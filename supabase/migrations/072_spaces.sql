select public.migration_begin(72);

-- =============================================================================
-- 072: Spaces. Every subsystem has its own Space (a Workbench project tied to the subsystem), made automatically,
-- and the people in that subsystem (Admin → Divisions & people, person_org) work in it as Contributors without
-- being added by hand. Epics inside a Space hold the actual pieces of work.
--
--   * pmx_space_key(name): a free key from the subsystem's name (Power Electronics → PE, Battery → BATT, …).
--   * pmx_ensure_space(subsystem): makes the Space if the subsystem has none (an archived one doesn't count).
--   * a trigger on org_subsystems makes one for each new (or un-archived) subsystem; every subsystem that has
--     no Space yet gets one now.
--   * pmx_caps_for / pm_visible: someone in a Space's subsystem has its Contributor role's abilities there
--     (on top of anything else they have), and sees it even if it's private.
-- The database still calls them projects (pm_projects); only the website says "Space".
-- =============================================================================

/** A key nobody uses yet, from a name: the first letters of each word (2 or more words) or the first 4 letters. */
create or replace function public.pmx_space_key(p_name text)
returns text language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  w     text[] := array(select x from regexp_split_to_table(upper(regexp_replace(coalesce(p_name, ''), '[^A-Za-z0-9]+', ' ', 'g')), ' ') x where x <> '');
  base  text;
  k     text;
  n     int := 1;
begin
  base := case when cardinality(w) >= 2 then (select string_agg(left(x, 1), '') from unnest(w) x) else coalesce(w[1], '') end;
  if cardinality(w) < 2 or length(base) < 2 then base := left(coalesce(w[1], '') || coalesce(w[2], ''), 4); end if;
  if base !~ '^[A-Z]' then base := 'S' || base; end if;
  base := left(case when length(base) < 2 then rpad(base, 2, 'X') else base end, 8);
  k := base;
  while exists (select 1 from pm_projects where key = k) loop
    n := n + 1;
    k := base || n;
  end loop;
  return k;
end;
$$;

/** The subsystem's Space, made from the starting configuration if it has none. Returns its id. */
create or replace function public.pmx_ensure_space(p_subsystem uuid)
returns uuid language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  s    org_subsystems;
  d    org_divisions;
  v_id uuid;
begin
  select * into s from org_subsystems where id = p_subsystem;
  if s.id is null or s.archived_at is not null then return null; end if;
  select id into v_id from pm_projects where subsystem_id = s.id and archived_at is null order by created_at limit 1;
  if v_id is not null then return v_id; end if;
  select * into d from org_divisions where id = s.division_id;
  insert into pm_projects (key, name, description, division_id, subsystem_id, visibility, created_by)
  values (pmx_space_key(s.name), left(trim(s.name), 120), 'The ' || trim(s.name) || ' subsystem''s Space' || coalesce(' (' || trim(d.name) || ')', '') || '. Its epics hold the work; people in the subsystem can add to it.',
          s.division_id, s.id, 'team', auth.uid())
  returning id into v_id;
  perform pmx_apply_config(v_id, pmx_default_config(), array['roles', 'workflows', 'types', 'fields', 'layouts', 'views', 'automations', 'settings'], false, current_date);
  perform pmx_log(v_id, null, 'project', 'Made for the ' || trim(s.name) || ' subsystem', jsonb_build_object('subsystem', s.id));
  return v_id;
end;
$$;

create or replace function public.pmx_space_for_subsystem()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.archived_at is null and (tg_op = 'INSERT' or old.archived_at is not null) then perform pmx_ensure_space(new.id); end if;
  return new;
end;
$$;
drop trigger if exists org_subsystems_space on public.org_subsystems;
create trigger org_subsystems_space after insert or update of archived_at on public.org_subsystems
  for each row execute function public.pmx_space_for_subsystem();

-- someone in the Space's subsystem works there as a Contributor
create or replace function public.pmx_caps_for(p_project uuid, p_user uuid)
returns text[] language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when p_user is null or not is_member(p_user) then '{}'::text[]
    when pmx_has(p_user, 'projects.manage') then pmx_all_caps()
    when not (pmx_has(p_user, 'projects.view') or pmx_has(p_user, 'projects.create')) then '{}'::text[]
    else coalesce((select array_agg(distinct c) from (
        select unnest(r.caps) as c from pm_members m join pm_roles r on r.id = m.role_id
        where m.project_id = p_project and m.user_id = p_user
        union
        select unnest(r.caps) from pm_projects p join pm_roles r on r.id = p.team_role_id
        where p.id = p_project and p.visibility = 'team'
        union
        select 'view' from pm_projects p where p.id = p_project and p.visibility = 'team'
        union
        select unnest(r.caps) from pm_projects p join pm_roles r on r.project_id = p.id and r.key = 'contributor'
        where p.id = p_project and p.subsystem_id is not null
          and exists (select 1 from person_org po where po.user_id = p_user and po.subsystem_id = p.subsystem_id)
        union
        select 'view' from pm_projects p where p.id = p_project and p.subsystem_id is not null
          and exists (select 1 from person_org po where po.user_id = p_user and po.subsystem_id = p.subsystem_id)
      ) x where c = any(pmx_all_caps())), '{}'::text[])
  end;
$$;

create or replace function public.pm_visible()
returns uuid[] language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when auth.uid() is null or not is_member() then '{}'::uuid[]
    when has_permission('projects.manage') then coalesce((select array_agg(id) from pm_projects), '{}'::uuid[])
    when not (has_permission('projects.view') or has_permission('projects.create')) then '{}'::uuid[]
    else coalesce((select array_agg(p.id) from pm_projects p
                   where p.visibility = 'team'
                      or exists (select 1 from pm_members m where m.project_id = p.id and m.user_id = auth.uid())
                      or (p.subsystem_id is not null and exists (select 1 from person_org po where po.user_id = auth.uid() and po.subsystem_id = p.subsystem_id))), '{}'::uuid[])
  end;
$$;

-- every subsystem that has no Space yet gets one now
select public.pmx_ensure_space(s.id) from public.org_subsystems s where s.archived_at is null order by s.sort, s.name;

do $$
declare f text;
begin
  foreach f in array array['public.pmx_space_key(text)', 'public.pmx_ensure_space(uuid)', 'public.pmx_space_for_subsystem()'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end;
$$;

select public.migration_done(72, '072_spaces.sql');
