select public.migration_begin(64);

-- =============================================================================
-- 064: Events: invite people, check them in with a QR code, see who came
-- =============================================================================
--
--   For the events outside normal meetings that the team keeps attendance for (town halls, testing days,
--   workdays…). Leads and up create an event and say who's invited (everyone, divisions, subsystems,
--   positions or people). On the day the host opens check-in: a QR code on a screen that changes every
--   30 seconds (with a short code to type instead). Members scan it, sign in and tap "I'm here". The host
--   can also check people in by hand, undo a check-in, and mark someone excused. Every change is logged.
--
--   Each event can ask its own sign-in questions (text, yes/no, a choice, a number), required or not, and
--   question sets can be kept as templates.
--
--   Who does what:
--     * any member: sees the events they're invited to, RSVPs, checks in, sees their own attendance;
--     * "Create events" (events.create): creates events and hosts them (with co-hosts), edits the categories;
--     * "See attendance" (events.attendance): sees every event, every attendance list and the stats;
--     * the host and co-hosts run their event's check-in; Admins can run any event.
--   Both permissions go to Subsystem Leads, Chief Engineers, the E-board and Admins (titles like President
--   carry nothing: their E-board role does). Admin → Roles changes who has them.
--
--   Not connected to Solar Evals. Nothing here weighs attendance: the team decides what it means.
-- =============================================================================

-- ---- permissions --------------------------------------------------------------------------------
insert into public.permissions (key, label, description, sort) values
  ('events.create', 'Create events', 'Create events, invite people, run check-in for your own events, and edit the event categories.', 50),
  ('events.attendance', 'See attendance', 'See every event, every attendance list and the attendance stats (who came to what, by division and subsystem).', 51)
on conflict (key) do nothing;
insert into public.role_permissions (role, permission)
select k, perm
from (select public.eval_seed_key('subsystem_lead') k union select public.eval_seed_key('ce') union select public.eval_seed_key('eboard') union select 'admin') x
cross join (values ('events.create'), ('events.attendance')) p(perm)
where k is not null and exists (select 1 from public.roles where key = k)
on conflict do nothing;
select public.record_permissions_snapshot();

-- ---- tables -------------------------------------------------------------------------------------
create table public.ev_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 40),
  color       text not null default 'blue' check (color ~ '^[a-z]{1,12}$'),
  sort        int not null default 100,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index ev_categories_name_key on public.ev_categories (lower(trim(name))) where archived_at is null;
insert into public.ev_categories (name, color, sort) values
  ('Town hall', 'blue', 10), ('Testing day', 'orange', 20), ('Workday', 'green', 30), ('Outreach', 'purple', 40),
  ('Social', 'pink', 50), ('Other', 'gray', 90);

create table public.ev_events (
  id             uuid primary key default gen_random_uuid(),
  title          text not null check (length(trim(title)) between 1 and 120),
  category_id    uuid references public.ev_categories(id) on delete set null,
  starts_at      timestamptz not null,
  ends_at        timestamptz,
  location       text not null default '' check (length(location) <= 200),
  notes          text not null default '' check (length(notes) <= 5000),
  -- Who's invited: { "all": true } or any of { "divisions": [ids], "subsystems": [ids], "roles": [keys], "people": [ids] }.
  invite         jsonb not null default '{"all": true}',
  ask_rsvp       boolean not null default true,
  allow_walkins  boolean not null default true,      -- members who weren't invited may check in (marked as walk-ins)
  -- Sign-in questions: [{ "id", "label", "type": text|check|select|number, "required", "options": [..] }]
  questions      jsonb not null default '[]',
  late_after_min int check (late_after_min between 0 and 600),   -- checked in this many minutes after the start: late
  host_id        uuid references public.profiles(id) on delete set null,
  cohosts        uuid[] not null default '{}',
  checkin_open   boolean not null default false,
  checkin_opened_at timestamptz,
  cancelled_at   timestamptz,
  cancel_note    text not null default '',
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (ends_at is null or ends_at >= starts_at),
  check (jsonb_typeof(invite) = 'object'),
  check (jsonb_typeof(questions) = 'array')
);
create index ev_events_starts_idx on public.ev_events (starts_at);

-- The secret behind each event's rotating check-in code. Nobody reads it directly.
create table public.ev_secrets (
  event_id uuid primary key references public.ev_events(id) on delete cascade,
  secret   text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);

