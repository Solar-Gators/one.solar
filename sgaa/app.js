/**
 * SGAA: the Solar Gators Alumni Association hub (sgaa/). What the team needs, how alumni can help, updates and
 * events, for everyone (signed in or not); contacting the team and RSVPs for alumni and the team; Manage for
 * people with "Edit the alumni hub". The database (052_sgaa.sql) decides who may do what; this page only
 * hides what someone can't use.
 *
 * Local testing: http://localhost:5190/sgaa/?fake runs every migration in an in-browser Postgres.
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, signInUrl } from '../shared/onesolar.js';
import { renderAccount } from '../shared/account-menu.js';
import { mountAppSwitcher } from '../shared/app-switcher.js';
import { startErrorReporter } from '../shared/error-reporter.js';
import { startVersionCheck } from '../shared/version-check.js';
import { esc, formatText, money, when, ago, toLocalInput, fromLocalInput, splitEvents, spotsLeft, KINDS, URGENCY, fileSlug } from './lib.js';

const FAKE = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('fake');
const sb = FAKE ? (await import('../tools/fake-supabase.js')).supabase : createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
startVersionCheck(sb);
startErrorReporter(sb, 'sgaa');
mountAppSwitcher();

const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');

// ---- state ------------------------------------------------------------------------------------------
let user = null;      // the signed-in Supabase user, or null
let hub = null;       // sgaa_hub(): { viewer, canEdit, settings, needs, contacts, updates, events }
let flash = null;     // { kind, text } shown once at the top of the next page

/** A database call; throws a readable message. */
async function rpc(fn, args = {}) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(friendly(error.message));
  return data;
}
async function rows(q) {
  const { data, error } = await q;
  if (error) throw new Error(friendly(error.message));
  return data || [];
}
const friendly = (m) => String(m || 'Something went wrong.').replace(/^.*?ERROR:\s*/, '');

const insider = () => hub && ['team', 'alum'].includes(hub.viewer);
const photoUrl = (path) => {
  if (!path) return '';
  const r = sb.storage.from('sgaa').getPublicUrl?.(path);
  return r?.data?.publicUrl || '';
};
const settings = () => hub?.settings || {};

async function loadHub() {
  hub = await rpc('sgaa_hub');
}

// ---- the top bar ---------------------------------------------------------------------------------------
async function renderTop() {
  let name = '', role = '';
  if (user) {
    const { data: p } = await sb.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
    name = p?.full_name || user.email;
    role = { team: 'Team', alum: 'Alum', pending: 'Alum (waiting for approval)', former: 'Former member', guest: 'Guest' }[hub?.viewer] || '';
  }
  renderAccount($('#account'), {
    user, name, role,
    links: hub?.canEdit ? [{ label: 'Manage SGAA', href: '#/manage' }] : [],
    onSignOut: async () => { await sb.auth.signOut(); location.hash = '#/'; location.reload(); },
  });
  $('#nav-manage').hidden = !hub?.canEdit;
  const title = settings().title || 'Solar Gators Alumni';
  $('#brand-app').textContent = 'Alumni';
  document.title = `${title} · one.solar`;
}

function setActiveNav(section) {
  for (const a of document.querySelectorAll('#sgaa-nav a')) a.classList.toggle('active', a.dataset.nav === section);
}

// ---- routing ------------------------------------------------------------------------------------------
const ROUTES = {
  '': renderHome,
  needs: renderNeeds,
  need: renderNeed,
  help: renderHelp,
  updates: renderUpdates,
  events: renderEvents,
  contact: renderContact,
  manage: renderManage,
};

