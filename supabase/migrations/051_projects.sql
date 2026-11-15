select public.migration_begin(51);

-- =============================================================================
-- 051: Projects: configurable project management (/projects/)
-- =============================================================================
--
--   Three layers, all in tables whose names start with pm_:
--
--   1. Work: programs → projects → work items (pm_items; any depth through parent_id), with owners,
--      collaborators and watchers, checklists, comments, dependencies (pm_deps), linked documents
--      (pm_resources), links to Orders and Inventory records (pm_refs), sprints, baselines, what-if scenarios,
--      and a permanent history (pm_events).
--   2. Configuration, per project and edited in the pages (never in code): work-item types (pm_types),
--      workflows with their statuses and transitions (pm_workflows / pm_statuses / pm_transitions, every saved
--      version kept in pm_workflow_versions), custom fields (pm_fields; values live in pm_items.custom and are
--      checked here), form layouts (pm_layouts), project roles and members (pm_roles / pm_members), automation
--      rules (pm_automations, each run logged in pm_automation_runs), saved views, boards and dashboards
--      (pm_views) and reusable templates (pm_templates: a whole configuration as one checked document).
--   3. The pages (board, backlog, list, timeline, calendar, dashboards) all read the same pm_items rows.
--
--   Who may do what
--     * one.solar permissions: projects.view (open Projects), projects.create (start a project),
--       projects.manage (everything in every project, including private ones).
--     * Inside a project, a person's project role (pm_roles.caps) decides. A team-visible project can give
--       everyone on the team a role (pm_projects.team_role_id, "Viewer" to start with); a private project is
--       only for its members. A project role never gives more than Projects itself allows: someone without
--       projects.view sees nothing.
--     * Reads go through row-level security on pm_visible(); every change is a function below that checks the
--       project role, validates against the project's configuration, and writes history in the same transaction.
--
--   Statuses only change through pm_transition (the board, the list and the item page all call it), so the
--   workflow's rules (allowed moves, who may make them, required fields and comments, approval) always hold.
-- =============================================================================

-- ---- permissions -------------------------------------------------------------------------------
insert into public.permissions (key, label, description, sort) values
  ('projects.view', 'See projects', 'Open Projects: team projects, your work, boards, timelines and dashboards. What you can change in a project depends on your role in that project.', 40),
  ('projects.create', 'Create projects', 'Start a new project (you become its Project Administrator), and save project templates.', 41),
  ('projects.manage', 'Manage all projects', 'Everything in every project, including private ones: settings, workflows, members, templates and programs.', 42)
on conflict (key) do nothing;

insert into public.role_permissions (role, permission)
select r.key, 'projects.view' from public.roles r where r.key not in ('guest', 'alumni')
on conflict do nothing;
insert into public.role_permissions (role, permission)
select v.role, v.permission
from (values ('ce', 'projects.create'), ('eboard', 'projects.create'), ('admin', 'projects.create'), ('admin', 'projects.manage')) v(role, permission)
where exists (select 1 from public.roles r where r.key = v.role)
on conflict do nothing;
select public.record_permissions_snapshot();

-- Email / Teams messages from Projects use the existing outbox as the event "project_update". Off until an
-- Admin turns it on in Admin → Notifications (the in-app inbox in Projects always works).
update public.app_settings
set value = jsonb_set(value, '{events,project_update}', '{"email": false, "teams": false}'::jsonb, true)
where key = 'notifications' and jsonb_typeof(value -> 'events') = 'object' and not (value -> 'events') ? 'project_update';

