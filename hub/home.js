/**
 * one.solar home screen: a card per app, grouped under headings, shown or hidden by who's signed in.
 *
 * The cards are hub/apps.js (the built-in apps) plus what admins change on the page itself
 * (✎ Edit home screen, needs "Customize lists & appearance", site.customize):
 *   - add a link to any other site (or a new app's folder), with its own name, icon and description,
 *   - drag cards (or use the arrows) to reorder them, and move them between sections,
 *   - add, rename, reorder and remove sections,
 *   - rename / re-describe / re-icon any card, and choose who sees it.
 * Saved in the database's settings "onesolar" (migration 029_onesolar.sql):
 *   { cards:    { [id]: { show, roles, name, blurb, icon, section } },   // changes to any card
 *     links:    [ { id, name, href, icon, blurb } ],                     // cards admins added
 *     order:    [ id, … ],                                               // card order
 *     sections: [ { id, name }, … ] }                                    // headings, in order
 *
 * Everyone can also star cards (★): favourites go to the top, in this browser. With many cards a
 * search box appears ("/" jumps to it). The cards you see are remembered for the app switcher
 * (shared/app-switcher.js) in every app's top bar.
 *
 * Signing in happens on the shared sign-in page (orders/), which sends you back here.
 * On localhost, ?fake (or ?fake=admin, ?fake=treasurer, ?fake=coordinator, ?fake=guest, ?fake=out)
 * uses a made-up account instead of the real database.
 */
// A namespace import, so a browser still holding an older cached apps.js (GitHub Pages caches files
// for 10 minutes) gets the default sections instead of a blank page.
import * as appList from './apps.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, appUrl, isLocal, signInUrl, rememberBrand } from '../shared/onesolar.js';
import { renderAccount, syncLogo } from '../shared/account-menu.js';
import { rememberApps, safeHref } from '../shared/app-switcher.js';

const APPS = appList.APPS || [];
const SECTIONS = appList.SECTIONS || [{ id: 'apps', name: 'Team apps' }, { id: 'tools', name: 'Engineering tools' }, { id: 'links', name: 'Links' }];

const FAKE = isLocal && new URLSearchParams(location.search).has('fake');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (sel, root = document) => root.querySelector(sel);

const sb = FAKE
  ? (await import('./fake.js')).createFakeClient(new URLSearchParams(location.search).get('fake'))
  : (await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm')).createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { flowType: 'pkce', persistSession: true, detectSessionInUrl: false },
    });

const me = { user: null, name: '', roles: [], perms: new Set(), roleLabel: '', guest: false };
let waiting = []; // 040: people who signed up and wait to be accepted (for those who can accept them)
let settings = { cards: {} };
let appearance = {}; // Admin → one.solar → Logo & accent, Banner & messages
let positions = []; // [{ key, label }]: the positions, for "Only these positions…"
let editing = false;
let draft = null; // a copy of the settings while editing; saved with Save changes
let draftStart = ''; // the draft as it started, to tell whether anything changed
let query = '';

async function loadSettings() {
  const [{ data }, { data: look }] = await Promise.all([
    sb.from('app_settings').select('value').eq('key', 'onesolar').maybeSingle(),
    sb.from('app_settings').select('value').eq('key', 'appearance').maybeSingle(),
  ]);
  settings = { cards: {}, ...(data?.value || {}) };
  appearance = look?.value || {};
  // The logo and accent, for every app. Only when the settings could be read (signed out they may
  // not be), so a signed-out visit doesn't forget them.
  if (look) {
    rememberBrand(appearance);
    syncLogo();
  }
}

/** The announcement banner (Admin → one.solar → Banner & messages), for signed-in people, until its end date. */
function drawAnnouncement() {
  const box = $('#announcement');
  const ann = appearance.announcement;
  const today = new Date().toISOString().slice(0, 10);
  const show = !!me.user && !!ann?.text && (!ann.until || today <= ann.until);
  box.hidden = !show;
  const tone = ['info', 'warning', 'success', 'error'].includes(ann?.tone) ? ann.tone : 'info';
  box.className = `announcement announcement-${tone}`;
  // Plain text with line breaks (the apps' banner also allows **bold** and links; kept simple here).
  box.innerHTML = show ? `<div class="container">${String(ann.text).split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>` : '';
}

