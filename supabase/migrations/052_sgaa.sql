select public.migration_begin(52);

-- =============================================================================
-- 052: SGAA: the Solar Gators Alumni Association hub (sgaa/)
-- =============================================================================
--
--   A place where alumni see what the team needs and how they can help, and reach the people on the team who
--   can tell them more. No money is tracked here: no pledges, no payments, no link to Orders.
--
--   Public (no sign-in): what we need, how to help, updates, events. One call: sgaa_hub().
--   Signed in as an alum or on the team: contact a designated person (the message is emailed to them, with
--   the alum's address as reply-to; team addresses are never shown), RSVP to events, the alumni directory.
--
--   Who is an alum
--     * A former member (044) marked as an alum: Admin → Users → "Graduated" (graduate_person), or
--       sgaa_set_alum for someone deactivated earlier. Alums can still sign in, but only see SGAA and their
--       account, never the team's data (they have no role permissions: is_member() is false for them).
--     * An alum who never had an account signs up (a Guest), asks to join as an alum (sgaa_request_alum), and
--       someone with "Approve alumni" says yes (sgaa_review_alum).
--     * Someone deactivated for another reason stays blocked, as before.
--
--   Permissions (Admin → Roles & permissions):
--     sgaa.edit      Edit the alumni hub: needs, how to help, contacts, updates and events.
--     sgaa.messages  See every message alumni sent (each contact always sees their own).
--     sgaa.alumni    Approve alumni who sign up, and see who asked.
--
--   Projects (051): a project or a work item can be shared with alumni (sgaa_share_from_projects). That makes
--   a linked need; when the work item is done, the need shows as met.
-- =============================================================================

-- ---- permissions -------------------------------------------------------------------------------
insert into public.permissions (key, label, description, sort) values
  ('sgaa.edit', 'Edit the alumni hub', 'SGAA: write what the team needs and how alumni can help, choose the people alumni can contact, and post updates and events.', 60),
  ('sgaa.messages', 'See alumni messages', 'SGAA: read every message alumni sent to the team''s contacts (each contact always sees the ones sent to them).', 61),
  ('sgaa.alumni', 'Approve alumni', 'SGAA: see who asked to join as an alum, and approve or decline them.', 62)
on conflict (key) do nothing;

insert into public.role_permissions (role, permission)
select v.role, v.permission
from (values ('ce', 'sgaa.edit'), ('ce', 'sgaa.alumni'),
             ('eboard', 'sgaa.edit'), ('eboard', 'sgaa.messages'), ('eboard', 'sgaa.alumni'),
             ('coordinator', 'sgaa.edit'), ('coordinator', 'sgaa.messages'), ('coordinator', 'sgaa.alumni'),
             ('admin', 'sgaa.edit'), ('admin', 'sgaa.messages'), ('admin', 'sgaa.alumni')) v(role, permission)
where exists (select 1 from public.roles r where r.key = v.role)
on conflict do nothing;
select public.record_permissions_snapshot();

-- Emails to contacts use the existing outbox as the event "sgaa_message". On by default once email is set up:
-- an alum who writes expects it to arrive. (The message is in SGAA → Messages either way.)
-- Its wording is editable in Admin → Notifications like the others; replies go to the alum (Reply-To).
update public.app_settings
set value = jsonb_set(value, '{events,sgaa_message}', '{"email": true, "teams": false}'::jsonb, true)
where key = 'notifications' and jsonb_typeof(value -> 'events') = 'object' and not (value -> 'events') ? 'sgaa_message';
update public.app_settings
set value = jsonb_set(value, '{templates,sgaa_message}', jsonb_build_object(
  'subject', 'Alumni hub: {what}',
  'body', 'Hi {first_name}, {from_name} ({from_kind}) sent you a message on the alumni hub.' || chr(10) || 'About: {need}' || chr(10)
          || '{details}' || chr(10) || 'Reply to this email to answer {from_name} directly.'), true)
where key = 'notifications' and jsonb_typeof(value -> 'templates') = 'object' and not (value -> 'templates') ? 'sgaa_message';

-- The hub's own words (Manage → Pages). Read through sgaa_hub(); written with sgaa_save_settings().
insert into public.app_settings (key, value) values ('sgaa', jsonb_build_object(
  'title', 'Solar Gators Alumni',
  'intro', 'Solar Gators alumni keep the team on the road. Here''s what the team is working on, what it needs, and how you can help.',
  'howToHelp', 'There are many ways to help:' || chr(10) || chr(10)
    || '- **Give.** Donations go through the UF Foundation, so they''re tax-deductible.' || chr(10)
    || '- **Parts and materials.** If your company makes or sells something on our list, tell us.' || chr(10)
    || '- **Mentor.** Answer a student''s question, review a design, or join a design review.' || chr(10)
    || '- **Connect us.** Introduce us to a sponsor or a company that might be interested.' || chr(10) || chr(10)
    || 'Not sure where to start? Contact one of the people below and they''ll point you the right way.',
  'giveUrl', '',
  'giveLabel', 'Give through the UF Foundation'))
on conflict (key) do nothing;

-- ---- who is who ----------------------------------------------------------------------------------
/** Text tidied and capped, never null. */
create or replace function public.sgaa_text(p text, p_max int)
returns text
language sql immutable set search_path = public, pg_temp
as $$ select left(trim(coalesce(p, '')), p_max) $$;

create table public.sgaa_alumni (
  user_id       uuid primary key references public.profiles(id) on delete cascade,
  -- null: a team member who filled in their directory card early; pending / declined: asked to join as an alum.
  status        text check (status in ('pending', 'alum', 'declined')),
  grad_year     int check (grad_year between 1990 and 2100),
  major         text not null default '' check (length(major) <= 80),
  employer      text not null default '' check (length(employer) <= 120),
  job_title     text not null default '' check (length(job_title) <= 120),
  city          text not null default '' check (length(city) <= 80),
  linkedin      text not null default '' check (length(linkedin) <= 200),
  mentor_topics text not null default '' check (length(mentor_topics) <= 300),
  bio           text not null default '' check (length(bio) <= 1000),
  team_roles    text not null default '' check (length(team_roles) <= 200),   -- "Battery lead, 2021–22", in their words
  listed        boolean not null default true,                                  -- in the directory at all
  -- Who sees each field: 'all' (alumni and the team), 'team' (only the current team), 'hidden'.
  visibility    jsonb not null default '{"employer": "all", "job_title": "all", "city": "all", "linkedin": "all",
                                         "mentor_topics": "all", "bio": "all", "major": "all", "team_roles": "all", "email": "hidden"}',
  request_note  text not null default '' check (length(request_note) <= 1000),
  requested_at  timestamptz,
  reviewed_by   uuid references public.profiles(id) on delete set null,
  reviewed_name text not null default '',
  reviewed_at   timestamptz,
  review_note   text not null default '',
  updated_at    timestamptz not null default now()
);

