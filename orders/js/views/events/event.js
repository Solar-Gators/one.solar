/**
 * Events → one event. Everyone invited sees what, when, where and who's hosting, answers the RSVP and checks in.
 * Its hosts (and leads with "See attendance") also get the numbers and the attendance list: pick the columns
 * (sign-in answers too), filter, sort, save the view, download it (CSV or Excel). Hosts check people in by hand,
 * undo a check-in, mark late or excused, and run check-in (the QR screen). Every change is in the log.
 */
import { auth } from '../../auth.js';
import { esc, fmtDateTime, renderRichText, takeFlash, setFlash, askText } from '../../ui.js';
import { ev } from '../../events/api.js';
import { phase, whenText, standing, answerText, toCsv, STANDING_LABELS } from '../../events/core.js';
import { eventStats, pct } from '../../events/stats.js';
import { loadBase, needsDatabase, header, mayCreate, seesAll, runs, eventHref, categoryChip, phaseChip, standingChip, inviteWords, personName,
  placeOf, attempt, toast, formDialog, remember, downloadFile, downloadXlsx, fileDate, safeName, invalidate } from './kit.js';
import { rsvpButtons, bindRsvp } from './home.js';
import { projectsCard } from '../../related.js';

const RSVP_WORDS = { yes: 'Going', maybe: 'Maybe', no: 'Can\'t make it' };
/** The attendance list's columns; sign-in questions are added as q:<id>. */
const BASE_COLUMNS = [
  ['name', 'Name'], ['place', 'Division / subsystem'], ['position', 'Position'], ['status', 'Status'], ['rsvp', 'RSVP'], ['rsvp_note', 'RSVP note'],
  ['time', 'Checked in at'], ['how', 'How'], ['walk_in', 'Walk-in'], ['excused_note', 'Excused because'], ['email', 'Email'],
];
const DEFAULT_COLUMNS = ['name', 'place', 'status', 'rsvp', 'time'];
const FILTERS = [['all', 'Everyone'], ['here', 'Came'], ['late', 'Late'], ['not', 'Not here'], ['excused', 'Excused'], ['walkin', 'Walk-ins']];
const LOG_WORDS = {
  created: 'created the event', edited: 'edited the event', cancelled: 'cancelled the event', uncancelled: 'brought the event back',
  checkin_opened: 'opened check-in', checkin_closed: 'closed check-in', checked_in: 'checked in', check_in_undone: 'undid the check-in of',
  check_in_restored: 'put back the check-in of', excused: 'excused', unexcused: 'took back the excuse of', marked_late: 'marked late:', marked_on_time: 'marked on time:',
};

