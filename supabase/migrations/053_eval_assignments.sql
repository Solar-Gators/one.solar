select public.migration_begin(53);

-- =============================================================================
-- 053: Solar Evals: who evaluates whom, set by Admin or the President
-- =============================================================================
--
--   Until now a self-eval's evaluator was picked by the person evaluated, from everyone who fits the type's
--   "Who evaluates" rule (e.g. everyone on the E-board). That's hard to get right, so now someone with
--   "Assign evaluators" (Admin and the President by default) can say who evaluates whom, per eval type:
--
--     * by position: "the President evaluates the Vice President". It keeps working when the people change.
--     * for one person: "Jane is evaluated by Sam". A person's own rows replace their positions' rows.
--
--   An eval type uses this when "Assigned by Admin / the President" is on in Setup (settings.assigned).
--   Then, for someone with assignments, only their assigned evaluators can be picked on their self-eval or
--   write their eval. Someone with no assignment (or whose assigned position is empty) picks from the
--   "Who evaluates" list as before. Assignments narrow that list, never widen it: an assigned person still
--   needs to fit "Who evaluates".
--
--   New positions for E-board titles: President, Vice President, Secretary (Treasurer and Business
--   Coordinator already exist). They carry no permissions except the President's "Assign evaluators":
--   E-board members keep the E-board position for what they can do, and add their title.
-- =============================================================================

-- ---- positions and the permission ------------------------------------------------------------
insert into public.roles (key, label, sort)
select v.key, v.label, v.sort
from (values ('president', 'President', 8), ('vp', 'Vice President', 9), ('secretary', 'Secretary', 10)) v(key, label, sort)
where not exists (select 1 from public.roles r where r.key = v.key or lower(r.label) = lower(v.label))
on conflict (key) do nothing;

insert into public.permissions (key, label, description, sort) values
  ('evals.assign', 'Assign evaluators', 'Solar Evals: say who evaluates whom (by position or person), for eval types that use assignments.', 15)
on conflict (key) do nothing;

insert into public.role_permissions (role, permission)
select v.role, 'evals.assign'
from (values ('admin'), ('president')) v(role)
where exists (select 1 from public.roles r where r.key = v.role)
on conflict do nothing;
select public.record_permissions_snapshot();

-- ---- the assignments ----------------------------------------------------------------------------
create table public.eval_assignments (
  id              uuid primary key default gen_random_uuid(),
  type_id         text not null references public.eval_types(id) on delete cascade,
  subject_kind    text not null check (subject_kind in ('role', 'person')),
  subject_value   text not null,
  evaluator_kind  text not null check (evaluator_kind in ('role', 'person')),
  evaluator_value text not null,
  created_at      timestamptz not null default now(),
  created_by_name text not null default '',
  unique (type_id, subject_kind, subject_value, evaluator_kind, evaluator_value)
);
create index eval_assignments_type_idx on public.eval_assignments (type_id);

alter table public.eval_assignments enable row level security;
create policy "team read" on public.eval_assignments for select to authenticated using (is_member());
revoke all on public.eval_assignments from anon, authenticated;
grant select on public.eval_assignments to authenticated;

-- A person's rows go when they do; a position's rows go with the position.
create or replace function public.eval_assignments_cleanup()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if tg_table_name = 'profiles' then
    delete from eval_assignments where (subject_kind = 'person' and subject_value = old.id::text)
                                    or (evaluator_kind = 'person' and evaluator_value = old.id::text);
  else
    delete from eval_assignments where (subject_kind = 'role' and subject_value = old.key)
                                    or (evaluator_kind = 'role' and evaluator_value = old.key);
  end if;
  return old;
end;
$$;
create trigger eval_assignments_person_gone after delete on public.profiles
  for each row execute function public.eval_assignments_cleanup();
create trigger eval_assignments_role_gone after delete on public.roles
  for each row execute function public.eval_assignments_cleanup();

/** Does this eval type use assignments? (Its current settings, so turning it on applies to drafts too.) */
create or replace function public.eval_type_assigned(p_type text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select settings ->> 'assigned' = 'true' from eval_types where id = coalesce(p_type, 'member')), false);
$$;

/**
 * The people assigned to evaluate p_subject in p_type: their own rows if they have any, otherwise their
 * positions' rows; positions resolved to whoever holds them now. Never the person themselves. Empty = no
 * assignment (pick from "Who evaluates").
 */