/** An alum: a former member marked as an alum (they may sign in, but only to SGAA). */
create or replace function public.sgaa_is_alum(p_user uuid default null)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(p_user, auth.uid()) is not null
     and is_former_member(coalesce(p_user, auth.uid()))
     and exists (select 1 from sgaa_alumni where user_id = coalesce(p_user, auth.uid()) and status = 'alum');
$$;

/** May use the signed-in parts of SGAA (contact, RSVP, directory): on the team, or an alum. */
create or replace function public.sgaa_insider()
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$ select auth.uid() is not null and (is_member() or sgaa_is_alum()) $$;

/** On the team and holding this SGAA permission. */
create or replace function public.sgaa_can(p_perm text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$ select auth.uid() is not null and is_member() and has_permission(p_perm) $$;

create or replace function public.sgaa_require(p_perm text)
returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'You must be signed in.' using errcode = '42501'; end if;
  if not sgaa_can(p_perm) then
    raise exception 'Your role can''t do this in SGAA (it needs "%").',
      coalesce((select label from permissions where key = p_perm), p_perm) using errcode = '42501';
  end if;
end;
$$;

create or replace function public.sgaa_require_insider()
returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if sgaa_insider() then return; end if;
  if exists (select 1 from sgaa_alumni where user_id = auth.uid() and status = 'pending') then
    raise exception 'Your alumni account is waiting to be approved. You''ll get access as soon as someone on the team approves it.' using errcode = '42501';
  end if;
  raise exception 'This is for Solar Gators alumni and the team. If you''re an alum, ask to join as one first.' using errcode = '42501';
end;
$$;

-- ---- needs, contacts, updates, events, messages -----------------------------------------------
create table public.sgaa_contacts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  title      text not null check (length(trim(title)) between 1 and 80),        -- "Business Coordinator"
  blurb      text not null default '' check (length(blurb) <= 500),            -- "Ask me about sponsorships and giving"
  topics     text[] not null default '{}',
  active     boolean not null default true,
  sort       int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.sgaa_needs (
  id            uuid primary key default gen_random_uuid(),
  title         text not null check (length(trim(title)) between 1 and 120),
  summary       text not null default '' check (length(summary) <= 300),
  body          text not null default '' check (length(body) <= 10000),
  photo_path    text not null default '' check (length(photo_path) <= 300),
  cost_estimate numeric(12, 2) check (cost_estimate is null or cost_estimate >= 0),
  quantity      text not null default '' check (length(quantity) <= 80),      -- "4 sheets", "about 200 cells"
  subsystem     text not null default '' check (length(subsystem) <= 80),
  kind          text not null default 'parts' check (kind in ('parts', 'money', 'expertise', 'other')),
  urgency       text not null default 'normal' check (urgency in ('low', 'normal', 'high')),
  status        text not null default 'draft' check (status in ('draft', 'open', 'met', 'archived')),
  contact_id    uuid references public.sgaa_contacts(id) on delete set null,
  pm_project_id uuid references public.pm_projects(id) on delete set null,
  pm_item_id    uuid references public.pm_items(id) on delete set null,
  met_note      text not null default '' check (length(met_note) <= 300),   -- "Thanks to a 2019 alum at …"
  sort          int not null default 100,
  published_at  timestamptz,
  met_at        timestamptz,
  created_by    uuid references public.profiles(id) on delete set null,
  updated_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index sgaa_needs_one_per_item on public.sgaa_needs (pm_item_id) where pm_item_id is not null and status <> 'archived';
create unique index sgaa_needs_one_per_project on public.sgaa_needs (pm_project_id)
  where pm_project_id is not null and pm_item_id is null and status <> 'archived';

create table public.sgaa_updates (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(trim(title)) between 1 and 140),
  body        text not null default '' check (length(body) <= 10000),
  need_id     uuid references public.sgaa_needs(id) on delete set null,
  pinned      boolean not null default false,
  published   boolean not null default false,
  author_id   uuid references public.profiles(id) on delete set null,
  author_name text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.sgaa_update_images (
  id        uuid primary key default gen_random_uuid(),
  update_id uuid not null references public.sgaa_updates(id) on delete cascade,
  path      text not null check (length(path) between 1 and 300),
  caption   text not null default '' check (length(caption) <= 200),
  sort      int not null default 0
);

create table public.sgaa_events (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (length(trim(title)) between 1 and 140),
  body       text not null default '' check (length(body) <= 5000),
  location   text not null default '' check (length(location) <= 200),
  starts_at  timestamptz not null,
  ends_at    timestamptz check (ends_at is null or ends_at >= starts_at),
  capacity   int check (capacity is null or capacity > 0),
  rsvp_open  boolean not null default true,
  published  boolean not null default false,
  cancelled  boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.sgaa_rsvps (
  event_id   uuid not null references public.sgaa_events(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  guests     int not null default 0 check (guests between 0 and 5),
  note       text not null default '' check (length(note) <= 300),
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create table public.sgaa_messages (
  id           uuid primary key default gen_random_uuid(),
  from_id      uuid references public.profiles(id) on delete set null,
  from_name    text not null,
  from_email   text not null,
  contact_id   uuid references public.sgaa_contacts(id) on delete set null,
  to_id        uuid references public.profiles(id) on delete set null,
  to_name      text not null,
  need_id      uuid references public.sgaa_needs(id) on delete set null,
  need_title   text not null default '',
  subject      text not null check (length(trim(subject)) between 1 and 150),
  body         text not null check (length(trim(body)) between 1 and 5000),
  emailed      boolean not null default false,
  created_at   timestamptz not null default now()
);
create index sgaa_messages_from on public.sgaa_messages (from_id, created_at);

-- ---- reading ---------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['sgaa_alumni', 'sgaa_contacts', 'sgaa_needs', 'sgaa_updates', 'sgaa_update_images',
                           'sgaa_events', 'sgaa_rsvps', 'sgaa_messages'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  foreach t in array array['sgaa_needs', 'sgaa_updates', 'sgaa_update_images', 'sgaa_events'] loop
    execute format('grant select on public.%I to anon', t);
  end loop;
end;
$$;

-- What's public is public to everyone; editors also see drafts.
create policy "public" on public.sgaa_needs for select to anon using (status in ('open', 'met'));
create policy "readers" on public.sgaa_needs for select to authenticated using (status in ('open', 'met') or sgaa_can('sgaa.edit'));
create policy "public" on public.sgaa_updates for select to anon using (published);
create policy "readers" on public.sgaa_updates for select to authenticated using (published or sgaa_can('sgaa.edit'));
create policy "public" on public.sgaa_update_images for select to anon
  using (exists (select 1 from sgaa_updates u where u.id = update_id and u.published));
create policy "readers" on public.sgaa_update_images for select to authenticated
  using (exists (select 1 from sgaa_updates u where u.id = update_id and (u.published or sgaa_can('sgaa.edit'))));
create policy "public" on public.sgaa_events for select to anon using (published);
create policy "readers" on public.sgaa_events for select to authenticated using (published or sgaa_can('sgaa.edit'));
-- Contacts are listed by sgaa_hub() (names only for alumni and the team; never an email).
create policy "editors" on public.sgaa_contacts for select to authenticated using (sgaa_can('sgaa.edit'));
create policy "own or editors" on public.sgaa_rsvps for select to authenticated using (user_id = auth.uid() or sgaa_can('sgaa.edit'));
create policy "sender, recipient, or messages" on public.sgaa_messages for select to authenticated
  using (from_id = auth.uid() or to_id = auth.uid() or sgaa_can('sgaa.messages'));
-- Your own card; approvers see requests. The directory is sgaa_directory().
create policy "own or approvers" on public.sgaa_alumni for select to authenticated
  using (user_id = auth.uid() or sgaa_can('sgaa.alumni') or sgaa_can('users.manage'));

/**
 * Everything the public pages show, in one call (works signed out). Contacts' names only for alumni and the
 * team. "viewer" says what the page may offer: 'anon', 'guest', 'pending', 'alum', 'team'.
 */
create or replace function public.sgaa_hub()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_insider boolean := sgaa_insider();
  v_viewer  text;
begin
  v_viewer := case
    when auth.uid() is null then 'anon'
    when is_member() then 'team'
    when sgaa_is_alum() then 'alum'
    when exists (select 1 from sgaa_alumni where user_id = auth.uid() and status = 'pending') then 'pending'
    when is_former_member() then 'former'
    else 'guest' end;
  return jsonb_build_object(
    'viewer', v_viewer,
    'canEdit', sgaa_can('sgaa.edit'),
    'canMessages', sgaa_can('sgaa.messages'),
    'canAlumni', sgaa_can('sgaa.alumni'),
    'settings', coalesce((select value from app_settings where key = 'sgaa'), '{}'),
    'needs', coalesce((
      select jsonb_agg(jsonb_build_object('id', n.id, 'title', n.title, 'summary', n.summary, 'body', n.body,
        'photo', n.photo_path, 'cost', n.cost_estimate, 'quantity', n.quantity, 'subsystem', n.subsystem, 'kind', n.kind,
        'urgency', n.urgency, 'status', n.status, 'contactId', n.contact_id, 'metNote', n.met_note, 'metAt', n.met_at,
        'publishedAt', n.published_at, 'project', (select p.name from pm_projects p where p.id = n.pm_project_id))
        order by (n.status = 'met'), case n.urgency when 'high' then 0 when 'normal' then 1 else 2 end, n.sort, n.published_at desc)
      from sgaa_needs n
      where n.status = 'open' or (n.status = 'met' and n.met_at > now() - interval '1 year')), '[]'),
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'blurb', c.blurb, 'topics', c.topics,
        'name', case when v_insider then p.full_name else null end) order by c.sort, c.title)
      from sgaa_contacts c join profiles p on p.id = c.user_id
      where c.active and is_member(c.user_id)), '[]'),
    'updates', coalesce((
      select jsonb_agg(jsonb_build_object('id', u.id, 'title', u.title, 'body', u.body, 'needId', u.need_id, 'pinned', u.pinned,
        'author', u.author_name, 'at', u.created_at,
        'images', coalesce((select jsonb_agg(jsonb_build_object('path', i.path, 'caption', i.caption) order by i.sort)
                            from sgaa_update_images i where i.update_id = u.id), '[]'))
        order by u.pinned desc, u.created_at desc)
      from (select * from sgaa_updates where published order by pinned desc, created_at desc limit 40) u), '[]'),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title, 'body', e.body, 'location', e.location,
        'startsAt', e.starts_at, 'endsAt', e.ends_at, 'capacity', e.capacity, 'rsvpOpen', e.rsvp_open, 'cancelled', e.cancelled,
        'going', (select coalesce(sum(1 + r.guests), 0) from sgaa_rsvps r where r.event_id = e.id),
        'mine', (select jsonb_build_object('guests', r.guests, 'note', r.note) from sgaa_rsvps r
                 where r.event_id = e.id and r.user_id = auth.uid()))
        order by e.starts_at)
      from sgaa_events e
      where e.published and coalesce(e.ends_at, e.starts_at) > now() - interval '180 days'), '[]'));
