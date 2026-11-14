select public.migration_begin(50);

-- =============================================================================
-- 050: Inventory: what's in the shop, where it is, and what it was used for
-- =============================================================================
--
--   A new one.solar app (inventory/). Orders stays in charge of buying (requests, approval, ordering);
--   Inventory is in charge of physical stock. They meet at receiving: an ordered line can be received into
--   Inventory, in parts (6 of 10, then 4 of 10), into stock, straight to a subsystem, or as "not an inventory
--   item". Ordering never adds stock; only a physical receipt does.
--
--   How stock is kept
--     * inventory_stock holds the balance of each bucket: item × location × lot × (available | set aside).
--       A check keeps every balance at zero or above, whatever happens.
--     * Every change is a movement (inventory_movements, never edited or deleted) made by one of the functions
--       below, in the same transaction as the balance change. Mistakes are undone with a reversing operation.
--     * Each function takes an operation id made by the page (p_op). Sending the same operation twice
--       (a double click, a retry after a dropped connection) returns the first result instead of doing it again.
--     * Each stock function locks the item's row first, so changes to one item happen one after another: two
--       people can't take the same last part, and counts know exactly which changes came after them.
--     * Quantities are exact numbers (numeric) in the item's unit; each item says how many decimal places it
--       tracks. Entries in another unit of the same kind (ft for an item kept in m) are converted; units of
--       different kinds (m and kg, rolls and each) never mix.
--
--   What it was used for
--     * org_divisions / org_subsystems: Solar Gators → CE division → subsystem, edited in Inventory → Setup
--       (and Admin). Archived ones stay in the history. Taking stock out records the subsystem (or a whole
--       division, or "General shop") and the division it was in at that moment, so moving a subsystem later
--       doesn't rewrite old reports.
--
--   Permissions (Admin → Roles & permissions): inventory.view, inventory.use, inventory.receive,
--   inventory.count, inventory.manage. Every team role gets view + use; Chief Engineers receive and count;
--   the Treasurer receives; Admin and the new "Inventory manager" role get everything.
-- =============================================================================

-- ---- permissions -------------------------------------------------------------------------------
insert into public.permissions (key, label, description, sort) values
  ('inventory.view', 'See inventory', 'Open Inventory: items, what''s in stock where, and the history.', 30),
  ('inventory.use', 'Use stock', 'Take parts out of inventory (saying which CE division and subsystem they''re for) and put unused parts back.', 31),
  ('inventory.receive', 'Receive & move stock', 'Put deliveries into inventory (including ordered items), add items, move stock between locations and set aside damaged stock.', 32),
  ('inventory.count', 'Count stock', 'Run physical counts and submit what was found.', 33),
  ('inventory.manage', 'Manage inventory', 'Edit items, locations, categories, CE divisions and subsystems; correct stock; approve counts; release set-aside stock; import spreadsheets.', 34)
on conflict (key) do nothing;

insert into public.roles (key, label, sort) values ('inventory_manager', 'Inventory manager', 7) on conflict (key) do nothing;

insert into public.role_permissions (role, permission)
select r.key, p.key from public.roles r cross join (values ('inventory.view'), ('inventory.use')) p(key)
where r.key not in ('guest', 'alumni')
on conflict do nothing;
insert into public.role_permissions (role, permission)
select v.role, v.permission
from (values ('ce', 'inventory.receive'), ('ce', 'inventory.count'), ('treasurer', 'inventory.receive'),
             ('admin', 'inventory.receive'), ('admin', 'inventory.count'), ('admin', 'inventory.manage'),
             ('inventory_manager', 'inventory.receive'), ('inventory_manager', 'inventory.count'), ('inventory_manager', 'inventory.manage')) v(role, permission)
where exists (select 1 from public.roles r where r.key = v.role)
on conflict do nothing;
-- A version in Admin → History with these, so restoring an older version later doesn't quietly drop them.
select public.record_permissions_snapshot();

-- ---- who may do what -----------------------------------------------------------------------------
/** On the team and allowed to open Inventory (any inventory permission). Used by the read policies. */
create or replace function public.inv_can_view()
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select auth.uid() is not null and is_member()
     and (has_permission('inventory.view') or has_permission('inventory.use') or has_permission('inventory.receive')
          or has_permission('inventory.count') or has_permission('inventory.manage'));
$$;

/** Refuse unless the signed-in person is on the team and has one of these permissions. */
create or replace function public.inv_require(p_perms text[])
returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'You must be signed in.' using errcode = '42501'; end if;
  if not is_member() then
    if is_former_member() then
      raise exception 'Your one.solar access has ended. Ask an Admin if this is a mistake.' using errcode = '42501';
    end if;
    raise exception 'Your account hasn''t been accepted into the team yet.' using errcode = '42501';
  end if;
  if not exists (select 1 from unnest(p_perms) k where has_permission(k)) then
    raise exception 'Your role can''t do this in Inventory (it needs "%").',
      (select string_agg(coalesce(pm.label, u.k), '" or "' order by u.o)
         from unnest(p_perms) with ordinality u(k, o) left join permissions pm on pm.key = u.k)
      using errcode = '42501';
  end if;
end;
$$;

/** 12.50 → "12.5", 100 → "100". */
create or replace function public.inv_fmt(p numeric)
returns text
language sql immutable set search_path = public, pg_temp
as $$
  select case when p is null then '' when p::text like '%.%' then rtrim(rtrim(p::text, '0'), '.') else p::text end;
$$;

/** Part numbers compared without case, spaces or punctuation: "PN-12 34" = "pn1234". */
create or replace function public.inv_norm(p text)
returns text
language sql immutable set search_path = public, pg_temp
as $$
  select lower(regexp_replace(coalesce(p, ''), '[^a-zA-Z0-9]', '', 'g'));
$$;

/** A number from the page's JSON, or a clear error. Null when blank. */
create or replace function public.inv_num(p jsonb, p_key text)
returns numeric
language plpgsql immutable set search_path = public, pg_temp
as $$
begin
  return nullif(trim(coalesce(p ->> p_key, '')), '')::numeric;
exception when others then
  raise exception '"%" isn''t a number.', p ->> p_key;
end;
$$;

-- ---- the organization: CE divisions and their subsystems ----------------------------------------
create table public.org_divisions (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 80),
  sort        int  not null default 100,
  archived_at timestamptz,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index org_divisions_name_key on public.org_divisions (lower(trim(name))) where archived_at is null;

create table public.org_subsystems (
  id          uuid primary key default gen_random_uuid(),
  division_id uuid not null references public.org_divisions(id),
  name        text not null check (length(trim(name)) between 1 and 80),
  sort        int  not null default 100,
  archived_at timestamptz,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index org_subsystems_name_key on public.org_subsystems (division_id, lower(trim(name))) where archived_at is null;
create index org_subsystems_division_idx on public.org_subsystems (division_id);

-- ---- units -----------------------------------------------------------------------------------------
-- factor: how many of the dimension's base unit one of this is (m for length, kg for mass, L for volume).
-- Container units (roll, spool, box…) are each their own kind: a roll is never converted to anything.
create table public.inventory_units (
  code      text primary key check (code ~ '^[a-z][a-z0-9_]{0,15}$'),
  label     text not null,
  dimension text not null,
  factor    numeric not null check (factor > 0),
  sort      int not null default 0
);
insert into public.inventory_units (code, label, dimension, factor, sort) values
  ('ea', 'each', 'count', 1, 1), ('pair', 'pair', 'pair', 1, 2), ('set', 'set', 'set', 1, 3), ('kit', 'kit', 'kit', 1, 4),
  ('mm', 'mm', 'length', 0.001, 10), ('cm', 'cm', 'length', 0.01, 11), ('m', 'm', 'length', 1, 12),
  ('in', 'in', 'length', 0.0254, 13), ('ft', 'ft', 'length', 0.3048, 14), ('yd', 'yd', 'length', 0.9144, 15),
  ('g', 'g', 'mass', 0.001, 20), ('kg', 'kg', 'mass', 1, 21), ('oz', 'oz', 'mass', 0.028349523125, 22), ('lb', 'lb', 'mass', 0.45359237, 23),
  ('ml', 'mL', 'volume', 0.001, 30), ('l', 'L', 'volume', 1, 31), ('floz', 'fl oz', 'volume', 0.0295735295625, 32), ('gal', 'gal', 'volume', 3.785411784, 33),
  ('sqm', 'm²', 'area', 1, 40), ('sqft', 'ft²', 'area', 0.09290304, 41),
  ('roll', 'roll', 'roll', 1, 50), ('spool', 'spool', 'spool', 1, 51), ('sheet', 'sheet', 'sheet', 1, 52), ('bottle', 'bottle', 'bottle', 1, 53),
  ('can', 'can', 'can', 1, 54), ('tube', 'tube', 'tube', 1, 55), ('bag', 'bag', 'bag', 1, 56), ('box', 'box', 'box', 1, 57);

-- ---- catalog -------------------------------------------------------------------------------------
create table public.inventory_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 80),
  parent_id   uuid references public.inventory_categories(id),
  sort        int not null default 100,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index inventory_categories_name_key on public.inventory_categories (lower(trim(name))) where archived_at is null;

create table public.inventory_locations (
  id           uuid primary key default gen_random_uuid(),
  code         text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,23}$'),
  name         text not null check (length(trim(name)) between 1 and 80),
  parent_id    uuid references public.inventory_locations(id),
  kind         text not null default 'other' check (kind in ('shop', 'room', 'cabinet', 'shelf', 'bin', 'other')),
  description  text not null default '' check (length(description) <= 500),
  restrictions text not null default '' check (length(restrictions) <= 300),
  sort         int not null default 100,
  archived_at  timestamptz,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
-- Codes are printed on labels, so they stay unique even after a location is archived.
create unique index inventory_locations_code_key on public.inventory_locations (code);

create sequence public.inventory_sku_seq;

create table public.inventory_items (
  id                  uuid primary key default gen_random_uuid(),
  sku                 text not null check (sku ~ '^[A-Z0-9][A-Z0-9._/-]{0,31}$'),
  name                text not null check (length(trim(name)) between 1 and 120),
  description         text not null default '' check (length(description) <= 2000),
  category_id         uuid references public.inventory_categories(id),
  manufacturer        text not null default '' check (length(manufacturer) <= 120),
  mpn                 text not null default '' check (length(mpn) <= 80),
  specs               jsonb not null default '{}' check (jsonb_typeof(specs) = 'object'),
  unit                text not null default 'ea' references public.inventory_units(code),
  decimals            int  not null default 0 check (decimals between 0 and 4),
  status              text not null default 'active' check (status in ('active', 'discontinued', 'archived')),
  image_url           text not null default '' check (image_url = '' or image_url ~ '^https://\S+$'),
  default_location_id uuid references public.inventory_locations(id),
  reorder_point       numeric check (reorder_point >= 0),
  reorder_qty         numeric check (reorder_qty > 0),
  unit_cost           numeric check (unit_cost >= 0),
  count_class         text not null default 'C' check (count_class in ('A', 'B', 'C')),
  track_lots          boolean not null default false,
  hazardous           boolean not null default false,
  hazard_classes      text[] not null default '{}' check (hazard_classes <@ array['flammable', 'oxidizer', 'corrosive', 'toxic',
                        'health_hazard', 'irritant', 'compressed_gas', 'explosive', 'environmental', 'lithium_battery']),
  sds_url             text not null default '' check (sds_url = '' or sds_url ~ '^https?://\S+$'),
  storage_notes       text not null default '' check (length(storage_notes) <= 500),
  notes               text not null default '' check (length(notes) <= 2000),
  created_by          uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_by          uuid references public.profiles(id) on delete set null,
  updated_at          timestamptz not null default now()
);
create unique index inventory_items_sku_key on public.inventory_items (upper(sku));
create index inventory_items_mpn_idx on public.inventory_items (public.inv_norm(mpn)) where mpn <> '';
create index inventory_items_category_idx on public.inventory_items (category_id);

