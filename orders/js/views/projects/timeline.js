/**
 * Projects → Timeline: a Gantt chart of one project, or of every project I can see.
 *
 * Solid bars are the TARGET dates people typed. The dashed outline is the FORECAST the scheduling engine works
 * out from dependencies, working days and what has actually happened (projects/schedule.js); a thin grey bar is
 * the chosen BASELINE. Red-edged bars are the critical path. Dragging or resizing a bar (or "Dates" on a row)
 * doesn't save anything: it starts a what-if that shows the knock-on effects, and only "Apply" changes the plan.
 *
 * Planning happens here too: "+ Add" under a project makes a new item (with its dates, so its bar appears right
 * away), "+" on a row makes something under it (any depth), ⇥ / ⇤ put a row under the one above it or take it
 * out a level, and "+ New project" (across projects) starts a project. A row with things under it gets a dark
 * summary bar for everything under it; so does each project. They're ordinary items, so List, Boards, Backlog
 * and Calendar show them too.
 *
 * 061: draw on an empty row to give an undated item its dates (a what-if, like dragging); "Only undated" lists
 * what still needs dates. Double-click a title to rename it; drag a row by its ⋮⋮ handle onto another row to put
 * it under that one (middle) or before / after it (top / bottom edge). Collapse / expand all, "Fit" zoom, and
 * with a baseline chosen each row says how far it moved. Team dates (competitions, reviews…) are lines on every
 * timeline. Dependencies on items in other projects show as tags on the row, and items waiting on an order that
 * isn't placed are warned about.
 */
import { esc, fmtDate, askText } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { schedule, proposeDates, toDay, toISO, todayISO, makeCalendar } from '../../projects/schedule.js';
import { DEP_KINDS, newId, rankBetween } from '../../projects/core.js';
import { auth } from '../../auth.js';
import { filterBar, bindFilterBar, filterOf, can, formDialog, attempt, toast, itemHref, typeBadge, avatar, canCreateProjects, invalidate, projectHref } from './kit.js';

const KEY_KINDS = { competition: 'Competition', review: 'Design review', deadline: 'Deadline', milestone: 'Team milestone', break: 'Break' };

/** Kinds of item that can go under `parent` (an item) or at the top (null), highest level first. */
export function kindsUnder(cfg, parent) {
  const types = (cfg?.types || []).filter((t) => !t.archived_at);
  const pt = parent ? cfg.typeById.get(parent.type_id) : null;
  const ok = pt ? types.filter((t) => (t.parent_type_ids?.length ? t.parent_type_ids.includes(pt.id) : t.level > pt.level)) : types;
  return [...ok].sort((a, z) => (a.level - z.level) || (a.is_milestone - z.is_milestone) || ((a.sort ?? 0) - (z.sort ?? 0)));
}

const ROW = 32;
const ZOOM = { day: 30, week: 14, month: 5, quarter: 2 };
const states = new Map();
const stateOf = (key) => states.get(key) || states.set(key, { f: { q: '', owner: '', category: '', priority: '', type: '', more: null }, zoom: 'week', closed: new Set(), overrides: {},
  baseline: '', scenario: '', deps: true, critical: true, scroll: null, undated: false, keys: true }).get(key);