-- Who's invited, worked out from ev_events.invite when the event is saved (and kept up to date until it starts).
create table public.ev_invitees (
  event_id     uuid not null references public.ev_events(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  excused      boolean not null default false,
  excused_note text not null default '' check (length(excused_note) <= 500),
  excused_by   text not null default '',
  added_at     timestamptz not null default now(),
  primary key (event_id, user_id)
);
create index ev_invitees_user_idx on public.ev_invitees (user_id);

create table public.ev_rsvps (
  event_id   uuid not null references public.ev_events(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  answer     text not null check (answer in ('yes', 'maybe', 'no')),
  note       text not null default '' check (length(note) <= 500),
  updated_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
create index ev_rsvps_user_idx on public.ev_rsvps (user_id);

create table public.ev_attendance (
  event_id      uuid not null references public.ev_events(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  checked_in_at timestamptz not null default now(),
  how           text not null check (how in ('code', 'host')),
  by_id         uuid references public.profiles(id) on delete set null,
  by_name       text not null default '',
  late          boolean not null default false,
  walk_in       boolean not null default false,
  answers       jsonb not null default '{}',
  primary key (event_id, user_id)
);
create index ev_attendance_user_idx on public.ev_attendance (user_id);

-- Everything that changed: check-ins, undos, excuses, edits.
create table public.ev_log (
  id         bigserial primary key,
  event_id   uuid not null references public.ev_events(id) on delete cascade,
  at         timestamptz not null default now(),
  actor_id   uuid references public.profiles(id) on delete set null,
  actor_name text not null default '',
  action     text not null,
  user_id    uuid references public.profiles(id) on delete set null,
  details    jsonb not null default '{}'
);
create index ev_log_event_idx on public.ev_log (event_id, id);

-- Sign-in question sets to reuse.
create table public.ev_templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) between 1 and 80),
  questions  jsonb not null default '[]' check (jsonb_typeof(questions) = 'array'),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

-- ---- who may do what ----------------------------------------------------------------------------
/** Sees every event and attendance list (the stats). */
create or replace function public.ev_sees_all()
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select auth.uid() is not null and is_member() and (has_permission('events.attendance') or is_admin()); $$;

/** Runs this event: its host, a co-host, or an Admin. */
create or replace function public.ev_runs(p_event uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select auth.uid() is not null and is_member() and (is_admin() or exists (
    select 1 from ev_events e where e.id = p_event and (e.host_id = auth.uid() or auth.uid() = any(e.cohosts))));
$$;

/** Sees this event: invited, checked in, running it, or sees everything. */
create or replace function public.ev_sees(p_event uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select auth.uid() is not null and is_member() and (
    ev_sees_all() or ev_runs(p_event)
    or exists (select 1 from ev_invitees where event_id = p_event and user_id = auth.uid())
    or exists (select 1 from ev_attendance where event_id = p_event and user_id = auth.uid()));
$$;

alter table public.ev_categories enable row level security;
create policy "members read" on public.ev_categories for select to authenticated using ((select public.is_member()));
alter table public.ev_events enable row level security;
create policy "who can see it" on public.ev_events for select to authenticated using (public.ev_sees(id));
alter table public.ev_secrets enable row level security;
alter table public.ev_invitees enable row level security;
create policy "mine, or the event's" on public.ev_invitees for select to authenticated
  using (user_id = auth.uid() or (select public.ev_sees_all()) or public.ev_runs(event_id));
alter table public.ev_rsvps enable row level security;
create policy "mine, or the event's" on public.ev_rsvps for select to authenticated
  using (user_id = auth.uid() or (select public.ev_sees_all()) or public.ev_runs(event_id));
alter table public.ev_attendance enable row level security;
create policy "mine, or the event's" on public.ev_attendance for select to authenticated
  using (user_id = auth.uid() or (select public.ev_sees_all()) or public.ev_runs(event_id));
alter table public.ev_log enable row level security;
create policy "the event's" on public.ev_log for select to authenticated using ((select public.ev_sees_all()) or public.ev_runs(event_id));
alter table public.ev_templates enable row level security;
create policy "event makers" on public.ev_templates for select to authenticated
  using ((select public.is_member()) and ((select public.has_permission('events.create')) or (select public.ev_sees_all())));

revoke all on public.ev_categories, public.ev_events, public.ev_secrets, public.ev_invitees, public.ev_rsvps,
  public.ev_attendance, public.ev_log, public.ev_templates from anon, authenticated;
revoke all on sequence public.ev_log_id_seq from anon, authenticated;
grant select on public.ev_categories, public.ev_events, public.ev_invitees, public.ev_rsvps, public.ev_attendance,
  public.ev_log, public.ev_templates to authenticated;

-- ---- helpers ------------------------------------------------------------------------------------
create or replace function public.evx_require_member()
returns void language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'You must be signed in.' using errcode = '42501'; end if;
  if not is_member() then raise exception 'Only team members can use Events.' using errcode = '42501'; end if;
end;
$$;

create or replace function public.evx_require_runs(p_event uuid)
returns ev_events language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v ev_events;
begin
  perform evx_require_member();
  select * into v from ev_events where id = p_event;
  if v.id is null then raise exception 'That event doesn''t exist (it may have been deleted).' using errcode = 'P0002'; end if;
  if not ev_runs(p_event) then raise exception 'Only the event''s host, its co-hosts or an Admin can do that.' using errcode = '42501'; end if;
  return v;
end;
$$;

create or replace function public.evx_log(p_event uuid, p_action text, p_user uuid default null, p_details jsonb default '{}')
returns void language sql security definer set search_path = public, pg_temp
as $$
  insert into ev_log (event_id, actor_id, actor_name, action, user_id, details)
  values (p_event, auth.uid(), coalesce(my_display_name(), ''), p_action, p_user, coalesce(p_details, '{}'));
$$;

/** The members an invite covers. */
create or replace function public.ev_invite_people(p_invite jsonb)
returns setof uuid language sql stable security definer set search_path = public, pg_temp
as $$
  with ids(kind, v) as (
    select k, jsonb_array_elements_text(case when jsonb_typeof(p_invite -> k) = 'array' then p_invite -> k else '[]' end)
    from unnest(array['divisions', 'subsystems', 'roles', 'people']) k)
  select distinct p.id
  from profiles p
  where is_member(p.id) and (
    (p_invite -> 'all') = 'true'::jsonb
    or exists (select 1 from person_org o join ids on ids.kind = 'divisions' and ids.v = o.division_id::text where o.user_id = p.id)
    or exists (select 1 from person_org o join ids on ids.kind = 'subsystems' and ids.v = o.subsystem_id::text where o.user_id = p.id)
    or exists (select 1 from profile_roles r join ids on ids.kind = 'roles' and ids.v = r.role where r.user_id = p.id)
    or exists (select 1 from ids where ids.kind = 'people' and ids.v = p.id::text));
$$;

/**
 * Bring an event's invite list up to date with its invite (and the team as it is now). People who RSVP'd,
 * checked in or were excused stay on it. Returns the people newly invited. Not once the event is over.
 */
create or replace function public.evx_sync_invitees(p_event uuid)
returns uuid[] language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v ev_events;
  v_new uuid[];
begin
  select * into v from ev_events where id = p_event;
  if v.id is null or coalesce(v.ends_at, v.starts_at + interval '6 hours') < now() then return '{}'; end if;
  with wanted as (select ev_invite_people(v.invite) as user_id),
  added as (
    insert into ev_invitees (event_id, user_id)
    select p_event, user_id from wanted
    on conflict do nothing
    returning user_id)
  select coalesce(array_agg(user_id), '{}') into v_new from added;
  delete from ev_invitees i
  where i.event_id = p_event and not i.excused
    and i.user_id not in (select ev_invite_people(v.invite))
    and not exists (select 1 from ev_rsvps r where r.event_id = p_event and r.user_id = i.user_id)
    and not exists (select 1 from ev_attendance a where a.event_id = p_event and a.user_id = i.user_id);
  return v_new;
end;
$$;

/** Keep upcoming events' invite lists in step with the team (new members, people who changed subsystem). */
create or replace function public.ev_sync()
returns int language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  n int := 0;
begin
  perform evx_require_member();
  for v_id in select id from ev_events where cancelled_at is null and coalesce(ends_at, starts_at + interval '6 hours') >= now() loop
    perform evx_sync_invitees(v_id);
    n := n + 1;
  end loop;
  return n;
end;
$$;

/** Clean sign-in questions: ids, labels, a known type, options for choices. */
create or replace function public.evx_questions(p jsonb)
returns jsonb language plpgsql volatile set search_path = public, pg_temp
as $$
declare
  q jsonb;
  out jsonb := '[]';
  v_type text;
  v_opts jsonb;
  v_ids text[] := '{}';
  v_id text;
begin
  if p is null or jsonb_typeof(p) <> 'array' then return '[]'; end if;
  if jsonb_array_length(p) > 20 then raise exception 'An event can ask at most 20 sign-in questions.'; end if;
  for q in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(q) <> 'object' or length(trim(coalesce(q ->> 'label', ''))) = 0 then continue; end if;
    v_type := coalesce(q ->> 'type', 'text');
    if v_type not in ('text', 'check', 'select', 'number') then raise exception 'A sign-in question has an unknown type (%).', v_type; end if;
    v_opts := '[]';
    if v_type = 'select' then
      select coalesce(jsonb_agg(distinct left(trim(o), 80)), '[]') into v_opts
      from jsonb_array_elements_text(case when jsonb_typeof(q -> 'options') = 'array' then q -> 'options' else '[]' end) o
      where length(trim(o)) > 0;
      if jsonb_array_length(v_opts) = 0 then raise exception 'The question "%" needs at least one choice.', trim(q ->> 'label'); end if;
    end if;
    v_id := coalesce(nullif(regexp_replace(coalesce(q ->> 'id', ''), '[^a-zA-Z0-9_-]', '', 'g'), ''), substr(md5(random()::text), 1, 8));
    if v_id = any(v_ids) then v_id := substr(md5(random()::text), 1, 8); end if;
    v_ids := v_ids || v_id;
    out := out || jsonb_build_array(jsonb_build_object('id', left(v_id, 24), 'label', left(trim(q ->> 'label'), 200), 'type', v_type,
      'required', coalesce((q ->> 'required')::boolean, false), 'options', v_opts));
  end loop;
  return out;
end;
$$;

/** Check answers against an event's questions; returns just the answers to its questions. */
create or replace function public.evx_answers(p_questions jsonb, p_answers jsonb)
returns jsonb language plpgsql stable set search_path = public, pg_temp
as $$
declare
  q jsonb;
  a jsonb;
  out jsonb := '{}';
  v_text text;
begin
  p_answers := case when jsonb_typeof(p_answers) = 'object' then p_answers else '{}' end;
  for q in select * from jsonb_array_elements(coalesce(p_questions, '[]')) loop
    a := p_answers -> (q ->> 'id');
    v_text := case when a is null or jsonb_typeof(a) = 'null' then '' else trim(a #>> '{}') end;
    if q ->> 'type' = 'check' then
      if (q ->> 'required')::boolean and v_text <> 'true' then raise exception 'Please tick "%".', q ->> 'label'; end if;
      out := out || jsonb_build_object(q ->> 'id', v_text = 'true');
      continue;
    end if;
    if v_text = '' then
      if (q ->> 'required')::boolean then raise exception 'Please answer "%".', q ->> 'label'; end if;
      continue;
    end if;
    if q ->> 'type' = 'number' then
      if v_text !~ '^-?[0-9]+(\.[0-9]+)?$' then raise exception '"%" needs a number.', q ->> 'label'; end if;
      out := out || jsonb_build_object(q ->> 'id', v_text::numeric);
    elsif q ->> 'type' = 'select' then
      if not (q -> 'options') ? v_text then raise exception 'Pick one of the choices for "%".', q ->> 'label'; end if;
      out := out || jsonb_build_object(q ->> 'id', v_text);
    else
      out := out || jsonb_build_object(q ->> 'id', left(v_text, 1000));
    end if;
  end loop;
  return out;
end;
$$;

-- ---- events -------------------------------------------------------------------------------------
/**
 * Create (p_id null) or change an event. p: title, category_id, starts_at, ends_at, location, notes, invite,
 * ask_rsvp, allow_walkins, questions, late_after_min, host_id, cohosts, cancelled (true/false), cancel_note,
 * notify (true: email the people newly invited, if email notifications are on). Returns the event.
 */
create or replace function public.ev_save_event(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v ev_events;
  v_old ev_events;
  v_new uuid[];
  v_invite jsonb;
  v_cohosts uuid[];
  v_settings jsonb := (select value from app_settings where key = 'notifications');
  v_person profiles;
  v_when text;
begin
  perform evx_require_member();
  if p_id is null then
    if not has_permission('events.create') and not is_admin() then
      raise exception 'Your role can''t create events (it needs "Create events").' using errcode = '42501';
    end if;
  else
    v_old := evx_require_runs(p_id);
  end if;
  p := coalesce(p, '{}');

  if p ? 'invite' then
    v_invite := case when jsonb_typeof(p -> 'invite') = 'object' then p -> 'invite' else '{}' end;
    v_invite := jsonb_strip_nulls(jsonb_build_object(
      'all', case when (v_invite -> 'all') = 'true'::jsonb then true end,
      'divisions', case when jsonb_typeof(v_invite -> 'divisions') = 'array' and jsonb_array_length(v_invite -> 'divisions') > 0 then v_invite -> 'divisions' end,
      'subsystems', case when jsonb_typeof(v_invite -> 'subsystems') = 'array' and jsonb_array_length(v_invite -> 'subsystems') > 0 then v_invite -> 'subsystems' end,
      'roles', case when jsonb_typeof(v_invite -> 'roles') = 'array' and jsonb_array_length(v_invite -> 'roles') > 0 then v_invite -> 'roles' end,
      'people', case when jsonb_typeof(v_invite -> 'people') = 'array' and jsonb_array_length(v_invite -> 'people') > 0 then v_invite -> 'people' end));
    if v_invite = '{}' then raise exception 'Choose who''s invited (everyone, or some divisions, subsystems, positions or people).'; end if;
  end if;
  if p ? 'cohosts' then
    select coalesce(array_agg(distinct x::uuid), '{}') into v_cohosts
    from jsonb_array_elements_text(case when jsonb_typeof(p -> 'cohosts') = 'array' then p -> 'cohosts' else '[]' end) x
    where is_member(x::uuid);
  end if;

  if p_id is null then
    insert into ev_events (title, category_id, starts_at, ends_at, location, notes, invite, ask_rsvp, allow_walkins, questions,
                           late_after_min, host_id, cohosts, created_by)
    values (trim(coalesce(p ->> 'title', '')), nullif(p ->> 'category_id', '')::uuid,
            coalesce(nullif(p ->> 'starts_at', '')::timestamptz, now()), nullif(p ->> 'ends_at', '')::timestamptz,
            trim(coalesce(p ->> 'location', '')), coalesce(p ->> 'notes', ''), coalesce(v_invite, '{"all": true}'),
            coalesce((p ->> 'ask_rsvp')::boolean, true), coalesce((p ->> 'allow_walkins')::boolean, true),
            evx_questions(p -> 'questions'), nullif(p ->> 'late_after_min', '')::int,
            coalesce(nullif(p ->> 'host_id', '')::uuid, auth.uid()), coalesce(v_cohosts, '{}'), auth.uid())
    returning * into v;
    insert into ev_secrets (event_id) values (v.id);
    perform evx_log(v.id, 'created', null, jsonb_build_object('title', v.title));
  else
    update ev_events set
      title = case when p ? 'title' then trim(coalesce(p ->> 'title', '')) else title end,
      category_id = case when p ? 'category_id' then nullif(p ->> 'category_id', '')::uuid else category_id end,
      starts_at = case when p ? 'starts_at' then coalesce(nullif(p ->> 'starts_at', '')::timestamptz, starts_at) else starts_at end,
      ends_at = case when p ? 'ends_at' then nullif(p ->> 'ends_at', '')::timestamptz else ends_at end,
      location = case when p ? 'location' then trim(coalesce(p ->> 'location', '')) else location end,
      notes = case when p ? 'notes' then coalesce(p ->> 'notes', '') else notes end,
      invite = coalesce(v_invite, invite),
      ask_rsvp = coalesce((p ->> 'ask_rsvp')::boolean, ask_rsvp),
      allow_walkins = coalesce((p ->> 'allow_walkins')::boolean, allow_walkins),
      questions = case when p ? 'questions' then evx_questions(p -> 'questions') else questions end,
      late_after_min = case when p ? 'late_after_min' then nullif(p ->> 'late_after_min', '')::int else late_after_min end,
      host_id = case when p ? 'host_id' then coalesce(nullif(p ->> 'host_id', '')::uuid, host_id) else host_id end,
      cohosts = coalesce(v_cohosts, cohosts),
      cancelled_at = case when p ? 'cancelled' then case when (p ->> 'cancelled')::boolean then coalesce(cancelled_at, now()) end else cancelled_at end,
      cancel_note = case when p ? 'cancel_note' then left(coalesce(p ->> 'cancel_note', ''), 500) else cancel_note end,
      checkin_open = case when (p ->> 'cancelled')::boolean then false else checkin_open end,
      updated_at = now()
    where id = p_id
    returning * into v;
    perform evx_log(v.id, case when v.cancelled_at is not null and v_old.cancelled_at is null then 'cancelled'
                              when v.cancelled_at is null and v_old.cancelled_at is not null then 'uncancelled' else 'edited' end,
                    null, jsonb_build_object('title', v.title));
  end if;
  if v.host_id is not null and not is_member(v.host_id) then raise exception 'The host must be a team member.'; end if;

  v_new := case when v.cancelled_at is null then evx_sync_invitees(v.id) else '{}' end;

  -- Email the people newly invited (asked for, and notifications switched on for "Event invitations").
  if coalesce((p ->> 'notify')::boolean, false) and array_length(v_new, 1) > 0
     and v_settings is not null and (v_settings -> 'enabled') = 'true'::jsonb
     and (v_settings -> 'events' -> 'event_invite' -> 'email') is distinct from 'false'::jsonb then
    v_when := to_char(v.starts_at at time zone 'America/New_York', 'Dy Mon FMDD, FMHH12:MI AM');
    for v_person in select * from profiles where id = any(v_new) and id is distinct from auth.uid() loop
      if v_person.notify_email and (v_person.notify_events -> 'event_invite' -> 'email') is distinct from 'false'::jsonb then
        insert into notification_outbox (event, recipient_id, email, channel, payload)
        values ('event_invite', v_person.id, v_person.email, 'email', jsonb_build_object(
          'recipient_name', v_person.full_name,
          'what', 'You''re invited: ' || v.title,
          'details', coalesce(my_display_name(), 'Someone') || ' invited you to ' || v.title || ' on ' || v_when
                     || case when v.location <> '' then ' at ' || v.location else '' end || '.'
                     || case when v.ask_rsvp then ' Let them know if you can make it.' else '' end,
          'actor', coalesce(my_display_name(), ''),
          'app_path', 'events/#/events/e/' || v.id));
      end if;
    end loop;
  end if;
  return to_jsonb(v);
end;
$$;

/** Delete an event and everything about it (host, co-host or Admin). */
create or replace function public.ev_delete_event(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform evx_require_runs(p_id);
  delete from ev_events where id = p_id;
end;
$$;

/** My answer: yes, maybe or no (with a reason). Anyone invited (or who can see it) until the event ends. */
create or replace function public.ev_rsvp(p_event uuid, p_answer text, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v ev_events;
  r ev_rsvps;
begin
  perform evx_require_member();
  select * into v from ev_events where id = p_event;
  if v.id is null or not ev_sees(p_event) then raise exception 'That event doesn''t exist, or you aren''t invited to it.' using errcode = 'P0002'; end if;
  if v.cancelled_at is not null then raise exception 'This event was cancelled.'; end if;
  if coalesce(v.ends_at, v.starts_at + interval '6 hours') < now() then raise exception 'This event is over.'; end if;
  if p_answer is null then
    delete from ev_rsvps where event_id = p_event and user_id = auth.uid();
    return null;
  end if;
  if p_answer not in ('yes', 'maybe', 'no') then raise exception 'Answer yes, maybe or no.'; end if;
  insert into ev_rsvps (event_id, user_id, answer, note) values (p_event, auth.uid(), p_answer, left(trim(coalesce(p_note, '')), 500))
  on conflict (event_id, user_id) do update set answer = excluded.answer, note = excluded.note, updated_at = now()
  returning * into r;
  return to_jsonb(r);
end;
$$;

-- ---- check-in -----------------------------------------------------------------------------------
/** The code for a 30-second window. */
create or replace function public.evx_code(p_event uuid, p_window bigint)
returns text language sql stable security definer set search_path = public, pg_temp
as $$ select upper(substr(md5(s.secret || ':' || p_window::text), 1, 6)) from ev_secrets s where s.event_id = p_event; $$;

/** Open or close check-in (host, co-host or Admin). */
create or replace function public.ev_set_checkin(p_event uuid, p_open boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v ev_events;
begin
  v := evx_require_runs(p_event);
  if p_open and v.cancelled_at is not null then raise exception 'This event was cancelled.'; end if;
  update ev_events set checkin_open = p_open, checkin_opened_at = case when p_open then now() else checkin_opened_at end, updated_at = now()
  where id = p_event returning * into v;
  perform evx_log(p_event, case when p_open then 'checkin_opened' else 'checkin_closed' end);
  return to_jsonb(v);
end;
$$;

/** The code to show right now, and when it changes (host, co-host or Admin, while check-in is open). */
create or replace function public.ev_checkin_code(p_event uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v ev_events;
  v_window bigint := floor(extract(epoch from now()) / 30);
begin
  v := evx_require_runs(p_event);
  if not v.checkin_open then raise exception 'Check-in is closed. Open it first.'; end if;
  return jsonb_build_object('code', evx_code(p_event, v_window), 'changes_at', to_jsonb(to_timestamp((v_window + 1) * 30)),
    'now', to_jsonb(now()), 'count', (select count(*) from ev_attendance where event_id = p_event));
end;
$$;

/** What I see when I scan the code: the event, its questions, whether I'm already in. */
create or replace function public.ev_checkin_info(p_event uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v ev_events;
  v_invited boolean;
begin
  perform evx_require_member();
  select * into v from ev_events where id = p_event;
  if v.id is null then raise exception 'That event doesn''t exist (it may have been deleted).' using errcode = 'P0002'; end if;
  v_invited := exists (select 1 from ev_invitees where event_id = p_event and user_id = auth.uid());
  if not v_invited and not v.allow_walkins and not ev_sees(p_event) then
    raise exception 'You aren''t invited to this event.' using errcode = '42501';
  end if;
  return jsonb_build_object('id', v.id, 'title', v.title, 'starts_at', v.starts_at, 'ends_at', v.ends_at, 'location', v.location,
    'questions', v.questions, 'open', v.checkin_open and v.cancelled_at is null, 'cancelled', v.cancelled_at is not null,
    'invited', v_invited, 'walkins', v.allow_walkins,
    'checked_in_at', (select checked_in_at from ev_attendance where event_id = p_event and user_id = auth.uid()));
end;
$$;

/** Check myself in with the code on the screen (this one or the two before it) and my answers. */
create or replace function public.ev_check_in(p_event uuid, p_code text, p_answers jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v ev_events;
  v_window bigint := floor(extract(epoch from now()) / 30);
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^a-zA-Z0-9]', '', 'g'));
  v_invited boolean;
  a ev_attendance;
begin
  perform evx_require_member();
  select * into v from ev_events where id = p_event;
  if v.id is null then raise exception 'That event doesn''t exist (it may have been deleted).' using errcode = 'P0002'; end if;
  select * into a from ev_attendance where event_id = p_event and user_id = auth.uid();
  if a.user_id is not null then
    return jsonb_build_object('status', 'already', 'checked_in_at', a.checked_in_at, 'late', a.late);
  end if;
  if v.cancelled_at is not null then raise exception 'This event was cancelled.'; end if;
  if not v.checkin_open then raise exception 'Check-in for this event isn''t open. Ask the host.'; end if;
  if v_code = '' or v_code not in (evx_code(p_event, v_window), evx_code(p_event, v_window - 1), evx_code(p_event, v_window - 2)) then
    raise exception 'That code didn''t work. It changes every 30 seconds: scan the screen again or type the code shown now.' using errcode = 'OS403';
  end if;
  v_invited := exists (select 1 from ev_invitees where event_id = p_event and user_id = auth.uid());
  if not v_invited and not v.allow_walkins then raise exception 'You aren''t invited to this event. Ask the host to check you in.' using errcode = '42501'; end if;
  insert into ev_attendance (event_id, user_id, how, by_id, by_name, late, walk_in, answers)
  values (p_event, auth.uid(), 'code', auth.uid(), coalesce(my_display_name(), ''),
          v.late_after_min is not null and now() > v.starts_at + make_interval(mins => v.late_after_min),
          not v_invited, evx_answers(v.questions, p_answers))
  returning * into a;
  perform evx_log(p_event, 'checked_in', auth.uid(), jsonb_build_object('how', 'code', 'late', a.late, 'walk_in', a.walk_in));
  return jsonb_build_object('status', 'in', 'checked_in_at', a.checked_in_at, 'late', a.late);
end;
$$;

/** Check someone in by hand (host, co-host or Admin). p_late null: worked out from the time. */
create or replace function public.ev_host_check_in(p_event uuid, p_user uuid, p_late boolean default null, p_answers jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v ev_events;
  a ev_attendance;
  v_invited boolean;
begin
  v := evx_require_runs(p_event);
  if not is_member(p_user) then raise exception 'Only team members can be checked in.'; end if;
  if exists (select 1 from ev_attendance where event_id = p_event and user_id = p_user) then
    raise exception 'They''re already checked in.' using errcode = 'OS409';
  end if;
  v_invited := exists (select 1 from ev_invitees where event_id = p_event and user_id = p_user);
  insert into ev_attendance (event_id, user_id, how, by_id, by_name, late, walk_in, answers, checked_in_at)
  values (p_event, p_user, 'host', auth.uid(), coalesce(my_display_name(), ''),
          coalesce(p_late, v.late_after_min is not null and now() > v.starts_at + make_interval(mins => v.late_after_min)),
          not v_invited, case when jsonb_typeof(p_answers) = 'object' then p_answers else '{}' end,
          case when now() < v.starts_at then v.starts_at else now() end)
  returning * into a;
  perform evx_log(p_event, 'checked_in', p_user, jsonb_build_object('how', 'host', 'late', a.late, 'walk_in', a.walk_in));
  return to_jsonb(a);
end;
$$;

/** Change late / answers on a check-in, or undo it (host, co-host or Admin). */
create or replace function public.ev_set_late(p_event uuid, p_user uuid, p_late boolean)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform evx_require_runs(p_event);
  update ev_attendance set late = p_late where event_id = p_event and user_id = p_user;
  if not found then raise exception 'They aren''t checked in.' using errcode = 'P0002'; end if;
  perform evx_log(p_event, case when p_late then 'marked_late' else 'marked_on_time' end, p_user);
end;
$$;

create or replace function public.ev_remove_attendance(p_event uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare a ev_attendance;
begin
  perform evx_require_runs(p_event);
  delete from ev_attendance where event_id = p_event and user_id = p_user returning * into a;
  if a.user_id is null then raise exception 'They aren''t checked in.' using errcode = 'P0002'; end if;
  perform evx_log(p_event, 'check_in_undone', p_user, jsonb_build_object('was', to_jsonb(a) - 'event_id' - 'user_id'));
  return to_jsonb(a);
end;
$$;

/** Put back a check-in that was undone (Undo after "Remove"), as it was. */
create or replace function public.ev_restore_attendance(p_event uuid, p_user uuid, p_was jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform evx_require_runs(p_event);
  insert into ev_attendance (event_id, user_id, checked_in_at, how, by_id, by_name, late, walk_in, answers)
  values (p_event, p_user, coalesce((p_was ->> 'checked_in_at')::timestamptz, now()), coalesce(nullif(p_was ->> 'how', ''), 'host'),
          nullif(p_was ->> 'by_id', '')::uuid, coalesce(p_was ->> 'by_name', ''), coalesce((p_was ->> 'late')::boolean, false),
          coalesce((p_was ->> 'walk_in')::boolean, false), case when jsonb_typeof(p_was -> 'answers') = 'object' then p_was -> 'answers' else '{}' end)
  on conflict do nothing;
  perform evx_log(p_event, 'check_in_restored', p_user);
end;
$$;

/** Excuse someone invited (or take it back), with a note (host, co-host, Admin, or "See attendance"). */
create or replace function public.ev_set_excused(p_event uuid, p_user uuid, p_excused boolean, p_note text default '')
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform evx_require_member();
  if not ev_runs(p_event) and not ev_sees_all() then raise exception 'Only the event''s hosts or people who can see attendance can excuse someone.' using errcode = '42501'; end if;
  update ev_invitees set excused = p_excused, excused_note = case when p_excused then left(trim(coalesce(p_note, '')), 500) else '' end,
         excused_by = case when p_excused then coalesce(my_display_name(), '') else '' end
  where event_id = p_event and user_id = p_user;
  if not found then raise exception 'Only people who were invited can be excused.' using errcode = 'P0002'; end if;
  perform evx_log(p_event, case when p_excused then 'excused' else 'unexcused' end, p_user, jsonb_build_object('note', coalesce(p_note, '')));
end;
$$;

-- ---- categories and templates ---------------------------------------------------------------------
/** Add or change a category: name, color, sort, archived. "Create events" or Admin. */
create or replace function public.ev_save_category(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare c ev_categories;
begin
  perform evx_require_member();
  if not has_permission('events.create') and not is_admin() then raise exception 'Your role can''t change the categories (it needs "Create events").' using errcode = '42501'; end if;
  if p_id is null then
    insert into ev_categories (name, color, sort) values (trim(coalesce(p ->> 'name', '')), coalesce(nullif(p ->> 'color', ''), 'blue'),
      coalesce(nullif(p ->> 'sort', '')::int, (select coalesce(max(sort), 0) + 10 from ev_categories)))
    returning * into c;
  else
    update ev_categories set
      name = case when p ? 'name' then trim(coalesce(p ->> 'name', '')) else name end,
      color = coalesce(nullif(p ->> 'color', ''), color),
      sort = coalesce(nullif(p ->> 'sort', '')::int, sort),
      archived_at = case when p ? 'archived' then case when (p ->> 'archived')::boolean then coalesce(archived_at, now()) end else archived_at end,
      updated_at = now()
    where id = p_id returning * into c;
    if c.id is null then raise exception 'That category doesn''t exist.' using errcode = 'P0002'; end if;
  end if;
  return to_jsonb(c);
exception when unique_violation then
  raise exception 'There''s already a category called "%".', trim(p ->> 'name') using errcode = 'OS412';
end;
$$;

/** Save a set of sign-in questions to reuse (p_id null: new). p: name, questions, archived. */
create or replace function public.ev_save_template(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare t ev_templates;
begin
  perform evx_require_member();
  if not has_permission('events.create') and not is_admin() then raise exception 'Your role can''t save question sets (it needs "Create events").' using errcode = '42501'; end if;
  if p_id is null then
    insert into ev_templates (name, questions, created_by) values (trim(coalesce(p ->> 'name', '')), evx_questions(p -> 'questions'), auth.uid())
    returning * into t;
  else
    update ev_templates set
      name = case when p ? 'name' then trim(coalesce(p ->> 'name', '')) else name end,
      questions = case when p ? 'questions' then evx_questions(p -> 'questions') else questions end,
      archived_at = case when p ? 'archived' then case when (p ->> 'archived')::boolean then coalesce(archived_at, now()) end else archived_at end,
      updated_at = now()
    where id = p_id returning * into t;
    if t.id is null then raise exception 'That question set doesn''t exist.' using errcode = 'P0002'; end if;
  end if;
  return to_jsonb(t);
end;
$$;

-- ---- grants -------------------------------------------------------------------------------------
revoke execute on function public.ev_sees_all(), public.ev_runs(uuid), public.ev_sees(uuid), public.evx_require_member(),
  public.evx_require_runs(uuid), public.evx_log(uuid, text, uuid, jsonb), public.ev_invite_people(jsonb), public.evx_sync_invitees(uuid),
  public.ev_sync(), public.evx_questions(jsonb), public.evx_answers(jsonb, jsonb), public.ev_save_event(uuid, jsonb), public.ev_delete_event(uuid),
  public.ev_rsvp(uuid, text, text), public.evx_code(uuid, bigint), public.ev_set_checkin(uuid, boolean), public.ev_checkin_code(uuid),
  public.ev_checkin_info(uuid), public.ev_check_in(uuid, text, jsonb), public.ev_host_check_in(uuid, uuid, boolean, jsonb),
  public.ev_set_late(uuid, uuid, boolean), public.ev_remove_attendance(uuid, uuid), public.ev_restore_attendance(uuid, uuid, jsonb),
  public.ev_set_excused(uuid, uuid, boolean, text), public.ev_save_category(uuid, jsonb), public.ev_save_template(uuid, jsonb)
  from public, anon;
-- Row-level security calls these three as the person.
grant execute on function public.ev_sees_all(), public.ev_runs(uuid), public.ev_sees(uuid) to authenticated;
grant execute on function public.ev_sync(), public.ev_save_event(uuid, jsonb), public.ev_delete_event(uuid), public.ev_rsvp(uuid, text, text),
  public.ev_set_checkin(uuid, boolean), public.ev_checkin_code(uuid), public.ev_checkin_info(uuid), public.ev_check_in(uuid, text, jsonb),
  public.ev_host_check_in(uuid, uuid, boolean, jsonb), public.ev_set_late(uuid, uuid, boolean), public.ev_remove_attendance(uuid, uuid),
  public.ev_restore_attendance(uuid, uuid, jsonb), public.ev_set_excused(uuid, uuid, boolean, text), public.ev_save_category(uuid, jsonb),
  public.ev_save_template(uuid, jsonb)
  to authenticated;

select public.migration_done(64, '064_events.sql');
