select public.migration_begin(46);

-- 046: Admins see what goes wrong in people's browsers, and people can report a problem.
--
--   * client_errors: errors the pages hit (and "Report a problem" messages), with the app, the build,
--     and the page (path and #route only: never the query string, which can hold sign-in codes).
--     No IP addresses, form contents, cookies or tokens. Anything that looks like a token or an email
--     address is blanked out, in the browser and again here.
--   * log_client_error(): callable signed out too (the sign-in page must be able to report). Capped at
--     10 a minute per person and 30 a minute from signed-out pages; the same error from the same person
--     within 10 minutes only adds to a count.
--   * Admin → one.solar → Diagnostics reads it (needs "Change workflow & notifications", like the
--     notification log). Rows older than 90 days are deleted when that page opens.

create table if not exists public.client_errors (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  last_at  timestamptz not null default now(),
  count    int not null default 1,
  user_id  uuid,                      -- no foreign key: kept if the account goes
  app      text not null default '',
  version  text not null default '',
  kind     text not null check (kind in ('error', 'rejection', 'report')),
  message  text not null default '',
  detail   text not null default '',
  path     text not null default '',
  ua       text not null default '',
  status   text not null default 'new' check (status in ('new', 'resolved'))
);
create index if not exists client_errors_recent on public.client_errors (last_at desc);
create index if not exists client_errors_user_at on public.client_errors (user_id, at desc);
alter table public.client_errors enable row level security;
revoke all on public.client_errors from anon, authenticated;
revoke all on sequence public.client_errors_id_seq from anon, authenticated;
grant select on public.client_errors to authenticated;
drop policy if exists "admins read" on public.client_errors;
create policy "admins read" on public.client_errors for select to authenticated
  using (public.is_member() and public.has_permission('workflow.edit'));

/** Blank out anything that looks like a token or an email address, and cut to p_max characters. */
create or replace function public.scrub_diagnostic(p_text text, p_max int)
returns text
language sql immutable set search_path = pg_catalog
as $$
  select left(
    regexp_replace(
      regexp_replace(coalesce(p_text, ''), 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?', '[token]', 'g'),
      '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]', 'g'),
    p_max);
$$;

/** Record an error or a problem report from a page. Never fails the page: over the limits it does nothing. */
create or replace function public.log_client_error(p jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_kind    text := case when p ->> 'kind' in ('error', 'rejection', 'report') then p ->> 'kind' else 'error' end;
  v_message text := scrub_diagnostic(p ->> 'message', 500);
  v_version text := left(coalesce(p ->> 'version', ''), 40);
  -- Path and #route only: drop any query string, and anything after the route in the hash.
  v_path    text := left(regexp_replace(regexp_replace(coalesce(p ->> 'path', ''), '\?[^#]*', ''), '#([^?&=]*).*$', '#\1'), 200);
  v_id      bigint;
begin
  if v_uid is null then
    if (select count(*) from client_errors where user_id is null and at > now() - interval '1 minute') >= 30 then return; end if;
  elsif (select count(*) from client_errors where user_id = v_uid and at > now() - interval '1 minute') >= 10 then
    return;
  end if;
  if v_kind <> 'report' then
    select id into v_id from client_errors
    where user_id is not distinct from v_uid and message = v_message and version = v_version and kind = v_kind
      and last_at > now() - interval '10 minutes'
    order by id desc limit 1;
    if v_id is not null then
      update client_errors set count = count + 1, last_at = now() where id = v_id;
      return;
    end if;
  end if;
  insert into client_errors (user_id, app, version, kind, message, detail, path, ua)
  values (v_uid, left(coalesce(p ->> 'app', ''), 20), v_version, v_kind, v_message,
          scrub_diagnostic(p ->> 'detail', 2000), scrub_diagnostic(v_path, 200), left(coalesce(p ->> 'ua', ''), 200));
end;
$$;

/** Diagnostics: mark a report resolved (or new again). */
create or replace function public.set_client_error_status(p_id bigint, p_status text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('workflow.edit');
  if p_status not in ('new', 'resolved') then raise exception 'Unknown status.'; end if;
  update client_errors set status = p_status where id = p_id;
end;
$$;

/** Delete diagnostics older than 90 days. Returns how many went. */
create or replace function public.purge_old_diagnostics()
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare n int;
begin
  perform require_permission('workflow.edit');
  delete from client_errors where last_at < now() - interval '90 days';
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.scrub_diagnostic(text, int) from public, anon, authenticated;
revoke execute on function public.log_client_error(jsonb), public.set_client_error_status(bigint, text), public.purge_old_diagnostics() from public;
grant execute on function public.log_client_error(jsonb) to anon, authenticated;
revoke execute on function public.set_client_error_status(bigint, text), public.purge_old_diagnostics() from anon;
grant execute on function public.set_client_error_status(bigint, text), public.purge_old_diagnostics() to authenticated;

select public.migration_done(46, '046_diagnostics.sql');
