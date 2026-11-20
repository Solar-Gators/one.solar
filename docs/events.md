# Events

Attendance for the team's events outside normal meetings: town halls, testing days, workdays, outreach. Leads
create an event and say who's invited; on the day, members check in by scanning a QR code; the team gets the
attendance list and stats by division and subsystem, instead of a spreadsheet. Address: **`/events/`**. Needs the
database update [`supabase/migrations/064_events.sql`](../supabase/migrations/064_events.sql); until it's applied,
every page says "Events isn't set up yet".

Events is not connected to Solar Evals, and nothing in it weighs attendance: the team decides what the numbers mean.

## Using it

| Page | Who | What it's for |
| --- | --- | --- |
| **My events** | every member | What you're invited to, with **Going / Maybe / Can't make it** (a reason is optional and only the hosts see it); a **Check in now** card while an event's check-in is open; the events you host; and your own attendance this semester. |
| **An event** | anyone invited | When, where, who's hosting, who's invited, the notes, your RSVP and whether you checked in. |
| **An event → Attendance** | its hosts, and leads with *See attendance* | The numbers (invited, RSVPs, came, walk-ins, late, excused, missed, turnout) and the list. Hosts check someone in by hand, **Undo** a check-in (with Undo on the notice), mark late / on time, and **Excuse** someone (with a note). |
| **An event → Log** | the same | Every change: created, edited, check-in opened / closed, who checked in (scanned or by hand, and by whom), undone, excused. |
| **Check-in screen** | hosts | Full screen for a projector or a laptop at the door: a QR code that changes every 30 seconds, the same code in big letters to type, a countdown, how many are in and the last few names. **Close check-in** when everyone's in. |
| **All events** | leads | Every event you can see, upcoming / past / everything, by category, with invited, came and turnout. |
| **Stats** | *See attendance* | **People**, **Events** and **Divisions & subsystems** (below). |
| **Categories & questions** | *Create events* | The categories (Town hall, Testing day, Workday, Outreach, Social, Other; add, rename, recolor, retire) and saved sets of sign-in questions. |

### Making an event

**+ New event** (top bar): title, category, start (and optional end), where, notes. Then:

- **Who's invited:** everyone on the team, or any mix of **divisions** (everyone in them), **subsystems**, **positions**
  (e.g. every Chief Engineer) and **people**. Divisions and subsystems are the ones in Admin → CE divisions &
  subsystems, and who's in which is Admin → Divisions & people. The invite list is worked out
  when you save, and it keeps following the team until the event starts (a new member of Battery is invited to
  Battery's upcoming events). After the event it's frozen, so past stats don't change when people move.
  People who RSVP'd, checked in or were excused stay on it even if the invite changes.
- **Email the people invited:** sends an invitation email to the people newly invited by this save (when
  notifications are on; Admin → Notifications → *Event invitations* can turn just these off). Invitations always
  show in My events.
- **Hosts:** the host (you, unless you pick someone) and co-hosts. Hosts and co-hosts can edit the event and run
  check-in; Admins can run any event.
- **Options:** ask people to RSVP; let members who weren't invited check in (they're marked **walk-in**); count
  check-ins as **late** after a number of minutes from the start.
- **Sign-in questions:** asked when someone checks in. Text, yes / no (a tick box), pick one, or a number; each can
  be required. **Add a saved set**, or **Save these questions as a set** for next time.

**Duplicate** (on an event) opens the form with the same set-up a week later. **Cancel the event** (⋯ menu) keeps
it and its attendance but marks it cancelled for everyone; **Bring it back** undoes that. **Delete** removes it and
everything about it.

### Checking in

1. The host opens **Check-in screen** → **Open check-in**, and puts it on a screen.
2. Members scan the QR code with their phone's camera. It opens one.solar's check-in page for that event (they sign
   in first if they aren't). They answer the questions and tap **I'm here**.
3. No phone camera? In one.solar → Events, the event shows **I'm here** while check-in is open; it asks for the code
   on the screen.

The code changes every 30 seconds and an old one stops working after about a minute, so a photo of the screen sent
to someone who isn't there won't check them in later. Check-in only works while it's open. A late scan just asks for
the code that's on the screen now. Hosts can always check someone in by hand, even after closing check-in.

Late is worked out from the start time and the event's "late after" minutes (a host can change it per person).

### The list

On an event's Attendance tab: **Everyone / Came / Late / Not here / Excused / Walk-ins**, find a name, click a
column to sort, **Columns** to choose what's shown (name, division / subsystem, position, status, RSVP and its note,
check-in time, how, walk-in, why excused, email, and each sign-in question's answer), **Saved views** to keep a
set-up under a name, and **CSV** / **Excel** to download exactly what's shown. Columns, sort and saved views are
remembered in this browser.

### Stats

Filters (remembered in this browser): semester (Spring = January–April, Summer = May–July, Fall = August–December),
from / to dates, categories, division, subsystem, position, and whether **"Can't make it" counts as excused** (on by
default). Every table sorts by any column and downloads as CSV or Excel.

- **People:** invited, came (walk-ins included), late, walk-ins, excused, missed, **rate**, last time they came, and
  how many of each category they came to. Click a name for every event they were invited to.
- **Events:** invited, said going, came, walk-ins, late, excused, **turnout**, and came / invited by division. The
  note above the table gives the average turnout of what's shown: filter to one category to compare its events.
- **Divisions & subsystems:** people, average rate, and how many are at or above / below a **threshold** you set
  (only a filter: nothing happens to anyone below it). Someone in two divisions counts in both.

What counts: events that have started and weren't cancelled. An event still going on counts for people who already
checked in; the others count once it's over.

- **Rate** = events they came to that they were invited to ÷ (events they were invited to − ones they were excused
  from). Walk-ins don't raise it (they're shown on their own).
