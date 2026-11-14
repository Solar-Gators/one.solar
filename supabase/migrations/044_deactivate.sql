select public.migration_begin(44);

-- 044: people who leave are deactivated, not deleted.
--
--   Active           any role other than Guest / Former member: as their roles allow.
--   Former member    the built-in role "alumni" (shown as "Former member"), on its own like Guest. They see
--                    none of the team's data and can change nothing. Everything they did stays, with their
--                    name. By default they also can't sign in (Admin → Team & season → "Former members can
--                    sign in" turns that off). Reactivate gives them roles again.
--   Deleted          only an Admin, only for a former member or a guest: the login goes. Their eval notes
--                    stay (without the link to the account), and their eval questions are archived.
--
-- Also closes a gap that mattered only once accounts are kept: reading an eval now requires being on the
-- team, for every route (evaluator, subject, input, viewers, extra readers, notes). Former members can't
-- read evals, their own included.
--
-- Rolling back: reactivate the affected people; the eval policies from 036 are kept as comments at the end.

-- ---- The role --------------------------------------------------------------------
insert into public.roles (key, label, sort) values ('alumni', 'Former member', -2) on conflict (key) do nothing;
delete from public.role_permissions where role = 'alumni';

/** On the team: any role other than Guest (not accepted yet) or Former member. (Default: the signed-in person.) */
create or replace function public.is_member(p_user uuid default null)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from profile_roles where user_id = coalesce(p_user, auth.uid()) and role not in ('guest', 'alumni'));
$$;

/** A former member (deactivated). */
create or replace function public.is_former_member(p_user uuid default null)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from profile_roles where user_id = coalesce(p_user, auth.uid()) and role = 'alumni');
$$;

-- Guest and Former member are each only ever on their own: a team role replaces either; Former member
-- replaces everything. (040's version handled Guest only.)
create or replace function public.guest_role_alone()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.role = 'alumni' then
    delete from profile_roles where user_id = new.user_id and role <> 'alumni';
  elsif new.role <> 'guest' then
    delete from profile_roles where user_id = new.user_id and role in ('guest', 'alumni');
  elsif exists (select 1 from profile_roles where user_id = new.user_id and role <> 'guest') then
    return null;   -- already on the team (or a former member): ignore
  end if;
  return new;
end;
$$;

create or replace function public.guest_role_kept()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if old.key = 'guest' then raise exception 'Guest is built in: it''s what new accounts are until someone accepts them.'; end if;
  if old.key = 'alumni' then raise exception 'Former member is built in: it''s what people are after they''re deactivated.'; end if;
  return old;
end;
$$;

create or replace function public.guest_no_permissions()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.role = 'guest' then raise exception 'Guests can''t have permissions. Accept them into the team (or give them a role) instead.'; end if;
  if new.role = 'alumni' then raise exception 'Former members can''t have permissions. Reactivate them instead.'; end if;
  return new;
end;
$$;

-- Writes by someone not on the team: say which of the two they are.
create or replace function public.require_member_write()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null and not is_member() then
    if is_former_member() then
      raise exception 'Your one.solar access has ended. Ask an Admin if this is a mistake.';
    end if;
    raise exception 'Your account hasn''t been accepted into the team yet. Ask someone on the team to accept you on the one.solar home screen.';
  end if;
  return coalesce(new, old);
end;
$$;

-- No more emails or Teams messages to former members (whatever queues them).
create or replace function public.skip_former_member_notifications()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.recipient_id is not null and is_former_member(new.recipient_id) then return null; end if;
  return new;
end;
$$;
drop trigger if exists skip_former_member_notifications on public.notification_outbox;
create trigger skip_former_member_notifications before insert on public.notification_outbox
  for each row execute function public.skip_former_member_notifications();

-- ---- Signing in ---------------------------------------------------------------------
/** Admin → Team & season: may former members still sign in (to see the "your access has ended" page)? */
create or replace function public.former_members_blocked()
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select (value ->> 'formerMembersCanSignIn')::boolean from app_settings where key = 'general'), false) is not true;
$$;