/** Same as Orders: roles from profile_roles, permissions from role_permissions. */
async function loadMe() {
  const { data } = await sb.auth.getSession();
  me.user = data.session?.user || null;
  me.perms = new Set();
  me.roles = [];
  me.guest = false;
  waiting = [];
  if (!me.user) return;
  const [{ data: profile }, { data: roles }] = await Promise.all([
    sb.from('profiles').select('full_name, email').eq('id', me.user.id).maybeSingle(),
    sb.from('profile_roles').select('role').eq('user_id', me.user.id),
  ]);
  me.name = profile?.full_name || me.user.email || '';
  me.roles = (roles || []).map((r) => r.role);
  if (!me.roles.length) me.roles = ['guest'];
  me.guest = me.roles.every((r) => r === 'guest'); // 040: signed up, not accepted into the team yet
  const [{ data: perms }, { data: labels }] = await Promise.all([
    sb.from('role_permissions').select('permission').in('role', me.roles),
    sb.from('roles').select('key, label').in('key', me.roles),
  ]);
  me.perms = new Set((perms || []).map((p) => p.permission));
  me.roleLabel = me.roles.map((r) => (labels || []).find((l) => l.key === r)?.label || r).join(' · ');
  await loadWaiting();
}

/** Who is waiting to be accepted into the team (040), for anyone who can accept them. */
async function loadWaiting() {
  waiting = [];
  if (!me.user || me.guest || !me.perms.has('people.accept')) return;
  const { data, error } = await sb.rpc('waiting_guests', {});
  if (!error && Array.isArray(data)) waiting = data;
}

function drawWaiting() {
  const box = $('#waiting');
  box.hidden = editing || !waiting.length;
  if (box.hidden) return (box.innerHTML = '');
  const ago = (d) => {
    const days = Math.floor((Date.now() - new Date(d)) / 864e5);
    return days < 1 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  };
  box.innerHTML = `<h2 class="section-title">Waiting to join the team (${waiting.length})</h2>
    <p class="muted small">They signed up for one.solar. Until someone accepts them they only see the public tools.
      Only accept people you know are on Solar Gators.</p>
    <ul class="waiting-list">${waiting.map((w) => `<li data-guest="${esc(w.id)}">
      <span class="waiting-who"><strong>${esc(w.full_name || w.email)}</strong>${w.full_name ? ` <span class="muted">${esc(w.email)}</span>` : ''}
        <span class="muted small">· signed up ${ago(w.created_at)}</span></span>
      <button type="button" class="btn btn-sm btn-primary" data-accept="${esc(w.id)}">Accept as Member</button></li>`).join('')}</ul>
    <p class="alert alert-error" id="waiting-error" role="alert" hidden></p>`;
}

async function accept(btn) {
  const w = waiting.find((x) => x.id === btn.dataset.accept);
  if (!w) return;
  btn.disabled = true;
  btn.textContent = 'Accepting…';
  const { error } = await sb.rpc('accept_member', { p_user: w.id });
  if (error) {
    btn.disabled = false;
    btn.textContent = 'Accept as Member';
    const e = $('#waiting-error');
    e.textContent = error.message;
    e.hidden = false;
    return;
  }
  waiting = waiting.filter((x) => x !== w);
  drawWaiting();
  const note = $('#waiting-done');
  note.textContent = `${w.full_name || w.email} is on the team now, as a Member. Give them other roles in Admin → Users if they need them.`;
  note.hidden = false;
}

const canCustomize = () => me.perms.has('site.customize');

// ---- The cards: apps.js + the admins' changes ------------------------------------------------

const isExternal = (href) => /^https?:/i.test(href);
const newId = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

/** Every card, with the admins' changes applied, in order. */
function cardsOf(s) {
  const links = (s.links || [])
    .filter((l) => l && l.id && safeHref(l.href))
    .map((l) => ({ id: l.id, name: l.name || 'Link', blurb: l.blurb || '', href: l.href, icon: l.icon || '🔗', access: 'public', section: 'links', added: true }));
  const all = [...APPS, ...links].map((a) => {
    const o = s.cards?.[a.id] || {};
    return { ...a, name: o.name || a.name, blurb: o.blurb ?? a.blurb, icon: o.icon || a.icon, section: o.section || a.section || 'apps', base: a };
  });
  const order = s.order || [];
  const rank = (id) => (order.includes(id) ? order.indexOf(id) : 1000 + all.findIndex((a) => a.id === id));
  return all.sort((a, b) => rank(a.id) - rank(b.id));
}

/** The sections, in order; any a card uses that isn't listed comes last. */
function sectionsOf(s, cards) {
  const list = (s.sections?.length ? s.sections : SECTIONS).map((x) => ({ ...x }));
  for (const c of cards) if (!list.some((x) => x.id === c.section)) list.push({ id: c.section, name: SECTIONS.find((x) => x.id === c.section)?.name || 'More' });
  return list;
}

