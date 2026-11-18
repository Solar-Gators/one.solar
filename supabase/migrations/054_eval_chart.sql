select public.migration_begin(54);

-- =============================================================================
-- 054: Solar Evals: the evaluation chart
-- =============================================================================
--
--   One chart for the whole team, drawn like an org chart, that Admin or the President edits ("Assign
--   evaluators", 053). Each box is a one.solar position:
--
--     reports_to   the box it sits under on the chart (null = the top)
--     type_id      the eval type its holders get (Members: the Member eval; leadership: the E-board eval)
--     evaluators   the positions that evaluate it (usually the box above; the President's is the VP)
--     feedback     positions whose holders are added as "Input from" when an eval of them starts, e.g. "other
--                  CEs" (never the person themselves or the evaluator); the input limit doesn't count them
--     feedback_pick positions the person or evaluator picks input from (e.g. their subsystem lead)
--     form_id      the form (variant) their eval uses, picked for you (e.g. the Treasurer's)
--
--   An eval type uses the chart with the new "who" rule {rule: "chart"} for "Who is evaluated" and/or
--   "Who evaluates": "Use the chart" on the chart page (eval_chart_use), or Setup → "From the evaluation
--   chart". Nothing switches by itself: until someone turns it on, evals work as before. Who evaluates whom then comes from the chart, with 053's
--   person rows on top for exceptions; nobody else can be picked (053's trigger). Someone the chart doesn't
--   place picks from the list, as before.
--
--   New positions Subsystem Lead and Integration Project Manager (053 added President, VP, Secretary).
--   053's position rows (role → role) move onto the chart.
-- =============================================================================

insert into public.roles (key, label, sort)
select v.key, v.label, v.sort
from (values ('subsystem_lead', 'Subsystem Lead', 11), ('integration_pm', 'Integration Project Manager', 12)) v(key, label, sort)
where not exists (select 1 from public.roles r where r.key = v.key or lower(r.label) = lower(v.label))
on conflict (key) do nothing;

-- ---- the chart --------------------------------------------------------------------------------
create table public.eval_chart (
  role            text primary key references public.roles(key) on delete cascade,
  reports_to      text references public.roles(key) on delete set null,
  type_id         text not null references public.eval_types(id) on delete cascade,
  evaluators      text[] not null default '{}',
  feedback        text[] not null default '{}',
  feedback_pick   text[] not null default '{}',
  form_id         text references public.eval_tracks(id) on delete set null,
  note            text not null default '' check (length(note) <= 400),
  sort            int not null default 0,
  updated_at      timestamptz not null default now(),
  updated_by_name text not null default ''
);
alter table public.eval_chart enable row level security;
create policy "team read" on public.eval_chart for select to authenticated using (is_member());
revoke all on public.eval_chart from anon, authenticated;
grant select on public.eval_chart to authenticated;

-- A position that goes comes off every list on the chart (its own box goes by the foreign key).
create or replace function public.eval_chart_role_gone()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update eval_chart set evaluators = array_remove(evaluators, old.key), feedback = array_remove(feedback, old.key),
                        feedback_pick = array_remove(feedback_pick, old.key)
  where old.key = any(evaluators) or old.key = any(feedback) or old.key = any(feedback_pick);
  return old;
end;
$$;
create trigger eval_chart_role_gone after delete on public.roles
  for each row execute function public.eval_chart_role_gone();

/** Whoever holds any of these positions now, on the team. */
create or replace function public.eval_holders(p_roles text[])
returns uuid[]
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct r.user_id), '{}') from profile_roles r
  where r.role = any(coalesce(p_roles, '{}')) and is_member(r.user_id);
$$;

/** The chart boxes that place this person in this eval type (one per position they hold that's on it). */
create or replace function public.eval_chart_boxes(p_type text, p_user uuid)
returns setof eval_chart
language sql stable security definer set search_path = public, pg_temp
as $$
  select c.* from eval_chart c
  where c.type_id = coalesce(p_type, 'member')
    and exists (select 1 from eval_types t where t.id = c.type_id and t.settings -> 'evaluators' ->> 'rule' = 'chart')
    and exists (select 1 from profile_roles r where r.user_id = p_user and r.role = c.role);
$$;

/** 053 plus the chart: their own rows, else 053 position rows, else the chart. */
create or replace function public.eval_assigned_evaluators(p_type text, p_subject uuid)
returns uuid[]
language sql stable security definer set search_path = public, pg_temp
as $$
  with own as (
    select a.* from eval_assignments a
    where a.type_id = coalesce(p_type, 'member') and a.subject_kind = 'person' and a.subject_value = p_subject::text
  ), pos as (
    select a.* from eval_assignments a
    where a.type_id = coalesce(p_type, 'member') and a.subject_kind = 'role' and not exists (select 1 from own)
      and exists (select 1 from profile_roles r where r.user_id = p_subject and r.role = a.subject_value)
  ), rows_ as (select * from own union all select * from pos),
  who as (
    select p.id from rows_ m join profiles p on m.evaluator_kind = 'person' and p.id::text = m.evaluator_value
    union
    select r.user_id from rows_ m join profile_roles r on m.evaluator_kind = 'role' and r.role = m.evaluator_value
    union
    select x from (select unnest(eval_holders(c.evaluators)) x from eval_chart_boxes(p_type, p_subject) c) z
    where not exists (select 1 from rows_)
  )
  select coalesce(array_agg(distinct id), '{}') from who where id is distinct from p_subject and is_member(id);
$$;

/** People added as input from the chart for an eval of p_subject: the boxes' "feedback" positions. */
create or replace function public.eval_chart_feedback(p_type text, p_subject uuid)
returns uuid[]
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct x), '{}')
  from (select unnest(eval_holders(c.feedback)) x from eval_chart_boxes(p_type, p_subject) c) z
  where x is distinct from p_subject;
