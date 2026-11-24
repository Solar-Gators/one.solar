/**
 * Events → Stats (leads with "See attendance"). Who came to what, and how many came to what:
 *   People: invited, came, late, walk-ins, excused, missed, rate, last came, and a count per category;
 *   Events: invited, RSVPs, came, walk-ins, turnout (and by division / subsystem);
 *   Groups: each division or subsystem's average rate, and how many are at or above / below a threshold.
 * Filter by semester, dates, category, division, subsystem and position; download any table. A person's name
 * opens every event they were invited to. Nothing is weighted: the team decides what the numbers mean.
 */
import { esc } from '../../ui.js';
import { ev } from '../../events/api.js';
import { semesterOf, semestersIn, toCsv, whenText } from '../../events/core.js';
import { peopleStats, eventsTable, groupStats, personHistory, countedEvents, pct } from '../../events/stats.js';
import { loadBase, needsDatabase, header, eventHref, categoryChip, standingChip, placeOf, remember, downloadFile, downloadXlsx, fileDate, attempt } from './kit.js';

let closeBound = false;
const TABS = [['people', 'People'], ['events', 'Events'], ['groups', 'Divisions & subsystems']];

async function loadAll() {
  const [b, events, invitees, rsvps, attendance] = await Promise.all([loadBase(), ev.events(), ev.invitees(), ev.rsvps(), ev.attendance()]);
  return { b, data: { events, invitees, rsvps, attendance, people: b.people, org: b.org, divisions: b.divisions, subsystems: b.subsystems } };
}

/** The filters, kept in this browser. */
function filtersOf(events) {
  const saved = remember.get('stats', {});
  const sems = semestersIn(events.filter((e) => new Date(e.starts_at) <= new Date()));
  const now = semesterOf(new Date().toISOString());
  return {
    semester: saved.semester === undefined ? (sems.includes(now) ? now : sems[0] || '') : saved.semester,
    categories: saved.categories || [], from: saved.from || '', to: saved.to || '',
    division: saved.division || '', subsystem: saved.subsystem || '', role: saved.role || '',
    noIsExcused: saved.noIsExcused !== false, by: saved.by || 'division', threshold: saved.threshold ?? 75,
    sort: saved.sort || 'name', dir: saved.dir || 'asc',
  };
}

/** How many filters (besides the semester) are narrowing the numbers: shown on the Filter ▾ button. */
function activeFilters(f, tab) {
  return [f.from, f.to, ...(tab !== 'events' ? [f.division, f.subsystem, f.role] : []), f.categories.length, !f.noIsExcused].filter(Boolean).length;
}
const filterLabel = (on) => `Filter${on ? ` · ${on}` : ''} <span aria-hidden="true">▾</span>`;

