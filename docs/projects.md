# Projects

Plan and track the team's work: projects, work items, boards, backlogs, timelines with dependencies, calendars,
dashboards, linked documents and rules. Address: **`/projects/`**. Needs the database update
[`supabase/migrations/051_projects.sql`](../supabase/migrations/051_projects.sql); until it's applied, every page
says "Projects isn't set up yet" and nothing else changes.

How a project works is **configuration, edited in the pages**: its kinds of work, its workflow, its fields, its
forms, its boards, its roles and its rules. Nothing about a particular project is in the code, so a project manager
can set up a completely new kind of project without a developer.

## Using it

| Page | What it's for |
| --- | --- |
| **My work** | What's on your plate: overdue, blocked (and why), due soon, in progress, up next; what's waiting for your approval; a menu on each item to move it along. "Copy what I finished" gives a plain list for a self-evaluation or report. |
| **Projects** | Every project you can see, by program, with how each is doing. **New project** starts from a template. |
| **A project → Summary** | Progress three ways (each says how it's worked out), what's coming up, people, latest changes. |
| **List** | A searchable, sortable table, a page at a time. Choose columns (custom fields too), filter, save it as a view, change several items at once, download a CSV. |
| **Board** | A kanban. Columns are a saved mapping of statuses (several statuses can share a column, each column can have a limit), swimlanes group the cards. Drag a card, or use its **Move** menu. |
| **Backlog** | Unfinished work in priority order: drag (or arrows / "Move to…") to reorder, estimate and assign in place. Sprints are optional. |
| **Timeline** | A Gantt chart like the team's roadmap slides: drag to plan (with Undo), click for details, draw dependencies, present or export. The forecast, baseline, critical path and what-ifs are under Plan. |
| **Calendar** | Deadlines, milestones, starts and project events, by month, week or agenda. Drag a deadline to another day. |
| **Documents** | The project's linked documents (Teams / SharePoint / OneDrive / GitHub / CAD…). |
| **Settings** | Details, People & roles, Work types, Workflows, Fields, Forms, Rules, Templates. |
| **Boards / Timeline / Calendar** (top menu) | The same views across every project you can see. |
| **Dashboards** | A board of widgets you can add, remove, reorder and save (for yourself, or shared with the team); **Workload**; **Weekly review**. |
| **Templates** | Reusable project set-ups: make a project from one, save a project as one, apply one to a running project, export / import. |
| **Inbox** | Notices about items you own, collaborate on or watch, and your choices about what you're told. |

### An item

Title, kind, status, priority, owner (the one accountable person), collaborators, reporter, watchers, CE division and
subsystem, start and due dates, estimate, progress, what "done" means, a checklist, items under it, dependencies,
linked documents, links to Orders requests and Inventory items, comments with `@First Last` mentions, and its full
history. Every item has a readable name (`BAT-24`) that never changes unless it moves to another project (then its
old name still opens it).

**Finished and accepted are two things.** An item is finished when its status is in the *Done* category. Someone
whose role may approve can then **review and accept** it; reopening it clears both.

**Descriptions and comments** use a small safe formatting: `**bold**`, `- lists`, `# headings`,
`[text](https://link)`. Everything typed is escaped first; nothing typed is ever run.

### Working fast (the same everywhere)

- **Change things where they show.** Click a status, owner, due or start date, priority, estimate or progress (in
  List, on a Board card, in the Backlog, in My work, on an item's page, in the Timeline's panel), pick, and it's
  saved. The page shows the new value at once; the save happens behind it. A notice offers **Undo**. If the change
  is refused, the old value comes back and the notice says why in plain words. Status is a workflow move, so a move
  that needs fields, a comment or an approval still asks first. On an item's page the **title** renames in place
  (click it) and **What's expected** has its own **Edit**.
- **The same pickers everywhere.** Type to filter; you come first in the people list, then the people you picked
  lately; dates have one-click choices (today, tomorrow, Friday, next Monday, in a week, in two weeks) or any day.
- **Add with just a title.** "+ Add…" at the bottom of a list, a board column, a sprint, the backlog, the timeline,
  an item's "Items under this one", and at the top of My work (pick the project). Enter adds it; where you typed
  decides the rest (that column's status, that sprint, that parent). **Shift+Enter** or **More…** opens the full
  form with the title in it. Undo takes it away (it's archived).
- **Sensible starting values.** A new item is yours (owner: you) and in the project's subsystem, or yours from
  People (Admin → Divisions & people) when the project has none. Change either right away.
- **Several at once.** Tick the box on rows or cards (Shift-click ticks a range; X ticks the one under the mouse)
  in List, Board, Backlog, Timeline or My work. A bar at the bottom changes their status, owner, due date, priority,
  more (start date, labels, sprint) or archives them. Anything that couldn't change is named, with why. Esc clears.
- **Ctrl+K** (⌘K on a Mac) jumps to any project, item (by name or `BAT-12`) or page, or starts a new item. Items you
  opened lately are listed first.
- **Keyboard shortcuts** (press **?** for the list): **C** new item, **/** search, **J / K** next / previous row,
  **Enter** open; on the row under the mouse **S** status, **A** owner, **D** due date, **P** priority, **E**
  estimate; **G** then **M**y work, **P**rojects, **I**nbox, **B**oards, **T**imeline, **C**alendar, a**L**l work,
  **D**ashboards. They don't fire while you're typing.
- **You always see what's happening:** a thin bar at the top while a page loads, a spinner on a value while it saves,
  and a notice when it's done (or why it wasn't).

### Who can do what

Two layers:

1. **one.solar permissions** (Admin → Roles & permissions): `projects.view` *See projects* (every team role),
   `projects.create` *Create projects* (Chief Engineers, E-board, Admins), `projects.manage` *Manage all projects*
   (Admins: everything in every project, including private ones). Without *See projects* a person sees nothing,
   whatever project role they have.
2. **A role in each project** (Settings → People & roles). A new project has Project Administrator, Project
   Manager, Contributor, Approver and Viewer; each is a list of what it may do (see the project, comment, create
   items, edit items, assign people, move items between statuses, approve, archive, plan and schedule, shared
   boards and views, automation rules, project settings / types / fields, workflows, members and roles). Change
   them or make your own.

A project the whole team can see gives everyone a role without being added (Viewer to start with; change it in
Settings → Details). A **private** project is only for the people added to it. Nobody can hand out, or put on a role,
something their own role can't do; whoever creates a project is its Project Administrator.

The database checks every change and every read: hiding a button is never the protection.

## Setting a project up (no code)

**Work types** (Settings → Work types): name, icon, color, level (0 is the top, an epic), which types it can go
under, its workflow, whether it's a milestone, and what new items of that type start with.

**Workflows** (Settings → Workflows): a drawing of the statuses with arrows for the allowed moves, a table of
statuses (name, category *To do / In progress / Done*, color, order) and of moves. Each move can be limited to some
project roles, require fields, require a comment, need approval (optionally not the owner's own), have a condition,
and do things straight afterwards. Saving shows a preview first. A status that still has items in it can only be
removed by saying which status those items become; each moved item gets a line in its history. Every saved version
is kept, and an earlier one can be loaded back into the editor and saved as a new version. Different work types can
use different workflows; moving a type to another workflow asks what each status in use becomes.

Statuses only ever change through a move. The board, the list, My work and the item page all make the same call, so
a move the workflow doesn't have, or that the person's role may not make, is refused everywhere, including for
someone calling the database directly.

**Fields** (Settings → Fields): short / long / formatted text, whole number, number, date, date and time, checkbox,
dropdown (one or several choices), person, people, link, tags, duration, money, and calculated. Each has help text, a
starting value, limits (minimum, maximum, length, pattern), and can be limited to some work types. Values are checked
by the database, kind by kind. Every field can be a list column, a filter, a board swimlane or card detail, and
required on a form or a move.

**Calculated fields** use a small arithmetic language: numbers, text in quotes, field keys, `+ - * / %`,
comparisons, `and or not`, `a ? b : c`, and `min max round abs ceil floor if coalesce days_between today len`. It
is worked out in the page by its own parser (never `eval`, never SQL), shown on the item and in lists, and not stored,
so a calculated field can't be filtered on.

**Forms** (Settings → Forms): for each work type (or the whole project) and each of *creating*, *editing*, *the
item's page* and *making a particular move*: which fields, in which sections and order, and which are required, with a
live preview. A type without its own form uses the project's; without that, the standard one.

**Boards and views**: on any List, Board or Dashboard, "Save as…" keeps the current filter, columns and layout:
just for you, for everyone in the project (needs *Shared boards and views*), for the whole team (cross-project;
needs *Create projects*), or for people you pick. A shared view never shows anyone an item they couldn't otherwise
see.

**Filters** are built from conditions (field, comparison, value) joined by *all of* / *any of*, with groups. They are
a checked model that the database turns into its own query; no text from a filter is ever run as SQL.

**Rules** (Settings → Rules): *when* (an item is created, changed, changes status, gets a new owner, is commented on,
everything it was waiting on is finished, a milestone is reached, is due soon, is overdue, or on a schedule) → *if*
(conditions) → *then* (send a notice, comment, move it to a status, assign, set a field, add a label, add a watcher,
create an item). "Try it" shows which items match without doing anything. Every run is logged with its result. A rule
that fails is logged and never stops what the person was doing; rules can set each other off at most three deep; a
rule that runs 60 times in a minute is paused; a timed rule runs once per item per date.

**Templates** (top menu, and Settings → Templates): the whole set-up as one checked document. *New project* starts
from one. *Apply to a project* brings chosen parts into a running project after a preview of exactly what would be
added or updated; it matches by name, never removes anything and never touches existing items. Templates can be
exported and imported as a file; an imported file is tried on a scratch project that is thrown away, and refused whole
if any part is wrong. Three come built in: *Simple board*, *Engineering design*, *Manufacturing*.

## The timeline and the scheduling engine

**The timeline (062): simple by default.** It looks like the team's roadmap slides: months over season weeks
(01, 02, … counted from the latest **Season start** team date; calendar dates if there isn't one), a "Work package"
column, rounded bars colored by the **kind of work**, and a legend underneath. Click a legend entry to pick out
that kind; click it again to show everything. Everything else is off until someone turns it on, and each person's
choices are remembered per project on their own device.

- **Move things by dragging.** Drag a bar to move it, or its ends to change the start or due date (whole days at
  Weeks zoom, whole weeks when zoomed out; a tag shows the new dates as you go). It **saves straight away**, with an
  **Undo** at the bottom of the screen. The arrow keys move a selected bar too (Shift for a week).
- **Click a bar** (or press Enter on it) for a **side panel**: title, status, kind, dates, owner, priority, progress
  and notes. Each one saves as soon as it's changed (notes when you click away), plus a link to the full item.
- **Draw dependencies:** hover a bar and drag the dot at its end onto the bar that has to wait for it (finish →
  start). Click an arrow to remove it. The other kinds, and gaps, are on the item's page.
- **⋯ on a row:** Details, Open, Add under it, Set dates, Put under the row above, Take out a level.
- **Draw dates:** an item without dates gets a shaded row; drag across it (or click for a week) to give it dates.
  **Filter → Only undated** lists just those (and what they're under).
- **Rename in place:** double-click a title. **Reorder and nest:** drag a row by its ⋮⋮ handle onto another row (the
  middle puts it under; the top or bottom edge puts it before or after; greyed out where the work types don't allow
  it). **Collapse all / Expand all** in the column header. Drag the column's edge to make it wider.
- **"+ Add"** makes a new item with its kind, title and dates; across projects, "+" on a project's row adds to it and
  "+ New project" starts one. These are ordinary items: List, Board, Backlog and Calendar show them too.

**The toolbar, for when you want more:**

- **Weeks / Months / Season** zoom (Season fits everything), and **Today**.
- **Color:** kind of work (default), status, subsystem, owner or priority. Kind colors are the work types' colors
  (Settings → Work types).
- **Show:** dependency arrows, progress, labels on bars, item keys, owners, team dates; compact
  or comfortable rows. Light or dark follows the site's own setting (the account menu), like every other page.
- **Filter:** the usual filters plus **Only undated**.
- **Plan:** **Forecast** (dashed outlines and "late" markers), **Critical path** (red), **What-if mode** (dragging
  only tries changes out until "Apply"), a **Baseline** to compare against (each row then shows its slip, and
  **Moved since the baseline** lists them), **Save a baseline**, saved what-ifs, **Reschedule to forecast…**, and
  **Team dates…** (competitions, design reviews, deadlines, breaks and the season start, for whoever can manage
  Projects; they show as bands on every timeline and on the Calendar).
- **Present:** the chart as a clean slide (in the site's light or dark colors), with a title and subtitle you can type, **Download PNG**,
  **Print / PDF** (landscape) and **Full screen**.

Also shown when they apply: **Other projects**' dependencies as tags on the row ("ELEC-12 ▸" where that item finishes,
"◂ MECH-4" where it starts), and **Orders not placed in time**: an open item linked to an Orders request that isn't
Ordered or Received, starting within the project's warning window (7 days unless changed under Summary → Orders &
budget) or already started, shows "order ⚠" on its row and a list under Schedule warnings. Its owner and the project
manager get an inbox notification (and email, if Project updates email is on), at most every 3 days per item.

Three kinds of date are kept apart:

- **Target** dates (solid bars): what people typed. They never move on their own.
- **Forecast** (dashed outline): what the engine works out.
- **Baseline** (thin grey bar): the target dates as they were when someone pressed "Save a baseline".
- (**Actual**: when work really started and finished, recorded by the workflow.)

The engine ([`orders/js/projects/schedule.js`](../orders/js/projects/schedule.js), pure and tested in Node) assumes:

- Time is whole days. Work happens on the project's working days (Settings → Details; Monday to Friday unless
  changed), never on its days off. Across several projects the standard week is used.
- An item's length is the working days from its target start to its target due date. With one date or none: its
  estimate at 8 hours a day, at least one day. A milestone has no length.
- Finished items stay where they finished. Items in progress started when they actually started and can't finish
  before today. Items not started can't start before today, their target start, or what their dependencies allow.
- Dependencies ("this waits on that"): finish → start, start → start, finish → finish, start → finish, with a gap in
  working days (negative to overlap). They work across projects. A loop is refused when it's made.
- Slack is how many working days an item can slip without moving the last finish date. The **critical path** is
  the chain with none.

**Warnings** say when an item is forecast to finish after its due date, when it was meant to have started and hasn't,
and when its planned start is earlier than its dependencies allow (naming the item that's holding it up).

**What-if** (Plan → What-if mode): dragging or resizing a bar, "Set dates" on a row, or "Reschedule to forecast…" changes nothing. It shows
what the forecast finish becomes, which other items move, and how the warnings change. Then **Apply to the plan**
(one saved change with a note, in every item's history), **Keep as a what-if** (to come back to), or **Discard**.

## Documents (Smart Links)

A document is linked by pasting its address: in Teams or SharePoint, *Copy link*, then *Link a document* on an item
or in a project's Documents. one.solar reads the address to guess what it is (SharePoint / Teams / OneDrive, a file or
a folder, the kind of file, a title, a category) and stores the address, title and category. Clicking opens the
original in Microsoft 365.

- No Microsoft Graph, app registration or UF IT approval is involved. Nothing is downloaded, previewed or proxied.
- one.solar **can't tell whether a file exists or who can open it**, and never says it can. Who can open a file is
  still decided in Teams / SharePoint. The page suggests linking with "People with existing access", and points out
  a link that looks like an "anyone with the link" share.
- Only `https://` addresses are kept (checked in the page and by the database); anything else is refused.
- The same model holds GitHub, Onshape / GrabCAD, Google Drive and other one.solar apps (GatorWire, Orders…).
- `pm_resources.meta` is there for a later Graph sync (file ids, modified dates) without changing what's stored.

## Other one.solar apps

- **Orders**: link an item to a purchase request; the request's status is read live (so "not here yet" shows on the
  item). Projects never changes a request. The project's **Summary** adds up its linked requests (spent: ordered or received; committed: approved, not ordered yet; waiting for approval) next to the project's own budget (**Set budget…**, for whoever can configure the project), and the request's page in Orders lists the project items it's linked to (migration 060).
- **Inventory**: link an item to an inventory item; what's available is read live for people who can see Inventory.
  Projects never changes stock. **How many?** on a linked part (061) reserves that many while the item is open: the
  item shows what's left after other open items' reservations ("short by 4" in red when there isn't enough), and the
  part's page in Inventory lists **Reserved for projects**.
- **CE divisions and subsystems**: the same list Inventory uses (`org_divisions` / `org_subsystems`, edited in Admin →
  CE divisions & subsystems). A project has an owning division / subsystem and others taking part; new items take the
  project's unless they say otherwise. Renaming keeps the link; history keeps the names of the time.
- **Solar Evals**: nothing is sent to it and nothing is scored. "Copy what I finished" on My work gives a member a
  plain list to paste into a self-evaluation if they want to.
- **Notifications**: Projects has its own inbox. Email / Teams messages use the existing outbox as the event
  *Project updates*, **off until an Admin turns it on** in Admin → Notifications; failures show and can be retried
  there like any other message. Bulk edits never send email.

## How it's built

- **Pages:** [`projects/index.html`](../projects/index.html) (`<body data-app="projects">`) loads the shared
  `orders/js/main.js`; routes are in [`router.js`](../orders/js/router.js) (`#/projects/…`). Views are in
  [`orders/js/views/projects/`](../orders/js/views/projects); pure logic (tested in Node) in
  [`orders/js/projects/`](../orders/js/projects): `schedule.js`, `links.js`, `formula.js`, `core.js`, and `api.js`
  (every read and RPC). Styles: [`orders/css/projects.css`](../orders/css/projects.css).
- **One way of working, shared by every view:** `pick.js` (the pickers), `inline.js` (change a field in place, with
  Undo; the buttons come from `kit.js` → `ie()`), `select.js` (tick boxes and the bar for several at once),
  `quick.js` (add with a title) and `command.js` (Ctrl+K and the shortcuts). A view only says which fields to show;
  saving, Undo, errors and permissions are the same everywhere. Edits in place save with `pm_update_item` without a
  version check (one field at a time, so the last change wins); the edit form still refuses a stale save.
- **No new libraries.** SortableJS, Frappe Gantt and calendar libraries were considered. The board uses the same
  small native drag-and-drop as the Sponsors board (now shared: [`orders/js/kanbanDnd.js`](../orders/js/kanbanDnd.js)),
  and the timeline and calendar are drawn here, because they need things those libraries don't do (baselines,
  forecast next to target, four kinds of dependency, what-if) and the site has no build step or bundled dependencies.
- **Database (051):** tables `pm_*`. Reads go through row-level security on `pm_visible()` (the projects the reader
  can see, worked out once per query). **Every change is a `security definer` function** (`pm_…`) that checks the
  person's project role, validates against the project's configuration, and writes history in the same transaction.
  Functions starting `pmx_` are internal and can't be called from the website.
- **One set of items.** Boards, backlog, list, timeline, calendar and dashboards all read `pm_items`; nothing is
  copied per view.
- **Custom field values** live in `pm_items.custom` (JSON, indexed), checked against `pm_fields` on every save.
- **Edits carry a version**: saving from an out-of-date page is refused (`OS409`) instead of overwriting. Creating
  carries an operation id, so a retry makes one item. Item numbers come from the project row under its lock.
- **Errors the pages handle:** `OS409` someone else changed it first, `OS412` that key is taken, `OS428` something is
  missing (the detail says what: fields for a form or move, or statuses to map).

### What 051 changes outside Projects

- New permissions `projects.*` with default grants, and a permissions snapshot (Admin → History).
- `project_update` added to the notification settings (off).
- Nothing else: no existing table, function or policy is changed.

## Tests

- `node tests/projects.test.mjs`: the database (access and privacy by role, configuration, forms, hierarchy, the
  workflow engine, dependencies, search, saved views, templates, rules, notifications, documents and links, planning,
  the roll-up).
- `node tests/projectsModules.test.mjs`: the scheduling engine, Smart Links, formulas, shared helpers.
- `npx playwright test tests/e2e/projects.spec.mjs`: the whole acceptance scenario in a browser on the fake backend.
  `PM_SHOTS=1` also saves pictures of the main pages in `test-results/pm-shots/`.
- All are part of `npm test` / `npm run test:smoke`.

## Deploying

1. Open a PR with the branch. CI runs every test; with auto-merge on, it merges when "Tests" pass.
2. Supabase's GitHub integration applies `051_projects.sql` when it reaches `main` (it's the next file after 050) and
   redeploys `send-notifications` (it gained the wording for project messages). Or run the SQL yourself in the SQL
   editor if the integration is off. It's one transaction: all or nothing.
3. Check: the yellow "database needs an update" banner is gone for Admins; `/projects/` opens; the home screen shows
   the Projects card.
4. First use (anyone with *Create projects*): Projects → **New project**, pick a template, add people in Settings →
   People & roles. CE divisions and subsystems come from Admin → CE divisions & subsystems.
5. Optional: **email / Teams** for Projects: Admin → Notifications → turn *Project updates* on.
6. Optional: run [`supabase/ops/cron_projects.sql`](../supabase/ops/cron_projects.sql) once, so reminders and timed
   rules also run on days nobody opens Projects. Without it they run when someone does (at most every 30 minutes).

Nothing else needs configuring: no new secrets, buckets or GitHub settings.

## Rolling back

- **The pages:** revert the PR. The database keeps working for everything else; the Projects pages disappear.
- **Hide Projects but keep the data:** in Admin → Roles & permissions, untick the Projects permissions. The home-screen
  card, the pages and every database function then refuse those roles.
- **The database:** don't drop it unless you're sure. On a database with no project data worth keeping: unschedule
  `projects-timed` if you set it up; drop the `pm_*` tables and the `pm_*` / `pmx_*` functions; delete the
  `projects.*` permissions and their role grants; remove `project_update` from the `notifications` setting; delete 051
  from the migration ledger (041); set `REQUIRED_SCHEMA_VERSION` back to 50. Test it on a copy first.

## What it doesn't do (compared with Jira)

Said plainly, so nobody expects it:

- No query language to type (JQL): filters are built from conditions, with groups one level deep.
- No time tracking / work logs, story points, velocity or burndown charts, or release / version management. Sprints
  keep a summary of what was done and carried over.
- No per-item or per-field security inside a project: if you can see a project you can see all of its items and
  fields. (Private projects are the boundary.)
- Workflow moves have conditions, required fields, comments, approvals and follow-up actions, but not arbitrary
  validators or scripts; rules have no branching ("else") and can't call other systems (no webhooks).
- No live updates: a page shows what was there when it loaded and refuses a save made from stale data.
- No file attachments on items: documents are linked, not uploaded. No Microsoft Graph, so no file previews,
  permission checks or "recent files".
- Calculated fields are display-only (not filterable or sortable in the database).
- The timeline schedules forward only, in whole days, with one calendar per project; it has no resource levelling
  and no per-person calendars. Workload uses estimates and due dates, not hours actually spent.
- Dashboards have a fixed set of widget kinds; there are no custom charts.
- Email / Teams messages are one message per event (no digests).
- Boards drag with a mouse; on a phone (and with a keyboard) every card has a **Move** menu instead.

## Known limits

- The fake backend and PGlite have one connection, so the tests check what makes concurrent use safe (row locks,
  versions, operation ids, unique keys) rather than racing two sessions.
- A list, board, timeline or calendar loads at most 2,000–3,000 items at once and says so when there are more; lists
  page from the database.
- Recognising a link's kind is a guess from its address; the person can change the title and category.