create or replace function public.eval_assigned_evaluators(p_type text, p_subject uuid)
returns uuid[]
language sql stable security definer set search_path = public, pg_temp
as $$
  with mine as (
    select a.* from eval_assignments a
    where a.type_id = coalesce(p_type, 'member') and (
      (a.subject_kind = 'person' and a.subject_value = p_subject::text)
      or (a.subject_kind = 'role'
          and not exists (select 1 from eval_assignments x where x.type_id = a.type_id and x.subject_kind = 'person' and x.subject_value = p_subject::text)
          and exists (select 1 from profile_roles r where r.user_id = p_subject and r.role = a.subject_value)))
  ), who as (
    select p.id from mine m join profiles p on m.evaluator_kind = 'person' and p.id::text = m.evaluator_value
    union
    select r.user_id from mine m join profile_roles r on m.evaluator_kind = 'role' and r.role = m.evaluator_value
  )
  select coalesce(array_agg(distinct id), '{}') from who where id is distinct from p_subject and is_member(id);
$$;

/** "Sam Lee and Pat Kim", for the error below. */
create or replace function public.eval_names(p_ids uuid[])
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(string_agg(coalesce(nullif(trim(full_name), ''), email), ', ' order by full_name), '')
  from profiles where id = any(p_ids);
$$;

/**
 * The check, on the evals table itself so every way of writing one goes through it:
 *   * a self-eval's evaluator (ce_id), when it's picked and when it's submitted;
 *   * an eval written about someone (evaluator_id + subject_id), when the subject is set.
 * An eval started from a self-eval (self_eval_id) was already checked when the evaluator was picked.
 */
create or replace function public.eval_assignment_guard()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_who uuid[]; v_evaluator uuid; v_subject uuid; s jsonb;
begin
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
  if cardinality(v_who) = 0 or v_evaluator = any(v_who) then return new; end if;
  s := coalesce(new.type_settings, eval_default_settings());
  if new.kind = 'self' then
    raise exception 'Your % is assigned: pick %. Ask an Admin or the President if that''s wrong.', lower(eval_lbl(s, 'evaluator')), eval_names(v_who);
  end if;
  raise exception '% is assigned to %, not you. Ask an Admin or the President if that''s wrong.',
    coalesce((select nullif(trim(full_name), '') from profiles where id = v_subject), 'That person'), eval_names(v_who);
end;
$$;
create trigger eval_assignment_guard before insert or update on public.evals
  for each row execute function public.eval_assignment_guard();

-- ---- writing them -------------------------------------------------------------------------------
/** Add one: p = { type_id, subject_kind, subject_value, evaluator_kind, evaluator_value }. Returns its id. */
create or replace function public.eval_assign(p jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_type text := p ->> 'type_id';
  v_sk text := p ->> 'subject_kind'; v_sv text := p ->> 'subject_value';
  v_ek text := p ->> 'evaluator_kind'; v_ev text := p ->> 'evaluator_value';
  v_id uuid;
begin
  perform require_permission('evals.assign');
  if not exists (select 1 from eval_types where id = v_type) then raise exception 'That kind of eval doesn''t exist any more.'; end if;
  if not (coalesce(v_sk, '') in ('role', 'person') and coalesce(v_ek, '') in ('role', 'person')) then
    raise exception 'Choose a position or a person on both sides.';
  end if;
  if (v_sk = 'role' and not exists (select 1 from roles where key = v_sv and key not in ('guest', 'alumni')))
     or (v_ek = 'role' and not exists (select 1 from roles where key = v_ev and key not in ('guest', 'alumni'))) then
    raise exception 'That position doesn''t exist any more.';
  end if;
  if (v_sk = 'person' and not exists (select 1 from profiles where id::text = v_sv))
     or (v_ek = 'person' and not exists (select 1 from profiles where id::text = v_ev)) then
    raise exception 'That person''s account no longer exists.';
  end if;
  if v_sk = v_ek and v_sv = v_ev then raise exception 'Nobody evaluates themselves. Pick someone else.'; end if;
  insert into eval_assignments (type_id, subject_kind, subject_value, evaluator_kind, evaluator_value, created_by_name)
  values (v_type, v_sk, v_sv, v_ek, v_ev, coalesce(my_name(), ''))
  on conflict (type_id, subject_kind, subject_value, evaluator_kind, evaluator_value) do nothing
  returning id into v_id;
  return coalesce(v_id, (select id from eval_assignments where type_id = v_type and subject_kind = v_sk and subject_value = v_sv
                                                          and evaluator_kind = v_ek and evaluator_value = v_ev));
end;
$$;

create or replace function public.eval_unassign(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('evals.assign');
  delete from eval_assignments where id = p_id;
end;
$$;

revoke execute on function public.eval_assignments_cleanup(), public.eval_assignment_guard(), public.eval_names(uuid[])
  from public, anon, authenticated;
revoke execute on function public.eval_type_assigned(text), public.eval_assigned_evaluators(text, uuid),
  public.eval_assign(jsonb), public.eval_unassign(uuid) from public, anon;
grant execute on function public.eval_type_assigned(text), public.eval_assigned_evaluators(text, uuid),
  public.eval_assign(jsonb), public.eval_unassign(uuid) to authenticated;

select public.migration_done(53, '053_eval_assignments.sql');