$$;

/** Assignments apply when the type has "Assigned" on (053) or uses the chart for who evaluates. */
create or replace function public.eval_type_assigned(p_type text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select settings ->> 'assigned' = 'true' or settings -> 'evaluators' ->> 'rule' = 'chart'
                   from eval_types where id = coalesce(p_type, 'member')), false);
$$;

-- ---- the "chart" rule ---------------------------------------------------------------------------
-- {rule: "chart", value: <eval type id>, side: "subject" | "evaluator"}; eval_type_save fills value and side.
create or replace function public.eval_rule_match(p_rule jsonb, p_user uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select p_user is not null and exists (select 1 from profiles where id = p_user) and is_member(p_user) and
    case coalesce(p_rule ->> 'rule', 'none')
      when 'anyone'     then true
      when 'permission' then user_has_permission(p_user, p_rule ->> 'value')
      when 'role'       then exists (select 1 from profile_roles where user_id = p_user and role = p_rule ->> 'value')
      when 'group'      then exists (select 1 from eval_groups where id = p_rule ->> 'value' and p_user = any(members))
      when 'person'     then p_user::text = p_rule ->> 'value'
      when 'chart'      then case when p_rule ->> 'side' = 'subject' then
          exists (select 1 from eval_chart_boxes(p_rule ->> 'value', p_user))
          or exists (select 1 from eval_assignments a where a.type_id = p_rule ->> 'value' and a.subject_kind = 'person' and a.subject_value = p_user::text)
        else
          exists (select 1 from eval_chart c join profile_roles r on r.user_id = p_user and r.role = any(c.evaluators)
                  where c.type_id = p_rule ->> 'value')
          or exists (select 1 from eval_assignments a where a.type_id = p_rule ->> 'value' and a.evaluator_kind = 'person' and a.evaluator_value = p_user::text)
          or exists (select 1 from eval_assignments a join profile_roles r on r.user_id = p_user and r.role = a.evaluator_value
                     where a.type_id = p_rule ->> 'value' and a.evaluator_kind = 'role')
        end
      else false
    end;
$$;

-- 036's check, plus "chart" for who is evaluated and who evaluates.
create or replace function public.eval_check_rule(r jsonb, what text, allowed text[])
returns void
language plpgsql stable set search_path = public, pg_temp
as $$
declare v_rule text := r ->> 'rule'; v text := r ->> 'value';
begin
  if jsonb_typeof(r) = 'object' and v_rule = 'chart' and what in ('Who is evaluated', 'Who evaluates') then return; end if;
  if jsonb_typeof(r) is distinct from 'object' or not (coalesce(v_rule, '') = any(allowed)) then
    raise exception '"%": choose who that is.', what;
  end if;
  if v_rule = 'permission' and not exists (select 1 from permissions where key = v) then
    raise exception '"%": that permission doesn''t exist.', what;
  elsif v_rule = 'role' and not exists (select 1 from roles where key = v) then
    raise exception '"%": that position doesn''t exist any more.', what;
  elsif v_rule = 'group' and not exists (select 1 from eval_groups where id = v) then
    raise exception '"%": that eval group doesn''t exist any more.', what;
  elsif v_rule = 'person' and not exists (select 1 from profiles where id::text = v) then
    raise exception '"%": pick the person.', what;
  end if;
end;
$$;

/** A type's settings with its chart rules pointing at it. */
create or replace function public.eval_chart_fill(s jsonb, p_type text)
returns jsonb
language sql immutable set search_path = public, pg_temp
as $$
  select case when s -> 'evaluators' ->> 'rule' = 'chart'
              then jsonb_set(s2, '{evaluators}', jsonb_build_object('rule', 'chart', 'value', p_type, 'side', 'evaluator')) else s2 end
  from (select case when s -> 'subjects' ->> 'rule' = 'chart'
                    then jsonb_set(s, '{subjects}', jsonb_build_object('rule', 'chart', 'value', p_type, 'side', 'subject')) else s end as s2) x;
$$;

-- 036's eval_type_save, filling in the chart rules.
create or replace function public.eval_type_save(p_id text, p_name text, p_description text, p_active boolean, p_settings jsonb, p_note text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id text := p_id; v_new boolean := p_id is null;
begin
  perform require_permission('evals.types');
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the eval type a name.'; end if;
  if exists (select 1 from eval_types where lower(name) = lower(trim(p_name)) and id is distinct from p_id) then
    raise exception 'There''s already an eval type called "%".', trim(p_name);
  end if;
  if v_new then v_id := eval_slug(p_name); end if;
  p_settings := eval_chart_fill(p_settings, v_id);
  perform eval_check_settings(p_settings);
  if v_new then
    insert into eval_types (id, name, description, active, sort, settings, updated_by, updated_by_name)
    values (v_id, trim(p_name), left(coalesce(trim(p_description), ''), 600), coalesce(p_active, true),
            coalesce((select max(sort) + 1 from eval_types), 0), p_settings, auth.uid(), coalesce(my_name(), ''));
  else
    if not exists (select 1 from eval_types where id = v_id) then raise exception 'That eval type no longer exists.'; end if;
    if not coalesce(p_active, true) and not exists (select 1 from eval_types where active and id <> v_id) then
      raise exception 'Keep at least one eval type turned on.';
    end if;
    update eval_types set name = trim(p_name), description = left(coalesce(trim(p_description), ''), 600), active = coalesce(p_active, true),
      settings = p_settings, updated_at = now(), updated_by = auth.uid(), updated_by_name = coalesce(my_name(), '')
    where id = v_id;
  end if;
  insert into eval_type_history (type_id, name, description, active, settings, note, saved_by_name)
  select id, name, description, active, settings, left(coalesce(trim(p_note), ''), 600), updated_by_name from eval_types where id = v_id;
  return v_id;
end;
$$;

-- 036's input check. The limit applies to people someone adds: people already on the eval (e.g. added from
-- the chart) can be taken off, or swapped, without going under it first.
create or replace function public.eval_check_inputs(s jsonb, p_new uuid[], p_old uuid[], p_by text, p_writer uuid)
returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v uuid; v_by text := s -> 'input' ->> 'pickedBy';
begin
  if coalesce((select array_agg(x order by x) from unnest(p_new) x), '{}') = coalesce((select array_agg(x order by x) from unnest(p_old) x), '{}') then
    return;
  end if;
  if not (s -> 'input' ->> 'on')::boolean then
    if exists (select 1 from unnest(p_new) x where not x = any(p_old)) then raise exception 'This kind of eval doesn''t ask anyone for input.'; end if;
    return;
  end if;
  if v_by <> 'either' and v_by <> p_by then
    raise exception 'The % picks the %.', lower(eval_lbl(s, case v_by when 'subject' then 'subject' else 'evaluator' end)), lower(eval_lbl(s, 'input'));
  end if;
  if cardinality(p_new) > greatest((s -> 'input' ->> 'max')::int, cardinality(p_old))
     and exists (select 1 from unnest(p_new) x where not x = any(p_old)) then
    raise exception 'Pick up to % (%).', s -> 'input' ->> 'max', lower(eval_lbl(s, 'input'));
  end if;
  foreach v in array p_new loop
    if not exists (select 1 from profiles where id = v) then
      raise exception 'That %''s account no longer exists.', lower(eval_lbl(s, 'input'));
    end if;
    if v = p_writer then raise exception 'You can''t give input on your own eval.'; end if;
    if not (v = any(p_old)) and not eval_rule_match(s -> 'input', v) then
      raise exception '% can''t be picked as %.', coalesce((select nullif(full_name, '') from profiles where id = v), 'That person'), lower(eval_lbl(s, 'input'));
    end if;
  end loop;
end;
$$;

-- ---- feedback from the chart, added when an eval of someone starts --------------------------------
create or replace function public.eval_chart_inputs()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_subject uuid; v_add uuid[];
begin
  if new.kind = 'self' then
    if tg_op <> 'INSERT' then return new; end if;
    v_subject := new.evaluator_id;
  else
    new.input_ids := array_remove(coalesce(new.input_ids, '{}'), new.evaluator_id);   -- never your own input
    if new.self_eval_id is not null or new.subject_id is null then return new; end if;   -- from a self-eval: it has them
    if tg_op = 'UPDATE' and new.subject_id is not distinct from old.subject_id then return new; end if;
    v_subject := new.subject_id;
  end if;
  v_add := array(select x from unnest(eval_chart_feedback(new.type_id, v_subject)) x
                 where x is distinct from new.evaluator_id and x is distinct from new.ce_id and not x = any(coalesce(new.input_ids, '{}')));
  if cardinality(v_add) = 0 then return new; end if;
  new.input_ids := coalesce(new.input_ids, '{}') || v_add;
  new.lead_id := coalesce(new.lead_id, new.input_ids[1]);
  perform set_config('onesolar.eval_chart_added', array_to_string(v_add, ','), true);
  return new;
end;
$$;
create trigger eval_chart_inputs before insert or update on public.evals
  for each row execute function public.eval_chart_inputs();

/** Tell the people the chart just added (not on a self-eval: they're told when the evaluator starts). */
create or replace function public.eval_chart_inputs_notify()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v text := nullif(current_setting('onesolar.eval_chart_added', true), '');
begin
  if v is null then return null; end if;
  perform set_config('onesolar.eval_chart_added', '', true);
  if new.kind <> 'self' then perform notify_eval(new.id, 'input', string_to_array(v, ',')::uuid[]); end if;
  return null;
end;
$$;
create trigger eval_chart_inputs_notify after insert or update on public.evals
  for each row execute function public.eval_chart_inputs_notify();

-- ---- editing the chart ---------------------------------------------------------------------------
/**
 * Add or change a box: p = { reports_to, type_id, evaluators[], feedback[], feedback_pick[], form_id, note, sort }.
 */
create or replace function public.eval_chart_save(p_role text, p jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_up text := nullif(p ->> 'reports_to', '');
  v_type text := coalesce(nullif(p ->> 'type_id', ''), 'member');
  v_ev text[] := coalesce((select array_agg(distinct x) from jsonb_array_elements_text(coalesce(p -> 'evaluators', '[]')) x where x <> ''), '{}');
  v_fb text[] := coalesce((select array_agg(distinct x) from jsonb_array_elements_text(coalesce(p -> 'feedback', '[]')) x where x <> ''), '{}');
  v_fp text[] := coalesce((select array_agg(distinct x) from jsonb_array_elements_text(coalesce(p -> 'feedback_pick', '[]')) x where x <> ''), '{}');
  v_form text := nullif(p ->> 'form_id', '');
  v_bad text;
  v_at text;
  v_n int := 0;
begin
  perform require_permission('evals.assign');
  if p_role in ('guest', 'alumni') or not exists (select 1 from roles where key = p_role) then
    raise exception 'That position doesn''t exist any more.';
  end if;
  select x into v_bad from unnest(v_ev || v_fb || v_fp || array_remove(array[v_up], null)) x
  where x in ('guest', 'alumni') or not exists (select 1 from roles where key = x) limit 1;
  if v_bad is not null then raise exception 'One of those positions doesn''t exist any more.'; end if;
  if not exists (select 1 from eval_types where id = v_type) then raise exception 'That kind of eval doesn''t exist any more.'; end if;
  if v_form is not null and not exists (select 1 from eval_tracks where id = v_form and removed_at is null) then
    raise exception 'That form has been removed. Pick another one.';
  end if;
  if v_up = p_role then raise exception 'A position can''t sit under itself.'; end if;
  if v_up is not null and not exists (select 1 from eval_chart where role = v_up) then
    raise exception 'Put % on the chart first.', (select label from roles where key = v_up);
  end if;
  -- No loops: walking up from where it goes must never come back to it.
  v_at := v_up;
  while v_at is not null loop
    if v_at = p_role then raise exception 'That would put % under itself (through the boxes above). Pick another place.', (select label from roles where key = p_role); end if;
    v_n := v_n + 1;
    if v_n > 100 then exit; end if;
    select reports_to into v_at from eval_chart where role = v_at;
  end loop;
  insert into eval_chart (role, reports_to, type_id, evaluators, feedback, feedback_pick, form_id, note, sort, updated_by_name)
  values (p_role, v_up, v_type, v_ev, v_fb, v_fp, v_form, left(trim(coalesce(p ->> 'note', '')), 400),
          coalesce((p ->> 'sort')::int, (select coalesce(max(sort), 0) + 1 from eval_chart)), coalesce(my_name(), ''))
  on conflict (role) do update set reports_to = excluded.reports_to, type_id = excluded.type_id, evaluators = excluded.evaluators,
    feedback = excluded.feedback, feedback_pick = excluded.feedback_pick, form_id = excluded.form_id, note = excluded.note,
    sort = case when p ? 'sort' then excluded.sort else eval_chart.sort end, updated_at = now(), updated_by_name = excluded.updated_by_name;
end;
$$;

/** Take a box off the chart; the boxes under it move up to its place. */
create or replace function public.eval_chart_remove(p_role text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_up text;
begin
  perform require_permission('evals.assign');
  select reports_to into v_up from eval_chart where role = p_role;
  update eval_chart set reports_to = v_up where reports_to = p_role;
  delete from eval_chart where role = p_role;
end;
$$;

-- ---- the chart from the team's "Evaluation flow" drawing -------------------------------------------
-- A position may already exist under another key with the same name (e.g. a "Subsystem Lead" someone made
-- in Admin before 053/054, which then didn't add theirs): use that one.
create or replace function public.eval_seed_key(p_key text)
returns text
language sql stable set search_path = public, pg_temp
as $$
  select coalesce(
    (select key from roles where key = p_key),
    (select r.key from roles r
     join (values ('president', 'President'), ('vp', 'Vice President'), ('treasurer', 'Treasurer'), ('secretary', 'Secretary'),
                  ('coordinator', 'Business Coordinator'), ('ce', 'Chief Engineer'), ('subsystem_lead', 'Subsystem Lead'),
                  ('integration_pm', 'Integration Project Manager'), ('member', 'Member'), ('eboard', 'E-board')) v(k, label)
       on v.k = p_key and lower(trim(r.label)) = lower(v.label)
     where r.key not in ('guest', 'alumni') order by r.sort, r.key limit 1));
$$;

-- The President's "Assign evaluators" (053), for a President position that already had another key.
insert into public.role_permissions (role, permission)
select public.eval_seed_key('president'), 'evals.assign' where public.eval_seed_key('president') is not null
on conflict do nothing;
select public.record_permissions_snapshot();

do $$
declare
  lead text := case when exists (select 1 from eval_types where id = 'eboard') then 'eboard' else 'member' end;
begin
  if exists (select 1 from eval_chart) then return; end if;
  -- role, sits under, type, evaluated by, feedback from (everyone), feedback picked from, form, note, sort
  insert into eval_chart (role, reports_to, type_id, evaluators, feedback, feedback_pick, form_id, note, sort, updated_by_name)
  select eval_seed_key(v.role), eval_seed_key(v.up), v.ty,
         array(select k from (select eval_seed_key(x) k from unnest(v.ev) x) z where k is not null),
         array(select k from (select eval_seed_key(x) k from unnest(v.fb) x) z where k is not null),
         array(select k from (select eval_seed_key(x) k from unnest(v.fp) x) z where k is not null),
         (select id from eval_tracks where id = v.form and removed_at is null), v.note, v.sort, 'Solar Gators'
  from (values
    ('president',      null,             lead,     array['vp'],             array['eboard', 'ce'],   array[]::text[],          'lead-president',      'The President is evaluated by the VP, with feedback from the other E-board members and the Chief Engineers.', 1),
    ('ce',             'president',      lead,     array['president'],      array['ce'],             array[]::text[],          'lead-ce',             '', 2),
    ('vp',             'president',      lead,     array['president'],      array[]::text[],         array[]::text[],          'lead-vp',             '', 3),
    ('treasurer',      'president',      lead,     array['president'],      array['ce'],             array[]::text[],          'lead-treasurer',      '', 4),
    ('secretary',      'president',      lead,     array['president'],      array[]::text[],         array[]::text[],          'lead-secretary',      '', 5),
    ('coordinator',    'president',      lead,     array['president'],      array[]::text[],         array[]::text[],          'lead-business',       '', 6),
    ('subsystem_lead', 'ce',             lead,     array['ce'],             array[]::text[],         array[]::text[],          'lead-subsystem-lead', '', 7),
    ('integration_pm', 'ce',             lead,     array['ce'],             array['integration_pm'], array[]::text[],          'lead-pm',             '', 8),
    ('member',         'subsystem_lead', 'member', array['ce'],             array[]::text[],         array['subsystem_lead'],  null,                  'Members are evaluated by their CE, with input from their subsystem lead.', 9)
  ) v(role, up, ty, ev, fb, fp, form, note, sort)
  where eval_seed_key(v.role) is not null and exists (select 1 from eval_types where id = v.ty)
  on conflict (role) do nothing;
  -- A box whose parent didn't make it onto the chart goes to the top.
  update eval_chart c set reports_to = null where reports_to is not null and not exists (select 1 from eval_chart p where p.role = c.reports_to);
end;
$$;

-- 053's position rows move onto the chart (person rows stay as exceptions).
do $$
declare r record;
begin
  for r in
    select a.subject_value as role, a.type_id, array_agg(distinct a.evaluator_value) as ev
    from eval_assignments a where a.subject_kind = 'role' and a.evaluator_kind = 'role'
    group by a.subject_value, a.type_id
  loop
    insert into eval_chart (role, reports_to, type_id, evaluators, updated_by_name)
    values (r.role, null, r.type_id, r.ev, 'Solar Gators')
    on conflict (role) do update set evaluators = (select array_agg(distinct x) from unnest(eval_chart.evaluators || excluded.evaluators) x),
                                     type_id = excluded.type_id;
  end loop;
  delete from eval_assignments where subject_kind = 'role' and evaluator_kind = 'role';
end;
$$;

/**
 * Turn the chart on (or off) for an eval type: "Who evaluates" (and "Who is evaluated", unless that's anyone)
 * come from the chart. The rules it had before are kept and come back when it's turned off. For people who
 * can "Assign evaluators" or "Set up Solar Evals".
 */
create or replace function public.eval_chart_use(p_type text, p_on boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare t eval_types; s jsonb; v_before jsonb;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if not (has_permission('evals.assign') or has_permission('evals.types')) then
    raise exception 'Your role does not allow this action (evals.assign).';
  end if;
  select * into t from eval_types where id = p_type;
  if t.id is null then raise exception 'That kind of eval doesn''t exist any more.'; end if;
  s := t.settings;
  if p_on then
    if s -> 'evaluators' ->> 'rule' = 'chart' then return; end if;
    s := jsonb_set(s, '{beforeChart}', jsonb_build_object('subjects', s -> 'subjects', 'evaluators', s -> 'evaluators'));
    s := jsonb_set(s, '{evaluators}', '{"rule": "chart"}');
    if s -> 'subjects' ->> 'rule' <> 'anyone' then s := jsonb_set(s, '{subjects}', '{"rule": "chart"}'); end if;
    s := eval_chart_fill(s, t.id);
  else
    if s -> 'evaluators' ->> 'rule' <> 'chart' and s -> 'subjects' ->> 'rule' <> 'chart' then return; end if;
    v_before := s -> 'beforeChart';
    s := jsonb_set(s, '{subjects}', case when s -> 'subjects' ->> 'rule' = 'chart'
           then coalesce(v_before -> 'subjects', '{"rule": "anyone"}') else s -> 'subjects' end);
    s := jsonb_set(s, '{evaluators}', case when s -> 'evaluators' ->> 'rule' = 'chart'
           then coalesce(v_before -> 'evaluators', '{"rule": "permission", "value": "evals.write"}') else s -> 'evaluators' end);
    s := s - 'beforeChart';
  end if;
  perform eval_check_settings(s);
  update eval_types set settings = s, updated_at = now(), updated_by = auth.uid(), updated_by_name = coalesce(my_name(), '') where id = t.id;
  insert into eval_type_history (type_id, name, description, active, settings, note, saved_by_name)
  values (t.id, t.name, t.description, t.active, s, case when p_on then 'Uses the evaluation chart.' else 'Stopped using the evaluation chart.' end, coalesce(my_name(), ''));
end;
$$;

revoke execute on function public.eval_chart_role_gone(), public.eval_chart_inputs(), public.eval_chart_inputs_notify(),
  public.eval_chart_fill(jsonb, text), public.eval_holders(text[]), public.eval_chart_boxes(text, uuid), public.eval_seed_key(text)
  from public, anon, authenticated;
revoke execute on function public.eval_chart_feedback(text, uuid), public.eval_chart_save(text, jsonb), public.eval_chart_remove(text),
  public.eval_chart_use(text, boolean) from public, anon;
grant execute on function public.eval_chart_feedback(text, uuid), public.eval_chart_save(text, jsonb), public.eval_chart_remove(text),
  public.eval_chart_use(text, boolean) to authenticated;

select public.migration_done(54, '054_eval_chart.sql');
