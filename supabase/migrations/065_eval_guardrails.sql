select public.migration_begin(65);

-- =============================================================================
-- 065: Solar Evals guardrails: who an eval type is NOT for, only the assigned evaluator, and a check
-- =============================================================================
--
--   Some leads filled out the Member eval's self-eval though they get the Leadership eval, and some E-board
--   members started evals of other E-board members they only give feedback on. Three settings on an eval
--   type (Setup, "Set up eval types"), all checked here, not just hidden in the app:
--     * "Except people in these positions" on Who is evaluated and on Who evaluates: { ..., except: [keys] }.
--       Someone holding any of them doesn't fit the rule (eval_rule_match), so they can't start a self-eval of
--       that type, be picked as its subject, or write one.
--     * "Only who's assigned" (settings.strict): when a type uses assignments or the evaluation chart, nobody
--       may start an eval of someone who has no assigned evaluator (before, anyone on "Who evaluates" could).
--     * Always: someone who only gives feedback on a person's eval (a chart box's "feedback from") can't write
--       that person's eval or be picked as their evaluator; they're added as input when the evaluator starts it.
--     * "Leave out people whose position has its own eval" on Who is evaluated ({ ..., except_others: <type> }):
--       someone holding a position that's on the evaluation chart under another eval type (a Subsystem Lead, an
--       Integration PM, the E-board titles, the CEs…) doesn't get this one, even though they also hold Member.
--       Turned on here for the Member eval; it can be turned off in Setup.
--   eval_rule_check(type) lists evals already started that break the type's rules now, for whoever can
--   "Set up eval types" or "Assign evaluators" to change the evaluator or delete (059). Nothing changes by itself.
-- =============================================================================

-- ---- "except": the 054 rule, minus people holding an excluded position --------------------------------
create or replace function public.eval_rule_except(p_rule jsonb)
returns text[]
language sql immutable set search_path = public, pg_temp
as $$
  select case when jsonb_typeof(p_rule -> 'except') = 'array'
              then array(select jsonb_array_elements_text(p_rule -> 'except')) else '{}'::text[] end;
$$;

/** The positions this person holds that the evaluation chart puts under another eval type (one that's on). */
create or replace function public.eval_other_positions(p_type text, p_user uuid)
returns text[]
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct coalesce(ro.label, c.role)), '{}')
  from eval_chart c
  join profile_roles r on r.role = c.role and r.user_id = p_user
  join eval_types t on t.id = c.type_id and t.active
  left join roles ro on ro.key = c.role
  where c.type_id <> coalesce(p_type, '');
$$;

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
    end
    and not exists (select 1 from profile_roles r where r.user_id = p_user and r.role = any(eval_rule_except(p_rule)))
    and (coalesce(p_rule ->> 'except_others', '') = '' or cardinality(eval_other_positions(p_rule ->> 'except_others', p_user)) = 0);
$$;

-- 054's check, plus the "except" list: positions that exist (not Guest or Alumni), at most 40.
create or replace function public.eval_check_rule(r jsonb, what text, allowed text[])
returns void
language plpgsql stable set search_path = public, pg_temp
as $$
declare v_rule text := r ->> 'rule'; v text := r ->> 'value'; v_bad text;
begin
  if jsonb_typeof(r) = 'object' and r ? 'except' then
    if jsonb_typeof(r -> 'except') <> 'array' or jsonb_array_length(r -> 'except') > 40 then
      raise exception '"%": the positions to leave out are incomplete.', what;
    end if;
    select x into v_bad from jsonb_array_elements(r -> 'except') x
    where jsonb_typeof(x) <> 'string' or x #>> '{}' in ('guest', 'alumni') or not exists (select 1 from roles where key = x #>> '{}') limit 1;
    if v_bad is not null then raise exception '"%": one of the positions to leave out doesn''t exist any more.', what; end if;
  end if;
  if jsonb_typeof(r) = 'object' and r ? 'except_others' and jsonb_typeof(r -> 'except_others') not in ('string', 'boolean') then
    raise exception '"%": "leave out people whose position has its own eval" is incomplete.', what;
  end if;
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

-- 036's, plus the "except" list (a permission rule checked the permission alone).
create or replace function public.eval_require_evaluator(s jsonb, p_type_name text)
returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if s -> 'evaluators' ->> 'rule' = 'permission' then
    perform require_permission(s -> 'evaluators' ->> 'value');
  end if;
  if not eval_rule_match(s -> 'evaluators', auth.uid()) then
    raise exception 'You don''t write % evals. Ask whoever runs Solar Evals if that''s wrong.', p_type_name;
  end if;
end;
$$;

