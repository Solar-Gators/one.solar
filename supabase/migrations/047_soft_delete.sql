select public.migration_begin(47);

-- 047: deleting a sponsor card or a Finances record can be undone (I-5).
--
--   * deleted_records: a copy of what was deleted, with everything deleted along with it (a card's
--     activity, watchers and files; a custom sheet's rows and their files; a purchase's files), who
--     deleted it and when. The delete functions write it just before they delete; the function names and
--     arguments are unchanged, so pages that call them don't change.
--   * restore_deleted_record(id): puts it back as it was, with the same id, so links and files work again.
--     People who have since left are dropped from it (watchers) or blanked (owner), never invented.
--   * Readable by people who can edit that area: "Edit sponsors" for sponsor cards, "Edit Finances" for
--     the rest. Sponsors → Recently deleted and Finances → Recently deleted list the last 90 days.
--   * Files in storage were never removed by a delete, so restoring the rows brings the files back.
--   * An empty purchase line (no description, no amount) isn't kept: Finances deletes those itself.

create table if not exists public.deleted_records (
  id               bigserial primary key,
  kind             text not null check (kind in ('sponsor_card', 'finance_sheet', 'finance_row', 'purchase', 'fund')),
  record_id        uuid not null,
  label            text not null default '',     -- what it was called, for the list
  season           text not null default '',
  snapshot         jsonb not null,               -- the row itself
  children         jsonb not null default '{}',  -- { table: [rows] } deleted along with it
  deleted_by       uuid references public.profiles(id) on delete set null,
  deleted_by_name  text not null default '',
  deleted_at       timestamptz not null default now(),
  restored_at      timestamptz,
  restored_by_name text not null default ''
);
create index if not exists deleted_records_recent_idx on public.deleted_records (kind, deleted_at desc);

alter table public.deleted_records enable row level security;
drop policy if exists "editors read" on public.deleted_records;
create policy "editors read" on public.deleted_records for select to authenticated using (
  public.is_member() and (
    (kind = 'sponsor_card' and public.has_permission('sponsors.edit'))
    or (kind <> 'sponsor_card' and public.has_permission('finances.edit'))
  ));
revoke all on public.deleted_records from anon, authenticated;
grant select on public.deleted_records to authenticated;

-- ---------------------------------------------------------------------------
-- Keeping a copy
-- ---------------------------------------------------------------------------
create or replace function public.keep_deleted(p_kind text, p_id uuid, p_label text, p_season text, p_snapshot jsonb, p_children jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_snapshot is null then return; end if;  -- nothing there: nothing to keep
  insert into deleted_records (kind, record_id, label, season, snapshot, children, deleted_by, deleted_by_name)
  values (p_kind, p_id, coalesce(p_label, ''), coalesce(p_season, ''), p_snapshot, coalesce(p_children, '{}'), auth.uid(), my_display_name());
end;
$$;

/** Rows of `p_table` where `p_column` = p_id, as a jsonb array ('[]' when none). */
create or replace function public.rows_as_json(p_table text, p_column text, p_ids uuid[])
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v jsonb;
begin
  execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]'') from public.%I t where t.%I = any($1)', p_table, p_column)
    into v using p_ids;
  return v;
end;
$$;

