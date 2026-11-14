select public.migration_begin(45);

-- 045: two people editing the same thing don't silently overwrite each other, and a double-clicked
-- Submit makes one request, not two.
--
-- The website sends what it last read (a row's updated_at, or a Finances cell's value). If someone else has
-- saved since, the save is refused with error code OS409 and a message saying who and when, so nothing is
-- lost without anyone knowing. Your own earlier saves never count as a conflict.
--
-- Old pages keep working: the existing functions are unchanged; the checks are in new functions that check,
-- then call them (set_finance_cell_checked, update_settings_checked, edit_request_items_checked,
-- save_sponsor_card_checked, save_purchase_checked, save_fund_checked, save_request_once).

-- ---- Every real change stamps updated_at / updated_by --------------------------------
alter table public.requests      add column if not exists updated_by uuid;
alter table public.sponsor_cards add column if not exists updated_by uuid;

/**
 * A change to the data stamps updated_at and updated_by. Moving something (only its position changes)
 * isn't an edit: it keeps the old stamp. An update that changes nothing but updated_at is left as written.
 */
create or replace function public.touch_updated_at()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_new jsonb := to_jsonb(new) - 'updated_at' - 'updated_by';
  v_old jsonb := to_jsonb(old) - 'updated_at' - 'updated_by';
begin
  if (v_new - 'position') is distinct from (v_old - 'position') then
    new.updated_at := now();
    if auth.uid() is not null then new.updated_by := auth.uid(); end if;
  elsif v_new is distinct from v_old then
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
  end if;
  return new;
