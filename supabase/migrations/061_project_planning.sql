select public.migration_begin(61);

-- =============================================================================
-- 061: Projects planning: team dates, parts reserved from Inventory, and "order it in time" warnings
-- =============================================================================
--
--   * Team dates (pm_key_dates): competitions, design reviews, "car done"... One list for the whole team,
--     drawn as lines on every project's timeline. Whoever can manage Projects (projects.manage) keeps it.
--   * Parts from Inventory: an item's linked Inventory part can say how many it needs (pm_refs.qty). While the
--     item isn't done, that many are reserved: Inventory shows them next to what's available, and the item
--     shows when there aren't enough left for it.
--   * Order in time: an item linked to an Orders request that isn't ordered yet, starting within the project's
--     warning window (settings "order_lead_days", 7 days if not set) or already started, is a warning on the
--     project's timeline and Summary, and its owner and the project manager are told (at most every 3 days).
--     It runs with the timed work (pm_run_scheduled), so with the optional cron job too.
-- =============================================================================

-- ---- team dates --------------------------------------------------------------------------------
create table public.pm_key_dates (
  id          uuid primary key default gen_random_uuid(),
  day         date not null,
  end_day     date,
  name        text not null check (length(trim(name)) between 1 and 120),
  kind        text not null default 'milestone' check (kind in ('competition', 'review', 'deadline', 'milestone', 'break')),
  note        text not null default '' check (length(note) <= 500),
  created_by  uuid references public.profiles(id) on delete set null,
  updated_at  timestamptz not null default now(),
  check (end_day is null or end_day >= day)
);
create index pm_key_dates_day_idx on public.pm_key_dates (day);
alter table public.pm_key_dates enable row level security;
create policy "projects readers" on public.pm_key_dates for select to authenticated using (pm_can_open());
revoke all on public.pm_key_dates from anon, authenticated;
grant select on public.pm_key_dates to authenticated;

