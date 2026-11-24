/**
 * SGAA: the Solar Gators Alumni Association hub (sgaa/). What the team needs, how alumni can help, updates and
 * events, for everyone (signed in or not); contacting the team and RSVPs for alumni and the team; Manage for
 * people with "Edit the alumni hub". The database (052_sgaa.sql) decides who may do what; this page only
 * hides what someone can't use.
 *
 * Local testing: http://localhost:5190/sgaa/?fake runs every migration in an in-browser Postgres. Under
 * `npm run dev:fake` it's fake without ?fake too: the client is Orders' (orders/js/supabase.js), which that
 * server swaps for the fake one, so links from the other apps stay on the same fake database.
 */
import { signInUrl, appUrl } from '../shared/onesolar.js';
import { renderAccount } from '../shared/account-menu.js';
import { mountAppSwitcher } from '../shared/app-switcher.js';
import { howItWorks } from '../shared/help.js';
import { startErrorReporter } from '../shared/error-reporter.js';
import { startVersionCheck } from '../shared/version-check.js';
import { esc, formatText, money, when, ago, toLocalInput, fromLocalInput, splitEvents, spotsLeft, KINDS, URGENCY, fileSlug, isSchoolEmail, joinProblems,
  VISIBILITY, PROFILE_FIELDS, linkedinHref, initials, directoryMatch } from './lib.js';

const FAKE = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('fake');
const sb = (await import(FAKE ? '../tools/fake-supabase.js' : '../orders/js/supabase.js')).supabase;
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
/** Manage: editors (needs, updates, …) and alumni approvers (Alumni). */
const canManage = () => !!(hub?.canEdit || hub?.canAlumni);
/** Someone who could join as an alum: signed out, or signed in but not on the team and not an alum yet. */
const couldJoin = () => !hub || ['anon', 'guest'].includes(hub.viewer);
/** Where Orders keeps "My account" (name, password, email). */
const accountUrl = () => appUrl('orders/#/account');

async function loadHub() {
  hub = await rpc('sgaa_hub');
}

// ---- the top bar ---------------------------------------------------------------------------------------
async function renderTop() {
  let name = '', role = '';
  if (user) {
    const { data: p } = await sb.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
    name = p?.full_name || user.email;
    role = { team: 'Team', alum: 'Alum', pending: 'Alum (pending)', former: 'Former member', guest: 'Guest' }[hub?.viewer] || '';
  }
  renderAccount($('#account'), {
    user, name, role,
    links: [...(mayHaveCard() ? [{ label: 'My directory card', href: '#/profile' }] : []), ...(canManage() ? [{ label: 'Manage SGAA', href: '#/manage' }] : [])],
    onSignOut: async () => { await sb.auth.signOut(); location.hash = '#/'; location.reload(); },
  });
  $('#nav-manage').hidden = !canManage();
  $('#nav-messages').hidden = !insider();
  $('#nav-directory').hidden = !insider();
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
  join: renderJoin,
  messages: renderMessages,
  directory: renderDirectory,
  profile: renderProfile,
  manage: renderManage,
};