- **Turnout** = invited people who came ÷ everyone invited.
- **Excused** = a host excused them, or (unless turned off) they answered "Can't make it".
- **Missed** = invited, not excused, didn't check in, and the event is over.

### Who can do what

| Permission | Lets you | Given by default to |
| --- | --- | --- |
| *(any member)* | See events you're invited to, RSVP, check in, see your own attendance | everyone accepted onto the team |
| **Create events** (`events.create`) | Create events, host them, edit the categories and question sets | Subsystem Lead, Chief Engineer, E-board, Admin |
| **See attendance** (`events.attendance`) | See every event, every attendance list and the stats; excuse people | Subsystem Lead, Chief Engineer, E-board, Admin |

Admin → Roles & permissions changes who has them. Titles like President carry no permissions; their E-board role
does. Running an event (editing it, check-in, hand check-in, undo) is for its host, its co-hosts and Admins. Guests
and former members can't use Events.

## How it's built

- **Database** (`064_events.sql`): `ev_categories`, `ev_events` (the invite and sign-in questions are JSON on the
  event), `ev_invitees` (worked out from the invite; holds "excused"), `ev_rsvps`, `ev_attendance` (time, how, by whom,
  late, walk-in, answers), `ev_log`, `ev_templates` (question sets), and `ev_secrets` (each event's check-in secret,
  readable by nobody). Row-level security: members read their own invitations, RSVPs and check-ins and the events
  they're invited to; hosts read their events'; *See attendance* reads everything. Every change goes through a
  function (`ev_save_event`, `ev_rsvp`, `ev_set_checkin`, `ev_checkin_code`, `ev_check_in`, `ev_host_check_in`,
  `ev_remove_attendance` / `ev_restore_attendance`, `ev_set_late`, `ev_set_excused`, `ev_save_category`,
  `ev_save_template`, `ev_delete_event`, `ev_sync`) that checks who's asking and logs the change.
- **The code:** six hex characters from `md5(secret : 30-second window)`. `ev_checkin_code` gives it to hosts while
  check-in is open; `ev_check_in` accepts this window's code and the two before it (about a minute to scan and sign in).
- **Pages:** [`events/index.html`](../events/index.html) is the app's shell (the same code as Orders; see
  `orders/js/appMode.js`), with pages in [`orders/js/views/events/`](../orders/js/views/events), data access in
  [`orders/js/events/api.js`](../orders/js/events/api.js), and the pure logic (standing, wording, CSV, stats) in
  [`core.js`](../orders/js/events/core.js) and [`stats.js`](../orders/js/events/stats.js). The stats are worked out
  in the browser from what the person may read. Styles: [`orders/css/events.css`](../orders/css/events.css).
- **Invitation emails:** `event_invite` rows in the notification outbox, sent by `send-notifications` like the other
  apps' messages (the template is editable in Admin → Notifications).

## Tests

- [`tests/events.test.mjs`](../tests/events.test.mjs): the database (permissions, invitations from divisions /
  subsystems / positions / people, who sees what, RSVPs, the check-in code, questions and answers, walk-ins, late,
  hand check-in, undo, excused, the log, syncing invite lists, cancelling, categories, question sets, emails).
- [`tests/eventsModules.test.mjs`](../tests/eventsModules.test.mjs): standing, wording, CSV and every stat.
- [`tests/e2e/events.spec.mjs`](../tests/e2e/events.spec.mjs): a lead makes an event, a member RSVPs and scans in,
  an old code is refused, the lead's list (answers, hand check-in, Undo, filters, CSV, log) and the stats.

## Deploying

1. Open a PR. CI runs every test; with auto-merge on, it merges when "Tests" pass.
2. Supabase's GitHub integration applies `064_events.sql` when it reaches `main`, and redeploys `send-notifications`
   (it gained the wording for invitation emails). If the integration is off, run the SQL in the SQL editor and
   redeploy the function. It's one transaction: all or nothing.
3. Check: the "database needs an update" banner is gone for Admins; `/events/` opens; the home screen shows the
   Events card.
4. Invitation emails go out only when a host ticks "Email the people invited" and notifications are on. Admin →
   Notifications → *Event invitations* turns them off, or changes their wording.

No new secrets, buckets or GitHub settings.

## Rolling back

- **The pages:** revert the PR. Everything else keeps working; the Events pages disappear.
- **Hide it but keep the data:** in Admin → Roles & permissions, untick the Events permissions (members still see
  their own invitations), or hide the card in Admin → Home screen.
- **The database:** only on a database with no event data worth keeping: drop the `ev_*` tables and the `ev_*` /
  `evx_*` functions; delete the `events.*` permissions and their role grants; delete 064 from the migration ledger
  (041); set `REQUIRED_SCHEMA_VERSION` back to 63. Test it on a copy first.

## Known limits

- No repeating series: use **Duplicate** (a week later) for weekly events.
- Saved views, list columns and stats filters are kept per browser, not shared between leads.
- Only team members check in (no guests or visitors). Someone without a phone is checked in by a host.
- The check-in screen needs to stay open (it fetches each new code); a host's laptop going to sleep stops it.