create table public.inventory_supplier_parts (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.inventory_items(id),
  supplier    text not null check (length(trim(supplier)) between 1 and 80),
  supplier_pn text not null default '' check (length(supplier_pn) <= 80),
  url         text not null default '' check (url = '' or url ~ '^https?://\S+$'),
  pack_qty    numeric not null default 1 check (pack_qty > 0),
  pack_label  text not null default '' check (length(pack_label) <= 40),
  last_price  numeric check (last_price >= 0),
  preferred   boolean not null default false,
  notes       text not null default '' check (length(notes) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index inventory_supplier_parts_key on public.inventory_supplier_parts (item_id, lower(trim(supplier)), public.inv_norm(supplier_pn));
create index inventory_supplier_parts_pn_idx on public.inventory_supplier_parts (public.inv_norm(supplier_pn)) where supplier_pn <> '';

create table public.inventory_lots (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.inventory_items(id),
  lot_code    text not null default '' check (length(lot_code) <= 60),
  container   text not null default '' check (length(container) <= 60),
  received_on date,
  opened_on   date,
  expires_on  date,
  retest_on   date,
  condition   text not null default 'good' check (condition in ('good', 'damaged', 'suspect', 'expired')),
  notes       text not null default '' check (length(notes) <= 500),
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (lot_code <> '' or container <> '')
);
create unique index inventory_lots_key on public.inventory_lots (item_id, lower(lot_code), lower(container));

-- ---- stock, operations and movements ----------------------------------------------------------------
create table public.inventory_stock (
  id          bigint generated always as identity primary key,
  item_id     uuid not null references public.inventory_items(id),
  location_id uuid not null references public.inventory_locations(id),
  lot_id      uuid references public.inventory_lots(id),
  status      text not null default 'available' check (status in ('available', 'quarantine')),
  qty         numeric not null default 0 check (qty >= 0),
  updated_at  timestamptz not null default now()
);
create unique index inventory_stock_key on public.inventory_stock
  (item_id, location_id, coalesce(lot_id, '00000000-0000-0000-0000-000000000000'::uuid), status);
create index inventory_stock_location_idx on public.inventory_stock (location_id);

-- One row per thing someone did (its id comes from the page, so a repeat is recognised).
create table public.inventory_ops (
  id          uuid primary key,
  kind        text not null check (kind in ('receive', 'consume', 'return', 'transfer', 'adjust', 'quarantine', 'release',
                                            'reverse', 'count', 'import', 'order_receipt')),
  item_id     uuid references public.inventory_items(id),
  actor_id    uuid references public.profiles(id) on delete set null,
  actor_name  text not null default '',
  note        text not null default '',
  reverses    uuid unique references public.inventory_ops(id),
  reversed_by uuid references public.inventory_ops(id),
  result      jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index inventory_ops_created_idx on public.inventory_ops (created_at desc);

create table public.inventory_movements (
  id             bigint generated always as identity primary key,
  op_id          uuid not null references public.inventory_ops(id),
  kind           text not null check (kind in ('receive', 'consume', 'return', 'transfer', 'adjust', 'quarantine', 'count',
                                               'import', 'direct_use')),
  item_id        uuid not null references public.inventory_items(id),
  location_id    uuid references public.inventory_locations(id),     -- null: no stock changed (used straight from a delivery)
  lot_id         uuid references public.inventory_lots(id),
  status         text check (status in ('available', 'quarantine')),
  qty            numeric not null check (qty <> 0),                  -- signed, in the item's unit
  qty_entered    numeric,
  unit_entered   text not null default '',
  unit_cost      numeric,                                            -- per item unit, when known
  use_for        text check (use_for in ('subsystem', 'division', 'general')),
  division_id    uuid references public.org_divisions(id),
  subsystem_id   uuid references public.org_subsystems(id),
  division_name  text,
  subsystem_name text,
  project        text not null default '',
  used_by_name   text not null default '',                           -- who used it (kept on undo lines too)
  reason         text not null default '',
  receipt_id     uuid,
  count_id       uuid,
  import_id      uuid,
  returns_op     uuid references public.inventory_ops(id),
  reversal       boolean not null default false,
  occurred_on    date not null default current_date,
  actor_id       uuid references public.profiles(id) on delete set null,
  actor_name     text not null default '',
  created_at     timestamptz not null default now(),
  check (kind not in ('consume', 'direct_use') or use_for is not null),
  check (use_for is null
         or (use_for = 'subsystem' and subsystem_id is not null and division_id is not null)
         or (use_for = 'division' and division_id is not null and subsystem_id is null)
         or (use_for = 'general' and division_id is null and subsystem_id is null)),
  check ((location_id is null) = (status is null)),
  check (location_id is not null or kind = 'direct_use')
);
create index inventory_movements_item_idx on public.inventory_movements (item_id, id);
create index inventory_movements_op_idx on public.inventory_movements (op_id);
create index inventory_movements_location_idx on public.inventory_movements (location_id, id);
create index inventory_movements_usage_idx on public.inventory_movements (occurred_on) where kind in ('consume', 'return', 'direct_use');
create index inventory_movements_returns_idx on public.inventory_movements (returns_op) where returns_op is not null;

/** History is permanent: mistakes are undone with a reversing operation. (Removing a person only clears the link to them.) */
create or replace function public.inv_history_is_permanent()
returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.actor_id is null and (to_jsonb(new) - 'actor_id') = (to_jsonb(old) - 'actor_id') then
    return new;
  end if;
  raise exception 'Inventory history can''t be changed or deleted. Undo it with a reversing transaction instead.';
end;
$$;
create trigger inventory_movements_permanent before update or delete on public.inventory_movements
  for each row execute function public.inv_history_is_permanent();

-- ---- receiving and Orders -------------------------------------------------------------------------
alter table public.request_items add column if not exists arrived_via_inventory boolean not null default false;

-- An Orders line ↔ a catalog item. units_per: how many of the item's unit one ordered quantity is
-- (a "pack of 100" line ordered ×2 with units_per 100 is 200 ea).
create table public.inventory_order_links (
  request_item_id uuid primary key references public.request_items(id) on delete cascade,
  item_id         uuid not null references public.inventory_items(id),
  units_per       numeric not null default 1 check (units_per > 0),
  linked_by       uuid references public.profiles(id) on delete set null,
  linked_at       timestamptz not null default now()
);
create index inventory_order_links_item_idx on public.inventory_order_links (item_id);

create table public.inventory_receipts (
  id              uuid primary key default gen_random_uuid(),
  op_id           uuid not null unique references public.inventory_ops(id),
  request_id      uuid references public.requests(id) on delete set null,
  request_item_id uuid references public.request_items(id) on delete set null,
  order_ref       text not null default '',      -- request number, kept even if the request is deleted
  line_name       text not null default '',      -- the Orders line's item name at the time
  line_price      numeric,                       -- its unit price at the time
  item_id         uuid references public.inventory_items(id),
  destination     text not null check (destination in ('stock', 'direct', 'non_inventory')),
  qty_order       numeric check (qty_order > 0), -- in the Orders line's quantity
  qty             numeric check (qty > 0),       -- in the item's unit (when it's a catalog item)
  location_id     uuid references public.inventory_locations(id),
  lot_id          uuid references public.inventory_lots(id),
  use_for         text check (use_for in ('subsystem', 'division', 'general')),
  division_id     uuid references public.org_divisions(id),
  subsystem_id    uuid references public.org_subsystems(id),
  division_name   text,
  subsystem_name  text,
  project         text not null default '',
  source          text not null default '',
  over_receipt    boolean not null default false,
  over_reason     text not null default '',
  received_on     date not null default current_date,
  note            text not null default '',
  actor_id        uuid references public.profiles(id) on delete set null,
  actor_name      text not null default '',
  created_at      timestamptz not null default now(),
  reversed_at     timestamptz,
  reversed_by     uuid references public.profiles(id) on delete set null,
  reversal_op     uuid references public.inventory_ops(id),
  check (destination <> 'stock' or (item_id is not null and qty is not null and location_id is not null)),
  check (destination <> 'direct' or use_for is not null)
);
create index inventory_receipts_line_idx on public.inventory_receipts (request_item_id) where request_item_id is not null;
create index inventory_receipts_request_idx on public.inventory_receipts (request_id) where request_id is not null;

-- ---- counts ----------------------------------------------------------------------------------------
create table public.inventory_counts (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(trim(name)) between 1 and 120),
  status          text not null default 'open' check (status in ('open', 'review', 'closed', 'cancelled')),
  scope           jsonb not null default '{}',
  baseline_seq    bigint not null default 0,     -- the last movement before the count started
  blind           boolean not null default false,
  needs_approval  boolean not null default false,
  notes           text not null default '' check (length(notes) <= 1000),
  started_by      uuid references public.profiles(id) on delete set null,
  started_by_name text not null default '',
  started_at      timestamptz not null default now(),
  submitted_at    timestamptz,
  closed_at       timestamptz,
  closed_by_name  text not null default '',
  op_id           uuid references public.inventory_ops(id)
);

create table public.inventory_count_lines (
  id              uuid primary key default gen_random_uuid(),
  count_id        uuid not null references public.inventory_counts(id),
  item_id         uuid not null references public.inventory_items(id),
  location_id     uuid not null references public.inventory_locations(id),
  lot_id          uuid references public.inventory_lots(id),
  expected        numeric not null default 0,    -- the system's quantity when the count started
  system_qty      numeric,                       -- the system's quantity at the moment it was counted
  counted         numeric check (counted >= 0),
  counted_seq     bigint,
  counted_at      timestamptz,
  counted_by_name text not null default '',
  first_count     numeric,                       -- the count before a recount
  recount         boolean not null default false,
  added           boolean not null default false, -- found during the count (wasn't on the list)
  note            text not null default '' check (length(note) <= 500)
);
create unique index inventory_count_lines_key on public.inventory_count_lines
  (count_id, item_id, location_id, coalesce(lot_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index inventory_count_lines_item_idx on public.inventory_count_lines (item_id);

-- ---- imports, history of changes, preferences --------------------------------------------------
create table public.inventory_import_batches (
  id             uuid primary key default gen_random_uuid(),
  op_id          uuid not null unique references public.inventory_ops(id),
  file_name      text not null default '',
  file_hash      text,
  row_count      int not null default 0,
  items_created  int not null default 0,
  items_matched  int not null default 0,
  stock_lines    int not null default 0,
  created_by     uuid references public.profiles(id) on delete set null,
  created_by_name text not null default '',
  created_at     timestamptz not null default now()
);
create index inventory_import_batches_hash_idx on public.inventory_import_batches (file_hash);

-- Every change to items, locations, categories, suppliers, lots, divisions and subsystems: what changed, who, when.
create table public.inventory_audit (
  id          bigint generated always as identity primary key,
  table_name  text not null,
  record_id   uuid not null,
  action      text not null,
  changes     jsonb not null default '{}',
  actor_id    uuid references public.profiles(id) on delete set null,
  actor_name  text not null default '',
  created_at  timestamptz not null default now()
);
create index inventory_audit_record_idx on public.inventory_audit (record_id, id);

create or replace function public.inv_audit()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_old     jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  v_new     jsonb := to_jsonb(new);
  v_changes jsonb := '{}';
  v_action  text;
  k         text;
begin
  for k in select jsonb_object_keys(v_new) loop
    continue when k in ('id', 'updated_at', 'updated_by', 'created_at', 'created_by');
    if tg_op = 'INSERT' then
      if v_new -> k not in ('null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb, 'false'::jsonb) then
        v_changes := v_changes || jsonb_build_object(k, v_new -> k);
      end if;
    elsif v_old -> k is distinct from v_new -> k then
      v_changes := v_changes || jsonb_build_object(k, jsonb_build_array(v_old -> k, v_new -> k));
    end if;
  end loop;
  if tg_op = 'UPDATE' and v_changes = '{}'::jsonb then return new; end if;
  v_action := case when tg_op = 'INSERT' then 'create'
                   when v_changes ? 'archived_at' and v_new ->> 'archived_at' is not null then 'archive'
                   when v_changes ? 'archived_at' then 'restore'
                   when v_changes ? 'division_id' then 'move'
                   else 'update' end;
  insert into inventory_audit (table_name, record_id, action, changes, actor_id, actor_name)
  values (tg_table_name, (v_new ->> 'id')::uuid, v_action, v_changes, auth.uid(), coalesce(my_display_name(), ''));
  return new;
end;
$$;
do $$
declare t text;
begin
  foreach t in array array['inventory_items', 'inventory_locations', 'inventory_categories', 'inventory_supplier_parts',
                           'inventory_lots', 'org_divisions', 'org_subsystems'] loop
    execute format('create trigger %I after insert or update on public.%I for each row execute function public.inv_audit()', t || '_audit', t);
  end loop;
end;
$$;

-- The last CE division / subsystem each person used, so the next time it's already picked.
create table public.inventory_prefs (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  use_for      text,
  division_id  uuid references public.org_divisions(id) on delete set null,
  subsystem_id uuid references public.org_subsystems(id) on delete set null,
  project      text not null default '',
  updated_at   timestamptz not null default now()
);

insert into public.app_settings (key, value) values
  ('inventory', '{"countDays": {"A": 30, "B": 90, "C": 180}, "approvalValue": 50, "approvalPct": 10, "expiryWarnDays": 30, "blindCounts": false}')
on conflict (key) do nothing;

-- ---- reading: team members with an inventory permission (org: the whole team) ------------------
do $$
declare t text;
begin
  foreach t in array array['inventory_units', 'inventory_categories', 'inventory_locations', 'inventory_items',
                           'inventory_supplier_parts', 'inventory_lots', 'inventory_stock', 'inventory_ops', 'inventory_movements',
                           'inventory_order_links', 'inventory_receipts', 'inventory_counts', 'inventory_count_lines',
                           'inventory_import_batches', 'inventory_audit'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "inventory read" on public.%I for select to authenticated using (public.inv_can_view())', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  foreach t in array array['org_divisions', 'org_subsystems'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "team read" on public.%I for select to authenticated using (public.is_member())', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end;
$$;
alter table public.inventory_prefs enable row level security;
create policy "own prefs" on public.inventory_prefs for select to authenticated using (user_id = auth.uid());
revoke all on public.inventory_prefs from anon, authenticated;
grant select on public.inventory_prefs to authenticated;
revoke all on sequence public.inventory_sku_seq, public.inventory_stock_id_seq, public.inventory_movements_id_seq,
  public.inventory_audit_id_seq from anon, authenticated;

-- ===================================================================================================
-- Internal helpers (not callable from the website)
-- ===================================================================================================

/** The item, locked so its stock changes happen one after another. */
create or replace function public.inv_lock_item(p_id uuid)
returns public.inventory_items
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v inventory_items;
begin
  select * into v from inventory_items where id = p_id for update;
  if not found then raise exception 'That item doesn''t exist (any more). Reload the page.'; end if;
  return v;
end;
$$;

/** A location; p_active refuses archived ones (nothing new goes into an archived location). */
create or replace function public.inv_location(p_id uuid, p_active boolean)
returns public.inventory_locations
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v inventory_locations;
begin
  if p_id is null then raise exception 'Pick a location.'; end if;
  select * into v from inventory_locations where id = p_id;
  if not found then raise exception 'That location doesn''t exist (any more).'; end if;
  if p_active and v.archived_at is not null then raise exception 'Location % is archived.', v.code; end if;
  return v;
end;
$$;

/** p_qty in p_unit (blank = the item's unit) → the item's unit, checked against its decimal places. */
create or replace function public.inv_qty(p_item public.inventory_items, p_qty numeric, p_unit text)
returns numeric
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_from inventory_units;
  v_to   inventory_units;
  v      numeric;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'Enter a quantity above zero.'; end if;
  if coalesce(p_unit, '') = '' or p_unit = p_item.unit then
    if p_qty <> round(p_qty, p_item.decimals) then
      raise exception '"%" is counted in %.', p_item.name,
        case when p_item.decimals = 0 then 'whole ' || p_item.unit else format('%s with at most %s decimal places', p_item.unit, p_item.decimals) end;
    end if;
    return p_qty;
  end if;
  select * into v_from from inventory_units where code = p_unit;
  if not found then raise exception 'Unknown unit "%".', p_unit; end if;
  select * into v_to from inventory_units where code = p_item.unit;
  if v_from.dimension <> v_to.dimension then
    raise exception 'You can''t use % for "%": it''s kept in %.', v_from.label, p_item.name, v_to.label;
  end if;
  v := round(p_qty * v_from.factor / v_to.factor, p_item.decimals);
  if v <= 0 then raise exception 'That''s less than the smallest amount of "%" that''s tracked.', p_item.name; end if;
  return v;
end;
$$;

/** Why a lot can't be used (null = it can): not in good condition, expired, or due for a retest. */
create or replace function public.inv_lot_problem(p_lot public.inventory_lots)
returns text
language sql stable set search_path = public, pg_temp
as $$
  select case
    when p_lot.id is null then null
    when p_lot.condition <> 'good' then format('is marked %s', p_lot.condition)
    when p_lot.expires_on < current_date then format('expired on %s', p_lot.expires_on)
    when p_lot.retest_on < current_date then format('was due for a retest on %s', p_lot.retest_on)
  end;
$$;

create or replace function public.inv_lot_label(p_lot public.inventory_lots)
returns text
language sql immutable set search_path = public, pg_temp
as $$
  select concat_ws(' / ', nullif(p_lot.lot_code, ''), nullif(p_lot.container, ''));
$$;

/**
 * The lot for a receipt (p.lot_id, or p.lot = {lot_code, container, expires_on, retest_on} found or made).
 * Null for items that aren't tracked by lot.
 */
create or replace function public.inv_resolve_lot(p_item public.inventory_items, p jsonb, p_create boolean, p_received date)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id   uuid := nullif(p ->> 'lot_id', '')::uuid;
  v_lot  jsonb := case when jsonb_typeof(p -> 'lot') = 'object' then p -> 'lot' else '{}'::jsonb end;
  v_code text := left(trim(coalesce(v_lot ->> 'lot_code', '')), 60);
  v_box  text := left(trim(coalesce(v_lot ->> 'container', '')), 60);
begin
  if not p_item.track_lots then
    if v_id is not null or v_code <> '' or v_box <> '' then
      raise exception '"%" isn''t tracked by lot. Turn on lot tracking for it first.', p_item.name;
    end if;
    return null;
  end if;
  if v_id is not null then
    if not exists (select 1 from inventory_lots where id = v_id and item_id = p_item.id) then
      raise exception 'That lot isn''t for "%".', p_item.name;
    end if;
    return v_id;
  end if;
  if not p_create or (v_code = '' and v_box = '') then
    raise exception '"%" is tracked by lot: pick the lot, or enter its lot number.', p_item.name;
  end if;
  select id into v_id from inventory_lots
   where item_id = p_item.id and lower(lot_code) = lower(v_code) and lower(container) = lower(v_box);
  if v_id is null then
    insert into inventory_lots (item_id, lot_code, container, received_on, expires_on, retest_on, opened_on, created_by)
    values (p_item.id, v_code, v_box, p_received, nullif(v_lot ->> 'expires_on', '')::date, nullif(v_lot ->> 'retest_on', '')::date,
            nullif(v_lot ->> 'opened_on', '')::date, auth.uid())
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

/** Who it's for: a subsystem (and its division right now), a whole division, or General shop. */
create or replace function public.inv_attribution(p_use_for text, p_division uuid, p_subsystem uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_s org_subsystems;
  v_d org_divisions;
begin
  if p_use_for = 'general' then
    if p_division is not null or p_subsystem is not null then
      raise exception 'General shop isn''t a division or subsystem: pick one or the other.';
    end if;
    return jsonb_build_object('use_for', 'general');
  elsif p_use_for = 'subsystem' then
    select * into v_s from org_subsystems where id = p_subsystem;
    if not found then raise exception 'Pick the subsystem it''s for.'; end if;
    if v_s.archived_at is not null then raise exception 'Subsystem "%" was archived. Pick a current one.', v_s.name; end if;
    if p_division is not null and p_division <> v_s.division_id then
      raise exception 'Subsystem "%" isn''t in that CE division.', v_s.name;
    end if;
    select * into v_d from org_divisions where id = v_s.division_id;
    return jsonb_build_object('use_for', 'subsystem', 'division_id', v_d.id, 'subsystem_id', v_s.id,
                              'division_name', v_d.name, 'subsystem_name', v_s.name);
  elsif p_use_for = 'division' then
    if p_subsystem is not null then raise exception 'Pick a subsystem or the whole division, not both.'; end if;
    select * into v_d from org_divisions where id = p_division;
    if not found then raise exception 'Pick the CE division it''s for.'; end if;
    if v_d.archived_at is not null then raise exception 'Division "%" was archived. Pick a current one.', v_d.name; end if;
    return jsonb_build_object('use_for', 'division', 'division_id', v_d.id, 'division_name', v_d.name);
  end if;
  raise exception 'Say what it''s for: a subsystem, a whole CE division, or General shop.';
end;
$$;

/**
 * Change one bucket's balance by p_delta (made if needed). The bucket row is locked; a balance can't go
 * below zero (OS422 says how much there is).
 */
create or replace function public.inv_bucket(p_item uuid, p_loc uuid, p_lot uuid, p_status text, p_delta numeric)
returns numeric
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v      inventory_stock;
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  v_i    inventory_items;
  v_code text;
begin
  select * into v from inventory_stock
   where item_id = p_item and location_id = p_loc and coalesce(lot_id, v_zero) = coalesce(p_lot, v_zero) and status = p_status
   for update;
  if not found then
    insert into inventory_stock (item_id, location_id, lot_id, status, qty) values (p_item, p_loc, p_lot, p_status, 0)
    on conflict do nothing;
    select * into v from inventory_stock
     where item_id = p_item and location_id = p_loc and coalesce(lot_id, v_zero) = coalesce(p_lot, v_zero) and status = p_status
     for update;
  end if;
  if v.qty + p_delta < 0 then
    select * into v_i from inventory_items where id = p_item;
    select code into v_code from inventory_locations where id = p_loc;
    raise exception 'Only % % of "%" % at %.', inv_fmt(v.qty), v_i.unit, v_i.name,
      case p_status when 'quarantine' then 'set aside' else 'in stock' end,
      v_code || case when p_lot is not null then ' in that lot' else '' end
      using errcode = 'OS422';
  end if;
  update inventory_stock set qty = qty + p_delta, updated_at = now() where id = v.id;
  return v.qty + p_delta;
end;
$$;

/** Record one movement line (and change the bucket, when it has a location). */
create or replace function public.inv_line(p_op uuid, p_kind text, p_item uuid, p_loc uuid, p_lot uuid, p_status text,
                                           p_qty numeric, p jsonb)
returns bigint
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id bigint;
begin
  if p_loc is not null then perform inv_bucket(p_item, p_loc, p_lot, p_status, p_qty); end if;
  insert into inventory_movements (op_id, kind, item_id, location_id, lot_id, status, qty, qty_entered, unit_entered, unit_cost,
                                   use_for, division_id, subsystem_id, division_name, subsystem_name, project, used_by_name,
                                   reason, receipt_id, count_id, import_id, returns_op, reversal, occurred_on, actor_id, actor_name)
  values (p_op, p_kind, p_item, p_loc, p_lot, case when p_loc is null then null else p_status end, p_qty,
          (p ->> 'qty_entered')::numeric, coalesce(p ->> 'unit_entered', ''), (p ->> 'unit_cost')::numeric,
          nullif(p ->> 'use_for', ''), (p ->> 'division_id')::uuid, (p ->> 'subsystem_id')::uuid, p ->> 'division_name', p ->> 'subsystem_name',
          left(coalesce(p ->> 'project', ''), 120),
          coalesce(p ->> 'used_by_name', case when p_kind in ('consume', 'return', 'direct_use') then coalesce(my_display_name(), '') else '' end),
          left(coalesce(p ->> 'reason', ''), 500),
          (p ->> 'receipt_id')::uuid, (p ->> 'count_id')::uuid, (p ->> 'import_id')::uuid, (p ->> 'returns_op')::uuid,
          coalesce((p ->> 'reversal')::boolean, false), coalesce((p ->> 'occurred_on')::date, current_date),
          auth.uid(), coalesce(my_display_name(), ''))
  returning id into v_id;
  return v_id;
end;
$$;

/**
 * Start an operation. Returns null for a new one; for an id that was already used (the same request sent
 * again), its first result with "replay": true, so nothing is done twice.
 */
create or replace function public.inv_op_begin(p_op uuid, p_kind text, p_item uuid, p_note text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v inventory_ops;
begin
  if p_op is null then raise exception 'Missing operation id. Reload the page and try again.'; end if;
  insert into inventory_ops (id, kind, item_id, actor_id, actor_name, note)
  values (p_op, p_kind, p_item, auth.uid(), coalesce(my_display_name(), ''), left(trim(coalesce(p_note, '')), 500))
  on conflict (id) do nothing;
  if found then return null; end if;
  select * into v from inventory_ops where id = p_op;
  if v.actor_id is distinct from auth.uid() or v.kind <> p_kind then
    raise exception 'That was already saved as something else. Reload the page and try again.';
  end if;
  return v.result || jsonb_build_object('op', p_op, 'replay', true);
end;
$$;

create or replace function public.inv_totals(p_item uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'on_hand', coalesce(sum(s.qty), 0),
    'available', coalesce(sum(s.qty) filter (where s.status = 'available' and (s.lot_id is null or inv_lot_problem(l) is null)), 0),
    'quarantined', coalesce(sum(s.qty) filter (where s.status = 'quarantine'), 0))
  from inventory_stock s left join inventory_lots l on l.id = s.lot_id
  where s.item_id = p_item;
$$;

create or replace function public.inv_op_end(p_op uuid, p_result jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update inventory_ops set result = p_result where id = p_op;
  return p_result || jsonb_build_object('op', p_op, 'replay', false);
end;
$$;

/** Remember what someone last used stock for. */
create or replace function public.inv_remember(p_attr jsonb, p_project text)
returns void
language sql security definer set search_path = public, pg_temp
as $$
  insert into inventory_prefs (user_id, use_for, division_id, subsystem_id, project, updated_at)
  values (auth.uid(), p_attr ->> 'use_for', (p_attr ->> 'division_id')::uuid, (p_attr ->> 'subsystem_id')::uuid, coalesce(p_project, ''), now())
  on conflict (user_id) do update set use_for = excluded.use_for, division_id = excluded.division_id,
    subsystem_id = excluded.subsystem_id, project = excluded.project, updated_at = now();
$$;

create or replace function public.inv_settings()
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select value from app_settings where key = 'inventory'), '{}'::jsonb);
$$;

/** When an item was last counted (in a finished count), or null. */
create or replace function public.inv_last_counted(p_item uuid)
returns timestamptz
language sql stable security definer set search_path = public, pg_temp
as $$
  select max(l.counted_at) from inventory_count_lines l join inventory_counts c on c.id = l.count_id
  where l.item_id = p_item and c.status = 'closed' and l.counted is not null;
$$;

/** Due for a count: never counted, or longer ago than its class's days (Setup → Settings). */
create or replace function public.inv_count_due(p_item public.inventory_items)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(inv_last_counted(p_item.id) < now() - make_interval(days =>
           coalesce((inv_settings() -> 'countDays' ->> p_item.count_class)::int, 180)), true);
$$;

-- ===================================================================================================
-- CE divisions and subsystems (Inventory → Setup; Admin → CE divisions)
-- ===================================================================================================

create or replace function public.org_save_division(p_id uuid, p_name text, p_sort int)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_name text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_id   uuid;
begin
  perform inv_require(array['inventory.manage', 'settings.edit']);
  if v_name = '' then raise exception 'Give the division a name.'; end if;
  if exists (select 1 from org_divisions where lower(name) = lower(v_name) and archived_at is null and id is distinct from p_id) then
    raise exception 'There''s already a division called "%".', v_name;
  end if;
  if p_id is null then
    insert into org_divisions (name, sort, created_by)
    values (v_name, coalesce(p_sort, (select coalesce(max(sort), 0) + 10 from org_divisions)), auth.uid())
    returning id into v_id;
  else
    update org_divisions set name = v_name, sort = coalesce(p_sort, sort), updated_at = now() where id = p_id returning id into v_id;
    if v_id is null then raise exception 'That division doesn''t exist any more.'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.org_archive_division(p_id uuid, p_archived boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v org_divisions;
begin
  perform inv_require(array['inventory.manage', 'settings.edit']);
  select * into v from org_divisions where id = p_id for update;
  if not found then raise exception 'That division doesn''t exist any more.'; end if;
  if p_archived then
    if exists (select 1 from org_subsystems where division_id = p_id and archived_at is null) then
      raise exception 'Archive or move "%"''s subsystems first.', v.name;
    end if;
    update org_divisions set archived_at = coalesce(archived_at, now()), updated_at = now() where id = p_id;
  else
    if exists (select 1 from org_divisions where lower(name) = lower(v.name) and archived_at is null and id <> p_id) then
      raise exception 'There''s already a current division called "%". Rename one of them first.', v.name;
    end if;
    update org_divisions set archived_at = null, updated_at = now() where id = p_id;
  end if;
end;
$$;

/** Add (p_id null), rename, reorder or move a subsystem to another division. Past usage keeps its old division. */
create or replace function public.org_save_subsystem(p_id uuid, p_division uuid, p_name text, p_sort int)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_name text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_d    org_divisions;
  v_id   uuid;
begin
  perform inv_require(array['inventory.manage', 'settings.edit']);
  if v_name = '' then raise exception 'Give the subsystem a name.'; end if;
  select * into v_d from org_divisions where id = p_division;
  if not found then raise exception 'Pick the CE division it belongs to.'; end if;
  if v_d.archived_at is not null then raise exception 'Division "%" is archived.', v_d.name; end if;
  if exists (select 1 from org_subsystems where division_id = p_division and lower(name) = lower(v_name)
               and archived_at is null and id is distinct from p_id) then
    raise exception '"%" already has a subsystem called "%".', v_d.name, v_name;
  end if;
  if p_id is null then
    insert into org_subsystems (division_id, name, sort, created_by)
    values (p_division, v_name, coalesce(p_sort, (select coalesce(max(sort), 0) + 10 from org_subsystems where division_id = p_division)), auth.uid())
    returning id into v_id;
  else
    update org_subsystems set division_id = p_division, name = v_name, sort = coalesce(p_sort, sort), updated_at = now()
     where id = p_id returning id into v_id;
    if v_id is null then raise exception 'That subsystem doesn''t exist any more.'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.org_archive_subsystem(p_id uuid, p_archived boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v org_subsystems;
begin
  perform inv_require(array['inventory.manage', 'settings.edit']);
  select * into v from org_subsystems where id = p_id for update;
  if not found then raise exception 'That subsystem doesn''t exist any more.'; end if;
  if not p_archived then
    if exists (select 1 from org_divisions where id = v.division_id and archived_at is not null) then
      raise exception 'Its division is archived. Move the subsystem to a current division instead.';
    end if;
    if exists (select 1 from org_subsystems where division_id = v.division_id and lower(name) = lower(v.name)
                 and archived_at is null and id <> p_id) then
      raise exception 'There''s already a current subsystem called "%" there.', v.name;
    end if;
  end if;
  update org_subsystems set archived_at = case when p_archived then coalesce(archived_at, now()) end, updated_at = now() where id = p_id;
end;
$$;

/** Put divisions (p_kind 'division') or one division's subsystems ('subsystem') in this order. */
create or replace function public.org_reorder(p_kind text, p_ids uuid[])
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform inv_require(array['inventory.manage', 'settings.edit']);
  if p_kind = 'division' then
    update org_divisions d set sort = u.o * 10, updated_at = now() from unnest(p_ids) with ordinality u(id, o) where d.id = u.id and d.sort <> u.o * 10;
  elsif p_kind = 'subsystem' then
    update org_subsystems s set sort = u.o * 10, updated_at = now() from unnest(p_ids) with ordinality u(id, o) where s.id = u.id and s.sort <> u.o * 10;
  else
    raise exception 'Reorder divisions or subsystems.';
  end if;
end;
$$;

/**
 * Starting points, so nobody types the team from scratch: the CE divisions Solar Evals already has
 * (its CE rubrics, without the trailing " CE"), and Orders' subsystem list into one division.
 * Names that already exist are skipped. Returns how many were added.
 */
create or replace function public.org_copy_from_evals()
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_n int;
begin
  perform inv_require(array['inventory.manage', 'settings.edit']);
  insert into org_divisions (name, sort, created_by)
  select distinct on (lower(n)) n, t.sort * 10, auth.uid()
  from eval_tracks t, lateral (select trim(regexp_replace(t.name, '\s+CE$', '', 'i')) n) x
  where t.kind = 'ce' and t.parent_id = 'master' and n <> ''
    and not exists (select 1 from org_divisions d where lower(d.name) = lower(n) and d.archived_at is null)
  order by lower(n), t.sort;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function public.org_add_subsystems(p_division uuid, p_names text[])
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_n    int := 0;
  v_name text;
begin
  perform inv_require(array['inventory.manage', 'settings.edit']);
  if not exists (select 1 from org_divisions where id = p_division and archived_at is null) then
    raise exception 'Pick a current CE division.';
  end if;
  foreach v_name in array coalesce(p_names, '{}') loop
    v_name := regexp_replace(trim(coalesce(v_name, '')), '\s+', ' ', 'g');
    continue when v_name = '' or length(v_name) > 80
      or exists (select 1 from org_subsystems where division_id = p_division and lower(name) = lower(v_name) and archived_at is null);
    insert into org_subsystems (division_id, name, sort, created_by)
    values (p_division, v_name, (select coalesce(max(sort), 0) + 10 from org_subsystems where division_id = p_division), auth.uid());
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ===================================================================================================
-- Catalog: categories, locations, items, suppliers, lots, settings
-- ===================================================================================================

create or replace function public.inventory_save_category(p_id uuid, p_name text, p_parent uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_name text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_id   uuid;
begin
  perform inv_require(array['inventory.manage']);
  if v_name = '' then raise exception 'Give the category a name.'; end if;
  if exists (select 1 from inventory_categories where lower(name) = lower(v_name) and archived_at is null and id is distinct from p_id) then
    raise exception 'There''s already a category called "%".', v_name;
  end if;
  if p_parent is not null and (p_parent = p_id or not exists (select 1 from inventory_categories where id = p_parent)) then
    raise exception 'Pick another parent category.';
  end if;
  if p_id is null then
    insert into inventory_categories (name, parent_id) values (v_name, p_parent) returning id into v_id;
  else
    update inventory_categories set name = v_name, parent_id = p_parent, updated_at = now() where id = p_id returning id into v_id;
    if v_id is null then raise exception 'That category doesn''t exist any more.'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.inventory_archive_category(p_id uuid, p_archived boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform inv_require(array['inventory.manage']);
  update inventory_categories set archived_at = case when p_archived then coalesce(archived_at, now()) end, updated_at = now() where id = p_id;
  if not found then raise exception 'That category doesn''t exist any more.'; end if;
end;
$$;

/** p: { code, name, parent_id, kind, description, restrictions }. Codes are capitals, digits, . _ - */
create or replace function public.inventory_save_location(p_id uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_code   text := upper(regexp_replace(trim(coalesce(p ->> 'code', '')), '\s+', '-', 'g'));
  v_name   text := trim(coalesce(p ->> 'name', ''));
  v_parent uuid := nullif(p ->> 'parent_id', '')::uuid;
  v_kind   text := coalesce(nullif(p ->> 'kind', ''), 'other');
  v_walk   uuid;
  v_depth  int := 0;
  v_id     uuid;
begin
  perform inv_require(array['inventory.manage']);
  if v_code !~ '^[A-Z0-9][A-Z0-9._-]{0,23}$' then
    raise exception 'The code "%" won''t work on a label: use up to 24 letters, digits, dots, dashes or underscores (e.g. CAB-A2).', v_code;
  end if;
  if v_name = '' then v_name := v_code; end if;
  if v_kind not in ('shop', 'room', 'cabinet', 'shelf', 'bin', 'other') then raise exception 'Unknown kind of location.'; end if;
  if exists (select 1 from inventory_locations where code = v_code and id is distinct from p_id) then
    raise exception 'Another location already has the code %.', v_code;
  end if;
  v_walk := v_parent;
  while v_walk is not null loop   -- no location inside itself
    if v_walk = p_id then raise exception 'A location can''t be inside itself.'; end if;
    v_depth := v_depth + 1;
    if v_depth > 20 then raise exception 'Locations can only be nested 20 deep.'; end if;
    select parent_id into v_walk from inventory_locations where id = v_walk;
  end loop;
  if v_parent is not null and exists (select 1 from inventory_locations where id = v_parent and archived_at is not null) then
    raise exception 'The location it''s in is archived.';
  end if;
  if p_id is null then
    insert into inventory_locations (code, name, parent_id, kind, description, restrictions, created_by)
    values (v_code, left(v_name, 80), v_parent, v_kind, left(coalesce(p ->> 'description', ''), 500), left(coalesce(p ->> 'restrictions', ''), 300), auth.uid())
    returning id into v_id;
  else
    update inventory_locations set code = v_code, name = left(v_name, 80), parent_id = v_parent, kind = v_kind,
      description = left(coalesce(p ->> 'description', ''), 500), restrictions = left(coalesce(p ->> 'restrictions', ''), 300), updated_at = now()
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'That location doesn''t exist any more.'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.inventory_archive_location(p_id uuid, p_archived boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v inventory_locations;
begin
  perform inv_require(array['inventory.manage']);
  select * into v from inventory_locations where id = p_id for update;
  if not found then raise exception 'That location doesn''t exist any more.'; end if;
  if p_archived then
    if exists (select 1 from inventory_stock where location_id = p_id and qty > 0) then
      raise exception '% still has stock in it. Move it or use it up first.', v.code;
    end if;
    if exists (select 1 from inventory_locations where parent_id = p_id and archived_at is null) then
      raise exception 'Archive or move the locations inside % first.', v.code;
    end if;
  elsif v.parent_id is not null and exists (select 1 from inventory_locations where id = v.parent_id and archived_at is not null) then
    raise exception 'The location it''s in is archived. Restore that first.';
  end if;
  update inventory_locations set archived_at = case when p_archived then coalesce(archived_at, now()) end, updated_at = now() where id = p_id;
end;
$$;

/**
 * Items that might be the same as what's being added: same SKU, same manufacturer part number, same
 * supplier part number, or the same / a similar name. Nothing is ever merged; people decide.
 * p: { sku, name, mpn, supplier_pn, exclude_id }
 */
create or replace function public.inventory_find_matches(p jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_name  text := inv_norm(p ->> 'name');
  v_words text[] := array(select distinct w from regexp_split_to_table(lower(coalesce(p ->> 'name', '')), '[^a-z0-9]+') w where length(w) >= 2);
  v_mpn   text := inv_norm(p ->> 'mpn');
  v_spn   text := inv_norm(p ->> 'supplier_pn');
  v_sku   text := upper(trim(coalesce(p ->> 'sku', '')));
  v_out   jsonb;
begin
  perform inv_require(array['inventory.view', 'inventory.use', 'inventory.receive', 'inventory.count', 'inventory.manage']);
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'sku', sku, 'name', name, 'manufacturer', manufacturer, 'mpn', mpn,
                                               'unit', unit, 'status', status, 'reasons', reasons) order by strength desc, name), '[]')
  into v_out
  from (
    select i.*, r.reasons, cardinality(r.reasons) + case when 'Same SKU' = any(r.reasons) or 'Same manufacturer part number' = any(r.reasons) then 10 else 0 end strength
    from inventory_items i,
    lateral (select array_remove(array[
      case when v_sku <> '' and upper(i.sku) = v_sku then 'Same SKU' end,
      case when length(v_mpn) >= 3 and inv_norm(i.mpn) = v_mpn then 'Same manufacturer part number' end,
      case when length(v_spn) >= 3 and exists (select 1 from inventory_supplier_parts sp where sp.item_id = i.id and inv_norm(sp.supplier_pn) = v_spn)
           then 'Same supplier part number' end,
      case when v_name <> '' and inv_norm(i.name) = v_name then 'Same name'
           when cardinality(v_words) > 0 and (
             select count(*) from unnest(v_words) w
             where w = any(array(select distinct x from regexp_split_to_table(lower(i.name), '[^a-z0-9]+') x where length(x) >= 2))
           )::numeric / greatest(cardinality(v_words),
                                 cardinality(array(select distinct x from regexp_split_to_table(lower(i.name), '[^a-z0-9]+') x where length(x) >= 2)), 1) >= 0.6
           then 'Similar name' end], null) reasons) r
    where cardinality(r.reasons) > 0 and i.id is distinct from nullif(p ->> 'exclude_id', '')::uuid
    order by strength desc, i.name
    limit 10
  ) m;
  return v_out;
end;
$$;

/**
 * Add (p_id null) or edit an item. Adding: "Receive & move stock" or "Manage inventory"; editing: "Manage
 * inventory". p holds the item's fields; a new item can also bring its first supplier (p.supplier = {…}).
 * An exact part-number match with another item is refused unless p.confirm_duplicate (OS412).
 */
create or replace function public.inventory_save_item(p_id uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_old     inventory_items;
  v_sku     text := upper(trim(coalesce(p ->> 'sku', '')));
  v_name    text := regexp_replace(trim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g');
  v_unit    text := coalesce(nullif(p ->> 'unit', ''), 'ea');
  v_dec     int;
  v_status  text := coalesce(nullif(p ->> 'status', ''), 'active');
  v_cat     uuid := nullif(p ->> 'category_id', '')::uuid;
  v_loc     uuid := nullif(p ->> 'default_location_id', '')::uuid;
  v_hz      text[] := coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(p -> 'hazard_classes') = 'array' then p -> 'hazard_classes' else '[]' end)), '{}');
  v_specs   jsonb := case when jsonb_typeof(p -> 'specs') = 'object' then p -> 'specs' else '{}'::jsonb end;
  v_sup     jsonb := case when jsonb_typeof(p -> 'supplier') = 'object' then p -> 'supplier' else null end;
  v_matches jsonb;
  v_id      uuid;
begin
  if p_id is null then
    perform inv_require(array['inventory.receive', 'inventory.manage']);
  else
    perform inv_require(array['inventory.manage']);
    select * into v_old from inventory_items where id = p_id for update;
    if not found then raise exception 'That item doesn''t exist any more.'; end if;
  end if;
  v_dec := coalesce(nullif(p ->> 'decimals', '')::int, case when v_unit in ('ea', 'pair', 'set', 'kit', 'roll', 'spool', 'sheet', 'bottle', 'can', 'tube', 'bag', 'box') then 0 else 2 end);
  if v_name = '' then raise exception 'Give the item a name.'; end if;
  if length(v_name) > 120 then raise exception 'Keep the name under 120 characters (the description can say more).'; end if;
  if not exists (select 1 from inventory_units where code = v_unit) then raise exception 'Unknown unit "%".', v_unit; end if;
  if v_dec not between 0 and 4 then raise exception 'Decimal places must be 0 to 4.'; end if;
  if v_status not in ('active', 'discontinued', 'archived') then raise exception 'Unknown status "%".', v_status; end if;
  if v_cat is not null and not exists (select 1 from inventory_categories where id = v_cat) then raise exception 'That category doesn''t exist any more.'; end if;
  if v_loc is not null and not exists (select 1 from inventory_locations where id = v_loc and archived_at is null) then
    raise exception 'Pick a current location as its usual place.';
  end if;
  if not v_hz <@ array['flammable', 'oxidizer', 'corrosive', 'toxic', 'health_hazard', 'irritant', 'compressed_gas', 'explosive', 'environmental', 'lithium_battery'] then
    raise exception 'Unknown hazard class.';
  end if;
  if (select count(*) from jsonb_object_keys(v_specs)) > 40 then raise exception 'Keep it to 40 specifications.'; end if;
  if exists (select 1 from jsonb_each(v_specs) where jsonb_typeof(value) not in ('string', 'number') or length(key) > 60 or length(value #>> '{}') > 200) then
    raise exception 'Each specification is a short name and value.';
  end if;
  if coalesce(p ->> 'image_url', '') !~ '^(https://\S+)?$' then raise exception 'The image link must start with https://'; end if;
  if coalesce(p ->> 'sds_url', '') !~ '^(https?://\S+)?$' then raise exception 'The safety data sheet link must start with https://'; end if;

  if v_sku = '' then
    if p_id is not null then v_sku := v_old.sku; else
      loop
        v_sku := 'INV-' || lpad(nextval('inventory_sku_seq')::text, 5, '0');
        exit when not exists (select 1 from inventory_items where upper(sku) = v_sku);
      end loop;
    end if;
  end if;
  if v_sku !~ '^[A-Z0-9][A-Z0-9._/-]{0,31}$' then
    raise exception 'The SKU "%" won''t work: use up to 32 letters, digits, dots, dashes, slashes or underscores.', v_sku;
  end if;
  if exists (select 1 from inventory_items where upper(sku) = v_sku and id is distinct from p_id) then
    raise exception 'Another item already has the SKU %.', v_sku;
  end if;

  if p_id is null and not coalesce((p ->> 'confirm_duplicate')::boolean, false) then
    v_matches := inventory_find_matches(jsonb_build_object('name', v_name, 'mpn', p ->> 'mpn', 'supplier_pn', v_sup ->> 'supplier_pn'));
    if exists (select 1 from jsonb_array_elements(v_matches) m
               where m -> 'reasons' ?| array['Same manufacturer part number', 'Same supplier part number', 'Same name']) then
      raise exception 'This looks like an item that''s already in the catalog: %. Use that one, or confirm this is a different item.',
        (select string_agg(format('%s (%s)', m ->> 'name', m ->> 'sku'), ', ') from jsonb_array_elements(v_matches) m
          where m -> 'reasons' ?| array['Same manufacturer part number', 'Same supplier part number', 'Same name'])
        using errcode = 'OS412';
    end if;
  end if;

  if p_id is not null then
    if v_unit <> v_old.unit and exists (select 1 from inventory_movements where item_id = p_id) then
      raise exception 'The unit can''t change once "%" has history (it would change every quantity). Make a new item instead.', v_old.name;
    end if;
    if v_dec < v_old.decimals and exists (select 1 from inventory_stock where item_id = p_id and qty <> round(qty, v_dec)) then
      raise exception 'Some stock of "%" has more decimal places than that.', v_old.name;
    end if;
    if v_status = 'archived' and v_old.status <> 'archived' and exists (select 1 from inventory_stock where item_id = p_id and qty > 0) then
      raise exception '"%" still has stock. Use it up, move it out or correct it before archiving.', v_old.name;
    end if;
    if v_old.track_lots and not coalesce((p ->> 'track_lots')::boolean, false) and exists (select 1 from inventory_stock where item_id = p_id and lot_id is not null and qty > 0) then
      raise exception 'Lot tracking can''t be turned off while lots of "%" are in stock.', v_old.name;
    end if;
    if not v_old.track_lots and coalesce((p ->> 'track_lots')::boolean, false) and exists (select 1 from inventory_stock where item_id = p_id and lot_id is null and qty > 0) then
      raise exception 'Lot tracking can only be turned on when "%" has no stock (receive it again into lots).', v_old.name;
    end if;
  end if;

  if p_id is null then
    insert into inventory_items (sku, name, description, category_id, manufacturer, mpn, specs, unit, decimals, status, image_url,
      default_location_id, reorder_point, reorder_qty, unit_cost, count_class, track_lots, hazardous, hazard_classes, sds_url,
      storage_notes, notes, created_by, updated_by)
    values (v_sku, v_name, left(coalesce(p ->> 'description', ''), 2000), v_cat, left(trim(coalesce(p ->> 'manufacturer', '')), 120),
      left(trim(coalesce(p ->> 'mpn', '')), 80), v_specs, v_unit, v_dec, v_status, coalesce(p ->> 'image_url', ''), v_loc,
      inv_num(p, 'reorder_point'), inv_num(p, 'reorder_qty'), inv_num(p, 'unit_cost'), coalesce(nullif(p ->> 'count_class', ''), 'C'),
      coalesce((p ->> 'track_lots')::boolean, false), coalesce((p ->> 'hazardous')::boolean, cardinality(v_hz) > 0), v_hz,
      coalesce(p ->> 'sds_url', ''), left(coalesce(p ->> 'storage_notes', ''), 500), left(coalesce(p ->> 'notes', ''), 2000), auth.uid(), auth.uid())
    returning id into v_id;
    if v_sup is not null and trim(coalesce(v_sup ->> 'supplier', '')) <> '' then
      insert into inventory_supplier_parts (item_id, supplier, supplier_pn, url, pack_qty, pack_label, last_price, preferred)
      values (v_id, trim(v_sup ->> 'supplier'), left(trim(coalesce(v_sup ->> 'supplier_pn', '')), 80), coalesce(v_sup ->> 'url', ''),
              coalesce(inv_num(v_sup, 'pack_qty'), 1), left(coalesce(v_sup ->> 'pack_label', ''), 40), inv_num(v_sup, 'last_price'), true);
    end if;
  else
    update inventory_items set sku = v_sku, name = v_name, description = left(coalesce(p ->> 'description', ''), 2000), category_id = v_cat,
      manufacturer = left(trim(coalesce(p ->> 'manufacturer', '')), 120), mpn = left(trim(coalesce(p ->> 'mpn', '')), 80), specs = v_specs,
      unit = v_unit, decimals = v_dec, status = v_status, image_url = coalesce(p ->> 'image_url', ''), default_location_id = v_loc,
      reorder_point = inv_num(p, 'reorder_point'), reorder_qty = inv_num(p, 'reorder_qty'), unit_cost = inv_num(p, 'unit_cost'),
      count_class = coalesce(nullif(p ->> 'count_class', ''), 'C'), track_lots = coalesce((p ->> 'track_lots')::boolean, false),
      hazardous = coalesce((p ->> 'hazardous')::boolean, cardinality(v_hz) > 0), hazard_classes = v_hz, sds_url = coalesce(p ->> 'sds_url', ''),
      storage_notes = left(coalesce(p ->> 'storage_notes', ''), 500), notes = left(coalesce(p ->> 'notes', ''), 2000),
      updated_by = auth.uid(), updated_at = now()
    where id = p_id returning id into v_id;
  end if;
  return v_id;
end;
$$;

/** Count classes for many items at once ({ item id: "A" | "B" | "C" }), e.g. Setup's "suggest by value". */
create or replace function public.inventory_set_count_classes(p jsonb)
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_n int;
begin
  perform inv_require(array['inventory.manage']);
  if exists (select 1 from jsonb_each_text(coalesce(p, '{}')) where value not in ('A', 'B', 'C')) then
    raise exception 'Count classes are A, B or C.';
  end if;
  update inventory_items i set count_class = e.value, updated_by = auth.uid(), updated_at = now()
  from jsonb_each_text(coalesce(p, '{}')) e where i.id = e.key::uuid and i.count_class <> e.value;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

/** p: { supplier, supplier_pn, url, pack_qty, pack_label, last_price, preferred, notes } */
create or replace function public.inventory_save_supplier_part(p_id uuid, p_item uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id   uuid;
  v_pack numeric := coalesce(inv_num(p, 'pack_qty'), 1);
begin
  perform inv_require(case when p_id is null then array['inventory.receive', 'inventory.manage'] else array['inventory.manage'] end);
  if trim(coalesce(p ->> 'supplier', '')) = '' then raise exception 'Name the supplier.'; end if;
  if v_pack <= 0 then raise exception 'A pack holds more than zero.'; end if;
  if coalesce(p ->> 'url', '') !~ '^(https?://\S+)?$' then raise exception 'The link must start with https://'; end if;
  if not exists (select 1 from inventory_items where id = p_item) then raise exception 'That item doesn''t exist any more.'; end if;
  if exists (select 1 from inventory_supplier_parts where item_id = p_item and lower(trim(supplier)) = lower(trim(p ->> 'supplier'))
               and inv_norm(supplier_pn) = inv_norm(p ->> 'supplier_pn') and id is distinct from p_id) then
    raise exception 'That supplier part is already listed.';
  end if;
  if coalesce((p ->> 'preferred')::boolean, false) then
    update inventory_supplier_parts set preferred = false, updated_at = now() where item_id = p_item and preferred and id is distinct from p_id;
  end if;
  if p_id is null then
    insert into inventory_supplier_parts (item_id, supplier, supplier_pn, url, pack_qty, pack_label, last_price, preferred, notes)
    values (p_item, left(trim(p ->> 'supplier'), 80), left(trim(coalesce(p ->> 'supplier_pn', '')), 80), coalesce(p ->> 'url', ''), v_pack,
            left(coalesce(p ->> 'pack_label', ''), 40), inv_num(p, 'last_price'), coalesce((p ->> 'preferred')::boolean, false), left(coalesce(p ->> 'notes', ''), 500))
    returning id into v_id;
  else
    update inventory_supplier_parts set supplier = left(trim(p ->> 'supplier'), 80), supplier_pn = left(trim(coalesce(p ->> 'supplier_pn', '')), 80),
      url = coalesce(p ->> 'url', ''), pack_qty = v_pack, pack_label = left(coalesce(p ->> 'pack_label', ''), 40), last_price = inv_num(p, 'last_price'),
      preferred = coalesce((p ->> 'preferred')::boolean, false), notes = left(coalesce(p ->> 'notes', ''), 500), updated_at = now()
    where id = p_id and item_id = p_item returning id into v_id;
    if v_id is null then raise exception 'That supplier part doesn''t exist any more.'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.inventory_delete_supplier_part(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v inventory_supplier_parts;
begin
  perform inv_require(array['inventory.manage']);
  delete from inventory_supplier_parts where id = p_id returning * into v;
  if v.id is not null then
    insert into inventory_audit (table_name, record_id, action, changes, actor_id, actor_name)
    values ('inventory_supplier_parts', v.id, 'delete', to_jsonb(v), auth.uid(), coalesce(my_display_name(), ''));
  end if;
end;
$$;

/** Change a lot's dates, condition or notes. p: { lot_code, container, received_on, opened_on, expires_on, retest_on, condition, notes } */
create or replace function public.inventory_save_lot(p_id uuid, p jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v inventory_lots;
begin
  perform inv_require(array['inventory.receive', 'inventory.count', 'inventory.manage']);
  select * into v from inventory_lots where id = p_id for update;
  if not found then raise exception 'That lot doesn''t exist any more.'; end if;
  if coalesce(p ->> 'condition', v.condition) not in ('good', 'damaged', 'suspect', 'expired') then raise exception 'Unknown condition.'; end if;
  update inventory_lots set
    lot_code = left(trim(coalesce(p ->> 'lot_code', lot_code)), 60), container = left(trim(coalesce(p ->> 'container', container)), 60),
    received_on = case when p ? 'received_on' then nullif(p ->> 'received_on', '')::date else received_on end,
    opened_on = case when p ? 'opened_on' then nullif(p ->> 'opened_on', '')::date else opened_on end,
    expires_on = case when p ? 'expires_on' then nullif(p ->> 'expires_on', '')::date else expires_on end,
    retest_on = case when p ? 'retest_on' then nullif(p ->> 'retest_on', '')::date else retest_on end,
    condition = coalesce(p ->> 'condition', condition), notes = left(coalesce(p ->> 'notes', notes), 500), updated_at = now()
  where id = p_id;
end;
$$;

/** Settings (Inventory → Setup → Settings). */
create or replace function public.inventory_save_settings(p jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare k text;
begin
  perform inv_require(array['inventory.manage']);
  if jsonb_typeof(p) <> 'object' then raise exception 'Settings must be a JSON object.'; end if;
  foreach k in array array['A', 'B', 'C'] loop
    if coalesce(p -> 'countDays' ->> k, '') !~ '^\d{1,3}$' then raise exception 'Count every 1 to 730 days (class %).', k; end if;
    if (p -> 'countDays' ->> k)::int not between 1 and 730 then raise exception 'Count every 1 to 730 days (class %).', k; end if;
  end loop;
  if coalesce(p ->> 'approvalValue', '') !~ '^\d+(\.\d+)?$' then raise exception 'The approval amount must be a number.'; end if;
  if coalesce(p ->> 'approvalPct', '') !~ '^\d+(\.\d+)?$' then raise exception 'The approval percentage must be 0 to 100.'; end if;
  if (p ->> 'approvalPct')::numeric > 100 then raise exception 'The approval percentage must be 0 to 100.'; end if;
  if coalesce(p ->> 'expiryWarnDays', '') !~ '^\d{1,3}$' then raise exception 'Warn 0 to 999 days before expiry.'; end if;
  insert into app_settings (key, value, updated_at, updated_by) values ('inventory', p, now(), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
end;
$$;

-- ===================================================================================================
-- Stock operations. Each takes the page's operation id (p_op) and returns
-- { op, replay, qty, item_id, on_hand, available, quarantined, … }.
-- ===================================================================================================

/** Put stock in by hand (not from Orders): p { item_id, location_id, qty, unit, lot_id | lot{…}, quarantine, unit_cost, source, note, date } */
create or replace function public.inventory_receive(p_op uuid, p jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_replay  jsonb;
  v_item    inventory_items;
  v_loc     inventory_locations;
  v_qty     numeric;
  v_lot     uuid;
  v_cost    numeric := inv_num(p, 'unit_cost');
  v_date    date := coalesce(nullif(p ->> 'date', '')::date, current_date);
  v_source  text := left(trim(coalesce(p ->> 'source', '')), 200);
  v_receipt uuid;
begin
  perform inv_require(array['inventory.receive', 'inventory.manage']);
  v_replay := inv_op_begin(p_op, 'receive', nullif(p ->> 'item_id', '')::uuid, p ->> 'note');
  if v_replay is not null then return v_replay; end if;
  v_item := inv_lock_item(nullif(p ->> 'item_id', '')::uuid);
  if v_item.status = 'archived' then raise exception '"%" is archived. Restore it first.', v_item.name; end if;
  v_loc := inv_location(nullif(p ->> 'location_id', '')::uuid, true);
  v_qty := inv_qty(v_item, inv_num(p, 'qty'), p ->> 'unit');
  if v_date > current_date then raise exception 'The date can''t be in the future.'; end if;
  if v_cost < 0 then raise exception 'The cost can''t be negative.'; end if;
  v_lot := inv_resolve_lot(v_item, p, true, v_date);
  insert into inventory_receipts (op_id, item_id, destination, qty, location_id, lot_id, source, received_on, note, actor_id, actor_name)
  values (p_op, v_item.id, 'stock', v_qty, v_loc.id, v_lot, v_source, v_date, left(trim(coalesce(p ->> 'note', '')), 500), auth.uid(), coalesce(my_display_name(), ''))
  returning id into v_receipt;
  perform inv_line(p_op, 'receive', v_item.id, v_loc.id, v_lot,
                   case when coalesce((p ->> 'quarantine')::boolean, false) then 'quarantine' else 'available' end, v_qty,
                   jsonb_build_object('qty_entered', inv_num(p, 'qty'), 'unit_entered', coalesce(nullif(p ->> 'unit', ''), v_item.unit),
                                      'unit_cost', v_cost, 'receipt_id', v_receipt, 'occurred_on', v_date, 'reason', v_source));
  if v_cost is not null then update inventory_items set unit_cost = v_cost, updated_at = now() where id = v_item.id and unit_cost is distinct from v_cost; end if;
  return inv_op_end(p_op, jsonb_build_object('qty', v_qty, 'item_id', v_item.id, 'location_id', v_loc.id, 'lot_id', v_lot) || inv_totals(v_item.id));
end;
$$;

/** Take stock out for a subsystem / division / General shop: p { item_id, location_id, lot_id, qty, unit, use_for, division_id, subsystem_id, project, note } */
create or replace function public.inventory_consume(p_op uuid, p jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_replay jsonb;
  v_item   inventory_items;
  v_loc    inventory_locations;
  v_qty    numeric;
  v_lot    inventory_lots;
  v_why    text;
  v_attr   jsonb;
  v_proj   text := left(trim(coalesce(p ->> 'project', '')), 120);
begin
  perform inv_require(array['inventory.use', 'inventory.manage']);
  v_replay := inv_op_begin(p_op, 'consume', nullif(p ->> 'item_id', '')::uuid, p ->> 'note');
  if v_replay is not null then return v_replay; end if;
  v_item := inv_lock_item(nullif(p ->> 'item_id', '')::uuid);
  v_loc := inv_location(nullif(p ->> 'location_id', '')::uuid, false);
  v_qty := inv_qty(v_item, inv_num(p, 'qty'), p ->> 'unit');
  if nullif(p ->> 'lot_id', '') is not null then
    select * into v_lot from inventory_lots where id = (p ->> 'lot_id')::uuid and item_id = v_item.id;
    if not found then raise exception 'That lot isn''t for "%".', v_item.name; end if;
  elsif v_item.track_lots then
    raise exception 'Pick which lot of "%" you''re using.', v_item.name;
  end if;
  v_why := inv_lot_problem(v_lot);
  if v_why is not null then
    raise exception 'Lot % of "%" % and can''t be used. Set it aside, or ask an inventory manager to check it.', inv_lot_label(v_lot), v_item.name, v_why;
  end if;
  v_attr := inv_attribution(p ->> 'use_for', nullif(p ->> 'division_id', '')::uuid, nullif(p ->> 'subsystem_id', '')::uuid);
  perform inv_line(p_op, 'consume', v_item.id, v_loc.id, v_lot.id, 'available', -v_qty,
                   v_attr || jsonb_build_object('project', v_proj, 'qty_entered', inv_num(p, 'qty'),
                                                'unit_entered', coalesce(nullif(p ->> 'unit', ''), v_item.unit), 'unit_cost', v_item.unit_cost));
  perform inv_remember(v_attr, v_proj);
  return inv_op_end(p_op, jsonb_build_object('qty', v_qty, 'item_id', v_item.id, 'location_id', v_loc.id) || v_attr || inv_totals(v_item.id));
end;
$$;

/**
 * Put unused stock back: p { item_id, location_id, lot_id, qty, unit, returns_op (the "used" it came from), or
 * use_for/division_id/subsystem_id when there isn't one, note }. Usage reports count it off what it was used for.
 */
create or replace function public.inventory_return(p_op uuid, p jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_replay jsonb;
  v_item   inventory_items;
  v_loc    inventory_locations;
  v_qty    numeric;
  v_ref    uuid := nullif(p ->> 'returns_op', '')::uuid;
  v_used   inventory_movements;
  v_taken  numeric;
  v_back   numeric;
  v_lot    uuid := nullif(p ->> 'lot_id', '')::uuid;
  v_attr   jsonb;
begin
  perform inv_require(array['inventory.use', 'inventory.manage']);
  v_replay := inv_op_begin(p_op, 'return', nullif(p ->> 'item_id', '')::uuid, p ->> 'note');
  if v_replay is not null then return v_replay; end if;
  v_item := inv_lock_item(nullif(p ->> 'item_id', '')::uuid);
  v_loc := inv_location(nullif(p ->> 'location_id', '')::uuid, true);
  v_qty := inv_qty(v_item, inv_num(p, 'qty'), p ->> 'unit');
  if v_ref is not null then
    select m.* into v_used from inventory_movements m join inventory_ops o on o.id = m.op_id
     where m.op_id = v_ref and m.kind = 'consume' and not m.reversal and m.item_id = v_item.id and o.reversed_by is null
     limit 1;
    if not found then raise exception 'That isn''t a current "used" record for "%".', v_item.name; end if;
    select -sum(qty) into v_taken from inventory_movements where op_id = v_ref and kind = 'consume';
    select coalesce(sum(qty), 0) into v_back from inventory_movements where returns_op = v_ref and kind = 'return';
    if v_back + v_qty > v_taken then
      raise exception 'Only % % of that was taken out, and % already came back.', inv_fmt(v_taken), v_item.unit, inv_fmt(v_back);
    end if;
    v_attr := jsonb_strip_nulls(jsonb_build_object('use_for', v_used.use_for, 'division_id', v_used.division_id, 'subsystem_id', v_used.subsystem_id,
                                 'division_name', v_used.division_name, 'subsystem_name', v_used.subsystem_name, 'project', v_used.project,
                                 'used_by_name', v_used.used_by_name));
    v_lot := coalesce(v_lot, v_used.lot_id);
  else
    v_attr := inv_attribution(p ->> 'use_for', nullif(p ->> 'division_id', '')::uuid, nullif(p ->> 'subsystem_id', '')::uuid)
              || jsonb_build_object('project', left(trim(coalesce(p ->> 'project', '')), 120));
  end if;
  if v_item.track_lots and v_lot is null then raise exception 'Pick which lot of "%" is going back.', v_item.name; end if;
  if v_lot is not null and not exists (select 1 from inventory_lots where id = v_lot and item_id = v_item.id) then
    raise exception 'That lot isn''t for "%".', v_item.name;
  end if;
  perform inv_line(p_op, 'return', v_item.id, v_loc.id, v_lot, 'available', v_qty,
                   v_attr || jsonb_build_object('returns_op', v_ref, 'qty_entered', inv_num(p, 'qty'),
                                                'unit_entered', coalesce(nullif(p ->> 'unit', ''), v_item.unit), 'unit_cost', v_item.unit_cost));
  return inv_op_end(p_op, jsonb_build_object('qty', v_qty, 'item_id', v_item.id, 'location_id', v_loc.id) || inv_totals(v_item.id));
end;
$$;

/** Move stock between locations (the total stays the same): p { item_id, from_id, to_id, lot_id, status, qty, unit, note } */
create or replace function public.inventory_transfer(p_op uuid, p jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_replay jsonb;
  v_item   inventory_items;
  v_from   inventory_locations;
  v_to     inventory_locations;
  v_qty    numeric;
  v_lot    uuid := nullif(p ->> 'lot_id', '')::uuid;
  v_status text := coalesce(nullif(p ->> 'status', ''), 'available');
begin
  perform inv_require(array['inventory.receive', 'inventory.manage']);
  v_replay := inv_op_begin(p_op, 'transfer', nullif(p ->> 'item_id', '')::uuid, p ->> 'note');
  if v_replay is not null then return v_replay; end if;
  v_item := inv_lock_item(nullif(p ->> 'item_id', '')::uuid);
  v_from := inv_location(nullif(p ->> 'from_id', '')::uuid, false);
  v_to := inv_location(nullif(p ->> 'to_id', '')::uuid, true);
  if v_from.id = v_to.id then raise exception 'Pick a different location to move it to.'; end if;
  if v_status not in ('available', 'quarantine') then raise exception 'Unknown stock status.'; end if;
  if v_item.track_lots and v_lot is null then raise exception 'Pick which lot of "%" is moving.', v_item.name; end if;
  v_qty := inv_qty(v_item, inv_num(p, 'qty'), p ->> 'unit');
  perform inv_line(p_op, 'transfer', v_item.id, v_from.id, v_lot, v_status, -v_qty, jsonb_build_object('qty_entered', inv_num(p, 'qty'), 'unit_entered', coalesce(nullif(p ->> 'unit', ''), v_item.unit)));
  perform inv_line(p_op, 'transfer', v_item.id, v_to.id, v_lot, v_status, v_qty, jsonb_build_object('qty_entered', inv_num(p, 'qty'), 'unit_entered', coalesce(nullif(p ->> 'unit', ''), v_item.unit)));
  return inv_op_end(p_op, jsonb_build_object('qty', v_qty, 'item_id', v_item.id, 'from_id', v_from.id, 'to_id', v_to.id) || inv_totals(v_item.id));
end;
$$;

/**
 * Correct a balance (inventory managers, with a reason): p { item_id, location_id, lot_id, status, reason,
 * set_to (with expected: the balance you saw) | delta }. If the balance changed since you looked, nothing is
 * changed (OS409).
 */
create or replace function public.inventory_adjust(p_op uuid, p jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_replay jsonb;
  v_item   inventory_items;
  v_loc    inventory_locations;
  v_lot    uuid := nullif(p ->> 'lot_id', '')::uuid;
  v_status text := coalesce(nullif(p ->> 'status', ''), 'available');
  v_reason text := trim(coalesce(p ->> 'reason', ''));
  v_now    numeric;
  v_target numeric;
  v_delta  numeric;
begin
  perform inv_require(array['inventory.manage']);
  if length(v_reason) < 3 then raise exception 'Say why the stock is being corrected.'; end if;
  v_replay := inv_op_begin(p_op, 'adjust', nullif(p ->> 'item_id', '')::uuid, v_reason);
  if v_replay is not null then return v_replay; end if;
  v_item := inv_lock_item(nullif(p ->> 'item_id', '')::uuid);
  v_loc := inv_location(nullif(p ->> 'location_id', '')::uuid, false);
  if v_status not in ('available', 'quarantine') then raise exception 'Unknown stock status.'; end if;
  if v_lot is not null and not exists (select 1 from inventory_lots where id = v_lot and item_id = v_item.id) then
    raise exception 'That lot isn''t for "%".', v_item.name;
  end if;
  if v_item.track_lots and v_lot is null then raise exception 'Pick which lot of "%" to correct.', v_item.name; end if;
  select coalesce(sum(qty), 0) into v_now from inventory_stock
   where item_id = v_item.id and location_id = v_loc.id and lot_id is not distinct from v_lot and status = v_status;
  if p ? 'set_to' then
    v_target := inv_num(p, 'set_to');
    if v_target is null or v_target < 0 then raise exception 'Enter the right quantity (zero or more).'; end if;
    if v_target <> round(v_target, v_item.decimals) then raise exception '"%" is kept to % decimal places.', v_item.name, v_item.decimals; end if;
    if p ? 'expected' and inv_num(p, 'expected') is distinct from v_now then
      raise exception 'The stock there changed since you looked (it''s % now). Check it and try again.', inv_fmt(v_now) using errcode = 'OS409';
    end if;
    v_delta := v_target - v_now;
  else
    v_delta := inv_num(p, 'delta');
    if v_delta is null or v_delta <> round(v_delta, v_item.decimals) then raise exception 'Enter how much to add or take off.'; end if;
  end if;
  if v_delta = 0 then raise exception 'Nothing to change: there are already % there.', inv_fmt(v_now); end if;
  perform inv_line(p_op, 'adjust', v_item.id, v_loc.id, v_lot, v_status, v_delta, jsonb_build_object('reason', v_reason, 'unit_cost', v_item.unit_cost));
  return inv_op_end(p_op, jsonb_build_object('qty', v_delta, 'item_id', v_item.id, 'location_id', v_loc.id) || inv_totals(v_item.id));
end;
$$;

/**
 * Set stock aside (damaged, expired, questionable: still counted, not available) or release it (inventory
 * managers). Expired or not-good lots are never released automatically: fix the lot's dates or condition first.
 * p { item_id, location_id, lot_id, qty, unit, reason, release }
 */
create or replace function public.inventory_quarantine(p_op uuid, p jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_release boolean := coalesce((p ->> 'release')::boolean, false);
  v_replay  jsonb;
  v_item    inventory_items;
  v_loc     inventory_locations;
  v_lot     inventory_lots;
  v_qty     numeric;
  v_reason  text := trim(coalesce(p ->> 'reason', ''));
  v_why     text;
begin
  if v_release then
    perform inv_require(array['inventory.manage']);
  else
    perform inv_require(array['inventory.receive', 'inventory.count', 'inventory.manage']);
    if length(v_reason) < 3 then raise exception 'Say why it''s being set aside (e.g. damaged, expired).'; end if;
  end if;
  v_replay := inv_op_begin(p_op, case when v_release then 'release' else 'quarantine' end, nullif(p ->> 'item_id', '')::uuid, v_reason);
  if v_replay is not null then return v_replay; end if;
  v_item := inv_lock_item(nullif(p ->> 'item_id', '')::uuid);
  v_loc := inv_location(nullif(p ->> 'location_id', '')::uuid, false);
  v_qty := inv_qty(v_item, inv_num(p, 'qty'), p ->> 'unit');
  if nullif(p ->> 'lot_id', '') is not null then
    select * into v_lot from inventory_lots where id = (p ->> 'lot_id')::uuid and item_id = v_item.id;
    if not found then raise exception 'That lot isn''t for "%".', v_item.name; end if;
  elsif v_item.track_lots then
    raise exception 'Pick which lot of "%".', v_item.name;
  end if;
  if v_release then
    v_why := inv_lot_problem(v_lot);
    if v_why is not null then
      raise exception 'Lot % %. Update its dates or condition before releasing it.', inv_lot_label(v_lot), v_why;
    end if;
  end if;
  perform inv_line(p_op, 'quarantine', v_item.id, v_loc.id, v_lot.id, case when v_release then 'quarantine' else 'available' end, -v_qty, jsonb_build_object('reason', v_reason));
  perform inv_line(p_op, 'quarantine', v_item.id, v_loc.id, v_lot.id, case when v_release then 'available' else 'quarantine' end, v_qty, jsonb_build_object('reason', v_reason));
  return inv_op_end(p_op, jsonb_build_object('qty', v_qty, 'item_id', v_item.id, 'location_id', v_loc.id) || inv_totals(v_item.id));
end;
$$;

-- ===================================================================================================
-- Orders: link lines to catalog items, receive them (in parts), keep Orders' "arrived" in step
-- ===================================================================================================

/** How much of an Orders line has been received in Inventory (in the line's quantity), not counting undone receipts. */
create or replace function public.inv_order_received(p_line uuid)
returns numeric
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(sum(qty_order), 0) from inventory_receipts where request_item_id = p_line and reversed_at is null;
$$;

/**
 * Keep Orders in step after a receipt (or an undone one). The rules:
 *   * a line is "arrived" in Orders once Inventory has received its whole quantity;
 *   * undoing a receipt un-arrives the line again, if Inventory had arrived it and the request is still Ordered;
 *   * when every line of an Ordered request has arrived, the request becomes Received (as if someone had
 *     pressed "Mark as Received"), and the requester is told the usual way.
 */
create or replace function public.inv_sync_order_line(p_line uuid, p_date date, p_where text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_ri  request_items;
  v_req requests;
  v_got numeric;
begin
  select * into v_ri from request_items where id = p_line for update;
  if not found then return; end if;
  select * into v_req from requests where id = v_ri.request_id;
  v_got := inv_order_received(p_line);
  if v_got > 0 and v_got >= coalesce(v_ri.quantity, 0) and v_ri.arrived_on is null then
    update request_items set arrived_on = least(coalesce(p_date, current_date), current_date), arrived_by = auth.uid(),
      arrived_note = left('Received in Inventory' || case when coalesce(p_where, '') <> '' then ' (' || p_where || ')' else '' end, 500),
      arrived_with_request = false, arrived_via_inventory = true
    where id = p_line;
  elsif v_got < coalesce(v_ri.quantity, 0) and v_ri.arrived_on is not null and v_ri.arrived_via_inventory and v_req.status = 'Ordered' then
    update request_items set arrived_on = null, arrived_by = null, arrived_note = '', arrived_via_inventory = false where id = p_line;
  end if;
  if v_req.status = 'Ordered' and not exists (select 1 from request_items where request_id = v_req.id and arrived_on is null) then
    update order_information set received_date = least(coalesce(p_date, current_date), current_date),
      received_notes = left('Received in Inventory' || case when coalesce(p_where, '') <> '' then ': ' || p_where else '' end, 500),
      received_by = auth.uid()
    where request_id = v_req.id;
    update requests set status = 'Received', updated_at = now() where id = v_req.id;
    insert into request_events (request_id, kind, actor_id, actor_name, note)
    values (v_req.id, 'received', auth.uid(), coalesce(my_display_name(), ''), 'Every item was received in Inventory');
  end if;
end;
$$;

alter table public.request_events drop constraint if exists request_events_kind_check;
alter table public.request_events add constraint request_events_kind_check
  check (kind in ('submitted', 'resubmitted', 'withdrawn', 'ordered', 'received', 'edited', 'cancelled', 'restored',
                  'arrived', 'unreceived', 'items_edited', 'linked', 'inventory'));

/**
 * Link an Orders line to a catalog item (p_item null unlinks). p_units_per: how many of the item's unit
 * one ordered quantity is (1 unless it's sold in packs). Can't change once something was received against it.
 */
create or replace function public.inventory_link_order_line(p_line uuid, p_item uuid, p_units_per numeric)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_ri   request_items;
  v_link inventory_order_links;
  v_item inventory_items;
  v_per  numeric := coalesce(p_units_per, 1);
begin
  perform inv_require(array['inventory.receive', 'inventory.manage']);
  select * into v_ri from request_items where id = p_line for update;
  if not found then raise exception 'That order line doesn''t exist any more.'; end if;
  select * into v_link from inventory_order_links where request_item_id = p_line;
  if v_link.item_id is not null and (p_item is distinct from v_link.item_id or v_per <> v_link.units_per)
     and exists (select 1 from inventory_receipts where request_item_id = p_line and reversed_at is null and item_id is not null) then
    raise exception '"%" was already received as that item. Undo those receipts first.', v_ri.item_name;
  end if;
  if p_item is null then
    delete from inventory_order_links where request_item_id = p_line;
    return;
  end if;
  select * into v_item from inventory_items where id = p_item;
  if not found then raise exception 'That item doesn''t exist any more.'; end if;
  if v_item.status = 'archived' then raise exception '"%" is archived.', v_item.name; end if;
  if v_per <= 0 then raise exception 'One ordered unit holds more than zero.'; end if;
  insert into inventory_order_links (request_item_id, item_id, units_per, linked_by)
  values (p_line, p_item, v_per, auth.uid())
  on conflict (request_item_id) do update set item_id = excluded.item_id, units_per = excluded.units_per, linked_by = auth.uid(), linked_at = now();
end;
$$;

/**
 * Receive (part of) an ordered line: p { line_id, qty (in the line's quantity), destination 'stock' | 'direct' |
 * 'non_inventory', location_id, lot_id | lot{…}, quarantine, use_for, division_id, subsystem_id, project, date, note,
 * over_reason }. Never more than is still to come, unless an inventory manager records an over-delivery with a reason.
 */
create or replace function public.inventory_receive_order(p_op uuid, p jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_dest    text := coalesce(nullif(p ->> 'destination', ''), 'stock');
  v_replay  jsonb;
  v_ri      request_items;
  v_req     requests;
  v_link    inventory_order_links;
  v_item    inventory_items;
  v_q       numeric := inv_num(p, 'qty');
  v_got     numeric;
  v_left    numeric;
  v_over    boolean := false;
  v_reason  text := trim(coalesce(p ->> 'over_reason', ''));
  v_qty     numeric;
  v_loc     inventory_locations;
  v_lot     uuid;
  v_attr    jsonb := '{}';
  v_cost    numeric;
  v_receipt uuid;
  v_date    date := coalesce(nullif(p ->> 'date', '')::date, current_date);
  v_where   text;
begin
  perform inv_require(array['inventory.receive', 'inventory.manage']);
  if v_dest not in ('stock', 'direct', 'non_inventory') then
    raise exception 'Say where it goes: into stock, straight to a subsystem, or not an inventory item.';
  end if;
  v_replay := inv_op_begin(p_op, 'order_receipt', null, p ->> 'note');
  if v_replay is not null then return v_replay; end if;
  select * into v_ri from request_items where id = nullif(p ->> 'line_id', '')::uuid;
  if not found then raise exception 'That order line doesn''t exist any more.'; end if;
  select * into v_req from requests where id = v_ri.request_id for update;     -- the same order as Orders' own functions
  select * into v_ri from request_items where id = v_ri.id for update;
  if v_req.status not in ('Ordered', 'Received') then
    raise exception '% is "%". Only ordered requests can be received (approved isn''t ordered until the Treasurer marks it Ordered).',
      v_req.request_number, v_req.status;
  end if;
  if v_q is null or v_q <= 0 then raise exception 'Enter how many arrived.'; end if;
  if v_date > current_date then raise exception 'The date can''t be in the future.'; end if;
  v_got := inv_order_received(v_ri.id);
  v_left := greatest(coalesce(v_ri.quantity, 0) - v_got, 0);
  if v_q > v_left then
    if not has_permission('inventory.manage') or v_reason = '' then
      raise exception 'Only % still to come on this line (% ordered, % received). An inventory manager can record an over-delivery with a reason.',
        inv_fmt(v_left), inv_fmt(coalesce(v_ri.quantity, 0)), inv_fmt(v_got) using errcode = 'OS422';
    end if;
    v_over := true;
  end if;

  select * into v_link from inventory_order_links where request_item_id = v_ri.id;
  if v_dest = 'stock' and v_link.item_id is null then
    raise exception 'Link "%" to an inventory item first (or add it to the catalog).', v_ri.item_name;
  end if;
  if v_dest <> 'non_inventory' and v_link.item_id is not null then
    v_item := inv_lock_item(v_link.item_id);
    v_qty := round(v_q * v_link.units_per, v_item.decimals);
    if v_qty <= 0 then raise exception 'That''s less than the smallest amount of "%" that''s tracked.', v_item.name; end if;
    if v_ri.unit_price is not null then v_cost := round(v_ri.unit_price / v_link.units_per, 6); end if;
  end if;
  if v_dest = 'direct' then
    v_attr := inv_attribution(p ->> 'use_for', nullif(p ->> 'division_id', '')::uuid, nullif(p ->> 'subsystem_id', '')::uuid)
              || jsonb_build_object('project', left(trim(coalesce(p ->> 'project', '')), 120));
    v_where := 'used straight away by ' || coalesce(v_attr ->> 'subsystem_name', v_attr ->> 'division_name', 'General shop');
  elsif v_dest = 'stock' then
    v_loc := inv_location(nullif(p ->> 'location_id', '')::uuid, true);
    v_lot := inv_resolve_lot(v_item, p, true, v_date);
    v_where := v_loc.code;
  else
    v_where := 'not an inventory item';
  end if;

  update inventory_ops set item_id = v_item.id where id = p_op;
  insert into inventory_receipts (op_id, request_id, request_item_id, order_ref, line_name, line_price, item_id, destination, qty_order, qty,
    location_id, lot_id, use_for, division_id, subsystem_id, division_name, subsystem_name, project, over_receipt, over_reason,
    received_on, note, actor_id, actor_name)
  values (p_op, v_req.id, v_ri.id, v_req.request_number, v_ri.item_name, v_ri.unit_price, case when v_dest = 'non_inventory' then null else v_item.id end,
    v_dest, v_q, case when v_dest = 'non_inventory' then null else v_qty end, v_loc.id, v_lot,
    v_attr ->> 'use_for', (v_attr ->> 'division_id')::uuid, (v_attr ->> 'subsystem_id')::uuid, v_attr ->> 'division_name', v_attr ->> 'subsystem_name',
    coalesce(v_attr ->> 'project', ''), v_over, case when v_over then left(v_reason, 500) else '' end, v_date,
    left(trim(coalesce(p ->> 'note', '')), 500), auth.uid(), coalesce(my_display_name(), ''))
  returning id into v_receipt;

  if v_dest = 'stock' then
    perform inv_line(p_op, 'receive', v_item.id, v_loc.id, v_lot,
                     case when coalesce((p ->> 'quarantine')::boolean, false) then 'quarantine' else 'available' end, v_qty,
                     jsonb_build_object('qty_entered', v_q, 'unit_entered', 'ordered', 'unit_cost', v_cost, 'receipt_id', v_receipt,
                                        'occurred_on', v_date, 'reason', v_req.request_number));
    if v_cost is not null then update inventory_items set unit_cost = v_cost, updated_at = now() where id = v_item.id and unit_cost is distinct from v_cost; end if;
  elsif v_dest = 'direct' and v_item.id is not null then
    perform inv_line(p_op, 'direct_use', v_item.id, null, null, null, -v_qty,
                     v_attr || jsonb_build_object('qty_entered', v_q, 'unit_entered', 'ordered', 'unit_cost', v_cost, 'receipt_id', v_receipt,
                                                  'occurred_on', v_date, 'reason', v_req.request_number));
  end if;

  insert into request_events (request_id, kind, actor_id, actor_name, note)
  values (v_req.id, 'inventory', auth.uid(), coalesce(my_display_name(), ''),
          left(format('%s of %s × %s received: %s%s', inv_fmt(v_got + v_q), inv_fmt(coalesce(v_ri.quantity, 0)),
                      coalesce(nullif(trim(v_ri.item_name), ''), 'an item'), v_where,
                      case when v_over then ' (over-delivery: ' || v_reason || ')' else '' end), 1000));
  perform inv_sync_order_line(v_ri.id, v_date, v_where);

  return inv_op_end(p_op, jsonb_build_object('line_id', v_ri.id, 'received', v_got + v_q, 'outstanding', greatest(coalesce(v_ri.quantity, 0) - v_got - v_q, 0),
                                             'qty', v_qty, 'item_id', v_item.id, 'over', v_over,
                                             'request_status', (select status from requests where id = v_req.id)));
end;
$$;

/**
 * Orders lines for receiving, with what's arrived so far and their catalog link (or a suggested item with the
 * same part number: never matched by name alone). p_request null: every Ordered request's open lines, plus
 * lines already partly received in Inventory. Otherwise one request's lines (any status).
 */
create or replace function public.inventory_order_lines(p_request uuid, p_open_only boolean)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v jsonb;
begin
  perform inv_require(array['inventory.view', 'inventory.use', 'inventory.receive', 'inventory.count', 'inventory.manage']);
  select coalesce(jsonb_agg(x.j order by x.ordered_on nulls last, x.request_number, x.position), '[]') into v
  from (
    select oi.order_date ordered_on, r.request_number, ri.position, jsonb_build_object(
      'request_id', r.id, 'request_number', r.request_number, 'title', r.title, 'status', r.status, 'subsystem', r.subsystem,
      'requester', r.requester, 'ordered_on', oi.order_date, 'line_id', ri.id, 'position', ri.position, 'item_name', ri.item_name,
      'vendor', ri.vendor, 'part_number', ri.part_number, 'product_link', ri.product_link, 'quantity', ri.quantity,
      'unit_price', ri.unit_price, 'arrived_on', ri.arrived_on, 'received', g.got,
      'outstanding', greatest(coalesce(ri.quantity, 0) - g.got, 0),
      'link', case when l.item_id is null then null else jsonb_build_object('item_id', l.item_id, 'units_per', l.units_per, 'sku', i.sku,
                'name', i.name, 'unit', i.unit, 'decimals', i.decimals, 'track_lots', i.track_lots, 'default_location_id', i.default_location_id) end,
      'suggest', case when l.item_id is null and length(inv_norm(ri.part_number)) >= 3 then (
          select jsonb_agg(jsonb_build_object('item_id', s.id, 'sku', s.sku, 'name', s.name, 'unit', s.unit, 'pack_qty', s.pack_qty))
          from (select distinct on (c.id) c.id, c.sku, c.name, c.unit, coalesce(sp.pack_qty, 1) pack_qty
                from inventory_items c left join inventory_supplier_parts sp on sp.item_id = c.id and inv_norm(sp.supplier_pn) = inv_norm(ri.part_number)
                where c.status <> 'archived' and (inv_norm(c.mpn) = inv_norm(ri.part_number) or sp.id is not null)
                order by c.id limit 3) s) end
    ) j
    from request_items ri
    join requests r on r.id = ri.request_id
    left join order_information oi on oi.request_id = r.id
    left join lateral (select coalesce(sum(rc.qty_order), 0) got from inventory_receipts rc where rc.request_item_id = ri.id and rc.reversed_at is null) g on true
    left join inventory_order_links l on l.request_item_id = ri.id
    left join inventory_items i on i.id = l.item_id
    where (p_request is not null and r.id = p_request)
       or (p_request is null and (r.status = 'Ordered' or (r.status = 'Received' and g.got > 0 and g.got < coalesce(ri.quantity, 0))))
  ) x
  where not coalesce(p_open_only, false) or (x.j ->> 'outstanding')::numeric > 0;
  return v;
end;
$$;

-- An Orders line received in Inventory can't be removed, or its quantity lowered below what arrived.
create or replace function public.inv_guard_order_line()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_got numeric;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from inventory_receipts where request_item_id = old.id and reversed_at is null) then
      raise exception '"%" was received in Inventory, so it can''t be removed. Undo the receipt in Inventory first.', old.item_name;
    end if;
    return old;
  end if;
  v_got := inv_order_received(new.id);
  if coalesce(new.quantity, 0) < v_got then
    raise exception '% of "%" were already received in Inventory, so the quantity can''t go below that.', inv_fmt(v_got), new.item_name;
  end if;
  if new.arrived_via_inventory and new.arrived_on is not null and coalesce(new.quantity, 0) > v_got then
    new.arrived_on := null; new.arrived_by := null; new.arrived_note := ''; new.arrived_via_inventory := false;  -- more is coming now
  end if;
  return new;
end;
$$;
create trigger inv_guard_order_line before update of quantity or delete on public.request_items
  for each row execute function public.inv_guard_order_line();

-- ===================================================================================================
-- Undo
-- ===================================================================================================

/**
 * Undo an operation with a reversing one (history keeps both). Inventory managers can undo anything; others
 * can undo their own use, return, move, receipt or set-aside within a day. An operation is undone once; an undo
 * isn't undone (record the right thing instead). Undoing a receipt from Orders puts Orders back in step.
 */
create or replace function public.inventory_reverse(p_op uuid, p_target uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_reason text := trim(coalesce(p_reason, ''));
  v_replay jsonb;
  v_t      inventory_ops;
  v_m      inventory_movements;
  v_r      inventory_receipts;
  v_n      int := 0;
begin
  perform inv_require(array['inventory.use', 'inventory.receive', 'inventory.count', 'inventory.manage']);
  if length(v_reason) < 3 then raise exception 'Say why it''s being undone.'; end if;
  v_replay := inv_op_begin(p_op, 'reverse', null, v_reason);
  if v_replay is not null then return v_replay; end if;
  select * into v_t from inventory_ops where id = p_target for update;
  if not found then raise exception 'That transaction doesn''t exist.'; end if;
  if v_t.kind = 'reverse' then raise exception 'An undo can''t be undone. Record the right transaction instead.'; end if;
  if v_t.reversed_by is not null then raise exception 'That was already undone.'; end if;
  if not has_permission('inventory.manage') and (
       v_t.actor_id is distinct from auth.uid() or v_t.created_at < now() - interval '1 day'
       or v_t.kind not in ('consume', 'return', 'transfer', 'receive', 'quarantine', 'order_receipt')) then
    raise exception 'Only an inventory manager can undo this (you can undo your own within a day).' using errcode = '42501';
  end if;
  if exists (select 1 from inventory_movements where returns_op = p_target and kind = 'return' having coalesce(sum(qty), 0) <> 0) then
    raise exception 'Some of it was already put back. Undo that return first.';
  end if;
  update inventory_ops set item_id = v_t.item_id, reverses = p_target where id = p_op;
  perform 1 from inventory_items where id in (select item_id from inventory_movements where op_id = p_target) order by id for update;
  begin
    for v_m in select * from inventory_movements where op_id = p_target and not reversal order by qty desc, id loop
      perform inv_line(p_op, v_m.kind, v_m.item_id, v_m.location_id, v_m.lot_id, v_m.status, -v_m.qty,
        jsonb_build_object('use_for', v_m.use_for, 'division_id', v_m.division_id, 'subsystem_id', v_m.subsystem_id,
          'division_name', v_m.division_name, 'subsystem_name', v_m.subsystem_name, 'project', v_m.project, 'used_by_name', v_m.used_by_name,
          'reason', v_reason, 'receipt_id', v_m.receipt_id, 'count_id', v_m.count_id, 'import_id', v_m.import_id, 'returns_op', v_m.returns_op,
          'reversal', true, 'unit_cost', v_m.unit_cost, 'occurred_on', v_m.occurred_on, 'qty_entered', v_m.qty_entered, 'unit_entered', v_m.unit_entered));
      v_n := v_n + 1;
    end loop;
  exception when sqlstate 'OS422' then
    raise exception 'Can''t undo this: %. Some of it was used or moved since.', sqlerrm using errcode = 'OS422';
  end;
  update inventory_receipts set reversed_at = now(), reversed_by = auth.uid(), reversal_op = p_op
   where op_id = p_target and reversed_at is null returning * into v_r;
  if v_r.request_item_id is not null then
    insert into request_events (request_id, kind, actor_id, actor_name, note)
    values (v_r.request_id, 'inventory', auth.uid(), coalesce(my_display_name(), ''),
            left(format('Receipt of %s × %s undone: %s', inv_fmt(v_r.qty_order), coalesce(nullif(v_r.line_name, ''), 'an item'), v_reason), 1000));
    perform inv_sync_order_line(v_r.request_item_id, current_date, '');
  end if;
  update inventory_ops set reversed_by = p_op where id = p_target;
  return inv_op_end(p_op, jsonb_build_object('reversed', p_target, 'lines', v_n, 'item_id', v_t.item_id)
                         || case when v_t.item_id is not null then inv_totals(v_t.item_id) else '{}'::jsonb end);
end;
$$;

-- ===================================================================================================
-- Counts
-- ===================================================================================================

/**
 * Start a count. p { name, location_ids (their sub-locations too), category_id, count_class, item_ids, due_only }.
 * One line per item / location / lot with the system's quantity now. Stock already in another open count is refused.
 */
create or replace function public.inventory_count_start(p jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_name  text := trim(coalesce(p ->> 'name', ''));
  v_locs  uuid[];
  v_items uuid[];
  v_cat   uuid := nullif(p ->> 'category_id', '')::uuid;
  v_class text := nullif(p ->> 'count_class', '');
  v_due   boolean := coalesce((p ->> 'due_only')::boolean, false);
  v_id    uuid;
  v_n     int;
  v_clash text;
begin
  perform inv_require(array['inventory.count', 'inventory.manage']);
  if v_name = '' then v_name := 'Count ' || to_char(now(), 'YYYY-MM-DD'); end if;
  if jsonb_typeof(p -> 'location_ids') = 'array' and jsonb_array_length(p -> 'location_ids') > 0 then
    with recursive tree(id) as (
      select (x)::uuid from jsonb_array_elements_text(p -> 'location_ids') x
      union select l.id from inventory_locations l join tree t on l.parent_id = t.id
    ) select array_agg(id) into v_locs from tree;
  end if;
  if jsonb_typeof(p -> 'item_ids') = 'array' and jsonb_array_length(p -> 'item_ids') > 0 then
    select array_agg(x::uuid) into v_items from jsonb_array_elements_text(p -> 'item_ids') x;
  end if;
  insert into inventory_counts (name, scope, baseline_seq, blind, started_by, started_by_name)
  values (left(v_name, 120), coalesce(p, '{}'), (select coalesce(max(id), 0) from inventory_movements),
          coalesce((inv_settings() ->> 'blindCounts')::boolean, false), auth.uid(), coalesce(my_display_name(), ''))
  returning id into v_id;
  insert into inventory_count_lines (count_id, item_id, location_id, lot_id, expected)
  select v_id, s.item_id, s.location_id, s.lot_id, s.qty
  from inventory_stock s join inventory_items i on i.id = s.item_id join inventory_locations l on l.id = s.location_id
  where s.status = 'available' and i.status <> 'archived' and l.archived_at is null
    and (s.qty > 0 or s.lot_id is null)
    and (v_locs is null or s.location_id = any(v_locs))
    and (v_items is null or s.item_id = any(v_items))
    and (v_cat is null or i.category_id = v_cat)
    and (v_class is null or i.count_class = v_class)
    and (not v_due or inv_count_due(i));
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'There''s nothing to count there yet.'; end if;
  select string_agg(distinct c.name, '", "') into v_clash
  from inventory_count_lines a join inventory_counts c on c.id = a.count_id and c.status in ('open', 'review') and c.id <> v_id
  join inventory_count_lines b on b.count_id = v_id and b.item_id = a.item_id and b.location_id = a.location_id and b.lot_id is not distinct from a.lot_id;
  if v_clash is not null then
    raise exception 'Some of this is already being counted in "%". Finish or cancel that count first.', v_clash;
  end if;
  return v_id;
end;
$$;

/** Something found during a count that wasn't on its list. p { item_id, location_id, lot_id } */
create or replace function public.inventory_count_add_line(p_count uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_c    inventory_counts;
  v_item inventory_items;
  v_loc  inventory_locations;
  v_lot  uuid := nullif(p ->> 'lot_id', '')::uuid;
  v_id   uuid;
begin
  perform inv_require(array['inventory.count', 'inventory.manage']);
  select * into v_c from inventory_counts where id = p_count for update;
  if not found or v_c.status <> 'open' then raise exception 'That count isn''t open.'; end if;
  select * into v_item from inventory_items where id = nullif(p ->> 'item_id', '')::uuid;
  if not found then raise exception 'Pick the item you found.'; end if;
  v_loc := inv_location(nullif(p ->> 'location_id', '')::uuid, true);
  if v_item.track_lots and v_lot is null then raise exception 'Pick which lot of "%" you found (receive a new lot if it isn''t listed).', v_item.name; end if;
  if v_lot is not null and not exists (select 1 from inventory_lots where id = v_lot and item_id = v_item.id) then
    raise exception 'That lot isn''t for "%".', v_item.name;
  end if;
  select id into v_id from inventory_count_lines where count_id = p_count and item_id = v_item.id and location_id = v_loc.id and lot_id is not distinct from v_lot;
  if v_id is not null then return v_id; end if;
  insert into inventory_count_lines (count_id, item_id, location_id, lot_id, expected, added)
  values (p_count, v_item.id, v_loc.id, v_lot,
          (select coalesce(sum(qty), 0) from inventory_stock where item_id = v_item.id and location_id = v_loc.id and lot_id is not distinct from v_lot and status = 'available'),
          true)
  returning id into v_id;
  return v_id;
end;
$$;

/**
 * Record what was found on one line (p_qty null clears it). The system's quantity at this moment is kept with
 * it, so stock used or moved afterwards isn't mistaken for a difference.
 */
create or replace function public.inventory_count_record(p_line uuid, p_qty numeric, p_note text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_l    inventory_count_lines;
  v_c    inventory_counts;
  v_item inventory_items;
  v_sys  numeric;
begin
  perform inv_require(array['inventory.count', 'inventory.manage']);
  select * into v_l from inventory_count_lines where id = p_line for update;
  if not found then raise exception 'That count line doesn''t exist.'; end if;
  select * into v_c from inventory_counts where id = v_l.count_id;
  if v_c.status <> 'open' then raise exception 'This count was already submitted.'; end if;
  v_item := inv_lock_item(v_l.item_id);
  if p_qty is not null and (p_qty < 0 or p_qty <> round(p_qty, v_item.decimals)) then
    raise exception '"%" is counted in %.', v_item.name,
      case when v_item.decimals = 0 then 'whole ' || v_item.unit else format('%s with at most %s decimal places', v_item.unit, v_item.decimals) end;
  end if;
  select coalesce(sum(qty), 0) into v_sys from inventory_stock
   where item_id = v_l.item_id and location_id = v_l.location_id and lot_id is not distinct from v_l.lot_id and status = 'available';
  update inventory_count_lines set
    counted = p_qty, system_qty = case when p_qty is null then null else v_sys end,
    counted_seq = case when p_qty is null then null else (select coalesce(max(id), 0) from inventory_movements) end,
    counted_at = case when p_qty is null then null else now() end,
    counted_by_name = case when p_qty is null then '' else coalesce(my_display_name(), '') end,
    recount = false, note = left(coalesce(p_note, note), 500)
  where id = p_line;
  return jsonb_build_object('line_id', p_line, 'counted', p_qty, 'system', v_sys, 'difference', p_qty - v_sys);
end;
$$;

/** Ask for a line to be counted again (keeps the first count). Sends a submitted count back to counting. */
create or replace function public.inventory_count_recount(p_line uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_l inventory_count_lines;
begin
  perform inv_require(array['inventory.count', 'inventory.manage']);
  select * into v_l from inventory_count_lines where id = p_line for update;
  if not found then raise exception 'That count line doesn''t exist.'; end if;
  if (select status from inventory_counts where id = v_l.count_id) not in ('open', 'review') then raise exception 'This count is finished.'; end if;
  update inventory_count_lines set first_count = coalesce(first_count, counted), counted = null, system_qty = null, counted_seq = null,
    counted_at = null, counted_by_name = '', recount = true where id = p_line;
  update inventory_counts set status = 'open', submitted_at = null where id = v_l.count_id;
end;
$$;

/**
 * Done counting. Big differences (Setup → Settings: an amount or a percentage, and any difference on a class A
 * item) need an inventory manager to approve the count.
 */
create or replace function public.inventory_count_submit(p_count uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_c     inventory_counts;
  v_s     jsonb := inv_settings();
  v_value numeric := coalesce((v_s ->> 'approvalValue')::numeric, 50);
  v_pct   numeric := coalesce((v_s ->> 'approvalPct')::numeric, 10);
  v_needs boolean;
begin
  perform inv_require(array['inventory.count', 'inventory.manage']);
  select * into v_c from inventory_counts where id = p_count for update;
  if not found or v_c.status <> 'open' then raise exception 'That count isn''t open.'; end if;
  if exists (select 1 from inventory_count_lines where count_id = p_count and recount) then
    raise exception 'Some lines are waiting for a recount.';
  end if;
  if not exists (select 1 from inventory_count_lines where count_id = p_count and counted is not null) then
    raise exception 'Count at least one line first.';
  end if;
  select exists (
    select 1 from inventory_count_lines l join inventory_items i on i.id = l.item_id
    where l.count_id = p_count and l.counted is not null and l.counted <> l.system_qty
      and (i.count_class = 'A'
           or abs(l.counted - l.system_qty) * coalesce(i.unit_cost, 0) >= v_value
           or l.system_qty = 0
           or abs(l.counted - l.system_qty) * 100 / l.system_qty >= v_pct)
  ) into v_needs;
  update inventory_counts set status = 'review', submitted_at = now(), needs_approval = v_needs where id = p_count;
  return jsonb_build_object('needs_approval', v_needs);
end;
$$;

/**
 * Apply a submitted count: each difference becomes a "count" movement of (counted − what the system had when
 * that line was counted), added to today's balance, so anything used or moved since the line was counted stays.
 * All or nothing. Counts that need approval: inventory managers only.
 */
create or replace function public.inventory_count_reconcile(p_op uuid, p_count uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_c      inventory_counts;
  v_l      record;
  v_replay jsonb;
  v_n      int := 0;
begin
  perform inv_require(array['inventory.count', 'inventory.manage']);
  v_replay := inv_op_begin(p_op, 'count', null, '');
  if v_replay is not null then return v_replay; end if;
  select * into v_c from inventory_counts where id = p_count for update;
  if not found or v_c.status <> 'review' then raise exception 'Submit the count before applying it.'; end if;
  if v_c.needs_approval and not has_permission('inventory.manage') then
    raise exception 'An inventory manager needs to approve this count: some differences are large, or on class A items.' using errcode = '42501';
  end if;
  update inventory_ops set note = left('Count: ' || v_c.name, 500) where id = p_op;
  perform 1 from inventory_items where id in (select item_id from inventory_count_lines where count_id = p_count and counted is not null) order by id for update;
  for v_l in
    select l.*, i.name item_name, i.unit_cost, loc.code from inventory_count_lines l
    join inventory_items i on i.id = l.item_id join inventory_locations loc on loc.id = l.location_id
    where l.count_id = p_count and l.counted is not null and l.counted <> l.system_qty order by l.item_id, l.id
  loop
    begin
      perform inv_line(p_op, 'count', v_l.item_id, v_l.location_id, v_l.lot_id, 'available', v_l.counted - v_l.system_qty,
        jsonb_build_object('count_id', p_count, 'unit_cost', v_l.unit_cost,
                           'reason', format('Count "%s": counted %s, system had %s', v_c.name, inv_fmt(v_l.counted), inv_fmt(v_l.system_qty))));
    exception when sqlstate 'OS422' then
      raise exception 'Stock of "%" at % changed after it was counted. Recount that line.', v_l.item_name, v_l.code using errcode = 'OS422';
    end;
    v_n := v_n + 1;
  end loop;
  update inventory_counts set status = 'closed', closed_at = now(), closed_by_name = coalesce(my_display_name(), ''), op_id = p_op where id = p_count;
  return inv_op_end(p_op, jsonb_build_object('count_id', p_count, 'adjusted', v_n));
end;
$$;

create or replace function public.inventory_count_cancel(p_count uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_c inventory_counts;
begin
  perform inv_require(array['inventory.count', 'inventory.manage']);
  select * into v_c from inventory_counts where id = p_count for update;
  if not found or v_c.status not in ('open', 'review') then raise exception 'That count isn''t open.'; end if;
  if v_c.started_by is distinct from auth.uid() and not has_permission('inventory.manage') then
    raise exception 'Only whoever started it or an inventory manager can cancel this count.' using errcode = '42501';
  end if;
  update inventory_counts set status = 'cancelled', closed_at = now(), closed_by_name = coalesce(my_display_name(), '') where id = p_count;
end;
$$;

-- ===================================================================================================
-- Spreadsheet import (all or nothing)
-- ===================================================================================================

/**
 * p { file_name, file_hash, allow_repeat, create_locations, create_categories, rows: [{ row, item_id, sku, name,
 * description, category, unit, decimals, manufacturer, mpn, supplier, supplier_pn, supplier_url, pack_qty, location,
 * location_name, qty, lot, expires_on, reorder_point, reorder_qty, unit_cost, count_class }] }.
 * Rows match an item by item_id (picked in the preview) or SKU; otherwise they make a new one. Every row is
 * checked first: one bad row and nothing is imported (the problems come back in the error's detail).
 * The same file again (same file_hash) is refused (OS410) unless allow_repeat.
 */
create or replace function public.inventory_import(p_op uuid, p jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_rows     jsonb := coalesce(p -> 'rows', '[]');
  v_hash     text := nullif(trim(coalesce(p ->> 'file_hash', '')), '');
  v_mklocs   boolean := coalesce((p ->> 'create_locations')::boolean, false);
  v_mkcats   boolean := coalesce((p ->> 'create_categories')::boolean, false);
  v_replay   jsonb;
  v_row      jsonb;
  v_i        bigint;
  v_label    text;
  v_errors   text[] := '{}';
  v_bad      int := 0;          -- rows with at least one problem
  v_before   int;
  v_new      jsonb := '{}';        -- new items in this file: key → id
  v_key      text;
  v_item     inventory_items;
  v_item_id  uuid;
  v_loc_id   uuid;
  v_cat_id   uuid;
  v_lot      uuid;
  v_qty      numeric;
  v_dec      int;
  v_unit     text;
  v_code     text;
  v_batch    uuid := gen_random_uuid();
  v_created  int := 0;
  v_matched  int := 0;
  v_lines    int := 0;
  v_prev     inventory_import_batches;
begin
  perform inv_require(array['inventory.manage']);
  if jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) = 0 then raise exception 'There are no rows to import.'; end if;
  if jsonb_array_length(v_rows) > 5000 then raise exception 'Import at most 5,000 rows at a time.'; end if;
  v_replay := inv_op_begin(p_op, 'import', null, p ->> 'file_name');
  if v_replay is not null then return v_replay; end if;
  if v_hash is not null and not coalesce((p ->> 'allow_repeat')::boolean, false) then
    select b.* into v_prev from inventory_import_batches b join inventory_ops o on o.id = b.op_id
     where b.file_hash = v_hash and o.reversed_by is null order by b.created_at desc limit 1;
    if v_prev.id is not null then
      raise exception 'This file was already imported (% by %). Import it again only if you mean to add its stock twice.',
        to_char(v_prev.created_at, 'YYYY-MM-DD'), v_prev.created_by_name using errcode = 'OS410';
    end if;
  end if;

  -- 1. Check every row.
  for v_row, v_i in select value, ordinality from jsonb_array_elements(v_rows) with ordinality loop
    v_label := 'Row ' || coalesce(nullif(v_row ->> 'row', ''), v_i::text) || ': ';
    v_before := cardinality(v_errors);
    v_item := null;
    if nullif(v_row ->> 'item_id', '') is not null then
      select * into v_item from inventory_items where id = (v_row ->> 'item_id')::uuid;
      if v_item.id is null then v_errors := v_errors || (v_label || 'the matched item no longer exists'); v_bad := v_bad + 1; continue; end if;
    elsif trim(coalesce(v_row ->> 'sku', '')) <> '' then
      select * into v_item from inventory_items where upper(sku) = upper(trim(v_row ->> 'sku'));
      if v_item.id is null and upper(trim(v_row ->> 'sku')) !~ '^[A-Z0-9][A-Z0-9._/-]{0,31}$' then
        v_errors := v_errors || (v_label || format('SKU "%s" has characters a label can''t use', v_row ->> 'sku'));
      end if;
    end if;
    if v_item.id is null then
      if trim(coalesce(v_row ->> 'name', '')) = '' then v_errors := v_errors || (v_label || 'a new item needs a name'); end if;
      v_unit := coalesce(nullif(lower(trim(v_row ->> 'unit')), ''), 'ea');
      if not exists (select 1 from inventory_units where code = v_unit) then v_errors := v_errors || (v_label || format('unknown unit "%s"', v_row ->> 'unit')); end if;
      v_dec := case when coalesce(v_row ->> 'decimals', '') ~ '^[0-4]$' then (v_row ->> 'decimals')::int
                    when v_unit in ('ea', 'pair', 'set', 'kit', 'roll', 'spool', 'sheet', 'bottle', 'can', 'tube', 'bag', 'box') then 0 else 2 end;
      if trim(coalesce(v_row ->> 'category', '')) <> '' and not v_mkcats
         and not exists (select 1 from inventory_categories where lower(name) = lower(trim(v_row ->> 'category')) and archived_at is null) then
        v_errors := v_errors || (v_label || format('no category called "%s"', v_row ->> 'category'));
      end if;
      if coalesce(v_row ->> 'count_class', '') not in ('', 'A', 'B', 'C') then v_errors := v_errors || (v_label || 'count class must be A, B or C'); end if;
    else
      v_unit := v_item.unit;
      v_dec := v_item.decimals;
      if nullif(lower(trim(v_row ->> 'unit')), '') is not null and lower(trim(v_row ->> 'unit')) <> v_item.unit then
        v_errors := v_errors || (v_label || format('"%s" is kept in %s, not %s', v_item.name, v_item.unit, v_row ->> 'unit'));
      end if;
    end if;
    begin
      v_qty := coalesce(nullif(trim(replace(coalesce(v_row ->> 'qty', ''), ',', '')), '')::numeric, 0);
      if v_qty < 0 then v_errors := v_errors || (v_label || 'the quantity can''t be negative');
      elsif v_qty <> round(v_qty, v_dec) then v_errors := v_errors || (v_label || format('quantity %s has more decimal places than the item keeps (%s)', v_qty, v_dec));
      end if;
    exception when others then
      v_errors := v_errors || (v_label || format('quantity "%s" isn''t a number', v_row ->> 'qty'));
      v_qty := 0;
    end;
    begin
      perform nullif(trim(coalesce(v_row ->> 'reorder_point', '')), '')::numeric, nullif(trim(coalesce(v_row ->> 'reorder_qty', '')), '')::numeric,
              nullif(trim(replace(coalesce(v_row ->> 'unit_cost', ''), '$', '')), '')::numeric, nullif(trim(coalesce(v_row ->> 'pack_qty', '')), '')::numeric;
    exception when others then v_errors := v_errors || (v_label || 'reorder point, reorder quantity, pack size and cost must be numbers');
    end;
    begin
      perform nullif(trim(coalesce(v_row ->> 'expires_on', '')), '')::date;
    exception when others then v_errors := v_errors || (v_label || format('"%s" isn''t a date (use YYYY-MM-DD)', v_row ->> 'expires_on'));
    end;
    if v_qty > 0 then
      v_code := upper(regexp_replace(trim(coalesce(v_row ->> 'location', '')), '\s+', '-', 'g'));
      if v_code = '' then v_errors := v_errors || (v_label || 'say where the stock is (a location code)');
      elsif not exists (select 1 from inventory_locations where code = v_code and archived_at is null) then
        if not v_mklocs then v_errors := v_errors || (v_label || format('no location with the code %s', v_code));
        elsif v_code !~ '^[A-Z0-9][A-Z0-9._-]{0,23}$' then v_errors := v_errors || (v_label || format('"%s" can''t be a location code', v_row ->> 'location'));
        end if;
      end if;
    end if;
    if (trim(coalesce(v_row ->> 'lot', '')) <> '' or trim(coalesce(v_row ->> 'expires_on', '')) <> '') and v_item.id is not null and not v_item.track_lots then
      v_errors := v_errors || (v_label || format('"%s" isn''t tracked by lot; turn that on first or leave lot and expiry blank', v_item.name));
    end if;
    if cardinality(v_errors) > v_before then v_bad := v_bad + 1; end if;
  end loop;
  if cardinality(v_errors) > 0 then
    raise exception '% row% with problems, so nothing was imported.', v_bad, case when v_bad = 1 then '' else 's' end
      using detail = array_to_string(v_errors[1:100], E'\n');
  end if;

  -- 2. Import.
  update inventory_ops set note = left('Import: ' || coalesce(p ->> 'file_name', ''), 500) where id = p_op;
  insert into inventory_import_batches (id, op_id, file_name, file_hash, row_count, created_by, created_by_name)
  values (v_batch, p_op, left(coalesce(p ->> 'file_name', ''), 200), v_hash, jsonb_array_length(v_rows), auth.uid(), coalesce(my_display_name(), ''));
  for v_row, v_i in select value, ordinality from jsonb_array_elements(v_rows) with ordinality loop
    v_item_id := nullif(v_row ->> 'item_id', '')::uuid;
    if v_item_id is null and trim(coalesce(v_row ->> 'sku', '')) <> '' then
      select id into v_item_id from inventory_items where upper(sku) = upper(trim(v_row ->> 'sku'));
    end if;
    v_key := coalesce(nullif(upper(trim(v_row ->> 'sku')), ''), lower(trim(v_row ->> 'name')) || '|' || inv_norm(v_row ->> 'mpn'));
    if v_item_id is null and v_new ? v_key then v_item_id := (v_new ->> v_key)::uuid; end if;
    if v_item_id is null then
      v_cat_id := null;
      if trim(coalesce(v_row ->> 'category', '')) <> '' then
        select id into v_cat_id from inventory_categories where lower(name) = lower(trim(v_row ->> 'category')) and archived_at is null;
        if v_cat_id is null then
          insert into inventory_categories (name) values (left(trim(v_row ->> 'category'), 80)) returning id into v_cat_id;
        end if;
      end if;
      v_unit := coalesce(nullif(lower(trim(v_row ->> 'unit')), ''), 'ea');
      insert into inventory_items (sku, name, description, category_id, manufacturer, mpn, unit, decimals, reorder_point, reorder_qty, unit_cost,
                                   count_class, track_lots, created_by, updated_by)
      values (coalesce(nullif(upper(trim(v_row ->> 'sku')), ''), (select 'INV-' || lpad(nextval('inventory_sku_seq')::text, 5, '0'))),
              left(regexp_replace(trim(v_row ->> 'name'), '\s+', ' ', 'g'), 120), left(coalesce(v_row ->> 'description', ''), 2000), v_cat_id,
              left(trim(coalesce(v_row ->> 'manufacturer', '')), 120), left(trim(coalesce(v_row ->> 'mpn', '')), 80), v_unit,
              case when coalesce(v_row ->> 'decimals', '') ~ '^[0-4]$' then (v_row ->> 'decimals')::int
                   when v_unit in ('ea', 'pair', 'set', 'kit', 'roll', 'spool', 'sheet', 'bottle', 'can', 'tube', 'bag', 'box') then 0 else 2 end,
              nullif(trim(coalesce(v_row ->> 'reorder_point', '')), '')::numeric, nullif(trim(coalesce(v_row ->> 'reorder_qty', '')), '')::numeric,
              nullif(trim(replace(coalesce(v_row ->> 'unit_cost', ''), '$', '')), '')::numeric, coalesce(nullif(v_row ->> 'count_class', ''), 'C'),
              trim(coalesce(v_row ->> 'lot', '')) <> '' or trim(coalesce(v_row ->> 'expires_on', '')) <> '', auth.uid(), auth.uid())
      returning id into v_item_id;
      v_new := v_new || jsonb_build_object(v_key, v_item_id);
      v_created := v_created + 1;
    elsif not (v_new ? v_key and v_new ->> v_key = v_item_id::text) then
      v_matched := v_matched + 1;
    end if;
    if trim(coalesce(v_row ->> 'supplier', '')) <> '' then
      insert into inventory_supplier_parts (item_id, supplier, supplier_pn, url, pack_qty)
      values (v_item_id, left(trim(v_row ->> 'supplier'), 80), left(trim(coalesce(v_row ->> 'supplier_pn', '')), 80),
              case when coalesce(v_row ->> 'supplier_url', '') ~ '^https?://\S+$' then v_row ->> 'supplier_url' else '' end,
              coalesce(nullif(trim(coalesce(v_row ->> 'pack_qty', '')), '')::numeric, 1))
      on conflict do nothing;
    end if;
    v_qty := coalesce(nullif(trim(replace(coalesce(v_row ->> 'qty', ''), ',', '')), '')::numeric, 0);
    if v_qty > 0 then
      v_code := upper(regexp_replace(trim(v_row ->> 'location'), '\s+', '-', 'g'));
      select id into v_loc_id from inventory_locations where code = v_code and archived_at is null;
      if v_loc_id is null then
        insert into inventory_locations (code, name, created_by)
        values (v_code, left(coalesce(nullif(trim(v_row ->> 'location_name'), ''), v_code), 80), auth.uid()) returning id into v_loc_id;
      end if;
      v_item := inv_lock_item(v_item_id);
      v_lot := null;
      if v_item.track_lots then
        v_lot := inv_resolve_lot(v_item, jsonb_build_object('lot', jsonb_build_object(
                   'lot_code', coalesce(nullif(trim(v_row ->> 'lot'), ''), 'imported'), 'expires_on', nullif(trim(v_row ->> 'expires_on'), ''))), true, current_date);
      end if;
      perform inv_line(p_op, 'import', v_item_id, v_loc_id, v_lot, 'available', v_qty,
                       jsonb_build_object('import_id', v_batch, 'unit_cost', v_item.unit_cost,
                                          'reason', left('Import: ' || coalesce(p ->> 'file_name', '') || ' row ' || coalesce(v_row ->> 'row', v_i::text), 500)));
      v_lines := v_lines + 1;
    end if;
  end loop;
  update inventory_import_batches set items_created = v_created, items_matched = v_matched, stock_lines = v_lines where id = v_batch;
  return inv_op_end(p_op, jsonb_build_object('batch_id', v_batch, 'items_created', v_created, 'items_matched', v_matched, 'stock_lines', v_lines));
end;
$$;

-- ===================================================================================================
-- Reading: the overview (catalog, low stock, expiry, counts due) and usage reports
-- ===================================================================================================

/**
 * Every item with its totals: on hand, available (not set aside, not in an expired or bad lot), set aside,
 * unusable, on order (linked Orders lines on Ordered requests, not yet received), requested (linked lines on
 * requests not ordered yet: not counted as coming), last counted and whether a count is due.
 * Plus lots expiring soon and how many ordered lines are waiting to be received. One JSON object, so it's never
 * cut off at the API's row limit.
 */
create or replace function public.inventory_overview()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_s     jsonb := inv_settings();
  v_warn  int := coalesce((v_s ->> 'expiryWarnDays')::int, 30);
  v_items jsonb;
  v_lots  jsonb;
  v_lines int;
begin
  perform inv_require(array['inventory.view', 'inventory.use', 'inventory.receive', 'inventory.count', 'inventory.manage']);
  select coalesce(jsonb_agg(to_jsonb(x) order by x.name), '[]') into v_items from (
    select i.id, i.sku, i.name, i.category_id, i.manufacturer, i.mpn, i.unit, i.decimals, i.status, i.reorder_point, i.reorder_qty,
           i.unit_cost, i.count_class, i.track_lots, i.hazardous, i.default_location_id, i.image_url, i.description,
           coalesce(s.on_hand, 0) on_hand, coalesce(s.available, 0) available, coalesce(s.quarantined, 0) quarantined,
           coalesce(s.unusable, 0) unusable, coalesce(s.locations, 0) locations,
           coalesce(o.on_order, 0) on_order, coalesce(o.requested, 0) requested,
           lc.last_counted,
           lc.last_counted is null or lc.last_counted < now() - make_interval(days => coalesce((v_s -> 'countDays' ->> i.count_class)::int, 180)) count_due,
           (select min(l.expires_on) from inventory_lots l where l.item_id = i.id
              and exists (select 1 from inventory_stock st where st.lot_id = l.id and st.qty > 0)) next_expiry
    from inventory_items i
    left join lateral (
      select sum(st.qty) on_hand,
             sum(st.qty) filter (where st.status = 'available' and (st.lot_id is null or inv_lot_problem(l) is null)) available,
             sum(st.qty) filter (where st.status = 'quarantine') quarantined,
             sum(st.qty) filter (where st.status = 'available' and st.lot_id is not null and inv_lot_problem(l) is not null) unusable,
             count(distinct st.location_id) filter (where st.qty > 0) locations
      from inventory_stock st left join inventory_lots l on l.id = st.lot_id where st.item_id = i.id
    ) s on true
    left join lateral (
      select sum(greatest(coalesce(ri.quantity, 0) - coalesce(g.got, 0), 0) * lk.units_per) filter (where r.status = 'Ordered') on_order,
             sum(coalesce(ri.quantity, 0) * lk.units_per) filter (where r.status in ('Submitted', 'Approved')) requested
      from inventory_order_links lk
      join request_items ri on ri.id = lk.request_item_id
      join requests r on r.id = ri.request_id
      left join lateral (select sum(rc.qty_order) got from inventory_receipts rc where rc.request_item_id = ri.id and rc.reversed_at is null) g on true
      where lk.item_id = i.id
    ) o on true
    left join lateral (select inv_last_counted(i.id) last_counted) lc on true
    where i.status <> 'archived' or coalesce(s.on_hand, 0) > 0
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object('lot_id', l.id, 'item_id', l.item_id, 'lot', inv_lot_label(l), 'expires_on', l.expires_on,
                                               'retest_on', l.retest_on, 'condition', l.condition, 'qty', q.qty, 'problem', inv_lot_problem(l))
                            order by least(l.expires_on, l.retest_on) nulls last), '[]')
  into v_lots
  from inventory_lots l
  join lateral (select sum(st.qty) qty from inventory_stock st where st.lot_id = l.id) q on q.qty > 0
  where l.condition <> 'good' or l.expires_on <= current_date + v_warn or l.retest_on <= current_date + v_warn;

  select count(*) into v_lines from request_items ri join requests r on r.id = ri.request_id
  where r.status = 'Ordered' and coalesce(ri.quantity, 0) > inv_order_received(ri.id) and ri.arrived_on is null;

  return jsonb_build_object('items', v_items, 'lots', v_lots, 'waitingLines', v_lines, 'today', current_date, 'settings', v_s);
end;
$$;

/**
 * What was used, for reports: net of returns (and of undone lines), from p_from to p_to (dates, inclusive; null =
 * open). Moving stock between locations isn't use. Grouped by the CE division and subsystem recorded at the time
 * (shown with today's names), item, person, project and month. Also lines from Orders received straight to a
 * subsystem that aren't catalog items (item_id null). cost is estimated from known unit costs (cost_known false
 * when some weren't known). One JSON list (not rows), so a long history is never cut off at the API's row limit:
 * [{ division_id, division_name, subsystem_id, subsystem_name, use_for, item_id, sku, item_name, unit, used_by, project,
 *    month, qty, cost, cost_known, lines }]
 */
create or replace function public.inventory_usage(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v jsonb;
begin
  perform inv_require(array['inventory.view', 'inventory.use', 'inventory.receive', 'inventory.count', 'inventory.manage']);
  select coalesce(jsonb_agg(to_jsonb(u) order by u.month, u.division_name, u.subsystem_name, u.item_name), '[]') into v
  from (
  select m.division_id, coalesce(d.name, m.division_name), m.subsystem_id, coalesce(s.name, m.subsystem_name), m.use_for,
         m.item_id, i.sku, i.name, i.unit, nullif(m.used_by_name, ''), m.project, to_char(m.occurred_on, 'YYYY-MM'),
         sum(-m.qty), sum(-m.qty * coalesce(m.unit_cost, i.unit_cost)), bool_and(coalesce(m.unit_cost, i.unit_cost) is not null), count(*)::int
  from inventory_movements m
  join inventory_items i on i.id = m.item_id
  left join org_divisions d on d.id = m.division_id
  left join org_subsystems s on s.id = m.subsystem_id
  where m.kind in ('consume', 'return', 'direct_use')
    and m.occurred_on >= coalesce(p_from, '-infinity'::date) and m.occurred_on <= coalesce(p_to, 'infinity'::date)
  group by m.division_id, coalesce(d.name, m.division_name), m.subsystem_id, coalesce(s.name, m.subsystem_name), m.use_for,
           m.item_id, i.sku, i.name, i.unit, nullif(m.used_by_name, ''), m.project, to_char(m.occurred_on, 'YYYY-MM')
  having sum(m.qty) <> 0
  union all
  select r.division_id, coalesce(d.name, r.division_name), r.subsystem_id, coalesce(s.name, r.subsystem_name), r.use_for,
         null::uuid, null::text, r.line_name || ' (' || r.order_ref || ')', 'ordered', nullif(r.actor_name, ''), r.project, to_char(r.received_on, 'YYYY-MM'),
         sum(r.qty_order), sum(r.qty_order * r.line_price), bool_and(r.line_price is not null), count(*)::int
  from inventory_receipts r
  left join org_divisions d on d.id = r.division_id
  left join org_subsystems s on s.id = r.subsystem_id
  where r.destination = 'direct' and r.item_id is null and r.reversed_at is null
    and r.received_on >= coalesce(p_from, '-infinity'::date) and r.received_on <= coalesce(p_to, 'infinity'::date)
  group by r.division_id, coalesce(d.name, r.division_name), r.subsystem_id, coalesce(s.name, r.subsystem_name), r.use_for,
           r.line_name, r.order_ref, nullif(r.actor_name, ''), r.project, to_char(r.received_on, 'YYYY-MM')
  ) u(division_id, division_name, subsystem_id, subsystem_name, use_for, item_id, sku, item_name, unit, used_by, project, month, qty, cost, cost_known, lines);
  return v;
end;
$$;

-- ---- what the website may call --------------------------------------------------------------------
revoke execute on function
  public.inv_require(text[]), public.inv_fmt(numeric), public.inv_norm(text), public.inv_num(jsonb, text),
  public.inv_lock_item(uuid), public.inv_location(uuid, boolean), public.inv_qty(public.inventory_items, numeric, text),
  public.inv_lot_problem(public.inventory_lots), public.inv_lot_label(public.inventory_lots),
  public.inv_resolve_lot(public.inventory_items, jsonb, boolean, date), public.inv_attribution(text, uuid, uuid),
  public.inv_bucket(uuid, uuid, uuid, text, numeric), public.inv_line(uuid, text, uuid, uuid, uuid, text, numeric, jsonb),
  public.inv_op_begin(uuid, text, uuid, text), public.inv_op_end(uuid, jsonb), public.inv_totals(uuid), public.inv_remember(jsonb, text),
  public.inv_settings(), public.inv_last_counted(uuid), public.inv_count_due(public.inventory_items), public.inv_order_received(uuid),
  public.inv_sync_order_line(uuid, date, text), public.inv_audit(), public.inv_guard_order_line(), public.inv_history_is_permanent()
from public, anon, authenticated;

revoke execute on function public.inv_can_view() from public, anon;
grant execute on function public.inv_can_view() to authenticated;   -- the read policies use it

do $$
declare f text;
begin
  foreach f in array array[
    'org_save_division(uuid, text, int)', 'org_archive_division(uuid, boolean)', 'org_save_subsystem(uuid, uuid, text, int)',
    'org_archive_subsystem(uuid, boolean)', 'org_reorder(text, uuid[])', 'org_copy_from_evals()', 'org_add_subsystems(uuid, text[])',
    'inventory_save_category(uuid, text, uuid)', 'inventory_archive_category(uuid, boolean)', 'inventory_save_location(uuid, jsonb)',
    'inventory_archive_location(uuid, boolean)', 'inventory_find_matches(jsonb)', 'inventory_save_item(uuid, jsonb)',
    'inventory_set_count_classes(jsonb)', 'inventory_save_supplier_part(uuid, uuid, jsonb)', 'inventory_delete_supplier_part(uuid)',
    'inventory_save_lot(uuid, jsonb)', 'inventory_save_settings(jsonb)', 'inventory_receive(uuid, jsonb)', 'inventory_consume(uuid, jsonb)',
    'inventory_return(uuid, jsonb)', 'inventory_transfer(uuid, jsonb)', 'inventory_adjust(uuid, jsonb)', 'inventory_quarantine(uuid, jsonb)',
    'inventory_link_order_line(uuid, uuid, numeric)', 'inventory_receive_order(uuid, jsonb)', 'inventory_order_lines(uuid, boolean)',
    'inventory_reverse(uuid, uuid, text)', 'inventory_count_start(jsonb)', 'inventory_count_add_line(uuid, jsonb)',
    'inventory_count_record(uuid, numeric, text)', 'inventory_count_recount(uuid)', 'inventory_count_submit(uuid)',
    'inventory_count_reconcile(uuid, uuid)', 'inventory_count_cancel(uuid)', 'inventory_import(uuid, jsonb)', 'inventory_overview()',
    'inventory_usage(date, date)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$$;

select public.migration_done(50, '050_inventory.sql');