/** Block (or unblock) someone's sign-in and end their sessions. Supabase-only parts are skipped elsewhere. */
create or replace function public.set_sign_in_blocked(p_user uuid, p_blocked boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update auth.users set banned_until = case when p_blocked then 'infinity'::timestamptz end where id = p_user;
  if p_blocked then
    if to_regclass('auth.sessions') is not null then execute 'delete from auth.sessions where user_id = $1' using p_user; end if;
    if to_regclass('auth.refresh_tokens') is not null then
      execute 'delete from auth.refresh_tokens where user_id = $1::text' using p_user;
    end if;
  end if;
end;
$$;

-- Only an Admin changes who can sign up (043) or whether former members can sign in.
create or replace function public.guard_sign_up_domains()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.key = 'general' and auth.uid() is not null and not is_admin() then
    if (old.value -> 'allowedEmailDomains') is distinct from (new.value -> 'allowedEmailDomains') then
      raise exception 'Only an Admin can change which email addresses can sign up.';
    end if;
    if (old.value -> 'formerMembersCanSignIn') is distinct from (new.value -> 'formerMembersCanSignIn') then
      raise exception 'Only an Admin can change whether former members can sign in.';
    end if;
  end if;
  return new;
end;
$$;

-- ---- Deactivating and reactivating -------------------------------------------------------
/** Someone left the team: their roles go (kept in the record), their data stays, they lose access. */
create or replace function public.deactivate_person(p_user uuid, p_note text default '')
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_old     text[];
  v_role    text;
  v_problem text;
begin
  perform require_permission('users.manage');
  if not exists (select 1 from profiles where id = p_user) then raise exception 'User not found.'; end if;
  if p_user = auth.uid() then raise exception 'You can''t deactivate yourself. Ask someone else who manages people.'; end if;
  if is_former_member(p_user) then return; end if;   -- someone else already did
  if not is_member(p_user) then
    raise exception 'They haven''t been accepted into the team. Use "Not on the team" to turn them away instead.';
  end if;
  if is_admin(p_user) and not is_admin() then raise exception 'Only an Admin can deactivate an Admin.'; end if;
  if is_admin(p_user) and not exists (select 1 from profile_roles where role = 'admin' and user_id <> p_user) then
    raise exception 'This is the last Admin. Make someone else an Admin first.';
  end if;
  v_old := roles_of(p_user);
  -- Taking their roles away follows the same rule as unticking them (042).
  foreach v_role in array v_old loop
    v_problem := role_change_problem(v_role);
    if v_problem <> '' then raise exception '%', v_problem; end if;
  end loop;

  perform set_config('onesolar.roles_logged', 'on', true);
  insert into profile_roles (user_id, role) values (p_user, 'alumni');   -- replaces every other role
  perform log_role_change(p_user, v_old, roles_of(p_user), 'deactivate_person', trim(coalesce(p_note, '')));
  perform set_config('onesolar.roles_logged', 'off', true);

  delete from request_watchers where user_id = p_user;
  delete from sponsor_watchers where user_id = p_user;
  update notification_outbox set status = 'failed', error = 'Not sent: the person was deactivated.'
  where recipient_id = p_user and status in ('pending', 'sending');
  if former_members_blocked() then perform set_sign_in_blocked(p_user, true); end if;
  perform assert_someone_can_manage_users();
end;
$$;

/** Bring a former member back, with these roles (empty = Member). */
create or replace function public.reactivate_person(p_user uuid, p_roles text[] default '{}')
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_roles   text[] := coalesce(p_roles, '{}');
  v_old     text[];
  v_role    text;
  v_problem text;
begin
  perform require_permission('users.manage');
  if not is_former_member(p_user) then raise exception 'They aren''t deactivated.'; end if;
  if exists (select 1 from unnest(v_roles) r where r in ('guest', 'alumni')) then raise exception 'Choose the roles they should have.'; end if;
  if exists (select 1 from unnest(v_roles) r where r not in (select key from roles)) then raise exception 'Unknown role.'; end if;
  if cardinality(v_roles) = 0 then v_roles := array['member']; end if;
  foreach v_role in array v_roles loop
    v_problem := role_change_problem(v_role);
    if v_problem <> '' then raise exception '%', v_problem; end if;
  end loop;

  v_old := roles_of(p_user);
  perform set_config('onesolar.roles_logged', 'on', true);
  insert into profile_roles (user_id, role) select distinct p_user, r from unnest(v_roles) r;   -- replaces Former member
  perform log_role_change(p_user, v_old, roles_of(p_user), 'reactivate_person');
  perform set_config('onesolar.roles_logged', 'off', true);
  perform set_sign_in_blocked(p_user, false);
end;
$$;

-- ---- Giving roles: never Guest or Former member by ticking a box (body of 042 plus that) ----
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
  if 'alumni' = any(v_roles) then raise exception 'To take someone off the team, use Deactivate.'; end if;
  if is_former_member(p_user_id) then raise exception 'They''re a former member. Use Reactivate to give them roles again.'; end if;
  if cardinality(v_roles) = 0 then v_roles := array['member']; end if;
  if p_user_id = auth.uid() and not is_admin() then
    raise exception 'You can''t change your own roles. Ask an Admin.';
  end if;

  v_was_admin := is_admin(p_user_id);
  if not is_admin() and v_was_admin then raise exception 'Only an Admin can change an Admin''s roles.'; end if;
  v_old := roles_of(p_user_id);
  select coalesce(array_agg(distinct r order by r), '{}') into v_new from unnest(v_roles) r;
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

-- ---- Guests and former members are different people (bodies of 040 / 043 plus that) ----------
create or replace function public.waiting_guests()
returns table (id uuid, full_name text, email text, created_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('people.accept');
  return query
    select p.id, p.full_name, p.email, p.created_at from profiles p
    where exists (select 1 from profile_roles r where r.user_id = p.id and r.role = 'guest') and not is_member(p.id)
    order by p.created_at desc;
end;
$$;

create or replace function public.waiting_people()
returns table (id uuid, full_name text, email text, created_at timestamptz, email_confirmed boolean)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('people.accept');
  return query
    select p.id, p.full_name, p.email, p.created_at, u.email_confirmed_at is not null
    from profiles p join auth.users u on u.id = p.id
    where exists (select 1 from profile_roles r where r.user_id = p.id and r.role = 'guest') and not is_member(p.id)
    order by p.created_at desc;
end;
$$;

create or replace function public.accept_member(p_user uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_old text[];
begin
  perform require_permission('people.accept');
  if not exists (select 1 from profiles where id = p_user) then raise exception 'That account no longer exists.'; end if;
  if is_member(p_user) then return; end if;   -- someone else already did
  if is_former_member(p_user) then
    raise exception 'They''re a former member. Someone who manages people can reactivate them in Admin → Users.';
  end if;
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
    raise exception 'They''re already on the team. To take someone off the team, use Admin → Users → Deactivate.';
  end if;
  if is_former_member(p_user) then raise exception 'They''re a former member, not someone waiting to join.'; end if;
  insert into removed_people (email, full_name, roles, note, removed_by, removed_by_name)
  values (v_p.email, coalesce(v_p.full_name, ''), roles_of(p_user),
          trim('Not accepted. ' || trim(coalesce(p_note, ''))), auth.uid(), coalesce(my_display_name(), ''));
  perform log_role_change(p_user, roles_of(p_user), '{}', 'decline_guest', trim(coalesce(p_note, '')));
  perform set_config('onesolar.roles_logged', 'on', true);
  delete from auth.users where id = p_user;
  perform set_config('onesolar.roles_logged', 'off', true);
end;
$$;

-- ---- Deleting an account keeps eval content ------------------------------------------------
-- Notes keep their text and author's name; only the link to the account goes.
alter table public.eval_input_notes drop constraint if exists eval_input_notes_pkey;
alter table public.eval_input_notes drop constraint if exists eval_input_notes_author_id_fkey;
alter table public.eval_input_notes alter column author_id drop not null;
alter table public.eval_input_notes add constraint eval_input_notes_author_id_fkey
  foreign key (author_id) references public.profiles(id) on delete set null;
alter table public.eval_input_notes add constraint eval_input_notes_eval_author unique (eval_id, author_id);

-- A CE's own questions are copied into each eval when it's made, so evals never lose them. The saved
-- list itself is kept here when its owner's account is deleted.
create table if not exists public.eval_questions_archive (
  id                bigserial primary key,
  former_owner_id   uuid not null,
  former_owner_name text not null default '',
  questions         jsonb not null,
  updated_at        timestamptz,
  archived_at       timestamptz not null default now()
);
alter table public.eval_questions_archive enable row level security;
revoke all on public.eval_questions_archive from anon, authenticated;
revoke all on sequence public.eval_questions_archive_id_seq from anon, authenticated;
grant select on public.eval_questions_archive to authenticated;
drop policy if exists "eval setup read" on public.eval_questions_archive;
create policy "eval setup read" on public.eval_questions_archive for select to authenticated
  using (public.is_member() and public.has_permission('evals.types'));

create or replace function public.archive_eval_questions()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  insert into eval_questions_archive (former_owner_id, former_owner_name, questions, updated_at)
  values (old.owner_id,
          coalesce((select full_name from profiles where id = old.owner_id), nullif(current_setting('onesolar.removed_name', true), ''), ''),
          old.questions, old.updated_at);
  return old;
end;
$$;
drop trigger if exists archive_eval_questions on public.eval_questions;
create trigger archive_eval_questions before delete on public.eval_questions
  for each row execute function public.archive_eval_questions();

/** Delete someone's account for good: Admins only, and only a former member or a guest. */
create or replace function public.remove_person(p_user_id uuid, p_note text default '')
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_p profiles;
begin
  perform require_permission('users.manage');
  if not is_admin() then raise exception 'Only an Admin can delete an account. Deactivate them instead: that keeps their history.'; end if;
  select * into v_p from profiles where id = p_user_id;
  if not found then raise exception 'User not found.'; end if;
  if p_user_id = auth.uid() then raise exception 'You can''t delete your own account here.'; end if;
  if is_member(p_user_id) then raise exception 'Deactivate them first. Deleting is only for former members and guests.'; end if;

  -- What they had on the team: for a former member, the roles they had before they were deactivated.
  insert into removed_people (email, full_name, roles, note, removed_by, removed_by_name)
  values (v_p.email, coalesce(v_p.full_name, ''),
          case when is_former_member(p_user_id)
               then coalesce((select old_roles from role_changes where target_id = p_user_id and via = 'deactivate_person'
                              order by id desc limit 1), '{}')
               else roles_of(p_user_id) end,
          trim(coalesce(p_note, '')), auth.uid(), coalesce(my_display_name(), ''));
  perform log_role_change(p_user_id, roles_of(p_user_id), '{}', 'remove_person', trim(coalesce(p_note, '')));

  perform set_config('onesolar.roles_logged', 'on', true);
  perform set_config('onesolar.removed_name', coalesce(v_p.full_name, ''), true);
  delete from auth.users where id = p_user_id;   -- cascades to the profile, roles and watchers; notes are kept
  perform set_config('onesolar.removed_name', '', true);
  perform set_config('onesolar.roles_logged', 'off', true);
  perform assert_someone_can_manage_users();
end;
$$;

-- ---- Reading evals requires being on the team (every route) ----------------------------------
create or replace function public.eval_visible_to_me(s jsonb, p_status text, p_subject uuid, p_member uuid, p_inputs uuid[])
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v jsonb := coalesce(s, eval_default_settings()) -> 'visibility';
begin
  if auth.uid() is null or not is_member() then return false; end if;
  return (p_status = 'shared' and p_member = auth.uid())
      or (p_subject = auth.uid() and eval_stage_ok(p_status, v -> 'eval' ->> 'subject'))
      or (auth.uid() = any(p_inputs) and eval_stage_ok(p_status, v -> 'eval' ->> 'input'))
      or (eval_stage_ok(p_status, v -> 'eval' ->> 'viewers') and has_permission('evals.view'))
      or (eval_stage_ok(p_status, v -> 'eval' ->> 'extra') and eval_rule_match(v -> 'extraWho', auth.uid()));
end;
$$;

create or replace function public.eval_answers_visible(p_self uuid)
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare s evals; c evals; v jsonb;
begin
  if auth.uid() is null or not is_member() then return false; end if;
  select * into s from evals where id = p_self and kind = 'self';
  if s.id is null or s.status = 'draft' then return false; end if;
  select * into c from evals where self_eval_id = p_self and kind = 'ce';
  v := coalesce(s.type_settings, eval_default_settings()) -> 'visibility' -> 'answers';
  return exists (
    select 1 from (values
        ((coalesce(c.evaluator_id, s.ce_id) = auth.uid()), v ->> 'evaluator'),
        ((auth.uid() = any(s.input_ids || coalesce(c.input_ids, '{}'))), v ->> 'input'),
        (has_permission('evals.view'), v ->> 'viewers'),
        (eval_rule_match(coalesce(s.type_settings, eval_default_settings()) -> 'visibility' -> 'extraWho', auth.uid()), v ->> 'extra')
      ) as a(who, lvl)
    where a.who and case a.lvl
      when 'submitted' then true
      when 'final'     then c.status in ('final', 'shared')
      when 'shared'    then c.status = 'shared'
      else false end);
end;
$$;

drop policy if exists "eval readers" on public.evals;
create policy "eval readers" on public.evals for select to authenticated using (
  public.is_member() and
  case when kind = 'self' then
    evaluator_id = auth.uid() or (status <> 'draft' and public.eval_answers_visible(id))
  else
    evaluator_id = auth.uid() or public.eval_visible_to_me(type_settings, status, subject_id, member_id, input_ids)
  end
);

drop policy if exists "author or evaluator" on public.eval_input_notes;
create policy "author or evaluator" on public.eval_input_notes for select to authenticated using (
  public.is_member() and
  (author_id = auth.uid() or exists (select 1 from evals e where e.id = eval_id and e.evaluator_id = auth.uid()))
);

-- ---- Who may call what ----------------------------------------------------------------------
revoke execute on function public.is_former_member(uuid), public.former_members_blocked(), public.set_sign_in_blocked(uuid, boolean),
  public.skip_former_member_notifications(), public.archive_eval_questions()
  from public, anon, authenticated;
revoke execute on function public.deactivate_person(uuid, text), public.reactivate_person(uuid, text[]) from public, anon;
grant execute on function public.deactivate_person(uuid, text), public.reactivate_person(uuid, text[]) to authenticated;

-- The 036 eval policies, to restore if this has to be undone:
--   create policy "eval readers" on public.evals for select to authenticated using (
--     case when kind = 'self' then evaluator_id = auth.uid() or (status <> 'draft' and eval_answers_visible(id))
--     else evaluator_id = auth.uid() or eval_visible_to_me(type_settings, status, subject_id, member_id, input_ids) end);
--   create policy "author or evaluator" on public.eval_input_notes for select to authenticated using (
--     author_id = auth.uid() or exists (select 1 from evals e where e.id = eval_id and e.evaluator_id = auth.uid()));

select public.migration_done(44, '044_deactivate.sql');
