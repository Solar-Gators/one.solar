/**
 * OneSolar home screen: a card per app (js/apps.js), shown or hidden by who's
 * signed in. Sign-in uses the Order Form's accounts (its Supabase project).
 * Every app lives on solar-gators.github.io, so signing in here, in the Order
 * Form or in Solar Evals signs you in to all of them; so does the Light / Dark choice.
 *
 * Admins (Order Form permission "Customize lists & appearance", site.customize)
 * choose per card who sees it, or hide it: Customize cards. The choices are saved
 * in the Order Form's settings ("onesolar", migration 029_onesolar.sql).
 *
 * On localhost, ?fake (or ?fake=admin, ?fake=treasurer, ?fake=coordinator, ?fake=out)
 * uses a made-up account instead of the real database.
 */
import { APPS } from './apps.js';

const SUPABASE_URL = 'https://xvacijpdfqccsigcoctg.supabase.co';
// The publishable key is public by design: the database's row-level security protects the data.
const SUPABASE_ANON_KEY = 'sb_publishable_XI0bjN64ejNPSkG2ZCk3ZQ_rkskphBu';
const ORDERS = '/Orders-Form/';

const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const FAKE = isLocal && new URLSearchParams(location.search).has('fake');
// Links are site paths (/Orders-Form/…). Locally there's nothing at those paths, so point them at the live site.
const SITE = isLocal ? 'https://solar-gators.github.io' : '';
const url = (href) => (/^https?:/.test(href) ? href : SITE + href);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (sel) => document.querySelector(sel);

const sb = FAKE
  ? (await import('./fake.js')).createFakeClient(new URLSearchParams(location.search).get('fake'))
  : (await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm')).createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { flowType: 'pkce', persistSession: true, detectSessionInUrl: false },
    });

const me = { user: null, name: '', roles: [], perms: new Set() };
// Settings "onesolar": { cards: { [app id]: { show, roles } } }; see 029_onesolar.sql.
let settings = { cards: {} };
let positions = []; // [{ key, label }] from the Order Form's roles, for Customize cards
let customizing = false;

async function loadSettings() {
  const { data } = await sb.from('app_settings').select('value').eq('key', 'onesolar').maybeSingle();
  settings = { cards: {}, ...(data?.value || {}) };
}

/** Same as the Order Form: roles from profile_roles, permissions from role_permissions. */
async function loadMe() {
  const { data } = await sb.auth.getSession();
  me.user = data.session?.user || null;
  me.perms = new Set();
  me.roles = [];
  if (!me.user) return;
  const [{ data: profile }, { data: roles }] = await Promise.all([
    sb.from('profiles').select('full_name, email').eq('id', me.user.id).maybeSingle(),
    sb.from('profile_roles').select('role').eq('user_id', me.user.id),
  ]);
  me.name = profile?.full_name || me.user.email || '';
  me.roles = (roles || []).map((r) => r.role);
  if (!me.roles.length) me.roles = ['member'];
  const { data: perms } = await sb.from('role_permissions').select('permission').in('role', me.roles);
  me.perms = new Set((perms || []).map((p) => p.permission));
}

const allowed = (access = 'public') =>
  access === 'public' || (!!me.user && (access === 'signedIn' || (Array.isArray(access) && access.some((p) => me.perms.has(p)))));

const choiceOf = (app) => settings.cards?.[app.id] || { show: 'default' };
/** Whether this person sees the card: the admins' choice, or else the app list's own rule. */
function sees(app) {
  const c = choiceOf(app);
  if (c.show === 'hidden') return false;
  if (c.show === 'everyone') return true;
  if (c.show === 'signedIn') return !!me.user;
  if (c.show === 'roles') return !!me.user && (c.roles || []).some((r) => me.roles.includes(r));
  return allowed(app.access);
}
const canCustomize = () => me.perms.has('site.customize');

// What the app list's own rule means, in words, for the Customize panel.
const PERM_WORDS = {
  'sponsors.view': 'see Sponsors', 'sponsors.edit': 'edit Sponsors', 'finances.view': 'see Finances', 'finances.edit': 'edit Finances',
  'request.review': 'review requests', 'request.order': 'order requests', 'evals.view': 'see evaluations', 'evals.write': 'write evaluations',
};
const defaultWords = (access = 'public') =>
  access === 'public' ? 'everyone' : access === 'signedIn' ? 'anyone signed in' : `people who can ${access.map((p) => PERM_WORDS[p] || p).join(' or ')}`;

