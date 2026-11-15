/**
 * Projects → Timeline: a Gantt chart of one project, or of every project I can see.
 *
 * Solid bars are the TARGET dates people typed. The dashed outline is the FORECAST the scheduling engine works
 * out from dependencies, working days and what has actually happened (projects/schedule.js); a thin grey bar is
 * the chosen BASELINE. Red-edged bars are the critical path. Dragging or resizing a bar (or "Dates" on a row)
 * doesn't save anything: it starts a what-if that shows the knock-on effects, and only "Apply" changes the plan.
 */
import { esc, fmtDate, askText } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { schedule, proposeDates, toDay, toISO, todayISO, makeCalendar } from '../../projects/schedule.js';
import { DEP_KINDS } from '../../projects/core.js';
import { filterBar, bindFilterBar, filterOf, can, formDialog, attempt, toast, itemHref, typeBadge, avatar } from './kit.js';

const ROW = 32;
const ZOOM = { day: 30, week: 14, month: 5, quarter: 2 };
const states = new Map();
const stateOf = (key) => states.get(key) || states.set(key, { f: { q: '', owner: '', category: '', priority: '', type: '', more: null }, zoom: 'week', closed: new Set(), overrides: {},
  baseline: '', scenario: '', deps: true, critical: true, scroll: null }).get(key);

