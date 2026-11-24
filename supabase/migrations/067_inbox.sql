select public.migration_begin(67);

-- =============================================================================
-- 067: "Waiting on you" on the one.solar home screen: what needs you, from every app, in one list
-- =============================================================================
--
--   my_inbox() returns [{ "app", "kind", "title", "note", "href", "count", "due", "urgent" }], most urgent first:
--     Orders    your requests sent back for changes (urgent) and your unsent drafts; requests to approve / to
--               order / awaiting delivery for whoever works those queues;
--     Sponsors  follow-ups due on cards you lead or watch (open stages only);
--     Evals     evaluations you're writing that aren't finished (your self-evals too);
--     Projects  your open work items due within a week or overdue, and unread Projects notifications;
--     Events    events in the next two weeks you're invited to and haven't answered.
--   href is a path from the site root (orders/#/requests/SG27-104). It runs as the person asking (security
--   invoker), so row-level security decides what's there; an app this person can't read is skipped.
-- =============================================================================

create or replace function public.my_inbox()
returns jsonb
language plpgsql stable security invoker set search_path = public, pg_temp
as $$
declare
  me   uuid := auth.uid();
  out  jsonb := '[]'::jsonb;
  part jsonb;
  n    int;
  today date := (now() at time zone 'America/New_York')::date;