export async function renderEvent(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  const id = ctx.params.id;
  const tab = ctx.params.parts[1] || '';
  const [b, e] = await Promise.all([loadBase(), ev.event(id)]);
  if (!e) {
    el.innerHTML = '<section class="card no-access"><h1>Event not found</h1><p>It may have been deleted, or you aren\'t invited to it.</p><a class="btn" href="#/events">My events</a></section>';
    return;
  }
  const me = auth.user?.id;
  const host = runs(e);
  const lead = host || seesAll();
  const [invitees, rsvps, attendance, log] = await Promise.all([ev.invitees(id), ev.rsvps(id), ev.attendance(id), lead && tab === 'log' ? ev.log(id) : []]);
  const myInvite = invitees.find((i) => i.user_id === me);
  const myRsvp = rsvps.find((r) => r.user_id === me) || null;
  const myAtt = attendance.find((a) => a.user_id === me);
  const p = phase(e);
  const hostNames = [e.host_id, ...(e.cohosts || [])].filter(Boolean).map((x) => esc(personName(b, x)));

  const actions = host ? `<a class="btn" href="${eventHref(id, 'edit')}">Edit</a>
      ${mayCreate() ? `<a class="btn" href="#/events/new?copy=${esc(id)}">Duplicate</a>` : ''}
      ${!e.cancelled_at ? `<a class="btn btn-primary" href="${eventHref(id, 'screen')}" data-screen>Check-in screen</a>` : ''}
      <details class="ev-more"><summary class="btn btn-ghost" aria-label="More">⋯</summary><div class="ev-more-pop">
        ${!e.cancelled_at ? `<button type="button" class="btn btn-ghost" data-checkin-toggle>${e.checkin_open ? 'Close check-in' : 'Open check-in (no screen)'}</button>` : ''}
        <button type="button" class="btn btn-ghost" data-cancel-event>${e.cancelled_at ? 'Bring it back' : 'Cancel the event'}</button>
        <button type="button" class="btn btn-ghost text-danger" data-delete-event>Delete</button></div></details>` : '';

  const myBlock = !myInvite && !myAtt ? (lead ? '' : '<p class="muted">You aren\'t invited to this event.</p>')
    : myAtt ? `<p class="ev-mine" data-me-in>✓ You checked in ${esc(fmtDateTime(myAtt.checked_in_at))}${myAtt.late ? ' (late)' : ''}.</p>`
    : e.cancelled_at ? ''
    : `${e.checkin_open ? `<p><a class="btn btn-primary" href="#/events/checkin/${esc(id)}" data-check-in="${esc(id)}">I'm here: check in</a></p>` : ''}
       ${myInvite?.excused ? `<p class="muted">You're excused${myInvite.excused_note ? `: ${esc(myInvite.excused_note)}` : ''}.</p>` : ''}
       ${e.ask_rsvp && p !== 'over' ? `<div class="ev-mine"><span>Are you going?</span> ${rsvpButtons(e, myRsvp)}</div>` : ''}
       ${p === 'over' && myInvite ? `<p>${standingChip(standing(e, { invited: true, excused: myInvite.excused, rsvp: myRsvp }))}</p>` : ''}`;

  el.innerHTML = `${takeFlash()}${header(esc(e.title), `${categoryChip(b, e.category_id)} ${phaseChip(e)}`, actions)}
    ${e.cancelled_at ? `<div class="alert alert-error" role="status"><strong>Cancelled.</strong> ${esc(e.cancel_note || '')}</div>` : ''}
    <section class="card ev-info">
      <dl class="ev-facts">
        <div><dt>When</dt><dd>${esc(whenText(e, { year: true }))}</dd></div>
        ${e.location ? `<div><dt>Where</dt><dd>${esc(e.location)}</dd></div>` : ''}
        <div><dt>Hosted by</dt><dd>${hostNames.join(', ') || '—'}</dd></div>
        <div><dt>Invited</dt><dd>${esc(inviteWords(b, e))}</dd></div>
        ${e.late_after_min !== null && e.late_after_min !== undefined ? `<div><dt>Late after</dt><dd>${e.late_after_min} min</dd></div>` : ''}
      </dl>
      ${e.notes ? `<div class="ev-notes">${renderRichText(e.notes)}</div>` : ''}
      ${myBlock}
    </section>
    <div data-projects-card></div>
    ${lead ? `<nav class="page-tabs" aria-label="This event"><a href="${eventHref(id)}" class="${tab !== 'log' ? 'active' : ''}">Attendance</a><a href="${eventHref(id, 'log')}" class="${tab === 'log' ? 'active' : ''}">Log</a></nav>
      <div data-lead></div>` : ''}`;

  bindRsvp(el, () => myRsvp, () => ctx.rerender());
  projectsCard(el.querySelector('[data-projects-card]'), 'event', e.id);   // V2
  if (host) bindHostActions(el, e, ctx);
  if (!lead) return;
  const box = el.querySelector('[data-lead]');
  if (tab === 'log') return void (box.innerHTML = logHtml(b, log));
  attendanceSection(box, { b, e, invitees, rsvps, attendance, host, ctx });
}

function bindHostActions(el, e, ctx) {
  el.querySelector('[data-checkin-toggle]')?.addEventListener('click', async () => {
    if (await attempt(() => ev.setCheckin(e.id, !e.checkin_open), e.checkin_open ? 'Check-in closed' : 'Check-in is open')) ctx.rerender();
  });
  el.querySelector('[data-cancel-event]').addEventListener('click', async () => {
    if (e.cancelled_at) {
      if (await attempt(() => ev.save(e.id, { cancelled: false }), 'It\'s back on')) ctx.rerender();
      return;
    }
    const note = await askText({ title: 'Cancel this event?', label: 'Why (shown to everyone invited; optional)', required: false, ok: 'Cancel the event' });
    if (note === null) return;
    if (await attempt(() => ev.save(e.id, { cancelled: true, cancel_note: note }), 'Cancelled')) ctx.rerender();
  });
  el.querySelector('[data-delete-event]').addEventListener('click', async () => {
    const ok = await formDialog({ title: `Delete ${esc(e.title)}?`, danger: true, submit: 'Delete it',
      body: '<p>The event, its invitations, RSVPs, check-ins and log are deleted for good. To keep its attendance, cancel it instead.</p>',
      onSubmit: () => ev.remove(e.id) });
    if (!ok) return;
    invalidate();
    setFlash(`Deleted "${e.title}".`);
    location.hash = '#/events';
  });
}

function logHtml(b, log) {
  if (!log.length) return '<section class="card"><p class="empty">Nothing yet.</p></section>';
  return `<section class="card"><ol class="ev-log">${log.map((l) => {
    const who = l.user_id ? esc(personName(b, l.user_id)) : '';
    const extra = l.action === 'checked_in' ? ` ${l.details?.how === 'host' ? '(by hand)' : '(scanned the code)'}${l.details?.late ? ', late' : ''}${l.details?.walk_in ? ', walk-in' : ''}`
      : l.details?.note ? `: ${esc(l.details.note)}` : '';
    const sentence = l.action === 'checked_in' && l.user_id === l.actor_id ? `<strong>${who}</strong> checked in${extra}`
      : `<strong>${esc(l.actor_name || 'Someone')}</strong> ${esc(LOG_WORDS[l.action] || l.action)} ${who}${extra}`;
    return `<li><time datetime="${esc(l.at)}">${esc(fmtDateTime(l.at))}</time> ${sentence}</li>`;
  }).join('')}</ol></section>`;
}

/** The numbers, the "check someone in" box and the list. */
function attendanceSection(box, { b, e, invitees, rsvps, attendance, host, ctx }) {
  const s = eventStats({ events: [e], invitees, rsvps, attendance, org: b.org, divisions: b.divisions, subsystems: b.subsystems }, e);
  const questions = e.questions || [];
  const allColumns = [...BASE_COLUMNS, ...questions.map((q) => [`q:${q.id}`, q.label])];
  const known = new Set(allColumns.map(([k]) => k));
  const saved = remember.get('list', {});
  const state = {
    columns: (saved.columns || DEFAULT_COLUMNS).filter((k) => known.has(k) || k.startsWith('q:')),
    showAnswers: saved.showAnswers !== false,
    filter: 'all', q: '', sort: saved.sort || 'name', dir: saved.dir || 'asc',
  };
  const rsvpOf = new Map(rsvps.map((r) => [r.user_id, r]));
  const attOf = new Map(attendance.map((a) => [a.user_id, a]));
  const invOf = new Map(invitees.map((i) => [i.user_id, i]));
  const ids = [...new Set([...invitees.map((i) => i.user_id), ...attendance.map((a) => a.user_id)])];
  const positions = new Map(b.positions.map((r) => [r.key, r.label]));
  const rows = ids.map((uid) => {
    const person = b.personById.get(uid) || {};
    const inv = invOf.get(uid);
    const rsvp = rsvpOf.get(uid);
    const att = attOf.get(uid);
    const st = standing(e, { invited: !!inv, excused: inv?.excused, rsvp, att });
    const value = {
      name: person.full_name || person.email || 'Someone', place: placeOf(b, uid), email: person.email || '',
      position: (person.roles || []).map((r) => positions.get(r)).filter(Boolean).join(', '),
      status: STANDING_LABELS[st] || '', rsvp: rsvp ? RSVP_WORDS[rsvp.answer] : '', rsvp_note: rsvp?.note || '',
      time: att ? new Date(att.checked_in_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '',
      how: att ? (att.how === 'host' ? `By ${att.by_name || 'a host'}` : 'Scanned') : '', walk_in: att?.walk_in ? 'Yes' : '',
      // Excused by a host (their note), or said they can't make it (their reason).
      excused_note: st !== 'excused' ? '' : inv?.excused ? inv.excused_note || `Excused by ${inv.excused_by || 'a host'}` : rsvp?.note || 'Said they can\'t make it',
    };
    for (const q of questions) value[`q:${q.id}`] = answerText(q, att?.answers?.[q.id]);
    return { uid, st, inv, att, value, sortTime: att?.checked_in_at || '' };
  });

  const tile = (n, label, extra = '') => `<div class="ev-tile${extra}"><strong>${n}</strong><span>${label}</span></div>`;
  box.innerHTML = `<section class="ev-tiles" data-tiles>
      ${tile(s.invited, 'invited')}
      ${e.ask_rsvp ? tile(`${s.yes}<small> / ${s.maybe} / ${s.no}</small>`, 'going / maybe / can\'t') : ''}
      ${tile(s.came, 'came', ' is-good')}${s.walkIns ? tile(s.walkIns, 'walk-ins') : ''}${s.late ? tile(s.late, 'late') : ''}
      ${tile(s.excused, 'excused')}${phase(e) === 'over' ? tile(s.missed, 'missed', s.missed ? ' is-bad' : '') : ''}
      ${tile(pct(s.turnout), 'turnout')}</section>
    ${host && !e.cancelled_at ? `<section class="card ev-add"><form class="ev-add-form" data-add>
      <label for="ev-add-person">Check someone in by hand</label>
      <select id="ev-add-person" name="person"><option value="">Pick someone…</option>${b.people.filter((x) => !attOf.has(x.id))
        .map((x) => `<option value="${esc(x.id)}">${esc(x.full_name || x.email)}${invOf.has(x.id) ? '' : ' (not invited)'}</option>`).join('')}</select>
      <button type="submit" class="btn">Check in</button></form></section>` : ''}
    <section class="card">
      <div class="ev-list-bar">
        <div class="pm-seg" role="group" aria-label="Show">${FILTERS.map(([k, l]) => `<button type="button" data-filter="${k}" aria-pressed="${state.filter === k}" class="${state.filter === k ? 'is-on' : ''}">${l}</button>`).join('')}</div>
        <input type="search" data-find placeholder="Find a name…" aria-label="Find a name">
        <details class="ev-cols"><summary class="btn btn-sm">Columns</summary><div class="ev-cols-pop">
          ${allColumns.map(([k, l]) => `<label class="pm-check"><input type="checkbox" data-col="${esc(k)}" ${state.columns.includes(k) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}
          ${questions.length ? '<p class="hint">Sign-in questions are at the end.</p>' : ''}</div></details>
        <select data-view aria-label="Saved views"><option value="">Saved views…</option></select>
        <button type="button" class="btn btn-sm" data-csv>CSV</button><button type="button" class="btn btn-sm" data-xlsx>Excel</button>
      </div>
      <div data-table></div>
    </section>`;

  const matches = (r) => {
    const f = state.filter;
    if (f === 'here' && !r.att) return false;
    if (f === 'late' && !r.att?.late) return false;
    if (f === 'not' && (r.att || r.st === 'excused')) return false;
    if (f === 'excused' && r.st !== 'excused') return false;
    if (f === 'walkin' && !r.att?.walk_in) return false;
    return !state.q || r.value.name.toLowerCase().includes(state.q);
  };
  const shown = () => {
    const list = rows.filter(matches);
    const k = state.sort;
    const by = k === 'time' ? (r) => r.sortTime : (r) => String(r.value[k] ?? '').toLowerCase();
    list.sort((a, z) => (by(a) < by(z) ? -1 : by(a) > by(z) ? 1 : a.value.name.localeCompare(z.value.name)) * (state.dir === 'asc' ? 1 : -1));
    return list;
  };
  const cols = () => state.columns.map((k) => allColumns.find(([x]) => x === k)).filter(Boolean);
  const keep = () => remember.set('list', { columns: state.columns, sort: state.sort, dir: state.dir });

  const acts = host || seesAll();   // a column of buttons
  const draw = () => {
    const list = shown();
    const c = cols();
    box.querySelector('[data-table]').innerHTML = list.length ? `<div class="table-wrap"><table class="table ev-table" data-fit><thead><tr>
      ${c.map(([k, l]) => `<th aria-sort="${state.sort === k ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" class="ev-sort" data-sort="${esc(k)}">${esc(l)}${state.sort === k ? (state.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`).join('')}
      ${acts ? '<th><span class="visually-hidden">Actions</span></th>' : ''}</tr></thead><tbody>
      ${list.map((r) => `<tr data-row="${esc(r.uid)}">${c.map(([k, l]) => `<td data-label="${esc(l)}">${k === 'status' ? standingChip(r.st) || '<span class="muted">—</span>'
        : k === 'name' && seesAll() ? `<a href="#/events/stats/person/${esc(r.uid)}" class="ev-person">${esc(r.value.name)}</a>` : esc(r.value[k] || '')}</td>`).join('')}
        ${acts ? `<td class="ev-row-actions">${rowActions(e, r, host)}</td>` : ''}</tr>`).join('')}</tbody></table></div>
      <p class="muted small" data-count>${list.length} of ${rows.length}</p>`
      : `<p class="empty">${rows.length ? 'Nobody matches.' : 'Nobody is invited yet.'}</p>`;
  };
  const views = () => remember.get('views', []);
  const drawViews = () => {
    const sel = box.querySelector('[data-view]');
    sel.innerHTML = `<option value="">Saved views…</option>${views().map((v, i) => `<option value="${i}">${esc(v.name)}</option>`).join('')}
      <option value="save">Save this view…</option>${views().length ? '<option value="delete">Delete a view…</option>' : ''}`;
  };
  const applyCols = () => box.querySelectorAll('[data-col]').forEach((x) => (x.checked = state.columns.includes(x.dataset.col)));
  const applyFilter = () => box.querySelectorAll('[data-filter]').forEach((x) => {
    x.classList.toggle('is-on', x.dataset.filter === state.filter);
    x.setAttribute('aria-pressed', String(x.dataset.filter === state.filter));
  });

  box.addEventListener('click', async (x) => {
    const f = x.target.closest('[data-filter]');
    if (f) {
      state.filter = f.dataset.filter;
      applyFilter();
      return draw();
    }
    const sorter = x.target.closest('[data-sort]');
    if (sorter) {
      const k = sorter.dataset.sort;
      state.dir = state.sort === k && state.dir === 'asc' ? 'desc' : 'asc';
      state.sort = k;
      keep();
      return draw();
    }
    const act = x.target.closest('[data-act]');
    if (act) await rowAction(act.dataset.act, act.closest('[data-row]').dataset.row, { b, e, rows, ctx });
  });
  box.querySelector('[data-find]').addEventListener('input', (x) => {
    state.q = x.target.value.trim().toLowerCase();
    draw();
  });
  box.querySelectorAll('[data-col]').forEach((x) => x.addEventListener('change', () => {
    const order = allColumns.map(([k]) => k);
    state.columns = order.filter((k) => (k === x.dataset.col ? x.checked : state.columns.includes(k)));
    if (!state.columns.length) state.columns = ['name'];
    keep();
    draw();
  }));
  box.querySelector('[data-view]').addEventListener('change', async (x) => {
    const v = x.target.value;
    x.target.value = '';
    if (v === 'save') {
      const name = await askText({ title: 'Save this view', label: 'Name', placeholder: 'e.g. Who came, with answers', ok: 'Save' });
      if (!name) return;
      remember.set('views', [...views().filter((w) => w.name !== name), { name, columns: state.columns, filter: state.filter, sort: state.sort, dir: state.dir }]);
      toast(`Saved "${name}" (in this browser)`);
      return drawViews();
    }
    if (v === 'delete') {
      const name = await askText({ title: 'Delete a view', label: `Which one? (${views().map((w) => w.name).join(', ')})`, ok: 'Delete' });
      if (name) remember.set('views', views().filter((w) => w.name !== name));
      return drawViews();
    }
    const view = views()[Number(v)];
    if (!view) return;
    Object.assign(state, { columns: view.columns, filter: view.filter || 'all', sort: view.sort || 'name', dir: view.dir || 'asc' });
    applyCols();
    applyFilter();
    keep();
    draw();
  });
  const table = () => [cols().map(([, l]) => l), ...shown().map((r) => cols().map(([k]) => r.value[k] ?? ''))];
  const name = `${safeName(e.title)}-${String(e.starts_at).slice(0, 10)}-attendance`;
  box.querySelector('[data-csv]').addEventListener('click', () => downloadFile(`${name}.csv`, toCsv(table())));
  box.querySelector('[data-xlsx]').addEventListener('click', () => attempt(() => {
    const [head, ...body] = table();
    return downloadXlsx(`${name}.xlsx`, e.title, head, body);
  }));
  box.querySelector('[data-add]')?.addEventListener('submit', async (x) => {
    x.preventDefault();
    const uid = x.target.elements.person.value;
    if (!uid) return;
    if (await attempt(() => ev.hostCheckIn(e.id, uid), `Checked in ${personName(b, uid)}`)) ctx.rerender();
  });
  drawViews();
  draw();
}

/** Hosts: check in / undo / late / excuse. Leads who aren't hosting: excuse only. */
function rowActions(e, r, host) {
  const btn = (act, label, title = '') => `<button type="button" class="btn btn-ghost btn-sm" data-act="${act}"${title ? ` title="${esc(title)}"` : ''}>${label}</button>`;
  if (!host) return r.inv && !r.att ? btn(r.inv.excused ? 'unexcuse' : 'excuse', r.inv.excused ? 'Not excused' : 'Excuse') : '';
  if (r.att) return `${btn(r.att.late ? 'ontime' : 'late', r.att.late ? 'On time' : 'Late')}${btn('undo', 'Undo check-in')}`;
  return `${!e.cancelled_at ? btn('in', 'Check in') : ''}${r.inv ? btn(r.inv.excused ? 'unexcuse' : 'excuse', r.inv.excused ? 'Not excused' : 'Excuse') : ''}`;
}

async function rowAction(act, uid, { b, e, ctx }) {
  const who = personName(b, uid);
  if (act === 'in') {
    if (await attempt(() => ev.hostCheckIn(e.id, uid), `Checked in ${who}`)) ctx.rerender();
  } else if (act === 'late' || act === 'ontime') {
    if (await attempt(() => ev.setLate(e.id, uid, act === 'late'), act === 'late' ? `${who}: late` : `${who}: on time`)) ctx.rerender();
  } else if (act === 'undo') {
    const was = await attempt(() => ev.undoCheckIn(e.id, uid));
    if (!was) return;
    ctx.rerender();
    toast(`Undid ${who}'s check-in`, 'ok', { undo: async () => {
      if (await attempt(() => ev.restoreCheckIn(e.id, uid, was), `${who} is checked in again`)) ctx.rerender();
    } });
  } else if (act === 'excuse') {
    const note = await askText({ title: `Excuse ${who}`, label: 'Why (optional)', required: false, ok: 'Excuse' });
    if (note === null) return;
    if (await attempt(() => ev.excuse(e.id, uid, true, note), `${who} is excused`)) ctx.rerender();
  } else if (act === 'unexcuse') {
    if (await attempt(() => ev.excuse(e.id, uid, false), `${who} isn't excused any more`)) ctx.rerender();
  }
}