create or replace function public.delete_sponsor_card(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare c sponsor_cards;
begin
  perform require_permission('sponsors.edit');
  select * into c from sponsor_cards where id = p_id;
  if found then
    perform keep_deleted('sponsor_card', c.id, c.name, c.season, to_jsonb(c), jsonb_build_object(
      'sponsor_activity', rows_as_json('sponsor_activity', 'card_id', array[c.id]),
      'sponsor_watchers', rows_as_json('sponsor_watchers', 'card_id', array[c.id]),
      'attachments',      rows_as_json('attachments', 'sponsor_card_id', array[c.id]),
      'linked_finance_rows', (select coalesce(jsonb_agg(id), '[]') from finance_rows where sponsor_card_id = c.id)));
  end if;
  delete from sponsor_cards where id = p_id;
end;
$$;

create or replace function public.delete_finance_sheet(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare s finance_sheets; v_rows uuid[];
begin
  perform require_permission('finances.edit');
  select * into s from finance_sheets where id = p_id;
  if found then
    select coalesce(array_agg(id), '{}') into v_rows from finance_rows where sheet_id = s.id;
    perform keep_deleted('finance_sheet', s.id, s.name, coalesce(to_jsonb(s) ->> 'season', ''), to_jsonb(s), jsonb_build_object(
      'finance_rows', rows_as_json('finance_rows', 'sheet_id', array[s.id]),
      'attachments',  rows_as_json('attachments', 'finance_row_id', v_rows)));
  end if;
  delete from finance_sheets where id = p_id;
end;
$$;

create or replace function public.delete_finance_rows(p_ids uuid[])
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare r finance_rows; v_sheet text;
begin
  perform require_permission('finances.edit');
  for r in select * from finance_rows where id = any(p_ids) loop
    select name into v_sheet from finance_sheets where id = r.sheet_id;
    perform keep_deleted('finance_row', r.id, coalesce(v_sheet, 'Sheet') || ' row', '', to_jsonb(r),
      jsonb_build_object('attachments', rows_as_json('attachments', 'finance_row_id', array[r.id])));
  end loop;
  delete from finance_rows where id = any(p_ids);
end;
$$;

create or replace function public.delete_purchase(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare p finance_purchases;
begin
  perform require_permission('finances.edit');
  if exists (select 1 from finance_purchases where id = p_id and request_id is not null) then
    raise exception 'This line comes from a request. Open the request to change it.';
  end if;
  select * into p from finance_purchases where id = p_id;
  if found and (coalesce(trim(p.description), '') <> '' or p.amount is not null) then
    perform keep_deleted('purchase', p.id, coalesce(nullif(trim(p.description), ''), 'Purchase'), p.season, to_jsonb(p),
      jsonb_build_object('attachments', rows_as_json('attachments', 'finance_purchase_id', array[p.id])));
  end if;
  delete from finance_purchases where id = p_id;
end;
$$;

create or replace function public.delete_fund(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare f finance_funds;
begin
  perform require_permission('finances.edit');
  select * into f from finance_funds where id = p_id;
  if found then
    perform keep_deleted('fund', f.id, coalesce(nullif(trim(f.name), ''), 'Funding source'), f.season, to_jsonb(f), '{}');
  end if;
  delete from finance_funds where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Putting it back
-- ---------------------------------------------------------------------------
-- A copied row with links to things that are gone since (a person who left, a deleted request or card)
-- blanked, so putting it back never fails on them and never points somewhere wrong.
create or replace function public.fix_refs(p_row jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v jsonb := p_row;
  k text;
begin
  foreach k in array array['owner_id', 'created_by', 'updated_by', 'uploaded_by', 'actor_id'] loop
    if v ->> k is not null and not exists (select 1 from profiles where id = (v ->> k)::uuid) then v := jsonb_set(v, array[k], 'null'); end if;
  end loop;
  if v ->> 'request_id' is not null and not exists (select 1 from requests where id = (v ->> 'request_id')::uuid) then v := jsonb_set(v, '{request_id}', 'null'); end if;
  foreach k in array array['sponsor_card_id', 'renewed_from'] loop
    if v ->> k is not null and not exists (select 1 from sponsor_cards where id = (v ->> k)::uuid) then v := jsonb_set(v, array[k], 'null'); end if;
  end loop;
  return v;
end;
$$;

-- The same, for each row of a jsonb array.
create or replace function public.fix_refs_all(p_rows jsonb)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(public.fix_refs(x)), '[]') from jsonb_array_elements(coalesce(p_rows, '[]')) x
$$;

create or replace function public.restore_deleted_record(p_id bigint)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  d deleted_records;
begin
  select * into d from deleted_records where id = p_id for update;
  if not found then raise exception 'That deleted item is no longer kept.'; end if;
  perform require_permission(case when d.kind = 'sponsor_card' then 'sponsors.edit' else 'finances.edit' end);
  if d.restored_at is not null then
    raise exception '% was already restored by % on %.', d.label, coalesce(nullif(d.restored_by_name, ''), 'someone'), to_char(d.restored_at, 'Mon DD');
  end if;

  if d.kind = 'sponsor_card' then
    if exists (select 1 from sponsor_cards where id = d.record_id) then raise exception '% is already on the board.', d.label; end if;
    insert into sponsor_cards select * from jsonb_populate_record(null::sponsor_cards, fix_refs(d.snapshot));
    insert into sponsor_activity select * from jsonb_populate_recordset(null::sponsor_activity, fix_refs_all(d.children -> 'sponsor_activity'));
    insert into sponsor_watchers select * from jsonb_populate_recordset(null::sponsor_watchers, d.children -> 'sponsor_watchers') w
      where exists (select 1 from profiles where id = w.user_id);
    update finance_rows set sponsor_card_id = d.record_id
      where id in (select (x #>> '{}')::uuid from jsonb_array_elements(coalesce(d.children -> 'linked_finance_rows', '[]')) x)
        and sponsor_card_id is null;
    insert into sponsor_activity (card_id, kind, body, actor_id, actor_name)
    values (d.record_id, 'edited', format('Restored (deleted by %s on %s)', coalesce(nullif(d.deleted_by_name, ''), 'someone'), to_char(d.deleted_at, 'Mon DD')),
            auth.uid(), my_display_name());

  elsif d.kind = 'finance_sheet' then
    if exists (select 1 from finance_sheets where id = d.record_id) then raise exception 'The sheet % is already there.', d.label; end if;
    insert into finance_sheets select * from jsonb_populate_record(null::finance_sheets, fix_refs(d.snapshot));
    insert into finance_rows select * from jsonb_populate_recordset(null::finance_rows, fix_refs_all(d.children -> 'finance_rows'));

  elsif d.kind = 'finance_row' then
    if not exists (select 1 from finance_sheets where id = (d.snapshot ->> 'sheet_id')::uuid) then
      raise exception 'Its sheet was deleted too. Restore the sheet instead.';
    end if;
    if exists (select 1 from finance_rows where id = d.record_id) then raise exception 'That row is already there.'; end if;
    insert into finance_rows select * from jsonb_populate_record(null::finance_rows, fix_refs(d.snapshot));

  elsif d.kind = 'purchase' then
    if exists (select 1 from finance_purchases where id = d.record_id) then raise exception '% is already there.', d.label; end if;
    insert into finance_purchases select * from jsonb_populate_record(null::finance_purchases, fix_refs(d.snapshot));

  elsif d.kind = 'fund' then
    if exists (select 1 from finance_funds where id = d.record_id) then raise exception '% is already there.', d.label; end if;
    insert into finance_funds select * from jsonb_populate_record(null::finance_funds, fix_refs(d.snapshot));
  end if;

  -- Files (their storage objects were never removed).
  insert into attachments select * from jsonb_populate_recordset(null::attachments, fix_refs_all(d.children -> 'attachments')) x
    where not exists (select 1 from attachments where id = x.id);

  update deleted_records set restored_at = now(), restored_by_name = my_display_name() where id = d.id;
  return jsonb_build_object('kind', d.kind, 'record_id', d.record_id, 'label', d.label);
end;
$$;

revoke execute on function public.keep_deleted(text, uuid, text, text, jsonb, jsonb), public.rows_as_json(text, text, uuid[]), public.fix_refs(jsonb), public.fix_refs_all(jsonb) from public, anon, authenticated;
revoke execute on function public.restore_deleted_record(bigint) from public, anon;
grant execute on function public.restore_deleted_record(bigint) to authenticated;

select public.migration_done(47, '047_soft_delete.sql');
