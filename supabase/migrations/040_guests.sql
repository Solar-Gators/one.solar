-- =============================================================================
-- 040: New accounts start as Guest until someone on the team accepts them;
--      OneSolar is now called one.solar
-- =============================================================================
-- Run once, after 039: Supabase → SQL Editor → New query → paste → Run.
--
--   * New sign-ups get the built-in Guest role instead of Member. A guest can
--     sign in and use the public apps (GatorWire, the Scope Map, links), and
--     change their own name and email settings, but sees nothing of the team:
--     no requests, people, evals, files or settings, and can't make or change
--     anything (no orders, evals or attachments).
--   * "Accept new people" (people.accept) lets someone accept a guest into the
--     team as a Member. Every role except Guest gets it, so anyone on the team
--     (leads included) can, and so does any role added later. Change who has it
--     in Admin → Roles & permissions.
--     Giving a guest any role in Admin → People also accepts them.
--   * Everyone who already has an account keeps their roles: nobody becomes a
--     guest by running this.
--   * The checks are on the tables themselves (who can read them, and a
--     trigger on every write), so they hold for every app and every function.
-- =============================================================================

insert into public.roles (key, label, sort) values ('guest', 'Guest', -1) on conflict (key) do nothing;

insert into public.permissions (key, label, description, sort) values
  ('people.accept', 'Accept new people', 'Accept someone who signed up into the team, as a Member. Until then they''re a Guest and see only the public apps.', 1)
on conflict (key) do nothing;
insert into public.role_permissions (role, permission)
select key, 'people.accept' from public.roles where key <> 'guest'
on conflict do nothing;
select public.record_permissions_snapshot();

alter table public.profiles add column if not exists accepted_at timestamptz;
alter table public.profiles add column if not exists accepted_by_name text not null default '';

/** Is this person on the team: any role other than Guest? (Default: the signed-in person.) */
create or replace function public.is_member(p_user uuid default null)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from profile_roles where user_id = coalesce(p_user, auth.uid()) and role <> 'guest');
$$;
revoke execute on function public.is_member(uuid) from public, anon;
grant execute on function public.is_member(uuid) to authenticated;

-- New accounts start as Guest.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_domains jsonb;
  v_domain  text := lower(split_part(new.email, '@', 2));
begin
  select value -> 'allowedEmailDomains' into v_domains from app_settings where key = 'general';

  if v_domains is not null and jsonb_array_length(v_domains) > 0 and not exists (
    select 1 from jsonb_array_elements_text(v_domains) d
    where v_domain = lower(d) or v_domain like '%.' || lower(d)
  ) then
    raise exception 'Sign-ups are limited to % email addresses.',
      (select string_agg('@' || d, ', ') from jsonb_array_elements_text(v_domains) d);
  end if;

  insert into profiles (id, email, full_name)
  values (new.id, new.email, coalesce(trim(new.raw_user_meta_data ->> 'full_name'), ''));
  insert into profile_roles (user_id, role) values (new.id, 'guest');
  return new;
end;
$$;

-- Guest is only ever on its own: any other role replaces it (so giving a guest a role in
-- Admin → People accepts them).
create or replace function public.guest_role_alone()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.role <> 'guest' then
    delete from profile_roles where user_id = new.user_id and role = 'guest';
  elsif exists (select 1 from profile_roles where user_id = new.user_id and role <> 'guest') then
    return null;   -- already on the team: ignore
  end if;
  return new;
end;
$$;
drop trigger if exists guest_role_alone on public.profile_roles;
create trigger guest_role_alone before insert on public.profile_roles
  for each row execute function public.guest_role_alone();

-- The Guest role can't be deleted or given permissions. New roles can accept people (anyone on the team can).
create or replace function public.guest_role_kept()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if old.key = 'guest' then raise exception 'Guest is built in: it''s what new accounts are until someone accepts them.'; end if;
  return old;
end;
$$;
drop trigger if exists guest_role_kept on public.roles;
create trigger guest_role_kept before delete on public.roles for each row execute function public.guest_role_kept();

create or replace function public.guest_no_permissions()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.role = 'guest' then raise exception 'Guests can''t have permissions. Accept them into the team (or give them a role) instead.'; end if;
  return new;
end;
$$;
drop trigger if exists guest_no_permissions on public.role_permissions;
create trigger guest_no_permissions before insert or update on public.role_permissions for each row execute function public.guest_no_permissions();

create or replace function public.new_role_can_accept()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.key <> 'guest' then
    insert into role_permissions (role, permission) values (new.key, 'people.accept') on conflict do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists new_role_can_accept on public.roles;