export async function renderTimeline(el, scope) {
  const { b, project } = scope;
  const st = stateOf(project?.id || '');
  const px = ZOOM[st.zoom];
  const today = todayISO();
  const filter = filterOf(st.f);
  const [{ items: all, total }, deps, baselines, scenarios, shown] = await Promise.all([
    pm.searchAll({ project: project?.id, sort: 'rank' }, 3000), pm.deps(scope.projectIds),
    project ? pm.baselines(project.id) : [], project ? pm.scenarios(project.id) : [],
    filter || st.f.q ? pm.searchAll({ project: project?.id, filter, q: st.f.q }, 3000).then((r) => new Set(r.items.map((i) => i.id))) : null,
  ]);
  const isMs = (i) => !!scope.cfgOf(i)?.typeById.get(i.type_id)?.is_milestone;
  const items = all.map((i) => ({ ...i, is_milestone: isMs(i) }));
  const byId = new Map(items.map((i) => [i.id, i]));
  // items in other projects that ours wait on: they shape the forecast but aren't rows here
  const outside = await pm.itemsByIds([...new Set(deps.map((d) => d.from_item).filter((id) => !byId.has(id)))]).catch(() => []);
  const settings = project?.settings || {};
  const input = [...items, ...outside.map((o) => ({ ...o, is_milestone: false }))];
  const base = schedule(input, deps, settings, { today });
  const trying = Object.keys(st.overrides).length > 0;
  const plan = trying ? schedule(input, deps, settings, { today, overrides: st.overrides }) : base;
  const baseline = baselines.find((x) => x.id === st.baseline)?.snapshot || null;
  const target = (i) => st.overrides[i.id] ? { start: st.overrides[i.id].start, due: st.overrides[i.id].due } : { start: i.start_date, due: i.due_date };

  // rows: by project (across projects), then by parent, in backlog order; a filter keeps matches and what they sit under
  const keep = (i) => !shown || shown.has(i.id);
  const kids = new Map();
  for (const i of items) (kids.get(i.parent_id && byId.has(i.parent_id) ? i.parent_id : `root:${i.project_id}`) || kids.set(i.parent_id && byId.has(i.parent_id) ? i.parent_id : `root:${i.project_id}`, []).get(i.parent_id && byId.has(i.parent_id) ? i.parent_id : `root:${i.project_id}`)).push(i);
  const visible = new Set();
  const mark = (i) => {
    let any = keep(i);
    for (const c of kids.get(i.id) || []) any = mark(c) || any;
    if (any) visible.add(i.id);
    return any;
  };
  const rows = [];
  const walk = (i, depth) => {
    if (!visible.has(i.id)) return;
    const children = (kids.get(i.id) || []).filter((c) => visible.has(c.id));
    rows.push({ item: i, depth, children: children.length });
    if (!st.closed.has(i.id)) children.forEach((c) => walk(c, depth + 1));
  };
  for (const pid of scope.projectIds) {
    const roots = kids.get(`root:${pid}`) || [];
    roots.forEach(mark);
    if (!roots.some((r) => visible.has(r.id))) continue;
    if (!project) rows.push({ header: b.projectById.get(pid) });
    if (project || !st.closed.has(pid)) roots.forEach((r) => walk(r, 0));
  }

  // the span of days shown
  const days = [toDay(today)];
  for (const { item: i } of rows.filter((r) => r.item)) {
    const p = plan.byId.get(i.id);
    const t = target(i);
    days.push(...[t.start, t.due, p?.start, p?.finish, baseline?.[i.id]?.start, baseline?.[i.id]?.due].filter(Boolean).map(toDay));
  }
  const first = Math.min(...days) - 7;
  const last = Math.max(...days) + 21;
  const x = (iso) => (toDay(iso) - first) * px;
  const width = (last - first + 1) * px;
  const cal = makeCalendar(settings);

  const head = () => {
    let months = '';
    let ticks = '';
    for (let d = first; d <= last; d++) {
      const date = new Date(d * 86400000);
      if (date.getUTCDate() === 1 || d === first) months += `<span class="pm-g-month" style="left:${(d - first) * px}px">${esc(date.toLocaleDateString('en-US', { month: 'short', year: date.getUTCMonth() === 0 || d === first ? 'numeric' : undefined, timeZone: 'UTC' }))}</span>`;
      if (st.zoom === 'day') ticks += `<span class="pm-g-day${cal.isWork(d) ? '' : ' is-off'}" style="left:${(d - first) * px}px;width:${px}px">${date.getUTCDate()}</span>`;
      else if (date.getUTCDay() === 1 && st.zoom !== 'quarter') ticks += `<span class="pm-g-day" style="left:${(d - first) * px}px">${st.zoom === 'week' ? date.getUTCDate() : ''}</span>`;
    }
    return `<div class="pm-g-head" style="width:${width}px">${months}${ticks}</div>`;
  };
  const rowIndex = new Map();
  rows.forEach((r, n) => r.item && rowIndex.set(r.item.id, n));
  const span = (i) => {
    const t = target(i);
    const p = plan.byId.get(i.id);
    return { start: t.start || (t.due && !i.is_milestone ? null : null) || t.due || p?.start, end: t.due || t.start || p?.finish, p, t };
  };
  const bar = (r, n) => {
    if (r.header) return `<div class="pm-g-row is-header" style="top:${n * ROW}px;width:${width}px"></div>`;
    const i = r.item;
    const { p, t } = span(i);
    const top = n * ROW;
    const drag = can(b, i.project_id, 'plan') && i.category !== 'done';
    let out = `<div class="pm-g-row" style="top:${top}px;width:${width}px"></div>`;
    const bl = baseline?.[i.id];
    if (bl && (bl.start || bl.due)) out += `<div class="pm-g-baseline" style="top:${top + ROW - 8}px;left:${x(bl.start || bl.due)}px;width:${(toDay(bl.due || bl.start) - toDay(bl.start || bl.due) + 1) * px}px" title="Baseline: ${esc(fmtDate(bl.start || bl.due))} – ${esc(fmtDate(bl.due || bl.start))}"></div>`;
    const crit = st.critical && p?.critical ? ' is-critical' : '';
    const tip = `${i.key} ${i.title}\nTarget: ${t.start ? fmtDate(t.start) : '?'} – ${t.due ? fmtDate(t.due) : '?'}${p ? `\nForecast: ${fmtDate(p.start)} – ${fmtDate(p.finish)}${p.slack === null ? '' : `\nSlack: ${p.slack} working day${p.slack === 1 ? '' : 's'}${p.critical ? ' (critical)' : ''}`}` : ''}`;
    if (i.is_milestone) {
      const at = t.due || t.start || p?.finish;
      if (at) out += `<div class="pm-g-ms is-${esc(i.category)}${crit}${st.overrides[i.id] ? ' is-trying' : ''}" data-bar="${esc(i.id)}" ${drag ? 'data-drag' : ''} style="top:${top + 6}px;left:${x(at) + px / 2 - 10}px" title="${esc(tip)}"></div>`;
    } else if (t.start || t.due) {
      const a = t.start || t.due;
      const z = t.due || t.start;
      out += `<div class="pm-g-bar is-${esc(i.category)}${crit}${st.overrides[i.id] ? ' is-trying' : ''}${t.start && t.due ? '' : ' is-open'}" data-bar="${esc(i.id)}" ${drag ? 'data-drag' : ''} style="top:${top + 6}px;left:${x(a)}px;width:${(toDay(z) - toDay(a) + 1) * px}px" title="${esc(tip)}">
        <span class="pm-g-fill" style="width:${Number(i.progress) || 0}%"></span>${drag ? '<span class="pm-g-h pm-g-h-l"></span><span class="pm-g-h pm-g-h-r"></span>' : ''}</div>`;
    }
    // the forecast, where it differs from the target (or there is no target)
    if (p && i.category !== 'done' && !i.is_milestone && (p.start !== t.start || p.finish !== t.due)) {
      out += `<div class="pm-g-forecast${p.late ? ' is-late' : ''}" ${!t.start && !t.due && drag ? `data-bar="${esc(i.id)}" data-drag` : ''} style="top:${top + 4}px;left:${x(p.start)}px;width:${(toDay(p.finish) - toDay(p.start) + 1) * px}px" title="${esc(tip)}"></div>`;
    }
    if (p?.late) out += `<span class="pm-g-late" style="top:${top + 7}px;left:${x(p.finish) + px + 4}px" title="${esc(p.warnings.map((w) => w.text).join('\n'))}">⚠ ${p.late}d</span>`;
    return out;
  };
  const arrows = () => {
    if (!st.deps) return '';
    let out = '';
    for (const d of deps) {
      const [a, z] = [rowIndex.get(d.from_item), rowIndex.get(d.to_item)];
      if (a === undefined || z === undefined) continue;
      const [sa, sz] = [span(byId.get(d.from_item)), span(byId.get(d.to_item))];
      if (!sa.start || !sz.start) continue;
      const x1 = ['SS', 'SF'].includes(d.kind) ? x(sa.start) : x(sa.end) + px;
      const x2 = ['FF', 'SF'].includes(d.kind) ? x(sz.end) + px : x(sz.start);
      const [y1, y2] = [a * ROW + ROW / 2, z * ROW + ROW / 2];
      const out1 = ['SS', 'SF'].includes(d.kind) ? x1 - 8 : x1 + 8;
      const in2 = ['FF', 'SF'].includes(d.kind) ? x2 + 8 : x2 - 8;
      const crit = st.critical && plan.byId.get(d.from_item)?.critical && plan.byId.get(d.to_item)?.critical;
      out += `<path class="pm-g-arrow${crit ? ' is-critical' : ''}" d="M${x1} ${y1} H${out1} V${y1 + (y2 > y1 ? ROW / 2 : -ROW / 2)} H${in2} V${y2} H${x2}" marker-end="url(#pm-g-tip${crit ? '-c' : ''})"><title>${esc(`${byId.get(d.from_item).key} → ${byId.get(d.to_item).key}: ${DEP_KINDS[d.kind]}${d.lag_days ? `, ${d.lag_days > 0 ? '+' : ''}${d.lag_days} working days` : ''}`)}</title></path>`;
    }
    return out;
  };
  const label = (r) => (r.header
    ? `<div class="pm-g-label is-header"><button type="button" class="pm-g-toggle" data-toggle="${esc(r.header.id)}" aria-expanded="${!st.closed.has(r.header.id)}">${st.closed.has(r.header.id) ? '▸' : '▾'}</button> <a href="#/projects/p/${esc(r.header.key)}/timeline"><strong>${esc(r.header.name)}</strong></a></div>`
    : `<div class="pm-g-label${plan.byId.get(r.item.id)?.critical && st.critical ? ' is-critical' : ''}" style="padding-left:${6 + r.depth * 16}px">
        ${r.children ? `<button type="button" class="pm-g-toggle" data-toggle="${esc(r.item.id)}" aria-expanded="${!st.closed.has(r.item.id)}" aria-label="${st.closed.has(r.item.id) ? 'Show' : 'Hide'} what's under ${esc(r.item.key)}">${st.closed.has(r.item.id) ? '▸' : '▾'}</button>` : '<span class="pm-g-toggle"></span>'}
        ${typeBadge(scope.cfgOf(r.item)?.typeById.get(r.item.type_id))} <a href="${itemHref(r.item.key)}" title="${esc(r.item.title)}">${esc(r.item.key)} ${esc(r.item.title)}</a>
        <span class="pm-g-label-end">${avatar(b, r.item.owner_id)}${can(b, r.item.project_id, 'plan') && r.item.category !== 'done' ? `<button type="button" class="btn btn-sm btn-ghost" data-dates="${esc(r.item.id)}" aria-label="Change the dates of ${esc(r.item.key)}">Dates</button>` : ''}</span></div>`);

  // what a what-if changes downstream
  const moved = trying ? [...plan.byId].filter(([id, p]) => base.byId.get(id) && base.byId.get(id).finish !== p.finish && !st.overrides[id] && byId.has(id))
    .map(([id, p]) => ({ item: byId.get(id), from: base.byId.get(id).finish, to: p.finish })) : [];
  const height = rows.length * ROW;
  const warnings = plan.warnings.filter((w) => byId.has(w.id));

  el.innerHTML = `<div class="pm-toolbar"><div class="card-actions">
        <label class="inline-field">Zoom <select data-zoom>${Object.keys(ZOOM).map((z) => `<option value="${z}" ${st.zoom === z ? 'selected' : ''}>${z[0].toUpperCase() + z.slice(1)}s</option>`).join('')}</select></label>
        <button type="button" class="btn btn-sm" data-today>Today</button>
        <label class="pm-check"><input type="checkbox" data-opt="deps" ${st.deps ? 'checked' : ''}> Dependencies</label>
        <label class="pm-check"><input type="checkbox" data-opt="critical" ${st.critical ? 'checked' : ''}> Critical path</label></div>
      ${project ? `<div class="card-actions"><label class="inline-field">Baseline <select data-baseline><option value="">None</option>${baselines.map((x) => `<option value="${esc(x.id)}" ${st.baseline === x.id ? 'selected' : ''}>${esc(x.name)} (${esc(fmtDate(x.created_at))})</option>`).join('')}</select></label>
        ${can(b, project.id, 'plan') ? `<button type="button" class="btn btn-sm" data-save-baseline>Save a baseline</button>
          ${scenarios.length ? `<select data-scenario aria-label="Saved what-ifs"><option value="">Saved what-ifs…</option>${scenarios.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}${s.applied_at ? ' (applied)' : ''}</option>`).join('')}</select>` : ''}
          <button type="button" class="btn btn-sm" data-to-forecast title="Try out moving every unfinished item's dates to where the forecast says they'll really be">Reschedule to forecast…</button>` : ''}</div>` : ''}</div>
    ${filterBar(b, st.f, { types: scope.types })}
    ${trying ? `<div class="alert alert-info pm-whatif" role="status"><strong>What-if: ${Object.keys(st.overrides).length} date change${Object.keys(st.overrides).length === 1 ? '' : 's'} tried out. Nothing is saved yet.</strong>
        <div>Forecast finish: ${esc(fmtDate(base.finish))} → <strong>${esc(fmtDate(plan.finish))}</strong>${plan.finish === base.finish ? ' (no change)' : ''}. Warnings: ${base.warnings.length} → <strong>${plan.warnings.length}</strong>.
          ${moved.length ? `Also moves ${moved.length} other item${moved.length === 1 ? '' : 's'}: ${moved.slice(0, 6).map((m) => `${esc(m.item.key)} (${esc(fmtDate(m.from))} → ${esc(fmtDate(m.to))})`).join(', ')}${moved.length > 6 ? '…' : ''}.` : 'No other item\'s forecast moves.'}</div>
        <div class="card-actions"><button type="button" class="btn btn-sm btn-primary" data-apply>Apply to the plan</button>${project ? '<button type="button" class="btn btn-sm" data-save-scenario>Keep as a what-if</button>' : ''}<button type="button" class="btn btn-sm btn-ghost" data-discard>Discard</button></div></div>` : ''}
    ${total > all.length ? `<p class="alert alert-info">Showing the first ${all.length} of ${total} items.</p>` : ''}
    ${plan.loop.length ? `<p class="alert alert-error">Some items depend on each other in a loop, so they can't be scheduled: ${plan.loop.map((id) => esc(byId.get(id)?.key || '')).join(', ')}.</p>` : ''}
    ${rows.length ? `<div class="pm-gantt" style="--row:${ROW}px">
        <div class="pm-g-left"><div class="pm-g-head"></div>${rows.map(label).join('')}</div>
        <div class="pm-g-right" data-scroll>${head()}
          <div class="pm-g-body" style="width:${width}px;height:${height}px">
            <div class="pm-g-today" style="left:${x(today) + px / 2}px;height:${height}px" title="Today"></div>
            ${rows.map(bar).join('')}
            <svg class="pm-g-svg" width="${width}" height="${height}" aria-hidden="true"><defs>
              <marker id="pm-g-tip" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z"/></marker>
              <marker id="pm-g-tip-c" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z"/></marker></defs>${arrows()}</svg>
          </div></div></div>
      <p class="pm-g-legend muted small"><span class="pm-g-key is-bar"></span> target dates <span class="pm-g-key is-forecast"></span> forecast <span class="pm-g-key is-baseline"></span> baseline
        <span class="pm-g-key is-crit"></span> critical path <span class="pm-g-key is-ms"></span> milestone · Forecast finish for everything shown: <strong>${esc(fmtDate(plan.finish))}</strong></p>`
      : '<div class="empty"><p><strong>Nothing to show on the timeline.</strong></p><p>Give items a start and a due date, or link them with dependencies, and they appear here.</p></div>'}
    <div class="pm-summary">
      <section class="card"><h2>Schedule warnings <span class="muted">${warnings.length}</span></h2>
        ${warnings.length ? `<ul class="pm-mini">${warnings.slice(0, 40).map((w) => `<li><a href="${itemHref(byId.get(w.id).key)}">${esc(byId.get(w.id).key)}</a> <span>${esc(w.text)}</span></li>`).join('')}</ul>` : '<p class="muted">None: the target dates fit the dependencies and nothing is forecast to finish late.</p>'}</section>
      <section class="card"><h2>Critical path</h2>
        ${plan.critical.filter((id) => byId.has(id)).length ? `<ol class="pm-crit">${plan.critical.filter((id) => byId.has(id)).map((id) => `<li><a href="${itemHref(byId.get(id).key)}">${esc(byId.get(id).key)} · ${esc(byId.get(id).title)}</a> <span class="muted small">${esc(fmtDate(plan.byId.get(id).start))} – ${esc(fmtDate(plan.byId.get(id).finish))}</span></li>`).join('')}</ol>
          <p class="hint">These have no slack: a day lost on any of them is a day lost at the end.</p>` : '<p class="muted">Nothing is linked into a chain yet. Add dependencies between items to see which ones decide the finish date.</p>'}
        <p class="hint">Working days: ${(settings.working_days?.length ? settings.working_days : [1, 2, 3, 4, 5]).map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')}${(settings.holidays || []).length ? `; ${settings.holidays.length} day(s) off` : ''}${project ? '' : ' (across projects the standard week is used)'}.
          Target dates never move on their own: the forecast is only advice until someone applies a reschedule.</p></section></div>`;

  const again = () => scope.rerender();
  const scroller = el.querySelector('[data-scroll]');
  if (scroller) {
    scroller.scrollLeft = st.scroll ?? Math.max(0, x(today) - 200);
    scroller.addEventListener('scroll', () => (st.scroll = scroller.scrollLeft));
  }
  bindFilterBar(el, b, st.f, again, { fields: scope.fields, statuses: scope.statuses });
  el.querySelector('[data-zoom]').onchange = (e) => ((st.zoom = e.target.value), (st.scroll = null), again());
  el.querySelector('[data-today]').onclick = () => scroller && (scroller.scrollLeft = Math.max(0, x(today) - 200));
  el.querySelectorAll('[data-opt]').forEach((n) => (n.onchange = () => ((st[n.dataset.opt] = n.checked), again())));
  el.querySelector('[data-baseline]')?.addEventListener('change', (e) => ((st.baseline = e.target.value), again()));
  el.querySelector('[data-scenario]')?.addEventListener('change', (e) => {
    const s = scenarios.find((q) => q.id === e.target.value);
    if (s) ((st.overrides = { ...s.changes }), (st.scenario = s.id), again());
  });

  /** Try out new target dates for an item (kept in the page only). */
  const tryDates = (id, start, due) => {
    const i = byId.get(id);
    if ((start || null) === (i.start_date || null) && (due || null) === (i.due_date || null)) delete st.overrides[id];
    else st.overrides[id] = { start: start || null, due: due || null };
    again();
  };
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (d.toggle) (st.closed[st.closed.has(d.toggle) ? 'delete' : 'add'](d.toggle), again());
    else if (d.dates) {
      const i = byId.get(d.dates);
      const t0 = target(i);
      const res = await formDialog({ title: `Dates for ${esc(i.key)}`, submit: 'Try these dates',
        body: `<p class="muted">${esc(i.title)}. This starts a what-if: you'll see what else moves before anything is saved.</p>
          <div class="form-grid"><div class="field span-2"><label for="gd-start">Start</label><input id="gd-start" name="start" type="date" value="${esc(t0.start || '')}"></div>
            <div class="field span-2"><label for="gd-due">Due</label><input id="gd-due" name="due" type="date" value="${esc(t0.due || '')}"></div></div>
          <p class="hint">Forecast: ${esc(fmtDate(plan.byId.get(i.id)?.start))} – ${esc(fmtDate(plan.byId.get(i.id)?.finish))}.</p>`,
        onSubmit: (f) => {
          if (f.elements.start.value && f.elements.due.value && f.elements.start.value > f.elements.due.value) throw new Error('The start date is after the due date.');
          return { start: f.elements.start.value, due: f.elements.due.value };
        } });
      if (res) tryDates(i.id, res.start, res.due);
    } else if (d.discard !== undefined) ((st.overrides = {}), (st.scenario = ''), again());
    else if (d.toForecast !== undefined) {
      const proposed = proposeDates(items.map((i) => ({ ...i, start_date: target(i).start, due_date: target(i).due })), plan);
      if (!Object.keys(proposed).length) return toast('The target dates already match the forecast.');
      st.overrides = { ...st.overrides, ...proposed };
      again();
    } else if (d.saveBaseline !== undefined) {
      const name = await askText({ title: 'Save a baseline', label: 'Name', placeholder: 'Plan of record', hint: 'Remembers today\'s target dates so you can see later how far the plan has moved.', ok: 'Save' });
      if (name && (await attempt(() => pm.saveBaseline(project.id, name), 'Baseline saved.'))) again();
    } else if (d.saveScenario !== undefined) {
      const name = await askText({ title: 'Keep this what-if', label: 'Name', placeholder: 'If the cells arrive a week late', ok: 'Keep it' });
      if (name && (await attempt(() => pm.saveScenario(project.id, null, { name, changes: st.overrides }), 'Kept. Find it under "Saved what-ifs".'))) again();
    } else if (d.apply !== undefined) {
      const n = Object.keys(st.overrides).length;
      const note = await askText({ title: `Change the dates of ${n} item${n === 1 ? '' : 's'}`, label: 'Why (shown in the history)', required: false, ok: 'Apply to the plan', multiline: true });
      if (note === null) return;
      const byProject = new Map();
      for (const [id, v] of Object.entries(st.overrides)) (byProject.get(byId.get(id).project_id) || byProject.set(byId.get(id).project_id, {}).get(byId.get(id).project_id))[id] = v;
      for (const [pid, changes] of byProject) {
        if (!(await attempt(() => pm.reschedule(pid, changes, note, pid === project?.id ? st.scenario || null : null)))) return;
      }
      st.overrides = {};
      st.scenario = '';
      toast(`Rescheduled ${n} item${n === 1 ? '' : 's'}.`);
      again();
    }
  });

  // dragging a bar: move it, or pull an end. Whole days; released → a what-if.
  el.addEventListener('pointerdown', (e) => {
    const node = e.target.closest('[data-drag]');
    if (!node || e.button !== 0) return;
    const i = byId.get(node.dataset.bar);
    const t0 = target(i);
    const p = plan.byId.get(i.id);
    const start = t0.start || (t0.due ? null : p.start);
    const due = t0.due || (t0.start ? null : p.finish);
    const mode = e.target.classList.contains('pm-g-h-l') ? 'l' : e.target.classList.contains('pm-g-h-r') ? 'r' : 'm';
    const [x0, left0, width0] = [e.clientX, node.offsetLeft, node.offsetWidth];
    let delta = 0;
    node.setPointerCapture(e.pointerId);
    node.classList.add('is-dragging');
    const onMove = (ev) => {
      delta = Math.round((ev.clientX - x0) / px);
      if (mode === 'm') node.style.left = `${left0 + delta * px}px`;
      else if (mode === 'r') node.style.width = `${Math.max(px, width0 + delta * px)}px`;
      else {
        const d2 = Math.min(delta, width0 / px - 1);
        node.style.left = `${left0 + d2 * px}px`;
        node.style.width = `${width0 - d2 * px}px`;
      }
    };
    const onUp = () => {
      node.removeEventListener('pointermove', onMove);
      node.classList.remove('is-dragging');
      if (!delta) return;
      const shift = (iso, n) => (iso ? toISO(toDay(iso) + n) : iso);
      if (i.is_milestone) return tryDates(i.id, t0.start, shift(t0.due || p.finish, delta));
      let [s2, d2] = mode === 'm' ? [shift(start, delta), shift(due, delta)] : mode === 'r' ? [start, shift(due || start, delta)] : [shift(start || due, delta), due];
      if (s2 && d2 && s2 > d2) (mode === 'r' ? (d2 = s2) : (s2 = d2));
      tryDates(i.id, s2, d2);
    };
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', onUp, { once: true });
    node.addEventListener('pointercancel', () => (node.removeEventListener('pointermove', onMove), again()), { once: true });
  });
}
