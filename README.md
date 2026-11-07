# OneSolar

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
(e.g. an old `orders/#/sponsors/…` email link) opens it in that app. Admin covers every app: people, positions and
permissions, the request form, approval rules, notifications and the season.

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
- **The top bar.** Solar Gators logo, **OneSolar** (back to the home screen), the app's name and its tabs on the
  left, and the account menu on the right: your name and position, My account & notifications, Appearance and
  Sign out. GatorWire is a built file: `npm run gatorwire` adds the OneSolar top bar and light colours to each new build
  (see [docs/gatorwire.md](docs/gatorwire.md)).

### Making a new app look like the rest
```html
<script src="../shared/theme.js"></script>             <!-- light / dark before the page draws -->
<link rel="stylesheet" href="../shared/onesolar.css">
…
<header class="topbar"><div class="topbar-inner">
  <a class="brand" href="../">
    <img class="brand-logo" data-auto-logo src="../shared/assets/solar-gators-logo.png" alt="Solar Gators" width="800" height="237">
    <span class="brand-divider"></span><span>One<span class="brand-accent">Solar</span></span>
    <span class="brand-app">My App</span>
  </a>
  <nav class="nav"><a href="#/one" class="active">One</a><a href="#/two">Two</a></nav>
  <div class="topbar-end" id="account"></div>
</div></header>
<script type="module">
  import { SUPABASE_URL, SUPABASE_ANON_KEY, appUrl, signInUrl } from '../shared/onesolar.js';
  import { renderAccount } from '../shared/account-menu.js';
  renderAccount(document.getElementById('account'), { user, name, role, onSignOut });
</script>
```
Then use the shared classes (`.container`, `.card`, `.btn`, `.btn-primary`, `.btn-sm`, `.field`, `.table`, `.badge`,
`.alert-info`…) and colour tokens (`var(--surface)`, `var(--border)`, `var(--orange)`, `var(--muted)`…) instead of
hex colours, so dark mode comes for free. Then add the app to the home screen (below).

## The home screen
One card per app, from [`hub/apps.js`](hub/apps.js). Signed in, it shows the apps your position can use:
Sponsors needs **See / Edit sponsors**, Finances needs **See / Edit Finances**, and the Queue shortcut needs
**Review** or **Order** requests. Hiding a card is only for tidiness: each app's database rules decide who sees
what, and anyone can type an app's address.

**Choosing who sees each card.** Admins (**Customize lists & appearance**) get **⚙ Customize cards**. For each card:
**Default** (the rule in `hub/apps.js`), **Everyone, even signed out**, **Anyone signed in**, **Only these
positions…**, or **Hidden from everyone**. It applies to everyone at once and is stored in the database's
settings "onesolar" (migration `029_onesolar.sql`).

**Adding an app.** Put it in its own folder with an `index.html`, then add an entry to
[`hub/apps.js`](hub/apps.js): name, one-line blurb, link (the folder, e.g. `'my-app/'`), icon, and who it's for
(`'public'`, `'signedIn'`, or a list of permissions). Optional shortcut links go under the card.

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
Then add the new address to Supabase → Authentication → URL Configuration, and update Admin → Notifications →
Website address.
