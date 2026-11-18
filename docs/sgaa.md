# Alumni hub (SGAA)

The Solar Gators Alumni Association's page on one.solar: what the team is working on, what it needs, and how alumni
can help. Address: **`/sgaa/`**. Needs the database update
[`supabase/migrations/052_sgaa.sql`](../supabase/migrations/052_sgaa.sql); until it's applied, the hub says it isn't
set up yet and nothing else changes.

No money is tracked here: no pledges, no payments, no link to Orders. Giving goes through the UF Foundation link on
"How to help".

## Using it

| Page | Who sees it | What it's for |
| --- | --- | --- |
| **Home** | everyone | The intro, a few open needs, the latest update and the next event. |
| **What we need** (and **a need**) | everyone | Parts, materials, money or know-how the team is looking for, by subsystem. "Contact the team about this" asks you to sign in. |
| **How to help** | everyone | Ways to help (written in Manage → Pages), the giving link, and the people alumni can contact. |
| **Updates** | everyone | News from the team, with photos. |
| **Events** | everyone | Reunions, races, design reviews. Signed-in alumni and team members can RSVP. |
| **Contact** | signed in | A message form to one of the team's contacts, optionally about a need. It's **emailed** to the contact with the alum's address as Reply-To, so replying to the email answers the alum. Team addresses are never shown to alumni. |
| **Messages** | signed in | Your messages: sent, and (for contacts) received, with "Reply by email". People with *See alumni messages* also see everyone's. |
| **Alumni** (directory) | alumni and team members | Search alumni by name, employer, city, major, role on the team or what they're happy to talk about; "Happy to talk" shows only mentors. |
| **My directory card** | alumni (and team members, ahead of time) | Your card: class year, job, employer, city, major, roles on the team, mentor topics, LinkedIn, bio. Each field has **Who sees it**: *Alumni and the team*, *Only the current team*, or *Only me*. Untick "List me" to leave the directory. Your email is hidden unless you choose otherwise. |
| **Join** | anyone | Sign up as an alum (any email address), or ask to be listed as one if you already have an account. |
| **Manage** | editors | **Needs**, **Updates**, **Events** (with RSVPs), **Contacts** (who alumni can write to), **Pages** (title, intro, how to help, giving link) and **Alumni** (approve people who asked to join). |

### Who is an alum

- **A former member who graduated.** Admin → Users → **Graduated…** deactivates them (like Deactivate, 044) and
  makes them an alum. **Mark as alum** does the same for someone deactivated earlier; **Not an alum** undoes it.
  Alumni can still sign in, but only to the alumni hub and My account: they have no team permissions and never see
  the team's data. Reactivating them puts them back on the team and they stop being an alum.