export async function renderTimeline(el, scope) {
  const { b, project } = scope;
  const st = stateOf(project?.id || '');
  const px = ZOOM[st.zoom];
  const today = todayISO();
  const filter = filterOf(st.f);
  const [{ items: all, total }, deps, baselines, scenarios, shown, keyDates, orderWarnings] = await Promise.all([
    pm.searchAll({ project: project?.id, sort: 'rank' }, 3000), pm.deps(scope.projectIds),
    project ? pm.baselines(project.id) : [], project ? pm.scenarios(project.id) : [],
    filter || st.f.q ? pm.searchAll({ project: project?.id, filter, q: st.f.q }, 3000).then((r) => new Set(r.items.map((i) => i.id))) : null,
    pm.keyDates().catch(() => []),
    Promise.all(scope.projectIds.map((pid) => pm.orderWarnings(pid).catch(() => []))).then((x) => x.flat()),
  ]);
  const isMs = (i) => !!scope.cfgOf(i)?.typeById.get(i.type_id)?.is_milestone;
  const items = all.map((i) => ({ ...i, is_milestone: isMs(i) }));
  const byId = new Map(items.map((i) => [i.id, i]));
  // items in other projects that ours wait on (they shape the forecast but aren't rows here), and ones waiting on ours
  const outsideIds = [...new Set(deps.flatMap((d) => [d.from_item, d.to_item]).filter((id) => !byId.has(id)))];
  const outsideAll = await pm.itemsByIds(outsideIds).catch(() => []);
  const outsideById = new Map(outsideAll.map((o) => [o.id, o]));
  const outside = outsideAll.filter((o) => deps.some((d) => d.from_item === o.id));
  const settings = project?.settings || {};
  const input = [...items, ...outside.map((o) => ({ ...o, is_milestone: false }))];
  const ordersFor = new Map();
  for (const w of orderWarnings) (ordersFor.get(w.item) || ordersFor.set(w.item, []).get(w.item)).push(w);
  const base = schedule(input, deps, settings, { today });
  const trying = Object.keys(st.overrides).length > 0;
  const plan = trying ? schedule(input, deps, settings, { today, overrides: st.overrides }) : base;
  const baseline = baselines.find((x) => x.id === st.baseline)?.snapshot || null;
  const target = (i) => st.overrides[i.id] ? { start: st.overrides[i.id].start, due: st.overrides[i.id].due } : { start: i.start_date, due: i.due_date };

  // rows: by project (across projects), then by parent, in backlog order; a filter keeps matches and what they sit under
  const undated = (i) => i.category !== 'done' && !target(i).start && !target(i).due;
  const keep = (i) => (!shown || shown.has(i.id)) && (!st.undated || undated(i));
  const undatedCount = items.filter(undated).length;
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
    const canAdd = can(b, pid, 'create');
    // a project with nothing (yet) still gets its row to add to, unless a filter is hiding things
    if (!roots.some((r) => visible.has(r.id)) && (shown || st.undated || roots.length || !canAdd)) continue;
    if (!project) rows.push({ header: b.projectById.get(pid) });
    if (project || !st.closed.has(pid)) {
      roots.forEach((r) => walk(r, 0));
      if (canAdd) rows.push({ add: pid });
    }
  }
  // summary spans: everything under an item (and under each project), from target dates, else the forecast
  const own = (i) => {
    const t = target(i);
    const p = plan.byId.get(i.id);
    const a = t.start || t.due || p?.start;
    const z = t.due || t.start || p?.finish;
    return a && z ? [a, z] : null;
  };
  const merge = (s, o) => (!o ? s : !s ? [...o] : [o[0] < s[0] ? o[0] : s[0], o[1] > s[1] ? o[1] : s[1]]);
  const under = new Map();
  const spanUnder = (i) => {
    if (under.has(i.id)) return under.get(i.id);
    under.set(i.id, null);
    let s = null;
    for (const c of kids.get(i.id) || []) s = merge(merge(s, own(c)), spanUnder(c));
    under.set(i.id, s);
    return s;
  };
  const spanProject = (pid) => (kids.get(`root:${pid}`) || []).reduce((s, r) => merge(merge(s, own(r)), spanUnder(r)), null);

  // the span of days shown
  const days = [toDay(today)];
  for (const { item: i } of rows.filter((r) => r.item)) {
    const p = plan.byId.get(i.id);
    const t = target(i);
    days.push(...[t.start, t.due, p?.start, p?.finish, baseline?.[i.id]?.start, baseline?.[i.id]?.due].filter(Boolean).map(toDay));
  }
  for (const r of rows) {
    const s = r.header ? spanProject(r.header.id) : r.item && r.children ? spanUnder(r.item) : null;
    if (s) days.push(toDay(s[0]), toDay(s[1]));
  }
  // team dates coming up (the next 8 months) are always in view
  const tday = toDay(today);
  const keysShown = st.keys ? keyDates.filter((k) => toDay(k.end_day || k.day) >= tday - 30 && toDay(k.day) <= tday + 240) : [];
  for (const k of keysShown) days.push(toDay(k.day), toDay(k.end_day || k.day));
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
    const keys = keysShown.map((k) => `<span class="pm-g-keyhead is-${esc(k.kind)}" style="left:${x(k.day)}px" title="${esc(`${k.name}: ${fmtDate(k.day)}${k.end_day && k.end_day !== k.day ? ` – ${fmtDate(k.end_day)}` : ''}${k.note ? ` · ${k.note}` : ''}`)}">${esc(k.name)}</span>`).join('');
    return `<div class="pm-g-head" style="width:${width}px">${months}${ticks}${keys}</div>`;
  };
  const rowIndex = new Map();
  rows.forEach((r, n) => r.item && rowIndex.set(r.item.id, n));
  const span = (i) => {
    const t = target(i);
    const p = plan.byId.get(i.id);
    return { start: t.start || (t.due && !i.is_milestone ? null : null) || t.due || p?.start, end: t.due || t.start || p?.finish, p, t };
  };
  const summary = (s, top, title) => (s ? `<div class="pm-g-sum" style="top:${top}px;left:${x(s[0])}px;width:${(toDay(s[1]) - toDay(s[0]) + 1) * px}px" title="${esc(title)}: ${esc(fmtDate(s[0]))} – ${esc(fmtDate(s[1]))}"></div>` : '');
  const bar = (r, n) => {
    if (r.header) return `<div class="pm-g-row is-header" style="top:${n * ROW}px;width:${width}px"></div>${summary(spanProject(r.header.id), n * ROW + ROW / 2 - 4, r.header.name)}`;
    if (r.add) return `<div class="pm-g-row is-add" style="top:${n * ROW}px;width:${width}px"></div>`;
    const i = r.item;
    const { p, t } = span(i);
    const top = n * ROW;
    const drag = can(b, i.project_id, 'plan') && i.category !== 'done';
    const draw = drag && !t.start && !t.due && !i.is_milestone;
    let out = `<div class="pm-g-row${draw ? ' is-drawable' : ''}" ${draw ? `data-draw="${esc(i.id)}" title="Drag across this row to give ${esc(i.key)} its dates"` : ''} style="top:${top}px;width:${width}px"></div>`;
    // dependencies on items in other projects: a tag where the other item ends (it waits on) or starts (waiting on this)
    for (const d of deps) {
      const inbound = d.to_item === i.id && outsideById.has(d.from_item);
      const outbound = d.from_item === i.id && outsideById.has(d.to_item);
      if (!inbound && !outbound) continue;
      const o = outsideById.get(inbound ? d.from_item : d.to_item);
      const op = plan.byId.get(o.id);
      const at = inbound ? (o.due_date || op?.finish || o.start_date) : (o.start_date || o.due_date);
      if (!at) continue;
      const proj = b.projectById.get(o.project_id);
      const tip = `${inbound ? 'Waits on' : 'Waiting on this:'} ${o.key} ${o.title}${proj ? ` (${proj.name})` : ''}\n${inbound ? 'Finishes' : 'Starts'} ${fmtDate(at)} · ${DEP_KINDS[d.kind]}`;
      out += `<a class="pm-g-ext${inbound ? '' : ' is-out'}${inbound && o.category !== 'done' ? '' : ' is-done'}" href="${itemHref(o.key)}" style="top:${top + 8}px;left:${inbound ? x(at) + px - 2 : x(at) - 2}px" title="${esc(tip)}">${inbound ? `${esc(o.key)} ▸` : `◂ ${esc(o.key)}`}</a>`;
    }
    if (r.children) out += summary(spanUnder(i), top + ROW - 7, `Everything under ${i.key}`);
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
  // with a baseline chosen: how far each item's finish moved since it was saved (calendar days)
  const slipOf = (i) => {
    const bl = baseline?.[i.id];
    const was = bl && (bl.due || bl.start);
    const now = target(i).due || target(i).start;
    return was && now ? toDay(now) - toDay(was) : null;
  };
  const slipChip = (i) => {
    const s = slipOf(i);
    return s ? `<span class="pm-g-chip ${s > 0 ? 'is-warn' : 'is-good'}" title="${s > 0 ? 'Later' : 'Earlier'} than the baseline by ${Math.abs(s)} day${Math.abs(s) === 1 ? '' : 's'}">${s > 0 ? '+' : '−'}${Math.abs(s)}d</span>` : '';
  };
  const slipped = baseline ? items.map((i) => ({ i, s: slipOf(i) })).filter((x) => x.s).sort((a, z) => z.s - a.s) : [];
  const keyBands = () => keysShown.map((k) => {
    const w = (toDay(k.end_day || k.day) - toDay(k.day) + 1) * px;
    return `<div class="pm-g-keydate is-${esc(k.kind)}" style="left:${x(k.day)}px;width:${Math.max(w, 2)}px;height:${rows.length * ROW}px"
      title="${esc(`${k.name} (${KEY_KINDS[k.kind] || k.kind}): ${fmtDate(k.day)}${k.end_day && k.end_day !== k.day ? ` – ${fmtDate(k.end_day)}` : ''}${k.note ? `\n${k.note}` : ''}`)}"></div>`;
  }).join('');
  const parentKey = (i) => (i.parent_id && byId.has(i.parent_id) ? i.parent_id : `root:${i.project_id}`);
  /** The row just above it at the same level, if `i` is allowed under it. */
  const indentTarget = (i) => {
    const sib = kids.get(parentKey(i)) || [];
    const prev = sib[sib.indexOf(i) - 1];
    return prev && kindsUnder(scope.cfgOf(i), prev).some((t) => t.id === i.type_id) ? prev : null;
  };
  const rowTools = (r) => {
    const i = r.item;
    if (i.category === 'done') return '';
    const cfg = scope.cfgOf(i);
    let out = '';
    if (can(b, i.project_id, 'create') && kindsUnder(cfg, i).length) out += `<button type="button" class="btn btn-sm btn-ghost" data-add-child="${esc(i.id)}" title="Add something under ${esc(i.key)}" aria-label="Add something under ${esc(i.key)}">+</button>`;
    if (can(b, i.project_id, 'edit')) {
      const up = indentTarget(i);
      if (i.parent_id && byId.has(i.parent_id)) out += `<button type="button" class="btn btn-sm btn-ghost" data-outdent="${esc(i.id)}" title="Take ${esc(i.key)} out a level" aria-label="Take ${esc(i.key)} out a level">⇤</button>`;
      if (up) out += `<button type="button" class="btn btn-sm btn-ghost" data-indent="${esc(i.id)}" title="Put ${esc(i.key)} under ${esc(up.key)}" aria-label="Put ${esc(i.key)} under ${esc(up.key)}">⇥</button>`;
    }
    return out;
  };
  const label = (r) => (r.add
    ? `<div class="pm-g-label is-add" style="padding-left:28px"><button type="button" class="btn btn-sm btn-ghost" data-add-root="${esc(r.add)}">+ Add${project ? '' : ` to ${esc(b.projectById.get(r.add)?.key || '')}`}</button></div>`
    : r.header
    ?`<div class="pm-g-label is-header"><button type="button" class="pm-g-toggle" data-toggle="${esc(r.header.id)}" aria-expanded="${!st.closed.has(r.header.id)}">${st.closed.has(r.header.id) ? '▸' : '▾'}</button> <a href="#/projects/p/${esc(r.header.key)}/timeline"><strong>${esc(r.header.name)}</strong></a></div>`
    : `<div class="pm-g-label${plan.byId.get(r.item.id)?.critical && st.critical ? ' is-critical' : ''}" data-row="${esc(r.item.id)}" style="padding-left:${6 + r.depth * 16}px">
        ${can(b, r.item.project_id, 'edit') && r.item.category !== 'done' ? `<span class="pm-g-grip" data-grip="${esc(r.item.id)}" title="Drag onto another row: the middle puts it under that row, the top or bottom edge before or after it" aria-hidden="true">⋮⋮</span>` : ''}
        ${r.children ? `<button type="button" class="pm-g-toggle" data-toggle="${esc(r.item.id)}" aria-expanded="${!st.closed.has(r.item.id)}" aria-label="${st.closed.has(r.item.id) ? 'Show' : 'Hide'} what's under ${esc(r.item.key)}">${st.closed.has(r.item.id) ? '▸' : '▾'}</button>` : '<span class="pm-g-toggle"></span>'}
        ${typeBadge(scope.cfgOf(r.item)?.typeById.get(r.item.type_id))} <span class="pm-g-name"><a href="${itemHref(r.item.key)}">${esc(r.item.key)}</a>
          <span class="pm-g-title" ${can(b, r.item.project_id, 'edit') ? `data-rename="${esc(r.item.id)}" title="${esc(r.item.title)} (double-click to rename)"` : `title="${esc(r.item.title)}"`}>${esc(r.item.title)}</span></span>
        ${slipChip(r.item)}${undated(r.item) ? '<span class="pm-g-chip" title="No start or due date yet: drag across the row to set them">no dates</span>' : ''}${(ordersFor.get(r.item.id) || []).length ? `<span class="pm-g-chip is-warn" title="${esc(ordersFor.get(r.item.id).map((w) => `${w.number} is ${w.status}, not ordered yet`).join('\n'))}">order ⚠</span>` : ''}
        <span class="pm-g-label-end">${avatar(b, r.item.owner_id)}${rowTools(r)}${can(b, r.item.project_id, 'plan') && r.item.category !== 'done' ? `<button type="button" class="btn btn-sm btn-ghost" data-dates="${esc(r.item.id)}" aria-label="Change the dates of ${esc(r.item.key)}">Dates</button>` : ''}</span></div>`);

  // what a what-if changes downstream
  const moved = trying ? [...plan.byId].filter(([id, p]) => base.byId.get(id) && base.byId.get(id).finish !== p.finish && !st.overrides[id] && byId.has(id))
    .map(([id, p]) => ({ item: byId.get(id), from: base.byId.get(id).finish, to: p.finish })) : [];
  const height = rows.length * ROW;
  const warnings = plan.warnings.filter((w) => byId.has(w.id));

  el.innerHTML = `<div class="pm-toolbar"><div class="card-actions">
        <label class="inline-field">Zoom <select data-zoom>${Object.keys(ZOOM).map((z) => `<option value="${z}" ${st.zoom === z ? 'selected' : ''}>${z[0].toUpperCase() + z.slice(1)}s</option>`).join('')}</select></label>
        <button type="button" class="btn btn-sm" data-fit title="Pick the zoom that shows everything at once">Fit</button>
        <button type="button" class="btn btn-sm" data-today>Today</button>
        <button type="button" class="btn btn-sm btn-ghost" data-collapse-all>Collapse all</button><button type="button" class="btn btn-sm btn-ghost" data-expand-all>Expand all</button>
        <label class="pm-check"><input type="checkbox" data-opt="deps" ${st.deps ? 'checked' : ''}> Dependencies</label>
        <label class="pm-check"><input type="checkbox" data-opt="critical" ${st.critical ? 'checked' : ''}> Critical path</label>
        <label class="pm-check"><input type="checkbox" data-opt="keys" ${st.keys ? 'checked' : ''}> Team dates</label>
        <label class="pm-check" title="Only items without a start or due date (and what they're under)"><input type="checkbox" data-opt="undated" ${st.undated ? 'checked' : ''}> Only undated${undatedCount ? ` (${undatedCount})` : ''}</label>
        ${auth.can('projects.manage') ? '<button type="button" class="btn btn-sm" data-key-dates>Team dates…</button>' : ''}
        ${!project && canCreateProjects() ? '<button type="button" class="btn btn-sm btn-primary" data-new-project>+ New project</button>' : ''}</div>
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
            ${keyBands()}
            <div class="pm-g-today" style="left:${x(today) + px / 2}px;height:${height}px" title="Today"></div>
            ${rows.map(bar).join('')}
            <svg class="pm-g-svg" width="${width}" height="${height}" aria-hidden="true"><defs>
              <marker id="pm-g-tip" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z"/></marker>
              <marker id="pm-g-tip-c" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z"/></marker></defs>${arrows()}</svg>
          </div></div></div>
      <p class="pm-g-legend muted small"><span class="pm-g-key is-bar"></span> target dates <span class="pm-g-key is-forecast"></span> forecast <span class="pm-g-key is-baseline"></span> baseline
        <span class="pm-g-key is-crit"></span> critical path <span class="pm-g-key is-ms"></span> milestone · Forecast finish for everything shown: <strong>${esc(fmtDate(plan.finish))}</strong></p>`
      : st.undated ? '<div class="empty"><p><strong>Every open item has dates.</strong></p></div>'
      : '<div class="empty"><p><strong>Nothing to show on the timeline.</strong></p><p>Give items a start and a due date, or link them with dependencies, and they appear here.</p></div>'}
    <div class="pm-summary">
      <section class="card"><h2>Schedule warnings <span class="muted">${warnings.length + orderWarnings.length}</span></h2>
        ${orderWarnings.length ? `<h3>Orders not placed in time</h3><ul class="pm-mini">${orderWarnings.map((w) => `<li><a href="${itemHref(w.key)}">${esc(w.key)}</a> <span>${w.start < today ? 'started' : 'starts'} ${esc(fmtDate(w.start))}, but ${esc(w.number)} (${esc(w.request_title)}) is ${esc(w.status)}.</span></li>`).join('')}</ul>` : ''}
        ${warnings.length ? `<ul class="pm-mini">${warnings.slice(0, 40).map((w) => `<li><a href="${itemHref(byId.get(w.id).key)}">${esc(byId.get(w.id).key)}</a> <span>${esc(w.text)}</span></li>`).join('')}</ul>` : orderWarnings.length ? '' : '<p class="muted">None: the target dates fit the dependencies, nothing is forecast to finish late, and the orders items wait on are placed.</p>'}</section>
      ${baseline ? `<section class="card"><h2>Moved since the baseline <span class="muted">${slipped.length}</span></h2>
        ${slipped.length ? `<ul class="pm-mini">${slipped.slice(0, 40).map(({ i, s }) => `<li><a href="${itemHref(i.key)}">${esc(i.key)}</a> ${esc(i.title)} <strong class="${s > 0 ? 'text-bad' : ''}">${s > 0 ? '+' : '−'}${Math.abs(s)} day${Math.abs(s) === 1 ? '' : 's'}</strong></li>`).join('')}</ul>` : '<p class="muted">Nothing: every item still finishes when the baseline said.</p>'}</section>` : ''}
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

  /**
   * A new item, at the top of a project or under `parent`, with its kind, title and dates. Saved straight away
   * (unlike dragging bars, which is a what-if): it's new, so nothing else moves because of it.
   */
  const addItem = async (pid, parent) => {
    const cfg = scope.cfgOf({ project_id: pid });
    const kinds = kindsUnder(cfg, parent);
    if (!kinds.length) return toast(parent ? `Nothing can go under a ${cfg?.typeById.get(parent.type_id)?.name || 'this'} in this project (Settings → Work types).` : 'This project has no work-item types yet. Add one in Settings → Work types.', 'bad');
    const start = (parent && (target(parent).start || plan.byId.get(parent.id)?.start)) || today;
    const pt = parent && target(parent);
    const due = pt?.due && pt.due >= start ? (toDay(pt.due) - toDay(start) < 7 ? pt.due : toISO(toDay(start) + 6)) : toISO(toDay(start) + 6);
    const opId = newId();
    return formDialog({
      title: parent ? `Add under ${esc(parent.key)}` : `Add to ${esc(b.projectById.get(pid)?.name || 'the project')}`, submit: 'Add',
      body: `${parent ? `<p class="muted">${esc(parent.title)}</p>` : ''}<div class="form-grid">
          <div class="field"><label for="ga-kind">Kind</label><select id="ga-kind" name="kind">${kinds.map((t) => `<option value="${esc(t.id)}">${esc(`${t.icon ? `${t.icon} ` : ''}${t.name}`)}</option>`).join('')}</select></div>
          <div class="field span-3"><label for="ga-title">Title</label><input id="ga-title" name="title" type="text" maxlength="200" required></div>
          <div class="field span-2"><label for="ga-start">Start</label><input id="ga-start" name="start" type="date" value="${esc(start)}"></div>
          <div class="field span-2"><label for="ga-due">Due</label><input id="ga-due" name="due" type="date" value="${esc(due)}"></div></div>
        <p class="hint">More details (owner, estimate…) are on the item's page, or in List and Backlog.</p>`,
      onOpen: (form) => form.elements.title.focus(),
      onSubmit: (f) => {
        const [s, z] = [f.elements.start.value, f.elements.due.value];
        if (s && z && s > z) throw new Error('The start date is after the due date.');
        return pm.createItem(opId, { project_id: pid, type_id: f.elements.kind.value, title: f.elements.title.value.trim(), parent_id: parent?.id || null,
          start_date: s || null, due_date: z || null, division_id: parent?.division_id || null, subsystem_id: parent?.subsystem_id || null });
      },
    });
  };

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
    else if (d.collapseAll !== undefined) {
      for (const [k, list] of kids) if (!k.startsWith('root:') && list.length) st.closed.add(k);
      if (!project) scope.projectIds.forEach((pid) => st.closed.add(pid));
      again();
    } else if (d.expandAll !== undefined) (st.closed.clear(), again());
    else if (d.fit !== undefined) {
      const room = (scroller?.clientWidth || 800) - 4;
      const span = last - first - 27;   // the days that matter, without the margins
      st.zoom = Object.keys(ZOOM).find((z) => span * ZOOM[z] <= room) || 'quarter';
      st.scroll = 0;
      again();
    } else if (d.keyDates !== undefined) (await keyDatesDialog(keyDates)) && again();
    else if (d.addRoot) (await addItem(d.addRoot, null)) && again();
    else if (d.addChild) {
      const parent = byId.get(d.addChild);
      if (await addItem(parent.project_id, parent)) (st.closed.delete(parent.id), again());
    } else if (d.indent || d.outdent) {
      const i = byId.get(d.indent || d.outdent);
      const to = d.indent ? indentTarget(i) : byId.get(i.parent_id);
      if (!to) return;
      const parentId = d.indent ? to.id : to.parent_id && byId.has(to.parent_id) ? to.parent_id : null;
      if (await attempt(() => pm.updateItem(i.id, i.version, { parent_id: parentId }), d.indent ? `${i.key} is under ${to.key} now.` : `${i.key} moved out a level.`)) {
        if (d.indent) st.closed.delete(to.id);
        again();
      }
    } else if (d.newProject !== undefined) {
      const { createProjectDialog } = await import('./projects.js');
      const p = await createProjectDialog(b);
      if (p) {
        invalidate();
        location.hash = projectHref(p.key, 'timeline');
      }
    } else if (d.dates) {
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

  // drawing on an undated item's row: from where you press to where you let go becomes its dates (a what-if)
  el.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('[data-draw]');
    if (!row || e.button !== 0) return;
    e.preventDefault();
    const i = byId.get(row.dataset.draw);
    const body = row.parentElement;
    const dayAt = (clientX) => Math.max(0, Math.floor((clientX - body.getBoundingClientRect().left) / px));
    const d0 = dayAt(e.clientX);
    let d1 = d0;
    const ghost = document.createElement('div');
    ghost.className = 'pm-g-bar is-drawing';
    ghost.style.cssText = `top:${row.offsetTop + 6}px;left:${d0 * px}px;width:${px}px`;
    body.append(ghost);
    row.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      d1 = dayAt(ev.clientX);
      const [a, z] = [Math.min(d0, d1), Math.max(d0, d1)];
      ghost.style.left = `${a * px}px`;
      ghost.style.width = `${(z - a + 1) * px}px`;
    };
    row.addEventListener('pointermove', onMove);
    row.addEventListener('pointerup', () => {
      row.removeEventListener('pointermove', onMove);
      ghost.remove();
      const [a, z] = [Math.min(d0, d1), Math.max(d0, d1)];
      // a single click gives it a week, the usual first guess
      tryDates(i.id, toISO(first + a), toISO(first + (a === z ? a + 6 : z)));
    }, { once: true });
  });

  // dragging a row by its handle onto another row: into it (middle), or before / after it (edges)
  el.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('[data-grip]');
    if (!grip || e.button !== 0) return;
    e.preventDefault();
    const i = byId.get(grip.dataset.grip);
    const labels = [...el.querySelectorAll('.pm-g-label[data-row]')];
    const under = (a, z) => {   // is z (an id) a, or somewhere under a?
      for (let n = byId.get(z); n; n = n.parent_id && byId.get(n.parent_id)) if (n.id === a) return true;
      return false;
    };
    let drop = null;
    const clear = () => labels.forEach((l) => l.classList.remove('is-drop-into', 'is-drop-before', 'is-drop-after', 'is-drop-no'));
    grip.setPointerCapture(e.pointerId);
    el.querySelector(`.pm-g-label[data-row="${CSS.escape(i.id)}"]`)?.classList.add('is-dragging');
    const onMove = (ev) => {
      clear();
      drop = null;
      const over = labels.find((l) => { const r = l.getBoundingClientRect(); return ev.clientY >= r.top && ev.clientY < r.bottom; });
      if (!over) return;
      const target = byId.get(over.dataset.row);
      const r = over.getBoundingClientRect();
      const f = (ev.clientY - r.top) / r.height;
      const where = f < 0.28 ? 'before' : f > 0.72 ? 'after' : 'into';
      const parent = where === 'into' ? target : target.parent_id && byId.has(target.parent_id) ? byId.get(target.parent_id) : null;
      const ok = target.id !== i.id && target.project_id === i.project_id && !under(i.id, target.id)
        && kindsUnder(scope.cfgOf(i), parent).some((t) => t.id === i.type_id);
      over.classList.add(ok ? `is-drop-${where}` : 'is-drop-no');
      if (ok) drop = { target, where, parent };
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', async () => {
      grip.removeEventListener('pointermove', onMove);
      clear();
      el.querySelector('.pm-g-label.is-dragging')?.classList.remove('is-dragging');
      if (!drop) return;
      const { target, where, parent } = drop;
      const sibs = (kids.get(parent ? parent.id : `root:${i.project_id}`) || []).filter((s) => s.id !== i.id);
      let rank;
      if (where === 'into') rank = rankBetween(sibs[sibs.length - 1]?.rank, null);
      else {
        const at = sibs.indexOf(target) + (where === 'after' ? 1 : 0);
        rank = rankBetween(sibs[at - 1]?.rank, sibs[at]?.rank);
      }
      const patch = { rank, ...((parent?.id || null) !== (i.parent_id && byId.has(i.parent_id) ? i.parent_id : null) ? { parent_id: parent?.id || null } : {}) };
      if (await attempt(() => pm.updateItem(i.id, i.version, patch), where === 'into' ? `${i.key} is under ${target.key} now.` : `${i.key} moved.`)) {
        if (where === 'into') st.closed.delete(target.id);
        again();
      }
    }, { once: true });
  });

  // double-click a title to rename it there
  el.addEventListener('dblclick', (e) => {
    const span = e.target.closest('[data-rename]');
    if (!span || span.querySelector('input')) return;
    const i = byId.get(span.dataset.rename);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pm-g-rename';
    input.maxLength = 200;
    input.value = i.title;
    input.setAttribute('aria-label', `New title for ${i.key}`);
    span.textContent = '';
    span.append(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      if (!save || !title || title === i.title) return void (span.textContent = i.title);
      span.textContent = title;
      if (await attempt(() => pm.updateItem(i.id, i.version, { title }), 'Renamed.')) again();
      else span.textContent = i.title;
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') (ev.preventDefault(), finish(true));
      else if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  });
}

