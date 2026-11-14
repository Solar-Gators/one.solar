select public.migration_begin(43);

-- 043: only the people who should let others in can, and only confirmed accounts get in.
--
--   * "Accept new people" (people.accept) stays with Admin, Chief Engineer and E-board only. 040 gave it
--     to every role (Member too) and to every role created later; both stop here. An Admin can still
--     tick it for any role under Roles & permissions.
--   * An account can be accepted only after its email address is confirmed.
--   * waiting_people(): who is waiting, and whether they confirmed their email (waiting_guests() is
--     unchanged, so pages from before 043 keep working).
--   * decline_guest(): turn away someone who isn't on Solar Gators. Their account is deleted and they're
--     listed under Removed people, so if they sign up again it's flagged.
--   * Only an Admin changes which email addresses can sign up (Team & season → allowed email domains).

-- ---- Who can accept people --------------------------------------------------------
drop trigger if exists new_role_can_accept on public.roles;
drop function if exists public.new_role_can_accept();
delete from public.role_permissions
where permission = 'people.accept' and role not in ('admin', 'ce', 'eboard');
select public.record_permissions_snapshot();

-- ---- Accepting: confirmed accounts only (body of 042 plus the check) ----------------
create or replace function public.accept_member(p_user uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_old text[];
begin
  perform require_permission('people.accept');
  if not exists (select 1 from profiles where id = p_user) then raise exception 'That account no longer exists.'; end if;
  if is_member(p_user) then return; end if;   -- someone else already did
  if not exists (select 1 from auth.users where id = p_user and email_confirmed_at is not null) then
    raise exception 'They haven''t confirmed their email address yet. Ask them to click the link in the email one.solar sent them, then accept them.';
  end if;
  v_old := roles_of(p_user);
  perform set_config('onesolar.roles_logged', 'on', true);
  insert into profile_roles (user_id, role) values (p_user, 'member');
  update profiles set accepted_at = now(), accepted_by_name = coalesce(my_name(), '') where id = p_user;
  perform log_role_change(p_user, v_old, roles_of(p_user), 'accept_member');
  perform set_config('onesolar.roles_logged', 'off', true);
end;
$$;

/** Everyone waiting to be accepted, newest first, and whether they confirmed their email address. */
create or replace function public.waiting_people()
returns table (id uuid, full_name text, email text, created_at timestamptz, email_confirmed boolean)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('people.accept');
  return query
    select p.id, p.full_name, p.email, p.created_at, u.email_confirmed_at is not null
    from profiles p join auth.users u on u.id = p.id
    where not is_member(p.id)
    order by p.created_at desc;
end;
$$;

/** Turn away someone waiting to join: their account goes, and a new sign-up with that email is flagged. */
create or replace function public.decline_guest(p_user uuid, p_note text default '')
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_p profiles;
begin
  perform require_permission('people.accept');
  select * into v_p from profiles where id = p_user;
  if not found then return; end if;   -- someone else already did
  if is_member(p_user) then
    raise exception 'They''re already on the team. To remove someone on the team, use Admin → Users → Remove.';
  end if;
  insert into removed_people (email, full_name, roles, note, removed_by, removed_by_name)
  values (v_p.email, coalesce(v_p.full_name, ''), roles_of(p_user),
          trim('Not accepted. ' || trim(coalesce(p_note, ''))), auth.uid(), coalesce(my_display_name(), ''));
  perform log_role_change(p_user, roles_of(p_user), '{}', 'decline_guest', trim(coalesce(p_note, '')));
  perform set_config('onesolar.roles_logged', 'on', true);
  delete from auth.users where id = p_user;   -- cascades to the profile and the Guest role
  perform set_config('onesolar.roles_logged', 'off', true);
end;
$$;

-- ---- Who can sign up: Admins only ------------------------------------------------------
/** The website changes settings through update_settings / restore_settings_version; this covers both. */
create or replace function public.guard_sign_up_domains()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.key = 'general' and auth.uid() is not null and not is_admin()
     and (old.value -> 'allowedEmailDomains') is distinct from (new.value -> 'allowedEmailDomains') then
    raise exception 'Only an Admin can change which email addresses can sign up.';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_sign_up_domains on public.app_settings;
create trigger guard_sign_up_domains before update on public.app_settings
  for each row execute function public.guard_sign_up_domains();

revoke execute on function public.guard_sign_up_domains() from public, anon, authenticated;
revoke execute on function public.waiting_people(), public.decline_guest(uuid, text) from public, anon;
grant execute on function public.waiting_people(), public.decline_guest(uuid, text) to authenticated;

select public.migration_done(43, '043_accept_guard.sql');