// ---- Drawing ---------------------------------------------------------------------------

function greeting() {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return me.user ? `${part}, ${esc(me.name.split(' ')[0])}` : 'Welcome to OneSolar';
}

function draw() {
  const shown = APPS.filter(sees);
  const locked = APPS.filter((a) => !sees(a) && choiceOf(a).show !== 'hidden');
  $('#account').innerHTML = me.user
    ? `<span class="who" title="${esc(me.user.email)}">${esc(me.name)}</span>
       <button type="button" class="btn btn-ghost btn-sm" id="sign-out">Sign out</button>`
    : '<button type="button" class="btn btn-primary btn-sm" id="sign-in-open">Sign in</button>';
  $('#hello').innerHTML = greeting();
  $('#lede').textContent = me.user
    ? 'Everything Solar Gators, in one place. Pick an app.'
    : 'Solar Gators\' team apps, in one place. Sign in with your Order Form account to see everything you have access to.';
  $('#apps').innerHTML = shown
    .map((a) => {
      const links = (a.links || []).filter((l) => allowed(l.access || a.access));
      return `<article class="app-card app-${esc(a.id)}">
        <a class="app-main" href="${esc(url(a.href))}">
          <span class="app-icon" aria-hidden="true">${esc(a.icon)}</span>
          <span class="app-text">
            <span class="app-name">${esc(a.name)}</span>
            <span class="app-blurb">${esc(a.blurb)}</span>
            ${a.note ? `<span class="app-note">${esc(a.note)}</span>` : ''}
          </span>
          <span class="app-go" aria-hidden="true">→</span>
        </a>
        ${links.length ? `<nav class="app-links" aria-label="${esc(a.name)} shortcuts">${links.map((l) => `<a href="${esc(url(l.href))}">${esc(l.label)}</a>`).join('')}</nav>` : ''}
      </article>`;
    })
    .join('');
  const forAll = locked.filter((a) => (choiceOf(a).show === 'default' ? a.access === 'signedIn' : choiceOf(a).show === 'signedIn'));
  $('#more').innerHTML = !me.user && locked.length
    ? `<p class="muted"><button type="button" class="link-btn" id="sign-in-open">Sign in</button> for ${forAll.length ? `${forAll.map((a) => esc(a.name)).join(', ')}, and ` : ''}the apps your position can use.</p>`
    : '';
  if (!shown.length) $('#apps').innerHTML = `<p class="muted">No apps to show${me.user ? ' for your position yet' : ''}.</p>`;
  $('#customize-open').hidden = !canCustomize() || customizing;
  drawCustomize();
}

// ---- Customize cards (admins) -------------------------------------------------------------

const SHOW = [
  ['default', 'Default'],
  ['everyone', 'Everyone, even signed out'],
  ['signedIn', 'Anyone signed in'],
  ['roles', 'Only these positions…'],
  ['hidden', 'Hidden from everyone'],
];
let draft = null;

