# one.solar

Every Solar Gators team app, in one place and one repo: **https://solar-gators.github.io/one.solar/**

| App | Address | Folder | Guide |
| --- | --- | --- | --- |
| Home screen | `/one.solar/` | `index.html`, [`hub/`](hub) | below |
| Orders | `/one.solar/orders/` | [`orders/`](orders) | [docs/orders.md](docs/orders.md) |
| Finances | `/one.solar/finances/` | [`finances/`](finances) | [docs/orders.md](docs/orders.md#finances-treasurer) |
| Sponsors | `/one.solar/sponsors/` | [`sponsors/`](sponsors) | [docs/orders.md](docs/orders.md#sponsors-business-coordinator) |
| Admin (people, permissions, settings) | `/one.solar/admin/` | [`admin/`](admin) | [docs/orders.md](docs/orders.md#admin) |
| Solar Evals | `/one.solar/evals/` | [`evals/`](evals) | [docs/solar-evals.md](docs/solar-evals.md) |
| GatorWire | `/one.solar/gatorwire/` | [`gatorwire/`](gatorwire) | [docs/gatorwire.md](docs/gatorwire.md) |
| CE Scope Map | `/one.solar/scope-map/` | [`scope-map/`](scope-map) | an editable four-way Venn diagram of Chief Engineer responsibilities |
| Solar Gators website | https://ufsolargators.org/ | (its own repo, Advertisement-Website) | a card on the home screen |

Orders, Finances, Sponsors and Admin are separate apps (each its own address, top bar and menu) built from the same
code in `orders/js/`: each app's `index.html` says which it is (`<body data-app="finances">`), and
[`orders/js/appMode.js`](orders/js/appMode.js) decides which pages belong where. A link to another app's page
(e.g. an old `orders/#/sponsors/…` email link) opens it in that app. Admin is grouped by where a setting applies: **one.solar** (every app: people, positions and permissions, the season,
logo, banner, notifications, home screen), **Orders** (the request form, approvals, lists), and **Other apps** (where
Sponsors, Finances and Solar Evals keep their own settings, inside each app).

Orders, Finances, Sponsors, Admin and Solar Evals share one Supabase database ([`supabase/`](supabase)). For setting it up,
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
real database. `npm test` runs the database, notification and import tests.

## Publishing
GitHub → this repo → **Settings → Pages** → **Deploy from a branch**, branch **main**, folder **/ (root)**.
Everything committed here is public; spreadsheets are kept out by `.gitignore`.

A custom domain (e.g. `one.ufsolargators.org`) can go in **Settings → Pages → Custom domain**, with a CNAME DNS record
pointing at `solar-gators.github.io`. The apps link to each other with relative paths, so they all move together.
Then add the new address to Supabase → Authentication → URL Configuration, and update Admin → one.solar → Notifications →
Website address.