begin
  if me is null then return out; end if;

  -- ---- Orders: my own requests ---------------------------------------------------------------------------
  begin
    select coalesce(jsonb_agg(r order by r.urgent desc, r.due), '[]') into part from (
      select 'orders' as app, 'request' as kind,
             coalesce(nullif(title, ''), 'Untitled request') as title,
             case when status = 'Changes Requested' then request_number || ' · sent back: make the changes and resubmit'
                  else request_number || ' · draft: not submitted yet' end as note,
             'orders/#/requests/' || request_number as href, null::int as count,
             updated_at::date as due, status = 'Changes Requested' as urgent
      from requests
      where created_by = me and status in ('Changes Requested', 'Draft')
      order by updated_at desc
      limit 10) r;
    out := out || part;
  exception when insufficient_privilege or undefined_table or undefined_column then null;
  end;

  -- ---- Orders: the queues -------------------------------------------------------------------------------
  begin
    if has_permission('request.review') then
      select count(*) into n from requests where status = 'Submitted';
      if n > 0 then
        out := out || jsonb_build_object('app', 'orders', 'kind', 'queue', 'title', n || case when n = 1 then ' request' else ' requests' end || ' to approve',
          'note', 'Orders › Queue › To approve', 'href', 'orders/#/approvals', 'count', n, 'due', null, 'urgent', false);
      end if;
    end if;
    if has_permission('request.order') then
      select count(*) into n from requests where status = 'Approved';
      if n > 0 then
        out := out || jsonb_build_object('app', 'orders', 'kind', 'queue', 'title', n || case when n = 1 then ' approved request' else ' approved requests' end || ' to order',
          'note', 'Orders › Queue › To order', 'href', 'orders/#/treasurer', 'count', n, 'due', null, 'urgent', false);
      end if;
      select count(*) into n from requests where status = 'Ordered';
      if n > 0 then
        out := out || jsonb_build_object('app', 'orders', 'kind', 'queue', 'title', n || case when n = 1 then ' order' else ' orders' end || ' awaiting delivery',
          'note', 'Orders › Queue › Awaiting delivery', 'href', 'orders/#/treasurer', 'count', n, 'due', null, 'urgent', false);
      end if;
    end if;
  exception when insufficient_privilege or undefined_table or undefined_column or undefined_function then null;
  end;

  -- ---- Sponsors: follow-ups due on cards I lead or watch ----------------------------------------------------
  begin
    select coalesce(jsonb_agg(r order by r.due), '[]') into part from (
      select 'sponsors' as app, 'follow_up' as kind, 'Follow up with ' || c.name as title,
             case when c.follow_up < today then 'Sponsors · follow-up was due ' || to_char(c.follow_up, 'Mon FMDD')
                  else 'Sponsors · follow-up due today' end as note,
             'sponsors/#/sponsors/' || c.id as href, null::int as count, c.follow_up as due, c.follow_up < today as urgent
      from sponsor_cards c
      where c.follow_up is not null and c.follow_up <= today
        and (c.owner_id = me or exists (select 1 from sponsor_watchers w where w.card_id = c.id and w.user_id = me))
        and coalesce(
              (select s ->> 'kind' from app_settings a, jsonb_array_elements(case when jsonb_typeof(a.value -> 'stages') = 'array' then a.value -> 'stages' else '[]' end) s
               where a.key = 'sponsors' and s ->> 'key' = c.stage limit 1),
              case when c.stage in ('received', 'thanked', 'declined') then 'closed' else 'open' end) = 'open'
      order by c.follow_up
      limit 10) r;
    out := out || part;
  exception when insufficient_privilege or undefined_table or undefined_column then null;
  end;

  -- ---- Solar Evals: evaluations I'm writing --------------------------------------------------------------
  begin
    select coalesce(jsonb_agg(r order by r.due), '[]') into part from (
      select 'evals' as app, 'eval' as kind,
             case when e.kind = 'self' then 'Finish your self-evaluation' else 'Finish ' || coalesce(nullif(e.member_name, ''), 'an') || '''s evaluation' end as title,
             concat_ws(' · ', 'Solar Evals', nullif(e.semester, ''), 'draft') as note,
             'evals/#/evals/' || e.id as href, null::int as count, e.updated_at::date as due, false as urgent
      from evals e
      where e.evaluator_id = me and e.status = 'draft'
      order by e.updated_at
      limit 10) r;
    out := out || part;
  exception when insufficient_privilege or undefined_table or undefined_column then null;
  end;

  -- ---- Projects: my work due soon, unread notifications ----------------------------------------------------
  begin
    select coalesce(jsonb_agg(r order by r.due), '[]') into part from (
      select 'projects' as app, 'item' as kind, i.key || ' · ' || i.title as title,
             case when i.due_date < today then 'Projects · overdue since ' || to_char(i.due_date, 'Mon FMDD')
                  when i.due_date = today then 'Projects · due today'
                  else 'Projects · due ' || to_char(i.due_date, 'Dy Mon FMDD') end as note,
             'projects/#/projects/item/' || i.key as href, null::int as count, i.due_date as due, i.due_date < today as urgent
      from pm_items i
      where i.owner_id = me and i.category <> 'done' and i.due_date is not null and i.due_date <= today + 7
      order by i.due_date
      limit 10) r;
    out := out || part;
    select count(*) into n from pm_notifications where user_id = me and read_at is null;
    if n > 0 then
      out := out || jsonb_build_object('app', 'projects', 'kind', 'notifications', 'title', n || case when n = 1 then ' unread update' else ' unread updates' end || ' in Projects',
        'note', 'Projects › Inbox', 'href', 'projects/#/projects/inbox', 'count', n, 'due', null, 'urgent', false);
    end if;
  exception when insufficient_privilege or undefined_table or undefined_column then null;
  end;

  -- ---- Events: invitations I haven't answered --------------------------------------------------------------
  begin
    select coalesce(jsonb_agg(r order by r.due), '[]') into part from (
      select 'events' as app, 'rsvp' as kind, 'Are you coming? ' || e.title as title,
             'Events · ' || to_char(e.starts_at at time zone 'America/New_York', 'Dy Mon FMDD, FMHH12:MI AM') as note,
             'events/#/events/e/' || e.id as href, null::int as count, (e.starts_at at time zone 'America/New_York')::date as due, false as urgent
      from ev_events e
      join ev_invitees v on v.event_id = e.id and v.user_id = me and not v.excused
      where e.ask_rsvp and e.cancelled_at is null and e.starts_at > now() and e.starts_at < now() + interval '14 days'
        and not exists (select 1 from ev_rsvps x where x.event_id = e.id and x.user_id = me)
      order by e.starts_at
      limit 10) r;
    out := out || part;
  exception when insufficient_privilege or undefined_table or undefined_column then null;
  end;

  -- most urgent first, then soonest
  select coalesce(jsonb_agg(x order by (x ->> 'urgent')::boolean desc, x ->> 'due' nulls last), '[]') into out from jsonb_array_elements(out) x;
  return out;
end;
$$;

revoke execute on function public.my_inbox() from public, anon;
grant execute on function public.my_inbox() to authenticated;

select public.migration_done(67, '067_inbox.sql');