// A Guest (040) counts as signed out here: they only get the public cards.
const onTeam = () => !!me.user && !me.guest;
const allowed = (access = 'public') =>
  access === 'public' || (onTeam() && (access === 'signedIn' || (Array.isArray(access) && access.some((p) => me.perms.has(p)))));
const choiceOf = (s, id) => s.cards?.[id] || {};
/** Whether this person sees the card: the admins' choice, or else the app list's own rule. */
function sees(card, s = settings) {
  const c = choiceOf(s, card.id);
  if (c.show === 'hidden') return false;
  if (c.show === 'everyone') return true;
  if (c.show === 'signedIn') return onTeam();
  if (c.show === 'roles') return onTeam() && (c.roles || []).some((r) => me.roles.includes(r));
  return allowed(card.access);
}

const PERM_WORDS = {
  'sponsors.view': 'see Sponsors', 'sponsors.edit': 'edit Sponsors', 'finances.view': 'see Finances', 'finances.edit': 'edit Finances',
  'request.review': 'review requests', 'request.order': 'order requests', 'evals.view': 'see evaluations', 'evals.write': 'write evaluations',
  'users.manage': 'manage people', 'settings.edit': 'edit settings', 'site.customize': 'customize the site', 'seasons.manage': 'manage seasons', 'workflow.edit': 'edit approval rules',
};
const defaultWords = (access = 'public') =>
  access === 'public' ? 'everyone' : access === 'signedIn' ? 'anyone signed in' : `people who can ${access.map((p) => PERM_WORDS[p] || p).join(' or ')}`;
/** Who sees a card, in a few words (shown on each card while editing). */
function whoWords(card, s) {
  const c = choiceOf(s, card.id);
  if (c.show === 'hidden') return 'Hidden from everyone';
  if (c.show === 'everyone') return 'Everyone';
  if (c.show === 'signedIn') return 'Anyone signed in';
  if (c.show === 'roles') return `Only ${(c.roles || []).map((r) => positions.find((p) => p.key === r)?.label || r).join(', ')}`;
  return `Who sees it: ${defaultWords(card.access)}`;
}

// ---- Favourites (★, in this browser) ------------------------------------------------------------

const FAV_KEY = 'onesolar:favorites';
let favs = (() => {
  try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch { return []; }
})();
function toggleFav(id) {
  favs = favs.includes(id) ? favs.filter((f) => f !== id) : [...favs, id];
  try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch {}
  draw();
  $(`[data-fav="${CSS.escape(id)}"]`)?.focus();
}

// ---- Drawing ----------------------------------------------------------------------------------

function greeting() {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return me.user ? `${part}, ${esc(me.name.split(' ')[0])}` : 'Welcome to one.solar';
}

function cardHTML(a, { edit = false, s = settings } = {}) {
  const href = safeHref(a.href) || '#';
  const ext = isExternal(href);
  const links = edit ? [] : (a.links || []).filter((l) => allowed(l.access || a.access));
  const fav = favs.includes(a.id);
  const inner = `<span class="app-icon" aria-hidden="true">${esc(a.icon)}</span>
    <span class="app-text">
      <span class="app-name">${esc(a.name)}${ext ? ' <span class="app-ext" title="Opens in a new tab">↗</span>' : ''}</span>
      <span class="app-blurb">${esc(a.blurb)}</span>
      ${a.note && !edit ? `<span class="app-note">${esc(a.note)}</span>` : ''}
      ${edit ? `<span class="app-who">${esc(whoWords(a, s))}</span>` : ''}
    </span>`;
  if (edit) {
    const hidden = choiceOf(s, a.id).show === 'hidden';
    return `<article class="app-card is-editing${hidden ? ' is-hidden' : ''}" draggable="true" data-card="${esc(a.id)}">
      <div class="app-main"><span class="drag-handle" aria-hidden="true" title="Drag to move">⠿</span>${inner}</div>
      <div class="card-tools">
        <button type="button" class="btn btn-sm" data-edit-card="${esc(a.id)}">✎ Edit</button>
        <span class="spacer"></span>
        <button type="button" class="btn btn-sm btn-ghost" data-move="-1" data-id="${esc(a.id)}" aria-label="Move ${esc(a.name)} earlier" title="Move earlier">↑</button>
        <button type="button" class="btn btn-sm btn-ghost" data-move="1" data-id="${esc(a.id)}" aria-label="Move ${esc(a.name)} later" title="Move later">↓</button>
      </div>
    </article>`;
  }
  return `<article class="app-card app-${esc(a.id)}" data-card="${esc(a.id)}">
    <a class="app-main" href="${esc(ext ? href : appUrl(href))}"${ext ? ' target="_blank" rel="noopener"' : ''}>${inner}</a>
    <button type="button" class="fav${fav ? ' on' : ''}" data-fav="${esc(a.id)}" aria-pressed="${fav}"
      aria-label="Favourite ${esc(a.name)}" title="${fav ? 'Remove from your favourites' : 'Add to your favourites (they go to the top)'}">${fav ? '★' : '☆'}</button>
    ${links.length ? `<nav class="app-links" aria-label="${esc(a.name)} shortcuts">${links.map((l) => `<a href="${esc(appUrl(l.href))}">${esc(l.label)}</a>`).join('')}</nav>` : ''}
  </article>`;
}

