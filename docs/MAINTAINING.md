# Maintaining one.solar

This guide is for whoever maintains the site: setting it up from scratch, running it locally, applying database updates, and understanding the code. Most of it is about Orders, the biggest app and the owner of the database. For what each app does and how the team uses it, see the [README](../README.md), [Orders](orders.md) and [Solar Evals](solar-evals.md).

**Stack**
- **Website:** plain HTML/CSS/JavaScript on **GitHub Pages**. No server; the deploy only copies the site's files after the tests pass (see [RELEASING.md](RELEASING.md)).
- **Accounts + database:** [Supabase](https://supabase.com) (free tier). It handles sign-in, stores the data, and enforces every permission.
- **Live site:** https://one.ufsolargators.org/ (Orders at `/orders/`). The old `solar-gators.github.io/one.solar/` addresses redirect there.
- **Changing the site:** push to `main` (or merge a pull request). The **Deploy site** workflow runs every test and publishes in about 5 minutes; a failing test publishes nothing. See [RELEASING.md](RELEASING.md) (including how to revert).
- **When something breaks for someone:** Admin → one.solar → **Diagnostics** lists errors pages hit and **Report a problem** messages (046), whether the website and database versions match, and failed notifications.
- **Deleted by mistake:** sponsor cards and Finances records (sheets, rows, purchases, funding sources) can be put back from **Recently deleted** at the bottom of Sponsors or Finances for 90 days (047). Requests and settings have their own History / restore.

**Permissions** live in the database (`permissions` and `role_permissions` tables), not in code:
- **Changing what a role can do:** use **Admin → one.solar → Roles & permissions** on the site. The Table Editor works too.
- **Lockout protection:** the database refuses any change (to a role or to the grid) that would leave nobody with `users.manage`. The Admin role always keeps `roles.edit`, and the last Admin can't drop the Admin role or be removed.
- **Admin is special (035):** only Admins can give or take the Admin role, change an Admin's roles, or remove an Admin. Everyone else with `users.manage` can do the rest.
- **Someone who left (044):** Admin → Users → **Deactivate…** makes them a **Former member**: their roles go (recorded in `role_changes`), they see none of the team's data (evals included), they can't sign in (unless an Admin turns on *Former members can sign in* under Team & season), and everything they did keeps their name. **Reactivate** brings them back. Only an Admin can **Delete permanently…** an account, and only a former member's or a guest's (type their email to confirm); their eval notes are kept and their saved eval questions are archived. Deleted accounts are kept in `removed_people`; if the same email signs up again, people managers see a flag until someone clicks **Let them back in**.
- **Roles (042):** only an Admin changes their own roles, or gives or takes Admin, CE, Treasurer or any role that can manage people, edit roles or change the workflow. Others who manage people can give or take only roles whose abilities they have themselves. Every change is in `role_changes` (Admin → Users → Role changes).
- **Accepting people (043):** only Admin, CE and E-board can ("Accept new people"), and only once the person has confirmed their email. **Not on the team…** on the home screen turns someone away. Only an Admin changes the allowed sign-up email domains.
- **Solar Evals is set up on its own page (036):** kinds of eval, groups, forms and questionnaires are rows in the database edited in Solar Evals → Setup / Forms / Questionnaires (`evals.types`, `evals.templates`). Each eval keeps a copy of its type's settings (`evals.type_settings`), and the row security reads that copy, so changing a type never changes who can see an eval already written until someone clicks **Apply to evals in progress**.
- **Roles:** a person can hold several roles (`profile_roles` table); their permissions combine. Built-in roles are Member, Chief Engineer, Treasurer and Admin. More can be created on the site.
- **Current permissions:**
  - `request.review`: approve, reject, or request changes.
  - `request.order`: mark Ordered and Received, and adjust costs.
  - `settings.edit`: form fields, dropdown lists, team settings, request rules.
  - `site.customize`: list columns/filters/sorting, status and priority labels and colors.
  - `seasons.manage`: start a new season, import spreadsheets.
  - `users.manage`: give people roles (not Admin or other people-managing roles: see 042 above), and deactivate people who left.
  - `roles.edit`: create, rename and delete roles, and the permission grid (Admin only by default).
  - `evals.write`, `evals.view`, `evals.templates`, `evals.types`: Solar Evals: fill out evals, see all evals, edit forms and questionnaires, set up kinds of eval (036).
- **Settings history:** every version of `app_settings` (general, form, lists, appearance) and of the permission grid is kept in `settings_history`. Leads restore versions from the **History** link at the top of each Admin page.

## Setup (one time, about 15 minutes)

### 1. Create the Supabase project
1. Sign up at https://supabase.com. Create a **team organization** (e.g. "UF Solar Gators") so the project isn't tied to one student's personal account, then invite the other leads.
2. **New project** → any name → pick a strong database password and save it somewhere safe.
3. Open **SQL Editor → New query**. Paste each file in [`supabase/migrations/`](../supabase/migrations) **in order** (`001_…`, then `002_…`, …) and click **Run** after each one. Together they create every table, permission, and security rule.

### 2. Configure sign-in
In Supabase, go to **Authentication**:
- **URL Configuration**
  - **Site URL:** the site's address, e.g. `https://one.ufsolargators.org/`
  - **Redirect URLs:** add `https://one.ufsolargators.org/**` and `http://localhost:5173/**` (for local testing). Keep the old `https://solar-gators.github.io/one.solar/**` for a while after a domain change, for emails sent before it.
- **Emails.** This one matters. Supabase's built-in email service only delivers to members of your Supabase organization, and only a few messages per hour. Pick one:
  - **Recommended:** set up custom SMTP (**Authentication → Emails → SMTP Settings**) with a free provider such as Resend or Brevo. Confirmation and password-reset emails will then work for everyone. Its **Sender name** is the name these emails come from (e.g. `one.solar`).
  - **Quick start:** turn off **Confirm email** (**Authentication → Sign In / Providers → Email**). People can sign up and use the site immediately. Only @ufl.edu addresses are accepted, and new accounts can't do anything beyond submit requests until a lead gives them a role. Password-reset emails still need SMTP.
- **Email templates** (**Authentication → Emails → Templates**). UF's Outlook opens every link in an email to scan it, which uses up Supabase's standard one-time links before the person clicks ("That email link has expired or was already used"). Change the link in two templates so it opens the site, and the link is only used when the person presses the button there (scanners don't press buttons; the link then also works on any device):
  - **Reset Password:** `<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery">Reset password</a>`
  - **Confirm signup:** `<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email">Confirm your email</a>`
  - **Change Email Address:** `<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email_change">Confirm your new email</a>` (My account → Email address; alumni switch off their UF address, migration 052)
  - `{{ .RedirectTo }}` is the app page the person asked from (e.g. `https://one.ufsolargators.org/orders/`), so it has to be allowed under Redirect URLs above. The site handles both link styles, so emails sent before the change still work.
  - These emails (confirm, reset, change email) are sent by Supabase through **Emails → SMTP Settings**, not by one.solar's notification sender, so they never appear in Admin → one.solar → Notifications' log. To see whether one went out, open **Logs → Auth** and click the person's `/signup` line (`user_confirmation_requested`, status 200 = handed to the SMTP server). After signing up, people see **Check your email** (it can take a few minutes; check Junk and Outlook's Other tab) with **Send it again** (once a minute, Supabase's limit), and signing in before confirming offers the same button. Someone stuck on "Email not confirmed yet" on the home screen's waiting list can get a new one with **Resend email** there; only the newest link works. A personal Gmail as the SMTP server often lands in UF Junk; a transactional email service with an address on the team's domain delivers better.
- **Secure email change** (**Authentication → Sign In / Providers → Email**): turn it **off**. When it's on, changing an email needs a link clicked in the old inbox too, and a graduate whose UF address is already turned off could never finish switching. Off, only the new address has to confirm.

### 3. Connect the website
Open **Project Settings → API** (or the **Connect** button). Copy the **Project URL** and the **anon / publishable** key into [`shared/config.js`](../shared/config.js). Every app reads them from there.

The anon key is meant to be public. Never paste the `service_role` / secret key anywhere in this repo.

### 4. Make yourself the first Admin
Open the site (locally or on GitHub Pages), click **Create an account**, and sign up. Then run this in Supabase's **SQL Editor**:

```sql
insert into public.profile_roles (user_id, role)
select id, 'admin' from public.profiles where email = 'you@ufl.edu'
on conflict do nothing;
```

Refresh the page. From now on, roles are assigned from **Admin → one.solar → Users**.

### 5. Publish on GitHub Pages
Push this folder to a GitHub repository, then follow [RELEASING.md → One-time setup](RELEASING.md#one-time-setup-a-repo-admin-in-github-done-2026-11-14): Pages source **GitHub Actions** and the `PAGES_FROM_ACTIONS` variable. Only the website's own files are published, after the tests pass.

> The repository itself is public. `.gitignore` keeps spreadsheets and `data/` out of it, so real order sheets never reach GitHub.

## Running locally

You need [Node.js](https://nodejs.org) 18+. It's only used for the local server and tests; the site itself has no dependencies.

```bash
npm install
npm run dev
```

Open http://localhost:5173/ (the home screen; Orders is http://localhost:5173/orders/). The site uses the Supabase project configured in `shared/config.js`.

### Fake mode (no Supabase needed)

```bash
npm run dev:fake
```

Fake mode swaps Orders' Supabase client for an in-browser Postgres ([PGlite](https://pglite.dev)) running the same migrations, so the permissions behave the same. Data stays in your browser. No emails are sent, and signing up logs you in immediately. The home screen has its own stand-in (`/?fake=admin`); Solar Evals uses the same one as Orders: add `?fake` to its address on localhost (`/evals/?fake`). In the browser console:

```js
await fakeSql("insert into profile_roles select id, 'treasurer' from profiles where email = 'you@ufl.edu' on conflict do nothing")  // then refresh
await fakeReset()   // wipe local data
```

### Tests

```bash
npm test
```

`npm test` runs every test file in `tests/`. `npm run test:import` checks spreadsheet column recognition against the real headers of the 2024-25, 2025-26, and 2026-27 sheets. `npm run test:db` runs every file in `supabase/migrations/` in PGlite and checks the security rules as different users, e.g. "a Member can't approve", "a Chief Engineer can't mark ordered", "you can't edit someone else's draft", and "non-UF emails can't sign up". Run it after any database change. `tests/notify.test.mjs` checks how notification messages are written (placeholders, email HTML, the Teams card). `tests/site.test.mjs` checks what GitHub Pages publishes (only the site, no broken local links, exact CDN versions) and `tests/workflows.test.mjs` checks that the GitHub Actions workflows only deploy after the tests pass.

```bash
npx playwright install chromium   # once per computer
npm run test:smoke
```

`npm run test:smoke` (`tests/e2e/`) opens every app in Chromium on the fake backend, signed out and as an Admin, and fails on any JavaScript error or any request to the real Supabase. GitHub runs all of this on every pull request and before every deploy: see [RELEASING.md](RELEASING.md).

## How it works

```
index.html               one.solar home screen (hub/: its script, card list and styles)
shared/                  What every app shares:
  onesolar.css           colours (light + dark), sizes (type, corners, control heights), status colours, top bar,
                         account menu, buttons, forms, cards, tables, alerts
  nav-more.js            top bar links stay on one line: what doesn't fit goes into "More ▾"
  theme.js               light / dark before the page draws
  onesolar.js            site root + links between apps, sign-in link, Light / Dark setting
  account-menu.js        the account menu at the top right
  config.js              Supabase URL + anon key            ← set during setup
  assets/                Solar Gators logo (light + dark), favicon
orders/                  Orders; its js/ and css/ also run Finances, Sponsors and Admin
  index.html             Page shell + navigation
  css/styles.css         Orders' own styling (on top of shared/onesolar.css)
  js/
    appMode.js           which app this page is (Orders / Finances / Sponsors / Admin) and which pages belong to each
    site-config.js       re-exports shared/config.js
    supabase.js          Supabase client
    auth.js              Current user, role, permissions; sign in/up/out
    api.js               All data reads + actions (views never call Supabase directly)
    router.js            Hash routes (#/new, #/requests, …); sign-in gate; page permissions
    main.js              Startup: settings, account menu, nav visibility
    excel.js             Builds the .xlsx in the browser (column list = export template)
    ui.js                Statuses, formatting, badges, shared table helpers
    formFields.js        Form field definitions, inputs, and display (used by form, detail, export)
    sheetImport.js       Reads old Excel order sheets (archive + this-season import)
    workflow.js          Approval rules + budgets (who approves, what's left)
    views/               One file per page (login, account, admin, requests, …)
  manifest.webmanifest, sw.js, assets/   Installing it as an app
finances/, sponsors/, admin/   index.html only: the same code as Orders, as its own app
evals/index.html         Solar Evals (one page: evaluations, forms, questionnaires, setup)
gatorwire/index.html     GatorWire (a built file: upload new builds here)
scope-map/index.html     CE Scope Map
supabase/migrations/     Database changes, in order: tables, security, permissions, workflow (all apps)
supabase/functions/send-notifications/index.ts   Sends queued email / Teams messages
tests/db.test.mjs        Database security + workflow tests
tests/notify.test.mjs    Notification message tests
tools/dev-server.mjs     Local static server for every app (+ --fake)
tools/fake-supabase.js   Fake backend for Orders in local development
```

**Security model.** The website is public, so the database protects itself:
- **Reading:** signed-in users can read requests, items, approvals, profiles, and settings. Signed-out visitors can read only the team name and allowed email domains, which the sign-in page needs.
- **Writing:** nobody can write to a table directly. Every change goes through a database function (`save_request`, `review_request`, `mark_ordered`, `mark_received`, `set_user_role`, `update_settings`, `update_my_profile`). Each function checks the caller's permission and the request's current status.
- **The website's role:** it only hides buttons people can't use. Even a modified copy of the site can't bypass these rules.

**Data** (Supabase tables):
- `requests`
- `request_items`
- `approvals`: every decision, with who made it and when
- `order_information`: order and delivery details
- `profiles`: name, email, and role, one per account
- `roles` and `role_permissions`
- `app_settings`: the `general` and `form` JSON documents

Request IDs (`SG-001`, …) come from a database sequence, and the prefix is set in Settings. Totals are always calculated, never stored.

**Excel export.** On **Requests → Download Excel → Download .xlsx**, the browser builds the file: one row per item, with request, approval, order, and delivery info repeated on each row. The header is bold, filtered, and frozen, and prices and dates are formatted. The columns follow the form fields: every shown request field, then every shown item field, then the approval, order, and delivery columns. Renaming or adding a field in **Admin → Orders → Request form** changes the export too.

## Database updates

New features sometimes need a database change. These live in `supabase/migrations/` as numbered files. When one is added, leads see a yellow **"Database update needed"** banner naming the file until it's applied.

### Automatic (once set up below)
Supabase's GitHub integration (Supabase → **Settings → Integrations → GitHub**, repository `Solar-Gators/one.solar`, **Deploy to production** on, branch `main`) runs every new file in `supabase/migrations/` when it reaches `main`, and redeploys the functions listed in `supabase/config.toml` (with **Verify JWT** off for send-notifications). It keeps its own list of what ran, in `supabase_migrations.schema_migrations`; our ledger (`schema_migrations`, below) still records and guards every file too.
- **Put database changes through a pull request**, so the tests (which build the whole database from the migrations) pass *before* it reaches `main`. A push straight to `main` would migrate the live database while the tests are still running.
- **Back up first** (see [RECOVERY.md](RECOVERY.md)) before merging anything that changes or removes data.
- After merging: Supabase → **Settings → Integrations → GitHub** (or the commit's checks on GitHub) shows the run; the "Database update needed" banner goes away; `select * from schema_migrations order by version desc limit 3;` shows the new file.
- **If it fails:** nothing from that file is kept (each file is one transaction). Fix it in a new commit and merge again. Never edit a file that already ran: add the next number instead.
- Files must be named `NNN_name.sql` (lowercase, underscores), must not contain their own `begin`/`commit`, and nothing that can't run in a transaction (`create index concurrently`, `vacuum`). `tests/migrations.test.mjs` checks this, and `supabase/config.toml`.
- `supabase/config.toml` has no `[auth]`/`[api]`/`[db]`/`[remotes]` sections on purpose, so the integration never changes sign-in settings (Site URL, redirects, SMTP). Keep it that way.

**Setting it up (once):** run `supabase/ops/record_migration_history.sql` in the SQL Editor (it copies what already ran from our ledger into Supabase's history, so nothing is run twice; every row should say `matches`), then turn on **Deploy to production**. Turning it on before that would make it try to run 001 onwards again.

### By hand (before it's set up, or if it's turned off)
1. **Back up first** (see [RECOVERY.md](RECOVERY.md)), at least before anything that changes or removes data.
2. Open the file on GitHub and copy its contents.
3. In Supabase, go to **SQL Editor → New query**, paste, and click **Run**.
   - **Several at once:** `node tools/bundle-migrations.mjs 49 52` writes `supabase/bundles/049-052.sql`. Paste that and run it once; it's all or nothing (if any file fails, none are applied).
4. Check it was recorded: `select * from schema_migrations order by version desc limit 3;`
5. **Then** merge the website change that needs it. The website must never need something the database doesn't have yet.
6. With automatic migrations set up, a file run by hand must also be added to Supabase's history (run `supabase/ops/record_migration_history.sql` again), or the integration will try to run it again on the next push (it's refused by our ledger, and that deploy shows as failed).

**Where the live database is:** 041–049 were applied by hand on 2026-11-14. **050 (Inventory)** is written and tested locally but not applied yet: it goes in through the usual PR → Supabase GitHub integration (see docs/inventory.md → Deploying). **051 (Projects)** is written and tested locally and not applied yet either: it goes in the same way (see docs/projects.md). **052 (the alumni hub, SGAA)** goes in the same way too, plus a few Supabase settings by hand (see docs/sgaa.md → Deploying). **053 (Solar Evals assignments)** and **054 (the evaluation chart)** go in the same way, with nothing to set by hand (see docs/solar-evals.md → The evaluation chart). **055 (see every eval, for troubleshooting)** too. **056 (people in divisions & subsystems)** and **057 (filling them in from Solar Evals)** too. **058 (budget categories inside categories, moving money)**, **059 (changing an eval's evaluator, deleting a wrong eval)** and **060 (what a project spends)** and **061 (team dates, parts reserved for projects, orders not placed in time)** and **062 (a "Season start" team date, for the timeline's week numbers)** and **063 (team-wide kinds of work, car cycles)** too. **064 (Events: invitations, QR check-in, attendance)** too (see docs/events.md). **065 (Solar Evals guardrails: who a type is not for, only the assigned evaluator, the rules check)** too (see docs/solar-evals.md). The next new migration is **066**.

**The ledger (from 041).** `schema_migrations` lists every migration. 001–040 are marked `baseline`: they were run by hand before the ledger existed and are *not individually verified*; `schema_baseline` records how the database compared with the repo when the ledger started. From 041 on, each file records itself as its **last** statement. Postgres runs the whole file as one transaction, so if anything fails, nothing is kept and nothing is recorded: fix the problem and run the same file again. Running a file twice, or skipping one, is refused with a message saying which to run.

### Before 041 (done on the live database; for a copy restored from before then)
The check ignores line endings (a file pasted from Windows stores CRLF in function source, and that's not a difference).
1. Run [`supabase/checks/040_baseline_check.sql`](../supabase/checks/040_baseline_check.sql) in the SQL editor. It's read-only.
2. **No rows**: run 041.
3. **Rows with `blocks_041 = true`** (a table, column, function, policy or trigger differs from migrations 001–040): usually a migration file was changed after it was run, or something was edited in the dashboard. Fix it by re-running the current definition from the latest migration that defines that object (search `supabase/migrations/` for its name), then run the check again. Only if the team decides a difference is correct, set `v_accept_differences := true` and write why in `v_note` near the top of 041; 041 records that in `schema_baseline`.
4. **Rows with `blocks_041 = false`** are grants (who may call or read what). They don't block 041, but review them: anything `anon` can call or any non-SELECT table grant is worth a look. 041 always refuses if a table has row-level security off or if `anon`/`authenticated` can write a table directly.

### Writing a migration
- **Never edit a migration that may have been run** (001 onwards, once merged). Add a new file with the next number.
- Start with `select public.migration_begin(N);` and end with `select public.migration_done(N, 'NNN_name.sql');`. `npm test` checks both, and that the app's lists (`orders/js/main.js` `REQUIRED_SCHEMA_VERSION` + `MIGRATIONS`, `tools/fake-supabase.js` `MIGRATIONS`) include it.
- Write it so it can simply be run again after a failure (`create or replace`, `if not exists`, `on conflict do nothing`).
- Don't remove or rename anything the live website still uses in the same release: add first, remove in a later migration.

### Changing a database function
Supabase's API finds a function by **name and the names of the arguments sent**. Postgres treats `f(a, b)` and `f(a, b, c)` as *two* functions, and `create or replace` with a new argument list **adds a second one**, after which every call fails (PGRST203). So:
1. **Same arguments, new body:** `create or replace` is fine.
2. **A new optional input:** put it inside an existing `jsonb` argument if the function already reads keys from one (e.g. `p_fields ? 'expected_updated_at'`).
3. Otherwise **a new function with a new name** (e.g. `…_checked`), keeping the old one for pages people still have open; remove the old one in a later migration.
4. **A different result** (new columns): `drop function` + `create function` + the grants again, in the same file.

`npm test` (`tests/rpc.test.mjs`) fails if a callable function gets a second version, if any callable signature changes without updating `tests/rpc-signatures.json` (`node tests/rpc.test.mjs --update`), or if any call in the website names a missing argument or function.

## Email & Teams notifications

How it works: every workflow step (submit, approve, order, …) writes messages into the `notification_outbox` table in the same database transaction, so nothing is lost. The **send-notifications** Edge Function delivers them. The website calls it right after each action, and **Admin → one.solar → Notifications → Send waiting messages now** does too. Failed messages are retried up to 5 times, and the log on that page shows each one.

Nothing is sent until an Admin turns it on in **Admin → one.solar → Notifications**. You need the Edge Function plus **at least one** way to send:
- **Email via Gmail** (simplest, reliable): a team Gmail account sends the emails.
- **Power Automate** (for Teams, and it can also send the emails from Outlook): one flow receives every message and either posts it to the person in Teams or emails it.

### 1. Deploy the Edge Function (once)
1. Supabase → **Edge Functions → Deploy a new function → Via Editor**.
2. Name it exactly `send-notifications`.
3. Replace the sample code with the contents of `supabase/functions/send-notifications/index.ts` and click **Deploy**.
4. **Turn "Verify JWT" off** for this function (its details page). The function checks callers itself (S-7): only someone signed in who is on the team, or the scheduled job with `CRON_SECRET`, can make it send; everything else gets 401. With "Verify JWT" on, the scheduled job can't call it. Deploy the new code **before** turning it off.
5. To update it later, open the function → **Code**, paste the new file, and deploy again.
   **After migration 015 (Sponsors board), redeploy it once.** Older versions send "Sponsor card updated" messages with blanks like {sponsor} in them.
   **After migration 052 (alumni hub), redeploy it once.** Older versions send alumni messages without the Reply-To, so a contact's reply would go to the team's sending address instead of the alum.

(With the Supabase CLI instead: `supabase functions deploy send-notifications`.)

### 2a. Email with Gmail
1. Make a team Gmail account, e.g. `solargators.orders@gmail.com`. Don't use a personal one; it has to outlive your time on the team.
2. Turn on **2-Step Verification** for it, then create an **App password** at https://myaccount.google.com/apppasswords.
3. Supabase → **Edge Functions → Secrets**, add:
   - `SMTP_USER` = the Gmail address
   - `SMTP_PASS` = the 16-letter app password
   - optional `SMTP_FROM_NAME` = the sender name people see, e.g. `one.solar`. Leave it unset for `one.solar · <team name>`.

Gmail allows about 500 emails a day, far more than the team needs. Other providers work too: also set `SMTP_HOST` and `SMTP_PORT` (use port 465; Supabase blocks 25 and 587).

### 2b. Teams (and optionally email) with Power Automate
The flow runs under the UF account of whoever builds it, so build it with a lead's account, and add the next lead as a co-owner at handover.

1. Go to https://make.powerautomate.com and sign in with your UF account.
2. **Create → Instant cloud flow**, name it "Orders notifications", and choose the trigger **When a Teams webhook request is received**. Set **Who can trigger the flow** to **Anyone**.
3. Add a **Condition**: `triggerBody()?['channel']` *is equal to* `teams`.
4. Under **True**, add **Microsoft Teams → Post card in a chat or channel**:
   - Post as: **Flow bot** · Post in: **Chat with Flow bot**
   - Recipient: expression `triggerBody()?['recipient']`
   - Adaptive Card: expression `triggerBody()?['card']`
5. Under **False** (email; only if you are *not* using Gmail), add **Office 365 Outlook → Send an email (V2)**:
   - To: `triggerBody()?['recipient']` · Subject: `triggerBody()?['subject']`
   - Body: switch the editor to code view (`</>`) and use `triggerBody()?['html']`
   - The emails then come from the flow owner's UF mailbox. If the team has a shared mailbox, use **Send an email from a shared mailbox** instead.
   - Under **Show advanced options**, set **Reply To** to `triggerBody()?['replyTo']`. It's empty for everything except alumni hub messages, where it's the alum's address, so a contact's reply goes to them.
6. **Save**, open the trigger again, and copy its URL.
7. Supabase → **Edge Functions → Secrets**, add `FLOW_URL` = that URL. Treat it like a password: anyone with it can make the bot post.

If both are set, email goes through Gmail and Teams through the flow. If only `FLOW_URL` is set, both go through the flow.

If UF's tenant doesn't offer the trigger, or says it needs a premium license, post into a team channel instead: in step 4 choose **Post in: Channel** and pick your team's channel. The card still names the request; it just isn't a private message.

### 3. Turn it on
1. **Admin → one.solar → Notifications**: tick **Send notifications**, check the website address, choose email / Teams per event, and **Save**.
2. Click **Send me a test email** and **Send me a test Teams message**. Setup problems (missing secret, wrong password, flow error) show right there and in **Recent messages**.

3. **Schedule the sender (recommended; needed for the alumni hub):** "Needs your approval" messages wait (30 minutes by default, Admin → one.solar → Notifications) so a CE approving their own order doesn't notify the others; the schedule is what sends the ones still waiting, and it retries failed messages. Alumni can't start the sender themselves (only team members can), so their messages to contacts go out on this schedule, within 5 minutes.
   1. Supabase → **Integrations**: turn on **pg_cron** and **pg_net**.
   2. Make a long random secret (`openssl rand -hex 32`) and add it as **CRON_SECRET** in Edge Functions → Secrets.
   3. Open [`supabase/ops/cron_send_notifications.sql`](../supabase/ops/cron_send_notifications.sql), put the same secret where it says, run it in the SQL Editor, and clear it from the editor. The secret is stored in Supabase Vault, not in the schedule or the repo.
   4. Check: `select * from cron.job_run_details order by start_time desc limit 5;` shows runs every 5 minutes.

## Yearly handover checklist

When the new leads take over (usually with **Admin → one.solar → Team & season → Start a new season**):
1. **Start the season:** Admin → one.solar → Team & season → **Start a new season**. Numbering restarts (e.g. SG27-001), last season moves to the Archive, and unfinished orders stay in the queues.
2. **Roles:** give the new Chief Engineer and Treasurer their roles in **Admin → one.solar → Users**, and set graduating leads to Member (or **Deactivate…** people who left the team). At least one person must always keep "Manage people", and there must always be an Admin.
3. **Supabase:** invite the new leads to the Supabase organization (Organization settings → Team) so someone can run database updates and restore the project if it pauses.
4. **GitHub:** give the new leads access to the `Solar-Gators/one.solar` repository.
5. **Email (optional):** if you set up custom SMTP for sign-up and password-reset emails, make sure the account behind it isn't tied to someone who's graduating.
6. **Notifications:** keep `CRON_SECRET` with the other secrets in the team's password manager. The Power Automate flow belongs to whoever built it. Add the new leads as co-owners (flow → **Share**) before the old owner's UF account goes away, or rebuild it and update `FLOW_URL`. Hand over the team Gmail's password too.
7. **Workflow rules:** rules that name specific people (Admin → Orders → Approval rules) need updating when those people leave. A rule whose people are all gone falls back to "any Chief Engineer".
