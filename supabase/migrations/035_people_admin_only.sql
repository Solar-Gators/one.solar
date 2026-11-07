-- =============================================================================
-- 035: Who manages people; removing someone who left
-- =============================================================================
-- Run once, after 034: Supabase → SQL Editor → New query → paste → Run.
--
--   * "Manage people" (CEs and the Treasurer by default) gives people roles and
--     removes people, but NOT the Admin role: only Admins can make someone an
--     Admin, take it away, or change an Admin's roles, and only Admins can
--     remove an Admin.
--   * New permission "Edit roles & permissions" (roles.edit, Admin only):
--     create, rename and delete roles, and change what each role can do
--     (otherwise anyone who manages people could give their own role
--     everything an Admin can do). The Admin role always keeps it, and the
--     last Admin can't drop the Admin role or be removed.
--   * remove_person(): for someone who left the team. Their login is deleted,
--     so they can't sign in; what they did stays (requests, approvals, notes,
--     evals keep their name). The removal is kept in removed_people: who, when,
--     by whom, and why.
--   * If the same email signs up again, Admin → Users flags the new account
--     ("Removed on … by …") until someone lets them back in or removes them
--     again.
--   * Later: an "Alumni" option can sit next to "Remove" (removed_people.kind).
-- =============================================================================

-- ---- Permissions ------------------------------------------------------------
insert into public.permissions (key, label, description, sort) values
  ('roles.edit', 'Edit roles & permissions', 'Create, rename and delete roles, and choose what each role can do.', 16)
on conflict (key) do nothing;
update public.permissions
   set label = 'Manage people',
       description = 'Give people roles (except Admin) and remove people who left the team.'
 where key = 'users.manage';
insert into public.role_permissions (role, permission) values ('admin', 'roles.edit') on conflict do nothing;

/** Does the signed-in person (or p_user) hold the Admin role? */
create or replace function public.is_admin(p_user uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from profile_roles where user_id = p_user and role = 'admin');
$$;
grant execute on function public.is_admin(uuid) to authenticated;

create or replace function public.assert_someone_can_manage_users()
returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from profile_roles pr join role_permissions rp on rp.role = pr.role
    where rp.permission = 'users.manage'
  ) then
    raise exception 'At least one person must keep the "Manage people" permission, or nobody could change roles again.';
  end if;
end;
$$;

-- ---- Giving people roles ----------------------------------------------------
create or replace function public.set_user_roles(p_user_id uuid, p_roles text[])
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_roles   text[] := coalesce(p_roles, '{}');
  v_unknown text;
  v_was_admin boolean;
begin
  perform require_permission('users.manage');
  if not exists (select 1 from profiles where id = p_user_id) then raise exception 'User not found.'; end if;
  select r into v_unknown from unnest(v_roles) r where r not in (select key from roles) limit 1;
  if v_unknown is not null then raise exception 'Unknown role "%".', v_unknown; end if;
  if cardinality(v_roles) = 0 then v_roles := array['member']; end if;

  v_was_admin := is_admin(p_user_id);
  if not is_admin() then
    if v_was_admin then raise exception 'Only an Admin can change an Admin''s roles.'; end if;
    if 'admin' = any(v_roles) then raise exception 'Only an Admin can make someone an Admin.'; end if;
  end if;

  delete from profile_roles where user_id = p_user_id;
  insert into profile_roles (user_id, role) select distinct p_user_id, r from unnest(v_roles) r;
  if v_was_admin and not exists (select 1 from profile_roles where role = 'admin') then
    raise exception 'This is the last Admin. Make someone else an Admin first, or nobody could manage Admins again.';
  end if;
  perform assert_someone_can_manage_users();
end;
$$;