function draw() {
  drawAnnouncement();
  renderAccount($('#account'), { user: me.user, name: me.name, role: me.roleLabel, onSignOut: signOut });
  $('#hello').innerHTML = greeting();
  $('#lede').textContent = me.guest
    ? "You're signed up! Someone on the team needs to accept you before you can use the team's apps. Ask your Chief Engineer, a lead or anyone on the e-board. Until then, here are the public tools."
    : me.user
    ? 'Everything Solar Gators, in one place. Pick an app.'
    : 'Solar Gators\' team apps, in one place. Sign in with your one.solar account to see everything you have access to.';
  $('#edit-open').hidden = !canCustomize() || editing;
  document.body.classList.toggle('editing-home', editing);
  drawWaiting();
  if (editing) return drawEditing();

  const cards = cardsOf(settings);
  const shown = cards.filter((c) => sees(c));
  rememberApps(shown.map((c) => ({ ...c, href: safeHref(c.href) })), favs); // for the app switcher in every app's top bar
  const match = (c) => !query || `${c.name} ${c.blurb}`.toLowerCase().includes(query);
  $('#search-wrap').hidden = shown.length < 7 && !query;

  const favCards = shown.filter((c) => favs.includes(c.id) && match(c)).sort((a, b) => favs.indexOf(a.id) - favs.indexOf(b.id));
  const groups = [
    ...(favCards.length ? [{ id: 'favorites', name: '★ Your favourites', cards: favCards }] : []),
    ...sectionsOf(settings, cards).map((x) => ({ ...x, cards: shown.filter((c) => c.section === x.id && !favs.includes(c.id) && match(c)) })),
  ].filter((g) => g.cards.length);
  const titled = groups.length > 1;
  $('#apps').innerHTML = groups.length
    ? groups.map((g) => `<section class="app-section" aria-label="${esc(g.name)}">
        ${titled ? `<h2 class="section-title">${esc(g.name)}</h2>` : ''}
        <div class="apps">${g.cards.map((c) => cardHTML(c)).join('')}</div>
      </section>`).join('')
    : `<p class="muted">${query ? `Nothing matches “${esc(query)}”.` : `No apps to show${me.user ? ' for your position yet' : ''}.`}</p>`;

  const locked = cards.filter((c) => !sees(c) && choiceOf(settings, c.id).show !== 'hidden');
  const forAll = locked.filter((c) => {
    const show = choiceOf(settings, c.id).show || 'default';
    return show === 'signedIn' || (show === 'default' && c.access === 'signedIn');
  });
  $('#more').innerHTML = !me.user && locked.length
    ? `<p class="muted"><a class="link-btn" href="${esc(signInUrl())}">Sign in</a> for ${forAll.length ? `${forAll.map((c) => esc(c.name)).join(', ')}, and ` : ''}the apps your position can use.</p>`
    : '';
}

// ---- Editing the home screen (admins) ---------------------------------------------------------