// The semester stays in view; everything else is in the same Filter ▾ menu as the other lists (shared/onesolar.css .list-filter).
function filterBar(b, f, events, tab) {
  const sems = semestersIn(events);
  const opt = (v, l, on) => `<option value="${esc(v)}" ${on ? 'selected' : ''}>${esc(l)}</option>`;
  const on = activeFilters(f, tab);
  return `<form class="list-bar ev-stats-filters" data-filters>
    <label class="ev-sem">Semester <select name="semester" class="list-bar-select">${opt('', 'All time', !f.semester)}${sems.map((s) => opt(s, s, s === f.semester)).join('')}</select></label>
    <details class="list-filter"><summary class="btn btn-sm${on ? ' is-on' : ''}" data-filter-sum>${filterLabel(on)}</summary>
    <div class="list-filter-pop ev-stats-pop">
    <label>From <input type="date" name="from" value="${esc(f.from)}"></label>
    <label>To <input type="date" name="to" value="${esc(f.to)}"></label>
    ${tab !== 'events' ? `<label>Division <select name="division">${opt('', 'All', !f.division)}${b.divisions.filter((d) => !d.archived_at).map((d) => opt(d.id, d.name, d.id === f.division)).join('')}</select></label>
    <label>Subsystem <select name="subsystem">${opt('', 'All', !f.subsystem)}${b.subsystems.filter((s) => !s.archived_at).map((s) => opt(s.id, `${b.names.division.get(s.division_id) || ''} · ${s.name}`, s.id === f.subsystem)).join('')}</select></label>
    <label>Position <select name="role">${opt('', 'All', !f.role)}${b.positions.map((r) => opt(r.key, r.label, r.key === f.role)).join('')}</select></label>` : ''}
    <div class="ev-cat-filter" role="group" aria-label="Categories"><span>Categories</span>${b.categories.filter((c) => !c.archived_at).map((c) =>
      `<label class="pm-check"><input type="checkbox" name="category" value="${esc(c.id)}" ${f.categories.includes(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('')}</div>
    <label class="pm-check"><input type="checkbox" name="noIsExcused" ${f.noIsExcused ? 'checked' : ''}> "Can't make it" counts as excused</label>
    ${tab === 'groups' ? `<label>By <select name="by">${opt('division', 'Division', f.by === 'division')}${opt('subsystem', 'Subsystem', f.by === 'subsystem')}</select></label>
      <label>Threshold <input type="number" name="threshold" min="0" max="100" step="5" value="${esc(f.threshold)}"> %</label>` : ''}
    <button type="button" class="link-btn" data-reset>Reset all filters</button>
    </div></details>
  </form>`;
}
function readFilters(form, f) {
  const e = form.elements;
  Object.assign(f, {
    semester: e.semester.value, from: e.from.value, to: e.to.value,
    division: e.division?.value ?? f.division, subsystem: e.subsystem?.value ?? f.subsystem, role: e.role?.value ?? f.role,
    categories: [...form.querySelectorAll('[name=category]:checked')].map((x) => x.value), noIsExcused: e.noIsExcused.checked,
    by: e.by?.value ?? f.by, threshold: e.threshold ? Number(e.threshold.value) || 0 : f.threshold,
  });
}

/** A sortable table with download buttons. cols: [{ key, label, num, html(row), value(row) }]. */
function table(box, f, cols, rows, { name, empty, onRow }) {
  // The chosen column, else the first (names A to Z; dates newest first).
  const chosen = cols.find((c) => c.key === f.sort);
  const sortCol = chosen || cols[0];
  const dir = chosen ? f.dir : sortCol.key === 'date' ? 'desc' : 'asc';
  const val = (c, r) => c.value(r);
  const cmp = (x, y) => {
    const blank = (v) => v === null || v === undefined || v === '';
    if (blank(x) || blank(y)) return blank(x) - blank(y) ? (blank(x) ? -1 : 1) : 0;
    return typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) : x - y;
  };
  const sorted = [...rows].sort((a, z) => (dir === 'asc' ? 1 : -1) * cmp(val(sortCol, a), val(sortCol, z))
    || String(val(cols[0], a)).localeCompare(String(val(cols[0], z))));
  Object.assign(box.dataset, { sortKey: sortCol.key, sortDir: dir });   // what's shown, so a click flips it
  box.innerHTML =`<div class="ev-table-tools"><span class="muted small">${rows.length} ${rows.length === 1 ? 'row' : 'rows'}</span>
      <button type="button" class="btn btn-sm" data-csv>CSV</button><button type="button" class="btn btn-sm" data-xlsx>Excel</button></div>
    ${rows.length ? `<div class="table-wrap"><table class="table ev-table" data-fit><thead><tr>${cols.map((c) => `<th class="${c.num ? 'num' : ''}" aria-sort="${c === sortCol ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}">
      <button type="button" class="ev-sort" data-sort="${esc(c.key)}">${esc(c.label)}${c === sortCol ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`).join('')}</tr></thead>
      <tbody>${sorted.map((r) => `<tr ${onRow ? `data-href="${esc(onRow(r))}"` : ''}>${cols.map((c) => `<td data-label="${esc(c.label)}" class="${c.num ? 'num' : ''}">${c.html ? c.html(r) : esc(c.value(r) ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : `<p class="empty">${empty}</p>`}`;
  const plain = () => [cols.map((c) => c.label), ...sorted.map((r) => cols.map((c) => (c.export ? c.export(r) : c.value(r) ?? '')))];
  box.querySelector('[data-csv]').onclick = () => downloadFile(`${name}-${fileDate()}.csv`, toCsv(plain()));
  box.querySelector('[data-xlsx]').onclick = () => attempt(() => {
    const [head, ...body] = plain();
    return downloadXlsx(`${name}-${fileDate()}.xlsx`, name, head, body);
  });
}

export async function renderEventStats(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  const tab = TABS.some(([k]) => k === ctx.params.id) ? ctx.params.id : 'people';
  const { b, data } = await loadAll();
  const f = filtersOf(data.events);
  el.innerHTML = `${header('Attendance stats', 'Who came to what, and how many came to what. Only events that have started count; cancelled ones don\'t.')}
    <nav class="page-tabs" aria-label="Stats">${TABS.map(([k, l]) => `<a href="#/events/stats${k === 'people' ? '' : `/${k}`}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</nav>
    <div data-bar></div><section class="card" data-out></section>`;
  const out = el.querySelector('[data-out]');
  const keep = () => remember.set('stats', f);

  const draw = () => {
    const opts = { ...f, threshold: f.threshold / 100 };
    const n = countedEvents(data, opts).length;
    const cats = b.categories.filter((c) => !c.archived_at && (!f.categories.length || f.categories.includes(c.id)));
    if (tab === 'people') {
      const rows = peopleStats(data, opts);
      const num = (key, label, fn = (r) => r[key]) => ({ key, label, num: true, value: fn });
      table(out, f, [
        { key: 'name', label: 'Name', value: (r) => r.person.full_name || r.person.email, html: (r) => `<a href="#/events/stats/person/${esc(r.person.id)}">${esc(r.person.full_name || r.person.email)}</a>` },
        { key: 'place', label: 'Division / subsystem', value: (r) => placeOf(b, r.person.id) },
        num('invited', 'Invited'), num('came', 'Came'), num('late', 'Late'), num('walkIns', 'Walk-ins'), num('excused', 'Excused'), num('missed', 'Missed'),
        { key: 'rate', label: 'Rate', num: true, value: (r) => r.rate, html: (r) => pct(r.rate), export: (r) => (r.rate === null ? '' : Math.round(r.rate * 100)) },
        { key: 'last', label: 'Last came', value: (r) => r.lastCame, html: (r) => (r.lastCame ? esc(new Date(r.lastCame).toLocaleDateString()) : '<span class="muted">—</span>'), export: (r) => (r.lastCame ? r.lastCame.slice(0, 10) : '') },
        ...cats.map((c) => num(`cat:${c.id}`, c.name, (r) => r.byCategory[c.id] || 0)),
      ], rows, { name: 'attendance-people', empty: 'Nobody matches these filters.', onRow: (r) => `#/events/stats/person/${r.person.id}` });
      out.insertAdjacentHTML('afterbegin', `<p class="muted small ev-note">${n} event${n === 1 ? '' : 's'} counted. Rate: events they came to out of those they were invited to and weren't excused from.</p>`);
    } else if (tab === 'events') {
      const rows = eventsTable(data, opts);
      const avg = rows.filter((r) => r.turnout !== null);
      table(out, f, [
        { key: 'date', label: 'Date', value: (r) => r.event.starts_at, html: (r) => esc(new Date(r.event.starts_at).toLocaleDateString()), export: (r) => r.event.starts_at.slice(0, 10) },
        { key: 'title', label: 'Event', value: (r) => r.event.title, html: (r) => `<a href="${eventHref(r.event.id)}">${esc(r.event.title)}</a>` },
        { key: 'category', label: 'Category', value: (r) => b.categoryById.get(r.event.category_id)?.name || '', html: (r) => categoryChip(b, r.event.category_id) },
        { key: 'invited', label: 'Invited', num: true, value: (r) => r.invited }, { key: 'yes', label: 'Said going', num: true, value: (r) => r.yes },
        { key: 'came', label: 'Came', num: true, value: (r) => r.came }, { key: 'walkIns', label: 'Walk-ins', num: true, value: (r) => r.walkIns },
        { key: 'late', label: 'Late', num: true, value: (r) => r.late }, { key: 'excused', label: 'Excused', num: true, value: (r) => r.excused },
        { key: 'turnout', label: 'Turnout', num: true, value: (r) => r.turnout, html: (r) => pct(r.turnout), export: (r) => (r.turnout === null ? '' : Math.round(r.turnout * 100)) },
        { key: 'groups', label: 'By division', value: (r) => r.groups.filter((g) => g.kind === 'division' && g.invited).map((g) => `${g.name} ${g.came}/${g.invited}`).join(', ') },
      ], rows, { name: 'attendance-events', empty: 'No events match these filters.', onRow: (r) => eventHref(r.event.id) });
      out.insertAdjacentHTML('afterbegin', `<p class="muted small ev-note">${rows.length} event${rows.length === 1 ? '' : 's'}${avg.length ? `; average turnout ${pct(avg.reduce((s, r) => s + r.turnout, 0) / avg.length)}, ${Math.round(rows.reduce((s, r) => s + r.came, 0) / rows.length)} people on average` : ''}. Turnout: invited people who came, out of everyone invited.</p>`);
    } else {
      const rows = groupStats(data, opts, f.by, f.threshold / 100);
      const divName = (id) => b.names.division.get(id) || '';
      table(out, f, [
        { key: 'name', label: f.by === 'division' ? 'Division' : 'Subsystem', value: (r) => (f.by === 'subsystem' && r.id ? `${divName(r.division_id)} · ${r.name}` : r.name) },
        { key: 'people', label: 'People', num: true, value: (r) => r.people },
        { key: 'avg', label: 'Average rate', num: true, value: (r) => r.avgRate, html: (r) => pct(r.avgRate), export: (r) => (r.avgRate === null ? '' : Math.round(r.avgRate * 100)) },
        { key: 'above', label: `At or above ${f.threshold}%`, num: true, value: (r) => r.above }, { key: 'below', label: `Below ${f.threshold}%`, num: true, value: (r) => r.below },
        { key: 'came', label: 'Check-ins', num: true, value: (r) => r.came }, { key: 'invited', label: 'Invitations', num: true, value: (r) => r.invited },
      ], rows, { name: `attendance-${f.by === 'division' ? 'divisions' : 'subsystems'}`, empty: 'Nothing to show.' });
      out.insertAdjacentHTML('afterbegin', `<p class="muted small ev-note">${n} event${n === 1 ? '' : 's'} counted. Someone in two ${f.by === 'division' ? 'divisions' : 'subsystems'} counts in both. The threshold only sorts people; it isn't a rule.</p>`);
    }
  };
  const drawBar = () => {
    el.querySelector('[data-bar]').innerHTML = filterBar(b, f, data.events, tab);
    const form = el.querySelector('[data-filters]');
    form.addEventListener('change', () => {
      readFilters(form, f);
      keep();
      const on = activeFilters(f, tab);
      const sum = form.querySelector('[data-filter-sum]');
      sum.innerHTML = filterLabel(on);
      sum.classList.toggle('is-on', !!on);
      draw();
    });
    const menu = form.querySelector('.list-filter');
    menu.addEventListener('keydown', (x) => { if (x.key === 'Escape') { menu.open = false; menu.querySelector('summary').focus(); } });
    if (!closeBound) {
      closeBound = true;   // a click elsewhere closes the menu (once for the page, however often the bar redraws)
      document.addEventListener('click', (x) => document.querySelectorAll('.ev-stats-filters details.list-filter[open]').forEach((d) => { if (!d.contains(x.target)) d.open = false; }));
    }
    form.querySelector('[data-reset]').addEventListener('click', () => {
      remember.set('stats', {});
      Object.assign(f, filtersOf(data.events));
      drawBar();
      draw();
    });
  };
  out.addEventListener('click', (x) => {
    const s = x.target.closest('[data-sort]');
    if (s) {
      // A new column starts with the most first (names: A to Z); a second click flips it.
      const text = ['name', 'place', 'title', 'category', 'groups'].includes(s.dataset.sort);
      f.dir = out.dataset.sortKey === s.dataset.sort ? (out.dataset.sortDir === 'asc' ? 'desc' : 'asc') : text ? 'asc' : 'desc';
      f.sort = s.dataset.sort;
      keep();
      return draw();
    }
    const row = x.target.closest('tr[data-href]');
    if (row && !x.target.closest('a, button')) location.hash = row.dataset.href;
  });
  drawBar();
  draw();
}

/** One person: every event they were invited to (or came to), in the stats' filters. */
export async function renderPersonStats(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  const { b, data } = await loadAll();
  const person = b.personById.get(ctx.params.id);
  if (!person) {
    el.innerHTML = '<section class="card no-access"><h1>Person not found</h1><a class="btn" href="#/events/stats">Stats</a></section>';
    return;
  }
  const f = filtersOf(data.events);
  const all = { ...f, semester: '', categories: [], from: '', to: '' };
  const history = personHistory(data, person.id, all);
  const row = peopleStats({ ...data, people: [person] }, all)[0];
  const sem = f.semester ? peopleStats({ ...data, people: [person] }, { ...all, semester: f.semester })[0] : null;
  el.innerHTML = `${header(esc(person.full_name || person.email), esc(placeOf(b, person.id) || 'Not in a division yet'), '<a class="btn" href="#/events/stats">All stats</a>')}
    <section class="ev-tiles">
      ${sem ? `<div class="ev-tile"><strong>${pct(sem.rate)}</strong><span>${esc(f.semester)} (came to ${sem.came})</span></div>` : ''}
      <div class="ev-tile"><strong>${pct(row.rate)}</strong><span>all time</span></div>
      <div class="ev-tile"><strong>${row.came}</strong><span>came</span></div><div class="ev-tile"><strong>${row.excused}</strong><span>excused</span></div>
      <div class="ev-tile${row.missed ? ' is-bad' : ''}"><strong>${row.missed}</strong><span>missed</span></div></section>
    <section class="card"><h2>Every event</h2>${history.length ? `<div class="table-wrap"><table class="table" data-fit><thead><tr><th>When</th><th>Event</th><th>Category</th><th>Status</th><th>Note</th></tr></thead><tbody>
      ${history.map((h) => `<tr><td data-label="When">${esc(whenText(h.event, { year: true }))}</td><td data-label="Event"><a href="${eventHref(h.event.id)}">${esc(h.event.title)}</a></td>
        <td data-label="Category">${categoryChip(b, h.event.category_id)}</td><td data-label="Status">${standingChip(h.standing)}${h.rec.att?.walk_in ? ' <span class="muted small">walk-in</span>' : ''}</td>
        <td data-label="Note">${esc(h.rec.excused_note || (h.rec.rsvp?.answer === 'no' ? h.rec.rsvp.note : '') || '')}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="empty">Not invited to anything yet.</p>'}</section>`;
}