-- ---- Roles and what they can do: Admins (roles.edit) only --------------------
create or replace function public.create_role(p_label text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_label text := trim(coalesce(p_label, ''));
  v_base  text;
  v_key   text;
  v_n     int := 1;
begin
  perform require_permission('roles.edit');
  if v_label = '' then raise exception 'Give the role a name.'; end if;
  if exists (select 1 from roles where lower(label) = lower(v_label)) then
    raise exception 'There is already a role called "%".', v_label;
  end if;
  v_base := left(coalesce(nullif(trim(both '_' from regexp_replace(lower(v_label), '[^a-z0-9]+', '_', 'g')), ''), 'role'), 30);
  v_key := v_base;
  while exists (select 1 from roles where key = v_key) loop
    v_n := v_n + 1;
    v_key := v_base || '_' || v_n;
  end loop;
  insert into roles (key, label, sort) values (v_key, v_label, (select coalesce(max(sort), 0) + 1 from roles));
  perform record_permissions_snapshot();
  return v_key;
end;
$$;

create or replace function public.rename_role(p_key text, p_label text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_label text := trim(coalesce(p_label, ''));
begin
  perform require_permission('roles.edit');
  if v_label = '' then raise exception 'Give the role a name.'; end if;
  if exists (select 1 from roles where lower(label) = lower(v_label) and key <> p_key) then
    raise exception 'There is already a role called "%".', v_label;
  end if;
  update roles set label = v_label where key = p_key;
  if not found then raise exception 'Unknown role "%".', p_key; end if;
end;
$$;

create or replace function public.delete_role(p_key text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('roles.edit');
  if p_key in ('member', 'ce', 'treasurer', 'admin') then
    raise exception 'Built-in roles can''t be deleted.';
  end if;
  delete from roles where key = p_key;
  if not found then raise exception 'Unknown role "%".', p_key; end if;
  insert into profile_roles (user_id, role)
  select p.id, 'member' from profiles p
  where not exists (select 1 from profile_roles pr where pr.user_id = p.id);
  perform assert_someone_can_manage_users();
  perform record_permissions_snapshot();
end;
$$;

create or replace function public.set_role_permissions(p_role text, p_permissions text[])
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_unknown text;
begin
  perform require_permission('roles.edit');
  if not exists (select 1 from roles where key = p_role) then
    raise exception 'Unknown role "%".', p_role;
  end if;
  select p into v_unknown from unnest(coalesce(p_permissions, '{}')) p
  where p not in (select key from permissions) limit 1;
  if v_unknown is not null then
    raise exception 'Unknown permission "%".', v_unknown;
  end if;

  if p_role = 'admin' and not ('roles.edit' = any(coalesce(p_permissions, '{}'))) then
    raise exception 'Admin always keeps "Edit roles & permissions".';
  end if;
  delete from role_permissions where role = p_role;
  insert into role_permissions (role, permission)
  select distinct p_role, p from unnest(coalesce(p_permissions, '{}')) p;

  perform assert_someone_can_manage_users();
  perform record_permissions_snapshot();
end;
$$;

create or replace function public.set_permission_matrix(p_matrix jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_role  text;
  v_perms jsonb;
  v_unknown text;
begin
  perform require_permission('roles.edit');
  if coalesce(jsonb_typeof(p_matrix), '') <> 'object' then raise exception 'Nothing to save.'; end if;

  for v_role, v_perms in select * from jsonb_each(p_matrix) loop
    if not exists (select 1 from roles where key = v_role) then raise exception 'Unknown role "%".', v_role; end if;
    if coalesce(jsonb_typeof(v_perms), '') <> 'array' then raise exception 'Permissions for "%" must be a list.', v_role; end if;
    select p into v_unknown from jsonb_array_elements_text(v_perms) p where p not in (select key from permissions) limit 1;
    if v_unknown is not null then raise exception 'Unknown permission "%".', v_unknown; end if;
    if v_role = 'admin' and not (v_perms ? 'roles.edit') then
      raise exception 'Admin always keeps "Edit roles & permissions".';
    end if;

    delete from role_permissions where role = v_role;
    insert into role_permissions (role, permission)
    select distinct v_role, p from jsonb_array_elements_text(v_perms) p;
  end loop;

  perform assert_someone_can_manage_users();
  perform record_permissions_snapshot();
end;
$$;

-- ---- Removing someone who left ----------------------------------------------
create table public.removed_people (
  id               bigserial primary key,
  email            text not null,
  full_name        text not null default '',
  roles            text[] not null default '{}',     -- what they had, for the record
  kind             text not null default 'removed' check (kind in ('removed')),  -- later: 'alumni'
  note             text not null default '',
  removed_at       timestamptz not null default now(),
  removed_by       uuid references public.profiles(id) on delete set null,
  removed_by_name  text not null default '',
  cleared_at       timestamptz,                       -- "Let them back in" after they signed up again
  cleared_by_name  text
);
create index removed_people_email on public.removed_people (lower(email));
alter table public.removed_people enable row level security;
create policy "people managers read" on public.removed_people for select to authenticated
  using (public.has_permission('users.manage'));
revoke all on public.removed_people from anon, authenticated;
grant select on public.removed_people to authenticated;

/**
 * Remove someone who left the team: their login is deleted (they can't sign
 * in), their roles and watches go, and everything they did keeps their name.
 */
create or replace function public.remove_person(p_user_id uuid, p_note text default '')
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_p profiles;
begin
  perform require_permission('users.manage');
  select * into v_p from profiles where id = p_user_id;
  if not found then raise exception 'User not found.'; end if;
  if p_user_id = auth.uid() then raise exception 'You can''t remove yourself. Ask someone else who manages people.'; end if;
  if is_admin(p_user_id) and not is_admin() then raise exception 'Only an Admin can remove an Admin.'; end if;
  if is_admin(p_user_id) and not exists (select 1 from profile_roles where role = 'admin' and user_id <> p_user_id) then
    raise exception 'This is the last Admin. Make someone else an Admin first.';
  end if;

  insert into removed_people (email, full_name, roles, note, removed_by, removed_by_name)
  values (v_p.email, coalesce(v_p.full_name, ''),
          coalesce((select array_agg(role order by role) from profile_roles where user_id = p_user_id), '{}'),
          trim(coalesce(p_note, '')), auth.uid(), coalesce(my_display_name(), ''));

  -- Their name stays on what they did; the links to the account go.
  delete from auth.users where id = p_user_id;   -- cascades to profiles, roles, watchers
  perform assert_someone_can_manage_users();
end;
$$;

/** They signed up again and that's fine: stop flagging their new account. */
create or replace function public.clear_removed_flag(p_email text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('users.manage');
  update removed_people
     set cleared_at = now(), cleared_by_name = coalesce(my_display_name(), '')
   where lower(email) = lower(trim(p_email)) and cleared_at is null;
end;
$$;

revoke execute on function public.remove_person(uuid, text), public.clear_removed_flag(text) from public, anon;
grant execute on function public.remove_person(uuid, text), public.clear_removed_flag(text) to authenticated;

update app_settings set value = jsonb_set(value, '{schemaVersion}', '35') where key = 'general';