end;
$$;

-- ---- editing: needs, contacts, updates, events, the hub's words ------------------------------------
create or replace function public.sgaa_save_need(p_id uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id     uuid := p_id;
  v_status text := coalesce(nullif(p ->> 'status', ''), 'draft');
  v_cost   numeric;
  v_old    sgaa_needs;
begin
  perform sgaa_require('sgaa.edit');
  if v_status not in ('draft', 'open', 'met', 'archived') then raise exception 'Unknown status "%".', v_status; end if;
  begin
    v_cost := nullif(trim(coalesce(p ->> 'cost', '')), '')::numeric;
  exception when others then
    raise exception 'The rough cost has to be a number.';
  end;
  if p ? 'contactId' and nullif(p ->> 'contactId', '') is not null
     and not exists (select 1 from sgaa_contacts where id = (p ->> 'contactId')::uuid) then
    raise exception 'That contact no longer exists.';
  end if;
  if v_id is null then
    insert into sgaa_needs (title, created_by) values (sgaa_text(p ->> 'title', 120), auth.uid()) returning id into v_id;
  end if;
  select * into v_old from sgaa_needs where id = v_id for update;
  if v_old.id is null then raise exception 'That need no longer exists.'; end if;
  update sgaa_needs set
    title         = sgaa_text(coalesce(p ->> 'title', title), 120),
    summary       = sgaa_text(coalesce(p ->> 'summary', summary), 300),
    body          = sgaa_text(coalesce(p ->> 'body', body), 10000),
    photo_path    = sgaa_text(coalesce(p ->> 'photo', photo_path), 300),
    cost_estimate = case when p ? 'cost' then v_cost else cost_estimate end,
    quantity      = sgaa_text(coalesce(p ->> 'quantity', quantity), 80),
    subsystem     = sgaa_text(coalesce(p ->> 'subsystem', subsystem), 80),
    kind          = coalesce(nullif(p ->> 'kind', ''), kind),
    urgency       = coalesce(nullif(p ->> 'urgency', ''), urgency),
    contact_id    = case when p ? 'contactId' then nullif(p ->> 'contactId', '')::uuid else contact_id end,
    met_note      = sgaa_text(coalesce(p ->> 'metNote', met_note), 300),
    sort          = coalesce((p ->> 'sort')::int, sort),
    status        = v_status,
    published_at  = case when v_status in ('open', 'met') then coalesce(published_at, now()) else published_at end,
    met_at        = case when v_status = 'met' then coalesce(met_at, now()) when v_status = 'open' then null else met_at end,
    updated_by    = auth.uid(),
    updated_at    = now()
  where id = v_id;
  if (select length(trim(title)) from sgaa_needs where id = v_id) = 0 then raise exception 'Give the need a title.'; end if;
  return v_id;
end;
$$;

/** Delete a need. Only drafts; anything alumni have seen is archived instead (it stays in messages and updates). */
create or replace function public.sgaa_delete_need(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform sgaa_require('sgaa.edit');
  if exists (select 1 from sgaa_needs where id = p_id and published_at is not null) then
    update sgaa_needs set status = 'archived', updated_by = auth.uid(), updated_at = now() where id = p_id;
  else
    delete from sgaa_needs where id = p_id;
  end if;
end;
$$;

create or replace function public.sgaa_save_contact(p_id uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id   uuid := p_id;
  v_user uuid := nullif(p ->> 'userId', '')::uuid;
begin
  perform sgaa_require('sgaa.edit');
  if v_id is null then
    if v_user is null then raise exception 'Choose who alumni will be contacting.'; end if;
    insert into sgaa_contacts (user_id, title) values (v_user, coalesce(nullif(sgaa_text(p ->> 'title', 80), ''), 'Contact'))
    returning id into v_id;
  end if;
  update sgaa_contacts set
    user_id    = coalesce(v_user, user_id),
    title      = coalesce(nullif(sgaa_text(p ->> 'title', 80), ''), title),
    blurb      = sgaa_text(coalesce(p ->> 'blurb', blurb), 500),
    topics     = case when p ? 'topics' then
                   coalesce((select array_agg(sgaa_text(t, 40)) from jsonb_array_elements_text(p -> 'topics') t where trim(t) <> ''), '{}')
                 else topics end,
    active     = coalesce((p ->> 'active')::boolean, active),
    sort       = coalesce((p ->> 'sort')::int, sort),
    updated_at = now()
  where id = v_id;
  if not found then raise exception 'That contact no longer exists.'; end if;
  if not is_member((select user_id from sgaa_contacts where id = v_id)) then
    raise exception 'Contacts have to be on the team (accepted, not deactivated).';
  end if;
  return v_id;
end;
$$;

create or replace function public.sgaa_delete_contact(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform sgaa_require('sgaa.edit');
  delete from sgaa_contacts where id = p_id;   -- needs and old messages keep working (contact_id → null)
end;
$$;

/** p: { title, body, needId, pinned, published, images: [{ path, caption }] }. Images are replaced as a set. */
create or replace function public.sgaa_save_update(p_id uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id  uuid := p_id;
  v_img jsonb;
  v_n   int := 0;
begin
  perform sgaa_require('sgaa.edit');
  if v_id is null then
    insert into sgaa_updates (title, author_id, author_name)
    values (coalesce(nullif(sgaa_text(p ->> 'title', 140), ''), 'Update'), auth.uid(), coalesce(my_display_name(), ''))
    returning id into v_id;
  end if;
  update sgaa_updates set
    title      = coalesce(nullif(sgaa_text(p ->> 'title', 140), ''), title),
    body       = sgaa_text(coalesce(p ->> 'body', body), 10000),
    need_id    = case when p ? 'needId' then nullif(p ->> 'needId', '')::uuid else need_id end,
    pinned     = coalesce((p ->> 'pinned')::boolean, pinned),
    published  = coalesce((p ->> 'published')::boolean, published),
    updated_at = now()
  where id = v_id;
  if not found then raise exception 'That update no longer exists.'; end if;
  if p ? 'images' then
    if jsonb_array_length(coalesce(p -> 'images', '[]')) > 12 then raise exception 'Up to 12 photos per update.'; end if;
    delete from sgaa_update_images where update_id = v_id;
    for v_img in select * from jsonb_array_elements(coalesce(p -> 'images', '[]')) loop
      if coalesce(v_img ->> 'path', '') !~ '^updates/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,120}$' then
        raise exception 'That photo wasn''t uploaded to SGAA.';
      end if;
      insert into sgaa_update_images (update_id, path, caption, sort) values (v_id, v_img ->> 'path', sgaa_text(v_img ->> 'caption', 200), v_n);
      v_n := v_n + 1;
    end loop;
  end if;
  return v_id;
end;
$$;

create or replace function public.sgaa_delete_update(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform sgaa_require('sgaa.edit');
  delete from sgaa_updates where id = p_id;
end;
$$;

create or replace function public.sgaa_save_event(p_id uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id    uuid := p_id;
  v_start timestamptz;
  v_end   timestamptz;
  v_cap   int;
begin
  perform sgaa_require('sgaa.edit');
  begin
    v_start := nullif(p ->> 'startsAt', '')::timestamptz;
    v_end := nullif(p ->> 'endsAt', '')::timestamptz;
    v_cap := nullif(p ->> 'capacity', '')::int;
  exception when others then
    raise exception 'Check the date, time and capacity.';
  end;
  if v_id is not null and not exists (select 1 from sgaa_events where id = v_id) then raise exception 'That event no longer exists.'; end if;
  if coalesce(case when p ? 'endsAt' then v_end else (select ends_at from sgaa_events where id = v_id) end, 'infinity')
     < coalesce(v_start, (select starts_at from sgaa_events where id = v_id), '-infinity') then
    raise exception 'It can''t end before it starts.';
  end if;
  if v_id is null then
    if v_start is null then raise exception 'When does it start?'; end if;
    insert into sgaa_events (title, starts_at, created_by)
    values (coalesce(nullif(sgaa_text(p ->> 'title', 140), ''), 'Event'), v_start, auth.uid()) returning id into v_id;
  end if;
  update sgaa_events set
    title      = coalesce(nullif(sgaa_text(p ->> 'title', 140), ''), title),
    body       = sgaa_text(coalesce(p ->> 'body', body), 5000),
    location   = sgaa_text(coalesce(p ->> 'location', location), 200),
    starts_at  = coalesce(v_start, starts_at),
    ends_at    = case when p ? 'endsAt' then v_end else ends_at end,
    capacity   = case when p ? 'capacity' then v_cap else capacity end,
    rsvp_open  = coalesce((p ->> 'rsvpOpen')::boolean, rsvp_open),
    published  = coalesce((p ->> 'published')::boolean, published),
    cancelled  = coalesce((p ->> 'cancelled')::boolean, cancelled),
    updated_at = now()
  where id = v_id;
  return v_id;
end;
$$;

create or replace function public.sgaa_delete_event(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform sgaa_require('sgaa.edit');
  if exists (select 1 from sgaa_rsvps where event_id = p_id) then
    raise exception 'People have RSVP''d. Cancel the event instead, so they can see it''s off.';
  end if;
  delete from sgaa_events where id = p_id;
end;
$$;

/** Who's coming (editors). */
create or replace function public.sgaa_event_rsvps(p_event uuid)
returns table (user_id uuid, full_name text, email text, guests int, note text, alum boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform sgaa_require('sgaa.edit');
  return query
    select r.user_id, p.full_name, p.email, r.guests, r.note, sgaa_is_alum(r.user_id), r.created_at
    from sgaa_rsvps r join profiles p on p.id = r.user_id
    where r.event_id = p_event order by r.created_at;
end;
$$;

/** The hub's words: { title, intro, howToHelp, giveUrl, giveLabel }. */
create or replace function public.sgaa_save_settings(p jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v jsonb := coalesce((select value from app_settings where key = 'sgaa'), '{}');
begin
  perform sgaa_require('sgaa.edit');
  if coalesce(p ->> 'giveUrl', '') <> '' and p ->> 'giveUrl' !~ '^https://' then
    raise exception 'The giving link has to start with https://';
  end if;
  -- Only the fields sent change.
  v := v || coalesce((select jsonb_object_agg(k, sgaa_text(p ->> k, m)) from (values ('title', 80), ('intro', 1000), ('howToHelp', 10000),
    ('giveUrl', 300), ('giveLabel', 60)) f(k, m) where p ? k), '{}');
  insert into app_settings (key, value) values ('sgaa', v) on conflict (key) do update set value = excluded.value;
end;
$$;

-- ---- signed-in alumni and the team: contact, RSVP --------------------------------------------------
/** Send a message to a contact. Emailed to them (reply goes to the sender); kept in SGAA → Messages. */
create or replace function public.sgaa_send_message(p_contact uuid, p_need uuid, p_subject text, p_body text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_me       profiles;
  v_to       profiles;
  v_contact  sgaa_contacts;
  v_need     sgaa_needs;
  v_id       uuid;
  v_settings jsonb := (select value from app_settings where key = 'notifications');
  v_ev       jsonb := v_settings -> 'events' -> 'sgaa_message';
  v_mail     boolean := false;
begin
  perform sgaa_require_insider();
  if length(trim(coalesce(p_body, ''))) = 0 then raise exception 'Write a message first.'; end if;
  if length(p_body) > 5000 then raise exception 'That message is too long (5,000 characters at most).'; end if;
  if (select count(*) from sgaa_messages where from_id = auth.uid() and created_at > now() - interval '1 hour') >= 5
     or (select count(*) from sgaa_messages where from_id = auth.uid() and created_at > now() - interval '1 day') >= 20 then
    raise exception 'You''ve sent a lot of messages recently. Please wait a little before sending more.';
  end if;
  select * into v_me from profiles where id = auth.uid();
  select * into v_need from sgaa_needs where id = p_need and status in ('open', 'met');
  select * into v_contact from sgaa_contacts where id = coalesce(p_contact, v_need.contact_id) and active;
  if v_contact.id is null then raise exception 'Choose who to contact.'; end if;
  select * into v_to from profiles where id = v_contact.user_id;
  if v_to.id is null or not is_member(v_to.id) then raise exception 'That person isn''t a contact anymore. Choose someone else.'; end if;

  insert into sgaa_messages (from_id, from_name, from_email, contact_id, to_id, to_name, need_id, need_title, subject, body)
  values (v_me.id, coalesce(nullif(v_me.full_name, ''), v_me.email), v_me.email, v_contact.id, v_to.id, v_to.full_name,
          v_need.id, coalesce(v_need.title, ''),
          coalesce(nullif(sgaa_text(p_subject, 150), ''), nullif(v_need.title, ''), 'A message from an alum'),
          trim(p_body))
  returning id into v_id;

  if v_settings is not null and (v_settings -> 'enabled') = 'true'::jsonb
     and (v_ev -> 'email') is distinct from 'false'::jsonb then   -- on unless an Admin turned it off
    insert into notification_outbox (event, recipient_id, email, channel, payload)
    values ('sgaa_message', v_to.id, v_to.email, 'email', jsonb_build_object(
      'recipient_name', v_to.full_name,
      'from_name', coalesce(nullif(v_me.full_name, ''), v_me.email),
      'from_kind', case when sgaa_is_alum() then 'an alum' else 'the team' end,
      'reply_to', v_me.email,
      'what', (select subject from sgaa_messages where id = v_id),
      'need', coalesce(v_need.title, ''),
      'details', trim(p_body),
      'app_path', 'sgaa/#/messages'));
    v_mail := true;
  end if;
  update sgaa_messages set emailed = v_mail where id = v_id;
  return v_id;
end;
$$;

/** RSVP (p_going = false takes it back). Returns how many are going. Capacity counts guests. */
create or replace function public.sgaa_rsvp(p_event uuid, p_going boolean, p_guests int default 0, p_note text default '')
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_e     sgaa_events;
  v_taken int;
begin
  perform sgaa_require_insider();
  select * into v_e from sgaa_events where id = p_event and published for update;   -- one RSVP at a time per event
  if v_e.id is null then raise exception 'That event isn''t listed anymore.'; end if;
  if not p_going then
    delete from sgaa_rsvps where event_id = p_event and user_id = auth.uid();
  else
    if v_e.cancelled then raise exception 'This event was cancelled.'; end if;
    if not v_e.rsvp_open then raise exception 'RSVPs for this event are closed.'; end if;
    if coalesce(v_e.ends_at, v_e.starts_at) < now() then raise exception 'This event is over.'; end if;
    if coalesce(p_guests, 0) not between 0 and 5 then raise exception 'You can bring up to 5 guests.'; end if;
    select coalesce(sum(1 + guests), 0) into v_taken from sgaa_rsvps where event_id = p_event and user_id <> auth.uid();
    if v_e.capacity is not null and v_taken + 1 + coalesce(p_guests, 0) > v_e.capacity then
      raise exception 'Sorry, it''s full (% of % spots taken).', v_taken, v_e.capacity;
    end if;
    insert into sgaa_rsvps (event_id, user_id, guests, note) values (p_event, auth.uid(), coalesce(p_guests, 0), sgaa_text(p_note, 300))
    on conflict (event_id, user_id) do update set guests = excluded.guests, note = excluded.note;
  end if;
  return (select coalesce(sum(1 + guests), 0) from sgaa_rsvps where event_id = p_event);
end;
$$;

-- ---- the directory --------------------------------------------------------------------------------
/** My card (or a blank one). */
create or replace function public.sgaa_my_profile()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare r sgaa_alumni;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  select * into r from sgaa_alumni where user_id = auth.uid();
  return jsonb_build_object('status', r.status, 'gradYear', r.grad_year, 'major', coalesce(r.major, ''),
    'employer', coalesce(r.employer, ''), 'jobTitle', coalesce(r.job_title, ''), 'city', coalesce(r.city, ''),
    'linkedin', coalesce(r.linkedin, ''), 'mentorTopics', coalesce(r.mentor_topics, ''), 'bio', coalesce(r.bio, ''),
    'teamRoles', coalesce(r.team_roles, ''), 'listed', coalesce(r.listed, true),
    'visibility', coalesce(r.visibility, '{"employer": "all", "job_title": "all", "city": "all", "linkedin": "all", "mentor_topics": "all", "bio": "all", "major": "all", "team_roles": "all", "email": "hidden"}'::jsonb),
    'reviewNote', coalesce(r.review_note, ''));
end;
$$;

/** Save my directory card. Alumni and the team (members can fill theirs in before they graduate). */
create or replace function public.sgaa_save_profile(p jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_vis  jsonb := '{}';
  v_k    text;
  v_year int;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if not (sgaa_insider() or exists (select 1 from sgaa_alumni where user_id = auth.uid() and status = 'pending')) then
    raise exception 'This is for Solar Gators alumni and the team.';
  end if;
  begin
    v_year := nullif(p ->> 'gradYear', '')::int;
  exception when others then raise exception 'Graduation year has to be a year, like 2024.';
  end;
  if v_year is not null and v_year not between 1990 and 2100 then raise exception 'Graduation year has to be a year, like 2024.'; end if;
  if coalesce(p ->> 'linkedin', '') <> '' and p ->> 'linkedin' !~* '^https://([a-z]+\.)?linkedin\.com/' then
    raise exception 'The LinkedIn link has to be a linkedin.com address.';
  end if;
  if p ? 'visibility' then
    for v_k in select jsonb_object_keys(p -> 'visibility') loop
      if v_k not in ('employer', 'job_title', 'city', 'linkedin', 'mentor_topics', 'bio', 'major', 'team_roles', 'email') then continue; end if;
      if (p -> 'visibility' ->> v_k) not in ('all', 'team', 'hidden') then raise exception 'Unknown privacy setting.'; end if;
      v_vis := v_vis || jsonb_build_object(v_k, p -> 'visibility' ->> v_k);
    end loop;
  end if;
  insert into sgaa_alumni (user_id) values (auth.uid()) on conflict (user_id) do nothing;
  update sgaa_alumni set
    grad_year     = case when p ? 'gradYear' then v_year else grad_year end,
    major         = sgaa_text(coalesce(p ->> 'major', major), 80),
    employer      = sgaa_text(coalesce(p ->> 'employer', employer), 120),
    job_title     = sgaa_text(coalesce(p ->> 'jobTitle', job_title), 120),
    city          = sgaa_text(coalesce(p ->> 'city', city), 80),
    linkedin      = sgaa_text(coalesce(p ->> 'linkedin', linkedin), 200),
    mentor_topics = sgaa_text(coalesce(p ->> 'mentorTopics', mentor_topics), 300),
    bio           = sgaa_text(coalesce(p ->> 'bio', bio), 1000),
    team_roles    = sgaa_text(coalesce(p ->> 'teamRoles', team_roles), 200),
    listed        = coalesce((p ->> 'listed')::boolean, listed),
    visibility    = visibility || v_vis,
    updated_at    = now()
  where user_id = auth.uid();
end;
$$;

/**
 * The alumni directory, for alumni and the team. Only listed alums. Each field follows its owner's setting:
 * 'all' = alumni and the team, 'team' = only people on the current team, 'hidden' = nobody.
 */
create or replace function public.sgaa_directory()
returns table (user_id uuid, full_name text, grad_year int, major text, employer text, job_title text, city text,
               linkedin text, mentor_topics text, bio text, team_roles text, email text, me boolean)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_team boolean := is_member();
begin
  perform sgaa_require_insider();
  return query
    select a.user_id, p.full_name, a.grad_year,
      case when sgaa_shows(a, 'major', v_team) then a.major else '' end,
      case when sgaa_shows(a, 'employer', v_team) then a.employer else '' end,
      case when sgaa_shows(a, 'job_title', v_team) then a.job_title else '' end,
      case when sgaa_shows(a, 'city', v_team) then a.city else '' end,
      case when sgaa_shows(a, 'linkedin', v_team) then a.linkedin else '' end,
      case when sgaa_shows(a, 'mentor_topics', v_team) then a.mentor_topics else '' end,
      case when sgaa_shows(a, 'bio', v_team) then a.bio else '' end,
      case when sgaa_shows(a, 'team_roles', v_team) then a.team_roles else '' end,
      case when sgaa_shows(a, 'email', v_team) then p.email else '' end,
      a.user_id = auth.uid()
    from sgaa_alumni a join profiles p on p.id = a.user_id
    where a.status = 'alum' and a.listed and is_former_member(a.user_id)
    order by a.grad_year desc nulls last, p.full_name;
end;
$$;

create or replace function public.sgaa_shows(a sgaa_alumni, p_field text, p_team boolean)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select a.user_id = auth.uid()
      or coalesce(a.visibility ->> p_field, case when p_field = 'email' then 'hidden' else 'all' end) = 'all'
      or (coalesce(a.visibility ->> p_field, '') = 'team' and p_team);
$$;

-- ---- becoming an alum ---------------------------------------------------------------------------
/** A Guest who is an alum asks to join as one. p: { gradYear, note, … directory fields }. */
create or replace function public.sgaa_request_alum(p jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if is_member() then raise exception 'You''re on the team already. You''ll become an alum when you graduate.'; end if;
  if sgaa_is_alum() then return; end if;
  if is_former_member() then
    raise exception 'Your account was deactivated. Ask someone on the team to mark you as an alum.';
  end if;
  if nullif(p ->> 'gradYear', '') is null then raise exception 'What year did you graduate (or leave the team)?'; end if;
  insert into sgaa_alumni (user_id, status) values (auth.uid(), 'pending')
  on conflict (user_id) do update set status = 'pending' where sgaa_alumni.status is distinct from 'alum';
  update sgaa_alumni set request_note = sgaa_text(p ->> 'note', 1000), requested_at = now(), review_note = ''
  where user_id = auth.uid();
  perform sgaa_save_profile(p - 'note');
end;
$$;

/** Who asked to join as an alum (approvers). */
create or replace function public.sgaa_alumni_queue()
returns table (user_id uuid, full_name text, email text, grad_year int, team_roles text, note text, requested_at timestamptz,
               confirmed boolean)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform sgaa_require('sgaa.alumni');
  return query
    select a.user_id, p.full_name, p.email, a.grad_year, a.team_roles, a.request_note, a.requested_at,
           u.email_confirmed_at is not null
    from sgaa_alumni a join profiles p on p.id = a.user_id join auth.users u on u.id = a.user_id
    where a.status = 'pending' order by a.requested_at;
end;
$$;

/** Make someone an alum: their only role becomes Former member, they're marked as an alum, and may sign in. */
create or replace function public.sgaa_make_alum(p_user uuid, p_via text, p_note text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_old text[] := roles_of(p_user);
begin
  if not is_former_member(p_user) then
    perform set_config('onesolar.roles_logged', 'on', true);
    insert into profile_roles (user_id, role) values (p_user, 'alumni');   -- replaces Guest
    perform log_role_change(p_user, v_old, roles_of(p_user), p_via, coalesce(p_note, ''));
    perform set_config('onesolar.roles_logged', 'off', true);
  end if;
  insert into sgaa_alumni (user_id) values (p_user) on conflict (user_id) do nothing;
  update sgaa_alumni set status = 'alum', reviewed_by = auth.uid(), reviewed_name = coalesce(my_display_name(), ''),
         reviewed_at = now(), review_note = sgaa_text(p_note, 300), updated_at = now()
  where user_id = p_user;
  perform set_sign_in_blocked(p_user, false);
end;
$$;

create or replace function public.sgaa_review_alum(p_user uuid, p_approve boolean, p_note text default '')
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform sgaa_require('sgaa.alumni');
  if not exists (select 1 from sgaa_alumni where user_id = p_user and status = 'pending') then
    if sgaa_is_alum(p_user) then return; end if;   -- someone else already did
    raise exception 'They haven''t asked to join as an alum.';
  end if;
  if is_member(p_user) then raise exception 'They''re on the team. They become an alum when they graduate.'; end if;
  if p_approve then
    if not exists (select 1 from auth.users where id = p_user and email_confirmed_at is not null) then
      raise exception 'They haven''t confirmed their email address yet.';
    end if;
    perform sgaa_make_alum(p_user, 'sgaa_review_alum', p_note);
  else
    update sgaa_alumni set status = 'declined', reviewed_by = auth.uid(), reviewed_name = coalesce(my_display_name(), ''),
           reviewed_at = now(), review_note = sgaa_text(p_note, 300), updated_at = now()
    where user_id = p_user;
  end if;
end;
$$;

/** Someone graduated: deactivate them (044) and make them an alum, so they keep SGAA. */
create or replace function public.graduate_person(p_user uuid, p_note text default '')
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform deactivate_person(p_user, coalesce(nullif(trim(coalesce(p_note, '')), ''), 'Graduated'));
  perform sgaa_make_alum(p_user, 'graduate_person', coalesce(nullif(trim(coalesce(p_note, '')), ''), 'Graduated'));
end;
$$;

/** A former member: alum (may sign in to SGAA) or not (back to blocked when former members are blocked). */
create or replace function public.sgaa_set_alum(p_user uuid, p_on boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('users.manage');
  if not is_former_member(p_user) then raise exception 'Only former members can be marked as alumni.'; end if;
  if p_on then
    perform sgaa_make_alum(p_user, 'sgaa_set_alum', '');
  else
    update sgaa_alumni set status = null, updated_at = now() where user_id = p_user;
    if former_members_blocked() then perform set_sign_in_blocked(p_user, true); end if;
  end if;
end;
$$;

-- Reactivating an alum (044) puts them back on the team: they're no longer listed as an alum.
create or replace function public.sgaa_alum_rejoined()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.role not in ('guest', 'alumni') then
    update sgaa_alumni set status = null, updated_at = now() where user_id = new.user_id and status is not null;
  end if;
  return null;
end;
$$;
create trigger sgaa_alum_rejoined after insert on public.profile_roles
  for each row execute function public.sgaa_alum_rejoined();

-- ---- signing up with a personal email; changing your email ------------------------------------------
-- Alumni rarely have a UF address anymore. A sign-up that starts on SGAA (it sends { sgaa: "alum" } with the
-- sign-up) may use any email address while "alumniCanSignUp" is on (Admin → Team & season; on by default).
-- They arrive as a Guest like everyone else and see nothing until approved as an alum. Their request starts
-- right away (status 'pending', details added once they've confirmed their email and come back to the join
-- page), so they wait in SGAA's Manage → Alumni, not in the team's "waiting to join" list. Other sign-ups
-- still follow "allowedEmailDomains".
update public.app_settings set value = value || '{"alumniCanSignUp": true}'
where key = 'general' and not value ? 'alumniCanSignUp';

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_domains jsonb;
  v_general jsonb;
  v_domain  text := lower(split_part(new.email, '@', 2));
begin
  select value into v_general from app_settings where key = 'general';
  v_domains := v_general -> 'allowedEmailDomains';

  if v_domains is not null and jsonb_array_length(v_domains) > 0 and not exists (
    select 1 from jsonb_array_elements_text(v_domains) d
    where v_domain = lower(d) or v_domain like '%.' || lower(d)
  ) and not (coalesce(new.raw_user_meta_data ->> 'sgaa', '') = 'alum'
             and coalesce((v_general ->> 'alumniCanSignUp')::boolean, true)) then
    raise exception 'Sign-ups are limited to % email addresses.',
      (select string_agg('@' || d, ', ') from jsonb_array_elements_text(v_domains) d);
  end if;

  insert into profiles (id, email, full_name)
  values (new.id, new.email, coalesce(trim(new.raw_user_meta_data ->> 'full_name'), ''));
  insert into profile_roles (user_id, role) values (new.id, 'guest');
  if coalesce(new.raw_user_meta_data ->> 'sgaa', '') = 'alum' then
    insert into sgaa_alumni (user_id, status, requested_at) values (new.id, 'pending', now())
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;

-- The team's "waiting to join" list (home screen, 043/044) leaves out people asking to join as an alum (or
-- who are one): they're approved in SGAA instead. If their alum request is declined, they show up here again,
-- so a lead can still accept them onto the team (or remove them).
create or replace function public.waiting_people()
returns table (id uuid, full_name text, email text, created_at timestamptz, email_confirmed boolean)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('people.accept');
  return query
    select p.id, p.full_name, p.email, p.created_at, u.email_confirmed_at is not null
    from profiles p join auth.users u on u.id = p.id
    where exists (select 1 from profile_roles r where r.user_id = p.id and r.role = 'guest') and not is_member(p.id)
      and not exists (select 1 from sgaa_alumni a where a.user_id = p.id and a.status in ('pending', 'alum'))
    order by p.created_at desc;
end;
$$;

/** Only an Admin turns alumni sign-ups on or off (like the email domains, 043). */
create or replace function public.guard_alumni_sign_up()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.key = 'general' and auth.uid() is not null and not is_admin()
     and (old.value -> 'alumniCanSignUp') is distinct from (new.value -> 'alumniCanSignUp') then
    raise exception 'Only an Admin can change whether alumni can sign up with any email address.';
  end if;
  return new;
end;
$$;
create trigger guard_alumni_sign_up before update on public.app_settings
  for each row execute function public.guard_alumni_sign_up();

-- When someone changes their sign-in email (a graduate moving off their UF address), the team's records and
-- notices follow it.
create or replace function public.sync_profile_email()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.email is distinct from old.email and coalesce(new.email, '') <> '' then
    update profiles set email = new.email where id = new.id;
  end if;
  return null;
end;
$$;
drop trigger if exists sync_profile_email on auth.users;
create trigger sync_profile_email after update of email on auth.users
  for each row execute function public.sync_profile_email();

-- ---- Projects: share with alumni -----------------------------------------------------------------
/**
 * Share a Projects project or work item with alumni (p_on), or stop. People with "Edit the alumni hub"
 * publish it straight away; anyone else who can edit it in Projects makes a draft for them to finish.
 * Returns the need's id (null when turned off).
 */
create or replace function public.sgaa_share_from_projects(p_project uuid, p_item uuid, p_on boolean)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_item    pm_items;
  v_project pm_projects;
  v_need    sgaa_needs;
  v_editor  boolean := sgaa_can('sgaa.edit');
begin
  if auth.uid() is null then raise exception 'You must be signed in.' using errcode = '42501'; end if;
  if p_item is not null then
    select * into v_item from pm_items where id = p_item;
    if v_item.id is null then raise exception 'That work item no longer exists.'; end if;
    p_project := v_item.project_id;
  end if;
  select * into v_project from pm_projects where id = p_project;
  if v_project.id is null then raise exception 'That project no longer exists.'; end if;
  if not v_editor and not ('edit' = any(pmx_caps_for(p_project, auth.uid()))) then
    raise exception 'You can''t share this: you need to be able to edit it in Projects, or have "Edit the alumni hub".' using errcode = '42501';
  end if;

  select * into v_need from sgaa_needs
  where status <> 'archived' and pm_project_id = p_project and pm_item_id is not distinct from p_item;

  if not p_on then
    if v_need.id is null then return null; end if;
    if v_need.published_at is null then delete from sgaa_needs where id = v_need.id;
    else update sgaa_needs set status = 'archived', updated_by = auth.uid(), updated_at = now() where id = v_need.id;
    end if;
    return null;
  end if;
  if v_need.id is not null then return v_need.id; end if;

  insert into sgaa_needs (title, summary, pm_project_id, pm_item_id, status, published_at, created_by, updated_by)
  values (left(coalesce(v_item.title, v_project.name), 120),
          left(regexp_replace(coalesce(v_item.description, v_project.description, ''), '\s+', ' ', 'g'), 300),
          p_project, p_item,
          case when v_editor then 'open' else 'draft' end,
          case when v_editor then now() end, auth.uid(), auth.uid())
  returning * into v_need;
  if v_item.category = 'done' and v_editor then
    update sgaa_needs set status = 'met', met_at = now() where id = v_need.id;
  end if;
  return v_need.id;
end;
$$;

/** Whether a project / item is shared, for the toggle in Projects. */
create or replace function public.sgaa_shared_from_projects(p_project uuid, p_item uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select case when auth.uid() is null or not is_member() then null else (
    select jsonb_build_object('id', id, 'status', status) from sgaa_needs
    where status <> 'archived' and pm_project_id = p_project and pm_item_id is not distinct from p_item) end;
$$;

-- A shared work item that's done shows as met; reopened, it's open again (only needs that are public).
create or replace function public.sgaa_item_changed()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.category is distinct from old.category then
    if new.category = 'done' then
      update sgaa_needs set status = 'met', met_at = now(), updated_at = now() where pm_item_id = new.id and status = 'open';
    elsif old.category = 'done' then
      update sgaa_needs set status = 'open', met_at = null, updated_at = now() where pm_item_id = new.id and status = 'met';
    end if;
  end if;
  return null;
end;
$$;
create trigger sgaa_item_changed after update of category on public.pm_items
  for each row execute function public.sgaa_item_changed();

-- ---- storage: photos for needs and updates (public bucket; editors upload) --------------------------
do $storage$
begin
  if to_regclass('storage.buckets') is null then return; end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('sgaa', 'sgaa', true, 8388608, array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
  on conflict (id) do nothing;
  execute $p$
    create policy "sgaa: upload" on storage.objects for insert to authenticated with check (
      bucket_id = 'sgaa' and split_part(name, '/', 1) in ('needs', 'updates') and public.sgaa_can('sgaa.edit'))
  $p$;
  execute $p$
    create policy "sgaa: delete" on storage.objects for delete to authenticated using (
      bucket_id = 'sgaa' and public.sgaa_can('sgaa.edit'))
  $p$;
end
$storage$;

-- ---- what the website may call --------------------------------------------------------------------
revoke execute on function
  public.sgaa_text(text, int), public.sgaa_require(text), public.sgaa_require_insider(),
  public.sgaa_make_alum(uuid, text, text), public.sgaa_shows(public.sgaa_alumni, text, boolean),
  public.sgaa_alum_rejoined(), public.sgaa_item_changed(), public.guard_alumni_sign_up(), public.sync_profile_email()
from public, anon, authenticated;

-- The read policies use these.
revoke execute on function public.sgaa_is_alum(uuid), public.sgaa_insider(), public.sgaa_can(text) from public, anon;
grant execute on function public.sgaa_is_alum(uuid), public.sgaa_insider(), public.sgaa_can(text) to authenticated;

-- The public page works signed out.
revoke execute on function public.sgaa_hub() from public;
grant execute on function public.sgaa_hub() to anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'sgaa_save_need(uuid, jsonb)', 'sgaa_delete_need(uuid)', 'sgaa_save_contact(uuid, jsonb)', 'sgaa_delete_contact(uuid)',
    'sgaa_save_update(uuid, jsonb)', 'sgaa_delete_update(uuid)', 'sgaa_save_event(uuid, jsonb)', 'sgaa_delete_event(uuid)',
    'sgaa_event_rsvps(uuid)', 'sgaa_save_settings(jsonb)', 'sgaa_send_message(uuid, uuid, text, text)',
    'sgaa_rsvp(uuid, boolean, int, text)', 'sgaa_my_profile()', 'sgaa_save_profile(jsonb)', 'sgaa_directory()',
    'sgaa_request_alum(jsonb)', 'sgaa_alumni_queue()', 'sgaa_review_alum(uuid, boolean, text)', 'graduate_person(uuid, text)',
    'sgaa_set_alum(uuid, boolean)', 'sgaa_share_from_projects(uuid, uuid, boolean)', 'sgaa_shared_from_projects(uuid, uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$$;

select public.migration_done(52, '052_sgaa.sql');
