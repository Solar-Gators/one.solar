select public.migration_begin(56);

-- =============================================================================
-- 056: who is in which CE division and subsystem
-- =============================================================================
--
--   The divisions and subsystems are the list in Admin → CE divisions & subsystems (050). Now people are in
--   them: each person can be in several subsystems, in any divisions, or in a whole division without a
--   subsystem (e.g. a Chief Engineer). One of them is their main one.
--
--   Who changes it (set_person_org):
--     * the person themselves (My account);
--     * whoever can "Manage people & roles" (users.manage): anyone;
--     * whoever can "Change people's subsystems (own divisions)" (people.subsystems, given to Chief
--       Engineers): only in the divisions they're in themselves.
--
--   Solar Evals uses it to fill in a self-eval's division and subsystem, and to put a member's subsystem
--   lead first when they pick who gives input. Admin → Users and Admin → Divisions & people show it.
-- =============================================================================

insert into public.permissions (key, label, description, sort) values
  ('people.subsystems', 'Change people''s subsystems (own divisions)', 'Put people in, or take them out of, the subsystems of the CE divisions you''re in yourself (Admin → Divisions & people).', 1)
on conflict (key) do nothing;
insert into public.role_permissions (role, permission)
select k, 'people.subsystems' from (select public.eval_seed_key('ce') k union select 'admin') x
where k is not null and exists (select 1 from public.roles where key = k)
on conflict do nothing;
select public.record_permissions_snapshot();

create table public.person_org (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  division_id     uuid not null references public.org_divisions(id) on delete cascade,
  subsystem_id    uuid references public.org_subsystems(id) on delete cascade,   -- null: the whole division
  main            boolean not null default false,
  updated_at      timestamptz not null default now(),
  updated_by_name text not null default ''
);
create unique index person_org_one on public.person_org (user_id, division_id, coalesce(subsystem_id, '00000000-0000-0000-0000-000000000000'::uuid));
create unique index person_org_main on public.person_org (user_id) where main;
create index person_org_subsystem_idx on public.person_org (subsystem_id);
create index person_org_division_idx on public.person_org (division_id);

alter table public.person_org enable row level security;
create policy "team read" on public.person_org for select to authenticated using (is_member());
revoke all on public.person_org from anon, authenticated;
grant select on public.person_org to authenticated;

/** May the signed-in person add or remove p_user's place in this division? */
create or replace function public.person_org_may_edit(p_user uuid, p_division uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select auth.uid() is not null and is_member() and (
    p_user = auth.uid()
    or has_permission('users.manage')
    or (has_permission('people.subsystems')
        and exists (select 1 from person_org where user_id = auth.uid() and division_id = p_division)));
$$;

/**
 * Set someone's divisions and subsystems: p_items = [{ subsystem_id } or { division_id }, main?]. Replaces
 * what they had. The first one is their main one unless another says main.
 */
create or replace function public.set_person_org(p_user uuid, p_items jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_new jsonb := '[]';
  it jsonb;
  v_sub org_subsystems;
  v_div org_divisions;
  v_main_key text;
  v_bad text;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if not is_member() then raise exception 'Your account hasn''t been accepted into the team yet.'; end if;
  if not exists (select 1 from profiles where id = p_user) then raise exception 'That person''s account no longer exists.'; end if;
  if jsonb_typeof(coalesce(p_items, '[]')) <> 'array' or jsonb_array_length(coalesce(p_items, '[]')) > 20 then
    raise exception 'Pick up to 20 subsystems.';
  end if;

  -- What they'll be in: {d, s, main}, each checked.
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    if nullif(it ->> 'subsystem_id', '') is not null then
      select * into v_sub from org_subsystems where id = (it ->> 'subsystem_id')::uuid;
      if v_sub.id is null then raise exception 'That subsystem doesn''t exist any more.'; end if;
      select * into v_div from org_divisions where id = v_sub.division_id;
    else
      v_sub := null;
      select * into v_div from org_divisions where id = nullif(it ->> 'division_id', '')::uuid;
      if v_div.id is null then raise exception 'That division doesn''t exist any more.'; end if;
    end if;
    -- Archived ones can stay where they were, but nobody is newly put in one.
    if (v_div.archived_at is not null or v_sub.archived_at is not null) and not exists (
         select 1 from person_org where user_id = p_user and division_id = v_div.id and subsystem_id is not distinct from v_sub.id) then
      raise exception '% has been archived. Pick another one.', coalesce(v_sub.name, v_div.name);
    end if;
    if not exists (select 1 from jsonb_array_elements(v_new) x where x ->> 'd' = v_div.id::text and (x ->> 's') is not distinct from v_sub.id::text) then
      v_new := v_new || jsonb_build_array(jsonb_build_object('d', v_div.id, 's', v_sub.id, 'main', coalesce((it ->> 'main')::boolean, false)));
    end if;
  end loop;

  -- Every place added or taken away has to be one they may change.
  select coalesce(d.name, '?') into v_bad
  from (
    select (x ->> 'd')::uuid d, nullif(x ->> 's', '')::uuid s from jsonb_array_elements(v_new) x
    except select division_id, subsystem_id from person_org where user_id = p_user
    union
    (select division_id, subsystem_id from person_org where user_id = p_user
     except select (x ->> 'd')::uuid, nullif(x ->> 's', '')::uuid from jsonb_array_elements(v_new) x)
  ) ch left join org_divisions d on d.id = ch.d
  where not person_org_may_edit(p_user, ch.d)
  limit 1;
  if v_bad is not null then
    raise exception 'You can only change subsystems in your own divisions (not %). Ask an Admin.', v_bad;
  end if;

  -- The main one: the one marked main, else the one that was, else the first.
  v_main_key := coalesce(
    (select (x ->> 'd') || '/' || coalesce(x ->> 's', '') from jsonb_array_elements(v_new) x where (x ->> 'main')::boolean limit 1),
    (select division_id::text || '/' || coalesce(subsystem_id::text, '') from person_org p where user_id = p_user and main
       and exists (select 1 from jsonb_array_elements(v_new) x where x ->> 'd' = p.division_id::text and (x ->> 's') is not distinct from p.subsystem_id::text)),
    (select (x ->> 'd') || '/' || coalesce(x ->> 's', '') from jsonb_array_elements(v_new) x limit 1));
  if v_main_key is not null and exists (select 1 from person_org p where user_id = p_user and main
       and p.division_id::text || '/' || coalesce(p.subsystem_id::text, '') <> v_main_key)
     and not person_org_may_edit(p_user, (select division_id from person_org where user_id = p_user and main)) then
    raise exception 'You can only change subsystems in your own divisions. Ask an Admin.';
  end if;

  delete from person_org where user_id = p_user;
  insert into person_org (user_id, division_id, subsystem_id, main, updated_by_name)
  select p_user, (x ->> 'd')::uuid, nullif(x ->> 's', '')::uuid,
         (x ->> 'd') || '/' || coalesce(x ->> 's', '') = v_main_key, coalesce(my_name(), '')
  from jsonb_array_elements(v_new) x;
end;
$$;

revoke execute on function public.person_org_may_edit(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.set_person_org(uuid, jsonb) from public, anon;
grant execute on function public.set_person_org(uuid, jsonb) to authenticated;

select public.migration_done(56, '056_people_subsystems.sql');