create trigger new_role_can_accept after insert on public.roles for each row execute function public.new_role_can_accept();

-- ---------------------------------------------------------------------------
-- Accepting people
-- ---------------------------------------------------------------------------
/** Everyone waiting to be accepted (guests), newest first. */
create or replace function public.waiting_guests()
returns table (id uuid, full_name text, email text, created_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('people.accept');
  return query
    select p.id, p.full_name, p.email, p.created_at from profiles p
    where not is_member(p.id)
    order by p.created_at desc;
end;
$$;

/** Accept a guest into the team as a Member. */
create or replace function public.accept_member(p_user uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('people.accept');
  if not exists (select 1 from profiles where id = p_user) then raise exception 'That account no longer exists.'; end if;
  if is_member(p_user) then return; end if;   -- someone else already did
  insert into profile_roles (user_id, role) values (p_user, 'member');
  update profiles set accepted_at = now(), accepted_by_name = coalesce(my_name(), '') where id = p_user;
end;
$$;
revoke execute on function public.waiting_guests(), public.accept_member(uuid) from public, anon;
grant execute on function public.waiting_guests(), public.accept_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- What guests can read: their own account, the role names, and the public settings
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['approvals', 'archive_imports', 'archive_orders', 'cost_changes', 'eval_groups', 'eval_questions',
                           'eval_types', 'order_information', 'request_events', 'request_items', 'request_watchers', 'requests',
                           'settings_history'] loop
    execute format('alter policy "signed-in read" on public.%I using (public.is_member())', t);
  end loop;
  foreach t in array array['eval_questionnaires', 'eval_templates', 'eval_tracks'] loop
    execute format('alter policy "signed-in read" on public.%I using (removed_at is null and public.is_member())', t);
  end loop;
end;
$$;
alter policy "signed-in read" on public.profiles using (id = auth.uid() or public.is_member());
alter policy "signed-in read" on public.profile_roles using (user_id = auth.uid() or public.is_member());
alter policy "signed-in read" on public.app_settings using (public.is_member() or key in ('general', 'appearance', 'onesolar'));

-- Files: only for people on the team (this also covers the storage bucket's policies).
create or replace function public.attachment_access(p_kind text, p_owner uuid, p_edit boolean)
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not is_member() then return false; end if;
  if p_kind = 'sponsor' then
    return has_permission('sponsors.edit') or (not p_edit and has_permission('sponsors.view'));
  elsif p_kind = 'request' then
    return not p_edit
      or has_permission('request.review') or has_permission('request.order')
      or exists (select 1 from requests where id = p_owner and created_by = auth.uid());
  elsif p_kind in ('finance', 'purchase') then
    return has_permission('finances.edit') or (not p_edit and has_permission('finances.view'));
  end if;
  return false;
end;
$$;

-- Solar Evals: a guest never fits a "who" rule (not even "anyone"), so they can't be evaluated,
-- evaluate, give input, or read an eval.
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
      else false
    end;
$$;

-- ---------------------------------------------------------------------------
-- What guests can't change: every write to the team's data checks the person making it
-- ---------------------------------------------------------------------------
create or replace function public.require_member_write()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null and not is_member() then
    raise exception 'Your account hasn''t been accepted into the team yet. Ask someone on the team to accept you on the one.solar home screen.';
  end if;
  return coalesce(new, old);
end;
$$;
do $$
declare t text;
begin
  foreach t in array array['requests', 'request_items', 'request_events', 'approvals', 'cost_changes', 'request_watchers',
                           'attachments', 'evals', 'eval_input_notes', 'eval_questions', 'eval_groups', 'eval_types',
                           'eval_tracks', 'eval_templates', 'eval_questionnaires', 'sponsor_cards', 'sponsor_activity',
                           'sponsor_watchers', 'finance_rows', 'finance_purchases', 'finance_funds', 'finance_sheets',
                           'finance_seasons', 'archive_orders', 'archive_imports', 'app_settings'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists require_member_write on public.%I', t);
      execute format('create trigger require_member_write before insert or update or delete on public.%I
                        for each row execute function public.require_member_write()', t);
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- The new name: OneSolar is now one.solar, in the database's messages and the saved wording too
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prosrc like '%OneSolar%' loop
    execute replace(pg_get_functiondef(f.oid), 'OneSolar', 'one.solar');
  end loop;
end;
$$;
update app_settings set value = replace(value::text, 'OneSolar', 'one.solar')::jsonb where value::text like '%OneSolar%';

update app_settings set value = jsonb_set(value, '{schemaVersion}', '40') where key = 'general';