async function route() {
  const [section = '', ...rest] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const page = ROUTES[section] || renderNotFound;
  setActiveNav(section === 'need' ? 'needs' : section === 'profile' ? 'directory' : section);
  directoryRows = [];
  try {
    const html = await page(rest, params);
    if (html !== undefined) main.innerHTML = flashHTML() + emailBanner() + html;
    if (section === 'directory') filterDirectory();
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
  if (hub.viewer === 'pending') return '<div class="alert alert-info">Your alumni account is waiting for approval (<a href="#/join">your request</a>). Once someone on the team approves it, you can contact the team, RSVP to events and see the alumni directory.</div>';
  if (hub.viewer === 'former') return '<div class="alert alert-info">Your one.solar access has ended. If you graduated, ask someone on the team to mark you as an alum so you can use this page.</div>';
  if (hub.viewer === 'guest') return '<div class="alert alert-info">Are you a Solar Gators alum? <a href="#/join">Join as an alum</a> to contact the team, RSVP to events and see the alumni directory.</div>';
  return '';
}

/**
 * Alumni (and people asking to join as one) who still use a UF address: UF turns it off soon after graduation,
 * and then they couldn't sign in, reset their password, or get replies. Shown at the top of every page.
 */
function emailBanner() {
  if (!user || !['alum', 'pending'].includes(hub?.viewer) || !isSchoolEmail(user.email)) return '';
  return `<div class="alert alert-warning email-banner"><div><strong>Switch to a personal email.</strong>
    UF turns off ${esc(user.email)} soon after graduation. After that you couldn't sign in or reset your password, and
    replies from the team wouldn't reach you.</div><a class="btn btn-sm btn-primary" href="${esc(accountUrl())}">Change my email</a></div>`;
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
        ${couldJoin() ? '<a class="btn" href="#/join">Join as an alum</a>' : ''}
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
          <input id="c-subject" name="subject" maxlength="150" value="${esc(need ? need.title : '')}" placeholder="What it's about"></div>
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
  // The scheduled job emails it within a few minutes. Someone on the team may also start the sender right away
  // (send-notifications only answers team members and the schedule).
  if (hub.viewer === 'team' && !FAKE) sb.functions?.invoke('send-notifications', { body: {} }).catch(() => {});
  say('success', 'Sent. It reaches their inbox within a few minutes, and they\'ll reply to your email. It\'s also under Messages.');
  location.hash = f.get('need') ? `#/need/${f.get('need')}` : '#/help';
}

// ---- messages ----------------------------------------------------------------------------------------
// Everything sent through the contact form is kept: you see what you sent and what was sent to you; people
// with "Read alumni messages" (sgaa.messages) see all of them, so nothing gets lost when a contact moves on.
async function renderMessages(_, params) {
  if (!user) {
    location.href = signInUrl(location.pathname + '#/messages');
    return '';
  }
  if (!insider()) return viewerNote() || '<div class="empty">Messages are for alumni and the team.</div>';
  const show = params.get('show') || 'mine';
  const all = await rows(sb.from('sgaa_messages').select('*').order('created_at', { ascending: false }).limit(500));
  const mine = (m) => m.from_id === user.id || m.to_id === user.id;
  const list = all.filter((m) => (show === 'all' && hub.canMessages ? true : show === 'to' ? m.to_id === user.id : show === 'sent' ? m.from_id === user.id : mine(m)));
  const count = (fn) => all.filter(fn).length;
  const chip = (key, label, n) => `<a class="chip${show === key ? ' on' : ''}" href="#/messages${key === 'mine' ? '' : `?show=${key}`}">${esc(label)}${n != null ? ` (${n})` : ''}</a>`;
  return `<div class="page-head"><div><h1>Messages</h1>
    <p class="muted">What was sent through the alumni hub's contact form. Replies happen by email, straight between the two of you.</p></div>
    ${hub.contacts.length ? '<a class="btn btn-primary" href="#/contact">New message</a>' : ''}</div>
  <div class="filter-chips" role="group" aria-label="Show">
    ${chip('mine', 'Mine', count(mine))}${chip('to', 'To me', count((m) => m.to_id === user.id))}${chip('sent', 'Sent', count((m) => m.from_id === user.id))}
    ${hub.canMessages ? chip('all', 'Everyone\'s', all.length) : ''}
  </div>
  ${list.length ? `<div class="stack">${list.map(messageCard).join('')}</div>`
    : `<div class="empty">${show === 'to' ? 'Nobody has written to you yet.' : 'No messages here yet.'}</div>`}`;
}

function messageCard(m) {
  const toMe = m.to_id === user.id;
  const fromMe = m.from_id === user.id;
  const reply = `mailto:${encodeURIComponent(m.from_email)}?subject=${encodeURIComponent(`Re: ${m.subject}`)}`;
  return `<article class="card message">
    <div class="message-head">
      <div><b>${esc(fromMe ? 'You' : m.from_name)}</b> <span class="muted">→</span> <b>${esc(toMe ? 'you' : m.to_name)}</b>
        <div class="muted small">${esc(new Date(m.created_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))}${m.need_title
          ? ` · About ${m.need_id ? `<a href="#/need/${m.need_id}">${esc(m.need_title)}</a>` : esc(m.need_title)}` : ''}</div></div>
      ${m.emailed ? '' : '<span class="tag" title="Email was off when it was sent, so it\'s only here">Not emailed</span>'}
    </div>
    <h3>${esc(m.subject)}</h3>
    <div class="prose message-body">${esc(m.body).replace(/\n/g, '<br>')}</div>
    ${!fromMe && m.from_email ? `<div class="form-actions"><a class="btn btn-sm" href="${esc(reply)}">Reply by email</a></div>` : ''}
  </article>`;
}

// ---- the alumni directory ------------------------------------------------------------------------
// Alumni and the team see listed alums (sgaa_directory() blanks each field its owner keeps from them). Anyone
// in the hub can fill in their own card: team members' cards wait until they graduate; people waiting for
// approval can fill theirs in early.
const mayHaveCard = () => insider() || hub?.viewer === 'pending';
let directoryRows = [];   // the rows behind the cards on the directory page, for search

async function renderDirectory(_, params) {
  if (!user) {
    location.href = signInUrl(location.pathname + '#/directory');
    return '';
  }
  if (!insider()) return viewerNote() || '<div class="empty">The directory is for alumni and the team.</div>';
  const [people, me] = await Promise.all([rpc('sgaa_directory'), rpc('sgaa_my_profile')]);
  const q = params.get('q') || '';
  const mentors = params.has('mentors');
  let note = '';
  if (hub.viewer === 'team') note = '<div class="alert alert-info">Your own card shows up here once you graduate. You can <a href="#/profile">fill it in now</a>.</div>';
  else if (!me.listed) note = '<div class="alert alert-info">You\'re hidden from the directory. <a href="#/profile">Edit my card</a> to show up.</div>';
  else if (!me.employer && !me.jobTitle && !me.city && !me.mentorTopics && !me.bio) {
    note = '<div class="alert alert-info">Your card only shows your name and class. <a href="#/profile">Add where you work, where you live and what you\'re happy to talk about</a> so other alumni and the team can find you.</div>';
  }
  return `<div class="page-head"><div><h1>Alumni directory</h1>
      <p class="muted">Solar Gators alumni, for alumni and the team. Everyone chooses what's on their card and who sees it.</p></div>
    <a class="btn" href="#/profile">Edit my card</a></div>
  ${note}
  ${people.length ? `<div class="directory-tools">
    <input id="d-q" type="search" placeholder="Search names, employers, cities, years…" aria-label="Search the directory" value="${esc(q)}" autocomplete="off">
    <label class="check"><input type="checkbox" id="d-mentors"${mentors ? ' checked' : ''}> Happy to talk</label>
    <span class="muted small" id="d-count"></span>
  </div>
  <div class="people-grid" id="d-list">${people.map(personCard).join('')}</div>
  <div class="empty" id="d-none" hidden>Nobody matches that search.</div>`
    : '<div class="empty">No alumni are listed yet.</div>'}`;
}

function personCard(p) {
  directoryRows.push(p);
  const job = [p.job_title, p.employer].filter(Boolean).join(' at ');
  const sub = [p.grad_year ? `Class of ${p.grad_year}` : '', p.major].filter(Boolean).join(' · ');
  const li = linkedinHref(p.linkedin);
  const links = [li ? `<a href="${esc(li)}" target="_blank" rel="noopener noreferrer">LinkedIn</a>` : '',
    p.email ? `<a href="mailto:${esc(p.email)}">Email</a>` : ''].filter(Boolean).join('');
  return `<article class="card person" data-i="${directoryRows.length - 1}">
    <div class="person-head"><div class="avatar" aria-hidden="true">${esc(initials(p.full_name))}</div>
      <div><h3>${esc(p.full_name)}${p.me ? ' <span class="tag">You</span>' : ''}</h3>${sub ? `<div class="muted small">${esc(sub)}</div>` : ''}</div></div>
    ${job || p.city ? `<p class="person-job">${esc(job)}${job && p.city ? ' · ' : ''}${p.city ? `<span class="muted">${esc(p.city)}</span>` : ''}</p>` : ''}
    ${p.team_roles ? `<p class="small"><span class="muted">On the team:</span> ${esc(p.team_roles)}</p>` : ''}
    ${p.mentor_topics ? `<p class="small"><span class="muted">Happy to talk about:</span> ${esc(p.mentor_topics)}</p>` : ''}
    ${p.bio ? `<p class="small person-bio">${esc(p.bio)}</p>` : ''}
    ${links ? `<div class="person-links">${links}</div>` : ''}
    ${p.me ? '<p class="hint">You see everything on your card. Others see only what you chose to show them.</p>' : ''}
  </article>`;
}

/** Search as you type: hide the cards that don't match, and keep the search in the address (Back keeps it). */
function filterDirectory() {
  const list = $('#d-list');
  const box = $('#d-q');
  if (!list || !box) return;
  const q = box.value;
  const mentors = $('#d-mentors').checked;
  let shown = 0;
  for (const el of list.children) {
    const p = directoryRows[el.dataset.i];
    const ok = directoryMatch(p, q) && (!mentors || !!p.mentor_topics);
    el.hidden = !ok;
    if (ok) shown++;
  }
  $('#d-none').hidden = shown > 0;
  $('#d-count').textContent = shown === list.children.length ? `${shown} alumni` : `${shown} of ${list.children.length}`;
  const parts = [];
  if (q.trim()) parts.push(`q=${encodeURIComponent(q.trim())}`);
  if (mentors) parts.push('mentors');
  const hash = `#/directory${parts.length ? `?${parts.join('&')}` : ''}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

async function renderProfile() {
  if (!user) {
    location.href = signInUrl(location.pathname + '#/profile');
    return '';
  }
  if (!mayHaveCard()) return viewerNote() || '<div class="empty">Directory cards are for alumni and the team.</div>';
  const me = await rpc('sgaa_my_profile');
  const vis = me.visibility || {};
  const pick = (key, dflt = 'all') => `<select id="v-${key}" name="vis_${key}">${Object.entries(VISIBILITY)
    .map(([k, label]) => `<option value="${k}"${(vis[key] || dflt) === k ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  const row = (f) => `<div class="profile-row">
      <div class="field"><label for="p-${f.name}">${esc(f.label)}</label>
        ${f.textarea ? `<textarea id="p-${f.name}" name="${f.name}" rows="4" maxlength="${f.max}">${esc(me[f.name] || '')}</textarea>`
          : `<input id="p-${f.name}" name="${f.name}" type="${f.type || 'text'}" maxlength="${f.max}" value="${esc(me[f.name] || '')}" placeholder="${esc(f.placeholder || '')}">`}</div>
      <div class="field profile-vis"><label for="v-${f.key}">Who sees it</label>${pick(f.key)}</div>
    </div>`;
  const where = hub.viewer === 'team' ? '<div class="alert alert-info">Your card goes in the directory once you graduate. Until then, only you see it.</div>'
    : hub.viewer === 'pending' ? '<div class="alert alert-info">Your card goes in the directory once your alumni account is approved.</div>' : '';
  return `<a class="back-link" href="#/${hub.viewer === 'pending' ? '' : 'directory'}">← ${hub.viewer === 'pending' ? 'Alumni hub' : 'Alumni directory'}</a>
  <div class="narrow"><form class="card stack" data-form="profile">
    <h1>My directory card</h1>
    <p class="muted">Your name and class year are on your card for alumni and the team. Everything else is up to you: leave a
      field blank, or pick who sees it.</p>
    ${where}
    <div class="profile-row">
      <div class="field"><label for="p-year">Graduation year</label>
        <input id="p-year" name="gradYear" inputmode="numeric" maxlength="4" value="${esc(me.gradYear ?? '')}" placeholder="2024"></div>
    </div>
    ${PROFILE_FIELDS.map(row).join('')}
    <div class="profile-row">
      <div class="field"><label>Email</label><div class="readonly">${esc(user.email)}</div>
        <div class="hint">Change it in <a href="${esc(accountUrl())}">My account</a>.</div></div>
      <div class="field profile-vis"><label for="v-email">Who sees it</label>${pick('email', 'hidden')}</div>
    </div>
    <label class="check"><input type="checkbox" name="listed"${me.listed ? ' checked' : ''}> Show me in the alumni directory</label>
    <div class="alert alert-error form-error" hidden></div>
    <div class="form-actions"><button class="btn btn-primary" type="submit">Save my card</button></div>
  </form></div>`;
}

async function saveProfile(f) {
  const p = { gradYear: String(f.get('gradYear') || '').trim(), listed: f.get('listed') === 'on', visibility: {} };
  if (p.gradYear && !/^\d{4}$/.test(p.gradYear)) throw new Error('Graduation year has to be a year, like 2024.');
  for (const fld of PROFILE_FIELDS) p[fld.name] = String(f.get(fld.name) || '').trim();
  if (p.linkedin && !linkedinHref(p.linkedin)) throw new Error('The LinkedIn link has to be a linkedin.com address, starting with https://');
  for (const key of [...PROFILE_FIELDS.map((x) => x.key), 'email']) p.visibility[key] = f.get(`vis_${key}`) || 'all';
  await rpc('sgaa_save_profile', { p });
}

// ---- joining as an alum --------------------------------------------------------------------------
// Alumni who were never on one.solar (or whose account is gone) sign up here, with any email address (052's
// handle_new_user lets a sign-up marked { sgaa: 'alum' } through). They're a Guest until someone with
// "Approve alumni" approves them (Manage → Alumni). Members who graduate don't come here: a lead marks them
// Graduated in Admin → Users.
const JOIN_KEY = 'sgaa-join';   // what they typed, kept while they confirm their email (same browser)
const savedJoin = () => {
  try { return JSON.parse(localStorage.getItem(JOIN_KEY)) || null; } catch { return null; }
};
const keepJoin = (v) => {
  try { v ? localStorage.setItem(JOIN_KEY, JSON.stringify(v)) : localStorage.removeItem(JOIN_KEY); } catch { /* private mode */ }
};
const alumOf = (f) => ({ gradYear: String(f.gradYear ?? '').trim(), major: f.major || '', teamRoles: f.teamRoles || '', note: f.note || '' });

function alumFields(v = {}) {
  return `<div class="form-grid">
    <div class="field"><label for="j-year">Graduation year <span class="req">*</span></label>
      <input id="j-year" name="gradYear" inputmode="numeric" maxlength="4" required value="${esc(v.gradYear ?? '')}" placeholder="2024"></div>
    <div class="field"><label for="j-major">Major</label><input id="j-major" name="major" maxlength="80" value="${esc(v.major)}" placeholder="Electrical Engineering"></div>
    <div class="field span-2"><label for="j-roles">What you did on the team</label>
      <input id="j-roles" name="teamRoles" maxlength="200" value="${esc(v.teamRoles)}" placeholder="Battery lead 2021–22, driver at FSGP"></div>
    <div class="field span-4"><label for="j-note">Anything that helps the team recognize you</label>
      <textarea id="j-note" name="note" rows="3" maxlength="1000" placeholder="Who you worked with, which car, …">${esc(v.note)}</textarea></div>
  </div>`;
}

async function renderJoin() {
  const v = hub.viewer;
  const back = '<a class="back-link" href="#/">← Alumni hub</a>';
  if (v === 'alum') {
    location.hash = '#/';
    return undefined;
  }
  if (v === 'team') {
    return `${back}<div class="narrow"><div class="card stack"><h1>You're on the team</h1>
      <p>You don't need to join: when you graduate, a lead marks you as <strong>Graduated</strong> and you keep this hub as an alum.</p>
      ${isSchoolEmail(user?.email) ? `<p>Before UF turns off ${esc(user.email)}, <a href="${esc(accountUrl())}">switch your one.solar account to a personal email</a>.</p>` : ''}
    </div></div>`;
  }
  if (v === 'former') return `${back}${viewerNote()}`;
  const me = ['guest', 'pending'].includes(v) ? await rpc('sgaa_my_profile') : {};
  // Signing up here starts the request; the details follow once they're signed in (pending, no year yet).
  if (v === 'pending' && me.gradYear != null) {
    return `${back}<div class="narrow"><div class="card stack">
      <h1>Thanks! You're on the list</h1>
      <p>Someone on the team will check your request soon. Once you're approved you can contact the team, RSVP to events and
        see the alumni directory. Until then, have a look around.</p>
      <dl class="join-summary"><dt>Class of</dt><dd>${esc(me.gradYear ?? '')}</dd>${me.teamRoles ? `<dt>On the team</dt><dd>${esc(me.teamRoles)}</dd>` : ''}</dl>
      <div class="form-actions"><a class="btn btn-primary" href="#/needs">See what the team needs</a></div>
    </div></div>`;
  }
  if (v === 'guest' || v === 'pending') {
    const stored = savedJoin();
    let problem = '';
    // Signed up here, confirmed their email, and came back: send what they typed before.
    if (stored && me.status !== 'declined') {
      try {
        await requestAlum(stored);
        return undefined;
      } catch (err) {
        problem = err.message;
      }
    }
    return `${back}<div class="narrow"><form class="card stack" data-form="join-request">
      <h1>${v === 'pending' ? 'Finish joining as an alum' : 'Join as an alum'}</h1>
      ${me.status === 'declined' ? `<div class="alert alert-warning">The team couldn't confirm your last request${me.reviewNote ? `: “${esc(me.reviewNote)}”` : '.'}
        If that's a mistake, add more detail and ask again.</div>` : ''}
      <p class="muted">Tell the team who you are, so they can approve you. You're signed in as ${esc(user.email)}.</p>
      ${alumFields(stored || me)}
      <div class="alert alert-error form-error" ${problem ? '' : 'hidden'}>${esc(problem)}</div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Ask to join</button></div>
    </form></div>`;
  }
  // Signed out: make an account here (any email address), or sign in with the one they already have.
  const stored = savedJoin() || {};
  return `${back}<div class="narrow"><form class="card stack" data-form="join-signup" novalidate>
    <h1>Join as an alum</h1>
    <p class="muted">For Solar Gators alumni: see what the team needs, contact the people who can tell you more, RSVP to
      events and find other alumni. Someone on the team approves each account.</p>
    <p class="small">Already have a one.solar account? <a href="${esc(signInUrl(location.pathname + '#/join'))}">Sign in</a> and come back here.</p>
    <div class="form-grid">
      <div class="field span-2"><label for="j-name">Full name <span class="req">*</span></label><input id="j-name" name="fullName" autocomplete="name" required maxlength="120"></div>
      <div class="field span-2"><label for="j-email">Email <span class="req">*</span></label><input id="j-email" name="email" type="email" autocomplete="email" required>
        <div class="hint">A personal address: UF turns off yours soon after graduation.</div></div>
      <div class="field span-2"><label for="j-pass">Password <span class="req">*</span></label><input id="j-pass" name="password" type="password" autocomplete="new-password" minlength="8" required>
        <div class="hint">At least 8 characters.</div></div>
    </div>
    ${alumFields(stored)}
    <div class="alert alert-error form-error" hidden></div>
    <div class="form-actions"><button class="btn btn-primary" type="submit">Create my account</button></div>
  </form></div>`;
}

/** Ask to join as an alum (signed in), then show where they stand. */
async function requestAlum(f) {
  const problems = joinProblems(f);
  if (problems.length) throw new Error(problems.join(' '));
  await rpc('sgaa_request_alum', { p: alumOf(f) });
  keepJoin(null);
  await loadHub();
  await renderTop();
  if (location.hash === '#/join') await route();   // "Thanks! You're on the list"
  else location.hash = '#/join';
}

/** Supabase's sign-up errors, in words. */
function signUpError(m = '') {
  if (/already (been )?registered/i.test(m)) return 'There\'s already a one.solar account with that email address. Sign in instead (or reset your password there).';
  if (/database error saving new user/i.test(m)) return 'Alumni sign-ups are turned off right now. Ask someone on the team.';
  if (/rate limit/i.test(m)) return 'Too many emails were sent recently. Wait a few minutes and try again.';
  return m || 'That didn\'t work. Try again.';
}

async function signUpAsAlum(form) {
  const f = Object.fromEntries(new FormData(form));
  const problems = joinProblems(f, { signUp: true });
  if (problems.length) throw new Error(problems.join(' '));
  const email = f.email.trim().toLowerCase();
  keepJoin(alumOf(f));
  const { data, error } = await sb.auth.signUp({
    email,
    password: f.password,
    // The confirmation link opens Orders (it handles email links); from there they come back here.
    options: { data: { full_name: f.fullName.trim(), sgaa: 'alum' }, emailRedirectTo: appUrl('orders/') },
  });
  if (error) throw new Error(signUpError(error.message));
  if (data?.session) {
    user = data.session.user;
    await loadHub();
    return requestAlum(alumOf(f));
  }
  main.innerHTML = `<div class="narrow"><div class="card stack">
    <h1>Check your email</h1>
    <p>We sent a link to <strong>${esc(email)}</strong>. Click it to confirm your address, then sign in. Your request goes to the team
      when you come back to this page.</p>
    <p class="muted small">No email after a few minutes? Check your spam folder. If you already had a one.solar account with that
      address, no email is sent: <a href="${esc(signInUrl(location.pathname + '#/join'))}">sign in</a> instead.</p>
  </div></div>`;
  window.scrollTo(0, 0);
  return undefined;
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
// [key, label, who sees it: 'edit' = "Edit the alumni hub", 'alumni' = "Approve alumni"]
const MANAGE_TABS = [
  ['needs', 'Needs', 'edit'], ['updates', 'Updates', 'edit'], ['events', 'Events', 'edit'], ['contacts', 'Contacts', 'edit'],
  ['pages', 'Pages', 'edit'], ['alumni', 'Alumni', 'alumni'],
];
const mayTab = (who) => (who === 'edit' ? hub.canEdit : hub.canAlumni);

async function renderManage([tab, id]) {
  if (!canManage()) return '<div class="empty">Managing SGAA needs "Edit the alumni hub" or "Approve alumni" (Admin → Roles &amp; permissions).</div>';
  const mine = MANAGE_TABS.filter(([, , who]) => mayTab(who));
  if (!mine.some(([k]) => k === tab)) tab = mine[0][0];
  const tabs = `<div class="tabs">${mine.map(([k, l]) => `<a href="#/manage/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</div>`;
  const body = await ({ needs: manageNeeds, updates: manageUpdates, events: manageEvents, contacts: manageContacts, pages: managePages, alumni: manageAlumni }[tab])(id);
  return `<div class="page-head"><div><h1>Manage SGAA</h1><p class="muted">${tab === 'alumni'
    ? 'Alumni who signed up here wait for someone to recognize them.'
    : 'Everything here is public once it\'s published, except contacts\' names (alumni and the team only) and their emails (never shown).'}</p></div></div>${tabs}${body}`;
}

async function manageAlumni() {
  const queue = await rows(sb.rpc('sgaa_alumni_queue'));
  return `<p class="muted">People who signed up on this hub to join as an alum. Approve the ones you recognize.</p>
    ${howItWorks(`<p>Once approved they can contact the team, RSVP to events and see the alumni directory (never the team's apps).
    Graduating members don't show up here: mark them <strong>Graduated</strong> in <a href="${esc(appUrl('admin/#/admin/users'))}">Admin → Users</a>.</p>`, { id: 'sgaa-alumni-queue' })}
  <div class="alert alert-error form-error" hidden></div>
  ${queue.length ? `<div class="stack">${queue.map((q) => `<div class="card alum-req">
    <div class="alum-req-body">
      <b>${esc(q.full_name || q.email)}</b> <span class="muted small">${esc(q.email)}</span>
      ${q.confirmed ? '' : ' <span class="tag tag-high" title="They need to click the link we emailed them">Email not confirmed yet</span>'}
      <div class="small">${q.grad_year != null ? `Class of ${esc(q.grad_year)}` : '<span class="muted">Hasn\'t said when they graduated yet</span>'}${q.team_roles ? ` · ${esc(q.team_roles)}` : ''}</div>
      ${q.note ? `<p class="small alum-note">“${esc(q.note)}”</p>` : ''}
      <div class="muted small">Asked ${esc(ago(q.requested_at))}</div>
    </div>
    <div class="alum-req-actions">
      <button type="button" class="btn btn-sm btn-ghost" data-act="alum-decline" data-id="${q.user_id}" data-name="${esc(q.full_name || q.email)}">Decline…</button>
      <button type="button" class="btn btn-sm btn-primary" data-act="alum-approve" data-id="${q.user_id}" data-name="${esc(q.full_name || q.email)}"
        ${q.confirmed ? '' : 'disabled title="They need to confirm their email address first"'}>Approve</button>
    </div>
  </div>`).join('')}</div>` : '<div class="empty">Nobody is waiting.</div>'}`;
}

const STATUS = { draft: 'Draft', open: 'Public', met: 'Met', archived: 'Archived' };

async function manageNeeds(id) {
  const all = await rows(sb.from('sgaa_needs').select('*').order('created_at', { ascending: false }));
  if (id) {
    // Suggest the same subsystem names as the Orders request form (Admin → Request form → Dropdowns).
    const form = await rows(sb.from('app_settings').select('value').eq('key', 'form')).catch(() => []);
    const need = id === 'new' ? null : all.find((n) => n.id === id);
    return needForm(need, form[0]?.value?.subsystems || [], await projectsLink(need));
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

/** A need shared from Projects: where it lives there (a link, for people who can see that project). */
async function projectsLink(n) {
  if (!n?.pm_project_id) return '';
  const [item] = n.pm_item_id ? await rows(sb.from('pm_items').select('key, title').eq('id', n.pm_item_id)).catch(() => []) : [];
  const [project] = await rows(sb.from('pm_projects').select('key, name').eq('id', n.pm_project_id)).catch(() => []);
  const href = item ? appUrl(`projects/#/projects/item/${encodeURIComponent(item.key)}`)
    : project ? appUrl(`projects/#/projects/p/${encodeURIComponent(project.key)}`) : '';
  const label = item ? `${item.key} · ${item.title}` : project?.name || '';
  return `<div class="alert alert-info">Shared from Projects${href ? `: <a href="${esc(href)}">${esc(label)}</a>` : ' (from a project you can\'t see)'}.
    ${n.pm_item_id ? 'When that work item is finished, this need is marked met.' : ''}</div>`;
}

function needForm(n, subsystems = [], fromProjects = '') {
  const v = n || { status: 'draft', kind: 'parts', urgency: 'normal' };
  const contacts = hub.contacts;
  return `<a class="back-link" href="#/manage/needs">← Needs</a>
  <form class="card stack" data-form="need" data-id="${n?.id || ''}">
    <h2>${n ? 'Edit need' : 'New need'}</h2>
    ${fromProjects}
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
      case 'join-signup':
        await signUpAsAlum(form);
        return;
      case 'profile':
        await saveProfile(f);
        say('success', 'Your card is saved.');
        location.hash = hub.viewer === 'pending' ? '#/' : '#/directory';
        return;
      case 'join-request':
        await requestAlum(Object.fromEntries(f));
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
      case 'alum-approve':
        el.disabled = true;
        await rpc('sgaa_review_alum', { p_user: id, p_approve: true, p_note: '' });
        say('success', `${el.dataset.name} is now an alum.`);
        return route();
      case 'alum-decline': {
        const note = prompt(`Decline ${el.dataset.name}? They'll see this note if they try again (optional):`, '');
        if (note === null) return;
        await rpc('sgaa_review_alum', { p_user: id, p_approve: false, p_note: note });
        say('info', `Declined ${el.dataset.name}.`);
        return route();
      }
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
document.addEventListener('input', (e) => {
  if (e.target.id === 'd-q') filterDirectory();
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'd-mentors') filterDirectory();
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
