# OneSolar

The home screen for Solar Gators' team apps: one card per app, at
**https://solar-gators.github.io/one.solar/**.

The apps themselves stay where they are, each in its own repo:

| App | Lives at | Uses |
| --- | --- | --- |
| Orders, Sponsors, Finances | [Orders-Form](https://github.com/Solar-Gators/Orders-Form) | Order Form database (Supabase) |
| Solar Evals | [Custom-Apps](https://github.com/Solar-Gators/Custom-Apps) `solarevals.html` | Order Form database |
| GatorWire | Custom-Apps `gatorwire.html` | GitHub (Gator-Wire repo) or files |
| CE Scope Map | Custom-Apps `responsibilitymap.html` | none |

## One sign-in
Everything is on `solar-gators.github.io`, so the browser treats it as one site: signing in here,
in the Order Form or in Solar Evals signs you in to all of them (OneSolar accounts, which are the Order Form's).
**Sign in** opens the Order Form's sign-in page (also for new accounts and password resets) and comes back
here afterwards. The Light / Dark choice is shared the same way.

Signed in, the home screen shows the apps your Order Form role can use: Sponsors needs **See / Edit
sponsors**, Finances needs **See / Edit Finances**, and the Queue shortcut needs **Review** or
**Order** requests. Hiding a card is only for tidiness: each app's database rules decide who sees
what, and anyone can type an app's address.

## Choosing who sees each card
Admins (anyone whose Order Form role has **Customize lists & appearance**) get **⚙ Customize cards**
on the home screen. For each card, pick:

- **Default**: the rule in `js/apps.js` (shown under the card's name),
- **Everyone, even signed out**,
- **Anyone signed in**,
- **Only these positions…**: tick the Order Form positions (Member, Chief Engineer, Treasurer…),
- **Hidden from everyone**.

The choice applies to everyone at once, signed in or not. It's stored in the Order Form's database
(settings "onesolar"), which needs the Order Form's `supabase/migrations/029_onesolar.sql` to be run once.

## Adding an app
Add an entry to [`js/apps.js`](js/apps.js): name, one-line blurb, link, icon, and who it's for
(`'public'`, `'signedIn'`, or a list of Order Form permissions). Optional shortcut links go under the card.

## The shared look
[`css/onesolar.css`](css/onesolar.css) holds the Order Form's colours (light and dark), buttons and
the top bar. Other apps can load it from `/one.solar/css/onesolar.css` so a brand change happens in one place.

## Trying it locally
Serve the folder (e.g. `python -m http.server 5180`) and open `http://localhost:5180/?fake` for a
made-up Member. `?fake=admin` (with Customize cards; choices kept in that browser), `?fake=treasurer`, `?fake=coordinator` and `?fake=out` (signed out) show the other
views. Fake mode only works on localhost and never touches the real database. Without `?fake`, the
local page signs in to the real Order Form database, and its links open the live apps.

## Publishing
GitHub → this repo → **Settings → Pages** → Source: **Deploy from a branch**, branch **main**, folder **/ (root)**.
