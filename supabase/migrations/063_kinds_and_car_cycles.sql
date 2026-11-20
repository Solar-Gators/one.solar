select public.migration_begin(63);

-- =============================================================================
-- 063: Projects: one team-wide list of kinds of work, and car cycles
-- =============================================================================
--
--   Kinds of work (pm_kinds): "Design Task", "Calc", "Design Review"… are one list for the whole team, so a
--   kind has the same name, icon and color in every project. Each project still has its own row for it
--   (pm_types, linked by kind_id), because a project decides which workflow the kind follows and what can go
--   under what. So:
--     * a new kind is added to every project at once, using that project's main workflow;
--     * renaming, recoloring or retiring a kind changes it in every project;
--     * a project can still hide a kind it doesn't use (archive it in its Settings), and keep kinds of its own
--       that aren't on the team list;
--     * a project kind with the same name as a team kind is that kind (it takes the team's name, icon and color).
--   Who changes the list: "Edit kinds of work (whole team)" (projects.kinds), given here to Subsystem Leads,
--   Chief Engineers, the E-board and Admins (titles like President carry nothing: their E-board role does);
--   anyone with "Manage all projects" too.
--
--   Car cycles: a program (pm_programs) is a car cycle. It gets start and end dates and a "current" flag (at
--   most one is current). Projects → the switcher at the top shows this car, the next car, or both.
--
--   Nothing here changes an item, a status or a workflow. Existing kinds with the same name across projects
--   become one team kind (the most used one's icon and color win).
-- =============================================================================

-- ---- who can change the list ------------------------------------------------------------------
insert into public.permissions (key, label, description, sort) values
  ('projects.kinds', 'Edit kinds of work (whole team)', 'Add, rename, recolor or retire the kinds of work every project uses (Design Task, Calc, Design Review…).', 43)
on conflict (key) do nothing;
-- …and "See projects", which positions added after 051 (Subsystem Lead) never got: they can't edit what they can't open.
insert into public.role_permissions (role, permission)
select k, perm
from (select public.eval_seed_key('subsystem_lead') k union select public.eval_seed_key('ce') union select public.eval_seed_key('eboard') union select 'admin') x
cross join (values ('projects.kinds'), ('projects.view')) p(perm)
where k is not null and exists (select 1 from public.roles where key = k)
on conflict do nothing;
select public.record_permissions_snapshot();

-- ---- the list ---------------------------------------------------------------------------------
create table public.pm_kinds (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(trim(name)) between 1 and 40),
  icon         text not null default '' check (length(icon) <= 8),
  color        text not null default 'blue' check (color ~ '^[a-z]{1,12}$'),
  description  text not null default '' check (length(description) <= 500),
  level        int not null default 1 check (level between 0 and 5),     -- where it sits in a new project: 0 is the top
  is_milestone boolean not null default false,
  sort         int not null default 100,
  archived_at  timestamptz,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index pm_kinds_name_key on public.pm_kinds (lower(trim(name))) where archived_at is null;
alter table public.pm_kinds enable row level security;
create policy "projects read" on public.pm_kinds for select to authenticated using ((select public.pm_can_open()));
revoke all on public.pm_kinds from anon, authenticated;
grant select on public.pm_kinds to authenticated;

alter table public.pm_types add column kind_id uuid references public.pm_kinds(id) on delete set null;
create index pm_types_kind_idx on public.pm_types (kind_id);

-- Existing kinds: one team kind per name, its look from the project kind with the most items.
insert into public.pm_kinds (name, icon, color, description, level, is_milestone, sort)
select distinct on (lower(trim(t.name))) trim(t.name), t.icon, t.color, t.description, t.level, t.is_milestone, t.sort
from public.pm_types t
where t.archived_at is null
order by lower(trim(t.name)), (select count(*) from public.pm_items i where i.type_id = t.id) desc, t.sort, t.id;
update public.pm_types t set kind_id = k.id
from public.pm_kinds k
where lower(trim(t.name)) = lower(trim(k.name));
update public.pm_types t set icon = k.icon, color = k.color
from public.pm_kinds k where k.id = t.kind_id and t.archived_at is null;

/** A project's main workflow: the one most of its kinds follow (else its oldest). */
create or replace function public.pmx_main_workflow(p_project uuid)
returns uuid language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(
    (select t.workflow_id from pm_types t join pm_workflows w on w.id = t.workflow_id and w.archived_at is null
     where t.project_id = p_project and t.archived_at is null group by t.workflow_id order by count(*) desc, min(t.sort) limit 1),
    (select id from pm_workflows where project_id = p_project and archived_at is null order by created_at, id limit 1));
$$;

/** Give a project a team kind: link its own kind of the same name, else add it. Nothing if it has it already. */
create or replace function public.pmx_kind_into(p_project uuid, k pm_kinds)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_wf uuid;
begin
  if exists (select 1 from pm_types where project_id = p_project and kind_id = k.id) then return; end if;
  perform set_config('pm.kind_sync', 'on', true);
  update pm_types set kind_id = k.id, icon = k.icon, color = k.color
  where id = (select id from pm_types where project_id = p_project and archived_at is null and lower(trim(name)) = lower(trim(k.name)) limit 1);
  if not found then
    v_wf := pmx_main_workflow(p_project);
    if v_wf is not null then
      insert into pm_types (project_id, name, icon, color, description, level, workflow_id, is_milestone, sort, kind_id)
      values (p_project, k.name, k.icon, k.color, k.description, k.level, v_wf, k.is_milestone,
              (select coalesce(max(sort), 0) + 10 from pm_types where project_id = p_project), k.id);
    end if;
  end if;
  perform set_config('pm.kind_sync', 'off', true);
end;
$$;
revoke execute on function public.pmx_main_workflow(uuid), public.pmx_kind_into(uuid, pm_kinds) from public, anon, authenticated;

/** A project kind on the team list looks like it (name, icon, color) unless the list itself is changing it. */
create or replace function public.pmx_type_kind()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare k pm_kinds;
begin
  if coalesce(current_setting('pm.kind_sync', true), 'off') = 'on' then return new; end if;
  if new.kind_id is null and new.archived_at is null then
    select * into k from pm_kinds where archived_at is null and lower(trim(name)) = lower(trim(new.name));
    new.kind_id := k.id;
  elsif new.kind_id is not null then
    select * into k from pm_kinds where id = new.kind_id;
  end if;
  if k.id is not null then
    new.name := k.name;
    new.icon := k.icon;
    new.color := k.color;
  end if;
  return new;
end;
$$;
revoke execute on function public.pmx_type_kind() from public, anon, authenticated;
create trigger pm_types_kind before insert or update of name, icon, color, kind_id, archived_at on public.pm_types
  for each row execute function public.pmx_type_kind();

/** A new project gets every team kind, once its own set-up is in (so at the end of the transaction). */
create or replace function public.pmx_project_kinds()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare k pm_kinds;
begin
  if exists (select 1 from pm_projects where id = new.id and archived_at is null) then
    for k in select * from pm_kinds where archived_at is null order by level, sort, name loop
      perform pmx_kind_into(new.id, k);
    end loop;
  end if;
  return null;
end;
$$;
revoke execute on function public.pmx_project_kinds() from public, anon, authenticated;
create constraint trigger pm_projects_kinds after insert on public.pm_projects
  deferrable initially deferred for each row execute function public.pmx_project_kinds();

/** May the signed-in person change the team's kinds of work? */
create or replace function public.pm_may_edit_kinds()
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select pm_can_open() and (has_permission('projects.kinds') or has_permission('projects.manage')); $$;
revoke execute on function public.pm_may_edit_kinds() from public, anon;
grant execute on function public.pm_may_edit_kinds() to authenticated;

/**
 * Add (p_id null) or change a team kind of work. p: { name, icon, color, description, level, is_milestone, sort, archived }.
 * A new kind goes into every project; a change shows in every project; retiring hides it everywhere and
 * putting it back shows it again (except in projects that had hidden it themselves).
 */
create or replace function public.pm_save_kind(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  o       pm_kinds;
  v       pm_kinds;
  v_name  text := trim(coalesce(p ->> 'name', ''));
  v_clash text;
  r       record;
begin
  perform pmx_open();
  if not pm_may_edit_kinds() then
    raise exception 'Only leads can change the team''s kinds of work (it needs "Edit kinds of work").' using errcode = '42501';
  end if;
  if p_id is not null then
    select * into o from pm_kinds where id = p_id for update;
    if o.id is null then raise exception 'That kind of work isn''t there any more.'; end if;
  end if;
  if p_id is null and v_name = '' then raise exception 'Give the kind of work a name.'; end if;
  if v_name <> '' and exists (select 1 from pm_kinds where archived_at is null and lower(trim(name)) = lower(v_name) and id is distinct from p_id) then
    raise exception 'There''s already a kind of work called "%".', v_name using errcode = 'OS412';
  end if;
  if coalesce(p ->> 'color', '') <> '' and p ->> 'color' !~ '^[a-z]{1,12}$' then raise exception 'Pick one of the colors.'; end if;

  if p_id is null then
    insert into pm_kinds (name, icon, color, description, level, is_milestone, sort, created_by)
    values (v_name, left(coalesce(p ->> 'icon', ''), 8), coalesce(nullif(p ->> 'color', ''), 'blue'), coalesce(p ->> 'description', ''),
      least(5, greatest(0, coalesce((p ->> 'level')::int, 1))), pmx_bool(p, 'is_milestone', false),
      coalesce((p ->> 'sort')::int, (select coalesce(max(sort), 0) + 10 from pm_kinds)), auth.uid())
    returning * into v;
    for r in select id from pm_projects where archived_at is null loop
      perform pmx_kind_into(r.id, v);
    end loop;
    return to_jsonb(v);
  end if;

  -- a new name another project already uses for a kind of its own would make two kinds of one name there
  if v_name <> '' and lower(v_name) <> lower(o.name) then
    select string_agg(pr.key, ', ' order by pr.key) into v_clash
    from pm_types t join pm_projects pr on pr.id = t.project_id
    where t.archived_at is null and lower(trim(t.name)) = lower(v_name) and t.kind_id is distinct from o.id;
    if v_clash is not null then
      raise exception 'Projects % already have a kind called "%". Rename or hide theirs first (project Settings → Kinds of work).', v_clash, v_name;
    end if;
  end if;

  if o.archived_at is not null and p ? 'archived' and not pmx_bool(p, 'archived', false)
     and exists (select 1 from pm_kinds where id <> o.id and archived_at is null and lower(trim(name)) = lower(coalesce(nullif(v_name, ''), o.name))) then
    raise exception 'There''s already a kind of work called "%". Rename one of them first.', coalesce(nullif(v_name, ''), o.name) using errcode = 'OS412';
  end if;

  update pm_kinds set name = coalesce(nullif(v_name, ''), name), icon = coalesce(left(p ->> 'icon', 8), icon), color = coalesce(nullif(p ->> 'color', ''), color),
    description = coalesce(p ->> 'description', description), level = coalesce(least(5, greatest(0, (p ->> 'level')::int)), level),
    is_milestone = pmx_bool(p, 'is_milestone', is_milestone), sort = coalesce((p ->> 'sort')::int, sort),
    archived_at = case when p ? 'archived' then case when pmx_bool(p, 'archived', false) then coalesce(archived_at, now()) end else archived_at end,
    updated_at = now()
  where id = p_id returning * into v;

  perform set_config('pm.kind_sync', 'on', true);
  update pm_types set name = v.name, icon = v.icon, color = v.color, description = v.description where kind_id = v.id;
  if v.archived_at is not null and o.archived_at is null then
    -- retired: hidden in every project (marked with the kind's own time, so putting it back finds them)
    update pm_types set archived_at = v.archived_at where kind_id = v.id and archived_at is null;
  elsif v.archived_at is null and o.archived_at is not null then
    update pm_types set archived_at = null where kind_id = v.id and archived_at = o.archived_at
      and not exists (select 1 from pm_types t2 where t2.project_id = pm_types.project_id and t2.id <> pm_types.id and t2.archived_at is null
                      and lower(trim(t2.name)) = lower(trim(v.name)));
    for r in select id from pm_projects where archived_at is null loop
      perform pmx_kind_into(r.id, v);
    end loop;
  end if;
  perform set_config('pm.kind_sync', 'off', true);
  return to_jsonb(v);
end;
$$;

/** For the Kinds of work page: per team kind, how many projects show it and how many items are that kind. */
create or replace function public.pm_kind_usage()
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(k.id, jsonb_build_object(
    'projects', (select count(*) from pm_types t join pm_projects p on p.id = t.project_id where t.kind_id = k.id and t.archived_at is null and p.archived_at is null),
    'items', (select count(*) from pm_items i join pm_types t on t.id = i.type_id where t.kind_id = k.id and i.archived_at is null))), '{}')
  from pm_kinds k where pm_can_open();
$$;
revoke execute on function public.pm_save_kind(uuid, jsonb), public.pm_kind_usage() from public, anon;
grant execute on function public.pm_save_kind(uuid, jsonb), public.pm_kind_usage() to authenticated;

-- ---- car cycles ---------------------------------------------------------------------------------
alter table public.pm_programs add column start_date date;
alter table public.pm_programs add column end_date date;
alter table public.pm_programs add column is_current boolean not null default false;
alter table public.pm_programs add constraint pm_programs_dates_check check (end_date is null or start_date is null or end_date >= start_date);
create unique index pm_programs_current on public.pm_programs (is_current) where is_current;
-- one program so far: it's the current car
update public.pm_programs set is_current = true
where id = (select id from public.pm_programs where archived_at is null order by sort, created_at limit 1)
  and (select count(*) from public.pm_programs where archived_at is null) = 1;

/** Add (p_id null) or change a car cycle (program). p: { name, description, vehicle, sort, start_date, end_date, current, archived }. */
create or replace function public.pm_save_program(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v pm_programs;
begin
  perform pmx_open();
  if not (has_permission('projects.create') or has_permission('projects.manage')) then
    raise exception 'Your role can''t change car cycles (it needs "Create projects").' using errcode = '42501';
  end if;
  if p_id is null and trim(coalesce(p ->> 'name', '')) = '' then raise exception 'Give the car cycle a name (e.g. Car 8).'; end if;
  if nullif(p ->> 'end_date', '')::date < nullif(p ->> 'start_date', '')::date then raise exception 'The end is before the start.'; end if;
  if pmx_bool(p, 'current', false) then update pm_programs set is_current = false, updated_at = now() where is_current and id is distinct from p_id; end if;
  if p_id is null then
    insert into pm_programs (name, description, vehicle, sort, start_date, end_date, is_current, created_by)
    values (trim(p ->> 'name'), coalesce(p ->> 'description', ''), coalesce(p ->> 'vehicle', ''), coalesce((p ->> 'sort')::int, 100),
            nullif(p ->> 'start_date', '')::date, nullif(p ->> 'end_date', '')::date,
            pmx_bool(p, 'current', not exists (select 1 from pm_programs where is_current)), auth.uid())
    returning * into v;
  else
    update pm_programs set name = coalesce(nullif(trim(p ->> 'name'), ''), name), description = coalesce(p ->> 'description', description),
      vehicle = coalesce(p ->> 'vehicle', vehicle), sort = coalesce((p ->> 'sort')::int, sort),
      start_date = case when p ? 'start_date' then nullif(p ->> 'start_date', '')::date else start_date end,
      end_date = case when p ? 'end_date' then nullif(p ->> 'end_date', '')::date else end_date end,
      is_current = case when p ? 'current' then pmx_bool(p, 'current', false) else is_current end,
      archived_at = case when p ? 'archived' then case when pmx_bool(p, 'archived', false) then coalesce(archived_at, now()) end else archived_at end,
      updated_at = now()
    where id = p_id returning * into v;
    if v.id is null then raise exception 'That car cycle doesn''t exist.'; end if;
    if v.archived_at is not null and v.is_current then update pm_programs set is_current = false where id = v.id returning * into v; end if;
  end if;
  return to_jsonb(v);
end;
$$;

select public.migration_done(63, '063_kinds_and_car_cycles.sql');
