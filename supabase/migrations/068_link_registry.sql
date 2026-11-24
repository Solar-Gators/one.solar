select public.migration_begin(68);

-- =============================================================================
-- 068: one way for any one.solar app to be linked from Projects (the link registry)
-- =============================================================================
--
--   Until now a Projects item could link to exactly two kinds of record, hard-wired in four places: pm_refs.kind's
--   check ('order', 'inventory'), pm_add_ref's if/else, the item page and the Orders request page. Adding a third
--   app meant changing all four.
--
--   Now each kind of record is a row in os_link_types, and its app provides two functions with a fixed shape:
--
--     <app>_link_search(p_q text, p_limit int)  → setof os_link_row   records matching what was typed
--     <app>_link_describe(p_ids uuid[])         → setof os_link_row   those records, as they are now
--
--   os_link_row is (id, code, title, status, tone, detail, path): a short code (request number, SKU) or '', the
--   name, the record's status in its own app (or null), a color for it ('green' / 'blue' / 'amber' / 'red' /
--   'gray' or null), a short line of extra detail (or null), and where it opens, relative to the site
--   ('orders/#/requests/SG27-900').
--
--   Each app stays in charge of its own data and who may see it:
--     * can_fn (optional): may this person use this kind of link at all? If not, deny_message is shown (42501).
--     * the two functions return only records the person may see. They are never called from the website
--       directly, only through os_link_search / os_link_describe / pm_add_ref, which check can_fn first.
--   Projects stores only the link (pm_refs: kind, ref_id, a label kept for history) and never changes the record.
--
--   How to register another app: docs/integrations.md. No Projects code changes.
--
--   Nothing visible changes: Orders and Inventory links look and behave exactly as before.

create type public.os_link_row as (id uuid, code text, title text, status text, tone text, detail text, path text);