/** Add (p_id null) or change a team date. */
create or replace function public.pm_save_key_date(p_id uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  perform require_permission('projects.manage');
  if p_id is null then
    insert into pm_key_dates (day, end_day, name, kind, note, created_by)
    values ((p ->> 'day')::date, nullif(p ->> 'end_day', '')::date, trim(p ->> 'name'), coalesce(nullif(p ->> 'kind', ''), 'milestone'),
            coalesce(p ->> 'note', ''), auth.uid())
    returning id into v_id;
  else
    update pm_key_dates set day = (p ->> 'day')::date, end_day = nullif(p ->> 'end_day', '')::date, name = trim(p ->> 'name'),
      kind = coalesce(nullif(p ->> 'kind', ''), 'milestone'), note = coalesce(p ->> 'note', ''), updated_at = now()
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'That date isn''t there any more.'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.pm_delete_key_date(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('projects.manage');
  delete from pm_key_dates where id = p_id;
end;
$$;
revoke execute on function public.pm_save_key_date(uuid, jsonb), public.pm_delete_key_date(uuid) from public, anon;
grant execute on function public.pm_save_key_date(uuid, jsonb), public.pm_delete_key_date(uuid) to authenticated;

-- ---- parts reserved from Inventory ---------------------------------------------------------------
alter table public.pm_refs add column qty numeric check (qty is null or qty > 0);

/** How many of a linked Inventory part the item needs (null: not said, nothing reserved). */
create or replace function public.pm_set_ref_qty(p_ref uuid, p_qty numeric)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v pm_refs; o pm_items;
begin
  select * into v from pm_refs where id = p_ref;
  if v.id is null then raise exception 'That link isn''t there any more.'; end if;
  if v.kind <> 'inventory' then raise exception 'Only Inventory parts have a quantity.'; end if;
  if p_qty is not null and p_qty <= 0 then raise exception 'Enter a quantity above 0, or leave it empty.'; end if;
  select * into o from pm_items where id = v.item_id;
  perform pmx_need(o.project_id, 'view');
  if not pmx_may_edit(o) then perform pmx_need(o.project_id, 'edit'); end if;
  update pm_refs set qty = p_qty where id = p_ref;
  perform pmx_log(o.project_id, o.id, 'link', case when p_qty is null then 'Stopped reserving ' || v.label
    else 'Needs ' || trim(to_char(p_qty, 'FM999999990.###')) || ' of ' || v.label end, '{}');
end;
$$;
revoke execute on function public.pm_set_ref_qty(uuid, numeric) from public, anon;
grant execute on function public.pm_set_ref_qty(uuid, numeric) to authenticated;

/**
 * What open project items have reserved of an Inventory item: { total, items: [{ qty, key, title, project,
 * start, due, ref }] }. Items in projects the caller can't see show only as "a private project".
 */
create or replace function public.inventory_reserved(p_items uuid[])
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_seen uuid[] := pm_visible();
begin
  if not (inv_can_view() or pm_can_open()) then return '{}'::jsonb; end if;
  return coalesce((
    select jsonb_object_agg(item, jsonb_build_object('total', total, 'items', list))
    from (
      select f.ref_id item, sum(f.qty) total,
             jsonb_agg(jsonb_build_object('qty', f.qty, 'ref', f.id,
               'key', case when p.id = any(v_seen) then i.key end, 'title', case when p.id = any(v_seen) then i.title end,
               'project', case when p.id = any(v_seen) then p.name else 'A private project' end,
               'start', i.start_date, 'due', i.due_date) order by coalesce(i.start_date, i.due_date) nulls last) list
      from pm_refs f
      join pm_items i on i.id = f.item_id and i.archived_at is null and i.category <> 'done'
      join pm_projects p on p.id = i.project_id and p.archived_at is null
      where f.kind = 'inventory' and f.qty is not null and f.ref_id = any(p_items)
      group by f.ref_id
    ) q), '{}'::jsonb);
end;
$$;
revoke execute on function public.inventory_reserved(uuid[]) from public, anon;
grant execute on function public.inventory_reserved(uuid[]) to authenticated;

-- ---- order it in time ---------------------------------------------------------------------------
/** The project's open items waiting on an Orders request that isn't ordered, starting within its window. */
create or replace function public.pm_order_warnings(p_project uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('item', i.id, 'key', i.key, 'title', i.title, 'start', coalesce(i.start_date, i.due_date),
           'request', r.id, 'number', r.request_number, 'status', r.status, 'request_title', r.title)
         order by coalesce(i.start_date, i.due_date), i.key), '[]'::jsonb)
  from pm_projects p
  join pm_items i on i.project_id = p.id and i.archived_at is null and i.category <> 'done'
  join pm_refs f on f.item_id = i.id and f.kind = 'order'
  join requests r on r.id = f.ref_id
  where p.id = p_project and p.id = any(pm_visible())
    and r.status not in ('Ordered', 'Received')
    and coalesce(i.start_date, i.due_date) <= current_date + coalesce((p.settings ->> 'order_lead_days')::int, 7);
$$;
revoke execute on function public.pm_order_warnings(uuid) from public, anon;
grant execute on function public.pm_order_warnings(uuid) to authenticated;

create table public.pm_order_alerts (
  item_id  uuid not null references public.pm_items(id) on delete cascade,
  ref_id   uuid not null,
  sent_at  timestamptz not null default now(),
  primary key (item_id, ref_id)
);
alter table public.pm_order_alerts enable row level security;
revoke all on public.pm_order_alerts from anon, authenticated;

/** Tell owners and project managers about items whose order isn't placed in time (each one every 3 days at most). */
create or replace function public.pmx_order_alerts()
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare r record; v_n int := 0;
begin
  for r in
    select i.id item, i.owner_id, p.lead_id, f.ref_id, rq.request_number, rq.status, coalesce(i.start_date, i.due_date) as starts
    from pm_items i
    join pm_projects p on p.id = i.project_id and p.archived_at is null
    join pm_refs f on f.item_id = i.id and f.kind = 'order'
    join requests rq on rq.id = f.ref_id
    where i.archived_at is null and i.category <> 'done' and rq.status not in ('Ordered', 'Received')
      and coalesce(i.start_date, i.due_date) <= current_date + coalesce((p.settings ->> 'order_lead_days')::int, 7)
      and not exists (select 1 from pm_order_alerts a where a.item_id = i.id and a.ref_id = f.ref_id and a.sent_at > now() - interval '3 days')
    limit 300
  loop
    perform pmx_notify(array_remove(array[r.owner_id, r.lead_id], null), 'dependency', r.item,
      'Order not placed: ' || r.request_number,
      r.request_number || ' is ' || r.status || ', and this ' || case when r.starts < current_date then 'started ' else 'starts ' end
        || to_char(r.starts, 'Mon DD') || '.');
    insert into pm_order_alerts (item_id, ref_id) values (r.item, r.ref_id)
    on conflict (item_id, ref_id) do update set sent_at = now();
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke execute on function public.pmx_order_alerts() from public, anon, authenticated;

-- the timed work (051) runs the order warnings too: same gate, same cron job
alter function public.pm_run_scheduled() rename to pmx_run_scheduled_base;
revoke execute on function public.pmx_run_scheduled_base() from public, anon, authenticated;
create or replace function public.pm_run_scheduled()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v jsonb := pmx_run_scheduled_base(); v_n int;
begin
  if coalesce((v ->> 'ran')::boolean, false) is false then return v; end if;
  perform set_config('pm.system', '1', true);
  v_n := pmx_order_alerts();
  perform set_config('pm.system', '', true);
  return v || jsonb_build_object('order_alerts', v_n);
end;
$$;
revoke execute on function public.pm_run_scheduled() from public, anon;
grant execute on function public.pm_run_scheduled() to authenticated;

select public.migration_done(61, '061_project_planning.sql');