async function route() {
  const [section = '', ...rest] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const page = ROUTES[section] || renderNotFound;
  setActiveNav(section === 'need' ? 'needs' : section);
  try {
    const html = await page(rest, params);
    if (html !== undefined) main.innerHTML = flashHTML() + html;
  } catch (err) {
    main.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
  window.scrollTo(0, 0);
}

function flashHTML() {
  if (!flash) return '';
  const f = flash;
  flash = null;
  return `<div class="alert alert-${f.kind} flash" role="status">${esc(f.text)}</div>`;
}
function say(kind, text) {
  flash = { kind, text };
}
function showError(err, host = main) {
  const box = host.querySelector('.form-error') || host.querySelector('[data-error]');
  if (box) {
    box.hidden = false;
    box.textContent = err.message;
    box.scrollIntoView({ block: 'nearest' });
  } else alert(err.message);
}

// ---- pieces ----------------------------------------------------------------------------------------------
function needCard(n) {
  const photo = photoUrl(n.photo);
  const meta = [n.subsystem, KINDS[n.kind], n.project ? `Project: ${n.project}` : ''].filter(Boolean);
  return `<a class="need-card${n.status === 'met' ? ' met' : ''}" href="#/need/${n.id}">
    ${photo ? `<img class="need-photo" src="${esc(photo)}" alt="" loading="lazy">` : `<div class="need-photo placeholder" aria-hidden="true">${{ parts: '🔧', money: '💵', expertise: '🧠', other: '☀️' }[n.kind] || '☀️'}</div>`}
    <div class="need-body">
      <div class="need-tags">
        ${n.status === 'met' ? '<span class="tag tag-met">Met, thank you!</span>' : ''}
        ${n.status !== 'met' && URGENCY[n.urgency] ? `<span class="tag tag-${n.urgency}">${URGENCY[n.urgency]}</span>` : ''}
      </div>
      <h3>${esc(n.title)}</h3>
      ${n.summary ? `<p>${esc(n.summary)}</p>` : ''}
      <div class="need-meta">
        ${n.cost != null ? `<span class="need-cost">${esc(money(n.cost))}</span>` : ''}
        ${n.quantity ? `<span>${esc(n.quantity)}</span>` : ''}
        ${meta.length ? `<span class="muted">${meta.map(esc).join(' · ')}</span>` : ''}
      </div>
    </div>
  </a>`;
}

function updateCard(u, { full = false } = {}) {
  const need = u.needId && hub.needs.find((n) => n.id === u.needId);
  const imgs = u.images || [];
  return `<article class="card update">
    <div class="update-head">
      ${u.pinned ? '<span class="tag tag-pin">Pinned</span>' : ''}
      <h3>${esc(u.title)}</h3>
      <div class="muted small">${esc(u.author || 'Solar Gators')} · ${esc(ago(u.at))}${need ? ` · <a href="#/need/${need.id}">${esc(need.title)}</a>` : ''}</div>
    </div>
    <div class="prose${full ? '' : ' clamp'}">${formatText(u.body)}</div>
    ${imgs.length ? `<div class="gallery g${Math.min(imgs.length, 3)}">${imgs.slice(0, full ? 12 : 3).map((i) =>
      `<a href="${esc(photoUrl(i.path))}" target="_blank" rel="noopener"><img src="${esc(photoUrl(i.path))}" alt="${esc(i.caption)}" loading="lazy"></a>`).join('')}</div>` : ''}
  </article>`;
}

function eventCard(e) {
  const left = spotsLeft(e);
  const past = new Date(e.endsAt || e.startsAt) < new Date();
  let action = '';
  if (e.cancelled) action = '<span class="tag tag-high">Cancelled</span>';
  else if (past) action = '<span class="muted small">This event is over.</span>';
  else if (!e.rsvpOpen) action = '<span class="muted small">RSVPs are closed.</span>';
  else if (!user) action = `<a class="btn btn-sm" href="${esc(signInUrl(location.pathname + '#/events'))}">Sign in to RSVP</a>`;
  else if (!insider()) action = '<span class="muted small">RSVPs are for alumni and the team.</span>';
  else if (e.mine) action = `<span class="tag tag-met">You're going${e.mine.guests ? ` (+${e.mine.guests})` : ''}</span>
    <button class="btn btn-sm" data-act="rsvp" data-id="${e.id}">Change</button>
    <button class="btn btn-sm btn-ghost" data-act="unrsvp" data-id="${e.id}">Can't make it</button>`;
  else if (left === 0) action = '<span class="muted small">It\'s full.</span>';
  else action = `<button class="btn btn-sm btn-primary" data-act="rsvp" data-id="${e.id}">RSVP</button>`;
  const d = new Date(e.startsAt);
  return `<article class="card event${e.cancelled ? ' cancelled' : ''}">
    <div class="event-date" aria-hidden="true"><b>${d.toLocaleDateString('en-US', { month: 'short' })}</b><span>${d.getDate()}</span></div>
    <div class="event-body">
      <h3>${esc(e.title)}</h3>
      <div class="muted small">${esc(when(e.startsAt, e.endsAt))}${e.location ? ` · ${esc(e.location)}` : ''}</div>
      ${e.body ? `<div class="prose">${formatText(e.body)}</div>` : ''}
      <div class="event-foot">
        <span class="muted small">${e.going ? `${e.going} going` : ''}${left !== '' && !past ? `${e.going ? ' · ' : ''}${left} spot${left === 1 ? '' : 's'} left` : ''}</span>
        <div class="event-actions">${action}</div>
      </div>
    </div>
  </article>`;
}

function contactCard(c, needId = '') {
  const href = `#/contact?to=${c.id}${needId ? `&need=${needId}` : ''}`;
  return `<div class="contact">
    <div class="avatar" aria-hidden="true">${esc((c.name || c.title).split(/\s+/).map((w) => w[0]).slice(0, 2).join(''))}</div>
    <div class="contact-body">
      <b>${esc(c.title)}</b>${c.name ? `<div>${esc(c.name)}</div>` : ''}
      ${c.blurb ? `<div class="muted small">${esc(c.blurb)}</div>` : ''}
      ${c.topics?.length ? `<div class="chips">${c.topics.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
    </div>
    ${contactButton(href)}
  </div>`;
}

/** "Contact": the form for alumni and the team; Sign in otherwise. */
function contactButton(href, label = 'Contact') {
  if (insider()) return `<a class="btn btn-sm" href="${href}">${label}</a>`;
  if (!user) return `<a class="btn btn-sm" href="${esc(signInUrl(location.pathname + href))}">Sign in to ${label.toLowerCase()}</a>`;
  return '';
}

function viewerNote() {
  if (!hub) return '';
  if (hub.viewer === 'pending') return '<div class="alert alert-info">Your alumni account is waiting for approval. Once someone on the team approves it, you can contact the team, RSVP to events and see the alumni directory.</div>';
  if (hub.viewer === 'former') return '<div class="alert alert-info">Your one.solar access has ended. If you graduated, ask someone on the team to mark you as an alum so you can use this page.</div>';
  return '';
}

function giveButton(cls = 'btn-primary') {
  const s = settings();
  return s.giveUrl ? `<a class="btn ${cls}" href="${esc(s.giveUrl)}" target="_blank" rel="noopener noreferrer">${esc(s.giveLabel || 'Give')}</a>` : '';
}

// ---- public pages ------------------------------------------------------------------------------------
async function renderHome() {
  const s = settings();
  const open = hub.needs.filter((n) => n.status === 'open');
  const { upcoming } = splitEvents(hub.events.filter((e) => !e.cancelled));
  return `${viewerNote()}
  <section class="hero">
    <div>
      <div class="eyebrow">Solar Gators Alumni Association</div>
      <h1>${esc(s.title || 'Solar Gators Alumni')}</h1>
      <p class="lead">${esc(s.intro || '')}</p>
      <div class="hero-actions">
        <a class="btn btn-primary" href="#/needs">See what we need</a>
        <a class="btn" href="#/help">How to help</a>
        ${giveButton('')}
      </div>
    </div>
    <div class="hero-stats">
      <div><b>${open.length}</b><span>open need${open.length === 1 ? '' : 's'}</span></div>
      <div><b>${hub.needs.filter((n) => n.status === 'met').length}</b><span>met this year</span></div>
      <div><b>${upcoming.length}</b><span>upcoming event${upcoming.length === 1 ? '' : 's'}</span></div>
    </div>
  </section>

  <section class="block">
    <div class="block-head"><h2>What we need</h2><a href="#/needs">All needs →</a></div>
    ${open.length ? `<div class="need-grid">${open.slice(0, 6).map(needCard).join('')}</div>`
      : '<div class="empty">Nothing on the list right now. Check back soon, or see how else you can help.</div>'}
  </section>

  <div class="two-col">
    <section class="block">
      <div class="block-head"><h2>Latest from the team</h2><a href="#/updates">All updates →</a></div>
      ${hub.updates.length ? hub.updates.slice(0, 3).map((u) => updateCard(u)).join('') : '<div class="empty">No updates yet.</div>'}
    </section>
    <aside>
      <section class="block">
        <div class="block-head"><h2>Coming up</h2><a href="#/events">Events →</a></div>
        ${upcoming.length ? upcoming.slice(0, 3).map((e) => `<a class="mini-event" href="#/events">
          <b>${esc(e.title)}</b><span class="muted small">${esc(when(e.startsAt, e.endsAt))}</span></a>`).join('')
          : '<div class="empty small">No events planned yet.</div>'}
      </section>
      <section class="block">
        <div class="block-head"><h2>Talk to the team</h2><a href="#/help">How to help →</a></div>
        <div class="card contacts">${hub.contacts.length ? hub.contacts.slice(0, 4).map((c) => contactCard(c)).join('') : '<p class="muted">Contacts are coming soon.</p>'}</div>
      </section>
    </aside>
  </div>`;
}

async function renderNeeds(_, params) {
  const kind = params.get('kind') || '';
  const open = hub.needs.filter((n) => n.status === 'open' && (!kind || n.kind === kind));
  const met = hub.needs.filter((n) => n.status === 'met');
  const kinds = Object.entries(KINDS).filter(([k]) => hub.needs.some((n) => n.status === 'open' && n.kind === k));
  return `${viewerNote()}
  <div class="page-head"><div><h1>What we need</h1><p class="muted">Parts, materials, funding and know-how the team is looking for right now. See something you can help with? Get in touch.</p></div>${giveButton()}</div>
  ${kinds.length > 1 ? `<div class="filter-chips" role="group" aria-label="Show">
    <a class="chip${kind ? '' : ' on'}" href="#/needs">All</a>
    ${kinds.map(([k, label]) => `<a class="chip${kind === k ? ' on' : ''}" href="#/needs?kind=${k}">${esc(label)}</a>`).join('')}
  </div>` : ''}
  ${open.length ? `<div class="need-grid">${open.map(needCard).join('')}</div>` : '<div class="empty">Nothing here right now.</div>'}
  ${met.length ? `<section class="block"><div class="block-head"><h2>Recently met, thanks to you</h2></div><div class="need-grid">${met.map(needCard).join('')}</div></section>` : ''}`;
}

async function renderNeed([id]) {
  const n = hub.needs.find((x) => x.id === id);
  if (!n) return `<a class="back-link" href="#/needs">← What we need</a><div class="empty">This need isn't listed anymore. It may have been met or taken down.</div>`;
  const contact = hub.contacts.find((c) => c.id === n.contactId);
  const photo = photoUrl(n.photo);
  const related = hub.updates.filter((u) => u.needId === n.id);
  return `<a class="back-link" href="#/needs">← What we need</a>
  <div class="need-detail">
    <div class="card">
      <div class="need-tags">
        ${n.status === 'met' ? '<span class="tag tag-met">Met, thank you!</span>' : ''}
        ${n.status !== 'met' && URGENCY[n.urgency] ? `<span class="tag tag-${n.urgency}">${URGENCY[n.urgency]}</span>` : ''}
        <span class="tag">${esc(KINDS[n.kind] || 'Other')}</span>
      </div>
      <h1>${esc(n.title)}</h1>
      ${n.summary ? `<p class="lead">${esc(n.summary)}</p>` : ''}
      ${photo ? `<img class="need-hero" src="${esc(photo)}" alt="">` : ''}
      <div class="prose">${formatText(n.body)}</div>
      ${n.status === 'met' && n.metNote ? `<div class="alert alert-success">${esc(n.metNote)}</div>` : ''}
    </div>
    <aside class="card need-side">
      ${n.cost != null ? `<div><span class="muted small">Rough cost</span><b class="big">${esc(money(n.cost))}</b></div>` : ''}
      ${n.quantity ? `<div><span class="muted small">How much</span><b>${esc(n.quantity)}</b></div>` : ''}
      ${n.subsystem ? `<div><span class="muted small">Subsystem</span><b>${esc(n.subsystem)}</b></div>` : ''}
      ${n.project ? `<div><span class="muted small">Project</span><b>${esc(n.project)}</b></div>` : ''}
      ${n.status === 'open' ? `<hr>
        <p class="small">${contact ? `Questions, or able to help? ${esc(contact.name || contact.title)} can tell you more.` : 'Able to help? Get in touch with the team.'}</p>
        ${contactButton(`#/contact?need=${n.id}${contact ? `&to=${contact.id}` : ''}`, 'Contact the team') || ''}
        ${giveButton('btn-block')}` : ''}
    </aside>
  </div>
  ${related.length ? `<section class="block"><div class="block-head"><h2>Updates</h2></div>${related.map((u) => updateCard(u, { full: true })).join('')}</section>` : ''}`;
}

async function renderHelp() {
  const s = settings();
  return `${viewerNote()}
  <div class="page-head"><div><h1>How to help</h1></div>${giveButton()}</div>
  <div class="two-col">
    <div class="card prose">${formatText(s.howToHelp || '')}</div>
    <aside class="help-side">
      <section class="block">
        <div class="block-head"><h2>Who to contact</h2></div>
        <div class="card contacts">${hub.contacts.length ? hub.contacts.map((c) => contactCard(c)).join('') : '<p class="muted">Contacts are coming soon.</p>'}
          ${!user ? '<p class="muted small">Sign in with your one.solar account to message them. Their email addresses aren\'t shown here.</p>' : ''}</div>
      </section>
    </aside>
  </div>`;
}

async function renderUpdates() {
  return `<div class="page-head"><div><h1>Updates</h1><p class="muted">What the team has been up to.</p></div></div>
  ${hub.updates.length ? hub.updates.map((u) => updateCard(u, { full: true })).join('') : '<div class="empty">No updates yet.</div>'}`;
}

async function renderEvents() {
  const { upcoming, past } = splitEvents(hub.events);
  return `${viewerNote()}<div class="page-head"><div><h1>Events</h1><p class="muted">Alumni get-togethers, races and design reviews you can join.</p></div></div>
  ${upcoming.length ? upcoming.map(eventCard).join('') : '<div class="empty">No events planned yet.</div>'}
  ${past.length ? `<section class="block"><div class="block-head"><h2>Past events</h2></div>${past.map(eventCard).join('')}</section>` : ''}`;
}

function renderNotFound() {
  return '<div class="empty">That page doesn\'t exist. <a href="#/">Go to the start</a>.</div>';
}

// ---- contacting the team -------------------------------------------------------------------------
async function renderContact(_, params) {
  if (!user) {
    location.href = signInUrl(location.pathname + location.hash);
    return '';
  }
  if (!insider()) {
    return `${viewerNote() || '<div class="alert alert-info">Contacting the team is for Solar Gators alumni and the team.</div>'}<a href="#/">← Back</a>`;
  }
  const need = hub.needs.find((n) => n.id === params.get('need'));
  const to = params.get('to') || need?.contactId || hub.contacts[0]?.id || '';
  if (!hub.contacts.length) return '<div class="empty">There\'s nobody to contact yet. Check back soon.</div>';
  return `<a class="back-link" href="${need ? `#/need/${need.id}` : '#/help'}">← Back</a>
  <div class="narrow">
    <div class="card">
      <h1>Contact the team</h1>
      <p class="muted">Your message is emailed to them, and their reply comes straight to your email (${esc(user.email)}).</p>
      <form data-form="contact" class="stack">
        <input type="hidden" name="need" value="${esc(need?.id || '')}">
        <div class="field"><label for="c-to">To</label>
          <select id="c-to" name="to" required>${hub.contacts.map((c) => `<option value="${c.id}"${c.id === to ? ' selected' : ''}>${esc(c.title)}${c.name ? ` (${esc(c.name)})` : ''}</option>`).join('')}</select></div>
        ${need ? `<div class="field"><label>About</label><div class="readonly">${esc(need.title)}</div></div>` : ''}
        <div class="field"><label for="c-subject">Subject</label>
          <input id="c-subject" name="subject" maxlength="150" value="${esc(need ? `About: ${need.title}` : '')}" placeholder="What it's about"></div>
        <div class="field"><label for="c-body">Message <span class="req">*</span></label>
          <textarea id="c-body" name="body" rows="7" maxlength="5000" required placeholder="How you'd like to help, or what you'd like to know"></textarea></div>
        <div class="alert alert-error form-error" hidden></div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Send</button></div>
      </form>
    </div>
  </div>`;
}

async function sendContact(form) {
  const f = new FormData(form);
  await rpc('sgaa_send_message', { p_contact: f.get('to') || null, p_need: f.get('need') || null, p_subject: f.get('subject') || '', p_body: f.get('body') || '' });
  say('success', 'Sent. They\'ll reply to your email.');
  location.hash = f.get('need') ? `#/need/${f.get('need')}` : '#/help';
}

// ---- RSVPs ------------------------------------------------------------------------------------------
function openRsvp(id) {
  const e = hub.events.find((x) => x.id === id);
  if (!e) return;
  const dlg = $('#dlg');
  const left = spotsLeft(e);
  dlg.innerHTML = `<form method="dialog" data-form="rsvp" data-id="${e.id}" class="stack dlg-form">
    <h2>${esc(e.title)}</h2>
    <p class="muted small">${esc(when(e.startsAt, e.endsAt))}${e.location ? ` · ${esc(e.location)}` : ''}</p>
    <div class="field"><label for="r-guests">Bringing anyone?</label>
      <select id="r-guests" name="guests">${[0, 1, 2, 3, 4, 5].map((g) => `<option value="${g}"${(e.mine?.guests || 0) === g ? ' selected' : ''}>${g ? `${g} guest${g > 1 ? 's' : ''}` : 'Just me'}</option>`).join('')}</select>
      ${left !== '' ? `<div class="hint">${left} spot${left === 1 ? '' : 's'} left (you and your guests count).</div>` : ''}</div>
    <div class="field"><label for="r-note">Note for the organizers</label><input id="r-note" name="note" maxlength="300" value="${esc(e.mine?.note || '')}" placeholder="Optional"></div>
    <div class="alert alert-error form-error" hidden></div>
    <div class="form-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn btn-primary" type="submit">${e.mine ? 'Save' : 'I\'m going'}</button></div>
  </form>`;
  dlg.showModal();
}

// ---- Manage (editors) ------------------------------------------------------------------------------------
const MANAGE_TABS = [
  ['needs', 'Needs'], ['updates', 'Updates'], ['events', 'Events'], ['contacts', 'Contacts'], ['pages', 'Pages'],
];

async function renderManage([tab = 'needs', id]) {
  if (!hub.canEdit) return '<div class="empty">Managing SGAA needs "Edit the alumni hub" (Admin → Roles &amp; permissions).</div>';
  const tabs = `<div class="tabs">${MANAGE_TABS.map(([k, l]) => `<a href="#/manage/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</div>`;
  const body = await ({ needs: manageNeeds, updates: manageUpdates, events: manageEvents, contacts: manageContacts, pages: managePages }[tab] || (() => ''))(id);
  return `<div class="page-head"><div><h1>Manage SGAA</h1><p class="muted">Everything here is public once it's published, except contacts' names (alumni and the team only) and their emails (never shown).</p></div></div>${tabs}${body}`;
}

const STATUS = { draft: 'Draft', open: 'Public', met: 'Met', archived: 'Archived' };

async function manageNeeds(id) {
  const all = await rows(sb.from('sgaa_needs').select('*').order('created_at', { ascending: false }));
  if (id) {
    // Suggest the same subsystem names as the Orders request form (Admin → Request form → Dropdowns).
    const form = await rows(sb.from('app_settings').select('value').eq('key', 'form')).catch(() => []);
    return needForm(id === 'new' ? null : all.find((n) => n.id === id), form[0]?.value?.subsystems || []);
  }
  const list = all.filter((n) => n.status !== 'archived');
  return `<div class="toolbar"><a class="btn btn-primary" href="#/manage/needs/new">+ New need</a>
    <span class="muted small">Tip: in Projects, "Share with alumni" on a project or work item adds it here too.</span></div>
  ${list.length ? `<div class="table-wrap"><table class="table">
    <thead><tr><th>Need</th><th>Status</th><th>Rough cost</th><th>Updated</th></tr></thead>
    <tbody>${list.map((n) => `<tr><td><a href="#/manage/needs/${n.id}">${esc(n.title)}</a>${n.pm_item_id || n.pm_project_id ? ' <span class="tag">From Projects</span>' : ''}</td>
      <td><span class="tag tag-s-${n.status}">${STATUS[n.status]}</span></td><td>${esc(money(n.cost_estimate))}</td><td class="muted">${esc(ago(n.updated_at))}</td></tr>`).join('')}</tbody>
  </table></div>` : '<div class="empty">No needs yet. Add the first one.</div>'}
  ${all.some((n) => n.status === 'archived') ? `<details class="block"><summary class="muted">Archived (${all.filter((n) => n.status === 'archived').length})</summary>
    <ul>${all.filter((n) => n.status === 'archived').map((n) => `<li><a href="#/manage/needs/${n.id}">${esc(n.title)}</a></li>`).join('')}</ul></details>` : ''}`;
}

function needForm(n, subsystems = []) {
  const v = n || { status: 'draft', kind: 'parts', urgency: 'normal' };
  const contacts = hub.contacts;
  return `<a class="back-link" href="#/manage/needs">← Needs</a>
  <form class="card stack" data-form="need" data-id="${n?.id || ''}">
    <h2>${n ? 'Edit need' : 'New need'}</h2>
    <div class="form-grid">
      <div class="field span-2"><label for="n-title">Title <span class="req">*</span></label><input id="n-title" name="title" maxlength="120" required value="${esc(v.title)}" placeholder="Battery cells for the new pack"></div>
      <div class="field"><label for="n-kind">Kind</label><select id="n-kind" name="kind">${Object.entries(KINDS).map(([k, l]) => `<option value="${k}"${v.kind === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label for="n-urgency">Urgency</label><select id="n-urgency" name="urgency">${[['high', 'Urgent'], ['normal', 'Normal'], ['low', 'Nice to have']].map(([k, l]) => `<option value="${k}"${v.urgency === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field span-2"><label for="n-summary">One-line summary</label><input id="n-summary" name="summary" maxlength="300" value="${esc(v.summary)}" placeholder="Shown on the card"></div>
      <div class="field"><label for="n-cost">Rough cost ($)</label><input id="n-cost" name="cost" inputmode="decimal" value="${esc(v.cost_estimate ?? '')}" placeholder="Optional"></div>
      <div class="field"><label for="n-qty">How much</label><input id="n-qty" name="quantity" maxlength="80" value="${esc(v.quantity)}" placeholder="About 400 cells"></div>
      <div class="field span-2"><label for="n-body">Details</label><textarea id="n-body" name="body" rows="8" maxlength="10000" placeholder="What it's for, specs, part numbers, what kind of help works best">${esc(v.body)}</textarea>
        <div class="hint">Formatting: blank line = new paragraph, "- " for bullets, **bold**, *italic*, [link](https://…).</div></div>
      <div class="field span-2">
        <label>Photo</label>
        <div class="photo-pick" data-photo-pick>
          <input type="hidden" name="photo" value="${esc(v.photo_path)}">
          <img src="${esc(photoUrl(v.photo_path))}" alt="" ${v.photo_path ? '' : 'hidden'}>
          <label class="btn btn-sm">Choose a photo<input type="file" accept="image/*" data-upload="needs" hidden></label>
          <button type="button" class="btn btn-sm btn-ghost" data-act="photo-clear" ${v.photo_path ? '' : 'hidden'}>Remove</button>
        </div>
      </div>
      <div class="field"><label for="n-sub">Subsystem</label><input id="n-sub" name="subsystem" maxlength="80" list="n-sub-list" value="${esc(v.subsystem)}" placeholder="Battery">
        <datalist id="n-sub-list">${subsystems.map((x) => `<option value="${esc(x)}">`).join('')}</datalist></div>
      <div class="field"><label for="n-contact">Contact</label><select id="n-contact" name="contactId"><option value="">Anyone (they choose)</option>
        ${contacts.map((c) => `<option value="${c.id}"${v.contact_id === c.id ? ' selected' : ''}>${esc(c.title)}${c.name ? ` (${esc(c.name)})` : ''}</option>`).join('')}</select></div>
      <div class="field"><label for="n-status">Status</label><select id="n-status" name="status">${['draft', 'open', 'met', 'archived'].map((k) => `<option value="${k}"${v.status === k ? ' selected' : ''}>${STATUS[k]}</option>`).join('')}</select>
        <div class="hint">Drafts are only visible here.</div></div>
      <div class="field"><label for="n-metnote">Thank-you note (when met)</label><input id="n-metnote" name="metNote" maxlength="300" value="${esc(v.met_note)}" placeholder="Thanks to a 2019 alum at …"></div>
    </div>
    <div class="alert alert-error form-error" hidden></div>
    <div class="form-actions">
      ${n ? '<button type="button" class="btn btn-danger" data-act="delete-need" data-id="' + n.id + '">' + (n.published_at ? 'Archive' : 'Delete') + '</button>' : ''}
      ${n && ['open', 'met'].includes(n.status) ? `<a class="btn" href="#/need/${n.id}" target="_blank">View</a>` : ''}
      <button class="btn btn-primary" type="submit">Save</button>
    </div>
  </form>`;
}

async function manageUpdates(id) {
  const all = await rows(sb.from('sgaa_updates').select('*').order('created_at', { ascending: false }));
  if (id) {
    const u = id === 'new' ? null : all.find((x) => x.id === id);
    const imgs = u ? await rows(sb.from('sgaa_update_images').select('*').eq('update_id', u.id).order('sort')) : [];
    return updateForm(u, imgs);
  }
  return `<div class="toolbar"><a class="btn btn-primary" href="#/manage/updates/new">+ New update</a></div>
  ${all.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Update</th><th>Status</th><th>Posted</th></tr></thead>
    <tbody>${all.map((u) => `<tr><td><a href="#/manage/updates/${u.id}">${esc(u.title)}</a>${u.pinned ? ' <span class="tag tag-pin">Pinned</span>' : ''}</td>
      <td><span class="tag tag-s-${u.published ? 'open' : 'draft'}">${u.published ? 'Public' : 'Draft'}</span></td><td class="muted">${esc(ago(u.created_at))} · ${esc(u.author_name)}</td></tr>`).join('')}</tbody>
  </table></div>` : '<div class="empty">No updates yet.</div>'}`;
}

function updateForm(u, imgs) {
  const v = u || {};
  const needs = hub.needs;
  return `<a class="back-link" href="#/manage/updates">← Updates</a>
  <form class="card stack" data-form="update" data-id="${u?.id || ''}">
    <h2>${u ? 'Edit update' : 'New update'}</h2>
    <div class="field"><label for="u-title">Title <span class="req">*</span></label><input id="u-title" name="title" maxlength="140" required value="${esc(v.title)}"></div>
    <div class="field"><label for="u-body">Text</label><textarea id="u-body" name="body" rows="8" maxlength="10000">${esc(v.body)}</textarea>
      <div class="hint">Formatting: blank line = new paragraph, "- " for bullets, **bold**, *italic*, [link](https://…).</div></div>
    <div class="field"><label>Photos (up to 12)</label>
      <div class="photo-list" data-photo-list>${imgs.map((i) => photoItem(i.path, i.caption)).join('')}</div>
      <label class="btn btn-sm">Add photos<input type="file" accept="image/*" multiple data-upload="updates" hidden></label></div>
    <div class="form-grid">
      <div class="field span-2"><label for="u-need">About a need</label><select id="u-need" name="needId"><option value="">None</option>
        ${needs.map((n) => `<option value="${n.id}"${v.need_id === n.id ? ' selected' : ''}>${esc(n.title)}</option>`).join('')}</select></div>
      <div class="field"><label class="check"><input type="checkbox" name="pinned" ${v.pinned ? 'checked' : ''}> Pin to the top</label></div>
      <div class="field"><label class="check"><input type="checkbox" name="published" ${v.published ? 'checked' : ''}> Public</label></div>
    </div>
    <div class="alert alert-error form-error" hidden></div>
    <div class="form-actions">${u ? `<button type="button" class="btn btn-danger" data-act="delete-update" data-id="${u.id}">Delete</button>` : ''}<button class="btn btn-primary" type="submit">Save</button></div>
  </form>`;
}

const photoItem = (path, caption = '') => `<div class="photo-item" data-path="${esc(path)}">
  <img src="${esc(photoUrl(path))}" alt=""><input name="caption" maxlength="200" value="${esc(caption)}" placeholder="Caption (optional)" aria-label="Caption">
  <button type="button" class="icon-btn" data-act="photo-remove" aria-label="Remove photo">×</button></div>`;

async function manageEvents(id) {
  const all = await rows(sb.from('sgaa_events').select('*').order('starts_at', { ascending: false }));
  if (id) {
    const e = id === 'new' ? null : all.find((x) => x.id === id);
    const going = e ? await rows(sb.rpc('sgaa_event_rsvps', { p_event: e.id })) : [];
    return eventForm(e, going);
  }
  return `<div class="toolbar"><a class="btn btn-primary" href="#/manage/events/new">+ New event</a></div>
  ${all.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Event</th><th>When</th><th>Status</th></tr></thead>
    <tbody>${all.map((e) => `<tr><td><a href="#/manage/events/${e.id}">${esc(e.title)}</a></td><td>${esc(when(e.starts_at, e.ends_at))}</td>
      <td><span class="tag tag-s-${e.cancelled ? 'archived' : e.published ? 'open' : 'draft'}">${e.cancelled ? 'Cancelled' : e.published ? 'Public' : 'Draft'}</span></td></tr>`).join('')}</tbody>
  </table></div>` : '<div class="empty">No events yet.</div>'}`;
}

function eventForm(e, going) {
  const v = e || { rsvp_open: true };
  const total = going.reduce((s, r) => s + 1 + r.guests, 0);
  return `<a class="back-link" href="#/manage/events">← Events</a>
  <form class="card stack" data-form="event" data-id="${e?.id || ''}">
    <h2>${e ? 'Edit event' : 'New event'}</h2>
    <div class="form-grid">
      <div class="field span-2"><label for="e-title">Title <span class="req">*</span></label><input id="e-title" name="title" maxlength="140" required value="${esc(v.title)}"></div>
      <div class="field span-2"><label for="e-loc">Where</label><input id="e-loc" name="location" maxlength="200" value="${esc(v.location)}" placeholder="MAE-B shop, or a Zoom link"></div>
      <div class="field"><label for="e-start">Starts <span class="req">*</span></label><input id="e-start" name="startsAt" type="datetime-local" required value="${esc(toLocalInput(v.starts_at))}"></div>
      <div class="field"><label for="e-end">Ends</label><input id="e-end" name="endsAt" type="datetime-local" value="${esc(toLocalInput(v.ends_at))}"></div>
      <div class="field"><label for="e-cap">Spots</label><input id="e-cap" name="capacity" type="number" min="1" value="${esc(v.capacity ?? '')}" placeholder="No limit"></div>
      <div class="field"><label class="check"><input type="checkbox" name="rsvpOpen" ${v.rsvp_open ? 'checked' : ''}> Taking RSVPs</label>
        <label class="check"><input type="checkbox" name="published" ${v.published ? 'checked' : ''}> Public</label>
        ${e ? `<label class="check"><input type="checkbox" name="cancelled" ${v.cancelled ? 'checked' : ''}> Cancelled</label>` : ''}</div>
      <div class="field span-4"><label for="e-body">Details</label><textarea id="e-body" name="body" rows="5" maxlength="5000">${esc(v.body)}</textarea></div>
    </div>
    <div class="alert alert-error form-error" hidden></div>
    <div class="form-actions">${e ? `<button type="button" class="btn btn-danger" data-act="delete-event" data-id="${e.id}">Delete</button>` : ''}<button class="btn btn-primary" type="submit">Save</button></div>
  </form>
  ${e ? `<section class="block"><div class="block-head"><h2>Going (${total})</h2></div>
    ${going.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Guests</th><th>Note</th><th>Email</th></tr></thead>
      <tbody>${going.map((r) => `<tr><td>${esc(r.full_name)}${r.alum ? ' <span class="tag">Alum</span>' : ''}</td><td>${r.guests}</td><td>${esc(r.note)}</td><td>${esc(r.email)}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty small">Nobody yet.</div>'}</section>` : ''}`;
}

async function manageContacts(id) {
  const [all, people, roles] = await Promise.all([
    rows(sb.from('sgaa_contacts').select('*').order('sort')),
    rows(sb.from('profiles').select('id, full_name, email')),
    rows(sb.from('profile_roles').select('user_id, role')),
  ]);
  const onTeam = new Set(roles.filter((r) => !['guest', 'alumni'].includes(r.role)).map((r) => r.user_id));
  const team = people.filter((p) => onTeam.has(p.id)).sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email));
  const nameOf = (uid) => people.find((p) => p.id === uid)?.full_name || 'Someone';
  if (id) {
    const c = id === 'new' ? null : all.find((x) => x.id === id);
    const v = c || { active: true, topics: [] };
    return `<a class="back-link" href="#/manage/contacts">← Contacts</a>
    <form class="card stack" data-form="contact-edit" data-id="${c?.id || ''}">
      <h2>${c ? 'Edit contact' : 'New contact'}</h2>
      <p class="muted small">Alumni message contacts through the site. Messages are emailed to them; their email address is never shown.</p>
      <div class="form-grid">
        <div class="field span-2"><label for="ct-user">Person <span class="req">*</span></label><select id="ct-user" name="userId" required><option value="">Choose…</option>
          ${team.map((p) => `<option value="${p.id}"${v.user_id === p.id ? ' selected' : ''}>${esc(p.full_name || p.email)}</option>`).join('')}</select></div>
        <div class="field span-2"><label for="ct-title">Shown as <span class="req">*</span></label><input id="ct-title" name="title" maxlength="80" required value="${esc(v.title)}" placeholder="Business Coordinator"></div>
        <div class="field span-4"><label for="ct-blurb">What to ask them about</label><input id="ct-blurb" name="blurb" maxlength="500" value="${esc(v.blurb)}" placeholder="Sponsorships, giving, and company matching"></div>
        <div class="field span-2"><label for="ct-topics">Topics (comma-separated)</label><input id="ct-topics" name="topics" value="${esc((v.topics || []).join(', '))}" placeholder="giving, sponsors"></div>
        <div class="field"><label for="ct-sort">Order</label><input id="ct-sort" name="sort" type="number" value="${esc(v.sort ?? 100)}"></div>
        <div class="field"><label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Listed</label></div>
      </div>
      <div class="alert alert-error form-error" hidden></div>
      <div class="form-actions">${c ? `<button type="button" class="btn btn-danger" data-act="delete-contact" data-id="${c.id}">Remove</button>` : ''}<button class="btn btn-primary" type="submit">Save</button></div>
    </form>`;
  }
  return `<div class="toolbar"><a class="btn btn-primary" href="#/manage/contacts/new">+ New contact</a></div>
  ${all.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Shown as</th><th>Person</th><th>Listed</th></tr></thead>
    <tbody>${all.map((c) => `<tr><td><a href="#/manage/contacts/${c.id}">${esc(c.title)}</a></td><td>${esc(nameOf(c.user_id))}${onTeam.has(c.user_id) ? '' : ' <span class="tag tag-high">Not on the team: hidden</span>'}</td><td>${c.active ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody>
  </table></div>` : '<div class="empty">No contacts yet. Add the people alumni should talk to (for example the Business Coordinator and the Chief Engineers).</div>'}`;
}

async function managePages() {
  const s = settings();
  return `<form class="card stack" data-form="pages">
    <h2>The hub's words</h2>
    <div class="field"><label for="p-title">Title</label><input id="p-title" name="title" maxlength="80" value="${esc(s.title)}"></div>
    <div class="field"><label for="p-intro">Introduction (the start page)</label><textarea id="p-intro" name="intro" rows="3" maxlength="1000">${esc(s.intro)}</textarea></div>
    <div class="field"><label for="p-help">How to help</label><textarea id="p-help" name="howToHelp" rows="12" maxlength="10000">${esc(s.howToHelp)}</textarea>
      <div class="hint">Formatting: blank line = new paragraph, "## " for a heading, "- " for bullets, **bold**, *italic*, [link](https://…).</div></div>
    <div class="form-grid">
      <div class="field span-2"><label for="p-give">Giving link</label><input id="p-give" name="giveUrl" maxlength="300" value="${esc(s.giveUrl)}" placeholder="https://… (the UF Foundation page for Solar Gators)">
        <div class="hint">Leave empty to hide the giving button.</div></div>
      <div class="field span-2"><label for="p-givel">Button text</label><input id="p-givel" name="giveLabel" maxlength="60" value="${esc(s.giveLabel)}"></div>
    </div>
    <div class="alert alert-error form-error" hidden></div>
    <div class="form-actions"><a class="btn" href="#/help" target="_blank">Preview "How to help"</a><button class="btn btn-primary" type="submit">Save</button></div>
  </form>`;
}

// ---- photos ------------------------------------------------------------------------------------------
/** Shrink big photos before uploading (longest side 1600 px, JPEG). GIFs are kept as they are. */
async function shrink(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5e6) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }) : file;
  } catch {
    return file;
  }
}

async function upload(folder, file) {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image (JPEG, PNG, GIF or WebP).');
  const small = await shrink(file);
  if (small.size > 8 * 1024 * 1024) throw new Error('That photo is too large (8 MB at most).');
  const path = `${folder}/${crypto.randomUUID()}/${fileSlug(small.name)}`;
  const { error } = await sb.storage.from('sgaa').upload(path, small, { contentType: small.type, upsert: false });
  if (error) throw new Error(`The photo didn't upload: ${error.message}`);
  return path;
}

// ---- events (clicks, forms) --------------------------------------------------------------------------
const bool = (f, k) => f.get(k) === 'on';

async function onSubmit(form) {
  const f = new FormData(form);
  const id = form.dataset.id || null;
  const btn = form.querySelector('[type=submit]');
  if (btn) btn.disabled = true;
  try {
    switch (form.dataset.form) {
      case 'contact':
        await sendContact(form);   // goes to another page
        return;
      case 'rsvp':
        await rpc('sgaa_rsvp', { p_event: id, p_going: true, p_guests: Number(f.get('guests') || 0), p_note: f.get('note') || '' });
        $('#dlg').close();
        say('success', 'You\'re on the list. See you there!');
        await loadHub();
        break;
      case 'need': {
        const saved = await rpc('sgaa_save_need', { p_id: id, p: {
          title: f.get('title'), summary: f.get('summary'), body: f.get('body'), photo: f.get('photo'), cost: f.get('cost'),
          quantity: f.get('quantity'), subsystem: f.get('subsystem'), kind: f.get('kind'), urgency: f.get('urgency'),
          contactId: f.get('contactId'), status: f.get('status'), metNote: f.get('metNote') } });
        say('success', 'Saved.');
        await loadHub();
        location.hash = `#/manage/needs/${saved}`;
        if (id) await route();
        return;
      }
      case 'update': {
        const images = [...form.querySelectorAll('.photo-item')].map((el) => ({ path: el.dataset.path, caption: el.querySelector('input').value }));
        const saved = await rpc('sgaa_save_update', { p_id: id, p: {
          title: f.get('title'), body: f.get('body'), needId: f.get('needId'), pinned: bool(f, 'pinned'), published: bool(f, 'published'), images } });
        say('success', 'Saved.');
        await loadHub();
        location.hash = `#/manage/updates/${saved}`;
        if (id) await route();
        return;
      }
      case 'event': {
        const saved = await rpc('sgaa_save_event', { p_id: id, p: {
          title: f.get('title'), location: f.get('location'), body: f.get('body'), startsAt: fromLocalInput(f.get('startsAt')),
          endsAt: fromLocalInput(f.get('endsAt')), capacity: f.get('capacity'), rsvpOpen: bool(f, 'rsvpOpen'),
          published: bool(f, 'published'), cancelled: bool(f, 'cancelled') } });
        say('success', 'Saved.');
        await loadHub();
        location.hash = `#/manage/events/${saved}`;
        if (id) await route();
        return;
      }
      case 'contact-edit':
        await rpc('sgaa_save_contact', { p_id: id, p: {
          userId: f.get('userId'), title: f.get('title'), blurb: f.get('blurb'), active: bool(f, 'active'), sort: f.get('sort') || 100,
          topics: String(f.get('topics') || '').split(',').map((t) => t.trim()).filter(Boolean) } });
        say('success', 'Saved.');
        await loadHub();
        location.hash = '#/manage/contacts';
        return;
      case 'pages':
        await rpc('sgaa_save_settings', { p: { title: f.get('title'), intro: f.get('intro'), howToHelp: f.get('howToHelp'), giveUrl: f.get('giveUrl'), giveLabel: f.get('giveLabel') } });
        say('success', 'Saved.');
        await loadHub();
        await renderTop();
        break;
    }
    await route();
  } catch (err) {
    showError(err, form);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function onAct(el) {
  const id = el.dataset.id;
  try {
    switch (el.dataset.act) {
      case 'rsvp':
        return openRsvp(id);
      case 'unrsvp':
        await rpc('sgaa_rsvp', { p_event: id, p_going: false, p_guests: 0, p_note: '' });
        say('info', 'Your RSVP is taken back.');
        await loadHub();
        return route();
      case 'delete-need':
        if (!confirm(el.textContent.trim() === 'Archive' ? 'Archive this need? It comes off the public page.' : 'Delete this draft?')) return;
        await rpc('sgaa_delete_need', { p_id: id });
        await loadHub();
        location.hash = '#/manage/needs';
        return;
      case 'delete-update':
        if (!confirm('Delete this update?')) return;
        await rpc('sgaa_delete_update', { p_id: id });
        await loadHub();
        location.hash = '#/manage/updates';
        return;
      case 'delete-event':
        if (!confirm('Delete this event?')) return;
        await rpc('sgaa_delete_event', { p_id: id });
        await loadHub();
        location.hash = '#/manage/events';
        return;
      case 'delete-contact':
        if (!confirm('Remove this contact? Messages already sent stay in the log.')) return;
        await rpc('sgaa_delete_contact', { p_id: id });
        await loadHub();
        location.hash = '#/manage/contacts';
        return;
      case 'photo-clear': {
        const pick = el.closest('[data-photo-pick]');
        pick.querySelector('input[name=photo]').value = '';
        pick.querySelector('img').hidden = true;
        el.hidden = true;
        return;
      }
      case 'photo-remove':
        el.closest('.photo-item').remove();
        return;
    }
  } catch (err) {
    showError(err, el.closest('form') || main);
  }
}

async function onFile(input) {
  const files = [...input.files];
  input.value = '';
  const form = input.closest('form');
  try {
    if (input.dataset.upload === 'needs') {
      const path = await upload('needs', files[0]);
      const pick = input.closest('[data-photo-pick]');
      pick.querySelector('input[name=photo]').value = path;
      const img = pick.querySelector('img');
      img.src = photoUrl(path);
      img.hidden = false;
      pick.querySelector('[data-act=photo-clear]').hidden = false;
    } else {
      const list = form.querySelector('[data-photo-list]');
      if (list.children.length + files.length > 12) throw new Error('Up to 12 photos per update.');
      for (const file of files) list.insertAdjacentHTML('beforeend', photoItem(await upload('updates', file)));
    }
  } catch (err) {
    showError(err, form);
  }
}

document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  if (e.submitter?.value === 'cancel') return;   // a dialog's Cancel
  e.preventDefault();
  onSubmit(form);
});
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el) {
    e.preventDefault();
    onAct(el);
  }
});
document.addEventListener('change', (e) => {
  if (e.target.matches('input[type=file][data-upload]')) onFile(e.target);
});
window.addEventListener('hashchange', route);

// ---- start ---------------------------------------------------------------------------------------------
{
  const { data } = await sb.auth.getSession();
  user = data?.session?.user || null;
  try {
    await loadHub();
  } catch (err) {
    main.innerHTML = `<div class="alert alert-error">SGAA couldn't load: ${esc(err.message)}</div>`;
    throw err;
  }
  await renderTop();
  await route();
}
