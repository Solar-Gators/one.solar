/**
 * Projects → Calendar: deadlines, milestones, starts and project events by month, by week, or as an agenda.
 * Every entry opens its item. Someone who may edit an item can change its due date by dragging it to another
 * day (or with "Change date" in the agenda); that is an ordinary edit, checked like any other. Open items with no
 * due date yet are listed beside the month and week (V6), to drag onto a day or give a date with "Pick a date".
 */
import { esc, fmtDate } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { occurrences, toDay, toISO, todayISO } from '../../projects/schedule.js';
import { filterBar, bindFilterBar, filterOf, can, formDialog, attempt, toast, itemHref, typeBadge, statusChip, avatar } from './kit.js';

const states = new Map();
const stateOf = (key) => states.get(key) || states.set(key, { f: { q: '', owner: '', category: '', priority: '', type: '', more: null }, mode: 'month', at: todayISO(), work: false }).get(key);
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function renderCalendar(el, scope) {
  const { b, project } = scope;
  const st = stateOf(project?.id || '');
  const today = todayISO();
  const at = new Date(`${st.at}T12:00:00Z`);
  let from;
  let to;
  if (st.mode === 'month') {
    const first = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    from = toDay(first.toISOString()) - first.getUTCDay();
    to = from + 41;
  } else if (st.mode === 'week') {
    from = toDay(st.at) - at.getUTCDay();
    to = from + 6;
  } else {
    from = toDay(st.at);
    to = from + 59;
  }
  const [fromISO, toISO_] = [toISO(from), toISO(to)];
  const user = filterOf(st.f);
  const inRange = (f) => ({ all: [{ f, op: 'gte', v: fromISO }, { f, op: 'lte', v: toISO_ }] });
  const side = st.mode !== 'agenda';   // V6: open items with no due date, beside the month and week
  const [{ items }, events, keyDates, undated] = await Promise.all([
    pm.searchAll({ project: project?.id, projects: scope.only, q: st.f.q, sort: 'due',
      filter: { all: [...(user ? [user] : []), { any: [inRange('due'), inRange('start'), ...(st.work ? [{ all: [{ f: 'start', op: 'lte', v: toISO_ }, { f: 'due', op: 'gte', v: fromISO }] }] : [])] }] } }, 2000),
    pm.calendarEvents(scope.projectIds),
    pm.keyDates().catch(() => []),   // 061: the team's dates
    side ? pm.searchAll({ project: project?.id, projects: scope.only, q: st.f.q,   // in backlog order
      filter: { all: [...(user ? [user] : []), { f: 'due', op: 'empty' }, { f: 'category', op: 'ne', v: 'done' }] } }, 500).then((r) => r.items).catch(() => []) : [],
  ]);
  const byId = new Map([...items, ...undated].map((i) => [i.id, i]));
  const isMs = (i) => !!scope.cfgOf(i)?.typeById.get(i.type_id)?.is_milestone;
  const mayMove = (i) => i.category !== 'done' && (can(b, i.project_id, 'edit') || can(b, i.project_id, 'plan') || i.owner_id === b.me);

  // what falls on each day
  const days = new Map();
  const put = (iso, entry) => (days.get(iso) || days.set(iso, []).get(iso)).push(entry);
  for (const i of items) {
    if (i.due_date && i.due_date >= fromISO && i.due_date <= toISO_) put(i.due_date, { kind: isMs(i) ? 'ms' : 'due', item: i });
    if (i.start_date && i.start_date !== i.due_date && i.start_date >= fromISO && i.start_date <= toISO_ && !isMs(i)) put(i.start_date, { kind: 'start', item: i });
    if (st.work && i.start_date && i.due_date) {
      for (let d = Math.max(from, toDay(i.start_date) + 1); d <= Math.min(to, toDay(i.due_date) - 1); d++) put(toISO(d), { kind: 'work', item: i });
    }
  }
  for (const ev of events) {
    for (const o of occurrences(ev, fromISO, toISO_)) {
      for (let d = Math.max(from, toDay(o.start)); d <= Math.min(to, toDay(o.end)); d++) put(toISO(d), { kind: 'event', event: ev });
    }
  }
  for (const k of keyDates) {
    for (let d = Math.max(from, toDay(k.day)); d <= Math.min(to, toDay(k.end_day || k.day)); d++) put(toISO(d), { kind: 'team', key: k });
  }
  const order = { team: -1, ms: 0, event: 1, due: 2, start: 3, work: 4 };
  const chip = (e) => {
    if (e.kind === 'team') return `<span class="pm-cal-chip is-team is-${esc(e.key.kind)}" title="${esc(`Team date: ${e.key.name}${e.key.note ? ` · ${e.key.note}` : ''}`)}">★ ${esc(e.key.name)}</span>`;
    if (e.kind === 'event') return `<button type="button" class="pm-cal-chip is-event" data-event="${esc(e.event.id)}" title="${esc(e.event.notes || e.event.title)}">📅 ${esc(e.event.title)}</button>`;
    const i = e.item;
    const late = e.kind !== 'start' && e.kind !== 'work' && i.category !== 'done' && i.due_date < today;
    return `<a class="pm-cal-chip is-${e.kind} is-${esc(i.category)}${late ? ' is-late' : ''}" href="${itemHref(i.key)}" data-card="${esc(i.id)}" ${e.kind !== 'start' && e.kind !== 'work' && mayMove(i) ? 'draggable="true"' : ''}
      title="${esc(`${i.key} ${i.title}${e.kind === 'start' ? ' (starts)' : e.kind === 'work' ? ' (in progress)' : ' (due)'}`)}">${e.kind === 'ms' ? '⚑ ' : e.kind === 'start' ? '▶ ' : ''}${esc(i.key)} ${esc(i.title)}</a>`;
  };
  const cell = (d, month) => {
    const iso = toISO(d);
    const list = (days.get(iso) || []).sort((x, y) => order[x.kind] - order[y.kind]);
    const date = new Date(d * 86400000);
    return `<div class="pm-cal-day${iso === today ? ' is-today' : ''}${month !== undefined && date.getUTCMonth() !== month ? ' is-other' : ''}" data-drop="${iso}">
      <div class="pm-cal-num">${st.mode === 'week' ? `${DOW[date.getUTCDay()]} ` : ''}${date.getUTCDate()}</div>${list.slice(0, st.mode === 'week' ? 40 : 4).map(chip).join('')}
      ${st.mode === 'month' && list.length > 4 ? `<button type="button" class="pm-cal-more" data-goto="${iso}">+${list.length - 4} more</button>` : ''}</div>`;
  };
  let body;
  if (st.mode === 'agenda') {
    const dates = [...days.keys()].sort();
    body = dates.length ? `<div class="pm-agenda">${dates.map((iso) => `<section><h3 class="${iso === today ? 'is-today' : ''}">${esc(new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }))}</h3>
      <ul class="pm-mini">${days.get(iso).sort((x, y) => order[x.kind] - order[y.kind]).filter((e) => e.kind !== 'work').map((e) => (e.kind === 'team' ? `<li>★ <strong>${esc(e.key.name)}</strong> <span class="muted">Team date${e.key.note ? ` · ${esc(e.key.note)}` : ''}</span></li>`
        : e.kind === 'event'
        ? `<li>📅 <strong>${esc(e.event.title)}</strong> <span class="muted">${esc(b.projectById.get(e.event.project_id)?.name || '')}${e.event.notes ? ` · ${esc(e.event.notes)}` : ''}</span></li>`
        : `<li>${typeBadge(scope.cfgOf(e.item)?.typeById.get(e.item.type_id))} <a href="${itemHref(e.item.key)}">${esc(e.item.key)} · ${esc(e.item.title)}</a>
            <span class="chip">${e.kind === 'start' ? 'Starts' : e.kind === 'ms' ? 'Milestone' : 'Due'}</span> ${statusChip(scope.cfgOf(e.item)?.statusById.get(e.item.status_id))} ${avatar(b, e.item.owner_id)}
            ${e.kind !== 'start' && mayMove(e.item) ? `<button type="button" class="btn btn-sm btn-ghost" data-redate="${esc(e.item.id)}">Change date</button>` : ''}</li>`)).join('')}</ul></section>`).join('')}</div>`
      : '<div class="empty"><p><strong>Nothing in the next 60 days.</strong></p></div>';
  } else {
    const weeks = (to - from + 1) / 7;
    body = `<div class="pm-cal is-${st.mode}"><div class="pm-cal-dow">${DOW.map((d) => `<span>${d}</span>`).join('')}</div>
      ${Array.from({ length: weeks }, (_, w) => `<div class="pm-cal-week">${Array.from({ length: 7 }, (_, d) => cell(from + w * 7 + d, st.mode === 'month' ? at.getUTCMonth() : undefined)).join('')}</div>`).join('')}</div>`;
    // V6: what has no date yet, to drag onto a day (or "Pick a date")
    const shown = st.allUndated ? undated : undated.slice(0, 30);
    body = `<div class="pm-cal-wrap">${body}<details class="pm-cal-side" data-undated ${st.sideOpen ?? matchMedia('(min-width: 861px)').matches ? 'open' : ''}>
      <summary><strong>No date yet</strong> <span class="muted">${undated.length >= 500 ? '500+' : undated.length}</span></summary>
      ${undated.length ? `<ul class="pm-cal-undated">${shown.map((i) => `<li><a class="pm-cal-chip is-due" href="${itemHref(i.key)}" data-card="${esc(i.id)}" ${mayMove(i) ? 'draggable="true"' : ''} title="${esc(`${i.key} ${i.title}`)}">${esc(i.key)} ${esc(i.title)}</a>
        ${mayMove(i) ? `<button type="button" class="btn btn-sm btn-ghost" data-redate="${esc(i.id)}">Pick a date</button>` : ''}</li>`).join('')}</ul>
        ${undated.length > shown.length ? `<button type="button" class="pm-cal-more" data-all-undated>Show all ${undated.length}</button>` : ''}`
        : '<p class="muted small">Every open item has a due date.</p>'}
      <p class="hint">Drag one onto a day to make it due then.</p></details></div>`;
  }
  const title = st.mode === 'month' ? at.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    : `${fmtDate(fromISO)} – ${fmtDate(toISO_)}`;
  const planIn = scope.projectIds.filter((id) => can(b, id, 'plan'));

  el.innerHTML = `<div class="pm-toolbar"><div class="card-actions">
        <button type="button" class="btn btn-sm" data-step="-1" aria-label="Earlier">←</button><button type="button" class="btn btn-sm" data-step="0">Today</button><button type="button" class="btn btn-sm" data-step="1" aria-label="Later">→</button>
        <strong class="pm-cal-title">${esc(title)}</strong></div>
      <div class="card-actions"><span role="tablist" class="pm-seg">${[['month', 'Month'], ['week', 'Week'], ['agenda', 'Agenda']].map(([k, l]) => `<button type="button" role="tab" data-mode="${k}" aria-selected="${st.mode === k}">${l}</button>`).join('')}</span>
        ${planIn.length ? '<button type="button" class="btn btn-sm" data-new-event>New event</button>' : ''}</div></div>
    <div class="pm-toolbar pm-tbar">${filterBar(b, st.f, { types: scope.types })}
      <div class="card-actions"><label class="pm-check" title="Also show items on every day between their start and due date"><input type="checkbox" data-work ${st.work ? 'checked' : ''}> Show scheduled work</label></div></div>
    ${body}
    <p class="hint">⚑ milestone · ▶ start · plain: due · 📅 space event. Drag a deadline to another day to change it (or use Agenda → "Change date").</p>`;

  const again = () => scope.rerender();
  bindFilterBar(el, b, st.f, again, { fields: scope.fields, statuses: scope.statuses });
  const redate = async (id, iso) => {
    const i = byId.get(id);
    if (!i || i.due_date === iso) return;
    // keep its length: the start moves with the deadline (an item with no due date yet only gets one)
    const shift = i.due_date ? toDay(iso) - toDay(i.due_date) : 0;
    const patch = { due_date: iso, ...(i.start_date && i.due_date ? { start_date: toISO(toDay(i.start_date) + shift) } : {}) };
    if (await attempt(() => pm.updateItem(id, null, patch), `${i.key} is now due ${fmtDate(iso)}.`)) again();
  };
  el.addEventListener('dragstart', (e) => {
    const c = e.target.closest?.('[data-card][draggable="true"]');
    if (c) e.dataTransfer.setData('text/plain', c.dataset.card);
  });
  el.addEventListener('dragover', (e) => e.target.closest?.('[data-drop]') && e.preventDefault());
  el.addEventListener('drop', (e) => {
    const zone = e.target.closest?.('[data-drop]');
    const id = e.dataTransfer.getData('text/plain');
    if (zone && id) (e.preventDefault(), redate(id, zone.dataset.drop));
  });
  el.addEventListener('change', (e) => e.target.matches('[data-work]') && ((st.work = e.target.checked), again()));
  el.querySelector('[data-undated]')?.addEventListener('toggle', (e) => (st.sideOpen = e.target.open));
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (d.mode) ((st.mode = d.mode), again());
    else if (d.goto) ((st.at = d.goto), (st.mode = 'week'), again());
    else if (d.allUndated !== undefined) ((st.allUndated = true), again());
    else if (d.step !== undefined) {
      const n = Number(d.step);
      if (!n) st.at = today;
      else if (st.mode === 'month') st.at = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + n, 1)).toISOString().slice(0, 10);
      else st.at = toISO(toDay(st.at) + n * (st.mode === 'week' ? 7 : 60));
      again();
    } else if (d.redate) {
      const i = byId.get(d.redate);
      const res = await formDialog({ title: `Due date of ${esc(i.key)}`, submit: 'Save',
        body: `<p class="muted">${esc(i.title)}</p><div class="field"><label for="rd-date">Due</label><input id="rd-date" name="date" type="date" required value="${esc(i.due_date || '')}"></div>
          ${i.start_date && i.due_date ? '<p class="hint">Its start date moves by the same number of days.</p>' : ''}`,
        onSubmit: (f) => f.elements.date.value });
      if (res) redate(i.id, res);
    } else if (d.newEvent !== undefined || d.event) {
      const ev = events.find((x) => x.id === d.event);
      if (ev && !can(b, ev.project_id, 'plan')) return toast(`${ev.title}${ev.notes ? `: ${ev.notes}` : ''}`);
      const res = await formDialog({ title: ev ? 'Edit event' : 'New event', submit: 'Save',
        body: `${ev || planIn.length === 1 ? '' : `<div class="field"><label for="ev-project">Space</label><select id="ev-project" name="project">${planIn.map((id) => `<option value="${esc(id)}">${esc(b.projectById.get(id).name)}</option>`).join('')}</select></div>`}
          <div class="field"><label for="ev-title">What</label><input id="ev-title" name="title" type="text" maxlength="120" required value="${esc(ev?.title || '')}" placeholder="Design review day"></div>
          <div class="form-grid"><div class="field span-2"><label for="ev-start">From</label><input id="ev-start" name="start" type="date" required value="${esc(ev?.starts_on || st.at)}"></div>
            <div class="field span-2"><label for="ev-end">To (optional)</label><input id="ev-end" name="end" type="date" value="${esc(ev?.ends_on || '')}"></div>
            <div class="field span-2"><label for="ev-repeat">Repeats</label><select id="ev-repeat" name="repeat">${[['none', 'No'], ['weekly', 'Every week'], ['biweekly', 'Every two weeks'], ['monthly', 'Every month']].map(([k, l]) => `<option value="${k}" ${ev?.repeat === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
            <div class="field span-2"><label for="ev-until">Until (optional)</label><input id="ev-until" name="until" type="date" value="${esc(ev?.repeat_until || '')}"></div></div>
          <div class="field"><label for="ev-notes">Notes</label><textarea id="ev-notes" name="notes" rows="2">${esc(ev?.notes || '')}</textarea></div>
          ${ev ? '<label class="pm-check"><input type="checkbox" name="delete"> Delete this event</label>' : ''}`,
        onSubmit: (f) => pm.saveEvent(ev?.project_id || f.elements.project?.value || planIn[0], ev?.id || null, f.elements.delete?.checked ? null
          : { title: f.elements.title.value.trim(), starts_on: f.elements.start.value, ends_on: f.elements.end.value, repeat: f.elements.repeat.value, repeat_until: f.elements.until.value, notes: f.elements.notes.value }).then((r) => r ?? true) });
      if (res) again();
    }
  });
}
