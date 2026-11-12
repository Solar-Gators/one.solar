/**
 * Start a new OneSolar app:
 *
 *   npm run new-app -- "Parts Library"
 *   npm run new-app -- "Parts Library" --icon=🧰 --section=tools --blurb="Every part we stock." --public
 *
 * It makes <folder>/index.html (folder = the name in lower case with dashes: parts-library/)
 * already in the OneSolar look: the shared top bar (logo → home screen, the app's name, the
 * ⊞ app switcher), Light / Dark, and OneSolar accounts (who's signed in, their name and
 * position, Sign in / Sign out). Then it adds a card for it to hub/apps.js.
 *
 *   --icon=🧰        the card's emoji (default 🧩)
 *   --section=tools  apps | tools | links, or an id admins added (default apps)
 *   --blurb="…"      the card's one-line description
 *   --public         anyone can see the card, signed in or not (default: anyone signed in)
 *   --no-accounts    no sign-in at all (like GatorWire and the CE Scope Map)
 *
 * Then: npm run dev, open http://localhost:5173/<folder>/, and build the app in its <main>.
 * docs/MAINTAINING.md has the rest ("Adding an app").
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (k, d) => {
  const a = args.find((x) => x === `--${k}` || x.startsWith(`--${k}=`));
  return a === undefined ? d : a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
};
const name = args.find((x) => !x.startsWith('--'))?.trim();
if (!name) {
  console.error('Usage: npm run new-app -- "App name" [--icon=🧩] [--section=apps] [--blurb="…"] [--public] [--no-accounts]');
  process.exit(1);
}
const slug = name.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
const RESERVED = ['shared', 'hub', 'tools', 'tests', 'docs', 'supabase', 'node_modules', 'orders', 'finances', 'sponsors', 'admin', 'evals', 'gatorwire', 'scope-map'];
if (!slug || RESERVED.includes(slug)) {
  console.error(`"${slug || name}" can't be a folder name here; pick another name.`);
  process.exit(1);
}
const here = (p) => new URL(`../${p}`, import.meta.url);
if (existsSync(here(slug))) {
  console.error(`${slug}/ already exists.`);
  process.exit(1);
}
const icon = flag('icon', '🧩');
const section = flag('section', 'apps');
const blurb = flag('blurb', `What ${name} is for, in one line.`);
const accounts = !flag('no-accounts', false);
const access = flag('public', false) || !accounts ? "'public'" : "'signedIn'";
const html = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const js = (s) => JSON.stringify(String(s)).slice(1, -1).replace(/'/g, "\\'");

const script = accounts
  ? `import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
  import { SUPABASE_URL, SUPABASE_ANON_KEY, signInUrl } from '../shared/onesolar.js';
  import { renderAccount } from '../shared/account-menu.js';
  import { mountAppSwitcher } from '../shared/app-switcher.js';

  // OneSolar accounts: the same sign-in as every other app (one session for the whole site).
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { flowType: 'pkce', persistSession: true, detectSessionInUrl: false } });
  mountAppSwitcher();

  const { data: { session } } = await sb.auth.getSession();
  const user = session?.user || null;
  let name = '', role = '';
  if (user) {
    const [{ data: profile }, { data: roles }] = await Promise.all([
      sb.from('profiles').select('full_name').eq('id', user.id).maybeSingle(),
      sb.from('profile_roles').select('role').eq('user_id', user.id),
    ]);
    name = profile?.full_name || user.email;
    role = (roles || []).map((r) => r.role).join(' · ') || 'member';
  }
  renderAccount(document.getElementById('account'), {
    user, name, role,
    onSignOut: async () => { await sb.auth.signOut(); location.reload(); },
  });

  const main = document.getElementById('main');
  if (!user) {
    main.innerHTML = \`<div class="card"><h2>${html(name)}</h2><p>Sign in with your OneSolar account to use ${html(name)}.</p>
      <a class="btn btn-primary" href="\${signInUrl()}">Sign in</a></div>\`;
  } else {
    // Your app starts here. sb is a Supabase client signed in as this person: sb.from('table')…
    // Permissions: sb.from('role_permissions').select('permission').in('role', [...their roles]).
    main.innerHTML = \`<div class="card"><h2>Hello, \${name.split(' ')[0]}</h2>
      <p class="muted">This is ${html(name)}. Build it in ${slug}/index.html.</p></div>\`;
  }`
  : `import { renderAccount } from '../shared/account-menu.js';
  import { mountAppSwitcher } from '../shared/app-switcher.js';

  // No accounts here: just the Light / Dark switch at the right.
  renderAccount(document.getElementById('account'), { user: null, signIn: false });
  mountAppSwitcher();

  // Your app starts here.
  document.getElementById('main').innerHTML = \`<div class="card"><h2>${html(name)}</h2>
    <p class="muted">Build it in ${slug}/index.html.</p></div>\`;`;

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${html(name)} · OneSolar</title>
  <link rel="icon" href="../shared/assets/favicon.png">
  <!-- The OneSolar look: Light / Dark first (no flash), then the shared styles. -->
  <script src="../shared/theme.js"></script>
  <link rel="stylesheet" href="../shared/onesolar.css">
  <style>
    /* ${html(name)}'s own styles. The shared ones (../shared/onesolar.css) give you .container, .card,
       .btn (.btn-primary, .btn-ghost, .btn-sm), inputs, .table, .badge, .alert, .tabs and dialogs. */
    main.container { padding-top: 28px; }
    .card h2 { margin: 0 0 6px; color: var(--navy); }
  </style>
</head>
<body>
  <!-- The OneSolar top bar, the same in every app. Add a <nav class="nav"> after .brand for tabs. -->
  <header class="topbar">
    <div class="topbar-inner">
      <a class="brand" href="../" aria-label="OneSolar: all Solar Gators apps">
        <img class="brand-logo" data-auto-logo src="../shared/assets/solar-gators-logo.png" alt="Solar Gators" width="800" height="237">
        <span class="brand-divider" aria-hidden="true"></span>
        <span>One<span class="brand-accent">Solar</span></span>
        <span class="brand-app">${html(name)}</span>
      </a>
      <div class="topbar-end" id="account"></div>
    </div>
  </header>

  <main class="container" id="main"></main>

  <script type="module">
  ${script}
  </script>
</body>
</html>
`;

mkdirSync(here(slug));
writeFileSync(here(`${slug}/index.html`), page);

// The card on the home screen: added at the end of APPS in hub/apps.js.
const appsFile = here('hub/apps.js');
const apps = readFileSync(appsFile, 'utf8');
const end = apps.lastIndexOf('];');
const card = `  {
    id: '${slug}',
    section: '${js(section)}',
    name: '${js(name)}',
    blurb: '${js(blurb)}',
    href: '${slug}/',
    icon: '${js(icon)}',
    access: ${access},
  },
`;
writeFileSync(appsFile, apps.slice(0, end) + card + apps.slice(end));

console.log(`Made ${slug}/index.html and added its card to hub/apps.js.
  Try it:   npm run dev, then http://localhost:5173/${slug}/
  Card:     change its icon, blurb, section or who sees it in hub/apps.js (or on the home screen: ✎ Edit home screen).`);