function drawEditing() {
  const cards = cardsOf(draft);
  const sections = sectionsOf(draft, cards);
  $('#search-wrap').hidden = true;
  $('#more').innerHTML = '';
  $('#apps').innerHTML = `<div class="edit-bar card" role="region" aria-label="Editing the home screen">
      <div class="edit-intro"><strong>Editing the home screen</strong>
        <div class="muted small">Drag cards to move them, within or between sections (or use ↑ ↓). ✎ Edit a card to rename it,
        change its icon or choose who sees it. Everyone sees your changes once you save.</div></div>
      <div class="edit-actions">
        <button type="button" class="btn btn-sm" id="add-link">+ Add a link</button>
        <button type="button" class="btn btn-sm" id="add-section">+ Add a section</button>
        <span class="spacer"></span>
        <button type="button" class="btn btn-sm btn-ghost" id="edit-cancel">Cancel</button>
        <button type="button" class="btn btn-sm btn-primary" id="edit-save">Save changes</button>
      </div>
      <p class="alert alert-error" id="edit-error" role="alert" hidden></p>
    </div>
    ${sections.map((x, i) => {
      const inIt = cards.filter((c) => c.section === x.id);
      return `<section class="app-section is-editing" data-section="${esc(x.id)}">
        <div class="section-edit">
          <input type="text" class="section-name" value="${esc(x.name)}" data-section-name="${esc(x.id)}" maxlength="40" aria-label="Section name">
          <button type="button" class="btn btn-sm btn-ghost" data-move-section="-1" data-id="${esc(x.id)}" ${i === 0 ? 'disabled' : ''} title="Move this section up" aria-label="Move ${esc(x.name)} up">↑</button>
          <button type="button" class="btn btn-sm btn-ghost" data-move-section="1" data-id="${esc(x.id)}" ${i === sections.length - 1 ? 'disabled' : ''} title="Move this section down" aria-label="Move ${esc(x.name)} down">↓</button>
          ${inIt.length ? '' : `<button type="button" class="btn btn-sm btn-ghost" data-remove-section="${esc(x.id)}">Remove section</button>`}
        </div>
        <div class="apps drop-zone" data-drop-section="${esc(x.id)}">
          ${inIt.map((c) => cardHTML(c, { edit: true, s: draft })).join('') || '<p class="muted small drop-hint">Empty: drag a card here, or remove the section.</p>'}
        </div>
      </section>`;
    }).join('')}`;
}

/** Card order as a list of ids, section by section (so moving between sections keeps its place). */
function orderedIds() {
  const cards = cardsOf(draft);
  return sectionsOf(draft, cards).flatMap((x) => cards.filter((c) => c.section === x.id).map((c) => c.id));
}
const override = (id) => (draft.cards[id] ||= {});

function moveCard(id, { before = null, section = null, step = 0 } = {}) {
  const cards = cardsOf(draft);
  const card = cards.find((c) => c.id === id);
  const sectionOf = (x) => (x === id ? card.section : cards.find((c) => c.id === x).section);
  let ids = orderedIds();
  if (step) {
    // Up / down within its section; past either end it moves into the neighbouring section.
    const same = ids.filter((x) => sectionOf(x) === card.section);
    const at = same.indexOf(id) + step;
    if (at >= 0 && at < same.length) {
      const i = ids.indexOf(id), j = ids.indexOf(same[at]);
      [ids[i], ids[j]] = [ids[j], ids[i]];
    } else {
      const secs = sectionsOf(draft, cards).map((x) => x.id);
      const next = secs[secs.indexOf(card.section) + step];
      if (!next) return;
      override(id).section = next;
      ids = ids.filter((x) => x !== id);
      const inNext = ids.filter((x) => sectionOf(x) === next);
      // Going up: last in the section above. Going down: first in the section below.
      const pos = step < 0
        ? (inNext.length ? ids.indexOf(inNext[inNext.length - 1]) + 1 : ids.length)
        : (inNext.length ? ids.indexOf(inNext[0]) : ids.length);
      ids.splice(pos, 0, id);
    }
  } else {
    if (section) override(id).section = section;
    ids = ids.filter((x) => x !== id);
    ids.splice(before ? ids.indexOf(before) : ids.length, 0, id);
  }
  draft.order = ids;
  drawEditing();
  if (step) $(`[data-card="${CSS.escape(id)}"] [data-move="${step}"]`)?.focus();
}

function startEditing() {
  draft = structuredClone({ cards: {}, links: [], order: [], ...settings });
  draft.sections = sectionsOf(draft, cardsOf(draft));
  draftStart = JSON.stringify(cleaned());
  editing = true;
  draw();
}
function stopEditing() {
  editing = false;
  draft = null;
  draw();
}
const unsaved = () => editing && JSON.stringify(cleaned()) !== draftStart;