create table public.os_link_types (
  key           text primary key check (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  app           text not null check (app ~ '^[a-z][a-z0-9-]{1,30}$'),      -- the folder it lives in (orders, inventory…)
  label         text not null check (length(label) between 1 and 40),     -- the chip on a link: "Order"
  noun          text not null check (length(noun) between 1 and 60),      -- in messages: "That Orders request doesn't exist."
  add_label     text not null check (length(add_label) between 1 and 60), -- the button: "Link an order"
  search_hint   text not null default '' check (length(search_hint) <= 80),
  note_hint     text not null default '' check (length(note_hint) <= 120),
  search_fn     regprocedure not null,
  describe_fn   regprocedure not null,
  can_fn        regprocedure,
  deny_message  text not null default '' check (length(deny_message) <= 200),
  sort          int not null default 100,
  active        boolean not null default true
);
alter table public.os_link_types enable row level security;
revoke all on public.os_link_types from anon, authenticated;
grant select on public.os_link_types to authenticated;
create policy "signed-in read" on public.os_link_types for select to authenticated using (true);

-- ---- Orders ---------------------------------------------------------------------------------------
-- Everyone signed in can read requests (001's "signed-in read"), so there's no extra check.
create or replace function public.orders_link_describe(p_ids uuid[])
returns setof public.os_link_row language sql stable security definer set search_path = public, pg_temp
as $$
  select r.id, r.request_number, r.title, r.status,
         case r.status when 'Received' then 'green' when 'Ordered' then 'blue' else 'amber' end,
         case when r.status = 'Received' then null else 'not here yet' end,
         'orders/#/requests/' || r.request_number
  from requests r where auth.uid() is not null and r.id = any(p_ids);
$$;
create or replace function public.orders_link_search(p_q text, p_limit int)
returns setof public.os_link_row language sql stable security definer set search_path = public, pg_temp
as $$
  select d.* from (
    select r.id from requests r
    where auth.uid() is not null and length(trim(coalesce(p_q, ''))) > 0
      and (r.request_number || ' ' || r.title) ilike '%' || replace(replace(replace(trim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
    order by r.created_at desc limit least(greatest(coalesce(p_limit, 12), 1), 50)) m
  cross join lateral public.orders_link_describe(array[m.id]) d;
$$;

-- ---- Inventory --------------------------------------------------------------------------------------
-- Only people with an Inventory permission (inv_can_view, 050). Stock and reservations stay on the item page,
-- read from Inventory as before (061).
create or replace function public.inventory_link_describe(p_ids uuid[])
returns setof public.os_link_row language sql stable security definer set search_path = public, pg_temp
as $$
  select i.id, i.sku, i.name, null::text, null::text, null::text, 'inventory/#/inventory/items/' || i.id
  from inventory_items i where inv_can_view() and i.id = any(p_ids);
$$;
create or replace function public.inventory_link_search(p_q text, p_limit int)
returns setof public.os_link_row language sql stable security definer set search_path = public, pg_temp
as $$
  select d.* from (
    select i.id from inventory_items i
    where inv_can_view() and i.status <> 'archived' and length(trim(coalesce(p_q, ''))) > 0
      and (i.sku || ' ' || i.name) ilike '%' || replace(replace(replace(trim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
    order by i.sku limit least(greatest(coalesce(p_limit, 12), 1), 50)) m
  cross join lateral public.inventory_link_describe(array[m.id]) d;
$$;

insert into public.os_link_types (key, app, label, noun, add_label, search_hint, note_hint, search_fn, describe_fn, can_fn, deny_message, sort) values
  ('order', 'orders', 'Order', 'Orders request', 'Link an order', 'Request number or title', 'e.g. Waiting on delivery before layup',
   'public.orders_link_search(text, int)', 'public.orders_link_describe(uuid[])', null, '', 10),
  ('inventory', 'inventory', 'Inventory', 'Inventory item', 'Link an inventory item', 'SKU or name', 'e.g. Needs 12 for the pack',
   'public.inventory_link_search(text, int)', 'public.inventory_link_describe(uuid[])', 'public.inv_can_view()',
   'Your role can''t see Inventory, so you can''t link its items.', 20);

-- ---- the calls the website makes ---------------------------------------------------------------------
/** The type, if it exists and is in use, after checking can_fn. */
create or replace function public.os_link_type(p_kind text)
returns public.os_link_types language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare t os_link_types; ok boolean;
begin
  select * into t from os_link_types where key = p_kind and active;
  if t.key is null then raise exception 'Unknown kind of link.'; end if;
  if t.can_fn is not null then
    execute format('select %s()', t.can_fn::oid::regproc) into ok;
    if not coalesce(ok, false) then
      raise exception '%', coalesce(nullif(t.deny_message, ''), 'Your role can''t use this kind of link.') using errcode = '42501';
    end if;
  end if;
  return t;
end;
$$;

/** Records of one kind matching what was typed, at most 12 (only ones the person may see). */
create or replace function public.os_link_search(p_kind text, p_q text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare t os_link_types; v jsonb;
begin
  if auth.uid() is null or not is_member() then
    raise exception 'Only accepted team members can link records.' using errcode = '42501';
  end if;
  t := os_link_type(p_kind);
  execute format('select coalesce(jsonb_agg(to_jsonb(d)), ''[]'') from %s($1, 12) d', t.search_fn::oid::regproc) into v using left(coalesce(p_q, ''), 100);
  return v;
end;
$$;

/** Records of one kind as they are now (only ones the person may see; others are left out, not an error). */
create or replace function public.os_link_describe(p_kind text, p_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare t os_link_types; v jsonb; ok boolean;
begin
  if auth.uid() is null or not is_member() or coalesce(cardinality(p_ids), 0) = 0 then return '[]'; end if;
  select * into t from os_link_types where key = p_kind and active;
  if t.key is null then return '[]'; end if;
  if t.can_fn is not null then
    execute format('select %s()', t.can_fn::oid::regproc) into ok;
    if not coalesce(ok, false) then return '[]'; end if;
  end if;
  execute format('select coalesce(jsonb_agg(to_jsonb(d)), ''[]'') from %s($1) d', t.describe_fn::oid::regproc) into v using p_ids[1:500];
  return v;
end;
$$;

-- pm_refs.kind: any registered kind (existing rows are all 'order' or 'inventory', which are registered)
alter table public.pm_refs drop constraint if exists pm_refs_kind_check;
alter table public.pm_refs add constraint pm_refs_kind_fkey foreign key (kind) references public.os_link_types(key);

/** Link an item to a record in another app (051, now for any registered kind). */
create or replace function public.pm_add_ref(p_item uuid, p_kind text, p_ref uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  o pm_items;
  t os_link_types;
  r os_link_row;
  v_label text;
  v pm_refs;
begin
  select * into o from pm_items where id = p_item;
  if o.id is null then raise exception 'That item doesn''t exist.'; end if;
  perform pmx_need(o.project_id, 'view');
  if not pmx_may_edit(o) then perform pmx_need(o.project_id, 'edit'); end if;
  t := os_link_type(p_kind);
  execute format('select * from %s($1) limit 1', t.describe_fn::oid::regproc) into r using array[p_ref];
  if r.id is null then raise exception 'That % doesn''t exist.', t.noun; end if;
  v_label := case when coalesce(r.code, '') = '' then r.title else r.code || ' · ' || r.title end;
  insert into pm_refs (item_id, project_id, kind, ref_id, label, note, created_by)
  values (p_item, o.project_id, p_kind, p_ref, left(v_label, 200), left(coalesce(p_note, ''), 300), auth.uid())
  on conflict (item_id, kind, ref_id) do update set note = excluded.note returning * into v;
  perform pmx_log(o.project_id, p_item, 'link', 'Linked ' || case p_kind when 'order' then 'the order ' when 'inventory' then 'the inventory item '
    else 'the ' || lower(t.noun) || ' ' end || v_label, '{}');
  return to_jsonb(v);
end;
$$;

revoke execute on function public.orders_link_describe(uuid[]), public.orders_link_search(text, int),
  public.inventory_link_describe(uuid[]), public.inventory_link_search(text, int), public.os_link_type(text) from public, anon, authenticated;
revoke execute on function public.os_link_search(text, text), public.os_link_describe(text, uuid[]) from public, anon;
grant execute on function public.os_link_search(text, text), public.os_link_describe(text, uuid[]) to authenticated;

select public.migration_done(68, '068_link_registry.sql');