/** 061: the team's dates (competitions, design reviews, breaks…): add one, or remove one. Shown on every timeline. */
function keyDatesDialog(list) {
  let changed = false;
  return formDialog({
    title: 'Team dates', submit: 'Add this date', wide: true,
    body: `<p class="muted">Competitions, design reviews, breaks… Every project's timeline shows them as lines.</p>
      <ul class="pm-mini" data-key-list>${list.length ? list.map((k) => `<li>${esc(fmtDate(k.day))}${k.end_day && k.end_day !== k.day ? ` – ${esc(fmtDate(k.end_day))}` : ''} <strong>${esc(k.name)}</strong>
        <span class="muted small">${esc(KEY_KINDS[k.kind] || k.kind)}${k.note ? ` · ${esc(k.note)}` : ''}</span>
        <button type="button" class="btn btn-sm btn-ghost" data-del-key="${esc(k.id)}" aria-label="Remove ${esc(k.name)}">✕</button></li>`).join('') : '<li class="muted">None yet.</li>'}</ul>
      <div class="form-grid">
        <div class="field span-3"><label for="kd-name">Name</label><input id="kd-name" name="name" type="text" maxlength="120" required placeholder="ASC 2027"></div>
        <div class="field"><label for="kd-kind">Kind</label><select id="kd-kind" name="kind">${Object.entries(KEY_KINDS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
        <div class="field span-2"><label for="kd-day">Date</label><input id="kd-day" name="day" type="date" required></div>
        <div class="field span-2"><label for="kd-end">Until (optional)</label><input id="kd-end" name="end" type="date"></div>
        <div class="field span-4"><label for="kd-note">Note</label><input id="kd-note" name="note" type="text" maxlength="500"></div></div>`,
    onOpen: (form) => {
      form.querySelector('[data-key-list]').addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-del-key]');
        if (!btn) return;
        if (await attempt(() => pm.deleteKeyDate(btn.dataset.delKey), 'Removed.')) {
          changed = true;
          btn.closest('li').remove();
        }
      });
    },
    onSubmit: (f) => {
      if (f.elements.end.value && f.elements.end.value < f.elements.day.value) throw new Error('"Until" is before the date.');
      return pm.saveKeyDate(null, { name: f.elements.name.value.trim(), kind: f.elements.kind.value, day: f.elements.day.value,
        end_day: f.elements.end.value || null, note: f.elements.note.value.trim() });
    },
  }).then((r) => r || changed);
}