-- 054's, keeping the "except" list when a chart rule is filled in, and pointing "leave out people whose position
-- has its own eval" (true from Setup) at this type.
create or replace function public.eval_chart_fill(s jsonb, p_type text)
returns jsonb
language sql immutable set search_path = public, pg_temp
as $$
  select case when coalesce(f.r -> 'subjects' ->> 'except_others', 'false') in ('false', '') then f.r #- '{subjects,except_others}'
              else jsonb_set(f.r, '{subjects,except_others}', to_jsonb(p_type)) end
  from (select case when s -> 'evaluators' ->> 'rule' = 'chart'
              then jsonb_set(s2, '{evaluators}', jsonb_build_object('rule', 'chart', 'value', p_type, 'side', 'evaluator')
                   || case when s -> 'evaluators' ? 'except' then jsonb_build_object('except', s -> 'evaluators' -> 'except') else '{}'::jsonb end)
              else s2 end as r
  from (select case when s -> 'subjects' ->> 'rule' = 'chart'
                    then jsonb_set(s, '{subjects}', jsonb_build_object('rule', 'chart', 'value', p_type, 'side', 'subject')
                         || case when s -> 'subjects' ? 'except' then jsonb_build_object('except', s -> 'subjects' -> 'except') else '{}'::jsonb end
                         || case when s -> 'subjects' ? 'except_others' then jsonb_build_object('except_others', s -> 'subjects' -> 'except_others') else '{}'::jsonb end)
                    else s end as s2) x) f;
$$;

-- ---- who may write someone's eval ----------------------------------------------------------------
/** Is this type's "Only who's assigned" on (its settings now, so turning it on applies straight away)? */
create or replace function public.eval_type_strict(p_type text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select settings ->> 'strict' = 'true' from eval_types where id = coalesce(p_type, 'member')), false);
$$;

-- 059's guard, plus: a feedback giver can't be the evaluator, and with "Only who's assigned" on, someone
-- nobody is assigned to can't be evaluated yet.
create or replace function public.eval_assignment_guard()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_who uuid[]; v_evaluator uuid; v_subject uuid; s jsonb; v_name text; v_ev text;
begin
  if current_setting('onesolar.eval_reassign', true) = 'on' then return new; end if;
  if not eval_type_assigned(new.type_id) then return new; end if;
  if new.kind = 'self' then
    if new.ce_id is null then return new; end if;
    if tg_op = 'UPDATE' and new.ce_id is not distinct from old.ce_id
       and not (new.status <> 'draft' and old.status = 'draft') then return new; end if;
    v_evaluator := new.ce_id; v_subject := new.evaluator_id;
  else
    if new.self_eval_id is not null or new.subject_id is null then return new; end if;
    if tg_op = 'UPDATE' and new.subject_id is not distinct from old.subject_id then return new; end if;
    v_evaluator := new.evaluator_id; v_subject := new.subject_id;
  end if;
  v_who := eval_assigned_evaluators(new.type_id, v_subject);
  if v_evaluator = any(v_who) then return new; end if;
  s := coalesce(new.type_settings, eval_default_settings());
  v_ev := lower(eval_lbl(s, 'evaluator'));
  v_name := coalesce((select nullif(trim(full_name), '') from profiles where id = v_subject), 'That person');
  -- someone who gives feedback on this person's eval doesn't write it
  if v_evaluator = any(eval_chart_feedback(new.type_id, v_subject)) then
    if new.kind = 'self' then
      raise exception '% gives feedback on your eval, so they can''t be your %.%', coalesce((select nullif(trim(full_name), '') from profiles where id = v_evaluator), 'They'), v_ev,
        case when cardinality(v_who) > 0 then format(' Pick %s.', eval_names(v_who)) else ' Ask an Admin or the President who evaluates you.' end;
    end if;
    raise exception 'You give feedback on %''s eval; you don''t write it. You''re added as input when % starts it.', v_name,
      case when cardinality(v_who) > 0 then eval_names(v_who) else format('their %s', v_ev) end;
  end if;
  if cardinality(v_who) = 0 then
    if eval_type_strict(new.type_id) then
      if new.kind = 'self' then
        raise exception 'Nobody is assigned as your % yet. Ask an Admin or the President to add you on the evaluation chart.', v_ev;
      end if;
      raise exception 'Nobody is assigned to evaluate % yet, so their eval can''t be started. Ask an Admin or the President to add them on the evaluation chart.', v_name;
    end if;
    return new;
  end if;
  if new.kind = 'self' then
    raise exception 'Your % is assigned: pick %. Ask an Admin or the President if that''s wrong.', v_ev, eval_names(v_who);
  end if;
  raise exception '% is assigned to %, not you. Ask an Admin or the President if that''s wrong.', v_name, eval_names(v_who);
end;
$$;