/** Keep only what differs from the defaults, so later apps.js changes still show through. */
function cleaned() {
  const cards = {};
  const all = cardsOf(draft);
  for (const [id, o] of Object.entries(draft.cards || {})) {
    const card = all.find((c) => c.id === id);
    if (!card) continue;
    const base = card.base;
    const c = {};
    if (o.show && o.show !== 'default') c.show = o.show;
    if (c.show === 'roles') c.roles = o.roles || [];
    if (!card.added) {
      if (o.name && o.name !== base.name) c.name = o.name;
      if (o.blurb !== undefined && o.blurb !== base.blurb) c.blurb = o.blurb;
      if (o.icon && o.icon !== base.icon) c.icon = o.icon;
    }
    if (o.section && o.section !== (base.section || 'apps')) c.section = o.section;
    if (Object.keys(c).length) cards[id] = c;
  }
  return {
    ...draft,
    cards,
    order: orderedIds(),
    sections: draft.sections.map((x) => ({ id: x.id, name: x.name.trim() || 'Untitled section' })),
  };
}

async function save(btn) {
  const err = $('#edit-error');
  const value = cleaned();
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const { error } = await sb.rpc('update_settings', { p_key: 'onesolar', p_value: value });
  btn.disabled = false;
  btn.textContent = 'Save changes';
  if (error) {
    err.textContent = /Unknown settings key/.test(error.message) ? 'The database needs 029_onesolar.sql first (Supabase → SQL Editor).' : error.message;
    err.hidden = false;
    return;
  }
  settings = value;
  stopEditing();
}

// ---- The card dialog: add a link, or change a card ----------------------------------------------

const SHOW = [
  ['default', 'Default'],
  ['everyone', 'Everyone, even signed out'],
  ['signedIn', 'Anyone signed in'],
  ['roles', 'Only these positions…'],
  ['hidden', 'Hidden from everyone'],
];
const ICONS = ['🔗', '🌐', '📦', '💵', '🤝', '📝', '🔌', '🗺️', '⚙️', '📊', '📅', '📁', '🧰', '🔋', '☀️', '🏎️', '🛠️', '📣', '🎓', '💬'];

