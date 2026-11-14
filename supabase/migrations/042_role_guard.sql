select public.migration_begin(42);

-- 042: nobody gives themselves more power, and every role change is written down.
--
-- Who may change roles (enforced here, in set_user_roles; Admin → Users only mirrors it):
--   Admin                anyone's roles, their own included (the last-Admin and "someone can manage people"
--                        guards still apply).
--   Manage people        (users.manage, e.g. CE / Treasurer) OTHER people only, and only roles that
--     but not Admin      (a) aren't "privileged" (Admin, or a role that can manage people, edit roles, or
--                        change workflow / notifications), and (b) carry only permissions they hold themselves:
--                        you can't give (or take away) what you don't have. Member (the base role) is
--                        always allowed.
--   Everyone else        nobody.
--
-- role_changes keeps every change: who, whose, roles before and after, when, and how (which function, or
-- "database" for a change made directly in the SQL editor / Table Editor).

-- ---- Helpers ------------------------------------------------------------------
/** The permissions a role carries. */
create or replace function public.role_permission_list(p_role text)
returns text[]
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(array_agg(permission order by permission), '{}') from role_permissions where role = p_role;
$$;

/** Admin, or a role that can manage people, edit roles, or change the workflow: only Admins hand these out. */
create or replace function public.role_is_privileged(p_role text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select p_role = 'admin' or exists (
    select 1 from role_permissions where role = p_role and permission in ('users.manage', 'roles.edit', 'workflow.edit'));
$$;

/** Why the signed-in person may not give or take this role ('' = they may). */
create or replace function public.role_change_problem(p_role text)
returns text
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_missing text;
begin
  if is_admin() then return ''; end if;
  if p_role = 'member' then return ''; end if;   -- the base role every accepted person has
  if p_role = 'admin' then return 'Only an Admin can give or take the Admin role.'; end if;
  if role_is_privileged(p_role) then
    return format('Only an Admin can give or take "%s": it can manage people, edit roles, or change the workflow.',
                  coalesce((select label from roles where key = p_role), p_role));
  end if;
  select string_agg(coalesce(pm.label, x.permission), ', ' order by x.permission) into v_missing
  from unnest(role_permission_list(p_role)) as x(permission) left join permissions pm on pm.key = x.permission
  where not has_permission(x.permission);
  if v_missing is not null then
    return format('You can''t give or take "%s": it includes things you can''t do yourself (%s). Ask an Admin.',
                  coalesce((select label from roles where key = p_role), p_role), v_missing);
  end if;
  return '';
end;
$$;

-- ---- The record of role changes -----------------------------------------------
create table if not exists public.role_changes (
  id          bigserial primary key,
  changed_at  timestamptz not null default now(),
  actor_id    uuid,                       -- no foreign key: the record outlives the accounts
  actor_name  text not null default '',
  target_id   uuid,
  target_name text not null default '',
  target_email text not null default '',
  old_roles   text[] not null default '{}',
  new_roles   text[] not null default '{}',
  via         text not null,
  note        text not null default ''
);
create index if not exists role_changes_target on public.role_changes (target_id, changed_at desc);
alter table public.role_changes enable row level security;
revoke all on public.role_changes from anon, authenticated;
revoke all on sequence public.role_changes_id_seq from anon, authenticated;
grant select on public.role_changes to authenticated;
drop policy if exists "people managers read" on public.role_changes;
create policy "people managers read" on public.role_changes for select to authenticated
  using (public.has_permission('users.manage'));

/** A person's roles right now. */
create or replace function public.roles_of(p_user uuid)
returns text[]
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(array_agg(role order by role), '{}') from profile_roles where user_id = p_user;
$$;

/**
 * Write one role_changes row from a function that changed someone's roles, and mark this transaction so
 * the profile_roles trigger doesn't write a second, per-row record of the same change.
 */
create or replace function public.log_role_change(p_target uuid, p_old text[], p_new text[], p_via text, p_note text default '')
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_p profiles;
begin
  select * into v_p from profiles where id = p_target;
  insert into role_changes (actor_id, actor_name, target_id, target_name, target_email, old_roles, new_roles, via, note)
  values (auth.uid(), coalesce(my_display_name(), ''), p_target, coalesce(v_p.full_name, ''), coalesce(v_p.email, ''),
          coalesce(p_old, '{}'), coalesce(p_new, '{}'), p_via, coalesce(p_note, ''));
end;
$$;

/** Role changes nobody logged (the SQL editor, the Table Editor, sign-up): one row per role added or removed. */
create or replace function public.log_unlogged_role_change()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid := coalesce(new.user_id, old.user_id);
  v_role text := coalesce(new.role, old.role);
  v_now  text[] := roles_of(v_user);
  v_p    profiles;
begin
  if coalesce(current_setting('onesolar.roles_logged', true), '') = 'on' then return null; end if;
  select * into v_p from profiles where id = v_user;
  insert into role_changes (actor_id, actor_name, target_id, target_name, target_email, old_roles, new_roles, via, note)
  values (auth.uid(), coalesce(my_display_name(), ''), v_user, coalesce(v_p.full_name, ''), coalesce(v_p.email, ''),
          case when tg_op = 'INSERT' then array_remove(v_now, v_role) else (select array_agg(r order by r) from unnest(v_now || v_role) r) end,
          v_now,
          case when tg_op = 'INSERT' and v_role = 'guest' and auth.uid() is null then 'sign-up' else 'database' end,
          case when tg_op = 'INSERT' then 'added ' else 'removed ' end || v_role);
  return null;
end;
$$;
drop trigger if exists log_role_changes on public.profile_roles;
create trigger log_role_changes after insert or delete on public.profile_roles
  for each row execute function public.log_unlogged_role_change();

-- ---- Giving people roles (same signature as 035; body only) ---------------------
create or replace function public.set_user_roles(p_user_id uuid, p_roles text[])
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_roles     text[] := coalesce(p_roles, '{}');
  v_unknown   text;
  v_was_admin boolean;
  v_old       text[];
  v_new       text[];
  v_role      text;
  v_problem   text;
begin
  perform require_permission('users.manage');
  if not exists (select 1 from profiles where id = p_user_id) then raise exception 'User not found.'; end if;
  select r into v_unknown from unnest(v_roles) r where r not in (select key from roles) limit 1;
  if v_unknown is not null then raise exception 'Unknown role "%".', v_unknown; end if;
  if 'guest' = any(v_roles) then raise exception 'Guest isn''t a role you can give. Leave every box unticked for Member.'; end if;
  if cardinality(v_roles) = 0 then v_roles := array['member']; end if;
  if p_user_id = auth.uid() and not is_admin() then
    raise exception 'You can''t change your own roles. Ask an Admin.';
  end if;

  v_was_admin := is_admin(p_user_id);
  if not is_admin() and v_was_admin then raise exception 'Only an Admin can change an Admin''s roles.'; end if;
  v_old := roles_of(p_user_id);
  select coalesce(array_agg(distinct r order by r), '{}') into v_new from unnest(v_roles) r;
  -- Every role being added or taken away (Guest goes by itself when someone is accepted).
  for v_role in
    select r from unnest(v_new) r where not r = any(v_old)
    union select r from unnest(v_old) r where not r = any(v_new) and r <> 'guest'
  loop
    v_problem := role_change_problem(v_role);
    if v_problem <> '' then raise exception '%', v_problem; end if;
  end loop;

  if v_old = v_new then return; end if;

  perform set_config('onesolar.roles_logged', 'on', true);
  delete from profile_roles where user_id = p_user_id;
  insert into profile_roles (user_id, role) select p_user_id, r from unnest(v_new) r;
  if v_was_admin and not exists (select 1 from profile_roles where role = 'admin') then
    raise exception 'This is the last Admin. Make someone else an Admin first, or nobody could manage Admins again.';
  end if;
  if 'guest' = any(v_old) then
    update profiles set accepted_at = coalesce(accepted_at, now()), accepted_by_name = coalesce(nullif(accepted_by_name, ''), coalesce(my_name(), ''))
    where id = p_user_id;
  end if;
  perform log_role_change(p_user_id, v_old, roles_of(p_user_id), 'set_user_roles');
  perform set_config('onesolar.roles_logged', 'off', true);
  perform assert_someone_can_manage_users();
end;
$$;

-- ---- Accepting and removing people: logged too (same signatures; bodies from 040 / 035 plus the log) ----
create or replace function public.accept_member(p_user uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_old text[];
begin
  perform require_permission('people.accept');
  if not exists (select 1 from profiles where id = p_user) then raise exception 'That account no longer exists.'; end if;
  if is_member(p_user) then return; end if;   -- someone else already did
  v_old := roles_of(p_user);
  perform set_config('onesolar.roles_logged', 'on', true);
  insert into profile_roles (user_id, role) values (p_user, 'member');
  update profiles set accepted_at = now(), accepted_by_name = coalesce(my_name(), '') where id = p_user;
  perform log_role_change(p_user, v_old, roles_of(p_user), 'accept_member');
  perform set_config('onesolar.roles_logged', 'off', true);
end;
$$;

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
  perform log_role_change(p_user_id, roles_of(p_user_id), '{}', 'remove_person', trim(coalesce(p_note, '')));

  -- Their name stays on what they did; the links to the account go.
  perform set_config('onesolar.roles_logged', 'on', true);
  delete from auth.users where id = p_user_id;   -- cascades to profiles, roles, watchers
  perform set_config('onesolar.roles_logged', 'off', true);
  perform assert_someone_can_manage_users();
end;
$$;

-- ---- Who may call what ----------------------------------------------------------
revoke execute on function public.role_permission_list(text), public.role_is_privileged(text), public.roles_of(uuid),
  public.log_role_change(uuid, text[], text[], text, text), public.log_unlogged_role_change()
  from public, anon, authenticated;
-- The website asks this to grey out the boxes a person can't change (the database decides either way).
revoke execute on function public.role_change_problem(text) from public, anon;
grant execute on function public.role_change_problem(text) to authenticated;

select public.migration_done(42, '042_role_guard.sql');
