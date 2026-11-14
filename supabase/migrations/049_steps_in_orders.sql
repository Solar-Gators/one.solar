select public.migration_begin(49);

-- 049: the Treasurer's purchasing steps (Finances → Purchases, e.g. "Request sent", "Dept approved") can be
-- shown in Orders, so a requester sees where an approved request really is, not just "Approved".
--
--   * Finances → Purchases → Edit steps → "Who sees these steps in Orders" (settings "ledger",
--     showStepsInOrders):
--       'finances'   people who can see Finances (and whoever orders), as before. The default.
--       'requester'  also the request's requester and the people watching it
--       'team'       everyone on the team
--   * request_steps(p_season): the step of each approved (not yet ordered) request this person may see, as
--     one JSON object { request id: step key } (one object, so it isn't cut off at the API's row limit), plus
--     who the setting shows them to. No Finances line yet = 'to_submit'. The Treasurer's notes, categories
--     and the rest of the line stay in Finances.
--   * A new notification, "Purchasing step changed" (event purchase_step): the requester and the request's
--     watchers, when an approved request moves to another step before it's ordered. Off until an Admin
--     ticks it in Admin → one.solar → Notifications, and only sent when the setting lets requesters see steps.

/** Who sees purchasing steps in Orders: 'finances' (default), 'requester' or 'team'. */
create or replace function public.steps_shown_to()
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select case when value ->> 'showStepsInOrders' in ('requester', 'team') then value ->> 'showStepsInOrders' end
                   from app_settings where key = 'ledger'), 'finances')
$$;

/** A step's name: the Treasurer's (Edit steps), or the standard one. */
create or replace function public.step_label(p_key text)
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(
    (select nullif(trim(s ->> 'label'), '')
       from app_settings, jsonb_array_elements(case when jsonb_typeof(value -> 'steps') = 'array' then value -> 'steps' else '[]' end) s
      where key = 'ledger' and s ->> 'key' = p_key limit 1),
    case p_key when 'to_submit' then 'To submit' when 'sent' then 'Request sent' when 'dept_approved' then 'Dept approved'
               when 'ordered' then 'Ordered' when 'received' then 'Received' when 'paid' then 'Paid' when 'cancelled' then 'Cancelled'
               else p_key end)
$$;

create or replace function public.request_steps(p_season text default null)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_mode    text := steps_shown_to();
  v_finance boolean := has_permission('finances.view') or has_permission('finances.edit') or has_permission('request.order');
  v_steps   jsonb;
begin
  if not is_member() then return jsonb_build_object('shownTo', v_mode, 'all', false, 'steps', '{}'::jsonb); end if;
  if not v_finance and v_mode = 'finances' then return jsonb_build_object('shownTo', v_mode, 'all', false, 'steps', '{}'::jsonb); end if;
  select coalesce(jsonb_object_agg(r.id, coalesce(p.dept_status, 'to_submit')), '{}') into v_steps
  from requests r left join finance_purchases p on p.request_id = r.id
  where r.status = 'Approved' and (p_season is null or r.season = p_season)
    and (v_finance or v_mode = 'team'
         or r.created_by = auth.uid()
         or exists (select 1 from request_watchers w where w.request_id = r.id and w.user_id = auth.uid()));
  -- 'all': every approved request is included; otherwise only the caller's own and watched ones.
  return jsonb_build_object('shownTo', v_mode, 'all', v_finance or v_mode = 'team', 'steps', v_steps);
end;
$$;

-- "Purchasing step changed": tell the requester and watchers (when they're allowed to see steps).
create or replace function public.notify_purchase_step()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_people uuid[];
begin
  if new.request_id is null or new.dept_status is not distinct from old.dept_status then return new; end if;
  if ledger_step_kind(new.dept_status) is distinct from 'pipeline' then return new; end if; -- Ordered / Received have their own messages
  if steps_shown_to() = 'finances' then return new; end if;
  select coalesce(array_agg(distinct x), '{}') into v_people
  from (select created_by x from requests where id = new.request_id
        union all select user_id from request_watchers where request_id = new.request_id) s
  where x is not null;
  if cardinality(v_people) = 0 then return new; end if;
  perform enqueue_notification('purchase_step', new.request_id, v_people);
  update notification_outbox set payload = payload || jsonb_build_object('step', step_label(new.dept_status))
  where event = 'purchase_step' and request_id = new.request_id and status = 'pending' and not (payload ? 'step');
  return new;
end;
$$;
drop trigger if exists finance_purchases_notify_step on public.finance_purchases;
create trigger finance_purchases_notify_step
  after update of dept_status on public.finance_purchases
  for each row execute function public.notify_purchase_step();

-- The setting itself is checked with the rest of the ledger settings (only "Edit Finances" saves them).
create or replace function public.check_steps_shown_to()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.key = 'ledger' and new.value ? 'showStepsInOrders'
     and coalesce(new.value ->> 'showStepsInOrders', '') not in ('finances', 'requester', 'team') then
    raise exception 'Who sees purchasing steps must be finances, requester or team.';
  end if;
  return new;
end;
$$;
drop trigger if exists check_steps_shown_to on public.app_settings;
create trigger check_steps_shown_to before insert or update on public.app_settings
  for each row execute function public.check_steps_shown_to();

revoke execute on function public.steps_shown_to(), public.step_label(text), public.notify_purchase_step(), public.check_steps_shown_to()
  from public, anon, authenticated;
revoke execute on function public.request_steps(text) from public, anon;
grant execute on function public.request_steps(text) to authenticated;

select public.migration_done(49, '049_steps_in_orders.sql');