function openCardDialog(id) {
  const isNew = !id;
  const card = isNew
    ? { id: newId('link'), name: '', blurb: '', href: 'https://', icon: '🔗', access: 'public', section: 'links', added: true, base: {} }
    : cardsOf(draft).find((c) => c.id === id);
  const o = choiceOf(draft, card.id);
  const show = o.show || 'default';
  const sections = sectionsOf(draft, cardsOf(draft));
  if (isNew && !sections.some((x) => x.id === 'links')) card.section = sections[sections.length - 1]?.id || 'links';
  const dlg = document.createElement('dialog');
  dlg.className = 'card-dialog';
  dlg.setAttribute('aria-labelledby', 'cd-title');
  dlg.innerHTML = `<form novalidate>
    <h2 id="cd-title">${isNew ? 'Add a link' : `Edit ${esc(card.name)}`}</h2>
    ${isNew ? '<p class="muted small">A card for another site, a shared drive folder, or a new one.solar app (its folder, e.g. <code>parts/</code>).</p>' : ''}
    <div class="field"><label for="cd-name">Name</label><input id="cd-name" maxlength="40" value="${esc(card.name)}" required></div>
    <div class="field"><label for="cd-blurb">Description <span class="muted">(one line)</span></label><input id="cd-blurb" maxlength="140" value="${esc(card.blurb)}"></div>
    <div class="field"><label for="cd-href">Link</label>
      ${card.added ? `<input id="cd-href" value="${esc(card.href)}" placeholder="https://… or my-app/" spellcheck="false" inputmode="url">`
        : `<input id="cd-href" value="${esc(card.href)}" disabled><div class="hint">Built-in apps keep their address.</div>`}</div>
    <div class="field"><label for="cd-icon">Icon</label>
      <div class="icon-row"><input id="cd-icon" class="icon-input" maxlength="8" value="${esc(card.icon)}" aria-describedby="cd-icon-hint">
        <div class="icon-picks">${ICONS.map((i) => `<button type="button" class="icon-pick" data-icon="${i}" aria-label="Use ${i}">${i}</button>`).join('')}</div></div>
      <div class="hint" id="cd-icon-hint">Pick one, or type any emoji (Windows: Win + . · Mac: Ctrl + Cmd + Space).</div></div>
    <div class="field"><label for="cd-section">Section</label>
      <select id="cd-section">${sections.map((x) => `<option value="${esc(x.id)}" ${x.id === card.section ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="cd-show">Who sees it</label>
      <select id="cd-show">${SHOW.map(([k, l]) => `<option value="${k}" ${k === show ? 'selected' : ''}>${esc(k === 'default' ? `Default (${defaultWords(card.access)})` : l)}</option>`).join('')}</select>
      <div class="cd-roles" ${show === 'roles' ? '' : 'hidden'}>${positions.map((p) => `<label><input type="checkbox" value="${esc(p.key)}" ${(o.roles || []).includes(p.key) ? 'checked' : ''}> ${esc(p.label)}</label>`).join('')}</div>
      <div class="hint">This only tidies the home screen: each app's own permissions still decide what people can do in it.</div></div>
    <p class="alert alert-error" id="cd-error" role="alert" hidden></p>
    <div class="form-actions">
      ${card.added && !isNew ? '<button type="button" class="btn btn-danger" id="cd-delete">Delete link</button>' : ''}
      ${!card.added && Object.keys(o).length ? '<button type="button" class="btn btn-ghost" id="cd-reset">Back to default</button>' : ''}
      <span class="spacer"></span>
      <button type="button" class="btn btn-ghost" id="cd-cancel">Cancel</button>
      <button type="submit" class="btn btn-primary">${isNew ? 'Add link' : 'Done'}</button>
    </div>
  </form>`;
  document.body.append(dlg);
  const f = (sel) => $(sel, dlg);
  const close = () => (dlg.close(), dlg.remove());
  const after = () => {
    close();
    drawEditing();
    $(`[data-card="${CSS.escape(card.id)}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  f('#cd-show').onchange = () => (f('.cd-roles').hidden = f('#cd-show').value !== 'roles');
  dlg.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-icon]');
    if (pick) f('#cd-icon').value = pick.dataset.icon;
  });
  f('#cd-cancel').onclick = close;
  dlg.addEventListener('cancel', () => setTimeout(() => dlg.remove()));
  f('#cd-delete')?.addEventListener('click', () => {
    if (!confirm(`Delete the ${card.name} link? (It's gone once you save.)`)) return;
    draft.links = draft.links.filter((l) => l.id !== card.id);
    delete draft.cards[card.id];
    draft.order = (draft.order || []).filter((x) => x !== card.id);
    close();
    drawEditing();
  });
  f('#cd-reset')?.addEventListener('click', () => {
    delete draft.cards[card.id];
    after();
  });
  f('form').onsubmit = (e) => {
    e.preventDefault();
    const err = f('#cd-error');
    const name = f('#cd-name').value.trim();
    const href = card.added ? safeHref(f('#cd-href').value) : card.href;
    const pick = f('#cd-show').value;
    const roles = [...dlg.querySelectorAll('.cd-roles input:checked')].map((i) => i.value);
    const problem = !name ? 'Give it a name.'
      : !href ? 'The link must start with https:// (another site), or be a folder of this site such as my-app/.'
      : pick === 'roles' && !roles.length ? 'Pick at least one position, or choose another option.' : '';
    if (problem) {
      err.textContent = problem;
      err.hidden = false;
      return;
    }
    const icon = f('#cd-icon').value.trim() || '🔗';
    const blurb = f('#cd-blurb').value.trim();
    const section = f('#cd-section').value;
    if (card.added) {
      const link = { id: card.id, name, href, icon, blurb };
      draft.links = isNew ? [...(draft.links || []), link] : draft.links.map((l) => (l.id === card.id ? link : l));
      draft.cards[card.id] = { show: pick, roles, section };
      if (isNew) draft.order = [...orderedIds().filter((x) => x !== card.id), card.id];
    } else {
      draft.cards[card.id] = { show: pick, roles, name, blurb, icon, section };
    }
    after();
  };
  dlg.showModal();
  f('#cd-name').focus();
}

// ---- Events -------------------------------------------------------------------------------------

async function loadPositions() {
  if (positions.length) return;
  const { data } = await sb.from('roles').select('key, label').order('sort');
  positions = data || [];
}

