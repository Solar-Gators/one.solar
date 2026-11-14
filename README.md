# one.solar

Every Solar Gators team app, in one place and one repo: **https://one.ufsolargators.org/**

**New admin?** Start with [Handing over one.solar](#handing-over-onesolar-read-this-if-youre-the-new-admin).

| App | Address | Folder | Guide |
| --- | --- | --- | --- |
| Home screen | `/` | `index.html`, [`hub/`](hub) | below |
| Orders | `/orders/` | [`orders/`](orders) | [docs/orders.md](docs/orders.md) |
| Finances | `/finances/` | [`finances/`](finances) | [docs/orders.md](docs/orders.md#finances-treasurer) |
| Sponsors | `/sponsors/` | [`sponsors/`](sponsors) | [docs/orders.md](docs/orders.md#sponsors-business-coordinator) |
| Admin (people, permissions, settings) | `/admin/` | [`admin/`](admin) | [docs/orders.md](docs/orders.md#admin) |
| Inventory (needs migration 050) | `/inventory/` | [`inventory/`](inventory) | [docs/inventory.md](docs/inventory.md) |
| Solar Evals | `/evals/` | [`evals/`](evals) | [docs/solar-evals.md](docs/solar-evals.md) |
| GatorWire | `/gatorwire/` | [`gatorwire/`](gatorwire) | [docs/gatorwire.md](docs/gatorwire.md) |
| CE Scope Map | `/scope-map/` | [`scope-map/`](scope-map) | an editable four-way Venn diagram of Chief Engineer responsibilities |
| Solar Gators website | https://ufsolargators.org/ | (its own repo, Advertisement-Website) | a card on the home screen |

Orders, Finances, Sponsors, Inventory and Admin are separate apps (each its own address, top bar and menu) built from the same
code in `orders/js/`: each app's `index.html` says which it is (`<body data-app="finances">`), and
[`orders/js/appMode.js`](orders/js/appMode.js) decides which pages belong where. A link to another app's page
(e.g. an old `orders/#/sponsors/…` email link) opens it in that app. Admin is grouped by where a setting applies: **one.solar** (every app: people, positions and permissions, the season,
logo, banner, notifications, home screen), **Orders** (the request form, approvals, lists), and **Other apps** (where
Sponsors, Finances and Solar Evals keep their own settings, inside each app).

Orders, Finances, Sponsors, Inventory, Admin and Solar Evals share one Supabase database ([`supabase/`](supabase)). For setting it up,
running it locally, database updates and how the code fits together, see **[docs/MAINTAINING.md](docs/MAINTAINING.md)**.

The old addresses (`/Orders-Form/…`, `/Custom-Apps/…`) still work: those repos now only send people here.

## One account, one look
- **One sign-in.** Every app is on the same site, so signing in on one signs you in to all of them.
  Signing in, creating an account and resetting a password all happen on the Orders sign-in page, which
  then goes back to the app you came from.
- **One look.** [`shared/onesolar.css`](shared/onesolar.css) has the colours (light and dark), the top bar, the
  account menu, buttons, form controls, cards, tables and alerts. Every app loads it first, then its own styles.
  Change a colour there and every app follows.
- **One Light / Dark setting.** The account menu's **Appearance** (Auto / Light / Dark) applies to every app.
- **The top bar.** Solar Gators logo, **one.solar** (back to the home screen), the app's name and its tabs on the
  left, and the account menu on the right: your name and position, My account & notifications, Appearance and
  Sign out. GatorWire is a built file: `npm run gatorwire` adds the one.solar top bar and light colours to each new build
  (see [docs/gatorwire.md](docs/gatorwire.md)).

- **The app switcher.** ⊞ next to the logo (or **Ctrl + K** / **⌘ K**) opens a grid of every app you can use, with a
  search box, so you can jump between apps without going home. It lists the cards the home screen last showed you
  (admins' links and order included). [`shared/app-switcher.js`](shared/app-switcher.js); one line per app:
  `mountAppSwitcher()`.

### Adding an app
```bash
npm run new-app -- "Parts Library" --icon=🧰 --section=tools --blurb="Every part we stock."
```
This makes `parts-library/index.html` already in the one.solar look (top bar, Light / Dark, app switcher, one.solar
sign-in with the person's name and position) and adds its card to [`hub/apps.js`](hub/apps.js). Build the app in
its `<main>`. Options: `--public` (card shown to everyone), `--no-accounts` (no sign-in, like GatorWire).

Doing it by hand: copy the top bar from any app (`.topbar` › `.brand` with `.brand-app`, then a `<nav class="nav">`
for tabs and `<div class="topbar-end" id="account">`), load `../shared/theme.js` and `../shared/onesolar.css`, call
`renderAccount(…)` and `mountAppSwitcher()`, and add an entry to `hub/apps.js`. Use the shared classes (`.container`,
`.card`, `.btn`, `.btn-primary`, `.btn-sm`, `.field`, `.table`, `.badge`, `.alert-info`…) and colour tokens
(`var(--surface)`, `var(--border)`, `var(--orange)`, `var(--muted)`…) instead of hex colours, so dark mode comes for free.

## The home screen
Cards grouped under headings (**Team apps**, **Engineering tools**, **Links**), from [`hub/apps.js`](hub/apps.js).
Signed in, it shows the apps your position can use: Sponsors needs **See / Edit sponsors**, Finances needs
**See / Edit Finances**, and the Queue shortcut needs **Review** or **Order** requests. Hiding a card is only for
tidiness: each app's database rules decide who sees what, and anyone can type an app's address.

**For everyone.** ☆ on a card makes it a favourite: favourites go to the top (kept in that browser). With seven or
more cards there's a search box (**/** or **Ctrl + K** jumps to it, **Enter** opens the first match).

**✎ Edit home screen** (admins with **Customize lists & appearance**), with no code:
- **+ Add a link**: a card for any other site (`https://…`), a shared drive folder, or a new app's folder (`parts/`),
  with its own name, icon, description and section.
- **Move cards**: drag them, within or between sections, or use ↑ ↓ on each card.
- **Sections**: add, rename, reorder (↑ ↓), and remove empty ones.
- **✎ Edit** a card: rename it, change its description or icon, move it to another section, and choose who sees it:
  **Default** (the rule in `hub/apps.js`), **Everyone, even signed out**, **Anyone signed in**, **Only these
  positions…**, or **Hidden from everyone**. **Back to default** undoes your changes to a built-in card.

**Save changes** applies it for everyone. It's stored in the database's settings "onesolar" (migration
`029_onesolar.sql`, no new migration needed): only what differs from `hub/apps.js`, so later changes to that file
still show through.

## Running it locally
```bash
npm install
npm run dev:fake
```
Open http://localhost:5173/. `dev:fake` needs no database: Orders runs every migration in an in-browser Postgres,
and the home screen and Solar Evals use stand-ins (`/?fake`, `/?fake=admin`, `/evals/?fake`). `npm run dev` uses the
real database. `npm test` runs the database, notification and import tests, and checks what gets published;
`npm run test:smoke` opens every app in a browser (run `npx playwright install chromium` once first).

## Publishing
Merging to `main` (through a pull request; it merges itself when **Tests** pass) runs the tests and then publishes the site with the **Deploy site** workflow: nothing is
published if a test fails. Setup, releasing, checking what's live and reverting: **[docs/RELEASING.md](docs/RELEASING.md)**.
Since 2026-11-14 Pages publishes through that tested deploy (Source: **GitHub Actions**), at **https://one.ufsolargators.org/**.
Everything committed here is public; spreadsheets are kept out by `.gitignore`.

The custom domain `one.ufsolargators.org` is set in **Settings → Pages → Custom domain**, with a CNAME DNS record
pointing at `solar-gators.github.io`. The apps link to each other with relative paths, so they all move together.
Then add the new address to Supabase → Authentication → URL Configuration, and update Admin → one.solar → Notifications →
Website address.

## Handing over one.solar (read this if you're the new admin)

You don't need to be a programmer to run this. Day to day it runs itself; you step in to add people, ship a change
(usually written with an AI assistant), or fix something. This section is the map. The details are in `docs/`.

### What you're taking over

| Piece | What it does | Where it lives |
| --- | --- | --- |
| The website | Every app's pages | This repo, published by GitHub Pages at https://one.ufsolargators.org/ |
| The database | Requests, finances, sponsors, evals, people, sign-ins, attached files | Supabase (organization "UF Solar Gators", project "Orders Form", free plan) |
| Database updates | New tables and functions for new features | `supabase/migrations/`, run automatically by Supabase when they reach `main` |
| Notifications | Email / Teams messages | The `send-notifications` Edge Function, run every 5 minutes by a scheduled job (`cron`) |
| The address | `one.ufsolargators.org` | A CNAME DNS record (Cloudflare, for `ufsolargators.org`) pointing at `solar-gators.github.io` |
| Backups | A nightly copy of the database | A separate **private** repo running `docs/ops/nightly-backup.yml` ([docs/RECOVERY.md](docs/RECOVERY.md)) |

### The handover checklist (old admin and new admin, together)

Do this before the old admin graduates: several pieces are tied to one person's accounts and break quietly once
that account goes away.

1. **one.solar:** Admin → one.solar → **Users**: give the new admin the **Admin** role (and "Manage people").
2. **Supabase:** Organization settings → **Team** → invite them as **Owner** (not just Developer), so they can change
   settings, run SQL and restore the project if it's paused.
3. **GitHub:** the `Solar-Gators` organization → this repo → Settings → **Collaborators and teams** → give them
   **Admin**. Admin is what lets them change settings, and push straight to `main` past the rules when needed.
4. **Supabase ↔ GitHub link:** it was authorised with the old admin's GitHub account. The new admin opens
   Supabase → Settings → **Integrations → GitHub**, disconnects and reconnects it as themselves (repo
   `Solar-Gators/one.solar`, working directory `.`, **Deploy to production** on, branch `main`).
5. **Secrets → the team's password manager** (never in this repo, never in chat):
   the Supabase database password, `CRON_SECRET`, the backup encryption passphrase, the team Gmail's password
   and app password (if email is set up), and the Power Automate `FLOW_URL` (if Teams is set up).
6. **Power Automate flow** (Teams messages): flow → **Share** → add the new admin as co-owner. It runs under the
   builder's UF account and dies with it.
7. **DNS:** make sure the new admin (or the team's web lead) can log in to Cloudflare for `ufsolargators.org`.
8. **Backup repo:** give them access to the private backup repository and check the last nightly run is green.
9. **AI assistant:** they set up Claude Code (or another assistant) as below. Nothing is tied to the old admin's account.
10. **Then** the yearly steps (new season, roles, approval rules naming people who left):
    [docs/MAINTAINING.md → Yearly handover checklist](docs/MAINTAINING.md#yearly-handover-checklist).
11. Last: the old admin removes their own Admin role in one.solar (and leaves the Supabase org / repo, or is
    downgraded), once the new admin has confirmed every step above works.

### How a change goes live

```
your branch → pull request → "Tests" run (about 5 min) → auto-merge into main
   → GitHub Pages republishes the site (about 2 min)
   → Supabase runs any new database migration and redeploys send-notifications
```

- `main` is protected: changes come through a pull request, and it only merges when **Tests** pass. Tick
  **Enable auto-merge** on the PR and it merges itself. If Tests fail, nothing changes anywhere.
- Check what's live: https://one.ufsolargators.org/version.json shows the commit. If the website and database are
  out of step, leads see a yellow banner saying which update is missing.
- Undo a bad change: [docs/RELEASING.md → Reverting](docs/RELEASING.md#reverting-a-front-end-change).

### Making changes with an AI assistant ("vibecoding")

Most changes to one.solar were written with [Claude Code](https://claude.com/claude-code). You describe what you
want; it reads the code, makes the change, runs the tests and opens the pull request. You stay the reviewer.

**Set up once (Windows, Mac or Linux):**
1. Install [Git](https://git-scm.com/), [Node.js 20+](https://nodejs.org/), and the [GitHub CLI](https://cli.github.com/)
   (`winget install GitHub.cli` on Windows), then `gh auth login`.
2. Install Claude Code: the Claude desktop app (Code tab), or `npm install -g @anthropic-ai/claude-code` and run `claude`.
3. Get the code and the tools:
   ```bash
   gh repo clone Solar-Gators/one.solar
   cd one.solar
   npm install
   npx playwright install chromium
   ```
4. Try it: `npm run dev:fake`, then open http://localhost:5173/. Fake mode runs the whole site with a pretend
   database inside your browser. Nothing touches the real data, so try anything.

**The rules the AI follows** are in [`CLAUDE.md`](CLAUDE.md). Claude Code reads it automatically: no secrets in
the repo, never edit a migration that already ran, never run SQL on the live database itself, tests must pass,
changes go through a PR. Keep that file up to date when you learn something the hard way.

**A good session looks like this:**
1. Say what you want in plain words, the way a member would: *"On the Sponsors board, let me filter by who's the
   lead"*, *"The Treasurer wants a 'Waiting on quote' step"*. Mention who uses it and why.
2. Ask it to **show you** before shipping: *"Run it in fake mode and take a screenshot"*, or open
   http://localhost:5173/ yourself.
3. *"Run `npm test` and `npm run test:smoke`."* Both must pass.
4. *"Open a PR with auto-merge."* (Or for a tiny website-only fix you've checked: *"push to main"*.)
5. **If there's a database migration** (a new file in `supabase/migrations/`): read what it does in plain words
   (ask the AI to explain it), and make sure there's a recent backup. It runs on the live database the moment
   the PR merges.

**Watch out for:**
- Anything asking you to paste a secret key, password or `CRON_SECRET` into the code or the chat: don't.
  Secrets go in Supabase (Edge Functions → Secrets, or Vault) and the password manager.
- Big "rewrite everything" changes. Ask for small steps, one PR each; they're easier to check and to undo.
- A change that makes tests pass by deleting or loosening tests. Ask why.
- Real people's data in examples, screenshots or committed files. The repo is **public**.

### When something goes wrong

| What you see | Where to look |
| --- | --- |
| Someone deleted something by mistake | **Recently deleted** at the bottom of Finances / Sponsors (90 days), or the request's History |
| Errors people hit | Admin → one.solar → **Diagnostics** |
| Yellow "Database update needed" banner | A migration didn't run: Supabase → Integrations → GitHub shows why ([docs/MAINTAINING.md → Database updates](docs/MAINTAINING.md#database-updates)) |
| Messages not going out | Admin → one.solar → Notifications (log + "Send waiting messages now"); then [docs/MAINTAINING.md → notifications](docs/MAINTAINING.md#email--teams-notifications) |
| The whole site says it can't reach the database | Supabase pauses free projects after a week without use: Supabase dashboard → **Restore project** |
| A change broke the site | Revert it ([docs/RELEASING.md](docs/RELEASING.md#reverting-a-front-end-change)) |
| Data is actually lost | [docs/RECOVERY.md](docs/RECOVERY.md) |