function drawCustomize() {
  const box = $('#customize');
  if (!customizing) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = `<h2>Customize cards</h2>
    <p class="muted">Choose who sees each card on the home screen. <strong>Default</strong> follows the app's own rule.
      This only tidies the home screen: each app's own permissions still decide what people can do in it.</p>
    <div class="cz-list">${APPS.map((a) => {
      const c = draft[a.id] || { show: 'default', roles: [] };
      return `<div class="cz-row" data-app="${esc(a.id)}">
        <div class="cz-app"><span class="app-icon cz-icon" aria-hidden="true">${esc(a.icon)}</span>
          <div><strong>${esc(a.name)}</strong><div class="muted small">Default: ${esc(defaultWords(a.access))}</div></div></div>
        <div class="cz-choice">
          <select data-show aria-label="Who sees ${esc(a.name)}">${SHOW.map(([k, l]) => `<option value="${k}" ${k === (c.show || 'default') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
          ${c.show === 'roles' ? `<div class="cz-roles">${positions.map((p) => `<label><input type="checkbox" data-role="${esc(p.key)}" ${(c.roles || []).includes(p.key) ? 'checked' : ''}> ${esc(p.label)}</label>`).join('')}</div>` : ''}
        </div>
      </div>`;
    }).join('')}</div>
    <p class="form-error" id="cz-error" role="alert" hidden></p>
    <div class="form-actions">
      <button type="button" class="btn btn-ghost" id="cz-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="cz-save">Save</button>
    </div>`;
}

function bindCustomize() {
  const box = $('#customize');
  document.addEventListener('click', async (e) => {
    if (e.target.closest('#customize-open')) {
      if (!positions.length) {
        const { data } = await sb.from('roles').select('key, label').order('sort');
        positions = data || [];
      }
      draft = structuredClone(settings.cards || {});
      customizing = true;
      draw();
      box.scrollIntoView({ block: 'nearest' });
    }
    if (e.target.closest('#cz-cancel')) {
      customizing = false;
      draw();
    }
    if (e.target.closest('#cz-save')) {
      const err = $('#cz-error');
      // Only keep what differs from the default.
      const cards = Object.fromEntries(Object.entries(draft).filter(([, c]) => c.show && c.show !== 'default')
        .map(([id, c]) => [id, c.show === 'roles' ? { show: 'roles', roles: c.roles || [] } : { show: c.show }]));
      const empty = Object.entries(cards).find(([, c]) => c.show === 'roles' && !c.roles.length);
      if (empty) {
        err.textContent = `Pick at least one position for ${APPS.find((a) => a.id === empty[0])?.name || empty[0]}, or hide it.`;
        err.hidden = false;
        return;
      }
      e.target.disabled = true;
      const { error } = await sb.rpc('update_settings', { p_key: 'onesolar', p_value: { ...settings, cards } });
      e.target.disabled = false;
      if (error) {
        err.textContent = /Unknown settings key/.test(error.message)
          ? 'The database needs the Order Form update 029_onesolar.sql first (Supabase → SQL Editor).'
          : error.message;
        err.hidden = false;
        return;
      }
      settings = { ...settings, cards };
      customizing = false;
      draw();
    }
  });
  box.addEventListener('change', (e) => {
    const row = e.target.closest('[data-app]');
    if (!row) return;
    const c = (draft[row.dataset.app] ||= { show: 'default', roles: [] });
    if (e.target.matches('[data-show]')) {
      c.show = e.target.value;
      drawCustomize();
    } else if (e.target.dataset.role) {
      const set = new Set(c.roles || []);
      if (e.target.checked) set.add(e.target.dataset.role);
      else set.delete(e.target.dataset.role);
      c.roles = positions.map((p) => p.key).filter((k) => set.has(k));
    }
  });
}

// ---- Sign in (the Order Form's accounts) -----------------------------------------------

function bindSignIn() {
  const dialog = $('#sign-in');
  const form = $('#sign-in-form');
  const err = $('#sign-in-error');
  $('#sign-up-link').href = url(ORDERS);
  $('#forgot-link').href = url(ORDERS);
  document.addEventListener('click', async (e) => {
    if (e.target.closest('#sign-in-open')) {
      err.hidden = true;
      form.reset();
      dialog.showModal();
      form.email.focus();
    }
    if (e.target.closest('#sign-in-cancel')) dialog.close();
    if (e.target.closest('#sign-out')) {
      await sb.auth.signOut();
      await loadMe();
      customizing = false;
      draw();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    err.hidden = true;
    const { error } = await sb.auth.signInWithPassword({ email: form.email.value.trim(), password: form.password.value });
    btn.disabled = false;
    if (error) {
      err.textContent = /invalid/i.test(error.message) ? 'That email and password don\'t match an Order Form account.' : error.message;
      err.hidden = false;
      return;
    }
    dialog.close();
    await loadMe();
    draw();
  });
}

// ---- Light / dark (shared with the Order Form: localStorage "theme") -----------------------

function bindTheme() {
  const set = (t) => {
    try {
      if (t === 'auto') localStorage.removeItem('theme');
      else localStorage.setItem('theme', t);
    } catch {}
    const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('#theme').textContent = dark ? '☀️' : '🌙';
    $('#theme').title = dark ? 'Switch to light' : 'Switch to dark';
    document.querySelector('.brand-logo').src = dark ? 'assets/solar-gators-logo-dark.png' : 'assets/solar-gators-logo.png';
  };
  set((() => { try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; } })());
  $('#theme').addEventListener('click', () => set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
}

bindTheme();
bindSignIn();
bindCustomize();
try {
  await Promise.all([loadMe(), loadSettings()]);
} catch {
  // Database unreachable: still show the public apps.
}
draw();
// Signing in or out in another tab (e.g. the Order Form) updates this one.
window.addEventListener('storage', async (e) => {
  if (e.key && e.key.startsWith('sb-')) {
    await loadMe();
    draw();
  }
});
document.body.classList.add('ready');