document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.closest('[data-fav]')) return toggleFav(t.closest('[data-fav]').dataset.fav);
  if (t.closest('[data-accept]')) return accept(t.closest('[data-accept]'));
  if (t.closest('#edit-open')) {
    await loadPositions();
    startEditing();
    return $('#apps').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  if (!editing || t.closest('dialog')) return;
  if (t.closest('#edit-cancel')) {
    if (unsaved() && !confirm('Throw away your changes to the home screen?')) return;
    return stopEditing();
  }
  if (t.closest('#edit-save')) return save(t.closest('#edit-save'));
  if (t.closest('#add-link')) return openCardDialog(null);
  if (t.closest('[data-edit-card]')) return openCardDialog(t.closest('[data-edit-card]').dataset.editCard);
  if (t.closest('[data-move]')) {
    const b = t.closest('[data-move]');
    return moveCard(b.dataset.id, { step: Number(b.dataset.move) });
  }
  if (t.closest('#add-section')) {
    const id = newId('section');
    draft.sections.push({ id, name: 'New section' });
    drawEditing();
    const input = $(`[data-section-name="${id}"]`);
    input?.scrollIntoView({ block: 'center' });
    input?.focus();
    input?.select();
    return;
  }
  if (t.closest('[data-move-section]')) {
    const b = t.closest('[data-move-section]');
    const i = draft.sections.findIndex((x) => x.id === b.dataset.id);
    const j = i + Number(b.dataset.moveSection);
    if (j < 0 || j >= draft.sections.length) return;
    [draft.sections[i], draft.sections[j]] = [draft.sections[j], draft.sections[i]];
    drawEditing();
    return $(`[data-section="${CSS.escape(b.dataset.id)}"] [data-move-section="${b.dataset.moveSection}"]:not(:disabled)`)?.focus();
  }
  if (t.closest('[data-remove-section]')) {
    draft.sections = draft.sections.filter((x) => x.id !== t.closest('[data-remove-section]').dataset.removeSection);
    return drawEditing();
  }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'search') {
    query = e.target.value.trim().toLowerCase();
    draw();
  }
  if (editing && e.target.dataset.sectionName) {
    const x = draft.sections.find((s) => s.id === e.target.dataset.sectionName);
    if (x) x.name = e.target.value;
  }
});
// "/" (or Ctrl/⌘ + K, the app switcher's shortcut in the other apps) jumps to the search box;
// Escape clears it; Enter opens the first match.
document.addEventListener('keydown', (e) => {
  const box = $('#search');
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
  const ctrlK = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k';
  if ((ctrlK || (e.key === '/' && !typing)) && !$('#search-wrap').hidden) {
    e.preventDefault();
    box.focus();
  } else if (e.target === box && e.key === 'Escape' && box.value) {
    box.value = '';
    query = '';
    draw();
  } else if (e.target === box && e.key === 'Enter') {
    $('#apps .app-main')?.click();
  }
});

// Drag and drop while editing: drop on a card to go before it, or on a section's empty space to go last.
let dragging = null;
const clearMarks = () => document.querySelectorAll('.drop-before, .drop-into').forEach((el) => el.classList.remove('drop-before', 'drop-into'));
document.addEventListener('dragstart', (e) => {
  const card = e.target.closest?.('.app-card.is-editing');
  if (!card) return;
  dragging = card.dataset.card;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragging);
  requestAnimationFrame(() => card.classList.add('is-dragging'));
});
document.addEventListener('dragend', () => {
  dragging = null;
  clearMarks();
  document.querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
});
document.addEventListener('dragover', (e) => {
  if (!dragging) return;
  const zone = e.target.closest?.('[data-drop-section]');
  if (!zone) return;
  e.preventDefault();
  clearMarks();
  const over = e.target.closest('.app-card.is-editing');
  if (over && over.dataset.card !== dragging) over.classList.add('drop-before');
  else if (!over) zone.classList.add('drop-into');
});
document.addEventListener('drop', (e) => {
  if (!dragging) return;
  const zone = e.target.closest?.('[data-drop-section]');
  if (!zone) return;
  e.preventDefault();
  const over = e.target.closest('.app-card.is-editing');
  const id = dragging;
  dragging = null;
  moveCard(id, { section: zone.dataset.dropSection, before: over && over.dataset.card !== id ? over.dataset.card : null });
});

// Leaving with unsaved changes asks first.
addEventListener('beforeunload', (e) => {
  if (unsaved()) e.preventDefault();
});

// ---- Sign out -----------------------------------------------------------------------------------

async function signOut() {
  await sb.auth.signOut();
  await loadMe();
  editing = false;
  draw();
}

try {
  await Promise.all([loadMe(), loadSettings()]);
} catch {
  // Database unreachable: still show the public apps.
}
draw();
// Admin → Home screen → "Open the home screen editor" comes here with ?edit.
if (new URLSearchParams(location.search).has('edit') && canCustomize()) {
  await loadPositions();
  startEditing();
}
// Signing in or out in another tab (e.g. Orders) updates this one.
window.addEventListener('storage', async (e) => {
  if (e.key && e.key.startsWith('sb-')) {
    await loadMe();
    if (!editing) draw();
  }
});
document.body.classList.add('ready');