end;
$$;
do $$
declare t text;
begin
  foreach t in array array['requests', 'sponsor_cards', 'finance_purchases', 'finance_funds', 'app_settings'] loop
    execute format('drop trigger if exists touch_updated_at on public.%I', t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function public.touch_updated_at()', t);
  end loop;
end;
$$;

/**
 * Refuse a save if someone else changed the thing after the page read it (p_expected).
 * Millisecond precision: browsers keep timestamps to the millisecond.
 */
create or replace function public.assert_unchanged(p_updated_at timestamptz, p_updated_by uuid, p_expected timestamptz, p_what text)
returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_who text;
begin
  if p_expected is null or p_updated_at is null then return; end if;
  if date_trunc('milliseconds', p_updated_at) <= date_trunc('milliseconds', p_expected) then return; end if;
  if p_updated_by is not null and p_updated_by = auth.uid() then return; end if;   -- your own change
  v_who := coalesce(nullif((select full_name from profiles where id = p_updated_by), ''), 'Someone else');
  raise exception using errcode = 'OS409',
    message = format('%s changed %s at %s, after you opened it. Reload to see their change, then make yours again.',
                     v_who, p_what, to_char(p_updated_at at time zone 'America/New_York', 'FMHH12:MI AM'));
end;
$$;

-- ---- Finances cells: compare the value ---------------------------------------------------
/** Set a cell, unless someone else changed it from what you saw (p_expected; null = don't check). */
create or replace function public.set_finance_cell_checked(p_row uuid, p_key text, p_value text, p_expected text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare r finance_rows;
begin
  perform require_permission('finances.edit');
  select * into r from finance_rows where id = p_row for update;
  if not found then raise exception 'That row was deleted by someone else. Reload the page.'; end if;
  if p_expected is not null
     and coalesce(r.data ->> p_key, '') is distinct from coalesce(p_expected, '')
     and coalesce(r.data ->> p_key, '') is distinct from coalesce(p_value, '')
     and r.updated_by is distinct from auth.uid() then
    raise exception using errcode = 'OS409',
      message = format('%s changed this cell to “%s” just now. Reload to see it, then make your change again.',
                       coalesce(nullif((select full_name from profiles where id = r.updated_by), ''), 'Someone else'),
                       left(coalesce(r.data ->> p_key, ''), 80));
  end if;
  perform set_finance_cell(p_row, p_key, p_value);
end;
$$;

-- ---- Settings ---------------------------------------------------------------------------
/** Save settings unless someone else saved them after p_expected_updated_at. Returns the new updated_at. */
create or replace function public.update_settings_checked(p_key text, p_value jsonb, p_expected_updated_at timestamptz)
returns timestamptz
language plpgsql security definer set search_path = public, pg_temp
as $$
declare s app_settings;
begin
  select * into s from app_settings where key = p_key for update;
  if found then perform assert_unchanged(s.updated_at, s.updated_by, p_expected_updated_at, 'these settings'); end if;
  perform update_settings(p_key, p_value);
  return (select updated_at from app_settings where key = p_key);
end;
$$;

-- ---- Requests -------------------------------------------------------------------------------
/** The Treasurer's item edits (034), refused if the request changed since the page read it. */
create or replace function public.edit_request_items_checked(p_id uuid, p_items jsonb, p_reason text, p_expected_updated_at timestamptz)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare r requests; v_result jsonb;
begin
  select * into r from requests where id = p_id for update;
  if found then perform assert_unchanged(r.updated_at, r.updated_by, p_expected_updated_at, 'this request'); end if;
  v_result := edit_request_items(p_id, p_items, p_reason);
  return coalesce(v_result, '{}'::jsonb) || jsonb_build_object('updated_at', (select updated_at from requests where id = p_id));
end;
$$;

alter table public.requests add column if not exists client_token uuid;
create unique index if not exists requests_client_token on public.requests (client_token) where client_token is not null;

/**
 * A new request, made once: the form sends the same p_client_token every time it's submitted, so a
 * double click or a retry after a dropped connection returns the request already made.
 */
create or replace function public.save_request_once(p_client_token uuid, p_request jsonb, p_items jsonb, p_action text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_number text;
begin
  if p_client_token is null then return save_request(null, p_request, p_items, p_action); end if;
  select request_number into v_number from requests where client_token = p_client_token and created_by = auth.uid();
  if found then return v_number; end if;
  begin
    v_number := save_request(null, p_request, p_items, p_action);
    update requests set client_token = p_client_token where request_number = v_number;
  exception when unique_violation then
    -- The same form got there first a moment ago (two clicks at once): that one counts.
    select request_number into v_number from requests where client_token = p_client_token and created_by = auth.uid();
    if not found then raise; end if;
  end;
  return v_number;
end;
$$;

-- ---- Sponsors and the Treasurer's ledger ---------------------------------------------------
/** Update a card unless someone else changed it since p_expected_updated_at. Returns { id, updated_at }. */
create or replace function public.save_sponsor_card_checked(p_id uuid, p_fields jsonb, p_expected_updated_at timestamptz)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare c sponsor_cards; v_id uuid;
begin
  if p_id is not null then
    select * into c from sponsor_cards where id = p_id for update;
    if found then perform assert_unchanged(c.updated_at, c.updated_by, p_expected_updated_at, 'this sponsor card'); end if;
  end if;
  v_id := save_sponsor_card(p_id, p_fields);
  return jsonb_build_object('id', v_id, 'updated_at', (select updated_at from sponsor_cards where id = v_id));
end;
$$;

create or replace function public.save_purchase_checked(p_id uuid, p_fields jsonb, p_expected_updated_at timestamptz)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare r finance_purchases; v_id uuid;
begin
  if p_id is not null then
    select * into r from finance_purchases where id = p_id for update;
    if found then perform assert_unchanged(r.updated_at, r.updated_by, p_expected_updated_at, 'this purchase'); end if;
  end if;
  v_id := save_purchase(p_id, p_fields);
  return jsonb_build_object('id', v_id, 'updated_at', (select updated_at from finance_purchases where id = v_id));
end;
$$;

create or replace function public.save_fund_checked(p_id uuid, p_fields jsonb, p_expected_updated_at timestamptz)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare r finance_funds; v_id uuid;
begin
  if p_id is not null then
    select * into r from finance_funds where id = p_id for update;
    if found then perform assert_unchanged(r.updated_at, r.updated_by, p_expected_updated_at, 'this fund'); end if;
  end if;
  v_id := save_fund(p_id, p_fields);
  return jsonb_build_object('id', v_id, 'updated_at', (select updated_at from finance_funds where id = v_id));
end;
$$;

-- ---- Who may call what -----------------------------------------------------------------------
revoke execute on function public.touch_updated_at(), public.assert_unchanged(timestamptz, uuid, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.set_finance_cell_checked(uuid, text, text, text), public.update_settings_checked(text, jsonb, timestamptz),
  public.edit_request_items_checked(uuid, jsonb, text, timestamptz), public.save_request_once(uuid, jsonb, jsonb, text),
  public.save_sponsor_card_checked(uuid, jsonb, timestamptz), public.save_purchase_checked(uuid, jsonb, timestamptz),
  public.save_fund_checked(uuid, jsonb, timestamptz)
  from public, anon;
grant execute on function public.set_finance_cell_checked(uuid, text, text, text), public.update_settings_checked(text, jsonb, timestamptz),
  public.edit_request_items_checked(uuid, jsonb, text, timestamptz), public.save_request_once(uuid, jsonb, jsonb, text),
  public.save_sponsor_card_checked(uuid, jsonb, timestamptz), public.save_purchase_checked(uuid, jsonb, timestamptz),
  public.save_fund_checked(uuid, jsonb, timestamptz)
  to authenticated;

select public.migration_done(45, '045_conflicts.sql');
