select public.migration_begin(48);

-- 048: imports can't be run twice by accident (I-3), and imported requests are linked to someone's
-- account only once they're on the team (I-4).
--
--   * import_batches: each import (this season's requests, or an archived sheet) with a fingerprint of
--     its rows, the file name, who ran it and when. import_requests_once / import_archive_once refuse
--     the same rows a second time ("This file was already imported on Nov 3 by Tess Treasurer. Import
--     again anyway?") unless the page passes p_allow_repeat after asking. The old import_requests and
--     import_archive are unchanged, for pages that haven't reloaded.
--   * Linking by name (012) used to happen whenever anyone signed up or renamed themselves, so a new
--     account named like a member picked up that member's imported requests. Now:
--       - signing up or renaming links nothing;
--       - names only match people on the team (not Guests);
--       - when someone is accepted (or reactivated, or given a team role), their requests are linked,
--         and each request's History says "Linked to <name>'s account".
--     Leads still choose by hand on the request page (set_request_owner), and a hand choice is never
--     changed automatically.

-- ---------------------------------------------------------------------------
-- I-3: repeat imports
-- ---------------------------------------------------------------------------
create table if not exists public.import_batches (
  id               bigserial primary key,
  kind             text not null check (kind in ('requests', 'archive')),
  fingerprint      text not null,
  source_file      text not null default '',
  row_count        int not null default 0,
  imported_by      uuid references public.profiles(id) on delete set null,
  imported_by_name text not null default '',
  imported_at      timestamptz not null default now()
);
create index if not exists import_batches_fingerprint_idx on public.import_batches (kind, fingerprint);

alter table public.import_batches enable row level security;
drop policy if exists "importers read" on public.import_batches;
create policy "importers read" on public.import_batches for select to authenticated
  using (public.is_member() and public.has_permission('seasons.manage'));
revoke all on public.import_batches from anon, authenticated;
grant select on public.import_batches to authenticated;

-- Refuse rows that were imported before (SQLSTATE OS410, so the page can ask "Import again anyway?").
create or replace function public.refuse_repeat_import(p_kind text, p_fingerprint text, p_allow_repeat boolean)
returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare b import_batches;
begin
  select * into b from import_batches where kind = p_kind and fingerprint = p_fingerprint order by imported_at desc limit 1;
  if found and not coalesce(p_allow_repeat, false) then
    raise exception 'This file was already imported on % by %. Import again anyway?',
      to_char(b.imported_at, 'Mon DD, YYYY'), coalesce(nullif(b.imported_by_name, ''), 'someone')
      using errcode = 'OS410';
  end if;
end;
$$;

create or replace function public.import_requests_once(p_requests jsonb, p_source_file text default '', p_allow_repeat boolean default false)
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_fp text := md5(coalesce(p_requests, 'null'::jsonb)::text);
  v_n  int;
begin
  perform require_permission('seasons.manage');
  perform refuse_repeat_import('requests', v_fp, p_allow_repeat);
  v_n := import_requests(p_requests);
  insert into import_batches (kind, fingerprint, source_file, row_count, imported_by, imported_by_name)
  values ('requests', v_fp, left(coalesce(p_source_file, ''), 200), v_n, auth.uid(), my_display_name());
  return v_n;
end;
$$;

create or replace function public.import_archive_once(
  p_season text, p_source_file text, p_sheet text, p_columns jsonb, p_rows jsonb, p_allow_repeat boolean default false)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_fp text := md5(coalesce(p_rows, 'null'::jsonb)::text);
  v_id uuid;
begin
  perform require_permission('seasons.manage');
  perform refuse_repeat_import('archive', v_fp, p_allow_repeat);
  v_id := import_archive(p_season, p_source_file, p_sheet, p_columns, p_rows);
  insert into import_batches (kind, fingerprint, source_file, row_count, imported_by, imported_by_name)
  values ('archive', v_fp, left(coalesce(p_source_file, ''), 200), coalesce(jsonb_array_length(p_rows), 0), auth.uid(), my_display_name());
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- I-4: link by name only when someone joins the team
-- ---------------------------------------------------------------------------
drop trigger if exists profiles_link_requests on public.profiles;

/** As in 012, but only people on the team (any role besides Guest) can match. */
create or replace function public.profile_for_name(p_name text)
returns uuid
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_key   text := name_key(p_name);
  v_first text := split_part(name_key(p_name), ' ', 1);
  v_rest  text := case when position(' ' in name_key(p_name)) > 0 then regexp_replace(name_key(p_name), '^.* ', '') else '' end;
  v_ids   uuid[];
  v_step  int;
begin
  if v_key = '' then return null; end if;
  for v_step in 1..4 loop
    select array_agg(p.id) into v_ids
    from profiles p, lateral (select name_key(p.full_name) k) n
    where n.k <> ''
      and exists (select 1 from profile_roles pr where pr.user_id = p.id and pr.role <> 'guest')
      and case v_step
      when 1 then n.k = v_key
      when 2 then v_rest <> '' and position(' ' in n.k) > 0 and first_last_key(p.full_name) = first_last_key(p_name)
      when 3 then length(v_rest) = 1 and split_part(n.k, ' ', 1) = v_first and position(' ' in n.k) > 0
                  and left(regexp_replace(n.k, '^.* ', ''), 1) = v_rest
      else v_rest = '' and split_part(n.k, ' ', 1) = v_first
    end;
    if cardinality(v_ids) = 1 then return v_ids[1]; end if;
    if cardinality(v_ids) > 1 then return null; end if; -- ambiguous: don't guess
  end loop;
  return null;
end;
$$;

alter table public.request_events drop constraint if exists request_events_kind_check;
alter table public.request_events add constraint request_events_kind_check
  check (kind in ('submitted', 'resubmitted', 'withdrawn', 'ordered', 'received', 'edited', 'cancelled', 'restored',
                  'arrived', 'unreceived', 'items_edited', 'linked'));

/** Link this person's unowned requests (by requester name) and say so in each request's History. */
create or replace function public.link_requests_for(p_user uuid)
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_name text := (select full_name from profiles where id = p_user);
  v_n int;
begin
  with linked as (
    update requests r set created_by = p_user
    where r.created_by is null and not r.owner_set_by_hand and profile_for_name(r.requester) = p_user
    returning r.id
  )
  insert into request_events (request_id, kind, actor_id, actor_name, note)
  select id, 'linked', auth.uid(), coalesce(nullif(my_display_name(), ''), 'one.solar'),
         format('Linked to %s''s account: the requester name matched when they joined the team.', v_name)
  from linked;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Someone gets a team role (accepted, reactivated, or given one by an Admin): link their requests.
create or replace function public.link_on_team_role()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.role not in ('guest', 'alumni') then perform link_requests_for(new.user_id); end if;
  return null;
end;
$$;
drop trigger if exists profile_roles_link_requests on public.profile_roles;
create trigger profile_roles_link_requests
  after insert on public.profile_roles
  for each row execute function public.link_on_team_role();

revoke execute on function public.refuse_repeat_import(text, text, boolean), public.link_requests_for(uuid), public.link_on_team_role()
  from public, anon, authenticated;
revoke execute on function public.import_requests_once(jsonb, text, boolean), public.import_archive_once(text, text, text, jsonb, jsonb, boolean) from public, anon;
grant execute on function public.import_requests_once(jsonb, text, boolean), public.import_archive_once(text, text, text, jsonb, jsonb, boolean) to authenticated;

select public.migration_done(48, '048_imports_links.sql');