-- ---- tables --------------------------------------------------------------------------------------
create table public.pm_programs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 80),
  description text not null default '' check (length(description) <= 2000),
  vehicle     text not null default '' check (length(vehicle) <= 80),
  sort        int not null default 100,
  archived_at timestamptz,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.pm_projects (
  id           uuid primary key default gen_random_uuid(),
  program_id   uuid references public.pm_programs(id) on delete set null,
  key          text not null check (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name         text not null check (length(trim(name)) between 1 and 120),
  description  text not null default '' check (length(description) <= 5000),
  lead_id      uuid references public.profiles(id) on delete set null,
  division_id  uuid references public.org_divisions(id),
  subsystem_id uuid references public.org_subsystems(id),
  participants jsonb not null default '[]',       -- [{ division_id, subsystem_id }]: others taking part
  vehicle      text not null default '' check (length(vehicle) <= 80),
  visibility   text not null default 'team' check (visibility in ('team', 'private')),
  team_role_id uuid,                              -- the project role everyone on the team has (team-visible projects)
  item_seq     int not null default 0,            -- the last number given out (BAT-24); only changed under the row's lock
  settings     jsonb not null default '{}',       -- working days, holidays, sprints on/off, document categories…
  version      int not null default 1,
  archived_at  timestamptz,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
-- Keys are part of every item's name (BAT-24), so they stay unique for good.
create unique index pm_projects_key_key on public.pm_projects (key);

create table public.pm_roles (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.pm_projects(id) on delete cascade,
  key        text not null check (key ~ '^[a-z][a-z0-9_]{0,29}$'),
  name       text not null check (length(trim(name)) between 1 and 60),
  caps       text[] not null default '{}',
  sort       int not null default 100,
  unique (project_id, key)
);
alter table public.pm_projects add constraint pm_projects_team_role_fkey foreign key (team_role_id) references public.pm_roles(id) on delete set null;

create table public.pm_members (
  project_id uuid not null references public.pm_projects(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role_id    uuid not null references public.pm_roles(id),
  added_by   uuid references public.profiles(id) on delete set null,
  added_at   timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index pm_members_user_idx on public.pm_members (user_id);

create table public.pm_workflows (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.pm_projects(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 80),
  description text not null default '' check (length(description) <= 1000),
  version     int not null default 1,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index pm_workflows_name_key on public.pm_workflows (project_id, lower(trim(name))) where archived_at is null;

create table public.pm_statuses (
  id          uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.pm_workflows(id) on delete cascade,
  project_id  uuid not null references public.pm_projects(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 40),
  category    text not null check (category in ('todo', 'doing', 'done')),
  color       text not null default 'gray' check (color ~ '^[a-z]{1,12}$'),
  sort        int not null default 100,
  x           int not null default 0,   -- where it sits in the workflow drawing
  y           int not null default 0
);
create unique index pm_statuses_name_key on public.pm_statuses (workflow_id, lower(trim(name)));

create table public.pm_transitions (
  id               uuid primary key default gen_random_uuid(),
  workflow_id      uuid not null references public.pm_workflows(id) on delete cascade,
  project_id       uuid not null references public.pm_projects(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 60),
  from_status      uuid references public.pm_statuses(id) on delete cascade,   -- null: from any status
  to_status        uuid not null references public.pm_statuses(id) on delete cascade,
  description      text not null default '' check (length(description) <= 500),
  role_ids         uuid[] not null default '{}',   -- only these project roles (empty: anyone who may move items)
  require_fields   text[] not null default '{}',   -- 'owner', 'due_date', 'cf.<field key>'…
  require_comment  boolean not null default false,
  require_approval boolean not null default false, -- someone with "Approve" has to agree
  no_self_approval boolean not null default false, -- …and not the item's owner
  conditions       jsonb,                          -- the item must match (same model as filters)
  actions          jsonb not null default '[]',    -- done right after the move (same model as automation actions)
  sort             int not null default 100
);
create index pm_transitions_workflow_idx on public.pm_transitions (workflow_id);

create table public.pm_workflow_versions (
  id          bigserial primary key,
  workflow_id uuid not null references public.pm_workflows(id) on delete cascade,
  project_id  uuid not null references public.pm_projects(id) on delete cascade,
  version     int not null,
  snapshot    jsonb not null,
  note        text not null default '',
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table public.pm_types (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.pm_projects(id) on delete cascade,
  name            text not null check (length(trim(name)) between 1 and 40),
  icon            text not null default '' check (length(icon) <= 8),
  color           text not null default 'blue' check (color ~ '^[a-z]{1,12}$'),
  description     text not null default '' check (length(description) <= 500),
  level           int not null default 1 check (level between 0 and 5),   -- 0 is the top (epics); a parent has a lower level
  parent_type_ids uuid[] not null default '{}',                           -- if set, only these types can be the parent
  workflow_id     uuid not null references public.pm_workflows(id),
  is_milestone    boolean not null default false,
  defaults        jsonb not null default '{}',                             -- starting values: { priority, estimate_hours, labels, custom: {…} }
  sort            int not null default 100,
  archived_at     timestamptz
);
create unique index pm_types_name_key on public.pm_types (project_id, lower(trim(name))) where archived_at is null;

create table public.pm_fields (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.pm_projects(id) on delete cascade,
  key           text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  name          text not null check (length(trim(name)) between 1 and 60),
  type          text not null check (type in ('text', 'longtext', 'richtext', 'integer', 'decimal', 'date', 'datetime', 'checkbox',
                                              'select', 'multiselect', 'user', 'multiuser', 'url', 'tags', 'duration', 'currency', 'formula')),
  description   text not null default '' check (length(description) <= 500),
  options       jsonb not null default '[]',   -- the choices of a dropdown: ["Pass", "Fail"]
  default_value jsonb,
  validation    jsonb not null default '{}',   -- { min, max, maxlen, pattern }
  formula       text not null default '' check (length(formula) <= 500),
  type_ids      uuid[] not null default '{}',  -- only on these work-item types (empty: all)
  sort          int not null default 100,
  archived_at   timestamptz,
  unique (project_id, key)
);

create table public.pm_layouts (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.pm_projects(id) on delete cascade,
  type_id       uuid references public.pm_types(id) on delete cascade,          -- null: every type without its own
  kind          text not null check (kind in ('create', 'view', 'edit', 'transition')),
  transition_id uuid references public.pm_transitions(id) on delete cascade,
  sections      jsonb not null default '[]',   -- [{ title, fields: [{ key, required }] }]
  updated_by    uuid references public.profiles(id) on delete set null,
  updated_at    timestamptz not null default now()
);
create unique index pm_layouts_key on public.pm_layouts
  (project_id, coalesce(type_id, '00000000-0000-0000-0000-000000000000'), kind, coalesce(transition_id, '00000000-0000-0000-0000-000000000000'));

create table public.pm_sprints (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.pm_projects(id) on delete cascade,
  name       text not null check (length(trim(name)) between 1 and 80),
  goal       text not null default '' check (length(goal) <= 1000),
  start_date date,
  end_date   date,
  status     text not null default 'planned' check (status in ('planned', 'active', 'closed')),
  summary    jsonb,                              -- what was done / carried over when it closed
  created_at timestamptz not null default now(),
  closed_at  timestamptz,
  check (start_date is null or end_date is null or start_date <= end_date)
);

create table public.pm_items (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.pm_projects(id),
  type_id        uuid not null references public.pm_types(id),
  seq            int not null,
  key            text not null,
  parent_id      uuid references public.pm_items(id),
  title          text not null check (length(trim(title)) between 1 and 200),
  description    text not null default '' check (length(description) <= 20000),
  status_id      uuid not null references public.pm_statuses(id),
  category       text not null check (category in ('todo', 'doing', 'done')),   -- the status's category, kept here for fast filters
  priority       text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  owner_id       uuid references public.profiles(id) on delete set null,       -- the one accountable person
  reporter_id    uuid references public.profiles(id) on delete set null,
  division_id    uuid references public.org_divisions(id),
  subsystem_id   uuid references public.org_subsystems(id),
  vehicle        text not null default '' check (length(vehicle) <= 80),
  start_date     date,                    -- target dates: typed by people, never moved by the scheduler on its own
  due_date       date,
  estimate_hours numeric check (estimate_hours is null or (estimate_hours >= 0 and estimate_hours <= 100000)),
  progress       int not null default 0 check (progress between 0 and 100),
  actual_start   date,
  completed_at   timestamptz,             -- the work was finished (status category Done)
  accepted_at    timestamptz,             -- …and formally reviewed / accepted, a separate step
  accepted_by    uuid references public.profiles(id) on delete set null,
  blocked        boolean not null default false,
  blocked_reason text not null default '' check (length(blocked_reason) <= 500),
  acceptance     text not null default '' check (length(acceptance) <= 5000),   -- what "done" means here
  labels         text[] not null default '{}',
  sprint_id      uuid references public.pm_sprints(id) on delete set null,
  rank           numeric not null default 0,   -- order in the backlog and inside a board column
  custom         jsonb not null default '{}',  -- custom field values by field key
  version        int not null default 1,
  op_id          uuid,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  archived_at    timestamptz,
  check (start_date is null or due_date is null or start_date <= due_date),
  check (parent_id is null or parent_id <> id)
);
create unique index pm_items_key_key on public.pm_items (key);
create unique index pm_items_op_key on public.pm_items (op_id) where op_id is not null;
create index pm_items_project_idx on public.pm_items (project_id, status_id) where archived_at is null;
create index pm_items_rank_idx on public.pm_items (project_id, rank);
create index pm_items_owner_idx on public.pm_items (owner_id) where archived_at is null;
create index pm_items_parent_idx on public.pm_items (parent_id);
create index pm_items_due_idx on public.pm_items (due_date) where archived_at is null;
create index pm_items_sprint_idx on public.pm_items (sprint_id);
create index pm_items_org_idx on public.pm_items (division_id, subsystem_id);
create index pm_items_updated_idx on public.pm_items (updated_at);
create index pm_items_custom_idx on public.pm_items using gin (custom jsonb_path_ops);
create index pm_items_labels_idx on public.pm_items using gin (labels);

-- An item moved to another project gets that project's key; its old name still finds it.
create table public.pm_item_aliases (
  key        text primary key,
  item_id    uuid not null references public.pm_items(id) on delete cascade,
  project_id uuid not null references public.pm_projects(id) on delete cascade
);

create table public.pm_people (
  item_id    uuid not null references public.pm_items(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null check (kind in ('collab', 'watch')),
  project_id uuid not null references public.pm_projects(id) on delete cascade,
  primary key (item_id, user_id, kind)
);
create index pm_people_user_idx on public.pm_people (user_id, kind);

create table public.pm_checklist (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.pm_items(id) on delete cascade,
  project_id uuid not null references public.pm_projects(id) on delete cascade,
  text       text not null check (length(trim(text)) between 1 and 300),
  done       boolean not null default false,
  sort       int not null default 0,
  done_by    uuid references public.profiles(id) on delete set null,
  done_at    timestamptz
);
create index pm_checklist_item_idx on public.pm_checklist (item_id);

-- from_item has to happen first: FS = to_item starts after from_item finishes, SS, FF, SF likewise.
create table public.pm_deps (
  id           uuid primary key default gen_random_uuid(),
  from_item    uuid not null references public.pm_items(id) on delete cascade,
  to_item      uuid not null references public.pm_items(id) on delete cascade,
  from_project uuid not null references public.pm_projects(id) on delete cascade,
  to_project   uuid not null references public.pm_projects(id) on delete cascade,
  kind         text not null default 'FS' check (kind in ('FS', 'SS', 'FF', 'SF')),
  lag_days     int not null default 0 check (lag_days between -365 and 365),   -- working days; negative is lead time
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (from_item, to_item),
  check (from_item <> to_item)
);
create index pm_deps_to_idx on public.pm_deps (to_item);

create table public.pm_comments (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.pm_items(id) on delete cascade,
  project_id uuid not null references public.pm_projects(id) on delete cascade,
  author_id  uuid references public.profiles(id) on delete set null,
  body       text not null check (length(body) between 1 and 10000),
  mentions   uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  edited_at  timestamptz,
  deleted_at timestamptz
);
create index pm_comments_item_idx on public.pm_comments (item_id, created_at);

create table public.pm_events (
  id         bigserial primary key,
  project_id uuid not null references public.pm_projects(id) on delete cascade,
  item_id    uuid references public.pm_items(id) on delete cascade,
  actor_id   uuid references public.profiles(id) on delete set null,
  actor_name text not null default '',
  kind       text not null,
  summary    text not null default '',
  data       jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index pm_events_item_idx on public.pm_events (item_id, id);
create index pm_events_project_idx on public.pm_events (project_id, id);

create table public.pm_approvals (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references public.pm_items(id) on delete cascade,
  project_id    uuid not null references public.pm_projects(id) on delete cascade,
  transition_id uuid not null references public.pm_transitions(id) on delete cascade,
  requested_by  uuid references public.profiles(id) on delete set null,
  requested_at  timestamptz not null default now(),
  payload       jsonb not null default '{}',
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by    uuid references public.profiles(id) on delete set null,
  decided_at    timestamptz,
  note          text not null default ''
);
create unique index pm_approvals_pending_key on public.pm_approvals (item_id) where status = 'pending';

-- Linked documents: only the address is kept. The file stays where it is (Teams / SharePoint / OneDrive /
-- GitHub…) and that system keeps deciding who can open it. meta is free for a later Microsoft Graph sync.
create table public.pm_resources (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.pm_projects(id) on delete cascade,
  url        text not null check (url ~* '^https://[^\s<>"]+$' and length(url) <= 2000),
  title      text not null check (length(trim(title)) between 1 and 200),
  category   text not null default '' check (length(category) <= 60),
  provider   text not null default 'link' check (provider ~ '^[a-z]{1,20}$'),
  kind       text not null default 'file' check (kind in ('file', 'folder', 'page', 'repo')),
  file_type  text not null default '' check (length(file_type) <= 12),
  meta       jsonb not null default '{}',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, url)
);
create table public.pm_resource_links (
  id           uuid primary key default gen_random_uuid(),
  resource_id  uuid not null references public.pm_resources(id) on delete cascade,
  project_id   uuid not null references public.pm_projects(id) on delete cascade,
  item_id      uuid references public.pm_items(id) on delete cascade,     -- null: a project (or subsystem) document
  subsystem_id uuid references public.org_subsystems(id),
  added_by     uuid references public.profiles(id) on delete set null,
  added_at     timestamptz not null default now()
);
create unique index pm_resource_links_key on public.pm_resource_links
  (resource_id, coalesce(item_id, '00000000-0000-0000-0000-000000000000'), coalesce(subsystem_id, '00000000-0000-0000-0000-000000000000'));
create index pm_resource_links_item_idx on public.pm_resource_links (item_id);

-- Links to other one.solar records. Projects only points at them: status and stock are read live from
-- Orders / Inventory under the reader's own access, and nothing here changes them.
create table public.pm_refs (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.pm_items(id) on delete cascade,
  project_id uuid not null references public.pm_projects(id) on delete cascade,
  kind       text not null check (kind in ('order', 'inventory')),
  ref_id     uuid not null,
  label      text not null default '' check (length(label) <= 200),
  note       text not null default '' check (length(note) <= 300),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (item_id, kind, ref_id)
);

create table public.pm_views (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid references public.profiles(id) on delete cascade,
  project_id  uuid references public.pm_projects(id) on delete cascade,   -- null: across projects
  kind        text not null check (kind in ('list', 'board', 'timeline', 'calendar', 'dashboard')),
  name        text not null check (length(trim(name)) between 1 and 80),
  sharing     text not null default 'private' check (sharing in ('private', 'project', 'team', 'people')),
  shared_with uuid[] not null default '{}',
  config      jsonb not null default '{}',
  is_default  boolean not null default false,
  version     int not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (sharing <> 'project' or project_id is not null)
);
create index pm_views_project_idx on public.pm_views (project_id);

create table public.pm_baselines (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.pm_projects(id) on delete cascade,
  name       text not null check (length(trim(name)) between 1 and 80),
  snapshot   jsonb not null,             -- { "<item id>": { start, due } }
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create table public.pm_scenarios (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.pm_projects(id) on delete cascade,
  name       text not null check (length(trim(name)) between 1 and 80),
  changes    jsonb not null,             -- { "<item id>": { start, due } }: tried out, not live until applied
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  applied_at timestamptz
);
create table public.pm_calendar_events (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.pm_projects(id) on delete cascade,
  title        text not null check (length(trim(title)) between 1 and 120),
  starts_on    date not null,
  ends_on      date,
  repeat       text not null default 'none' check (repeat in ('none', 'weekly', 'biweekly', 'monthly')),
  repeat_until date,
  notes        text not null default '' check (length(notes) <= 1000),
  created_by   uuid references public.profiles(id) on delete set null,
  check (ends_on is null or ends_on >= starts_on)
);

create table public.pm_automations (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.pm_projects(id) on delete cascade,
  name           text not null check (length(trim(name)) between 1 and 80),
  enabled        boolean not null default true,
  trigger        text not null check (trigger in ('created', 'updated', 'status', 'assigned', 'comment', 'dependency_done',
                                                  'milestone', 'due_soon', 'overdue', 'schedule')),
  trigger_config jsonb not null default '{}',
  conditions     jsonb,
  actions        jsonb not null default '[]',
  version        int not null default 1,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_run_at    timestamptz
);
create table public.pm_automation_runs (
  id         bigserial primary key,
  rule_id    uuid not null references public.pm_automations(id) on delete cascade,
  project_id uuid not null references public.pm_projects(id) on delete cascade,
  item_id    uuid references public.pm_items(id) on delete cascade,
  trigger    text not null,
  status     text not null check (status in ('ok', 'skipped', 'error')),
  detail     text not null default '',
  dedupe     text,
  created_at timestamptz not null default now()
);
create unique index pm_automation_runs_dedupe_key on public.pm_automation_runs (rule_id, dedupe) where dedupe is not null;
create index pm_automation_runs_rule_idx on public.pm_automation_runs (rule_id, id);

create table public.pm_notifications (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  project_id uuid references public.pm_projects(id) on delete cascade,
  item_id    uuid references public.pm_items(id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text not null default '',
  actor_name text not null default '',
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index pm_notifications_user_idx on public.pm_notifications (user_id, id desc);

create table public.pm_prefs (
  user_id        uuid primary key references public.profiles(id) on delete cascade,
  notify         jsonb not null default '{}',   -- { "<kind>": { inapp: false, email: false } }
  hours_per_week numeric check (hours_per_week is null or (hours_per_week >= 0 and hours_per_week <= 168)),
  updated_at     timestamptz not null default now()
);

create table public.pm_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 80),
  description text not null default '' check (length(description) <= 1000),
  config      jsonb not null,
  version     int not null default 1,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);
create unique index pm_templates_name_key on public.pm_templates (lower(trim(name))) where archived_at is null;

-- When the timed rules (due soon, overdue, recurring) last ran.
create table public.pm_schedule_state (
  one      boolean primary key default true check (one),
  last_run timestamptz
);
insert into public.pm_schedule_state (one) values (true);

-- ---- who can see and do what ---------------------------------------------------------------------
create or replace function public.pmx_all_caps()
returns text[] language sql immutable set search_path = public, pg_temp
as $$ select array['view', 'create', 'edit', 'assign', 'transition', 'approve', 'comment', 'delete', 'plan', 'boards',
                   'configure', 'workflows', 'automations', 'members']; $$;

create or replace function public.pmx_has(p_user uuid, p_permission text)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from profile_roles pr join role_permissions rp on rp.role = pr.role
                 where pr.user_id = p_user and rp.permission = p_permission);
$$;

/** On the team and allowed to open Projects. */
create or replace function public.pm_can_open()
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select auth.uid() is not null and is_member()
     and (has_permission('projects.view') or has_permission('projects.create') or has_permission('projects.manage'));
$$;

/** What this person may do in this project (their project role, plus the role the whole team has). */
create or replace function public.pmx_caps_for(p_project uuid, p_user uuid)
returns text[] language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when p_user is null or not is_member(p_user) then '{}'::text[]
    when pmx_has(p_user, 'projects.manage') then pmx_all_caps()
    when not (pmx_has(p_user, 'projects.view') or pmx_has(p_user, 'projects.create')) then '{}'::text[]
    else coalesce((select array_agg(distinct c) from (
        select unnest(r.caps) as c from pm_members m join pm_roles r on r.id = m.role_id
        where m.project_id = p_project and m.user_id = p_user
        union
        select unnest(r.caps) from pm_projects p join pm_roles r on r.id = p.team_role_id
        where p.id = p_project and p.visibility = 'team'
        union
        select 'view' from pm_projects p where p.id = p_project and p.visibility = 'team'
      ) x where c = any(pmx_all_caps())), '{}'::text[])
  end;
$$;

create or replace function public.pmx_can(p_project uuid, p_cap text)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select p_cap = any(pmx_caps_for(p_project, auth.uid())); $$;

/** The projects the signed-in person can see. The read policies use it (worked out once per query). */
create or replace function public.pm_visible()
returns uuid[] language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when auth.uid() is null or not is_member() then '{}'::uuid[]
    when has_permission('projects.manage') then coalesce((select array_agg(id) from pm_projects), '{}'::uuid[])
    when not (has_permission('projects.view') or has_permission('projects.create')) then '{}'::uuid[]
    else coalesce((select array_agg(p.id) from pm_projects p
                   where p.visibility = 'team'
                      or exists (select 1 from pm_members m where m.project_id = p.id and m.user_id = auth.uid())), '{}'::uuid[])
  end;
$$;

/** Refuse unless signed in, on the team, and allowed into Projects. */
create or replace function public.pmx_open()
returns void language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'You must be signed in.' using errcode = '42501'; end if;
  if not is_member() then
    if is_former_member() then raise exception 'Your one.solar access has ended. Ask an Admin if this is a mistake.' using errcode = '42501'; end if;
    raise exception 'Your account hasn''t been accepted into the team yet.' using errcode = '42501';
  end if;
  if not pm_can_open() then raise exception 'Your role can''t open Projects (it needs "See projects").' using errcode = '42501'; end if;
end;
$$;

/** Refuse unless the signed-in person can do this in this project. */
create or replace function public.pmx_need(p_project uuid, p_cap text)
returns void language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_caps text[];
begin
  perform pmx_open();
  v_caps := pmx_caps_for(p_project, auth.uid());
  if not ('view' = any(v_caps)) then raise exception 'That project doesn''t exist, or you can''t see it.' using errcode = '42501'; end if;
  if not (p_cap = any(v_caps)) then
    raise exception 'Your role in this project can''t do this (it needs "%").',
      case p_cap when 'create' then 'Create items' when 'edit' then 'Edit items' when 'assign' then 'Assign people'
        when 'transition' then 'Move items between statuses' when 'approve' then 'Approve' when 'comment' then 'Comment'
        when 'delete' then 'Archive items' when 'plan' then 'Plan and schedule' when 'boards' then 'Shared boards and views'
        when 'configure' then 'Project settings, types and fields' when 'workflows' then 'Workflows'
        when 'automations' then 'Automation rules' when 'members' then 'Members and roles' else p_cap end
      using errcode = '42501';
  end if;
end;
$$;

-- ---- row-level security: reads only; every change is a function -----------------------------------
do $$
declare t text;
begin
  foreach t in array array['pm_programs', 'pm_projects', 'pm_roles', 'pm_members', 'pm_workflows', 'pm_statuses', 'pm_transitions',
    'pm_workflow_versions', 'pm_types', 'pm_fields', 'pm_layouts', 'pm_sprints', 'pm_items', 'pm_item_aliases', 'pm_people', 'pm_checklist',
    'pm_deps', 'pm_comments', 'pm_events', 'pm_approvals', 'pm_resources', 'pm_resource_links', 'pm_refs', 'pm_views', 'pm_baselines',
    'pm_scenarios', 'pm_calendar_events', 'pm_automations', 'pm_automation_runs', 'pm_notifications', 'pm_prefs', 'pm_templates',
    'pm_schedule_state'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  foreach t in array array['pm_roles', 'pm_members', 'pm_workflows', 'pm_statuses', 'pm_transitions', 'pm_workflow_versions', 'pm_types',
    'pm_fields', 'pm_layouts', 'pm_sprints', 'pm_items', 'pm_item_aliases', 'pm_people', 'pm_checklist', 'pm_comments', 'pm_events',
    'pm_approvals', 'pm_resources', 'pm_resource_links', 'pm_refs', 'pm_baselines', 'pm_scenarios', 'pm_calendar_events',
    'pm_automations', 'pm_automation_runs'] loop
    execute format('create policy "project read" on public.%I for select to authenticated using (project_id = any((select public.pm_visible())::uuid[]))', t);
  end loop;
end;
$$;
create policy "project read" on public.pm_projects for select to authenticated using (id = any((select public.pm_visible())::uuid[]));
create policy "projects read" on public.pm_programs for select to authenticated using ((select public.pm_can_open()));
create policy "projects read" on public.pm_templates for select to authenticated using ((select public.pm_can_open()));
create policy "projects read" on public.pm_schedule_state for select to authenticated using ((select public.pm_can_open()));
-- A dependency shows if you can see either end (the other end's item stays hidden by pm_items' own rule).
create policy "project read" on public.pm_deps for select to authenticated
  using (from_project = any((select public.pm_visible())::uuid[]) or to_project = any((select public.pm_visible())::uuid[]));
create policy "own or shared" on public.pm_views for select to authenticated using (
  (select public.pm_can_open()) and (
    owner_id = auth.uid()
    or (sharing = 'project' and project_id = any((select public.pm_visible())::uuid[]))
    or (sharing = 'team' and (project_id is null or project_id = any((select public.pm_visible())::uuid[])))
    or (sharing = 'people' and auth.uid() = any(shared_with))));
create policy "own" on public.pm_notifications for select to authenticated using (user_id = auth.uid());
create policy "projects read" on public.pm_prefs for select to authenticated using ((select public.pm_can_open()));

/** History is permanent: nothing edits or deletes it (a project being deleted takes its history with it). */
create or replace function public.pmx_permanent()
returns trigger language plpgsql set search_path = public, pg_temp
as $$
begin
  -- pm_move_item takes an item's history with it to the other project (only the project changes)
  if tg_op = 'UPDATE' and coalesce(current_setting('pm.move', true), '') = '1' then return new; end if;
  if tg_op = 'DELETE' and not exists (select 1 from pm_projects where id = old.project_id) then return old; end if;
  if tg_op = 'DELETE' and old.item_id is not null and not exists (select 1 from pm_items where id = old.item_id) then return old; end if;
  raise exception 'Project history is permanent: it can''t be changed or deleted.';
end;
$$;
create trigger pm_events_permanent before update or delete on public.pm_events
  for each row execute function public.pmx_permanent();

-- ---- small helpers ---------------------------------------------------------------------------------
create or replace function public.pmx_uuid(p text)
returns uuid language plpgsql immutable set search_path = public, pg_temp
as $$
begin
  if p is null or trim(p) = '' then return null; end if;
  return trim(p)::uuid;
exception when others then
  raise exception '"%" isn''t a valid id.', left(p, 60);
end;
$$;

create or replace function public.pmx_uuids(p jsonb)
returns uuid[] language sql immutable set search_path = public, pg_temp
as $$
  select case when jsonb_typeof(p) = 'array'
    then coalesce((select array_agg(distinct pmx_uuid(x)) from jsonb_array_elements_text(p) x where trim(x) <> ''), '{}'::uuid[])
    else '{}'::uuid[] end;
$$;

create or replace function public.pmx_texts(p jsonb)
returns text[] language sql immutable set search_path = public, pg_temp
as $$
  select case when jsonb_typeof(p) = 'array'
    then coalesce((select array_agg(trim(x)) from jsonb_array_elements_text(p) x where trim(x) <> ''), '{}'::text[])
    else '{}'::text[] end;
$$;

create or replace function public.pmx_num(p text)
returns numeric language plpgsql immutable set search_path = public, pg_temp
as $$
begin
  return nullif(trim(p), '')::numeric;
exception when others then
  return null;
end;
$$;

create or replace function public.pmx_bool(p jsonb, p_key text, p_default boolean)
returns boolean language sql immutable set search_path = public, pg_temp
as $$ select case when p -> p_key in ('true'::jsonb, '"true"'::jsonb) then true when p -> p_key in ('false'::jsonb, '"false"'::jsonb) then false else p_default end; $$;

create or replace function public.pmx_log(p_project uuid, p_item uuid, p_kind text, p_summary text, p_data jsonb)
returns bigint language sql security definer set search_path = public, pg_temp
as $$
  insert into pm_events (project_id, item_id, actor_id, actor_name, kind, summary, data)
  values (p_project, p_item, auth.uid(), coalesce(my_display_name(), 'one.solar'), p_kind, left(coalesce(p_summary, ''), 500), coalesce(p_data, '{}'))
  returning id;
$$;

-- ---- filters: a checked model turned into SQL (never SQL from the page) ----------------------------
--   { "all": [ … ] } | { "any": [ … ] } | { "not": … } | { "f": field, "op": operator, "v": value }
--   Fields: project type status owner reporter division subsystem sprint parent program · priority category
--   vehicle key title type_name status_name · due start created updated completed · progress estimate ·
--   blocked overdue milestone open_deps accepted awaiting mine watching unassigned · labels · text · cf.<key>
--   Operators: eq ne in nin lt lte gt gte contains empty notempty is within past last
create or replace function public.pmx_where(c jsonb, p_depth int default 0)
returns text language plpgsql stable set search_path = public, pg_temp
as $$
declare
  v_parts text[] := '{}';
  v_el    jsonb;
  f       text;
  op      text;
  v       jsonb;
  col     text;
  kind    text;
  k       text;
  s       text;
  lits    text;
  n       numeric;
begin
  if c is null or jsonb_typeof(c) <> 'object' or c = '{}'::jsonb then return 'true'; end if;
  if p_depth > 6 then raise exception 'That filter is nested too deeply.'; end if;
  if c ? 'all' or c ? 'any' then
    v := coalesce(c -> 'all', c -> 'any');
    if jsonb_typeof(v) <> 'array' then return 'true'; end if;
    if jsonb_array_length(v) > 40 then raise exception 'That filter has too many conditions.'; end if;
    for v_el in select * from jsonb_array_elements(v) loop
      v_parts := v_parts || pmx_where(v_el, p_depth + 1);
    end loop;
    if cardinality(v_parts) = 0 then return 'true'; end if;
    return '(' || array_to_string(v_parts, case when c ? 'all' then ' and ' else ' or ' end) || ')';
  end if;
  if c ? 'not' then return '(not ' || pmx_where(c -> 'not', p_depth + 1) || ')'; end if;

  f := coalesce(c ->> 'f', '');
  op := coalesce(c ->> 'op', 'eq');
  v := c -> 'v';
  if f in ('project', 'type', 'status', 'owner', 'reporter', 'division', 'subsystem', 'sprint', 'parent') then
    kind := 'uuid'; col := 'i.' || f || '_id';
  elsif f = 'program' then kind := 'uuid'; col := '(select pp.program_id from pm_projects pp where pp.id = i.project_id)';
  elsif f in ('priority', 'category', 'vehicle', 'key', 'title') then kind := 'text'; col := 'i.' || f;
  elsif f = 'type_name' then kind := 'text'; col := '(select tt.name from pm_types tt where tt.id = i.type_id)';
  elsif f = 'status_name' then kind := 'text'; col := '(select ss.name from pm_statuses ss where ss.id = i.status_id)';
  elsif f in ('due', 'start') then kind := 'date'; col := 'i.' || f || '_date';
  elsif f in ('created', 'updated', 'completed') then kind := 'date'; col := '(i.' || f || '_at)::date';
  elsif f = 'progress' then kind := 'num'; col := 'i.progress';
  elsif f = 'estimate' then kind := 'num'; col := 'i.estimate_hours';
  elsif f = 'blocked' then kind := 'bool'; col := 'i.blocked';
  elsif f = 'unassigned' then kind := 'bool'; col := '(i.owner_id is null)';
  elsif f = 'accepted' then kind := 'bool'; col := '(i.accepted_at is not null)';
  elsif f = 'overdue' then kind := 'bool'; col := '(i.due_date < current_date and i.category <> ''done'')';
  elsif f = 'milestone' then kind := 'bool'; col := '(select tt.is_milestone from pm_types tt where tt.id = i.type_id)';
  elsif f = 'open_deps' then kind := 'bool';
    col := 'exists (select 1 from pm_deps dd join pm_items xx on xx.id = dd.from_item where dd.to_item = i.id and xx.category <> ''done'' and xx.archived_at is null)';
  elsif f = 'awaiting' then kind := 'bool'; col := 'exists (select 1 from pm_approvals aa where aa.item_id = i.id and aa.status = ''pending'')';
  elsif f = 'mine' then kind := 'bool';
    col := '(i.owner_id = auth.uid() or exists (select 1 from pm_people pe where pe.item_id = i.id and pe.user_id = auth.uid() and pe.kind = ''collab''))';
  elsif f = 'watching' then kind := 'bool';
    col := 'exists (select 1 from pm_people pe where pe.item_id = i.id and pe.user_id = auth.uid() and pe.kind = ''watch'')';
  elsif f = 'labels' then kind := 'array'; col := 'i.labels';
  elsif f = 'text' then kind := 'search';
  elsif f ~ '^cf\.[a-z][a-z0-9_]{0,39}$' then kind := 'cf'; k := substr(f, 4); col := format('(i.custom ->> %L)', k);
  else raise exception 'Unknown filter field "%".', left(f, 40);
  end if;

  if op not in ('eq', 'ne', 'in', 'nin', 'lt', 'lte', 'gt', 'gte', 'contains', 'empty', 'notempty', 'is', 'within', 'past', 'last') then
    raise exception 'Unknown filter operator "%".', left(op, 20);
  end if;
  s := case when jsonb_typeof(v) in ('string', 'number', 'boolean') then v #>> '{}' else null end;

  if kind = 'bool' then
    return case when s = 'false' or op = 'ne' then '(not coalesce(' || col || ', false))' else 'coalesce(' || col || ', false)' end;
  end if;
  if kind = 'search' then
    if coalesce(s, '') = '' then return 'true'; end if;
    s := '%' || replace(replace(replace(left(s, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%';
    return format('(i.title ilike %L or i.key ilike %L or i.description ilike %L)', s, s, s);
  end if;
  if op in ('empty', 'notempty') then
    col := case kind when 'text' then format('(coalesce(%s, '''') = '''')', col) when 'array' then format('(cardinality(%s) = 0)', col)
                     when 'cf' then format('(coalesce(%s, '''') in ('''', ''[]''))', col) else format('(%s is null)', col) end;
    return case when op = 'empty' then col else '(not ' || col || ')' end;
  end if;

  if kind = 'date' and op in ('within', 'past', 'last') then
    n := coalesce(pmx_num(s), 0)::int;
    return case op when 'within' then format('(%s between current_date and current_date + %s)', col, n)
                   when 'past' then format('(%s < current_date - %s)', col, n)
                   else format('(%s between current_date - %s and current_date)', col, n) end;
  end if;

  -- a list of values
  if op in ('in', 'nin') or (kind = 'array' and jsonb_typeof(v) = 'array') then
    if jsonb_typeof(v) <> 'array' then v := jsonb_build_array(v); end if;
    if jsonb_array_length(v) > 200 then raise exception 'That filter has too many values.'; end if;
    select string_agg(case when kind = 'uuid' then case when x = 'me' then 'auth.uid()' else format('%L::uuid', pmx_uuid(x)) end else format('%L', x) end, ', ')
      into lits from jsonb_array_elements_text(v) x;
    if lits is null then return case when op = 'nin' then 'true' else 'false' end; end if;
    if kind = 'array' then
      return case when op = 'nin' then format('(not %s && array[%s]::text[])', col, lits) else format('(%s && array[%s]::text[])', col, lits) end;
    elsif kind = 'cf' then
      return case when op = 'nin' then format('(%s is null or (%s not in (%s) and not (i.custom -> %L) ?| array[%s]))', col, col, lits, k, lits)
                  else format('(%s in (%s) or (i.custom -> %L) ?| array[%s])', col, lits, k, lits) end;
    elsif kind = 'uuid' then
      return case when op = 'nin' then format('(%s is null or %s not in (%s))', col, col, lits) else format('(%s in (%s))', col, lits) end;
    else
      return case when op = 'nin' then format('(%s is null or %s::text not in (%s))', col, col, lits) else format('(%s::text in (%s))', col, lits) end;
    end if;
  end if;

  if s is null then raise exception 'The filter on "%" needs a value.', f; end if;
  if kind = 'uuid' then
    lits := case when s = 'me' then 'auth.uid()' else format('%L::uuid', pmx_uuid(s)) end;
    return case when op = 'ne' then format('(%s is distinct from %s)', col, lits) else format('(%s = %s)', col, lits) end;
  elsif kind = 'array' then
    return case when op = 'ne' then format('(not %L = any(%s))', s, col) else format('(%L = any(%s))', s, col) end;
  elsif kind = 'date' then
    lits := case when s = 'today' then 'current_date' else format('%L::date', s::date) end;
    return format('(%s %s %s)', col, case op when 'lt' then '<' when 'lte' then '<=' when 'gt' then '>' when 'gte' then '>=' when 'ne' then '<>' else '=' end, lits);
  elsif kind = 'num' then
    if pmx_num(s) is null then raise exception '"%" isn''t a number.', left(s, 40); end if;
    return format('(%s %s %s)', col, case op when 'lt' then '<' when 'lte' then '<=' when 'gt' then '>' when 'gte' then '>=' when 'ne' then '<>' else '=' end, pmx_num(s));
  elsif op = 'contains' then
    lits := '%' || replace(replace(replace(left(s, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%';
    return case when kind = 'cf' then format('(%s ilike %L or (i.custom -> %L) ? %L)', col, lits, k, s) else format('(%s ilike %L)', col, lits) end;
  elsif op in ('lt', 'lte', 'gt', 'gte') then
    if kind = 'cf' and pmx_num(s) is not null then
      return format('(pmx_num(%s) %s %s)', col, case op when 'lt' then '<' when 'lte' then '<=' when 'gt' then '>' else '>=' end, pmx_num(s));
    end if;
    return format('(%s %s %L)', col, case op when 'lt' then '<' when 'lte' then '<=' when 'gt' then '>' else '>=' end, s);
  elsif kind = 'cf' then
    return case when op = 'ne' then format('(%s is distinct from %L and not coalesce((i.custom -> %L) ? %L, false))', col, s, k, s)
                else format('(%s = %L or (i.custom -> %L) ? %L)', col, s, k, s) end;
  else
    return case when op = 'ne' then format('(%s is distinct from %L)', col, s) else format('(%s = %L)', col, s) end;
  end if;
end;
$$;

/** Does this item match the conditions? (transitions and automation rules) */
create or replace function public.pmx_matches(p_item uuid, c jsonb)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v boolean;
begin
  if c is null or c = '{}'::jsonb or jsonb_typeof(c) <> 'object' then return true; end if;
  execute 'select exists (select 1 from pm_items i where i.id = $1 and ' || pmx_where(c) || ')' into v using p_item;
  return v;
end;
$$;

/**
 * Items the signed-in person can see, filtered, sorted and paged.
 * p: { filter, q, project, archived, sort, dir, limit (≤ 1000), offset } → { total, items }
 */
create or replace function public.pm_search(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_vis    uuid[] := pm_visible();
  v_where  text;
  v_sort   text;
  v_limit  int := least(greatest(coalesce(pmx_num(p ->> 'limit'), 100)::int, 1), 1000);
  v_offset int := greatest(coalesce(pmx_num(p ->> 'offset'), 0)::int, 0);
  v_total  int;
  v_items  jsonb;
begin
  perform pmx_open();
  v_where := pmx_where(p -> 'filter');
  if coalesce(trim(p ->> 'q'), '') <> '' then
    v_where := v_where || ' and ' || pmx_where(jsonb_build_object('f', 'text', 'v', p ->> 'q'));
  end if;
  if coalesce(p ->> 'project', '') <> '' then v_where := v_where || format(' and i.project_id = %L::uuid', pmx_uuid(p ->> 'project')); end if;
  if not pmx_bool(p, 'archived', false) then v_where := v_where || ' and i.archived_at is null'; end if;
  v_sort := case coalesce(p ->> 'sort', '')
    when 'due' then 'i.due_date' when 'start' then 'i.start_date' when 'updated' then 'i.updated_at' when 'created' then 'i.created_at'
    when 'title' then 'lower(i.title)' when 'progress' then 'i.progress' when 'estimate' then 'i.estimate_hours'
    when 'priority' then 'array_position(array[''urgent'', ''high'', ''medium'', ''low''], i.priority)'
    when 'status' then '(select ss.sort from pm_statuses ss where ss.id = i.status_id)'
    when 'owner' then '(select lower(pr.full_name) from profiles pr where pr.id = i.owner_id)'
    when 'type' then '(select tt.sort from pm_types tt where tt.id = i.type_id)'
    when 'key' then 'i.created_at' else
      case when p ->> 'sort' ~ '^cf\.[a-z][a-z0-9_]{0,39}$' then format('(i.custom ->> %L)', substr(p ->> 'sort', 4)) else 'i.rank' end end;
  execute format('select count(*) from pm_items i where i.project_id = any($1) and %s', v_where) into v_total using v_vis;
  execute format($q$
    select coalesce(jsonb_agg(r), '[]'::jsonb) from (
      select (to_jsonb(i) - 'description' - 'acceptance' - 'op_id') || jsonb_build_object(
        'children', (select count(*) from pm_items c where c.parent_id = i.id and c.archived_at is null),
        'children_done', (select count(*) from pm_items c where c.parent_id = i.id and c.archived_at is null and c.category = 'done'),
        'open_deps', (select count(*) from pm_deps d join pm_items x on x.id = d.from_item
                      where d.to_item = i.id and x.category <> 'done' and x.archived_at is null)) as r
      from pm_items i where i.project_id = any($1) and %s
      order by %s %s nulls last, i.seq limit %s offset %s) q $q$,
    v_where, v_sort, case when p ->> 'dir' = 'desc' then 'desc' else 'asc' end, v_limit, v_offset) into v_items using v_vis;
  return jsonb_build_object('total', v_total, 'items', v_items);
end;
$$;

-- ---- notifications ---------------------------------------------------------------------------------
/**
 * Tell people about an item: the Projects inbox (always, unless they turned that kind off), and email / Teams
 * through the existing outbox when an Admin has turned "project_update" on. Never the person who did it,
 * never someone who can't see the project. The same unread notice within ten minutes is updated, not repeated.
 */
create or replace function public.pmx_notify(p_users uuid[], p_kind text, p_item uuid, p_title text, p_body text)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_item     pm_items;
  v_settings jsonb := (select value from app_settings where key = 'notifications');
  v_ev       jsonb := v_settings -> 'events' -> 'project_update';
  v_actor    text := coalesce(my_display_name(), 'one.solar');
  v_person   profiles;
  v_pref     jsonb;
  v_payload  jsonb;
  v_quiet    boolean := coalesce(current_setting('pm.quiet', true), '') = '1';
  v_system   boolean := coalesce(current_setting('pm.system', true), '') = '1';   -- a timed reminder: nobody "did" it
begin
  if v_system then v_actor := 'one.solar'; end if;
  select * into v_item from pm_items where id = p_item;
  if v_item.id is null then return; end if;
  v_payload := jsonb_build_object('what', v_item.key || ': ' || p_title, 'details', regexp_replace(p_body, '\s+', ' ', 'g'),
    'actor', v_actor, 'app_path', 'projects/#/projects/item/' || v_item.key);
  for v_person in
    select pr.* from profiles pr where pr.id = any(p_users) and (v_system or pr.id is distinct from auth.uid())
      and 'view' = any(pmx_caps_for(v_item.project_id, pr.id))
  loop
    v_pref := coalesce((select notify -> p_kind from pm_prefs where user_id = v_person.id), '{}');
    if (v_pref -> 'inapp') is distinct from 'false'::jsonb then
      update pm_notifications set title = p_title, body = p_body, actor_name = v_actor, created_at = now()
      where id = (select id from pm_notifications where user_id = v_person.id and item_id = p_item and kind = p_kind
                    and read_at is null and created_at > now() - interval '10 minutes' order by id desc limit 1);
      if not found then
        insert into pm_notifications (user_id, project_id, item_id, kind, title, body, actor_name)
        values (v_person.id, v_item.project_id, p_item, p_kind, p_title, p_body, v_actor);
      end if;
    end if;
    -- Email / Teams: not for bulk edits, and only the kinds that ask something of the person unless they opted in.
    if v_quiet or v_settings is null or (v_settings -> 'enabled') is distinct from 'true'::jsonb or v_ev is null then continue; end if;
    if (v_pref -> 'email') = 'false'::jsonb then continue; end if;
    if p_kind not in ('assigned', 'mentioned', 'review', 'due', 'dependency', 'automation') and (v_pref -> 'email') is distinct from 'true'::jsonb then continue; end if;
    if (v_ev -> 'email') = 'true'::jsonb and v_person.notify_email
       and (v_person.notify_events -> 'project_update' -> 'email') is distinct from 'false'::jsonb then
      insert into notification_outbox (event, recipient_id, email, channel, payload)
      values ('project_update', v_person.id, v_person.email, 'email', v_payload || jsonb_build_object('recipient_name', v_person.full_name));
    end if;
    if (v_ev -> 'teams') = 'true'::jsonb and v_person.notify_teams
       and (v_person.notify_events -> 'project_update' -> 'teams') is distinct from 'false'::jsonb then
      insert into notification_outbox (event, recipient_id, email, channel, payload)
      values ('project_update', v_person.id, v_person.email, 'teams', v_payload || jsonb_build_object('recipient_name', v_person.full_name));
    end if;
  end loop;
end;
$$;

/** The people to tell about an item: owner, reporter, collaborators and watchers. */
create or replace function public.pmx_audience(p_item uuid)
returns uuid[] language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct u) filter (where u is not null), '{}'::uuid[]) from (
    select owner_id as u from pm_items where id = p_item
    union select reporter_id from pm_items where id = p_item
    union select user_id from pm_people where item_id = p_item) x;
$$;

-- ---- configuration as one document: templates, export / import, copying between projects --------------
/**
 * A starting configuration. p_statuses: [[name, category, color]…] in order; p_types: [[name, icon, color, level,
 * milestone]…]; p_fields: [[key, name, type, [options]]…]; p_gate: the status that needs approval to enter;
 * p_free: any status can move to any other (otherwise forward / back one step).
 */
create or replace function public.pmx_make_config(p_statuses jsonb, p_types jsonb, p_fields jsonb, p_gate text, p_free boolean)
returns jsonb language plpgsql volatile set search_path = public, pg_temp
as $$
declare
  v_wf     uuid := gen_random_uuid();
  v_roles  jsonb;
  v_st     jsonb := '[]';
  v_tr     jsonb := '[]';
  v_types  jsonb := '[]';
  v_fields jsonb := '[]';
  v_ids    uuid[] := '{}';
  v_viewer uuid := gen_random_uuid();
  r        jsonb;
  i        int := 0;
  n        int := jsonb_array_length(p_statuses);
begin
  v_roles := jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid(), 'key', 'admin', 'name', 'Project Administrator', 'sort', 1, 'caps', to_jsonb(pmx_all_caps())),
    jsonb_build_object('id', gen_random_uuid(), 'key', 'manager', 'name', 'Project Manager', 'sort', 2, 'caps',
      to_jsonb(array['view', 'create', 'edit', 'assign', 'transition', 'approve', 'comment', 'delete', 'plan', 'boards', 'automations', 'members'])),
    jsonb_build_object('id', gen_random_uuid(), 'key', 'contributor', 'name', 'Contributor', 'sort', 3, 'caps',
      to_jsonb(array['view', 'create', 'edit', 'assign', 'transition', 'comment'])),
    jsonb_build_object('id', gen_random_uuid(), 'key', 'approver', 'name', 'Approver', 'sort', 4, 'caps',
      to_jsonb(array['view', 'comment', 'transition', 'approve'])),
    jsonb_build_object('id', v_viewer, 'key', 'viewer', 'name', 'Viewer', 'sort', 5, 'caps', to_jsonb(array['view', 'comment'])));
  for r in select * from jsonb_array_elements(p_statuses) loop
    v_ids := v_ids || gen_random_uuid();
    i := i + 1;
    v_st := v_st || jsonb_build_object('id', v_ids[i], 'name', r ->> 0, 'category', r ->> 1, 'color', coalesce(r ->> 2, 'gray'),
      'sort', i * 10, 'x', 40 + (i - 1) * 190, 'y', 70);
  end loop;
  for i in 1..n loop
    if p_free then
      v_tr := v_tr || jsonb_build_object('id', gen_random_uuid(), 'name', p_statuses -> (i - 1) ->> 0, 'from_status', null, 'to_status', v_ids[i], 'sort', i * 10);
    else
      if i < n then
        v_tr := v_tr || jsonb_build_object('id', gen_random_uuid(), 'name', 'Move to ' || (p_statuses -> i ->> 0), 'from_status', v_ids[i], 'to_status', v_ids[i + 1],
          'sort', i * 20, 'require_approval', (p_statuses -> i ->> 0) is not distinct from p_gate);
        v_tr := v_tr || jsonb_build_object('id', gen_random_uuid(), 'name', 'Back to ' || (p_statuses -> (i - 1) ->> 0), 'from_status', v_ids[i + 1], 'to_status', v_ids[i],
          'sort', i * 20 + 1);
      end if;
    end if;
  end loop;
  i := 0;
  for r in select * from jsonb_array_elements(p_types) loop
    i := i + 1;
    v_types := v_types || jsonb_build_object('id', gen_random_uuid(), 'name', r ->> 0, 'icon', coalesce(r ->> 1, ''), 'color', coalesce(r ->> 2, 'blue'),
      'level', coalesce((r ->> 3)::int, 1), 'is_milestone', coalesce((r ->> 4)::boolean, false), 'workflow_id', v_wf, 'sort', i * 10);
  end loop;
  i := 0;
  for r in select * from jsonb_array_elements(coalesce(p_fields, '[]')) loop
    i := i + 1;
    v_fields := v_fields || jsonb_build_object('id', gen_random_uuid(), 'key', r ->> 0, 'name', r ->> 1, 'type', r ->> 2,
      'options', coalesce(r -> 3, '[]'), 'sort', i * 10);
  end loop;
  return jsonb_build_object('format', 1, 'visibility', 'team', 'team_role', v_viewer,
    'settings', jsonb_build_object('working_days', jsonb_build_array(1, 2, 3, 4, 5), 'holidays', '[]'::jsonb, 'sprints', false, 'sprint_days', 14),
    'roles', v_roles,
    'workflows', jsonb_build_array(jsonb_build_object('id', v_wf, 'name', 'Workflow', 'statuses', v_st, 'transitions', v_tr)),
    'types', v_types, 'fields', v_fields, 'layouts', '[]'::jsonb, 'views', '[]'::jsonb, 'automations', '[]'::jsonb, 'items', '[]'::jsonb, 'deps', '[]'::jsonb);
end;
$$;

create or replace function public.pmx_default_config()
returns jsonb language sql volatile set search_path = public, pg_temp
as $$
  select pmx_make_config(
    '[["To Do", "todo", "gray"], ["In Progress", "doing", "blue"], ["In Review", "doing", "purple"], ["Done", "done", "green"]]',
    '[["Epic", "◆", "purple", 0, false], ["Task", "✓", "blue", 1, false], ["Subtask", "↳", "gray", 2, false], ["Milestone", "⚑", "orange", 1, true], ["Bug", "●", "red", 1, false]]',
    '[]', null, true);
$$;

/** A project's whole configuration as one document (ids kept, so the parts still point at each other). */
create or replace function public.pmx_export(p_project uuid, p_items boolean)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  p      pm_projects;
  v_base date;
  v      jsonb;
begin
  select * into p from pm_projects where id = p_project;
  v := jsonb_build_object('format', 1, 'visibility', p.visibility, 'team_role', p.team_role_id, 'settings', p.settings,
    'roles', coalesce((select jsonb_agg(to_jsonb(r) - 'project_id' order by r.sort, r.name) from pm_roles r where r.project_id = p_project), '[]'),
    'workflows', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'description', w.description,
        'statuses', coalesce((select jsonb_agg(to_jsonb(s) - 'project_id' - 'workflow_id' order by s.sort, s.name) from pm_statuses s where s.workflow_id = w.id), '[]'),
        'transitions', coalesce((select jsonb_agg(to_jsonb(t) - 'project_id' - 'workflow_id' order by t.sort, t.name) from pm_transitions t where t.workflow_id = w.id), '[]'))
        order by w.created_at, w.name) from pm_workflows w where w.project_id = p_project and w.archived_at is null), '[]'),
    'types', coalesce((select jsonb_agg(to_jsonb(t) - 'project_id' - 'archived_at' order by t.sort, t.name) from pm_types t where t.project_id = p_project and t.archived_at is null), '[]'),
    'fields', coalesce((select jsonb_agg(to_jsonb(f) - 'project_id' - 'archived_at' order by f.sort, f.name) from pm_fields f where f.project_id = p_project and f.archived_at is null), '[]'),
    'layouts', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'type_id', l.type_id, 'kind', l.kind, 'transition_id', l.transition_id, 'sections', l.sections))
        from pm_layouts l where l.project_id = p_project), '[]'),
    'views', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'kind', w.kind, 'name', w.name, 'config', w.config, 'is_default', w.is_default) order by w.name)
        from pm_views w where w.project_id = p_project and w.sharing = 'project'), '[]'),
    'automations', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'enabled', a.enabled, 'trigger', a.trigger,
        'trigger_config', a.trigger_config, 'conditions', a.conditions, 'actions', a.actions) order by a.name) from pm_automations a where a.project_id = p_project), '[]'),
    'items', '[]'::jsonb, 'deps', '[]'::jsonb);
  if p_items then
    select min(least(coalesce(start_date, due_date), coalesce(due_date, start_date))) into v_base from pm_items where project_id = p_project and archived_at is null;
    v := v || jsonb_build_object(
      'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'type_id', i.type_id, 'parent_id', i.parent_id, 'title', i.title,
          'description', i.description, 'status_id', i.status_id, 'priority', i.priority, 'estimate_hours', i.estimate_hours, 'labels', i.labels,
          'acceptance', i.acceptance, 'custom', i.custom, 'start_offset', i.start_date - v_base, 'due_offset', i.due_date - v_base,
          'checklist', coalesce((select jsonb_agg(c.text order by c.sort) from pm_checklist c where c.item_id = i.id), '[]')) order by i.seq)
        from pm_items i where i.project_id = p_project and i.archived_at is null), '[]'),
      'deps', coalesce((select jsonb_agg(jsonb_build_object('from_item', d.from_item, 'to_item', d.to_item, 'kind', d.kind, 'lag_days', d.lag_days))
        from pm_deps d where d.from_project = p_project and d.to_project = p_project), '[]'));
  end if;
  return v;
