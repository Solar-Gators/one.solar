select public.migration_begin(66);

-- =============================================================================
-- 066: one search for the Ctrl/⌘ + K command palette (shared/command-palette.js)
-- =============================================================================
--
--   search_everything('nickel') finds requests, inventory parts, sponsors, projects, project work items and
--   events whose name or number contains the text, a few of each, best matches first. It runs as the person
--   searching (security invoker), so row-level security decides what they see: nobody finds a sponsor, a
--   private project or a part they couldn't open anyway. A source that person can't read at all is skipped.
--   Returns [{ "kind", "id", "title", "sub" }] (id is the request number for requests, SG27-104, and the key for projects and work items, BAT-24); the palette
--   turns kind + id into a link.
-- =============================================================================

create or replace function public.search_everything(p_q text, p_limit int default 5)
returns jsonb
language plpgsql stable security invoker set search_path = public, pg_temp
as $$
declare
  q   text := lower(trim(coalesce(p_q, '')));
  n   int  := least(greatest(coalesce(p_limit, 5), 1), 20);
  out jsonb := '[]'::jsonb;
  part jsonb;
begin
  if length(q) < 2 or length(q) > 100 then return out; end if;

  -- rank: 0 = the number / key / name starts with it, 1 = contains it
  begin
    select coalesce(jsonb_agg(r), '[]') into part from (
      select 'request' as kind, request_number as id, request_number || ' · ' || coalesce(nullif(title, ''), 'Untitled request') as title, status as sub
      from requests
      where strpos(lower(request_number), q) > 0 or strpos(lower(title), q) > 0
      order by (lower(request_number) like q || '%' or lower(title) like q || '%') desc, created_at desc
      limit n) r;
    out := out || part;
  exception when insufficient_privilege or undefined_table or undefined_column then null;
  end;

  begin
    select coalesce(jsonb_agg(r), '[]') into part from (
      select 'part' as kind, id::text as id, name as title, sku as sub
      from inventory_items
      where status <> 'archived' and (strpos(lower(sku), q) > 0 or strpos(lower(name), q) > 0 or strpos(lower(mpn), q) > 0)
      order by (lower(sku) like q || '%' or lower(name) like q || '%') desc, name
      limit n) r;
    out := out || part;
  exception when insufficient_privilege or undefined_table or undefined_column then null;
  end;

  begin
    select coalesce(jsonb_agg(r), '[]') into part from (
      select 'sponsor' as kind, id::text as id, name as title, nullif(concat_ws(' · ', nullif(season, ''), nullif(stage, '')), '') as sub
      from sponsor_cards
      where strpos(lower(name), q) > 0 or strpos(lower(contact_name), q) > 0
      order by (lower(name) like q || '%') desc, season desc, name
      limit n) r;
    out := out || part;
  exception when insufficient_privilege or undefined_table or undefined_column then null;
  end;

  begin
    select coalesce(jsonb_agg(r), '[]') into part from (
      select 'project' as kind, key as id, name as title, key as sub
      from pm_projects
      where strpos(lower(key), q) > 0 or strpos(lower(name), q) > 0
      order by (lower(key) like q || '%' or lower(name) like q || '%') desc, name
      limit n) r;
    out := out || part;
  exception when insufficient_privilege or undefined_table or undefined_column then null;
  end;

  begin
    select coalesce(jsonb_agg(r), '[]') into part from (
      select 'item' as kind, key as id, key || ' · ' || title as title, category as sub
      from pm_items
      where strpos(lower(key), q) > 0 or strpos(lower(title), q) > 0
      order by (lower(key) like q || '%' or lower(title) like q || '%') desc, (category = 'done'), updated_at desc
      limit n) r;
    out := out || part;
  exception when insufficient_privilege or undefined_table or undefined_column then null;
  end;

  begin
    select coalesce(jsonb_agg(r), '[]') into part from (
      select 'event' as kind, id::text as id, title, to_char(starts_at at time zone 'America/New_York', 'Mon DD, YYYY') as sub
      from ev_events
      where strpos(lower(title), q) > 0 or strpos(lower(location), q) > 0
      order by (lower(title) like q || '%') desc, starts_at desc
      limit n) r;
    out := out || part;
  exception when insufficient_privilege or undefined_table or undefined_column then null;
  end;

  return out;
end;
$$;

revoke execute on function public.search_everything(text, int) from public, anon;
grant execute on function public.search_everything(text, int) to authenticated;

select public.migration_done(66, '066_search.sql');