- **An alum who was never on one.solar** signs up from **Join**. They may use any email address while
  *Alumni can sign up with any email address* is on (Admin → one.solar → Team & season; on by default, Admins only).
  They arrive as a Guest, see nothing of the team, and wait in **Manage → Alumni** (not in the team's "waiting to
  join" list) until someone with *Approve alumni* approves or declines them. A declined person shows up in the
  team's waiting list again, so a lead can still accept them onto the team.
- **Switch to a personal email.** UF turns off student addresses after graduation. Alumni and graduating members are
  reminded (on the hub and in My account) to change their sign-in email in **My account → Email address**. The
  team's records follow the new address.

### Who can do what

| Permission (Admin → Roles & permissions) | Lets you | Given by default to |
| --- | --- | --- |
| `sgaa.edit` Edit the alumni hub | needs, updates, events, contacts, pages; make shared Projects items public | CE, E-board, Coordinator, Admin |
| `sgaa.messages` See alumni messages | read every message alumni sent (contacts always see their own) | E-board, Coordinator, Admin |
| `sgaa.alumni` Approve alumni | see who asked to join as an alum, approve or decline | CE, E-board, Coordinator, Admin |

## Needs from Projects

A Projects project or work item can be put on the alumni hub's "What we need" list with the **Share with alumni**
card (on a project's Summary and on a work item's page). Alumni can't see Projects, so this is how a part or a
problem from Projects reaches them.

- People who can **edit** it in Projects share it as a **draft**; someone with *Edit the alumni hub* checks the
  wording in Manage → Needs and makes it public. People with *Edit the alumni hub* share it as public right away.
- The need links back to Projects ("Shared from Projects: KEY · title") for team members, and shows a "From
  Projects" tag in Manage → Needs.
- When the shared work item is **done**, the need shows as **met**; reopened, it's open again.
- **Stop sharing** deletes a draft and archives a public need.

## How it's built

- `sgaa/`: `index.html`, `app.js` (pages and routing), `lib.js` (pure helpers, tested in Node), `sgaa.css`. Like
  Solar Evals, it's its own app, using one.solar's shared top bar and sign-in. It uses Orders' Supabase client
  (`orders/js/supabase.js`) so the fake dev server can swap it.
- Public pages read everything in one call, `sgaa_hub()`, which also works without signing in. Every write is a
  `security definer` function (`sgaa_*`) that checks the permission itself.
- Tables: `sgaa_alumni` (alum status and directory card, with per-field visibility), `sgaa_contacts`, `sgaa_needs`,
  `sgaa_updates` (+ `sgaa_update_images`), `sgaa_events`, `sgaa_rsvps`, `sgaa_messages`. Photos are in the public
  storage bucket `sgaa`; only editors upload.
- `sgaa_directory()` blanks every field a card's owner hid from the person asking; your own card always shows
  everything to you.
- **Messages** go through the existing notifications outbox as the event `sgaa_message` (email only; its wording is
  in Admin → Notifications → *Alumni hub (SGAA)*). `send-notifications` sets the alum's address as Reply-To and sends
  as "Name via one.solar". Alumni can't start the sender themselves, so their messages go out on the **schedule**
  (see MAINTAINING.md → Notifications, "Schedule the sender"), within 5 minutes.

### What 052 changes outside the hub

- New permissions `sgaa.*` with default grants, and a permissions snapshot (Admin → History).
- Notification event and template `sgaa_message` (email on); the `sgaa` app setting.
- `handle_new_user`: a sign-up from the hub (`{ sgaa: "alum" }`) may use any email while `alumniCanSignUp` is on,
  and starts a pending alum request. `guard_alumni_sign_up`: only Admins change `alumniCanSignUp`.
- `waiting_people` leaves out people asking to join as an alum.
- `graduate_person`, `sgaa_set_alum`; reactivating an alum (a new role) clears it (`sgaa_alum_rejoined`).
- `sync_profile_email`: changing your sign-in email updates your profile.
- A trigger on Projects items (`sgaa_item_changed`) marks a shared need met / open.
- The Orders router sends alumni (and pending alumni) to the hub instead of the team's pages; the home screen does too.

## Tests

- `node tests/sgaa.test.mjs`: the database (who sees what, alumni sign-up and approval, graduating, messages and the
  outbox, RSVPs, the directory's privacy, sharing from Projects).
- `node tests/sgaaLib.test.mjs`: `sgaa/lib.js` and `shared/safe-next.js`.
- `npx playwright test tests/e2e/sgaa.spec.mjs` (and the last test in `projects.spec.mjs`): in a browser on the fake
  backend. Locally, `npm run dev:fake` and open `/sgaa/`.
- All are part of `npm test` / `npm run test:smoke`.

## Deploying

1. Open a PR with the branch. CI runs every test; with auto-merge on, it merges when "Tests" pass.
2. Supabase's GitHub integration applies `052_sgaa.sql` when it reaches `main` and redeploys `send-notifications`
   (it gained the Reply-To for alumni messages). Or run the SQL yourself in the SQL editor and redeploy the function
   if the integration is off. It's one transaction: all or nothing.
3. **Supabase → Authentication** (done by hand, once):
   - Emails → Templates → **Change Email Address**: use the `token_hash` link in MAINTAINING.md (Email templates).
   - Turn **off** *Secure email change*, so a graduate whose UF address is already gone only has to confirm the
     new address.
4. **Schedule the sender** if it isn't yet (MAINTAINING.md → Notifications), or alumni messages wait until a team
   member opens one.solar. If email goes through Power Automate, set **Reply To** to `triggerBody()?['replyTo']`.
5. Check: `/sgaa/` opens without signing in; the home screen shows the *Alumni (SGAA)* card; Admin → Users has
   **Graduated…**.
6. First setup (someone with *Edit the alumni hub*): Manage → **Pages** (intro, how to help, the UF Foundation
   giving link), **Contacts** (who alumni can write to), then a few **Needs**. Then mark last year's graduates with
   **Graduated…** and send alumni the link.

No new secrets or GitHub settings.

## Rolling back

- **The pages:** revert the PR. Alumni then see only the home screen and My account.
- **Hide it but keep the data:** untick the `sgaa.*` permissions; turn off *Alumni can sign up with any email
  address*. The public pages stay readable; take needs, updates and events down in Manage first if they shouldn't.
- **The database:** don't drop it unless you're sure. On a database with nothing worth keeping: drop the triggers
  `sgaa_alum_rejoined`, `guard_alumni_sign_up`, `sync_profile_email` and `sgaa_item_changed`, the `sgaa_*` tables and
  functions, `graduate_person`; put back `handle_new_user` from 040 and `waiting_people` from 044; remove the `sgaa` bucket and
  its policies, the `sgaa.*` permissions and grants, the `sgaa` setting and `sgaa_message` from the `notifications`
  setting; delete 052 from the migration ledger (041); set `REQUIRED_SCHEMA_VERSION` back to 51. Test it on a copy first.

## Known limits

- Alumni messages are email only (no Teams), and go out on the schedule, not instantly.
- Contacts are team members; alumni can't message each other through the hub (the directory shows an email or
  LinkedIn only if the alum chose to).
- No pledges or donation tracking, on purpose.