end;
$$;

create or replace function public.pm_export_config(p_project uuid, p_items boolean)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform pmx_need(p_project, 'view');
  return pmx_export(p_project, coalesce(p_items, false));
end;
$$;

/**
 * Put a configuration document into a project. Parts: roles, workflows, types, fields, layouts, views,
 * automations, settings, items. Things are matched to what the project already has by name (roles and fields by
 * key): matches are updated, the rest added. Nothing is ever removed and existing items are never touched, so
 * applying a template to a project that's in use can't orphan work. With p_dry it changes nothing and returns
 * what would happen: [{ part, name, action: add | update | same }].
 */
create or replace function public.pmx_apply_config(p_project uuid, p_config jsonb, p_parts text[], p_dry boolean, p_start date)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  c        jsonb := p_config;
  v_text   text;
  v_parts  text[] := p_parts;
  v_out    jsonb := '[]';
  r        record;
  v_new    uuid;
  w        jsonb;
  o        jsonb;
  v_exists boolean;
  v_same   boolean;
  v_seq    int;
  v_key    text;
  v_rank   numeric;
  v_wfv    int;
begin
  if jsonb_typeof(c) <> 'object' or (c ->> 'format') is distinct from '1' then
    raise exception 'That isn''t a one.solar project configuration (format 1).';
  end if;
  if octet_length(c::text) > 2000000 then raise exception 'That configuration is too big.'; end if;
  if 'items' = any(v_parts) then v_parts := v_parts || array['layouts', 'types', 'fields', 'workflows', 'roles']; end if;
  if 'layouts' = any(v_parts) then v_parts := v_parts || array['types', 'fields', 'workflows']; end if;
  if 'types' = any(v_parts) or 'views' = any(v_parts) or 'automations' = any(v_parts) then v_parts := v_parts || array['workflows']; end if;
  if 'workflows' = any(v_parts) then v_parts := v_parts || array['roles']; end if;

  -- Every id in the document becomes this project's own: the id of what it matches here, or a new one.
  v_text := c::text;
  for r in
    select x.old, x.found from (
      select (e ->> 'id') as old, (select id from pm_roles t where t.project_id = p_project and t.key = e ->> 'key') as found
        from jsonb_array_elements(coalesce(c -> 'roles', '[]')) e
      union all select e ->> 'id', (select id from pm_workflows t where t.project_id = p_project and t.archived_at is null and lower(trim(t.name)) = lower(trim(e ->> 'name')))
        from jsonb_array_elements(coalesce(c -> 'workflows', '[]')) e
      union all select s ->> 'id', (select t.id from pm_statuses t join pm_workflows tw on tw.id = t.workflow_id
          where tw.project_id = p_project and tw.archived_at is null and lower(trim(tw.name)) = lower(trim(e ->> 'name')) and lower(trim(t.name)) = lower(trim(s ->> 'name')))
        from jsonb_array_elements(coalesce(c -> 'workflows', '[]')) e, jsonb_array_elements(coalesce(e -> 'statuses', '[]')) s
      union all select s ->> 'id', (select t.id from pm_transitions t where t.project_id = p_project and t.id::text = s ->> 'id')
        from jsonb_array_elements(coalesce(c -> 'workflows', '[]')) e, jsonb_array_elements(coalesce(e -> 'transitions', '[]')) s
      union all select e ->> 'id', (select id from pm_types t where t.project_id = p_project and t.archived_at is null and lower(trim(t.name)) = lower(trim(e ->> 'name')))
        from jsonb_array_elements(coalesce(c -> 'types', '[]')) e
      union all select e ->> 'id', (select id from pm_fields t where t.project_id = p_project and t.key = e ->> 'key')
        from jsonb_array_elements(coalesce(c -> 'fields', '[]')) e
      union all select e ->> 'id', (select id from pm_automations t where t.project_id = p_project and lower(trim(t.name)) = lower(trim(e ->> 'name')) limit 1)
        from jsonb_array_elements(coalesce(c -> 'automations', '[]')) e
      union all select e ->> 'id', (select id from pm_views t where t.project_id = p_project and t.sharing = 'project' and t.kind = e ->> 'kind'
          and lower(trim(t.name)) = lower(trim(e ->> 'name')) limit 1)
        from jsonb_array_elements(coalesce(c -> 'views', '[]')) e
      union all select e ->> 'id', null::uuid from jsonb_array_elements(coalesce(c -> 'layouts', '[]')) e
      union all select e ->> 'id', null::uuid from jsonb_array_elements(coalesce(c -> 'items', '[]')) e
    ) x where x.old is not null
  loop
    perform pmx_uuid(r.old);
    v_new := coalesce(r.found, gen_random_uuid());
    if v_new::text <> r.old then v_text := replace(v_text, r.old, v_new::text); end if;
  end loop;
  c := v_text::jsonb;

  -- roles
  if 'roles' = any(v_parts) then
    for o in select * from jsonb_array_elements(coalesce(c -> 'roles', '[]')) loop
      select true, (r2.name = o ->> 'name' and r2.caps @> pmx_texts(o -> 'caps') and r2.caps <@ pmx_texts(o -> 'caps')) into v_exists, v_same
        from pm_roles r2 where r2.id = pmx_uuid(o ->> 'id');
      v_out := v_out || jsonb_build_object('part', 'roles', 'name', o ->> 'name', 'action', case when v_exists is null then 'add' when v_same then 'same' else 'update' end);
      if not p_dry then
        insert into pm_roles (id, project_id, key, name, caps, sort)
        values (pmx_uuid(o ->> 'id'), p_project, o ->> 'key', o ->> 'name',
          array(select x from unnest(pmx_texts(o -> 'caps')) x where x = any(pmx_all_caps())), coalesce((o ->> 'sort')::int, 100))
        on conflict (id) do update set name = excluded.name, caps = excluded.caps, sort = excluded.sort;
      end if;
      v_exists := null;
    end loop;
  end if;

  -- workflows, their statuses and transitions
  if 'workflows' = any(v_parts) then
    for w in select * from jsonb_array_elements(coalesce(c -> 'workflows', '[]')) loop
      select true into v_exists from pm_workflows where id = pmx_uuid(w ->> 'id');
      v_out := v_out || jsonb_build_object('part', 'workflows', 'name', w ->> 'name', 'action', case when v_exists is null then 'add' else 'update' end);
      for o in select * from jsonb_array_elements(coalesce(w -> 'statuses', '[]')) loop
        if not exists (select 1 from pm_statuses where id = pmx_uuid(o ->> 'id')) then
          v_out := v_out || jsonb_build_object('part', 'statuses', 'name', (w ->> 'name') || ': ' || (o ->> 'name'), 'action', 'add');
        end if;
      end loop;
      if not p_dry then
        insert into pm_workflows (id, project_id, name, description) values (pmx_uuid(w ->> 'id'), p_project, w ->> 'name', coalesce(w ->> 'description', ''))
        on conflict (id) do update set description = excluded.description, version = pm_workflows.version + 1, updated_at = now()
        returning version into v_wfv;
        insert into pm_statuses (id, workflow_id, project_id, name, category, color, sort, x, y)
        select pmx_uuid(s ->> 'id'), pmx_uuid(w ->> 'id'), p_project, s ->> 'name', s ->> 'category', coalesce(s ->> 'color', 'gray'),
               coalesce((s ->> 'sort')::int, 100), coalesce((s ->> 'x')::int, 0), coalesce((s ->> 'y')::int, 0)
        from jsonb_array_elements(coalesce(w -> 'statuses', '[]')) s
        on conflict (id) do update set category = excluded.category, color = excluded.color, sort = excluded.sort, x = excluded.x, y = excluded.y;
        update pm_items i set category = s.category from pm_statuses s where s.id = i.status_id and s.workflow_id = pmx_uuid(w ->> 'id') and i.category <> s.category;
        delete from pm_transitions t where t.workflow_id = pmx_uuid(w ->> 'id')
          and t.id not in (select pmx_uuid(s ->> 'id') from jsonb_array_elements(coalesce(w -> 'transitions', '[]')) s);
        insert into pm_transitions (id, workflow_id, project_id, name, from_status, to_status, description, role_ids, require_fields, require_comment,
                                    require_approval, no_self_approval, conditions, actions, sort)
        select pmx_uuid(s ->> 'id'), pmx_uuid(w ->> 'id'), p_project, s ->> 'name', pmx_uuid(s ->> 'from_status'), pmx_uuid(s ->> 'to_status'),
               coalesce(s ->> 'description', ''), array(select x from unnest(pmx_uuids(s -> 'role_ids')) x where exists (select 1 from pm_roles pr where pr.id = x and pr.project_id = p_project)),
               pmx_texts(s -> 'require_fields'), pmx_bool(s, 'require_comment', false), pmx_bool(s, 'require_approval', false), pmx_bool(s, 'no_self_approval', false),
               nullif(s -> 'conditions', 'null'), coalesce(nullif(s -> 'actions', 'null'), '[]'), coalesce((s ->> 'sort')::int, 100)
        from jsonb_array_elements(coalesce(w -> 'transitions', '[]')) s
        on conflict (id) do update set name = excluded.name, from_status = excluded.from_status, to_status = excluded.to_status, description = excluded.description,
          role_ids = excluded.role_ids, require_fields = excluded.require_fields, require_comment = excluded.require_comment,
          require_approval = excluded.require_approval, no_self_approval = excluded.no_self_approval, conditions = excluded.conditions,
          actions = excluded.actions, sort = excluded.sort;
        perform pmx_where(t.conditions) from pm_transitions t where t.workflow_id = pmx_uuid(w ->> 'id');
        insert into pm_workflow_versions (workflow_id, project_id, version, snapshot, note, created_by)
        values (pmx_uuid(w ->> 'id'), p_project, v_wfv, pmx_workflow_json(pmx_uuid(w ->> 'id')), 'From a template or another project', auth.uid());
      end if;
      v_exists := null;
    end loop;
  end if;

  -- work-item types
  if 'types' = any(v_parts) then
    for o in select * from jsonb_array_elements(coalesce(c -> 'types', '[]')) loop
      select true into v_exists from pm_types where id = pmx_uuid(o ->> 'id');
      v_out := v_out || jsonb_build_object('part', 'types', 'name', o ->> 'name', 'action', case when v_exists is null then 'add' else 'update' end);
      if not p_dry then
        insert into pm_types (id, project_id, name, icon, color, description, level, parent_type_ids, workflow_id, is_milestone, defaults, sort)
        values (pmx_uuid(o ->> 'id'), p_project, o ->> 'name', coalesce(o ->> 'icon', ''), coalesce(o ->> 'color', 'blue'), coalesce(o ->> 'description', ''),
          coalesce((o ->> 'level')::int, 1), pmx_uuids(o -> 'parent_type_ids'), pmx_uuid(o ->> 'workflow_id'), pmx_bool(o, 'is_milestone', false),
          coalesce(nullif(o -> 'defaults', 'null'), '{}'), coalesce((o ->> 'sort')::int, 100))
        -- a type that already has items keeps its workflow (changing it needs a status mapping: Settings → Work types)
        on conflict (id) do update set icon = excluded.icon, color = excluded.color, description = excluded.description, level = excluded.level,
          parent_type_ids = excluded.parent_type_ids, is_milestone = excluded.is_milestone, defaults = excluded.defaults, sort = excluded.sort,
          workflow_id = case when exists (select 1 from pm_items i where i.type_id = pm_types.id) then pm_types.workflow_id else excluded.workflow_id end;
      end if;
      v_exists := null;
    end loop;
    if not p_dry then
      update pm_types t set parent_type_ids = array(select x from unnest(t.parent_type_ids) x where exists (select 1 from pm_types t2 where t2.id = x and t2.project_id = p_project))
      where t.project_id = p_project;
    end if;
  end if;

  -- custom fields
  if 'fields' = any(v_parts) then
    for o in select * from jsonb_array_elements(coalesce(c -> 'fields', '[]')) loop
      select true, f.type into v_exists, v_key from pm_fields f where f.id = pmx_uuid(o ->> 'id');
      if v_exists and v_key <> o ->> 'type' then
        raise exception 'The field "%" is a % here and a % in the template: a field''s kind can''t change.', o ->> 'name', v_key, o ->> 'type';
      end if;
      v_out := v_out || jsonb_build_object('part', 'fields', 'name', o ->> 'name', 'action', case when v_exists is null then 'add' else 'update' end);
      if not p_dry then
        insert into pm_fields (id, project_id, key, name, type, description, options, default_value, validation, formula, type_ids, sort)
        values (pmx_uuid(o ->> 'id'), p_project, o ->> 'key', o ->> 'name', o ->> 'type', coalesce(o ->> 'description', ''), coalesce(nullif(o -> 'options', 'null'), '[]'),
          nullif(o -> 'default_value', 'null'), coalesce(nullif(o -> 'validation', 'null'), '{}'), coalesce(o ->> 'formula', ''),
          array(select x from unnest(pmx_uuids(o -> 'type_ids')) x where exists (select 1 from pm_types t2 where t2.id = x and t2.project_id = p_project)),
          coalesce((o ->> 'sort')::int, 100))
        on conflict (id) do update set name = excluded.name, description = excluded.description, options = excluded.options, default_value = excluded.default_value,
          validation = excluded.validation, formula = excluded.formula, type_ids = excluded.type_ids, sort = excluded.sort, archived_at = null;
      end if;
      v_exists := null;
    end loop;
  end if;

  -- form layouts
  if 'layouts' = any(v_parts) and jsonb_array_length(coalesce(c -> 'layouts', '[]')) > 0 then
    v_out := v_out || jsonb_build_object('part', 'layouts', 'name', jsonb_array_length(c -> 'layouts') || ' form layout(s)', 'action', 'update');
    if not p_dry then
      for o in select * from jsonb_array_elements(c -> 'layouts') loop
        delete from pm_layouts l where l.project_id = p_project and l.type_id is not distinct from pmx_uuid(o ->> 'type_id') and l.kind = o ->> 'kind'
          and l.transition_id is not distinct from pmx_uuid(o ->> 'transition_id');
        insert into pm_layouts (project_id, type_id, kind, transition_id, sections, updated_by)
        values (p_project, pmx_uuid(o ->> 'type_id'), o ->> 'kind', pmx_uuid(o ->> 'transition_id'), coalesce(o -> 'sections', '[]'), auth.uid());
      end loop;
    end if;
  end if;

  -- shared boards and views
  if 'views' = any(v_parts) then
    for o in select * from jsonb_array_elements(coalesce(c -> 'views', '[]')) loop
      select true into v_exists from pm_views where id = pmx_uuid(o ->> 'id');
      v_out := v_out || jsonb_build_object('part', 'views', 'name', o ->> 'name', 'action', case when v_exists is null then 'add' else 'update' end);
      if not p_dry then
        insert into pm_views (id, owner_id, project_id, kind, name, sharing, config, is_default)
        values (pmx_uuid(o ->> 'id'), auth.uid(), p_project, o ->> 'kind', o ->> 'name', 'project', coalesce(o -> 'config', '{}'), pmx_bool(o, 'is_default', false))
        on conflict (id) do update set config = excluded.config, is_default = excluded.is_default, version = pm_views.version + 1, updated_at = now();
      end if;
      v_exists := null;
    end loop;
  end if;

  -- automation rules
  if 'automations' = any(v_parts) then
    for o in select * from jsonb_array_elements(coalesce(c -> 'automations', '[]')) loop
      select true into v_exists from pm_automations where id = pmx_uuid(o ->> 'id');
      v_out := v_out || jsonb_build_object('part', 'automations', 'name', o ->> 'name', 'action', case when v_exists is null then 'add' else 'update' end);
      if not p_dry then
        perform pmx_where(nullif(o -> 'conditions', 'null'));
        perform pmx_check_actions(p_project, coalesce(nullif(o -> 'actions', 'null'), '[]'));
        insert into pm_automations (id, project_id, name, enabled, trigger, trigger_config, conditions, actions, created_by)
        values (pmx_uuid(o ->> 'id'), p_project, o ->> 'name', pmx_bool(o, 'enabled', true), o ->> 'trigger', coalesce(nullif(o -> 'trigger_config', 'null'), '{}'),
          nullif(o -> 'conditions', 'null'), coalesce(nullif(o -> 'actions', 'null'), '[]'), auth.uid())
        on conflict (id) do update set enabled = excluded.enabled, trigger = excluded.trigger, trigger_config = excluded.trigger_config,
          conditions = excluded.conditions, actions = excluded.actions, version = pm_automations.version + 1, updated_at = now();
      end if;
      v_exists := null;
    end loop;
  end if;

  -- project settings (working days, holidays, sprints, who the team role is)
  if 'settings' = any(v_parts) then
    v_out := v_out || jsonb_build_object('part', 'settings', 'name', 'Working days, holidays and other project settings', 'action', 'update');
    if not p_dry then
      update pm_projects set settings = settings || coalesce(nullif(c -> 'settings', 'null'), '{}'),
        team_role_id = coalesce((select id from pm_roles where id = pmx_uuid(c ->> 'team_role') and project_id = p_project), team_role_id), updated_at = now()
      where id = p_project;
    end if;
  end if;

  -- starter items (epics, tasks, milestones) with dates counted from p_start
  if 'items' = any(v_parts) and jsonb_array_length(coalesce(c -> 'items', '[]')) > 0 then
    v_out := v_out || jsonb_build_object('part', 'items', 'name', jsonb_array_length(c -> 'items') || ' starter item(s)', 'action', 'add');
    if not p_dry then
      select coalesce(max(rank), 0) into v_rank from pm_items where project_id = p_project;
      for o in select * from jsonb_array_elements(c -> 'items') loop
        update pm_projects set item_seq = item_seq + 1 where id = p_project returning item_seq, key into v_seq, v_key;
        v_rank := v_rank + 1000;
        insert into pm_items (id, project_id, type_id, seq, key, title, description, status_id, category, priority, estimate_hours, labels, acceptance,
                              custom, start_date, due_date, reporter_id, created_by, rank)
        select pmx_uuid(o ->> 'id'), p_project, pmx_uuid(o ->> 'type_id'), v_seq, v_key || '-' || v_seq, o ->> 'title', coalesce(o ->> 'description', ''),
               s.id, s.category, coalesce(o ->> 'priority', 'medium'), pmx_num(o ->> 'estimate_hours'), pmx_texts(o -> 'labels'), coalesce(o ->> 'acceptance', ''),
               coalesce(nullif(o -> 'custom', 'null'), '{}'), p_start + (o ->> 'start_offset')::int, p_start + (o ->> 'due_offset')::int, auth.uid(), auth.uid(), v_rank
        from pm_statuses s where s.id = pmx_uuid(o ->> 'status_id') and s.project_id = p_project;
        if not found then raise exception 'The starter item "%" has a status this project doesn''t have.', o ->> 'title'; end if;
        insert into pm_checklist (item_id, project_id, text, sort)
        select pmx_uuid(o ->> 'id'), p_project, x.t, x.n from jsonb_array_elements_text(coalesce(o -> 'checklist', '[]')) with ordinality x(t, n);
      end loop;
      update pm_items i set parent_id = pmx_uuid(o2 ->> 'parent_id')
      from jsonb_array_elements(c -> 'items') o2
      where i.id = pmx_uuid(o2 ->> 'id') and (o2 ->> 'parent_id') is not null
        and exists (select 1 from pm_items x where x.id = pmx_uuid(o2 ->> 'parent_id') and x.project_id = p_project);
      insert into pm_deps (from_item, to_item, from_project, to_project, kind, lag_days, created_by)
      select pmx_uuid(d ->> 'from_item'), pmx_uuid(d ->> 'to_item'), p_project, p_project, coalesce(d ->> 'kind', 'FS'), coalesce((d ->> 'lag_days')::int, 0), auth.uid()
      from jsonb_array_elements(coalesce(c -> 'deps', '[]')) d
      where exists (select 1 from pm_items x where x.id = pmx_uuid(d ->> 'from_item') and x.project_id = p_project)
        and exists (select 1 from pm_items x where x.id = pmx_uuid(d ->> 'to_item') and x.project_id = p_project);
    end if;
  end if;

  if not p_dry then
    -- every type needs a workflow of this project, every workflow a status
    if exists (select 1 from pm_types t where t.project_id = p_project and not exists (select 1 from pm_workflows w where w.id = t.workflow_id and w.project_id = p_project)) then
      raise exception 'A work-item type in that configuration points at a workflow it doesn''t include.';
    end if;
    if exists (select 1 from pm_workflows w where w.project_id = p_project and not exists (select 1 from pm_statuses s where s.workflow_id = w.id)) then
      raise exception 'A workflow in that configuration has no statuses.';
    end if;
  end if;
  return v_out;
end;
$$;

/** A workflow with its statuses and transitions, as kept in its version history. */
create or replace function public.pmx_workflow_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object('id', w.id, 'name', w.name, 'description', w.description, 'version', w.version,
    'statuses', coalesce((select jsonb_agg(to_jsonb(s) - 'project_id' - 'workflow_id' order by s.sort, s.name) from pm_statuses s where s.workflow_id = w.id), '[]'),
    'transitions', coalesce((select jsonb_agg(to_jsonb(t) - 'project_id' - 'workflow_id' order by t.sort, t.name) from pm_transitions t where t.workflow_id = w.id), '[]'))
  from pm_workflows w where w.id = p_id;
$$;