-- ---- the check ----------------------------------------------------------------------------------------
/**
 * Evals of this type already started (any stage) that break its rules now: the person evaluated doesn't
 * fit "Who is evaluated" (e.g. holds an excluded position), or the writer isn't the assigned evaluator, only
 * gives feedback, or nobody is assigned while "Only who's assigned" is on. People no longer on the team are
 * left out. [{id, kind, status, semester, subject, writer, problems: [text]}], newest first.
 */
create or replace function public.eval_rule_check(p_type text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  t eval_types; s jsonb; e evals; v_subj uuid; v_writer uuid; v_who uuid[]; v_p text[]; v_ex text;
  v_out jsonb := '[]'; v_assigned boolean; v_strict boolean;
  nm text; wn text;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if not (has_permission('evals.types') or has_permission('evals.assign')) then
    raise exception 'Your role does not allow this action (evals.types).';
  end if;
  select * into t from eval_types where id = p_type;
  if t.id is null then raise exception 'That kind of eval doesn''t exist any more.'; end if;
  s := t.settings;
  v_assigned := eval_type_assigned(t.id);
  v_strict := eval_type_strict(t.id);
  for e in select * from evals where coalesce(type_id, 'member') = t.id order by updated_at desc loop
    v_p := '{}';
    v_subj := case when e.kind = 'self' then e.evaluator_id else e.subject_id end;
    v_writer := case when e.kind = 'self' then e.ce_id else e.evaluator_id end;
    continue when v_subj is null or not is_member(v_subj);
    nm := coalesce((select nullif(trim(full_name), '') from profiles where id = v_subj), nullif(trim(e.member_name), ''), 'Someone');
    wn := coalesce((select nullif(trim(full_name), '') from profiles where id = v_writer), 'someone');
    if not eval_rule_match(s -> 'subjects', v_subj) then
      select string_agg(coalesce(ro.label, r.role), ', ' order by ro.sort) into v_ex
      from profile_roles r left join roles ro on ro.key = r.role
      where r.user_id = v_subj and r.role = any(eval_rule_except(s -> 'subjects'));
      if v_ex is not null then v_ex := v_ex || ','; end if;
      if v_ex is null and coalesce(s -> 'subjects' ->> 'except_others', '') <> '' then
        v_ex := nullif(array_to_string(eval_other_positions(t.id, v_subj), ', '), '');
        if v_ex is not null then v_ex := v_ex || ', which has its own eval,'; end if;
      end if;
      v_p := v_p || case when v_ex is not null then format('%s is %s and %s is left out for them.', nm, v_ex, t.name)
                         else format('%s isn''t someone who gets %s.', nm, t.name) end;
    end if;
    if v_writer is not null and v_assigned then
      v_who := eval_assigned_evaluators(t.id, v_subj);
      if not (v_writer = any(v_who)) then
        if v_writer = any(eval_chart_feedback(t.id, v_subj)) then
          v_p := v_p || format('%s gives feedback on %s''s eval; %s.', wn, nm,
            case when cardinality(v_who) > 0 then format('%s should write it', eval_names(v_who)) else 'nobody is assigned to write it yet' end);
        elsif cardinality(v_who) > 0 then
          v_p := v_p || format('%s %s, but %s is assigned.', case when e.kind = 'self' then 'Goes to' else 'Written by' end, wn, eval_names(v_who));
        elsif v_strict then
          v_p := v_p || format('Nobody is assigned to evaluate %s.', nm);
        end if;
      end if;
    end if;
    if cardinality(v_p) > 0 then
      v_out := v_out || jsonb_build_array(jsonb_build_object('id', e.id, 'kind', e.kind, 'status', e.status, 'semester', e.semester,
        'subject', nm, 'writer', case when v_writer is null then '' else wn end, 'problems', to_jsonb(v_p)));
    end if;
  end loop;
  return v_out;
end;
$$;

-- The Member eval: leads, PMs, the E-board and CEs have their own eval on the chart, so they don't get this one.
update public.eval_types set settings = jsonb_set(settings, '{subjects,except_others}', '"member"'), updated_at = now(),
  updated_by_name = 'one.solar update (065)'
where id = 'member' and settings -> 'subjects' ->> 'except_others' is null;
insert into public.eval_type_history (type_id, name, description, active, settings, note, saved_by_name)
select id, name, description, active, settings, 'Leaves out people whose position has its own eval on the evaluation chart (065).', 'one.solar update (065)'
from public.eval_types where id = 'member';

revoke execute on function public.eval_rule_except(jsonb), public.eval_type_strict(text), public.eval_other_positions(text, uuid) from public, anon, authenticated;
revoke execute on function public.eval_rule_check(text) from public, anon;
grant execute on function public.eval_rule_check(text) to authenticated;

select public.migration_done(65, '065_eval_guardrails.sql');