-- ---- programs, projects, roles and members ---------------------------------------------------------
create or replace function public.pm_save_program(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v pm_programs;
begin
  perform pmx_open();
  if not (has_permission('projects.create') or has_permission('projects.manage')) then
    raise exception 'Your role can''t change programs (it needs "Create projects").' using errcode = '42501';
  end if;
  if p_id is null then
    insert into pm_programs (name, description, vehicle, sort, created_by)
    values (trim(p ->> 'name'), coalesce(p ->> 'description', ''), coalesce(p ->> 'vehicle', ''), coalesce((p ->> 'sort')::int, 100), auth.uid())
    returning * into v;
  else
    update pm_programs set name = coalesce(nullif(trim(p ->> 'name'), ''), name), description = coalesce(p ->> 'description', description),
      vehicle = coalesce(p ->> 'vehicle', vehicle), sort = coalesce((p ->> 'sort')::int, sort),
      archived_at = case when p ? 'archived' then case when pmx_bool(p, 'archived', false) then coalesce(archived_at, now()) end else archived_at end,
      updated_at = now()
    where id = p_id returning * into v;
    if v.id is null then raise exception 'That program doesn''t exist.'; end if;
  end if;
  return to_jsonb(v);
end;
$$;

create or replace function public.pmx_check_settings(p jsonb)
returns jsonb language plpgsql immutable set search_path = public, pg_temp
as $$
declare d text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return '{}'::jsonb; end if;
  if octet_length(p::text) > 20000 then raise exception 'Those project settings are too big.'; end if;
  if p ? 'working_days' then
    if jsonb_typeof(p -> 'working_days') <> 'array' or jsonb_array_length(p -> 'working_days') = 0
       or exists (select 1 from jsonb_array_elements_text(p -> 'working_days') x where x !~ '^[0-6]$') then
      raise exception 'Pick at least one working day.';
    end if;
  end if;
  if p ? 'holidays' then
    if jsonb_typeof(p -> 'holidays') <> 'array' then raise exception 'Days off must be a list of dates.'; end if;
    for d in select * from jsonb_array_elements_text(p -> 'holidays') loop
      begin perform d::date; exception when others then raise exception '"%" isn''t a date.', left(d, 30); end;
    end loop;
  end if;
  return p;
end;
$$;

/**
 * Create a project (from a template, a configuration document, or the standard starting point) or change its
 * details. p: { key, name, description, program_id, lead_id, division_id, subsystem_id, participants, vehicle,
 * visibility, team_role_id, settings, archived, version, template_id | config, start_date }
 */
create or replace function public.pm_save_project(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  o        pm_projects;
  v        pm_projects;
  v_config jsonb;
  v_key    text := upper(trim(coalesce(p ->> 'key', '')));
  v_role   uuid;
  v_sub    org_subsystems;
begin
  perform pmx_open();
  if p_id is null then
    if not (has_permission('projects.create') or has_permission('projects.manage')) then
      raise exception 'Your role can''t create projects (it needs "Create projects").' using errcode = '42501';
    end if;
    if v_key !~ '^[A-Z][A-Z0-9]{1,9}$' then raise exception 'The project key is 2 to 10 capital letters or numbers, starting with a letter (e.g. BAT).'; end if;
    if exists (select 1 from pm_projects where key = v_key) then raise exception 'Another project already uses the key %.', v_key using errcode = 'OS412'; end if;
    if trim(coalesce(p ->> 'name', '')) = '' then raise exception 'Give the project a name.'; end if;
    insert into pm_projects (key, name, created_by, lead_id) values (v_key, trim(p ->> 'name'), auth.uid(), auth.uid()) returning * into o;
    v_config := case
      when coalesce(p ->> 'template_id', '') <> '' then (select config from pm_templates where id = pmx_uuid(p ->> 'template_id') and archived_at is null)
      when jsonb_typeof(p -> 'config') = 'object' then p -> 'config'
      else pmx_default_config() end;
    if v_config is null then raise exception 'That template doesn''t exist any more.'; end if;
    perform pmx_apply_config(o.id, v_config, array['roles', 'workflows', 'types', 'fields', 'layouts', 'views', 'automations', 'settings']
      || case when pmx_bool(p, 'include_items', true) then array['items'] else '{}'::text[] end, false, coalesce(nullif(p ->> 'start_date', '')::date, current_date));
    if not exists (select 1 from pm_types where project_id = o.id) then raise exception 'That configuration has no work-item types.'; end if;
    select id into v_role from pm_roles where project_id = o.id order by (key = 'admin') desc, cardinality(caps) desc limit 1;
    if v_role is null or not (select caps @> array['members', 'configure'] from pm_roles where id = v_role) then
      insert into pm_roles (project_id, key, name, caps, sort) values (o.id, 'admin', 'Project Administrator', pmx_all_caps(), 1)
      on conflict (project_id, key) do update set caps = pmx_all_caps() returning id into v_role;
    end if;
    insert into pm_members (project_id, user_id, role_id, added_by) values (o.id, auth.uid(), v_role, auth.uid());
    perform pmx_log(o.id, null, 'project', 'Created the project', jsonb_build_object('template', p ->> 'template_id'));
    select * into o from pm_projects where id = o.id;
  else
    select * into o from pm_projects where id = p_id for update;
    perform pmx_need(p_id, 'configure');
    if p ? 'version' and (p ->> 'version')::int <> o.version then
      raise exception 'Someone else changed this project''s settings while you had them open. Reload and try again.' using errcode = 'OS409';
    end if;
    if (p ? 'visibility' and p ->> 'visibility' <> o.visibility) or (p ? 'team_role_id' and pmx_uuid(p ->> 'team_role_id') is distinct from o.team_role_id) then
      perform pmx_need(p_id, 'members');
    end if;
  end if;

  v := o;
  if p_id is not null and p ? 'name' then v.name := trim(p ->> 'name'); end if;
  if p ? 'description' then v.description := coalesce(p ->> 'description', ''); end if;
  if p ? 'program_id' then v.program_id := pmx_uuid(p ->> 'program_id'); end if;
  if p ? 'lead_id' then v.lead_id := pmx_uuid(p ->> 'lead_id'); end if;
  if p ? 'division_id' then v.division_id := pmx_uuid(p ->> 'division_id'); end if;
  if p ? 'subsystem_id' then v.subsystem_id := pmx_uuid(p ->> 'subsystem_id'); end if;
  if p ? 'vehicle' then v.vehicle := coalesce(p ->> 'vehicle', ''); end if;
  if p ? 'visibility' then v.visibility := p ->> 'visibility'; end if;
  if p ? 'team_role_id' then v.team_role_id := pmx_uuid(p ->> 'team_role_id'); end if;
  if p ? 'settings' then v.settings := o.settings || pmx_check_settings(p -> 'settings'); end if;
  if p ? 'participants' then
    v.participants := coalesce((select jsonb_agg(jsonb_build_object('division_id', pmx_uuid(x ->> 'division_id'), 'subsystem_id', pmx_uuid(x ->> 'subsystem_id')))
      from jsonb_array_elements(p -> 'participants') x where coalesce(x ->> 'division_id', '') <> ''), '[]');
  end if;
  if p ? 'archived' then v.archived_at := case when pmx_bool(p, 'archived', false) then coalesce(o.archived_at, now()) end; end if;

  if v.lead_id is not null and not is_member(v.lead_id) then raise exception 'The project manager has to be someone on the team.'; end if;
  if v.subsystem_id is not null then
    select * into v_sub from org_subsystems where id = v.subsystem_id;
    if v_sub.id is null then raise exception 'That subsystem doesn''t exist.'; end if;
    v.division_id := v_sub.division_id;
  end if;
  if v.team_role_id is not null then
    if not exists (select 1 from pm_roles where id = v.team_role_id and project_id = o.id) then raise exception 'That role isn''t one of this project''s roles.'; end if;
    -- the whole team can't be handed more than the person setting it has
    if v.team_role_id is distinct from o.team_role_id and p_id is not null
       and not (select r.caps <@ pmx_caps_for(o.id, auth.uid()) from pm_roles r where r.id = v.team_role_id) then
      raise exception 'You can''t give the whole team a role that can do more than yours.' using errcode = '42501';
    end if;
  end if;
  update pm_projects set name = v.name, description = v.description, program_id = v.program_id, lead_id = v.lead_id, division_id = v.division_id,
    subsystem_id = v.subsystem_id, participants = v.participants, vehicle = v.vehicle, visibility = v.visibility, team_role_id = v.team_role_id,
    settings = v.settings, archived_at = v.archived_at, version = o.version + 1, updated_at = now()
  where id = o.id returning * into v;
  if p_id is not null then perform pmx_log(o.id, null, 'project', 'Changed the project''s settings', '{}'); end if;
  return to_jsonb(v);
end;
$$;

/** p: { key, name, caps, sort }. Nobody can make a role that can do more than they can. */
create or replace function public.pm_save_role(p_project uuid, p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_caps text[] := array(select x from unnest(pmx_texts(p -> 'caps')) x where x = any(pmx_all_caps()));
  v_mine text[];
  o      pm_roles;
  v      pm_roles;
begin
  perform pmx_need(p_project, 'members');
  v_mine := pmx_caps_for(p_project, auth.uid());
  if not ('view' = any(v_caps)) then v_caps := v_caps || 'view'::text; end if;
  if not (v_caps <@ v_mine) then raise exception 'You can''t give a role something your own role can''t do.' using errcode = '42501'; end if;
  if trim(coalesce(p ->> 'name', '')) = '' then raise exception 'Give the role a name.'; end if;
  if p_id is null then
    insert into pm_roles (project_id, key, name, caps, sort)
    values (p_project, coalesce(nullif(p ->> 'key', ''), 'r' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)), trim(p ->> 'name'), v_caps, coalesce((p ->> 'sort')::int, 100))
    returning * into v;
  else
    select * into o from pm_roles where id = p_id and project_id = p_project for update;
    if o.id is null then raise exception 'That role doesn''t exist.'; end if;
    if not (o.caps <@ v_mine) then raise exception 'You can''t change a role that can do more than yours.' using errcode = '42501'; end if;
    update pm_roles set name = trim(p ->> 'name'), caps = v_caps, sort = coalesce((p ->> 'sort')::int, sort) where id = p_id returning * into v;
    if not exists (select 1 from pm_members m join pm_roles r on r.id = m.role_id where m.project_id = p_project and r.caps @> array['members']) then
      raise exception 'Someone in the project has to be able to manage members. Keep "Members and roles" on a role somebody has.';
    end if;
  end if;
  perform pmx_log(p_project, null, 'config', 'Saved the role "' || v.name || '"', jsonb_build_object('caps', v.caps));
  return to_jsonb(v);
end;
$$;

create or replace function public.pm_delete_role(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare o pm_roles;
begin
  select * into o from pm_roles where id = p_id;
  if o.id is null then return; end if;
  perform pmx_need(o.project_id, 'members');
  if not (o.caps <@ pmx_caps_for(o.project_id, auth.uid())) then raise exception 'You can''t delete a role that can do more than yours.' using errcode = '42501'; end if;
  if exists (select 1 from pm_members where role_id = p_id) then raise exception 'People still have the role "%". Give them another role first.', o.name; end if;
  update pm_transitions set role_ids = array_remove(role_ids, p_id) where project_id = o.project_id and p_id = any(role_ids);
  delete from pm_roles where id = p_id;
  perform pmx_log(o.project_id, null, 'config', 'Deleted the role "' || o.name || '"', '{}');
end;
$$;

/** Add someone to the project, change their role, or (p_role null) take them out. */
create or replace function public.pm_set_member(p_project uuid, p_user uuid, p_role uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_mine text[];
  v_old  pm_roles;
  v_new  pm_roles;
  v_name text := (select coalesce(nullif(full_name, ''), email) from profiles where id = p_user);
begin
  perform pmx_need(p_project, 'members');
  v_mine := pmx_caps_for(p_project, auth.uid());
  select r.* into v_old from pm_members m join pm_roles r on r.id = m.role_id where m.project_id = p_project and m.user_id = p_user;
  if v_old.id is not null and not (v_old.caps <@ v_mine) then
    raise exception 'You can''t change someone whose role can do more than yours.' using errcode = '42501';
  end if;
  if p_role is null then
    delete from pm_members where project_id = p_project and user_id = p_user;
  else
    select * into v_new from pm_roles where id = p_role and project_id = p_project;
    if v_new.id is null then raise exception 'That role isn''t one of this project''s roles.'; end if;
    if not (v_new.caps <@ v_mine) then raise exception 'You can''t give someone a role that can do more than yours.' using errcode = '42501'; end if;
    if v_name is null or not is_member(p_user) then raise exception 'Only people on the team can be added to a project.'; end if;
    if not (pmx_has(p_user, 'projects.view') or pmx_has(p_user, 'projects.create') or pmx_has(p_user, 'projects.manage')) then
      raise exception '%''s one.solar role can''t open Projects yet. An Admin has to give it "See projects" first.', v_name;
    end if;
    insert into pm_members (project_id, user_id, role_id, added_by) values (p_project, p_user, p_role, auth.uid())
    on conflict (project_id, user_id) do update set role_id = excluded.role_id;
  end if;
  if not exists (select 1 from pm_members m join pm_roles r on r.id = m.role_id where m.project_id = p_project and r.caps @> array['members']) then
    raise exception 'Someone in the project has to be able to manage members.';
  end if;
  perform pmx_log(p_project, null, 'members', case when p_role is null then 'Removed ' || coalesce(v_name, 'someone') || ' from the project'
    else coalesce(v_name, 'Someone') || ' is now ' || v_new.name end, jsonb_build_object('user', p_user, 'role', p_role));
end;
$$;

-- ---- work-item types -------------------------------------------------------------------------------
/**
 * p: { name, icon, color, description, level, parent_type_ids, workflow_id, is_milestone, defaults, sort, archived,
 *      mapping: { "<old status id>": "<new status id>" }, dry_run }
 * Moving a type that has items to another workflow needs a new status for every status those items are in.
 */
create or replace function public.pm_save_type(p_project uuid, p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  o        pm_types;
  v        pm_types;
  v_wf     uuid := pmx_uuid(p ->> 'workflow_id');
  v_impact jsonb := '[]';
  r        record;
  v_to     uuid;
begin
  perform pmx_need(p_project, 'configure');
  if p_id is not null then
    select * into o from pm_types where id = p_id and project_id = p_project for update;
    if o.id is null then raise exception 'That work-item type doesn''t exist.'; end if;
  end if;
  v_wf := coalesce(v_wf, o.workflow_id, (select id from pm_workflows where project_id = p_project and archived_at is null order by created_at limit 1));
  if not exists (select 1 from pm_workflows where id = v_wf and project_id = p_project and archived_at is null) then
    raise exception 'Pick one of this project''s workflows.';
  end if;
  if p_id is not null and v_wf <> o.workflow_id then
    for r in select s.id, s.name, count(*) as n from pm_items i join pm_statuses s on s.id = i.status_id where i.type_id = p_id group by s.id, s.name loop
      v_to := pmx_uuid(p -> 'mapping' ->> r.id::text);
      if v_to is not null and not exists (select 1 from pm_statuses where id = v_to and workflow_id = v_wf) then v_to := null; end if;
      v_impact := v_impact || jsonb_build_object('id', r.id, 'name', r.name, 'items', r.n, 'to', v_to);
    end loop;
  end if;
  if pmx_bool(p, 'dry_run', false) then return jsonb_build_object('dry_run', true, 'statuses', v_impact); end if;
  if exists (select 1 from jsonb_array_elements(v_impact) x where x ->> 'to' is null) then
    raise exception 'Items of this type are in statuses the new workflow doesn''t have. Say which status each one becomes.'
      using errcode = 'OS428', detail = v_impact::text;
  end if;
  if trim(coalesce(p ->> 'name', o.name, '')) = '' then raise exception 'Give the type a name.'; end if;
  if p_id is null then
    insert into pm_types (project_id, name, icon, color, description, level, parent_type_ids, workflow_id, is_milestone, defaults, sort)
    values (p_project, trim(p ->> 'name'), coalesce(p ->> 'icon', ''), coalesce(nullif(p ->> 'color', ''), 'blue'), coalesce(p ->> 'description', ''),
      coalesce((p ->> 'level')::int, 1), '{}', v_wf, pmx_bool(p, 'is_milestone', false), coalesce(nullif(p -> 'defaults', 'null'), '{}'),
      coalesce((p ->> 'sort')::int, (select coalesce(max(sort), 0) + 10 from pm_types where project_id = p_project)))
    returning * into v;
  else
    update pm_types set name = coalesce(nullif(trim(p ->> 'name'), ''), name), icon = coalesce(p ->> 'icon', icon), color = coalesce(nullif(p ->> 'color', ''), color),
      description = coalesce(p ->> 'description', description), level = coalesce((p ->> 'level')::int, level), workflow_id = v_wf,
      is_milestone = pmx_bool(p, 'is_milestone', is_milestone), defaults = coalesce(nullif(p -> 'defaults', 'null'), defaults), sort = coalesce((p ->> 'sort')::int, sort),
      archived_at = case when p ? 'archived' then case when pmx_bool(p, 'archived', false) then coalesce(archived_at, now()) end else archived_at end
    where id = p_id returning * into v;
    if v_wf <> o.workflow_id then
      insert into pm_events (project_id, item_id, actor_id, actor_name, kind, summary, data)
      select p_project, i.id, auth.uid(), coalesce(my_display_name(), ''), 'status', 'Status changed because ' || v.name || ' items moved to another workflow',
             jsonb_build_object('from', i.status_id, 'to', rm ->> 'to', 'how', 'workflow')
      from pm_items i join jsonb_array_elements(v_impact) rm on (rm ->> 'id')::uuid = i.status_id where i.type_id = p_id;
      update pm_items i set status_id = s.id, category = s.category, version = i.version + 1, updated_at = now()
      from jsonb_array_elements(v_impact) rm join pm_statuses s on s.id = (rm ->> 'to')::uuid
      where i.type_id = p_id and i.status_id = (rm ->> 'id')::uuid;
      update pm_approvals set status = 'cancelled', note = 'The workflow changed.', decided_at = now()
      where status = 'pending' and item_id in (select id from pm_items where type_id = p_id);
    end if;
  end if;
  if p ? 'parent_type_ids' then
    update pm_types set parent_type_ids = array(select x from unnest(pmx_uuids(p -> 'parent_type_ids')) x
      where exists (select 1 from pm_types t where t.id = x and t.project_id = p_project))
    where id = v.id returning * into v;
  end if;
  perform pmx_log(p_project, null, 'config', 'Saved the work-item type "' || v.name || '"', '{}');
  return to_jsonb(v);
end;
$$;

-- ---- workflows -----------------------------------------------------------------------------------
/** The actions a transition or a rule may run, checked before they're saved. */
create or replace function public.pmx_check_actions(p_project uuid, p_actions jsonb)
returns void language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a jsonb; t text;
begin
  if p_actions is null or jsonb_typeof(p_actions) <> 'array' then raise exception 'Actions must be a list.'; end if;
  if jsonb_array_length(p_actions) > 10 then raise exception 'A rule can have up to 10 actions.'; end if;
  for a in select * from jsonb_array_elements(p_actions) loop
    t := a ->> 'type';
    if t = 'set_status' then
      if not exists (select 1 from pm_statuses where id = pmx_uuid(a ->> 'status') and project_id = p_project) then raise exception 'An action sets a status this project doesn''t have.'; end if;
    elsif t in ('assign', 'add_watcher', 'notify') then
      if coalesce(a ->> case t when 'notify' then 'to' else 'user' end, '') not in ('owner', 'reporter', 'lead', 'none', 'watchers', 'actor')
         and not is_member(pmx_uuid(a ->> case t when 'notify' then 'to' else 'user' end)) then
        raise exception 'An action names someone who isn''t on the team.';
      end if;
      if t = 'notify' and trim(coalesce(a ->> 'message', '')) = '' then raise exception 'A "notify" action needs a message.'; end if;
    elsif t = 'set_field' then
      if coalesce(a ->> 'field', '') not in ('priority', 'due_date', 'start_date', 'blocked', 'blocked_reason', 'progress', 'estimate_hours')
         and not exists (select 1 from pm_fields f where f.project_id = p_project and 'cf.' || f.key = a ->> 'field' and f.type <> 'formula') then
        raise exception 'An action sets a field ("%") that can''t be set by a rule.', left(coalesce(a ->> 'field', ''), 40);
      end if;
    elsif t = 'comment' then
      if trim(coalesce(a ->> 'text', '')) = '' then raise exception 'A "comment" action needs some text.'; end if;
    elsif t = 'create_item' then
      if trim(coalesce(a ->> 'title', '')) = '' then raise exception 'A "create an item" action needs a title.'; end if;
      if not exists (select 1 from pm_types where id = pmx_uuid(a ->> 'type_id') and project_id = p_project and archived_at is null) then
        raise exception 'A "create an item" action needs one of this project''s work-item types.';
      end if;
    elsif t = 'add_label' then
      if trim(coalesce(a ->> 'label', '')) = '' or length(a ->> 'label') > 40 then raise exception 'A "label" action needs a label (up to 40 characters).'; end if;
    else
      raise exception 'Unknown action "%".', left(coalesce(t, ''), 30);
    end if;
  end loop;
end;
$$;

/**
 * Save a whole workflow at once (a new version).
 * p: { name, description, version, statuses: [{ id, name, category, color, sort, x, y }],
 *      transitions: [{ id, name, from_status, to_status, description, role_ids, require_fields, require_comment,
 *                      require_approval, no_self_approval, conditions, actions, sort }],
 *      mapping: { "<removed status id>": "<status id that replaces it>" }, note, dry_run }
 * A status that items are in can only be removed with a replacement, so nothing is ever left without a status.
 * dry_run changes nothing and returns what would happen.
 */
create or replace function public.pm_save_workflow(p_project uuid, p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  w         pm_workflows;
  v_ids     uuid[];
  v_removed jsonb := '[]';
  v_recat   int := 0;
  v_to      uuid;
  r         record;
  s         jsonb;
  t         jsonb;
  v_warn    text[] := '{}';
  v_dry     boolean := pmx_bool(p, 'dry_run', false);
begin
  perform pmx_need(p_project, 'workflows');
  if jsonb_typeof(p -> 'statuses') <> 'array' or jsonb_array_length(p -> 'statuses') = 0 then raise exception 'A workflow needs at least one status.'; end if;
  if jsonb_array_length(p -> 'statuses') > 40 then raise exception 'A workflow can have up to 40 statuses.'; end if;
  if jsonb_array_length(coalesce(p -> 'transitions', '[]')) > 300 then raise exception 'A workflow can have up to 300 transitions.'; end if;
  if p_id is not null then
    select * into w from pm_workflows where id = p_id and project_id = p_project for update;
    if w.id is null then raise exception 'That workflow doesn''t exist.'; end if;
    if p ? 'version' and (p ->> 'version')::int <> w.version then
      raise exception 'Someone else saved this workflow while you were editing it (it''s now version %). Reload to see their changes.', w.version using errcode = 'OS409';
    end if;
  end if;
  if trim(coalesce(p ->> 'name', w.name, '')) = '' then raise exception 'Give the workflow a name.'; end if;

  select array_agg(pmx_uuid(x ->> 'id')) into v_ids from jsonb_array_elements(p -> 'statuses') x;
  if array_position(v_ids, null) is not null or (select count(distinct x) from unnest(v_ids) x) <> cardinality(v_ids) then
    raise exception 'Every status needs its own id.';
  end if;
  if exists (select 1 from pm_statuses where id = any(v_ids) and workflow_id is distinct from p_id) then raise exception 'A status belongs to another workflow.'; end if;
  for s in select * from jsonb_array_elements(p -> 'statuses') loop
    if trim(coalesce(s ->> 'name', '')) = '' or coalesce(s ->> 'category', '') not in ('todo', 'doing', 'done') then
      raise exception 'Every status needs a name and a category (To do, In progress or Done).';
    end if;
  end loop;
  if (select count(distinct lower(trim(x ->> 'name'))) from jsonb_array_elements(p -> 'statuses') x) <> cardinality(v_ids) then
    raise exception 'Two statuses have the same name.';
  end if;
  if not exists (select 1 from jsonb_array_elements(p -> 'statuses') x where x ->> 'category' = 'done') then v_warn := v_warn || 'No status is in the Done category, so nothing here ever counts as finished.'; end if;

  for t in select * from jsonb_array_elements(coalesce(p -> 'transitions', '[]')) loop
    if trim(coalesce(t ->> 'name', '')) = '' then raise exception 'Every transition needs a name.'; end if;
    if pmx_uuid(t ->> 'to_status') is null or not (pmx_uuid(t ->> 'to_status') = any(v_ids))
       or (pmx_uuid(t ->> 'from_status') is not null and not (pmx_uuid(t ->> 'from_status') = any(v_ids))) then
      raise exception 'The transition "%" goes to or from a status that isn''t in this workflow.', t ->> 'name';
    end if;
    if exists (select 1 from unnest(pmx_uuids(t -> 'role_ids')) x where not exists (select 1 from pm_roles pr where pr.id = x and pr.project_id = p_project)) then
      raise exception 'The transition "%" is limited to a role this project doesn''t have.', t ->> 'name';
    end if;
    if exists (select 1 from unnest(pmx_texts(t -> 'require_fields')) x
               where x not in ('owner', 'description', 'due_date', 'start_date', 'estimate_hours', 'division', 'subsystem', 'parent', 'sprint', 'acceptance', 'labels', 'vehicle')
                 and not exists (select 1 from pm_fields f where f.project_id = p_project and 'cf.' || f.key = x)) then
      raise exception 'The transition "%" requires a field this project doesn''t have.', t ->> 'name';
    end if;
    perform pmx_where(nullif(t -> 'conditions', 'null'));
    perform pmx_check_actions(p_project, coalesce(nullif(t -> 'actions', 'null'), '[]'));
  end loop;
  -- statuses nothing leads to (other than the first, where new items start)
  select v_warn || coalesce(array_agg('Nothing moves an item into "' || (x.v ->> 'name') || '".'), '{}') into v_warn
  from (select v, row_number() over (order by coalesce((v ->> 'sort')::int, 100), v ->> 'name') as n from jsonb_array_elements(p -> 'statuses') v) x
  where x.n > 1 and not exists (select 1 from jsonb_array_elements(coalesce(p -> 'transitions', '[]')) t2 where t2 ->> 'to_status' = x.v ->> 'id');

  -- statuses being removed, and what happens to the items in them
  if p_id is not null then
    for r in select st.id, st.name, (select count(*) from pm_items i where i.status_id = st.id) as n
             from pm_statuses st where st.workflow_id = p_id and not (st.id = any(v_ids)) loop
      v_to := pmx_uuid(p -> 'mapping' ->> r.id::text);
      if v_to is not null and not (v_to = any(v_ids)) then v_to := null; end if;
      v_removed := v_removed || jsonb_build_object('id', r.id, 'name', r.name, 'items', r.n, 'to', v_to);
    end loop;
    select count(*) into v_recat from pm_items i join jsonb_array_elements(p -> 'statuses') x on (x ->> 'id')::uuid = i.status_id where i.category <> x ->> 'category';
  end if;
  if v_dry then
    return jsonb_build_object('dry_run', true, 'removed', v_removed, 'recategorized', v_recat, 'warnings', to_jsonb(v_warn),
      'items', case when p_id is null then 0 else (select count(*) from pm_items i join pm_statuses st on st.id = i.status_id where st.workflow_id = p_id) end);
  end if;
  if exists (select 1 from jsonb_array_elements(v_removed) x where (x ->> 'items')::int > 0 and x ->> 'to' is null) then
    raise exception 'Items are still in a status you removed. Say which status they move to.' using errcode = 'OS428', detail = v_removed::text;
  end if;

  if p_id is null then
    insert into pm_workflows (project_id, name, description) values (p_project, trim(p ->> 'name'), coalesce(p ->> 'description', '')) returning * into w;
  else
    update pm_workflows set name = coalesce(nullif(trim(p ->> 'name'), ''), name), description = coalesce(p ->> 'description', description),
      version = version + 1, updated_at = now(),
      archived_at = case when p ? 'archived' then case when pmx_bool(p, 'archived', false) then coalesce(archived_at, now()) end else archived_at end
    where id = p_id returning * into w;
    if w.archived_at is not null and exists (select 1 from pm_types where workflow_id = w.id and archived_at is null) then
      raise exception 'Work-item types still use this workflow. Give them another one first.';
    end if;
  end if;
  insert into pm_statuses (id, workflow_id, project_id, name, category, color, sort, x, y)
  select (x ->> 'id')::uuid, w.id, p_project, trim(x ->> 'name'), x ->> 'category', coalesce(nullif(x ->> 'color', ''), 'gray'),
         coalesce((x ->> 'sort')::int, 100), coalesce((x ->> 'x')::numeric::int, 0), coalesce((x ->> 'y')::numeric::int, 0)
  from jsonb_array_elements(p -> 'statuses') x
  on conflict (id) do update set name = excluded.name, category = excluded.category, color = excluded.color, sort = excluded.sort, x = excluded.x, y = excluded.y;

  -- move items out of removed statuses (each move is in the item's history), then remove them
  insert into pm_events (project_id, item_id, actor_id, actor_name, kind, summary, data)
  select p_project, i.id, auth.uid(), coalesce(my_display_name(), ''), 'status',
         'Moved from "' || (rm ->> 'name') || '" to "' || st.name || '" because the workflow changed',
         jsonb_build_object('from', i.status_id, 'to', st.id, 'from_name', rm ->> 'name', 'to_name', st.name, 'how', 'workflow')
  from pm_items i join jsonb_array_elements(v_removed) rm on (rm ->> 'id')::uuid = i.status_id join pm_statuses st on st.id = (rm ->> 'to')::uuid;
  update pm_items i set status_id = st.id, category = st.category, version = i.version + 1, updated_at = now()
  from jsonb_array_elements(v_removed) rm join pm_statuses st on st.id = (rm ->> 'to')::uuid
  where i.status_id = (rm ->> 'id')::uuid;
  delete from pm_statuses where workflow_id = w.id and not (id = any(v_ids));
  update pm_items i set category = st.category,
    completed_at = case when st.category = 'done' then coalesce(i.completed_at, now()) else null end
  from pm_statuses st where st.id = i.status_id and st.workflow_id = w.id and i.category <> st.category;

  delete from pm_transitions tr where tr.workflow_id = w.id
    and tr.id not in (select pmx_uuid(x ->> 'id') from jsonb_array_elements(coalesce(p -> 'transitions', '[]')) x where x ->> 'id' is not null);
  insert into pm_transitions (id, workflow_id, project_id, name, from_status, to_status, description, role_ids, require_fields, require_comment,
                              require_approval, no_self_approval, conditions, actions, sort)
  select coalesce(pmx_uuid(x ->> 'id'), gen_random_uuid()), w.id, p_project, trim(x ->> 'name'), pmx_uuid(x ->> 'from_status'), pmx_uuid(x ->> 'to_status'),
         coalesce(x ->> 'description', ''), pmx_uuids(x -> 'role_ids'), pmx_texts(x -> 'require_fields'), pmx_bool(x, 'require_comment', false),
         pmx_bool(x, 'require_approval', false), pmx_bool(x, 'no_self_approval', false), nullif(x -> 'conditions', 'null'),
         coalesce(nullif(x -> 'actions', 'null'), '[]'), coalesce((x ->> 'sort')::int, n::int * 10)
  from jsonb_array_elements(coalesce(p -> 'transitions', '[]')) with ordinality q(x, n)
  on conflict (id) do update set name = excluded.name, from_status = excluded.from_status, to_status = excluded.to_status, description = excluded.description,
    role_ids = excluded.role_ids, require_fields = excluded.require_fields, require_comment = excluded.require_comment,
    require_approval = excluded.require_approval, no_self_approval = excluded.no_self_approval, conditions = excluded.conditions,
    actions = excluded.actions, sort = excluded.sort
  where pm_transitions.workflow_id = excluded.workflow_id;
  if (select count(*) from pm_transitions where workflow_id = w.id) <> jsonb_array_length(coalesce(p -> 'transitions', '[]')) then
    raise exception 'A transition belongs to another workflow.';
  end if;
  -- an approval that was waiting on a move that no longer applies is cancelled, and says why
  update pm_approvals a set status = 'cancelled', note = 'The workflow changed.', decided_at = now()
  where a.status = 'pending' and a.project_id = p_project
    and exists (select 1 from pm_items i join pm_transitions tr on tr.id = a.transition_id where i.id = a.item_id and tr.from_status is not null and tr.from_status <> i.status_id);

  insert into pm_workflow_versions (workflow_id, project_id, version, snapshot, note, created_by)
  values (w.id, p_project, w.version, pmx_workflow_json(w.id), left(coalesce(p ->> 'note', ''), 300), auth.uid());
  perform pmx_log(p_project, null, 'config', 'Saved the workflow "' || w.name || '" (version ' || w.version || ')',
    jsonb_build_object('workflow', w.id, 'version', w.version, 'removed', v_removed));
  return jsonb_build_object('id', w.id, 'version', w.version, 'removed', v_removed, 'warnings', to_jsonb(v_warn));
end;
$$;

-- ---- custom fields and form layouts ---------------------------------------------------------------
/** p: { key, name, type, description, options, default_value, validation, formula, type_ids, sort, archived } */
create or replace function public.pm_save_field(p_project uuid, p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  o       pm_fields;
  v       pm_fields;
  v_type  text;
  v_opts  jsonb;
  v_val   jsonb := coalesce(nullif(p -> 'validation', 'null'), '{}');
begin
  perform pmx_need(p_project, 'configure');
  if p_id is not null then
    select * into o from pm_fields where id = p_id and project_id = p_project for update;
    if o.id is null then raise exception 'That field doesn''t exist.'; end if;
    if p ? 'type' and p ->> 'type' <> o.type then raise exception 'A field''s kind can''t change once it exists (its values wouldn''t fit). Make a new field instead.'; end if;
  end if;
  v_type := coalesce(o.type, p ->> 'type');
  if trim(coalesce(p ->> 'name', o.name, '')) = '' then raise exception 'Give the field a name.'; end if;
  v_opts := case when p ? 'options' then to_jsonb(pmx_texts(p -> 'options')) else coalesce(o.options, '[]') end;
  if v_type in ('select', 'multiselect') then
    if jsonb_array_length(v_opts) = 0 then raise exception 'A dropdown needs at least one choice.'; end if;
    if jsonb_array_length(v_opts) > 200 or exists (select 1 from jsonb_array_elements_text(v_opts) x where length(x) > 100) then
      raise exception 'A dropdown can have up to 200 choices of up to 100 characters.';
    end if;
    if (select count(distinct lower(x)) from jsonb_array_elements_text(v_opts) x) <> jsonb_array_length(v_opts) then raise exception 'Two choices are the same.'; end if;
  end if;
  if jsonb_typeof(v_val) <> 'object' or octet_length(v_val::text) > 600 then raise exception 'Those validation rules aren''t valid.'; end if;
  if v_val ? 'pattern' then
    begin perform 'x' ~ (v_val ->> 'pattern'); exception when others then raise exception 'The pattern isn''t a valid regular expression.'; end;
  end if;
  if v_type = 'formula' then
    -- A small arithmetic language worked out in the page (docs/projects.md): only these characters ever get in.
    if coalesce(p ->> 'formula', o.formula, '') !~ '^[A-Za-z0-9_ .,+*/()<>=!?:''"%-]+$' then
      raise exception 'A formula can only use numbers, field names, + - * / ( ) and the listed functions.';
    end if;
  end if;
  if p_id is null then
    if coalesce(p ->> 'key', '') !~ '^[a-z][a-z0-9_]{0,39}$' then raise exception 'The field key is lowercase letters, numbers and _ (e.g. test_date).'; end if;
    if exists (select 1 from pm_fields where project_id = p_project and key = p ->> 'key') then
      raise exception 'This project already has a field with the key "%".', p ->> 'key' using errcode = 'OS412';
    end if;
    insert into pm_fields (project_id, key, name, type, description, options, default_value, validation, formula, type_ids, sort)
    values (p_project, p ->> 'key', trim(p ->> 'name'), v_type, coalesce(p ->> 'description', ''), v_opts, nullif(p -> 'default_value', 'null'), v_val,
      coalesce(p ->> 'formula', ''), '{}', coalesce((p ->> 'sort')::int, (select coalesce(max(sort), 0) + 10 from pm_fields where project_id = p_project)))
    returning * into v;
  else
    update pm_fields set name = coalesce(nullif(trim(p ->> 'name'), ''), name), description = coalesce(p ->> 'description', description), options = v_opts,
      default_value = case when p ? 'default_value' then nullif(p -> 'default_value', 'null') else default_value end,
      validation = case when p ? 'validation' then v_val else validation end, formula = coalesce(p ->> 'formula', formula),
      sort = coalesce((p ->> 'sort')::int, sort),
      archived_at = case when p ? 'archived' then case when pmx_bool(p, 'archived', false) then coalesce(archived_at, now()) end else archived_at end
    where id = p_id returning * into v;
  end if;
  if p ? 'type_ids' then
    update pm_fields set type_ids = array(select x from unnest(pmx_uuids(p -> 'type_ids')) x where exists (select 1 from pm_types t where t.id = x and t.project_id = p_project))
    where id = v.id returning * into v;
  end if;
  if v.default_value is not null and v.type <> 'formula' then
    perform pmx_clean_custom(p_project, null, jsonb_build_object(v.key, v.default_value), '{}');
  end if;
  perform pmx_log(p_project, null, 'config', 'Saved the field "' || v.name || '"', '{}');
  return to_jsonb(v);
end;
$$;

/**
 * p: { type_id, kind: create | view | edit | transition, transition_id, sections: [{ title, fields: [{ key, required }] }] }
 * No sections: back to the standard form.
 */
create or replace function public.pm_save_layout(p_project uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_type uuid := pmx_uuid(p ->> 'type_id');
  v_tr   uuid := pmx_uuid(p ->> 'transition_id');
  v_kind text := p ->> 'kind';
  v_sec  jsonb := coalesce(nullif(p -> 'sections', 'null'), '[]');
  s      jsonb;
  f      jsonb;
  v      pm_layouts;
begin
  perform pmx_need(p_project, 'configure');
  if v_kind not in ('create', 'view', 'edit', 'transition') then raise exception 'Unknown kind of form.'; end if;
  if v_type is not null and not exists (select 1 from pm_types where id = v_type and project_id = p_project) then raise exception 'That work-item type isn''t in this project.'; end if;
  if (v_kind = 'transition') <> (v_tr is not null) then raise exception 'A transition form belongs to one transition.'; end if;
  if v_tr is not null and not exists (select 1 from pm_transitions where id = v_tr and project_id = p_project) then raise exception 'That transition isn''t in this project.'; end if;
  if jsonb_typeof(v_sec) <> 'array' or jsonb_array_length(v_sec) > 20 then raise exception 'A form can have up to 20 sections.'; end if;
  for s in select * from jsonb_array_elements(v_sec) loop
    if jsonb_typeof(s -> 'fields') <> 'array' or length(coalesce(s ->> 'title', '')) > 80 then raise exception 'A section needs a title (up to 80 characters) and a list of fields.'; end if;
    for f in select * from jsonb_array_elements(s -> 'fields') loop
      if coalesce(f ->> 'key', '') not in ('description', 'priority', 'owner', 'collaborators', 'division', 'subsystem', 'vehicle', 'start_date', 'due_date',
                                           'estimate_hours', 'progress', 'parent', 'sprint', 'labels', 'acceptance', 'blocked')
         and not exists (select 1 from pm_fields x where x.project_id = p_project and 'cf.' || x.key = f ->> 'key') then
        raise exception 'The form has a field this project doesn''t have ("%").', left(coalesce(f ->> 'key', ''), 50);
      end if;
    end loop;
  end loop;
  delete from pm_layouts where project_id = p_project and type_id is not distinct from v_type and kind = v_kind and transition_id is not distinct from v_tr;
  if jsonb_array_length(v_sec) > 0 then
    insert into pm_layouts (project_id, type_id, kind, transition_id, sections, updated_by) values (p_project, v_type, v_kind, v_tr, v_sec, auth.uid()) returning * into v;
  end if;
  perform pmx_log(p_project, null, 'config', 'Saved a form layout', jsonb_build_object('kind', v_kind, 'type', v_type));
  return to_jsonb(v);
end;
$$;

/**
 * Custom field values, checked against the project's fields: p_new is merged over p_old; a blank value clears
 * the field. Values are stored in one shape per kind (numbers as numbers, lists as lists), so filters and reports
 * can rely on them. p_type null skips the "is this field on this type" check (used for defaults).
 */
create or replace function public.pmx_clean_custom(p_project uuid, p_type uuid, p_new jsonb, p_old jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_out jsonb := coalesce(p_old, '{}');
  k     text;
  v     jsonb;
  f     pm_fields;
  s     text;
  n     numeric;
  arr   text[];
begin
  if p_new is null or jsonb_typeof(p_new) <> 'object' then return v_out; end if;
  for k, v in select * from jsonb_each(p_new) loop
    select * into f from pm_fields where project_id = p_project and key = k and archived_at is null;
    if f.id is null then raise exception 'This project has no field "%".', left(k, 40); end if;
    if f.type = 'formula' then continue; end if;
    if p_type is not null and cardinality(f.type_ids) > 0 and not (p_type = any(f.type_ids)) then
      raise exception 'The field "%" isn''t used on this kind of item.', f.name;
    end if;
    s := case when jsonb_typeof(v) in ('string', 'number', 'boolean') then trim(v #>> '{}') else null end;
    if v is null or jsonb_typeof(v) = 'null' or s = '' or v = '[]'::jsonb then
      v_out := v_out - k;
      continue;
    end if;
    if f.type in ('text', 'longtext', 'richtext') then
      if s is null then raise exception '"%" has to be text.', f.name; end if;
      if length(s) > coalesce(pmx_num(f.validation ->> 'maxlen'), case when f.type = 'text' then 500 else 20000 end) then raise exception '"%" is too long.', f.name; end if;
      if f.validation ? 'pattern' and s !~ (f.validation ->> 'pattern') then raise exception '"%" doesn''t look right%.', f.name, coalesce(' (' || nullif(f.validation ->> 'hint', '') || ')', ''); end if;
      v_out := v_out || jsonb_build_object(k, s);
    elsif f.type in ('integer', 'decimal', 'currency', 'duration') then
      n := pmx_num(s);
      if n is null then raise exception '"%" has to be a number.', f.name; end if;
      if f.type = 'integer' and n <> trunc(n) then raise exception '"%" has to be a whole number.', f.name; end if;
      if f.type in ('duration', 'currency') and n < 0 and not f.validation ? 'min' then raise exception '"%" can''t be negative.', f.name; end if;
      if n < pmx_num(f.validation ->> 'min') then raise exception '"%" can''t be less than %.', f.name, f.validation ->> 'min'; end if;
      if n > pmx_num(f.validation ->> 'max') then raise exception '"%" can''t be more than %.', f.name, f.validation ->> 'max'; end if;
      v_out := v_out || jsonb_build_object(k, n);
    elsif f.type = 'date' then
      begin v_out := v_out || jsonb_build_object(k, to_char(s::date, 'YYYY-MM-DD'));
      exception when others then raise exception '"%" has to be a date.', f.name; end;
    elsif f.type = 'datetime' then
      begin v_out := v_out || jsonb_build_object(k, to_char(s::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
      exception when others then raise exception '"%" has to be a date and time.', f.name; end;
    elsif f.type = 'checkbox' then
      if s not in ('true', 'false') then raise exception '"%" has to be yes or no.', f.name; end if;
      if s = 'true' then v_out := v_out || jsonb_build_object(k, true); else v_out := v_out - k; end if;
    elsif f.type = 'select' then
      if s is null or not f.options ? s then raise exception '"%" isn''t one of the choices for "%".', left(coalesce(s, ''), 60), f.name; end if;
      v_out := v_out || jsonb_build_object(k, s);
    elsif f.type = 'url' then
      if s is null or s !~* '^https?://[^\s<>"]+$' or length(s) > 2000 then raise exception '"%" has to be a web address starting with https://.', f.name; end if;
      v_out := v_out || jsonb_build_object(k, s);
    elsif f.type = 'user' then
      if s is null or not is_member(pmx_uuid(s)) then raise exception '"%" has to be someone on the team.', f.name; end if;
      v_out := v_out || jsonb_build_object(k, s);
    else -- multiselect, multiuser, tags: lists
      if jsonb_typeof(v) <> 'array' then v := jsonb_build_array(v); end if;
      arr := pmx_texts(v);
      if cardinality(arr) > 50 then raise exception '"%" has too many values.', f.name; end if;
      if f.type = 'multiselect' and exists (select 1 from unnest(arr) x where not f.options ? x) then
        raise exception '"%" has a value that isn''t one of its choices.', f.name;
      elsif f.type = 'multiuser' and exists (select 1 from unnest(arr) x where not is_member(pmx_uuid(x))) then
        raise exception '"%" has to be people on the team.', f.name;
      elsif f.type = 'tags' and exists (select 1 from unnest(arr) x where length(x) > 40) then
        raise exception 'Each tag in "%" can be up to 40 characters.', f.name;
      end if;
      if cardinality(arr) = 0 then v_out := v_out - k; else v_out := v_out || jsonb_build_object(k, to_jsonb(arr)); end if;
    end if;
  end loop;
  return v_out;
end;
$$;

/** The fields the applicable form marks as required (the type's own form, else the project's). */
create or replace function public.pmx_required(p_project uuid, p_type uuid, p_kind text, p_transition uuid)
returns text[] language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(array_agg(f ->> 'key'), '{}'::text[])
  from (select sections from pm_layouts
        where project_id = p_project and kind = p_kind and (type_id = p_type or type_id is null) and transition_id is not distinct from p_transition
        order by type_id nulls last limit 1) l,
       jsonb_array_elements(l.sections) s, jsonb_array_elements(s -> 'fields') f
  where f -> 'required' = 'true'::jsonb;
$$;

/** Which of these fields are empty on the item. */
create or replace function public.pmx_missing(p_item pm_items, p_keys text[])
returns text[] language sql stable set search_path = public, pg_temp
as $$
  select coalesce(array_agg(k order by o), '{}'::text[])
  from unnest(p_keys) with ordinality u(k, o),
       lateral (select case when k like 'cf.%' then p_item.custom -> substr(k, 4)
                            else to_jsonb(p_item) -> (case k when 'owner' then 'owner_id' when 'division' then 'division_id' when 'subsystem' then 'subsystem_id'
                                                               when 'parent' then 'parent_id' when 'sprint' then 'sprint_id' else k end) end as val) x
  where k not in ('collaborators', 'blocked', 'progress', 'priority')
    and (x.val is null or x.val in ('null'::jsonb, '""'::jsonb, '[]'::jsonb));
$$;

/** "owner, cf.test_date" → "Owner, Test date". */
create or replace function public.pmx_field_names(p_project uuid, p_keys text[])
returns text language sql stable security definer set search_path = public, pg_temp
as $$
  select string_agg(case when k like 'cf.%' then coalesce((select name from pm_fields where project_id = p_project and key = substr(k, 4)), k)
                         when k = 'comment' then 'a comment' else initcap(replace(replace(k, '_hours', ''), '_', ' ')) end, ', ' order by o)
  from unnest(p_keys) with ordinality u(k, o);
$$;

-- ---- templates -------------------------------------------------------------------------------------
/**
 * p: { name, description, config | from_project, include_items, archived, version }
 * The configuration is tried out on a scratch project first (and rolled back), so a broken one is never saved.
 */
create or replace function public.pm_save_template(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  o        pm_templates;
  v        pm_templates;
  v_config jsonb;
  v_tmp    uuid;
begin
  perform pmx_open();
  if not (has_permission('projects.create') or has_permission('projects.manage')) then
    raise exception 'Your role can''t save templates (it needs "Create projects").' using errcode = '42501';
  end if;
  if p_id is not null then
    select * into o from pm_templates where id = p_id for update;
    if o.id is null then raise exception 'That template doesn''t exist.'; end if;
    if o.created_by is distinct from auth.uid() and not has_permission('projects.manage') then
      raise exception 'Only the person who made this template, or someone who manages all projects, can change it.' using errcode = '42501';
    end if;
    if p ? 'version' and (p ->> 'version')::int <> o.version then
      raise exception 'Someone else changed this template. Reload and try again.' using errcode = 'OS409';
    end if;
  end if;
  if coalesce(p ->> 'from_project', '') <> '' then
    perform pmx_need(pmx_uuid(p ->> 'from_project'), 'configure');
    v_config := pmx_export(pmx_uuid(p ->> 'from_project'), pmx_bool(p, 'include_items', false));
  elsif jsonb_typeof(p -> 'config') = 'object' then
    v_config := p -> 'config';
  end if;
  if v_config is not null then
    begin
      insert into pm_projects (key, name) values ('ZZ' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)), 'Template check') returning id into v_tmp;
      perform pmx_apply_config(v_tmp, v_config, array['roles', 'workflows', 'types', 'fields', 'layouts', 'views', 'automations', 'settings', 'items'], false, current_date);
      if not exists (select 1 from pm_types where project_id = v_tmp) then raise exception 'That configuration has no work-item types.'; end if;
      raise exception 'ok' using errcode = 'PMOK1';
    exception when sqlstate 'PMOK1' then null;
    end;
  end if;
  if trim(coalesce(p ->> 'name', o.name, '')) = '' then raise exception 'Give the template a name.'; end if;
  if p_id is null then
    if v_config is null then raise exception 'A template needs a configuration.'; end if;
    insert into pm_templates (name, description, config, created_by) values (trim(p ->> 'name'), coalesce(p ->> 'description', ''), v_config, auth.uid()) returning * into v;
  else
    update pm_templates set name = coalesce(nullif(trim(p ->> 'name'), ''), name), description = coalesce(p ->> 'description', description),
      config = coalesce(v_config, config), version = version + 1, updated_at = now(),
      archived_at = case when p ? 'archived' then case when pmx_bool(p, 'archived', false) then coalesce(archived_at, now()) end else archived_at end
    where id = p_id returning * into v;
  end if;
  return to_jsonb(v) - 'config';
end;
$$;

/**
 * Bring a template's (or another project's, or a pasted) configuration into a project. p: { template_id |
 * from_project | config, parts: [...], dry_run, start_date }. Returns what changed (or would, with dry_run).
 */
create or replace function public.pm_apply_config(p_project uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_config jsonb;
  v_parts  text[] := pmx_texts(p -> 'parts');
  v_out    jsonb;
begin
  perform pmx_need(p_project, 'configure');
  if v_parts && array['workflows', 'types', 'layouts', 'items', 'views', 'automations'] then perform pmx_need(p_project, 'workflows'); end if;
  if 'roles' = any(v_parts) then perform pmx_need(p_project, 'members'); end if;
  if 'automations' = any(v_parts) then perform pmx_need(p_project, 'automations'); end if;
  if exists (select 1 from unnest(v_parts) x where x not in ('roles', 'workflows', 'types', 'fields', 'layouts', 'views', 'automations', 'settings', 'items')) then
    raise exception 'Unknown part of a configuration.';
  end if;
  if coalesce(p ->> 'template_id', '') <> '' then
    select config into v_config from pm_templates where id = pmx_uuid(p ->> 'template_id');
  elsif coalesce(p ->> 'from_project', '') <> '' then
    perform pmx_need(pmx_uuid(p ->> 'from_project'), 'view');
    v_config := pmx_export(pmx_uuid(p ->> 'from_project'), false);
  else
    v_config := p -> 'config';
  end if;
  if v_config is null then raise exception 'Nothing to apply.'; end if;
  v_out := pmx_apply_config(p_project, v_config, v_parts, pmx_bool(p, 'dry_run', false), coalesce(nullif(p ->> 'start_date', '')::date, current_date));
  if not pmx_bool(p, 'dry_run', false) then
    perform pmx_log(p_project, null, 'config', 'Applied a configuration (' || array_to_string(v_parts, ', ') || ')', jsonb_build_object('changes', v_out));
  end if;
  return jsonb_build_object('changes', v_out, 'dry_run', pmx_bool(p, 'dry_run', false));
end;
$$;

-- ---- work items ------------------------------------------------------------------------------------
/** The parts of an item a person can type, taken from what the page sent ('' means "nothing" for dates, numbers and people). */
create or replace function public.pmx_patch(p jsonb)
returns jsonb language sql immutable set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(k, case
      when k in ('title', 'description', 'vehicle', 'blocked_reason', 'acceptance') then to_jsonb(coalesce(p ->> k, ''))
      when k = 'labels' then to_jsonb(pmx_texts(p -> k))
      when p -> k = '""'::jsonb then 'null'::jsonb
      else p -> k end), '{}'::jsonb)
  from unnest(array['title', 'description', 'priority', 'owner_id', 'division_id', 'subsystem_id', 'vehicle', 'start_date', 'due_date', 'estimate_hours',
                    'progress', 'actual_start', 'blocked', 'blocked_reason', 'acceptance', 'labels', 'sprint_id', 'parent_id', 'rank']) k
  where p ? k;
$$;

/** The rules every item has to meet, whoever is saving it. Returns the item with the division filled from the subsystem. */
create or replace function public.pmx_check_item(n pm_items, o pm_items)
returns pm_items language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_type   pm_types;
  v_parent pm_items;
  v_ptype  pm_types;
  v_sub    org_subsystems;
  v_up     uuid;
  v_depth  int := 0;
begin
  if trim(coalesce(n.title, '')) = '' then raise exception 'Give it a title.'; end if;
  n.title := trim(n.title);
  if n.priority not in ('low', 'medium', 'high', 'urgent') then raise exception 'Priority is low, medium, high or urgent.'; end if;
  if n.owner_id is not null and n.owner_id is distinct from o.owner_id and not is_member(n.owner_id) then raise exception 'The owner has to be someone on the team.'; end if;
  if n.subsystem_id is not null then
    select * into v_sub from org_subsystems where id = n.subsystem_id;
    if v_sub.id is null then raise exception 'That subsystem doesn''t exist.'; end if;
    n.division_id := v_sub.division_id;
  end if;
  if n.division_id is not null and not exists (select 1 from org_divisions where id = n.division_id) then raise exception 'That CE division doesn''t exist.'; end if;
  if n.start_date is not null and n.due_date is not null and n.start_date > n.due_date then raise exception 'The start date is after the due date.'; end if;
  if cardinality(n.labels) > 20 or exists (select 1 from unnest(n.labels) x where length(x) > 40) then raise exception 'Up to 20 labels of up to 40 characters.'; end if;
  n.labels := array(select distinct x from unnest(n.labels) x order by 1);
  if n.blocked is not true then n.blocked := false; n.blocked_reason := ''; end if;
  if n.sprint_id is not null and not exists (select 1 from pm_sprints where id = n.sprint_id and project_id = n.project_id) then raise exception 'That sprint isn''t in this project.'; end if;
  select * into v_type from pm_types where id = n.type_id;
  if n.parent_id is not null and (n.parent_id is distinct from o.parent_id or n.type_id is distinct from o.type_id) then
    select * into v_parent from pm_items where id = n.parent_id;
    if v_parent.id is null or v_parent.project_id <> n.project_id then raise exception 'The parent has to be an item in the same project.'; end if;
    select * into v_ptype from pm_types where id = v_parent.type_id;
    if cardinality(v_type.parent_type_ids) > 0 then
      if not (v_ptype.id = any(v_type.parent_type_ids)) then raise exception 'A % can''t go under a %.', v_type.name, v_ptype.name; end if;
    elsif v_ptype.level >= v_type.level then
      raise exception 'A % can''t go under a % (it has to be under something higher up).', v_type.name, v_ptype.name;
    end if;
    v_up := n.parent_id;
    while v_up is not null loop
      if v_up = n.id then raise exception 'That would put the item underneath itself.'; end if;
      v_depth := v_depth + 1;
      if v_depth > 12 then raise exception 'Items can be nested up to 12 levels deep.'; end if;
      select parent_id into v_up from pm_items where id = v_up;
    end loop;
  end if;
  return n;
end;
$$;

/** May the signed-in person edit this item? "Edit items", or it's theirs and their role can create items. */
create or replace function public.pmx_may_edit(p_item pm_items)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select 'edit' = any(c) or ('create' = any(c) and (p_item.owner_id = auth.uid() or p_item.reporter_id = auth.uid()
      or exists (select 1 from pm_people where item_id = p_item.id and user_id = auth.uid() and kind = 'collab')))
  from (select pmx_caps_for(p_item.project_id, auth.uid()) as c) x;
$$;

/**
 * Create a work item. p_op is made by the page: sending it again returns the first item instead of making a
 * second. p: { project_id, type_id, title, …the fields pm_update_item takes…, status_id, custom,
 * collaborators, watchers, checklist: [text] }
 */
create or replace function public.pm_create_item(p_op uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_project uuid := pmx_uuid(p ->> 'project_id');
  v_type    pm_types;
  v_status  pm_statuses;
  v_want    uuid := pmx_uuid(p ->> 'status_id');
  v_tr      pm_transitions;
  n         pm_items;
  v_seq     int;
  v_key     text;
  v_miss    text[];
  v_defs    jsonb;
begin
  if p_op is not null then
    select * into n from pm_items where op_id = p_op;
    if n.id is not null then
      perform pmx_need(n.project_id, 'view');
      return to_jsonb(n);
    end if;
  end if;
  perform pmx_need(v_project, 'create');
  if (select archived_at from pm_projects where id = v_project) is not null then raise exception 'This project is archived. Restore it to add items.'; end if;
  select * into v_type from pm_types where id = pmx_uuid(p ->> 'type_id') and project_id = v_project and archived_at is null;
  if v_type.id is null then raise exception 'Pick one of this project''s work-item types.'; end if;
  select * into v_status from pm_statuses where workflow_id = v_type.workflow_id order by sort, name limit 1;

  update pm_projects set item_seq = item_seq + 1 where id = v_project returning item_seq, key into v_seq, v_key;
  n := jsonb_populate_record(null::pm_items, jsonb_build_object('priority', 'medium', 'description', '', 'vehicle', '', 'blocked', false, 'blocked_reason', '',
    'acceptance', '', 'labels', '[]'::jsonb, 'progress', 0, 'custom', '{}'::jsonb, 'version', 1)
    || (select coalesce(jsonb_object_agg(k, val), '{}') from jsonb_each(v_type.defaults) d(k, val)
        where k in ('priority', 'description', 'acceptance', 'estimate_hours', 'labels'))
    || pmx_patch(p));
  n.id := gen_random_uuid();
  n.project_id := v_project;
  n.type_id := v_type.id;
  n.seq := v_seq;
  n.key := v_key || '-' || v_seq;
  n.status_id := v_status.id;
  n.category := v_status.category;
  n.reporter_id := auth.uid();
  n.created_by := auth.uid();
  n.op_id := p_op;
  n.created_at := now();
  n.updated_at := now();
  if not p ? 'rank' or n.rank is null then n.rank := (select coalesce(max(rank), 0) + 1000 from pm_items where project_id = v_project); end if;
  -- an item belongs to its project's CE division and subsystem unless it says otherwise
  if n.division_id is null and n.subsystem_id is null then
    select division_id, subsystem_id into n.division_id, n.subsystem_id from pm_projects where id = v_project;
  end if;
  if n.owner_id is not null and n.owner_id <> auth.uid() then perform pmx_need(v_project, 'assign'); end if;
  if n.sprint_id is not null then perform pmx_need(v_project, 'plan'); end if;
  n := pmx_check_item(n, null::pm_items);
  -- fields start at their default; what the person typed wins
  select coalesce(jsonb_object_agg(f.key, f.default_value), '{}') into v_defs from pm_fields f
  where f.project_id = v_project and f.archived_at is null and f.default_value is not null and f.type <> 'formula'
    and (cardinality(f.type_ids) = 0 or v_type.id = any(f.type_ids));
  n.custom := pmx_clean_custom(v_project, v_type.id, v_defs || coalesce(nullif(p -> 'custom', 'null'), '{}'), '{}');
  v_miss := pmx_missing(n, pmx_required(v_project, v_type.id, 'create', null));
  if cardinality(v_miss) > 0 then
    raise exception 'Fill in: %.', pmx_field_names(v_project, v_miss) using errcode = 'OS428', detail = to_jsonb(v_miss)::text;
  end if;
  insert into pm_items select n.*;
  insert into pm_people (item_id, user_id, kind, project_id)
  select n.id, x, 'collab', v_project from unnest(pmx_uuids(p -> 'collaborators')) x where is_member(x)
  union select n.id, x, 'watch', v_project from unnest(pmx_uuids(p -> 'watchers') || auth.uid()) x where is_member(x)
  on conflict do nothing;
  insert into pm_checklist (item_id, project_id, text, sort)
  select n.id, v_project, left(x.t, 300), x.o from unnest(pmx_texts(p -> 'checklist')) with ordinality x(t, o);
  perform pmx_log(v_project, n.id, 'created', 'Created ' || n.key, jsonb_build_object('title', n.title, 'type', v_type.name));
  if n.owner_id is not null then perform pmx_notify(array[n.owner_id], 'assigned', n.id, 'Assigned to you: ' || n.title, coalesce(my_display_name(), 'Someone') || ' gave you ' || n.key || ' "' || n.title || '".'); end if;
  perform pmx_fire('created', n.id, '{}');
  -- made straight into another column: the same move (and the same rules) as dragging it there afterwards
  if v_want is not null and v_want <> n.status_id then
    select * into v_tr from pm_transitions where workflow_id = v_type.workflow_id and to_status = v_want and (from_status = n.status_id or from_status is null)
      order by from_status nulls last, sort limit 1;
    if v_tr.id is null then raise exception 'New % items start in "%": nothing moves them straight to that status.', v_type.name, v_status.name; end if;
    perform pm_transition(n.id, v_tr.id, '{}');
  end if;
  select * into n from pm_items where id = n.id;
  return to_jsonb(n);
end;
$$;

/**
 * Change an item. p_version is the version the page had: if someone saved in between, nothing is changed
 * (OS409) so their work isn't silently overwritten. p: any of title, description, priority, owner_id, division_id,
 * subsystem_id, vehicle, start_date, due_date, estimate_hours, progress, actual_start, blocked, blocked_reason,
 * acceptance, labels, sprint_id, parent_id, rank, custom: {…}, collaborators: […], watchers: […],
 * type_id (+ status_id when the new type has another workflow).
 */
create or replace function public.pmx_update(p_id uuid, p_version int, p jsonb, p_internal boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  o         pm_items;
  n         pm_items;
  v_patch   jsonb := pmx_patch(p);
  v_changes jsonb := '{}';
  v_keys    text[];
  v_type    pm_types;
  v_st      pm_statuses;
  v_before  text[];
  v_miss    text[];
  v_req     text[];
  k         text;
  v_people  boolean := false;
  v_quiet   boolean := coalesce(current_setting('pm.quiet', true), '') = '1';
begin
  select * into o from pm_items where id = p_id for update;
  if o.id is null then raise exception 'That item doesn''t exist.'; end if;
  if not p_internal then
    perform pmx_need(o.project_id, 'view');
    if not pmx_may_edit(o) then
      -- planners may still set dates, sprint and order
      if pmx_can(o.project_id, 'plan') and not exists (select 1 from jsonb_object_keys(p) x where x not in ('start_date', 'due_date', 'sprint_id', 'rank', 'parent_id')) then null;
      else perform pmx_need(o.project_id, 'edit');
      end if;
    end if;
  end if;
  if o.archived_at is not null then raise exception '% is archived. Restore it to change it.', o.key; end if;
  if p_version is not null and p_version <> o.version then
    raise exception '% was changed by someone else while you had it open. Reload to see their changes, then make yours again.', o.key using errcode = 'OS409';
  end if;

  n := jsonb_populate_record(o, v_patch);
  if not p_internal then
    if n.owner_id is distinct from o.owner_id and n.owner_id is distinct from auth.uid() then perform pmx_need(o.project_id, 'assign'); end if;
    if n.sprint_id is distinct from o.sprint_id then perform pmx_need(o.project_id, 'plan'); end if;
  end if;
  if p ? 'type_id' and pmx_uuid(p ->> 'type_id') <> o.type_id then
    select * into v_type from pm_types where id = pmx_uuid(p ->> 'type_id') and project_id = o.project_id and archived_at is null;
    if v_type.id is null then raise exception 'Pick one of this project''s work-item types.'; end if;
    n.type_id := v_type.id;
    if not exists (select 1 from pm_statuses where id = o.status_id and workflow_id = v_type.workflow_id) then
      select * into v_st from pm_statuses where id = pmx_uuid(p ->> 'status_id') and workflow_id = v_type.workflow_id;
      if v_st.id is null then
        raise exception '% items use another workflow. Pick the status it should have there.', v_type.name using errcode = 'OS428', detail = '["status_id"]';
      end if;
      n.status_id := v_st.id;
      n.category := v_st.category;
      update pm_approvals set status = 'cancelled', note = 'The item''s type changed.', decided_at = now() where item_id = o.id and status = 'pending';
    end if;
    -- values of fields the new type doesn't use are kept in the history, not on the item
    n.custom := coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(o.custom) e join pm_fields f on f.project_id = o.project_id and f.key = e.key
      where cardinality(f.type_ids) = 0 or v_type.id = any(f.type_ids)), '{}');
  end if;
  n := pmx_check_item(n, o);
  if p ? 'custom' then n.custom := pmx_clean_custom(o.project_id, n.type_id, p -> 'custom', n.custom); end if;

  -- a required field can't be emptied (one that was already empty doesn't block unrelated edits)
  v_req := pmx_required(o.project_id, n.type_id, 'edit', null);
  v_before := pmx_missing(o, v_req);
  select coalesce(array_agg(x), '{}') into v_miss from unnest(pmx_missing(n, v_req)) x where not (x = any(v_before));
  if cardinality(v_miss) > 0 and not p_internal then
    raise exception '% can''t be left empty.', pmx_field_names(o.project_id, v_miss) using errcode = 'OS428', detail = to_jsonb(v_miss)::text;
  end if;

  foreach k in array array['title', 'description', 'priority', 'owner_id', 'division_id', 'subsystem_id', 'vehicle', 'start_date', 'due_date', 'estimate_hours',
                           'progress', 'actual_start', 'blocked', 'blocked_reason', 'acceptance', 'labels', 'sprint_id', 'parent_id', 'type_id', 'status_id'] loop
    if (to_jsonb(o) -> k) is distinct from (to_jsonb(n) -> k) then
      v_changes := v_changes || jsonb_build_object(k, case when k in ('description', 'acceptance') then '[true]'::jsonb else jsonb_build_array(to_jsonb(o) -> k, to_jsonb(n) -> k) end);
    end if;
  end loop;
  select v_changes || coalesce(jsonb_object_agg('cf.' || kk, jsonb_build_array(o.custom -> kk, n.custom -> kk)), '{}') into v_changes
  from (select jsonb_object_keys(o.custom || n.custom) as kk) x where (o.custom -> kk) is distinct from (n.custom -> kk);

  if p ? 'collaborators' then
    delete from pm_people where item_id = o.id and kind = 'collab' and not (user_id = any(pmx_uuids(p -> 'collaborators')));
    if found then v_people := true; end if;
    insert into pm_people (item_id, user_id, kind, project_id) select o.id, x, 'collab', o.project_id from unnest(pmx_uuids(p -> 'collaborators')) x where is_member(x)
    on conflict do nothing;
    if found then v_people := true; end if;
  end if;
  if p ? 'watchers' then
    delete from pm_people where item_id = o.id and kind = 'watch' and not (user_id = any(pmx_uuids(p -> 'watchers')));
    insert into pm_people (item_id, user_id, kind, project_id) select o.id, x, 'watch', o.project_id from unnest(pmx_uuids(p -> 'watchers')) x where is_member(x)
    on conflict do nothing;
  end if;
  if v_people then v_changes := v_changes || jsonb_build_object('collaborators', '[true]'::jsonb); end if;

  if v_changes = '{}'::jsonb and n.rank is not distinct from o.rank then return to_jsonb(o); end if;
  update pm_items set title = n.title, description = n.description, priority = n.priority, owner_id = n.owner_id, division_id = n.division_id,
    subsystem_id = n.subsystem_id, vehicle = n.vehicle, start_date = n.start_date, due_date = n.due_date, estimate_hours = n.estimate_hours,
    progress = n.progress, actual_start = n.actual_start, blocked = n.blocked, blocked_reason = n.blocked_reason, acceptance = n.acceptance,
    labels = n.labels, sprint_id = n.sprint_id, parent_id = n.parent_id, rank = n.rank, type_id = n.type_id, status_id = n.status_id, category = n.category,
    custom = n.custom, version = case when v_changes = '{}'::jsonb then version else version + 1 end,
    updated_at = case when v_changes = '{}'::jsonb then updated_at else now() end
  where id = o.id returning * into n;
  if v_changes = '{}'::jsonb then return to_jsonb(n); end if;   -- only its place in the list moved

  select array_agg(x) into v_keys from jsonb_object_keys(v_changes) x;
  perform pmx_log(o.project_id, o.id, 'updated', 'Changed ' || pmx_field_names(o.project_id, v_keys), jsonb_build_object('changes', v_changes));
  if n.owner_id is distinct from o.owner_id and n.owner_id is not null then
    perform pmx_notify(array[n.owner_id], 'assigned', o.id, 'Assigned to you: ' || n.title, coalesce(my_display_name(), 'Someone') || ' gave you ' || n.key || ' "' || n.title || '".');
  end if;
  if not v_quiet and v_keys && array['due_date', 'start_date', 'blocked', 'priority', 'title', 'owner_id'] then
    perform pmx_notify(pmx_audience(o.id), 'updated', o.id, 'Changed: ' || n.title,
      coalesce(my_display_name(), 'Someone') || ' changed ' || pmx_field_names(o.project_id, v_keys) || ' on ' || n.key || '.');
  end if;
  if n.owner_id is distinct from o.owner_id then perform pmx_fire('assigned', o.id, '{}'); end if;
  perform pmx_fire('updated', o.id, jsonb_build_object('changed', to_jsonb(v_keys)));
  return to_jsonb(n);
end;
$$;

create or replace function public.pm_update_item(p_id uuid, p_version int, p jsonb)
returns jsonb language sql security definer set search_path = public, pg_temp
as $$ select pmx_update(p_id, p_version, p, false); $$;

/** The same change on many items. Items it can't change are reported, not skipped silently. No emails. */
create or replace function public.pm_bulk_update(p_ids uuid[], p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id     uuid;
  v_done   int := 0;
  v_failed jsonb := '[]';
  v_p      jsonb;
begin
  perform pmx_open();
  if cardinality(p_ids) > 200 then raise exception 'Change up to 200 items at a time.'; end if;
  if exists (select 1 from jsonb_object_keys(p) k where k not in ('priority', 'owner_id', 'sprint_id', 'due_date', 'start_date', 'division_id', 'subsystem_id',
                                                                  'parent_id', 'add_labels', 'blocked', 'archived')) then
    raise exception 'That can''t be changed on many items at once.';
  end if;
  perform set_config('pm.quiet', '1', true);
  foreach v_id in array p_ids loop
    begin
      if p ? 'archived' then perform pm_archive_item(v_id, pmx_bool(p, 'archived', true)); end if;
      v_p := p - 'add_labels' - 'archived';
      if p ? 'add_labels' then
        v_p := v_p || jsonb_build_object('labels', to_jsonb((select labels from pm_items where id = v_id) || pmx_texts(p -> 'add_labels')));
      end if;
      if v_p <> '{}'::jsonb then perform pmx_update(v_id, null, v_p, false); end if;
      v_done := v_done + 1;
    exception when others then
      v_failed := v_failed || jsonb_build_object('id', v_id, 'key', (select key from pm_items where id = v_id), 'error', sqlerrm);
    end;
  end loop;
  perform set_config('pm.quiet', '', true);
  return jsonb_build_object('changed', v_done, 'failed', v_failed);
end;
$$;

/** Archive (or restore) an item and everything under it. Nothing is deleted. */
create or replace function public.pm_archive_item(p_id uuid, p_archived boolean)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare o pm_items; v_n int;
begin
  select * into o from pm_items where id = p_id for update;
  if o.id is null then raise exception 'That item doesn''t exist.'; end if;
  perform pmx_need(o.project_id, 'delete');
  with recursive tree as (select id from pm_items where id = p_id union all select i.id from pm_items i join tree t on i.parent_id = t.id)
  update pm_items set archived_at = case when p_archived then coalesce(archived_at, now()) end, version = version + 1, updated_at = now()
  where id in (select id from tree) and (archived_at is null) = p_archived;
  get diagnostics v_n = row_count;
  if p_archived then update pm_approvals set status = 'cancelled', note = 'The item was archived.', decided_at = now() where item_id = p_id and status = 'pending'; end if;
  perform pmx_log(o.project_id, p_id, 'archived', case when p_archived then 'Archived ' else 'Restored ' end || o.key || case when v_n > 1 then ' and ' || (v_n - 1) || ' under it' else '' end, '{}');
end;
$$;

/**
 * Move an item to another project. It gets that project's next number (its old name still opens it), keeps its
 * whole history, comments, checklist, documents and links. Items that were under it stay behind, under what it
 * was under. p: { project_id, type_id, status_id }
 */
create or replace function public.pm_move_item(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  o        pm_items;
  n        pm_items;
  v_to     uuid := pmx_uuid(p ->> 'project_id');
  v_type   pm_types;
  v_st     pm_statuses;
  v_seq    int;
  v_key    text;
  v_drop   jsonb;
  r        record;
  v_res    uuid;
begin
  select * into o from pm_items where id = p_id for update;
  if o.id is null then raise exception 'That item doesn''t exist.'; end if;
  perform pmx_need(o.project_id, 'edit');
  perform pmx_need(v_to, 'create');
  if v_to = o.project_id then raise exception 'It''s already in that project.'; end if;
  select * into v_type from pm_types where id = pmx_uuid(p ->> 'type_id') and project_id = v_to and archived_at is null;
  if v_type.id is null then raise exception 'Pick what kind of item it becomes in the other project.' using errcode = 'OS428', detail = '["type_id"]'; end if;
  select * into v_st from pm_statuses where workflow_id = v_type.workflow_id and (id = pmx_uuid(p ->> 'status_id') or pmx_uuid(p ->> 'status_id') is null) order by sort, name limit 1;
  if v_st.id is null then raise exception 'Pick a status from the other project''s workflow.'; end if;
  update pm_projects set item_seq = item_seq + 1 where id = v_to returning item_seq, key into v_seq, v_key;
  select coalesce(jsonb_object_agg(e.key, e.value), '{}') into v_drop from jsonb_each(o.custom) e
  where not exists (select 1 from pm_fields f where f.project_id = v_to and f.key = e.key and f.archived_at is null and f.type <> 'formula'
                      and (cardinality(f.type_ids) = 0 or v_type.id = any(f.type_ids)));
  update pm_items set parent_id = o.parent_id, version = version + 1 where parent_id = o.id;
  insert into pm_item_aliases (key, item_id, project_id) values (o.key, o.id, v_to) on conflict (key) do update set item_id = excluded.item_id, project_id = excluded.project_id;
  update pm_item_aliases set project_id = v_to where item_id = o.id;
  update pm_approvals set status = 'cancelled', note = 'The item moved to another project.', decided_at = now() where item_id = o.id and status = 'pending';
  update pm_items set project_id = v_to, type_id = v_type.id, seq = v_seq, key = v_key || '-' || v_seq, parent_id = null, sprint_id = null,
    status_id = v_st.id, category = v_st.category, custom = o.custom - array(select jsonb_object_keys(v_drop)),
    completed_at = case when v_st.category = 'done' then coalesce(completed_at, now()) end,
    rank = (select coalesce(max(rank), 0) + 1000 from pm_items where project_id = v_to), version = version + 1, updated_at = now()
  where id = o.id returning * into n;
  begin
    n.custom := pmx_clean_custom(v_to, v_type.id, n.custom, '{}');
  exception when others then
    v_drop := v_drop || n.custom;
    update pm_items set custom = '{}' where id = o.id;
  end;
  perform set_config('pm.move', '1', true);
  update pm_events set project_id = v_to where item_id = o.id;
  perform set_config('pm.move', '', true);
  update pm_people set project_id = v_to where item_id = o.id;
  update pm_checklist set project_id = v_to where item_id = o.id;
  update pm_comments set project_id = v_to where item_id = o.id;
  update pm_approvals set project_id = v_to where item_id = o.id;
  update pm_refs set project_id = v_to where item_id = o.id;
  update pm_deps set from_project = v_to where from_item = o.id;
  update pm_deps set to_project = v_to where to_item = o.id;
  update pm_notifications set project_id = v_to where item_id = o.id;
  for r in select l.id as link_id, s.* from pm_resource_links l join pm_resources s on s.id = l.resource_id where l.item_id = o.id loop
    insert into pm_resources (project_id, url, title, category, provider, kind, file_type, meta, created_by)
    values (v_to, r.url, r.title, r.category, r.provider, r.kind, r.file_type, r.meta, r.created_by)
    on conflict (project_id, url) do update set updated_at = now() returning id into v_res;
    update pm_resource_links set resource_id = v_res, project_id = v_to where id = r.link_id;
  end loop;
  perform pmx_log(v_to, o.id, 'moved', 'Moved from ' || o.key || ' to ' || n.key, jsonb_build_object('from_project', o.project_id, 'old_key', o.key, 'dropped_fields', v_drop));
  perform pmx_log(o.project_id, null, 'moved', o.key || ' "' || o.title || '" moved to ' || n.key, '{}');
  select * into n from pm_items where id = o.id;
  return to_jsonb(n);
end;
$$;

-- ---- the workflow engine ---------------------------------------------------------------------------
/** Put an item in a status and do everything that follows. Only called once a move has been allowed. */
create or replace function public.pmx_set_status(p_item uuid, p_tr pm_transitions, p_comment text, p_how text)
returns pm_items language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  o       pm_items;
  n       pm_items;
  v_from  pm_statuses;
  v_to    pm_statuses;
  v_event bigint;
  r       record;
begin
  select * into o from pm_items where id = p_item for update;
  select * into v_from from pm_statuses where id = o.status_id;
  select * into v_to from pm_statuses where id = p_tr.to_status;
  update pm_items set status_id = v_to.id, category = v_to.category, version = version + 1, updated_at = now(),
    completed_at = case when v_to.category = 'done' then coalesce(completed_at, now()) else null end,
    actual_start = case when v_to.category <> 'todo' then coalesce(actual_start, current_date) else actual_start end,
    progress = case when v_to.category = 'done' then 100 else progress end,
    accepted_at = case when v_to.category = 'done' then accepted_at else null end,
    accepted_by = case when v_to.category = 'done' then accepted_by else null end
  where id = p_item returning * into n;
  if p_how <> 'approval' then
    update pm_approvals set status = 'cancelled', note = 'The item moved to "' || v_to.name || '" another way.', decided_at = now() where item_id = p_item and status = 'pending';
  end if;
  if trim(coalesce(p_comment, '')) <> '' then
    insert into pm_comments (item_id, project_id, author_id, body) values (p_item, o.project_id, auth.uid(), left(trim(p_comment), 10000));
  end if;
  v_event := pmx_log(o.project_id, p_item, 'status', '"' || v_from.name || '" → "' || v_to.name || '"',
    jsonb_build_object('from', v_from.id, 'to', v_to.id, 'from_name', v_from.name, 'to_name', v_to.name, 'transition', p_tr.name, 'how', p_how, 'comment', coalesce(p_comment, '')));
  perform pmx_notify(pmx_audience(p_item), 'status', p_item, '"' || v_to.name || '": ' || n.title,
    coalesce(my_display_name(), 'A rule') || ' moved ' || n.key || ' from "' || v_from.name || '" to "' || v_to.name || '".');
  if jsonb_array_length(p_tr.actions) > 0 then perform pmx_run_actions(p_item, p_tr.actions, 'transition'); end if;
  perform pmx_fire('status', p_item, jsonb_build_object('from', v_from.id, 'to', v_to.id, 'event', v_event));
  if v_to.category = 'done' and v_from.category <> 'done' then
    if (select is_milestone from pm_types where id = n.type_id) then perform pmx_fire('milestone', p_item, jsonb_build_object('event', v_event)); end if;
    -- what was waiting on this
    for r in select i.* from pm_deps d join pm_items i on i.id = d.to_item where d.from_item = p_item and i.archived_at is null and i.category <> 'done' loop
      if not exists (select 1 from pm_deps d2 join pm_items x on x.id = d2.from_item where d2.to_item = r.id and x.category <> 'done' and x.archived_at is null) then
        perform pmx_notify(array[r.owner_id], 'dependency', r.id, 'Ready to start: ' || r.title, n.key || ' "' || n.title || '" is done, so nothing is holding up ' || r.key || ' any more.');
        perform pmx_fire('dependency_done', r.id, jsonb_build_object('event', v_event));
      end if;
    end loop;
  end if;
  select * into n from pm_items where id = p_item;
  return n;
end;
$$;

/**
 * Make a workflow move. The board, the list and the item page all call this, so the workflow's rules always
 * hold: the move has to exist from the item's current status, the person's project role has to be allowed,
 * required fields and comment have to be there, conditions have to match; a move that needs approval waits for
 * someone who may approve. p: { version, comment, fields: {…what pm_update_item takes…} }
 * Returns the item, or { pending: true, approval_id } when it's now waiting for approval.
 */
create or replace function public.pm_transition(p_id uuid, p_transition uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  o        pm_items;
  t        pm_transitions;
  v_type   pm_types;
  v_miss   text[];
  v_ok     boolean;
  v_appr   uuid;
  v_who    uuid[];
begin
  select * into o from pm_items where id = p_id for update;
  if o.id is null then raise exception 'That item doesn''t exist.'; end if;
  perform pmx_need(o.project_id, 'transition');
  if o.archived_at is not null then raise exception '% is archived.', o.key; end if;
  select * into v_type from pm_types where id = o.type_id;
  select * into t from pm_transitions where id = p_transition and workflow_id = v_type.workflow_id;
  if t.id is null then raise exception 'That move isn''t part of this item''s workflow.'; end if;
  if p ? 'version' and (p ->> 'version')::int <> o.version then
    raise exception '% was changed by someone else while you had it open. Reload to see their changes.', o.key using errcode = 'OS409';
  end if;
  if t.to_status = o.status_id then return to_jsonb(o); end if;
  if t.from_status is not null and t.from_status <> o.status_id then
    raise exception '% is now "%", so "%" doesn''t apply any more. Reload to see where it is.', o.key, (select name from pm_statuses where id = o.status_id), t.name using errcode = 'OS409';
  end if;
  if cardinality(t.role_ids) > 0 and not has_permission('projects.manage') and not exists (
      select 1 from pm_members m where m.project_id = o.project_id and m.user_id = auth.uid() and m.role_id = any(t.role_ids)
      union all select 1 from pm_projects pp where pp.id = o.project_id and pp.visibility = 'team' and pp.team_role_id = any(t.role_ids)) then
    raise exception 'Only % can make the move "%".', (select string_agg(name, ' or ') from pm_roles where id = any(t.role_ids)), t.name using errcode = '42501';
  end if;
  if jsonb_typeof(p -> 'fields') = 'object' and p -> 'fields' <> '{}'::jsonb then
    perform pmx_update(p_id, null, p -> 'fields', true);
    select * into o from pm_items where id = p_id;
  end if;
  if not pmx_matches(p_id, t.conditions) then
    raise exception '% doesn''t meet the conditions for "%"%.', o.key, t.name, coalesce(': ' || nullif(t.description, ''), '');
  end if;
  v_miss := pmx_missing(o, t.require_fields || pmx_required(o.project_id, o.type_id, 'transition', t.id));
  if t.require_comment and trim(coalesce(p ->> 'comment', '')) = '' then v_miss := v_miss || 'comment'::text; end if;
  if cardinality(v_miss) > 0 then
    raise exception '"%" needs: %.', t.name, pmx_field_names(o.project_id, v_miss) using errcode = 'OS428', detail = to_jsonb(v_miss)::text;
  end if;
  if t.require_approval then
    v_ok := pmx_can(o.project_id, 'approve') and not (t.no_self_approval and o.owner_id = auth.uid());
    if not v_ok then
      if exists (select 1 from pm_approvals where item_id = p_id and status = 'pending') then
        raise exception '% is already waiting for an approval.', o.key;
      end if;
      insert into pm_approvals (item_id, project_id, transition_id, requested_by, payload)
      values (p_id, o.project_id, t.id, auth.uid(), jsonb_build_object('comment', coalesce(p ->> 'comment', ''))) returning id into v_appr;
      perform pmx_log(o.project_id, p_id, 'approval', 'Asked for approval: "' || t.name || '"', jsonb_build_object('transition', t.name, 'approval', v_appr));
      select coalesce(array_agg(distinct u), '{}') into v_who from (
        select m.user_id as u from pm_members m join pm_roles r on r.id = m.role_id where m.project_id = o.project_id and 'approve' = any(r.caps)
        union select lead_id from pm_projects where id = o.project_id) x
      where u is not null and not (t.no_self_approval and u = o.owner_id);
      perform pmx_notify(v_who, 'review', p_id, 'Needs your approval: ' || o.title,
        coalesce(my_display_name(), 'Someone') || ' asked to move ' || o.key || ' with "' || t.name || '". It needs an approval.');
      return jsonb_build_object('pending', true, 'approval_id', v_appr, 'item', to_jsonb(o));
    end if;
  end if;
  return to_jsonb(pmx_set_status(p_id, t, p ->> 'comment', case when t.require_approval then 'approved' else 'transition' end));
end;
$$;

/** Approve (the move happens) or reject a move that was waiting. */
create or replace function public.pm_decide_approval(p_id uuid, p_approve boolean, p_note text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  a pm_approvals;
  o pm_items;
  t pm_transitions;
begin
  select * into a from pm_approvals where id = p_id for update;
  if a.id is null then raise exception 'That approval request doesn''t exist.'; end if;
  perform pmx_need(a.project_id, 'approve');
  if a.status <> 'pending' then raise exception 'That request was already %.', a.status using errcode = 'OS409'; end if;
  select * into o from pm_items where id = a.item_id for update;
  select * into t from pm_transitions where id = a.transition_id;
  if t.no_self_approval and o.owner_id = auth.uid() then raise exception 'The owner can''t approve their own item here. Someone else has to.' using errcode = '42501'; end if;
  if not p_approve and trim(coalesce(p_note, '')) = '' then raise exception 'Say why you''re sending it back.'; end if;
  update pm_approvals set status = case when p_approve then 'approved' else 'rejected' end, decided_by = auth.uid(), decided_at = now(), note = left(coalesce(p_note, ''), 1000)
  where id = p_id;
  if p_approve then
    if t.from_status is not null and t.from_status <> o.status_id then
      raise exception '% has moved since this was asked for, so the approval no longer applies.', o.key using errcode = 'OS409';
    end if;
    perform pmx_log(o.project_id, o.id, 'approval', 'Approved "' || t.name || '"', jsonb_build_object('approval', p_id, 'note', coalesce(p_note, '')));
    o := pmx_set_status(o.id, t, nullif(trim(coalesce(a.payload ->> 'comment', '')), ''), 'approval');
  else
    perform pmx_log(o.project_id, o.id, 'approval', 'Sent back: "' || t.name || '" wasn''t approved', jsonb_build_object('approval', p_id, 'note', p_note));
  end if;
  perform pmx_notify(array[a.requested_by, o.owner_id], 'review', o.id, case when p_approve then 'Approved: ' else 'Not approved: ' end || o.title,
    coalesce(my_display_name(), 'Someone') || case when p_approve then ' approved "' else ' didn''t approve "' end || t.name || '" on ' || o.key
    || case when trim(coalesce(p_note, '')) <> '' then ': ' || p_note else '.' end);
  return to_jsonb(o);
end;
$$;

/** Formal acceptance of finished work: a separate step from "done", by someone who may approve. */
create or replace function public.pm_accept(p_id uuid, p_accepted boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare o pm_items;
begin
  select * into o from pm_items where id = p_id for update;
  if o.id is null then raise exception 'That item doesn''t exist.'; end if;
  perform pmx_need(o.project_id, 'approve');
  if p_accepted and o.category <> 'done' then raise exception '% isn''t finished yet, so it can''t be accepted.', o.key; end if;
  update pm_items set accepted_at = case when p_accepted then now() end, accepted_by = case when p_accepted then auth.uid() end, version = version + 1, updated_at = now()
  where id = p_id returning * into o;
  perform pmx_log(o.project_id, p_id, 'accepted', case when p_accepted then 'Reviewed and accepted' else 'Acceptance withdrawn' end, '{}');
  perform pmx_notify(array[o.owner_id], 'review', p_id, case when p_accepted then 'Accepted: ' else 'Acceptance withdrawn: ' end || o.title,
    coalesce(my_display_name(), 'Someone') || case when p_accepted then ' reviewed and accepted ' else ' withdrew the acceptance of ' end || o.key || '.');
  return to_jsonb(o);
end;
$$;

-- ---- comments, checklists, watching ----------------------------------------------------------------
create or replace function public.pm_comment(p_item uuid, p_body text, p_mentions uuid[])
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  o pm_items;
  c pm_comments;
  v_mentions uuid[];
begin
  select * into o from pm_items where id = p_item;
  if o.id is null then raise exception 'That item doesn''t exist.'; end if;
  perform pmx_need(o.project_id, 'comment');
  if trim(coalesce(p_body, '')) = '' then raise exception 'Write something first.'; end if;
  v_mentions := array(select distinct x from unnest(coalesce(p_mentions, '{}')) x where 'view' = any(pmx_caps_for(o.project_id, x)));
  insert into pm_comments (item_id, project_id, author_id, body, mentions) values (p_item, o.project_id, auth.uid(), left(trim(p_body), 10000), v_mentions) returning * into c;
  insert into pm_people (item_id, user_id, kind, project_id) values (p_item, auth.uid(), 'watch', o.project_id) on conflict do nothing;
  update pm_items set updated_at = now() where id = p_item;
  perform pmx_log(o.project_id, p_item, 'comment', 'Commented', jsonb_build_object('comment', c.id));
  perform pmx_notify(v_mentions, 'mentioned', p_item, 'You were mentioned: ' || o.title, coalesce(my_display_name(), 'Someone') || ' mentioned you on ' || o.key || ': ' || left(c.body, 300));
  perform pmx_notify(array(select x from unnest(pmx_audience(p_item)) x where not (x = any(v_mentions))), 'comment', p_item, 'New comment: ' || o.title,
    coalesce(my_display_name(), 'Someone') || ' commented on ' || o.key || ': ' || left(c.body, 300));
  perform pmx_fire('comment', p_item, jsonb_build_object('comment', c.id));
  return to_jsonb(c);
end;
$$;

/** Edit your own comment, or (p_body null) remove it. People who can archive items can remove any comment. */
create or replace function public.pm_edit_comment(p_id uuid, p_body text)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare c pm_comments;
begin
  select * into c from pm_comments where id = p_id for update;
  if c.id is null or c.deleted_at is not null then raise exception 'That comment doesn''t exist.'; end if;
  perform pmx_need(c.project_id, 'comment');
  if p_body is null then
    if c.author_id is distinct from auth.uid() then perform pmx_need(c.project_id, 'delete'); end if;
    update pm_comments set deleted_at = now(), body = '(removed)' where id = p_id;
    perform pmx_log(c.project_id, c.item_id, 'comment', 'Removed a comment', jsonb_build_object('comment', c.id));
  else
    if c.author_id is distinct from auth.uid() then raise exception 'You can only edit your own comments.' using errcode = '42501'; end if;
    if trim(p_body) = '' then raise exception 'Write something first.'; end if;
    update pm_comments set body = left(trim(p_body), 10000), edited_at = now() where id = p_id;
  end if;
end;
$$;

/** The whole checklist: [{ id, text, done }] in order. */
create or replace function public.pm_save_checklist(p_item uuid, p_items jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare o pm_items;
begin
  select * into o from pm_items where id = p_item for update;
  if o.id is null then raise exception 'That item doesn''t exist.'; end if;
  perform pmx_need(o.project_id, 'view');
  if not pmx_may_edit(o) then perform pmx_need(o.project_id, 'edit'); end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 then raise exception 'A checklist can have up to 100 lines.'; end if;
  delete from pm_checklist where item_id = p_item and id not in (select pmx_uuid(x ->> 'id') from jsonb_array_elements(p_items) x where x ->> 'id' is not null);
  insert into pm_checklist (id, item_id, project_id, text, done, sort, done_by, done_at)
  select coalesce(pmx_uuid(x ->> 'id'), gen_random_uuid()), p_item, o.project_id, left(trim(x ->> 'text'), 300), pmx_bool(x, 'done', false), n::int,
         case when pmx_bool(x, 'done', false) then auth.uid() end, case when pmx_bool(x, 'done', false) then now() end
  from jsonb_array_elements(p_items) with ordinality q(x, n) where trim(coalesce(x ->> 'text', '')) <> ''
  on conflict (id) do update set text = excluded.text, sort = excluded.sort, done = excluded.done,
    done_by = case when excluded.done and not pm_checklist.done then excluded.done_by when excluded.done then pm_checklist.done_by end,
    done_at = case when excluded.done and not pm_checklist.done then excluded.done_at when excluded.done then pm_checklist.done_at end
  where pm_checklist.item_id = excluded.item_id;
  update pm_items set updated_at = now() where id = p_item;
end;
$$;

create or replace function public.pm_watch(p_item uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare o pm_items;
begin
  select * into o from pm_items where id = p_item;
  if o.id is null then raise exception 'That item doesn''t exist.'; end if;
  perform pmx_need(o.project_id, 'view');
  if p_on then insert into pm_people (item_id, user_id, kind, project_id) values (p_item, auth.uid(), 'watch', o.project_id) on conflict do nothing;
  else delete from pm_people where item_id = p_item and user_id = auth.uid() and kind = 'watch';
  end if;
end;
$$;

-- ---- dependencies ----------------------------------------------------------------------------------
/** p: { from, to, kind: FS | SS | FF | SF, lag_days }: "from" has to happen first. Works across projects. No loops. */
create or replace function public.pm_link(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  a pm_items;
  b pm_items;
  d pm_deps;
begin
  select * into a from pm_items where id = pmx_uuid(p ->> 'from');
  select * into b from pm_items where id = pmx_uuid(p ->> 'to');
  if a.id is null or b.id is null then raise exception 'Pick two items.'; end if;
  perform pmx_need(a.project_id, 'view');
  perform pmx_need(b.project_id, 'plan');
  if a.id = b.id then raise exception 'An item can''t depend on itself.'; end if;
  if coalesce(p ->> 'kind', 'FS') not in ('FS', 'SS', 'FF', 'SF') then raise exception 'Unknown kind of dependency.'; end if;
  -- lock the pair's projects in a fixed order so two people can't close a loop at the same moment
  perform 1 from pm_projects where id in (a.project_id, b.project_id) order by id for update;
  if exists (with recursive down as (
               select to_item from pm_deps where from_item = b.id
               union select d2.to_item from pm_deps d2 join down on d2.from_item = down.to_item)
             select 1 from down where to_item = a.id) then
    raise exception '% already depends on % (directly or through other items), so this would make a loop.', a.key, b.key;
  end if;
  insert into pm_deps (from_item, to_item, from_project, to_project, kind, lag_days, created_by)
  values (a.id, b.id, a.project_id, b.project_id, coalesce(p ->> 'kind', 'FS'), coalesce((p ->> 'lag_days')::int, 0), auth.uid())
  on conflict (from_item, to_item) do update set kind = excluded.kind, lag_days = excluded.lag_days returning * into d;
  perform pmx_log(b.project_id, b.id, 'dependency', 'Now depends on ' || a.key, jsonb_build_object('from', a.id, 'kind', d.kind, 'lag_days', d.lag_days));
  return to_jsonb(d);
end;
$$;

create or replace function public.pm_unlink(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare d pm_deps;
begin
  select * into d from pm_deps where id = p_id;
  if d.id is null then return; end if;
  perform pmx_need(d.to_project, 'plan');
  delete from pm_deps where id = p_id;
  perform pmx_log(d.to_project, d.to_item, 'dependency', 'No longer depends on ' || (select key from pm_items where id = d.from_item), jsonb_build_object('from', d.from_item));
end;
$$;

-- ---- linked documents and one.solar records -----------------------------------------------------------
/**
 * Link a document by its address. p: { project_id, item_id, subsystem_id, url, title, category, provider, kind,
 * file_type }. Only https addresses are kept; nothing is fetched, so this never says whether the file exists
 * or who can open it.
 */
create or replace function public.pm_add_resource(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_item    pm_items;
  v_project uuid := pmx_uuid(p ->> 'project_id');
  v_url     text := trim(coalesce(p ->> 'url', ''));
  r         pm_resources;
begin
  if coalesce(p ->> 'item_id', '') <> '' then
    select * into v_item from pm_items where id = pmx_uuid(p ->> 'item_id');
    if v_item.id is null then raise exception 'That item doesn''t exist.'; end if;
    v_project := v_item.project_id;
  end if;
  perform pmx_need(v_project, 'view');
  if not (pmx_can(v_project, 'create') or pmx_can(v_project, 'edit')) then perform pmx_need(v_project, 'create'); end if;
  if v_url !~* '^https://[^\s<>"]+$' or length(v_url) > 2000 then
    raise exception 'Paste the document''s full link (it starts with https://).';
  end if;
  if trim(coalesce(p ->> 'title', '')) = '' then raise exception 'Give the document a title.'; end if;
  insert into pm_resources (project_id, url, title, category, provider, kind, file_type, created_by)
  values (v_project, v_url, trim(p ->> 'title'), coalesce(p ->> 'category', ''), coalesce(nullif(p ->> 'provider', ''), 'link'),
    coalesce(nullif(p ->> 'kind', ''), 'file'), left(coalesce(p ->> 'file_type', ''), 12), auth.uid())
  on conflict (project_id, url) do update set title = excluded.title, category = case when excluded.category <> '' then excluded.category else pm_resources.category end,
    updated_at = now()
  returning * into r;
  insert into pm_resource_links (resource_id, project_id, item_id, subsystem_id, added_by)
  values (r.id, v_project, v_item.id, pmx_uuid(p ->> 'subsystem_id'), auth.uid()) on conflict do nothing;
  if found and v_item.id is not null then perform pmx_log(v_project, v_item.id, 'document', 'Linked "' || r.title || '"', jsonb_build_object('resource', r.id)); end if;
  return to_jsonb(r);
end;
$$;

/** Change a document's title or category, or (p null) take it off the project altogether. */
create or replace function public.pm_save_resource(p_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare r pm_resources;
begin
  select * into r from pm_resources where id = p_id;
  if r.id is null then return; end if;
  if not (pmx_can(r.project_id, 'create') or pmx_can(r.project_id, 'edit')) then perform pmx_need(r.project_id, 'create'); end if;
  if p is null then
    if r.created_by is distinct from auth.uid() then perform pmx_need(r.project_id, 'edit'); end if;
    delete from pm_resources where id = p_id;
  else
    update pm_resources set title = coalesce(nullif(trim(p ->> 'title'), ''), title), category = coalesce(p ->> 'category', category), updated_at = now() where id = p_id;
  end if;
end;
$$;

/** Take a document off one item (the document stays in the project's library while anything else uses it). */
create or replace function public.pm_remove_resource_link(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare l pm_resource_links;
begin
  select * into l from pm_resource_links where id = p_id;
  if l.id is null then return; end if;
  if not (pmx_can(l.project_id, 'create') or pmx_can(l.project_id, 'edit')) then perform pmx_need(l.project_id, 'create'); end if;
  delete from pm_resource_links where id = p_id;
  delete from pm_resources r where r.id = l.resource_id and not exists (select 1 from pm_resource_links x where x.resource_id = r.id);
  if l.item_id is not null then perform pmx_log(l.project_id, l.item_id, 'document', 'Removed a linked document', '{}'); end if;
end;
$$;

/** Point an item at an Orders request or an Inventory item. Nothing in Orders or Inventory changes. */
create or replace function public.pm_add_ref(p_item uuid, p_kind text, p_ref uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  o pm_items;
  v_label text;
  v pm_refs;
begin
  select * into o from pm_items where id = p_item;
  if o.id is null then raise exception 'That item doesn''t exist.'; end if;
  perform pmx_need(o.project_id, 'view');
  if not pmx_may_edit(o) then perform pmx_need(o.project_id, 'edit'); end if;
  if p_kind = 'order' then
    select request_number || ' · ' || title into v_label from requests where id = p_ref;
    if v_label is null then raise exception 'That Orders request doesn''t exist.'; end if;
  elsif p_kind = 'inventory' then
    if not inv_can_view() then raise exception 'Your role can''t see Inventory, so you can''t link its items.' using errcode = '42501'; end if;
    select sku || ' · ' || name into v_label from inventory_items where id = p_ref;
    if v_label is null then raise exception 'That Inventory item doesn''t exist.'; end if;
  else
    raise exception 'Unknown kind of link.';
  end if;
  insert into pm_refs (item_id, project_id, kind, ref_id, label, note, created_by)
  values (p_item, o.project_id, p_kind, p_ref, left(v_label, 200), left(coalesce(p_note, ''), 300), auth.uid())
  on conflict (item_id, kind, ref_id) do update set note = excluded.note returning * into v;
  perform pmx_log(o.project_id, p_item, 'link', 'Linked ' || case p_kind when 'order' then 'the order ' else 'the inventory item ' end || v_label, '{}');
  return to_jsonb(v);
end;
$$;

create or replace function public.pm_remove_ref(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v pm_refs; o pm_items;
begin
  select * into v from pm_refs where id = p_id;
  if v.id is null then return; end if;
  select * into o from pm_items where id = v.item_id;
  if not pmx_may_edit(o) then perform pmx_need(o.project_id, 'edit'); end if;
  delete from pm_refs where id = p_id;
  perform pmx_log(o.project_id, o.id, 'link', 'Removed the link to ' || v.label, '{}');
end;
$$;

-- ---- automation: trigger → conditions → actions, all from checked lists (never code) ------------------
/** "{key}: {title}" with the item's own values. */
create or replace function public.pmx_fill(p_text text, p_item uuid)
returns text language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select replace(replace(replace(replace(replace(p_text, '{key}', i.key), '{title}', i.title),
      '{status}', coalesce((select name from pm_statuses where id = i.status_id), '')),
      '{owner}', coalesce((select coalesce(nullif(full_name, ''), email) from profiles where id = i.owner_id), 'nobody')),
      '{due}', coalesce(to_char(i.due_date, 'Mon DD'), 'no due date'))
    from pm_items i where i.id = p_item), p_text);
$$;

/** Who an action means: owner / reporter / lead / actor / none, or one person. */
create or replace function public.pmx_who(p_item uuid, p_project uuid, p text)
returns uuid language sql stable security definer set search_path = public, pg_temp
as $$
  select case p when 'owner' then (select owner_id from pm_items where id = p_item)
                when 'reporter' then (select reporter_id from pm_items where id = p_item)
                when 'lead' then (select lead_id from pm_projects where id = p_project)
                when 'actor' then auth.uid() when 'none' then null when 'watchers' then null else pmx_uuid(p) end;
$$;

/** Run a list of actions on an item (p_item null: a timed rule with no item, which can only create one). Returns what it did. */
create or replace function public.pmx_run_actions(p_item uuid, p_actions jsonb, p_source text)
returns text language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  return pmx_run_actions_in((select project_id from pm_items where id = p_item), p_item, p_actions, p_source);
end;
$$;

create or replace function public.pmx_run_actions_in(p_project uuid, p_item uuid, p_actions jsonb, p_source text)
returns text language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  a       jsonb;
  t       text;
  v_item  uuid := p_item;
  o       pm_items;
  n       pm_items;
  v_tr    pm_transitions;
  v_type  pm_types;
  v_st    pm_statuses;
  v_done  text[] := '{}';
  v_val   jsonb;
  v_seq   int;
  v_key   text;
  v_users uuid[];
  v_miss  text[];
begin
  for a in select * from jsonb_array_elements(coalesce(p_actions, '[]')) loop
    t := a ->> 'type';
    if v_item is null and t <> 'create_item' then continue; end if;
    select * into o from pm_items where id = v_item;
    if t = 'set_status' then
      if o.status_id = pmx_uuid(a ->> 'status') then continue; end if;
      select tr.* into v_tr from pm_transitions tr join pm_types ty on ty.workflow_id = tr.workflow_id
      where ty.id = o.type_id and tr.to_status = pmx_uuid(a ->> 'status') and (tr.from_status = o.status_id or tr.from_status is null)
      order by tr.from_status nulls last, tr.sort limit 1;
      if v_tr.id is null then
        raise exception 'the workflow has no move from "%" to "%"', (select name from pm_statuses where id = o.status_id), (select name from pm_statuses where id = pmx_uuid(a ->> 'status'));
      end if;
      v_miss := pmx_missing(o, v_tr.require_fields);
      if cardinality(v_miss) > 0 then raise exception 'the move "%" needs %', v_tr.name, pmx_field_names(o.project_id, v_miss); end if;
      v_tr.actions := '[]';   -- a rule's move doesn't set off the move's own follow-up actions (no chains)
      perform pmx_set_status(v_item, v_tr, null, 'automation');
      v_done := v_done || ('moved to "' || (select name from pm_statuses where id = v_tr.to_status) || '"');
    elsif t = 'assign' then
      perform pmx_update(v_item, null, jsonb_build_object('owner_id', pmx_who(v_item, p_project, a ->> 'user')), true);
      v_done := v_done || 'assigned'::text;
    elsif t = 'set_field' then
      v_val := a -> 'value';
      if jsonb_typeof(v_val) = 'object' and v_val ? 'days' then v_val := to_jsonb(to_char(current_date + (v_val ->> 'days')::int, 'YYYY-MM-DD')); end if;
      if a ->> 'field' like 'cf.%' then perform pmx_update(v_item, null, jsonb_build_object('custom', jsonb_build_object(substr(a ->> 'field', 4), v_val)), true);
      else perform pmx_update(v_item, null, jsonb_build_object(a ->> 'field', v_val), true);
      end if;
      v_done := v_done || ('set ' || (a ->> 'field'));
    elsif t = 'comment' then
      insert into pm_comments (item_id, project_id, author_id, body) values (v_item, o.project_id, null, left(pmx_fill(a ->> 'text', v_item), 10000));
      v_done := v_done || 'commented'::text;
    elsif t = 'add_label' then
      perform pmx_update(v_item, null, jsonb_build_object('labels', to_jsonb(o.labels || (a ->> 'label'))), true);
      v_done := v_done || ('labelled ' || (a ->> 'label'));
    elsif t = 'add_watcher' then
      insert into pm_people (item_id, user_id, kind, project_id)
      select v_item, pmx_who(v_item, p_project, a ->> 'user'), 'watch', o.project_id where pmx_who(v_item, p_project, a ->> 'user') is not null on conflict do nothing;
      v_done := v_done || 'added a watcher'::text;
    elsif t = 'notify' then
      v_users := case when a ->> 'to' = 'watchers' then pmx_audience(v_item) else array[pmx_who(v_item, p_project, a ->> 'to')] end;
      -- a rule's message also reaches the person whose action set it off
      insert into pm_notifications (user_id, project_id, item_id, kind, title, body, actor_name)
      select auth.uid(), o.project_id, v_item, 'automation', left(pmx_fill(a ->> 'message', v_item), 200), '', 'A rule' where auth.uid() = any(v_users);
      perform pmx_notify(v_users, 'automation', v_item, left(pmx_fill(a ->> 'message', v_item), 200), pmx_fill(a ->> 'message', v_item));
      v_done := v_done || 'notified'::text;
    elsif t = 'create_item' then
      select * into v_type from pm_types where id = pmx_uuid(a ->> 'type_id') and project_id = p_project and archived_at is null;
      if v_type.id is null then raise exception 'the work-item type to create no longer exists'; end if;
      select * into v_st from pm_statuses where workflow_id = v_type.workflow_id order by sort, name limit 1;
      update pm_projects set item_seq = item_seq + 1 where id = p_project returning item_seq, key into v_seq, v_key;
      n := jsonb_populate_record(null::pm_items, jsonb_build_object('priority', coalesce(a ->> 'priority', 'medium'), 'description', coalesce(a ->> 'description', ''),
        'vehicle', '', 'blocked', false, 'blocked_reason', '', 'acceptance', '', 'labels', '[]'::jsonb, 'progress', 0, 'custom', '{}'::jsonb, 'version', 1));
      n.id := gen_random_uuid(); n.project_id := p_project; n.type_id := v_type.id; n.seq := v_seq; n.key := v_key || '-' || v_seq;
      n.title := left(coalesce(pmx_fill(a ->> 'title', v_item), 'New item'), 200); n.status_id := v_st.id; n.category := v_st.category;
      n.reporter_id := coalesce(auth.uid(), (select lead_id from pm_projects where id = p_project)); n.created_by := auth.uid();
      n.owner_id := pmx_who(v_item, p_project, coalesce(a ->> 'owner', 'none'));
      n.due_date := case when a ? 'due_in_days' then current_date + (a ->> 'due_in_days')::int end;
      n.division_id := o.division_id; n.subsystem_id := o.subsystem_id;
      n.rank := (select coalesce(max(rank), 0) + 1000 from pm_items where project_id = p_project);
      n.created_at := now(); n.updated_at := now();
      -- under the item that set the rule off, when the project's hierarchy allows that
      if v_item is not null and coalesce(a ->> 'as', 'child') = 'child' then
        begin n.parent_id := v_item; n := pmx_check_item(n, null::pm_items);
        exception when others then n.parent_id := null; end;
      end if;
      n := pmx_check_item(n, null::pm_items);
      insert into pm_items select n.*;
      perform pmx_log(p_project, n.id, 'created', 'Created ' || n.key || ' (by a rule)', jsonb_build_object('title', n.title, 'how', 'automation'));
      if n.owner_id is not null then perform pmx_notify(array[n.owner_id], 'assigned', n.id, 'Assigned to you: ' || n.title, 'A rule created ' || n.key || ' "' || n.title || '" for you.'); end if;
      if v_item is null then v_item := n.id; end if;
      v_done := v_done || ('created ' || n.key);
    end if;
  end loop;
  return array_to_string(v_done, '; ');
end;
$$;

/**
 * Run one rule for one item if its conditions match. Each run is logged; a failure is logged and undone without
 * touching what the person was doing. p_dedupe makes "once per event / per day" hold however often this is called.
 */
create or replace function public.pmx_run_rule(r pm_automations, p_item uuid, p_dedupe text)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_detail text;
begin
  if p_item is not null and not pmx_matches(p_item, r.conditions) then return; end if;
  if p_dedupe is not null and exists (select 1 from pm_automation_runs where rule_id = r.id and dedupe = p_dedupe) then return; end if;
  if (select count(*) from pm_automation_runs where rule_id = r.id and created_at > now() - interval '1 minute') >= 60 then
    if not exists (select 1 from pm_automation_runs where rule_id = r.id and status = 'skipped' and created_at > now() - interval '1 minute') then
      insert into pm_automation_runs (rule_id, project_id, item_id, trigger, status, detail)
      values (r.id, r.project_id, p_item, r.trigger, 'skipped', 'Paused: this rule ran 60 times in a minute.');
    end if;
    return;
  end if;
  begin
    v_detail := pmx_run_actions_in(r.project_id, p_item, r.actions, 'rule');
    insert into pm_automation_runs (rule_id, project_id, item_id, trigger, status, detail, dedupe) values (r.id, r.project_id, p_item, r.trigger, 'ok', coalesce(v_detail, ''), p_dedupe);
    update pm_automations set last_run_at = now() where id = r.id;
  exception when others then
    insert into pm_automation_runs (rule_id, project_id, item_id, trigger, status, detail, dedupe)
    values (r.id, r.project_id, p_item, r.trigger, 'error', left(sqlerrm, 500), p_dedupe);
  end;
end;
$$;

/** Something happened to an item: run the project's rules for it. Rules can set each other off at most 3 deep. */
create or replace function public.pmx_fire(p_trigger text, p_item uuid, p_ctx jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_project uuid := (select project_id from pm_items where id = p_item);
  v_depth   int := coalesce(nullif(current_setting('pm.depth', true), ''), '0')::int;
  r         pm_automations;
  tc        jsonb;
begin
  if not exists (select 1 from pm_automations where project_id = v_project and enabled and trigger = p_trigger) then return; end if;
  if v_depth >= 3 then
    insert into pm_automation_runs (rule_id, project_id, item_id, trigger, status, detail)
    select id, project_id, p_item, p_trigger, 'skipped', 'Stopped: rules were setting each other off (3 deep).'
    from pm_automations where project_id = v_project and enabled and trigger = p_trigger limit 1;
    return;
  end if;
  perform set_config('pm.depth', (v_depth + 1)::text, true);
  for r in select * from pm_automations where project_id = v_project and enabled and trigger = p_trigger order by created_at, id loop
    tc := r.trigger_config;
    if p_trigger = 'status' and ((coalesce(tc ->> 'to', '') <> '' and tc ->> 'to' is distinct from p_ctx ->> 'to')
                              or (coalesce(tc ->> 'from', '') <> '' and tc ->> 'from' is distinct from p_ctx ->> 'from')) then continue; end if;
    if p_trigger = 'updated' and coalesce(tc ->> 'field', '') <> '' and not coalesce(p_ctx -> 'changed' ? (tc ->> 'field'), false) then continue; end if;
    perform pmx_run_rule(r, p_item, case when p_ctx ? 'event' then 'e' || (p_ctx ->> 'event') end);
  end loop;
  perform set_config('pm.depth', v_depth::text, true);
end;
$$;

/** p: { name, enabled, trigger, trigger_config, conditions, actions, version } */
create or replace function public.pm_save_automation(p_project uuid, p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare o pm_automations; v pm_automations;
begin
  perform pmx_need(p_project, 'automations');
  if p_id is not null then
    select * into o from pm_automations where id = p_id and project_id = p_project for update;
    if o.id is null then raise exception 'That rule doesn''t exist.'; end if;
    if p ? 'version' and (p ->> 'version')::int <> o.version then raise exception 'Someone else changed this rule. Reload and try again.' using errcode = 'OS409'; end if;
  end if;
  if trim(coalesce(p ->> 'name', o.name, '')) = '' then raise exception 'Give the rule a name.'; end if;
  if coalesce(p ->> 'trigger', o.trigger) not in ('created', 'updated', 'status', 'assigned', 'comment', 'dependency_done', 'milestone', 'due_soon', 'overdue', 'schedule') then
    raise exception 'Pick when the rule runs.';
  end if;
  perform pmx_where(nullif(p -> 'conditions', 'null'));
  if p ? 'actions' or p_id is null then
    perform pmx_check_actions(p_project, coalesce(nullif(p -> 'actions', 'null'), '[]'));
    if jsonb_array_length(coalesce(nullif(p -> 'actions', 'null'), '[]')) = 0 then raise exception 'A rule needs at least one action.'; end if;
  end if;
  if p_id is null then
    insert into pm_automations (project_id, name, enabled, trigger, trigger_config, conditions, actions, created_by)
    values (p_project, trim(p ->> 'name'), pmx_bool(p, 'enabled', true), p ->> 'trigger', coalesce(nullif(p -> 'trigger_config', 'null'), '{}'),
      nullif(p -> 'conditions', 'null'), p -> 'actions', auth.uid()) returning * into v;
  else
    update pm_automations set name = coalesce(nullif(trim(p ->> 'name'), ''), name), enabled = pmx_bool(p, 'enabled', enabled), trigger = coalesce(p ->> 'trigger', trigger),
      trigger_config = case when p ? 'trigger_config' then coalesce(nullif(p -> 'trigger_config', 'null'), '{}') else trigger_config end,
      conditions = case when p ? 'conditions' then nullif(p -> 'conditions', 'null') else conditions end,
      actions = case when p ? 'actions' then p -> 'actions' else actions end, version = version + 1, updated_at = now()
    where id = p_id returning * into v;
  end if;
  perform pmx_log(p_project, null, 'config', 'Saved the rule "' || v.name || '"' || case when v.enabled then '' else ' (off)' end, '{}');
  return to_jsonb(v);
end;
$$;

create or replace function public.pm_delete_automation(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare o pm_automations;
begin
  select * into o from pm_automations where id = p_id;
  if o.id is null then return; end if;
  perform pmx_need(o.project_id, 'automations');
  delete from pm_automations where id = p_id;
  perform pmx_log(o.project_id, null, 'config', 'Deleted the rule "' || o.name || '"', '{}');
end;
$$;

/** Try a rule without running it: which items match its conditions right now. p: { trigger, trigger_config, conditions, actions } */
create or replace function public.pm_test_automation(p_project uuid, p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_where text;
  v_n     int;
  v_rows  jsonb;
begin
  perform pmx_need(p_project, 'automations');
  perform pmx_check_actions(p_project, coalesce(nullif(p -> 'actions', 'null'), '[]'));
  v_where := pmx_where(nullif(p -> 'conditions', 'null')) || case p ->> 'trigger'
    when 'due_soon' then format(' and i.category <> ''done'' and i.due_date between current_date and current_date + %s', coalesce(pmx_num(p -> 'trigger_config' ->> 'days'), 2)::int)
    when 'overdue' then ' and i.category <> ''done'' and i.due_date < current_date' else '' end;
  execute format('select count(*) from pm_items i where i.project_id = $1 and i.archived_at is null and %s', v_where) into v_n using p_project;
  execute format('select coalesce(jsonb_agg(jsonb_build_object(''key'', q.key, ''title'', q.title)), ''[]'') from (select i.key, i.title from pm_items i
    where i.project_id = $1 and i.archived_at is null and %s order by i.seq desc limit 20) q', v_where) into v_rows using p_project;
  return jsonb_build_object('matches', v_n, 'sample', v_rows);
end;
$$;

/**
 * The timed work: reminders for items due tomorrow or overdue, and the "due soon", "overdue" and "recurring"
 * rules. Safe to call as often as you like: it does its work at most every 30 minutes, and each reminder and
 * each rule runs once per item per date. Projects calls it when someone opens the app; a scheduled job can
 * call it too (supabase/ops/cron_projects.sql), so it doesn't depend on anyone being signed in.
 */
create or replace function public.pm_run_scheduled()
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r    pm_automations;
  i    pm_items;
  tc   jsonb;
  v_n  int := 0;
  v_due boolean;
begin
  if auth.uid() is not null and not pm_can_open() then return jsonb_build_object('ran', false); end if;
  update pm_schedule_state set last_run = now() where one and (last_run is null or last_run < now() - interval '30 minutes');
  if not found then return jsonb_build_object('ran', false); end if;
  perform set_config('pm.system', '1', true);
  -- reminders everyone gets without setting anything up
  for i in select it.* from pm_items it join pm_projects p on p.id = it.project_id
           where it.archived_at is null and p.archived_at is null and it.category <> 'done' and it.owner_id is not null and it.due_date <= current_date + 1
             and not exists (select 1 from pm_notifications n where n.item_id = it.id and n.user_id = it.owner_id and n.kind = 'due' and n.created_at > now() - interval '6 days')
           limit 500 loop
    perform pmx_notify(array[i.owner_id], 'due', i.id,
      case when i.due_date < current_date then 'Overdue: ' when i.due_date = current_date then 'Due today: ' else 'Due tomorrow: ' end || i.title,
      i.key || ' "' || i.title || '" ' || case when i.due_date < current_date then 'was due ' || to_char(i.due_date, 'Mon DD') else 'is due ' || to_char(i.due_date, 'Mon DD') end || '.');
    v_n := v_n + 1;
  end loop;
  for r in select a.* from pm_automations a join pm_projects p on p.id = a.project_id
           where a.enabled and p.archived_at is null and a.trigger in ('due_soon', 'overdue', 'schedule') loop
    tc := r.trigger_config;
    if r.trigger = 'schedule' then
      v_due := case coalesce(tc ->> 'every', 'week')
           when 'day' then true
           when 'week' then extract(dow from current_date)::int = coalesce(pmx_num(tc ->> 'weekday'), 1)::int
           when 'month' then extract(day from current_date)::int = coalesce(pmx_num(tc ->> 'day'), 1)::int
           else false end;
      if v_due then
        perform pmx_run_rule(r, null, 'sch:' || current_date);
        v_n := v_n + 1;
      end if;
    else
      for i in select it.* from pm_items it where it.project_id = r.project_id and it.archived_at is null and it.category <> 'done'
                 and case when r.trigger = 'overdue' then it.due_date < current_date
                          else it.due_date between current_date and current_date + coalesce(pmx_num(tc ->> 'days'), 2)::int end
               limit 500 loop
        perform pmx_run_rule(r, i.id, r.trigger || ':' || i.id || ':' || i.due_date);
        v_n := v_n + 1;
      end loop;
    end if;
  end loop;
  perform set_config('pm.system', '', true);
  return jsonb_build_object('ran', true, 'checked', v_n);
end;
$$;

-- ---- planning: sprints, baselines, what-if scenarios, rescheduling, calendar events ---------------------
/** p: { name, goal, start_date, end_date, status, move_to }: closing moves unfinished items to move_to (or the backlog). */
create or replace function public.pm_save_sprint(p_project uuid, p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare o pm_sprints; v pm_sprints; v_to uuid := pmx_uuid(p ->> 'move_to');
begin
  perform pmx_need(p_project, 'plan');
  if p_id is null then
    if trim(coalesce(p ->> 'name', '')) = '' then raise exception 'Give the sprint a name.'; end if;
    insert into pm_sprints (project_id, name, goal, start_date, end_date)
    values (p_project, trim(p ->> 'name'), coalesce(p ->> 'goal', ''), nullif(p ->> 'start_date', '')::date, nullif(p ->> 'end_date', '')::date) returning * into v;
    return to_jsonb(v);
  end if;
  select * into o from pm_sprints where id = p_id and project_id = p_project for update;
  if o.id is null then raise exception 'That sprint doesn''t exist.'; end if;
  if p ? 'delete' then
    if o.status <> 'planned' then raise exception 'Only a sprint that hasn''t started can be deleted.'; end if;
    delete from pm_sprints where id = p_id;
    return null;
  end if;
  if o.status = 'closed' then raise exception 'That sprint is closed.'; end if;
  if p ->> 'status' = 'active' and o.status = 'planned' and exists (select 1 from pm_sprints where project_id = p_project and status = 'active') then
    raise exception 'Another sprint is still running. Close it first.';
  end if;
  if p ->> 'status' = 'closed' then
    if v_to is not null and not exists (select 1 from pm_sprints where id = v_to and project_id = p_project and status <> 'closed') then raise exception 'Pick an open sprint to move unfinished work to.'; end if;
    update pm_sprints set status = 'closed', closed_at = now(), summary = jsonb_build_object(
      'done', (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'title', title, 'estimate', estimate_hours)), '[]') from pm_items where sprint_id = p_id and category = 'done'),
      'carried', (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'title', title, 'estimate', estimate_hours)), '[]') from pm_items where sprint_id = p_id and category <> 'done'))
    where id = p_id returning * into v;
    update pm_items set sprint_id = v_to, version = version + 1, updated_at = now() where sprint_id = p_id and category <> 'done';
    perform pmx_log(p_project, null, 'sprint', 'Closed the sprint "' || v.name || '"', v.summary);
    return to_jsonb(v);
  end if;
  update pm_sprints set name = coalesce(nullif(trim(p ->> 'name'), ''), name), goal = coalesce(p ->> 'goal', goal),
    start_date = case when p ? 'start_date' then nullif(p ->> 'start_date', '')::date else start_date end,
    end_date = case when p ? 'end_date' then nullif(p ->> 'end_date', '')::date else end_date end,
    status = case when p ->> 'status' in ('planned', 'active') then p ->> 'status' else status end
  where id = p_id returning * into v;
  return to_jsonb(v);
end;
$$;

/** Remember today's target dates as a baseline to compare against later. */
create or replace function public.pm_save_baseline(p_project uuid, p_name text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v pm_baselines;
begin
  perform pmx_need(p_project, 'plan');
  if trim(coalesce(p_name, '')) = '' then raise exception 'Give the baseline a name.'; end if;
  insert into pm_baselines (project_id, name, snapshot, created_by)
  values (p_project, trim(p_name), coalesce((select jsonb_object_agg(id, jsonb_build_object('start', start_date, 'due', due_date))
    from pm_items where project_id = p_project and archived_at is null and (start_date is not null or due_date is not null)), '{}'), auth.uid())
  returning * into v;
  perform pmx_log(p_project, null, 'plan', 'Saved the baseline "' || v.name || '"', '{}');
  return to_jsonb(v) - 'snapshot';
end;
$$;

create or replace function public.pm_delete_baseline(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare o pm_baselines;
begin
  select * into o from pm_baselines where id = p_id;
  if o.id is null then return; end if;
  perform pmx_need(o.project_id, 'plan');
  delete from pm_baselines where id = p_id;
end;
$$;

/** Keep a what-if (dates tried out on the timeline, not live). p: { name, changes: { "<item>": { start, due } } }; p null deletes. */
create or replace function public.pm_save_scenario(p_project uuid, p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v pm_scenarios;
begin
  perform pmx_need(p_project, 'plan');
  if p is null then
    delete from pm_scenarios where id = p_id and project_id = p_project;
    return null;
  end if;
  if jsonb_typeof(p -> 'changes') <> 'object' or octet_length((p -> 'changes')::text) > 500000 then raise exception 'That scenario isn''t valid.'; end if;
  if trim(coalesce(p ->> 'name', '')) = '' then raise exception 'Give the scenario a name.'; end if;
  if p_id is null then
    insert into pm_scenarios (project_id, name, changes, created_by) values (p_project, trim(p ->> 'name'), p -> 'changes', auth.uid()) returning * into v;
  else
    update pm_scenarios set name = trim(p ->> 'name'), changes = p -> 'changes' where id = p_id and project_id = p_project returning * into v;
  end if;
  return to_jsonb(v);
end;
$$;

/**
 * Change the target dates of several items in one go: the explicit "reschedule" step (dates never move on their
 * own). p_changes: { "<item id>": { start, due } } for items of this project. All or nothing, one history entry
 * per item plus one for the project.
 */
create or replace function public.pm_reschedule(p_project uuid, p_changes jsonb, p_note text, p_scenario uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare k text; v jsonb; v_n int := 0;
begin
  perform pmx_need(p_project, 'plan');
  if jsonb_typeof(p_changes) <> 'object' then raise exception 'Nothing to reschedule.'; end if;
  if (select count(*) from jsonb_object_keys(p_changes)) > 1000 then raise exception 'Reschedule up to 1000 items at a time.'; end if;
  perform set_config('pm.quiet', '1', true);
  for k, v in select * from jsonb_each(p_changes) loop
    if not exists (select 1 from pm_items where id = pmx_uuid(k) and project_id = p_project) then raise exception 'One of those items isn''t in this project.'; end if;
    perform pmx_update(pmx_uuid(k), null, jsonb_build_object('start_date', v -> 'start', 'due_date', v -> 'due'), true);
    v_n := v_n + 1;
  end loop;
  perform set_config('pm.quiet', '', true);
  if p_scenario is not null then update pm_scenarios set applied_at = now() where id = p_scenario and project_id = p_project; end if;
  perform pmx_log(p_project, null, 'plan', 'Rescheduled ' || v_n || ' item(s)' || case when trim(coalesce(p_note, '')) <> '' then ': ' || p_note else '' end,
    jsonb_build_object('items', v_n, 'scenario', p_scenario));
  return jsonb_build_object('changed', v_n);
end;
$$;

/** A project event on the calendar. p: { title, starts_on, ends_on, repeat, repeat_until, notes }; p null deletes. */
create or replace function public.pm_save_event(p_project uuid, p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v pm_calendar_events;
begin
  perform pmx_need(p_project, 'plan');
  if p is null then
    delete from pm_calendar_events where id = p_id and project_id = p_project;
    return null;
  end if;
  if trim(coalesce(p ->> 'title', '')) = '' or coalesce(p ->> 'starts_on', '') = '' then raise exception 'An event needs a title and a date.'; end if;
  if p_id is null then
    insert into pm_calendar_events (project_id, title, starts_on, ends_on, repeat, repeat_until, notes, created_by)
    values (p_project, trim(p ->> 'title'), (p ->> 'starts_on')::date, nullif(p ->> 'ends_on', '')::date, coalesce(nullif(p ->> 'repeat', ''), 'none'),
      nullif(p ->> 'repeat_until', '')::date, coalesce(p ->> 'notes', ''), auth.uid()) returning * into v;
  else
    update pm_calendar_events set title = trim(p ->> 'title'), starts_on = (p ->> 'starts_on')::date, ends_on = nullif(p ->> 'ends_on', '')::date,
      repeat = coalesce(nullif(p ->> 'repeat', ''), 'none'), repeat_until = nullif(p ->> 'repeat_until', '')::date, notes = coalesce(p ->> 'notes', '')
    where id = p_id and project_id = p_project returning * into v;
  end if;
  return to_jsonb(v);
end;
$$;

-- ---- saved views, boards and dashboards --------------------------------------------------------------
/**
 * p: { project_id, kind, name, sharing: private | project | team | people, shared_with, config, is_default, version }
 * Yours alone: any time. Shared with a project: needs "Shared boards and views" there. Shared with the whole
 * team across projects: needs "Create projects". Whatever a view's filter says, each person still only gets the
 * items of projects they can see.
 */
create or replace function public.pm_save_view(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  o         pm_views;
  v         pm_views;
  v_project uuid := pmx_uuid(p ->> 'project_id');
  v_sharing text := coalesce(p ->> 'sharing', 'private');
begin
  perform pmx_open();
  if p_id is not null then
    select * into o from pm_views where id = p_id for update;
    if o.id is null then raise exception 'That view doesn''t exist.'; end if;
    v_project := o.project_id;
    if not p ? 'sharing' then v_sharing := o.sharing; end if;
    if o.owner_id is distinct from auth.uid() then
      if o.sharing = 'project' then perform pmx_need(o.project_id, 'boards');
      elsif not has_permission('projects.manage') then raise exception 'Only its owner can change this view.' using errcode = '42501';
      end if;
    end if;
    if p ? 'version' and (p ->> 'version')::int <> o.version then raise exception 'Someone else changed this view. Reload and try again.' using errcode = 'OS409'; end if;
  end if;
  if v_sharing not in ('private', 'project', 'team', 'people') then raise exception 'Unknown way of sharing.'; end if;
  if v_project is not null then perform pmx_need(v_project, 'view'); end if;
  if v_sharing = 'project' then
    if v_project is null then raise exception 'Only a project''s view can be shared with the project.'; end if;
    perform pmx_need(v_project, 'boards');
  elsif v_sharing = 'team' then
    if v_project is not null then perform pmx_need(v_project, 'boards');
    elsif not (has_permission('projects.create') or has_permission('projects.manage')) then
      raise exception 'Sharing a view with the whole team needs "Create projects".' using errcode = '42501';
    end if;
  end if;
  if p ? 'config' then
    if jsonb_typeof(p -> 'config') <> 'object' or octet_length((p -> 'config')::text) > 100000 then raise exception 'That view isn''t valid.'; end if;
    perform pmx_where(nullif(p -> 'config' -> 'filter', 'null'));
  end if;
  if trim(coalesce(p ->> 'name', o.name, '')) = '' then raise exception 'Give the view a name.'; end if;
  if p_id is null then
    if coalesce(p ->> 'kind', '') not in ('list', 'board', 'timeline', 'calendar', 'dashboard') then raise exception 'Unknown kind of view.'; end if;
    insert into pm_views (owner_id, project_id, kind, name, sharing, shared_with, config, is_default)
    values (auth.uid(), v_project, p ->> 'kind', trim(p ->> 'name'), v_sharing, array(select x from unnest(pmx_uuids(p -> 'shared_with')) x where is_member(x)),
      coalesce(p -> 'config', '{}'), pmx_bool(p, 'is_default', false)) returning * into v;
  else
    update pm_views set name = coalesce(nullif(trim(p ->> 'name'), ''), name), sharing = v_sharing,
      shared_with = case when p ? 'shared_with' then array(select x from unnest(pmx_uuids(p -> 'shared_with')) x where is_member(x)) else shared_with end,
      config = coalesce(p -> 'config', config), is_default = pmx_bool(p, 'is_default', is_default), version = version + 1, updated_at = now()
    where id = p_id returning * into v;
  end if;
  if v.is_default then
    update pm_views set is_default = false where id <> v.id and kind = v.kind and project_id is not distinct from v.project_id
      and (sharing = v.sharing) and (v.sharing <> 'private' or owner_id = v.owner_id);
  end if;
  return to_jsonb(v);
end;
$$;

create or replace function public.pm_delete_view(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare o pm_views;
begin
  select * into o from pm_views where id = p_id;
  if o.id is null then return; end if;
  perform pmx_open();
  if o.owner_id is distinct from auth.uid() then
    if o.sharing = 'project' then perform pmx_need(o.project_id, 'boards');
    elsif not has_permission('projects.manage') then raise exception 'Only its owner can delete this view.' using errcode = '42501';
    end if;
  end if;
  delete from pm_views where id = p_id;
end;
$$;

-- ---- the inbox and personal settings -----------------------------------------------------------------
/** Mark notifications read (p_ids null: all of mine). */
create or replace function public.pm_mark_read(p_ids bigint[])
returns void language sql security definer set search_path = public, pg_temp
as $$
  update pm_notifications set read_at = now() where user_id = auth.uid() and read_at is null and (p_ids is null or id = any(p_ids));
$$;

/** p: { notify: { "<kind>": { inapp, email } }, hours_per_week } */
create or replace function public.pm_save_prefs(p jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform pmx_open();
  if p ? 'notify' and (jsonb_typeof(p -> 'notify') <> 'object' or octet_length((p -> 'notify')::text) > 4000) then raise exception 'Those notification choices aren''t valid.'; end if;
  insert into pm_prefs (user_id, notify, hours_per_week)
  values (auth.uid(), coalesce(p -> 'notify', '{}'), pmx_num(p ->> 'hours_per_week'))
  on conflict (user_id) do update set notify = case when p ? 'notify' then excluded.notify else pm_prefs.notify end,
    hours_per_week = case when p ? 'hours_per_week' then excluded.hours_per_week else pm_prefs.hours_per_week end, updated_at = now();
end;
$$;

-- ---- reading: what I can do, and the numbers for dashboards ----------------------------------------------
/** { "<project id>": ["view", "create", …] } for every project I can see. */
create or replace function public.pm_my_caps()
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(x, to_jsonb(pmx_caps_for(x, auth.uid()))), '{}'::jsonb) from unnest(pm_visible()) x;
$$;

/**
 * Counts for dashboards, by project × CE division × subsystem, over the projects I can see (so a leadership
 * dashboard never counts work its reader isn't allowed to see). est_* are estimated hours; ms_* are milestones.
 * trend: items finished per week for the last 12 weeks.
 */
create or replace function public.pm_rollup()
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  with vis as (select p.id from pm_projects p where p.id = any(pm_visible()) and p.archived_at is null and pm_can_open()),
  it as (select i.*, t.is_milestone from pm_items i join pm_types t on t.id = i.type_id where i.project_id in (select id from vis) and i.archived_at is null)
  select jsonb_build_object(
    'groups', coalesce((select jsonb_agg(g) from (
      select project_id, division_id, subsystem_id, count(*) as total,
        count(*) filter (where category = 'todo') as todo, count(*) filter (where category = 'doing') as doing, count(*) filter (where category = 'done') as done,
        count(*) filter (where category <> 'done' and due_date < current_date) as overdue,
        count(*) filter (where blocked and category <> 'done') as blocked,
        count(*) filter (where owner_id is null and category <> 'done') as unassigned,
        coalesce(sum(estimate_hours), 0) as est_total, coalesce(sum(estimate_hours) filter (where category = 'done'), 0) as est_done,
        count(*) filter (where estimate_hours is null) as est_missing,
        count(*) filter (where is_milestone) as ms_total, count(*) filter (where is_milestone and category = 'done') as ms_done,
        count(*) filter (where is_milestone and category <> 'done' and due_date < current_date) as ms_late,
        min(due_date) filter (where is_milestone and category <> 'done') as next_ms
      from it group by project_id, division_id, subsystem_id) g), '[]'::jsonb),
    'trend', coalesce((select jsonb_agg(w) from (
      select project_id, to_char(date_trunc('week', completed_at), 'YYYY-MM-DD') as week, count(*) as done
      from it where completed_at > now() - interval '12 weeks' group by 1, 2 order by 2) w), '[]'::jsonb));
$$;

-- ---- starting templates ---------------------------------------------------------------------------
insert into public.pm_templates (name, description, config)
select v.name, v.description, v.config from (values
  ('Simple board', 'To Do → In Progress → In Review → Done, any order. Epics, tasks, subtasks, milestones and bugs. A good start for most projects.',
   public.pmx_default_config()),
  ('Engineering design', 'Draft → In Design → In Review → Approved → Released, one step at a time; "Approved" needs someone who may approve. Design tasks, analyses, design reviews and tests with engineering fields.',
   public.pmx_make_config(
     '[["Draft", "todo", "gray"], ["In Design", "doing", "blue"], ["In Review", "doing", "purple"], ["Approved", "doing", "teal"], ["Released", "done", "green"]]',
     '[["Epic", "◆", "purple", 0, false], ["Design Task", "✎", "blue", 1, false], ["Analysis", "∑", "teal", 1, false], ["Design Review", "☑", "orange", 1, false], ["Test", "⚗", "red", 1, false], ["Milestone", "⚑", "orange", 1, true], ["Subtask", "↳", "gray", 2, false]]',
     '[["requirement", "Requirement", "longtext"], ["analysis_type", "Analysis type", "select", ["Hand calculation", "FEA", "CFD", "Simulation", "Test data"]], ["review_date", "Review date", "date"], ["test_procedure", "Test procedure", "longtext"], ["measured_result", "Measured result", "text"], ["outcome", "Outcome", "select", ["Pass", "Fail", "Retest"]]]',
     'Approved', false)),
  ('Manufacturing', 'Planned → Material Ready → In Manufacturing → Inspection → Complete, one step at a time. Manufacturing jobs and inspections with drawing, material, process and equipment fields.',
   public.pmx_make_config(
     '[["Planned", "todo", "gray"], ["Material Ready", "todo", "amber"], ["In Manufacturing", "doing", "blue"], ["Inspection", "doing", "purple"], ["Complete", "done", "green"]]',
     '[["Epic", "◆", "purple", 0, false], ["Manufacturing Job", "⚙", "blue", 1, false], ["Inspection", "☑", "orange", 1, false], ["Milestone", "⚑", "orange", 1, true], ["Subtask", "↳", "gray", 2, false]]',
     '[["drawing_ref", "Drawing", "url"], ["material", "Material", "text"], ["process", "Process", "select", ["Layup", "Machining", "Welding", "3D printing", "Wiring", "Assembly", "Other"]], ["equipment", "Equipment needed", "text"], ["inspection_req", "Inspection requirements", "longtext"]]',
     null, false))
  ) v(name, description, config);

-- ---- what the website may call --------------------------------------------------------------------
-- Everything starting with pmx_ is internal; pm_… are the functions the pages call.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'pm\_%' or p.proname like 'pmx\_%') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    if f.proname like 'pm\_%' then execute format('grant execute on function %s to authenticated', f.sig); end if;
  end loop;
end;
$$;

select public.migration_done(51, '051_projects.sql');
