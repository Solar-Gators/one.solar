/**
 * Projects → Timeline: a Gantt chart of one project, or of every project I can see.
 *
 * Simple by default (062), like the team's roadmap slides: a wide list of work on the left, months over season
 * weeks (01, 02… from the "Season start" team date) on top, and one bar per item colored by its kind of work,
 * with a legend. Drag a bar to move it, pull an end to change its length (it snaps to days, or to weeks when
 * zoomed out); it saves straight away and "Undo" puts it back. Click a bar for a side panel to edit it; drag
 * from the dot at a bar's end onto another bar to make that one wait on it (click an arrow to remove it).
 *
 * More when you want it:
 *   Color by    kind (default), status, subsystem, owner or priority.
 *   Rows        group by (structure, owner, kind, status, subsystem, none), order (planned, start, end, what waits on
 *               what), pack rows that don't overlap in time, one row for a one-item project, hide rows outside the Fit.
 *   Show        dependencies, progress, labels on bars (and what they say), dates on summaries, item keys, owners, team
 *               dates, car cycles; density. Light / dark follows the site.
 *   Filter      the usual filters, and "Only undated" (draw on a row to give an item its dates).
 *   Plan        the scheduling engine (projects/schedule.js): the FORECAST (dashed outline) from dependencies,
 *               working days and what has happened, the critical path, baselines and how far rows slipped, and
 *               what-if mode, where moving bars is only tried out until "Apply" (saved what-ifs, Reschedule to
 *               forecast). Team dates are kept here too.
 *   Present     a clean full-screen chart with a title and legend; download it as a PNG or print it to PDF.
 *
 * Every project (063): levels above the projects, Car (when two car cycles are shown) → CE division → subsystem
 * → project → work. It opens on my subsystem (else my division); the breadcrumbs above zoom out to everything or
 * back in, and Level (Divisions / Subsystems / Projects / Work) folds the rows to that depth. A folded level is
 * one summary bar, with how many of its items are late.
 *
 * Each row's ⋯ menu adds things under it, nests it or takes it out a level, and sets its dates; ⋮⋮ drags it
 * onto another row (middle: under it; edges: before / after); double-click a title to rename it. Each person's
 * choices (zoom, colors, what's shown) are remembered per project in this browser.
 */
import { esc, fmtDate, askText } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { schedule, proposeDates, toDay, toISO, todayISO, makeCalendar } from '../../projects/schedule.js';
import { DEP_KINDS, PRIORITIES, CATEGORIES, newId, rankBetween } from '../../projects/core.js';
import { auth } from '../../auth.js';
import { filterBar, bindFilterBar, filterOf, can, canEditKinds, formDialog, attempt, toast, itemHref, avatar, personName, canCreateProjects, invalidate, projectHref, ie, mayEditItem, mayDateItem } from './kit.js';
import { bindInline, saveField } from './inline.js';
import { bindSelection, pickBox } from './select.js';
import { quickAdd, bindQuickAdd } from './quick.js';
import { cyclesInView, cyclesOf, cycleOfProject } from './cycles.js';

/** Kinds of item that can go under `parent` (an item) or at the top (null), highest level first. */
export function kindsUnder(cfg, parent) {
  const types = (cfg?.types || []).filter((t) => !t.archived_at);
  const pt = parent ? cfg.typeById.get(parent.type_id) : null;
  const ok = pt ? types.filter((t) => (t.parent_type_ids?.length ? t.parent_type_ids.includes(pt.id) : t.level > pt.level)) : types;
  return [...ok].sort((a, z) => (a.level - z.level) || (a.is_milestone - z.is_milestone) || ((a.sort ?? 0) - (z.sort ?? 0)));
}

const KEY_KINDS = { season: 'Season start (week 01)', competition: 'Competition', review: 'Design review', deadline: 'Deadline', milestone: 'Team milestone', break: 'Break' };
/** The project tones (core.js TONES) as bar colors. */
const TONE = { gray: '#8b93a3', blue: '#3c6fe0', green: '#2f9e5b', teal: '#25a59a', amber: '#d9a21b', orange: '#f26b3a', red: '#d9372b', pink: '#d6468f', purple: '#7c5ce0', navy: '#2c4a7a' };
const PALETTE = ['blue', 'orange', 'teal', 'purple', 'green', 'pink', 'amber', 'red', 'navy'];
const CAT_TONE = { todo: 'gray', doing: 'blue', done: 'green' };
const PRI_TONE = { urgent: 'red', high: 'orange', medium: 'blue', low: 'gray' };
const COLOR_BY = { type: 'Kind of work', status: 'Status', subsystem: 'Subsystem', owner: 'Owner', priority: 'Priority' };
/** Zoom: how wide a day is, in pixels. The presets; − / +, Ctrl+scroll (or pinching) and the − / + keys go between them. */
const ZOOMS = [['day', 'Days', 40], ['week', 'Weeks', 18], ['month', 'Months', 6], ['quarter', 'Quarters', 2.2], ['year', 'Year', 0.9]];
const PX_MIN = 0.4;
const PX_MAX = 80;
const clampPx = (n) => Math.min(PX_MAX, Math.max(PX_MIN, Number(n) || 18));
/** Fit: a span of dates made to fill the width (it's chosen again as the window changes size). */
const FITS = { all: 'Everything shown', cycle: 'This car cycle', '3m': 'Next 3 months', '6m': 'Next 6 months', '12m': 'Next 12 months' };
let resizeTimer = 0;
let onResize = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => onResize?.(), 200);
});
const DENSITY = { comfortable: { row: 40, bar: 22 }, compact: { row: 30, bar: 16 } };
const SHOW = { deps: 'Dependencies', progress: 'Progress', labels: 'Labels on bars', sums: 'Dates on summary bars', keys: 'Item keys', status: 'Status', owners: 'Owners', team: 'Team dates', cycles: 'Car cycles' };
/** What a bar's label says (Show → Labels on bars). */
const BAR_TEXT = { name: 'Name', dates: 'Dates', both: 'Name and dates', owner: 'Owner', progress: 'Progress' };
/** Rows, top to bottom: what they're grouped by, and the order inside a group. */
const GROUP_BY = { structure: 'What\'s under what', owner: 'Owner', type: 'Kind of work', status: 'Status', subsystem: 'Subsystem', none: 'Nothing (one list)' };
const SORT_BY = { rank: 'As planned', start: 'Start date', end: 'End date', deps: 'What waits on what' };
const DEFAULTS = { px: 18, fit: '', colorBy: 'type', density: 'comfortable', labelW: 280, barText: 'name',
  groupBy: 'structure', sortBy: 'rank', pack: false, merge: true, hideOutside: false, closed: [], level: '',
  show: { deps: true, progress: true, labels: false, sums: true, keys: false, status: false, owners: false, team: true, cycles: true },
  plan: { forecast: false, critical: false, whatIf: false, baseline: '' } };

const prefKey = (key) => `pm.gantt.${key || 'all'}`;
function loadPrefs(key) {
  const d = key ? DEFAULTS : { ...DEFAULTS, labelW: 340 };   // every project: room for the levels above the work
  try {
    const p = JSON.parse(localStorage.getItem(prefKey(key)) || 'null');
    if (p) {
      // saved before zoom was a number: Weeks, Months or Season (now "Fit: everything shown")
      if (p.px === undefined && p.zoom) Object.assign(p, p.zoom === 'season' ? { fit: 'all' } : { px: p.zoom === 'month' ? 6 : 18 });
      return { ...d, ...p, show: { ...d.show, ...p.show }, plan: { ...d.plan, ...p.plan } };
    }
  } catch { /* private window: defaults */ }
  return { ...d, show: { ...d.show }, plan: { ...d.plan } };
}
function savePrefs(key, st) {
  try {
    localStorage.setItem(prefKey(key), JSON.stringify({ px: st.px, fit: st.fit, colorBy: st.colorBy, density: st.density, labelW: st.labelW, show: st.show, plan: st.plan,
      barText: st.barText, groupBy: st.groupBy, sortBy: st.sortBy, pack: st.pack, merge: st.merge, hideOutside: st.hideOutside, closed: [...st.closed], level: st.level }));
  } catch { /* not kept: fine */ }
}
const states = new Map();
function stateOf(key) {
  if (!states.has(key)) {
    const p = loadPrefs(key);   // what's folded and the level are remembered too
    states.set(key, { ...p, f: { q: '', owner: '', category: '', priority: '', type: '', more: null }, closed: new Set(Array.isArray(p.closed) ? p.closed : []), overrides: {}, scenario: '',
      scroll: null, undated: false, filters: false, pop: '', only: '', selected: '', present: false, title: null, subtitle: null,
      focus: null, focusSet: false, level: p.level || '', room: null, anchor: null });
  }
  return states.get(key);
}

const span2 = (s, z) => (s && z ? toDay(z) - toDay(s) + 1 : null);
const lengthText = (n) => (n === null ? '' : n % 7 === 0 ? `${n / 7} week${n === 7 ? '' : 's'}` : `${n} day${n === 1 ? '' : 's'}`);
const rangeText = (s, z) => (s && z ? `${fmtDate(s)} – ${fmtDate(z)} · ${lengthText(span2(s, z))}` : fmtDate(s || z));

/** The site's own light / dark setting (account menu): the chart and the slide follow it. */
const siteDark = () => document.documentElement.dataset.theme === 'dark';

/** The same notice with Undo as everywhere else in Projects, after a change that saved straight away. */
const undoBar = (text, undo) => toast(text, 'ok', { undo });

export async function renderTimeline(el, scope) {
  const { b, project } = scope;
  const key = project?.id || '';
  const st = stateOf(key);
  const persist = () => savePrefs(key, st);
  const today = todayISO();
  const tday = toDay(today);
  const filter = filterOf(st.f);
  const [{ items: all, total }, deps, baselines, scenarios, shown, keyDates, orderWarnings] = await Promise.all([
    pm.searchAll({ project: project?.id, projects: scope.only, sort: 'rank' }, 3000), pm.deps(scope.projectIds),
    project ? pm.baselines(project.id) : [], project ? pm.scenarios(project.id) : [],
    filter || st.f.q ? pm.searchAll({ project: project?.id, projects: scope.only, filter, q: st.f.q }, 3000).then((r) => new Set(r.items.map((i) => i.id))) : null,
    pm.keyDates().catch(() => []),
    Promise.all(scope.projectIds.map((pid) => pm.orderWarnings(pid).catch(() => []))).then((x) => x.flat()),
  ]);
  const isMs = (i) => !!scope.cfgOf(i)?.typeById.get(i.type_id)?.is_milestone;
  const items = all.map((i) => ({ ...i, is_milestone: isMs(i) }));
  const byId = new Map(items.map((i) => [i.id, i]));
  // items in other projects that ours wait on (they shape the forecast but aren't rows here), and ones waiting on ours
  const outsideAll = await pm.itemsByIds([...new Set(deps.flatMap((d) => [d.from_item, d.to_item]).filter((id) => !byId.has(id)))]).catch(() => []);
  const outsideById = new Map(outsideAll.map((o) => [o.id, o]));
  const outside = outsideAll.filter((o) => deps.some((d) => d.from_item === o.id));
  const settings = project?.settings || {};
  const input = [...items, ...outside.map((o) => ({ ...o, is_milestone: false }))];
  const base = schedule(input, deps, settings, { today });
  const trying = Object.keys(st.overrides).length > 0;
  const plan = trying ? schedule(input, deps, settings, { today, overrides: st.overrides }) : base;
  const baseline = baselines.find((x) => x.id === st.plan.baseline)?.snapshot || null;
  const target = (i) => (st.overrides[i.id] ? { start: st.overrides[i.id].start, due: st.overrides[i.id].due } : { start: i.start_date, due: i.due_date });
  const ordersFor = new Map();
  for (const w of orderWarnings) (ordersFor.get(w.item) || ordersFor.set(w.item, []).get(w.item)).push(w);
  const mayPlanAny = scope.projectIds.some((pid) => can(b, pid, 'plan'));

  // ---- spans: an item's own dates (target, else the forecast), and everything under an item, a project or a group
  const own = (i) => {
    const t = target(i);
    const p = plan.byId.get(i.id);
    const a = t.start || t.due || p?.start;
    const z = t.due || t.start || p?.finish;
    return a && z ? [a, z] : null;
  };
  const merge = (s, o) => (!o ? s : !s ? [...o] : [o[0] < s[0] ? o[0] : s[0], o[1] > s[1] ? o[1] : s[1]]);
  const parentKey = (i) => (i.parent_id && byId.has(i.parent_id) ? i.parent_id : `root:${i.project_id}`);
  const kids = new Map();
  for (const i of items) (kids.get(parentKey(i)) || kids.set(parentKey(i), []).get(parentKey(i))).push(i);
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
  const spanHeader = (h) => (h.items ? h.items.reduce((s, i) => merge(s, own(i)), null) : h.pids.reduce((s, pid) => merge(s, spanProject(pid)), null));
  /** How far along a summary is (done counts as 100%), and how much of it is past its due date. */
  const leavesOf = (i) => {
    const k = kids.get(i.id) || [];
    return k.length ? k.flatMap(leavesOf) : [i];
  };
  const infoOf = (list) => (!list.length ? null : {
    pct: Math.round(list.reduce((s, i) => s + (i.category === 'done' ? 100 : Number(i.progress) || 0), 0) / list.length),
    late: list.filter((i) => i.category !== 'done' && i.due_date && i.due_date < today).length,
  });
  const headerInfo = (h) => infoOf(h.items || h.pids.flatMap((pid) => (kids.get(`root:${pid}`) || []).flatMap(leavesOf)));

  // Fit to set dates (anything but "everything shown"): known before the rows, so rows outside them can be left out
  const cycleSpan = () => {
    const ids = cyclesInView(b);
    const list = (ids ? b.programs.filter((g) => ids.includes(g.id)) : cyclesOf(b)).filter((g) => g.start_date && g.end_date);
    return list.length ? [Math.min(...list.map((g) => toDay(g.start_date))), Math.max(...list.map((g) => toDay(g.end_date)))] : null;
  };
  const fixedWindow = !st.fit || st.fit === 'all' ? null : typeof st.fit === 'object' ? [toDay(st.fit.from), toDay(st.fit.to)]
    : st.fit === 'cycle' ? cycleSpan() : st.fit === '3m' ? [tday - 7, tday + 91] : st.fit === '6m' ? [tday - 7, tday + 182] : st.fit === '12m' ? [tday - 14, tday + 365] : null;
  const hiding = !!(st.hideOutside && fixedWindow);
  const outsideWindow = (i) => {
    const s = own(i);
    return !s || toDay(s[1]) < fixedWindow[0] || toDay(s[0]) > fixedWindow[1];
  };

  // ---- rows: by project (across projects), then by parent, in backlog order; a filter keeps matches and what they're under
  const undated = (i) => i.category !== 'done' && !target(i).start && !target(i).due;
  const keep = (i) => (!shown || shown.has(i.id)) && (!st.undated || undated(i)) && (!hiding || !outsideWindow(i));
  const undatedCount = items.filter(undated).length;
  const visible = new Set();
  const mark = (i) => {
    let any = keep(i);
    for (const c of kids.get(i.id) || []) any = mark(c) || any;
    if (any) visible.add(i.id);
    return any;
  };
  const rows = [];
  // Rows → Order: siblings as planned (backlog order), by start or end date, or what waits on what (then by start)
  const startOf = (i) => {
    const s = merge(own(i), spanUnder(i));
    return s ? toDay(s[st.sortBy === 'end' ? 1 : 0]) : Infinity;
  };
  const sortList = (list) => {
    if (st.sortBy === 'start' || st.sortBy === 'end') return [...list].sort((a, z) => startOf(a) - startOf(z));
    if (st.sortBy !== 'deps') return list;
    const ids = new Set(list.map((i) => i.id));
    const waiting = new Map(list.map((i) => [i.id, 0]));
    const next = new Map();
    for (const d of deps) {
      if (!ids.has(d.from_item) || !ids.has(d.to_item) || d.from_item === d.to_item) continue;
      waiting.set(d.to_item, waiting.get(d.to_item) + 1);
      (next.get(d.from_item) || next.set(d.from_item, []).get(d.from_item)).push(d.to_item);
    }
    const left = [...list].sort((a, z) => startOf(a) - startOf(z));
    const out = [];
    while (left.length) {
      const at = left.findIndex((i) => waiting.get(i.id) === 0);
      const [i] = left.splice(Math.max(at, 0), 1);   // a loop: the earliest goes first
      out.push(i);
      for (const id of next.get(i.id) || []) waiting.set(id, waiting.get(id) - 1);
    }
    return out;
  };
  const hasKids = (i) => (kids.get(i.id) || []).some((c) => visible.has(c.id));
  // Rows → Pack rows: siblings with dates and nothing under them share a row when they don't overlap in time
  const place = (list, depth, flat = false) => {
    list = sortList(list);
    if (!st.pack) return list.forEach((c) => (flat ? rows.push({ item: c, depth, children: 0 }) : walk(c, depth)));
    const lanes = [];
    const laneOf = new Map();
    for (const c of list.filter((i) => own(i) && (flat || !hasKids(i))).sort((a, z) => toDay(own(a)[0]) - toDay(own(z)[0]))) {
      const [s, z] = own(c).map(toDay);
      let lane = lanes.find((l) => l.end < s - 1);
      if (!lane) lanes.push((lane = { end: -Infinity, items: [] }));
      lane.items.push(c);
      lane.end = Math.max(lane.end, z);
      laneOf.set(c.id, lane);
    }
    for (const c of list) {
      const lane = laneOf.get(c.id);
      if (!lane) flat ? rows.push({ item: c, depth, children: 0 }) : walk(c, depth);
      else if (lane.items.length === 1) rows.push({ item: c, depth, children: 0 });
      else if (!lane.shown) ((lane.shown = true), rows.push({ lane: lane.items, depth }));
    }
  };
  const walk = (i, depth, prefix = null) => {
    if (!visible.has(i.id)) return;
    const children = (kids.get(i.id) || []).filter((c) => visible.has(c.id));
    rows.push({ item: i, depth, children: children.length, prefix });
    if (!st.closed.has(i.id)) place(children, depth + 1);
  };
  const live = scope.projectIds.filter((pid) => {
    const roots = kids.get(`root:${pid}`) || [];
    roots.forEach(mark);
    return roots.some((r) => visible.has(r.id)) || (!shown && !st.undated && !hiding);   // an empty project shows too (e.g. next car's), unless filtering
  });
  const projectRows = (pid, depth) => {
    const roots = (kids.get(`root:${pid}`) || []).filter((r) => visible.has(r.id));
    if (project) return place(roots, 0);
    const p = b.projectById.get(pid);
    // a project with one thing in it (and nothing under that) is one row: "Battery Pack › Cell Selection"
    if (st.merge && !st.closed.has(pid) && roots.length === 1 && !hasKids(roots[0])) return walk(roots[0], depth, { key: p.key, name: p.name });
    rows.push({ header: { kind: 'project', id: pid, key: p.key, name: p.name, pids: [pid], toggle: pid, late: lateIn([pid]) }, depth });
    if (!st.closed.has(pid)) place(roots, depth + 1);
  };

  // ---- across projects: the levels above them (Car → CE division → subsystem), and where it opens
  const lateIn = (pids) => items.filter((i) => pids.includes(i.project_id) && i.category !== 'done' && i.due_date && i.due_date < today).length;
  const carsShown = cyclesInView(b);
  const multiCar = carsShown ? carsShown.length > 1 : cyclesOf(b).length > 1;
  const nodes = project ? [] : live.map((pid) => {
    const p = b.projectById.get(pid);
    return { pid, p, car: multiCar ? cycleOfProject(b, p)?.id || '' : '', div: p.division_id || b.subsystemById.get(p.subsystem_id)?.division_id || '', sub: p.subsystem_id || '' };
  });
  const sortOf = (list, id) => { const at = list.findIndex((x) => x.id === id); return at < 0 ? 1e9 : at; };
  const divOrder = [...b.divisions].sort((a, z) => (a.sort - z.sort) || a.name.localeCompare(z.name));
  const subOrder = [...b.subsystems].sort((a, z) => (a.sort - z.sort) || a.name.localeCompare(z.name));
  const LEVEL = {
    car: { get: (n) => n.car, name: (id) => b.programs.find((g) => g.id === id)?.name || 'No car cycle', order: (id) => sortOf(cyclesOf(b), id) },
    division: { get: (n) => n.div, name: (id) => b.divisionById.get(id)?.name || 'No CE division', order: (id) => (id ? sortOf(divOrder, id) : 1e9) },
    subsystem: { get: (n) => n.sub, name: (id) => b.subsystemById.get(id)?.name || '', order: (id) => sortOf(subOrder, id) },
  };
  const levelsUsed = [...(multiCar ? ['car'] : []), ...(nodes.some((n) => n.div) ? ['division'] : []), ...(nodes.some((n) => n.sub) ? ['subsystem'] : [])];
  if (!project && !st.focusSet) {   // the first time: my subsystem, else my division
    st.focusSet = true;
    const mine = b.myOrg;
    if (mine?.subsystem_id && nodes.some((n) => n.sub === mine.subsystem_id)) st.focus = { kind: 'subsystem', id: mine.subsystem_id };
    else if (mine?.division_id && nodes.some((n) => n.div === mine.division_id)) st.focus = { kind: 'division', id: mine.division_id };
  }
  if (st.focus && !nodes.some((n) => LEVEL[st.focus.kind]?.get(n) === st.focus.id)) st.focus = null;   // nothing there now
  const focus = project ? null : st.focus;
  const inFocus = focus ? nodes.filter((n) => LEVEL[focus.kind].get(n) === focus.id) : nodes;
  const dropped = !focus ? [] : focus.kind === 'subsystem' ? ['division', 'subsystem'] : [focus.kind];
  const levels = levelsUsed.filter((k) => !dropped.includes(k));
  const groupKey = (kind, id) => `${kind}:${id || 'none'}`;
  const emit = (list, at, depth) => {
    if (at >= levels.length) {
      const by = (n) => {
        const s = spanProject(n.pid);
        return s ? toDay(s[st.sortBy === 'end' ? 1 : 0]) : Infinity;
      };
      const dated = st.sortBy === 'start' || st.sortBy === 'end' || st.sortBy === 'deps';
      return [...list].sort((a, z) => (dated ? by(a) - by(z) : 0) || a.p.name.localeCompare(z.p.name)).forEach((n) => projectRows(n.pid, depth));
    }
    const kind = levels[at];
    const L = LEVEL[kind];
    const groups = new Map();
    for (const n of [...list].sort((a, z) => L.order(L.get(a)) - L.order(L.get(z)))) (groups.get(L.get(n)) || groups.set(L.get(n), []).get(L.get(n))).push(n);
    for (const [id, ns] of groups) {
      // no subsystem, or a subsystem with one project: the project goes straight under the level above (no row saying the same twice)
      if (kind === 'subsystem' && (!id || ns.length === 1)) { emit(ns, at + 1, depth); continue; }
      const key = groupKey(kind, id);
      const pids = ns.map((n) => n.pid);
      rows.push({ header: { kind, id, key, name: L.name(id), pids, toggle: key, late: lateIn(pids), count: pids.length }, depth });
      if (!st.closed.has(key)) emit(ns, at + 1, depth + 1);
    }
  };
  // Rows → Group by something other than the structure: one row per piece of work (what has dates, or nothing under it)
  const grouped = st.groupBy !== 'structure' && !!GROUP_BY[st.groupBy];
  const GROUP_OF = {
    owner: (i) => (i.owner_id ? [i.owner_id, personName(b, i.owner_id) || 'Someone'] : ['', 'No owner']),
    type: (i) => [i.type_id, scope.cfgOf(i)?.typeById.get(i.type_id)?.name || 'Item'],
    status: (i) => [i.category, CATEGORIES.find((c) => c[0] === i.category)?.[1] || i.category],
    subsystem: (i) => {
      const p = b.projectById.get(i.project_id);
      const sub = i.subsystem_id || p?.subsystem_id;
      const div = i.division_id || p?.division_id;
      return sub ? [sub, b.subsystemById.get(sub)?.name || 'Subsystem'] : div ? [div, b.divisionById.get(div)?.name || 'Division'] : ['', 'No subsystem'];
    },
    none: () => ['', ''],
  };
  const groupRows = () => {
    const pids = new Set(project ? [project.id] : inFocus.map((n) => n.pid));
    const groups = new Map();
    for (const i of items) {
      if (!pids.has(i.project_id) || !visible.has(i.id) || (hasKids(i) && !own(i))) continue;
      const [k, name] = GROUP_OF[st.groupBy](i);
      (groups.get(k) || groups.set(k, { name, items: [] }).get(k)).items.push(i);
    }
    const catAt = (k) => CATEGORIES.findIndex((c) => c[0] === k);
    const order = [...groups].sort(([ka, a], [kz, z]) => (!ka) - (!kz) || (st.groupBy === 'status' ? catAt(ka) - catAt(kz) : a.name.localeCompare(z.name)));
    for (const [k, g] of order) {
      if (st.groupBy === 'none') {
        place(g.items, 0, true);
        continue;
      }
      const key = `g:${st.groupBy}:${k || 'none'}`;
      rows.push({ header: { kind: 'group', id: k, key, name: g.name, items: g.items, toggle: key, count: g.items.length,
        late: g.items.filter((i) => i.category !== 'done' && i.due_date && i.due_date < today).length }, depth: 0 });
      if (!st.closed.has(key)) place(g.items, 1, true);
    }
  };
  if (grouped) groupRows();
  else if (project) projectRows(project.id, 0);
  else emit(inFocus, 0, 0);
  /** Every item on a row (a packed row has several). */
  const rowItems = rows.flatMap((r) => (r.item ? [r.item] : r.lane || []));
  const hiddenOutside = hiding ? items.filter((i) => (!shown || shown.has(i.id)) && !visible.has(i.id)).length : 0;
  // where I am: Everything › Electrical › Battery (each one zooms out to it)
  const crumbs = () => {
    if (project || !levelsUsed.some((k) => k !== 'car')) return '';
    const path = [];
    if (focus?.kind === 'car') path.push(['car', focus.id]);
    if (focus?.kind === 'division') path.push(['division', focus.id]);
    if (focus?.kind === 'subsystem') {
      const div = b.subsystemById.get(focus.id)?.division_id;
      if (div) path.push(['division', div]);
      path.push(['subsystem', focus.id]);
    }
    const crumb = (kind, id, last) => (last ? `<span aria-current="location">${esc(LEVEL[kind].name(id))}</span>`
      : `<button type="button" data-focus="${kind}:${esc(id)}">${esc(LEVEL[kind].name(id))}</button>`);
    const mine = b.myOrg?.subsystem_id;
    return `<nav class="pm-g-crumbs" aria-label="Where you are">${path.length ? '<button type="button" data-focus="">Everything</button>' : '<span aria-current="location">Everything</span>'}
      ${path.map(([k, id], n) => ` <span class="pm-g-crumb-sep" aria-hidden="true">›</span> ${crumb(k, id, n === path.length - 1)}`).join('')}
      ${focus?.id !== mine && mine && nodes.some((n) => n.sub === mine) ? ` <button type="button" class="pm-g-crumb-mine" data-focus="subsystem:${esc(mine)}">My subsystem</button>` : ''}</nav>`;
  };
  const LEVELS = [['division', 'Divisions'], ['subsystem', 'Subsystems'], ['project', 'Spaces'], ['work', 'Work']]
    .filter(([k]) => k === 'project' || k === 'work' || levels.includes(k));
  const setLevel = (lv) => {
    const depthOf = { division: 0, subsystem: 1, project: 2, work: 3 }[lv];
    for (const n of nodes) {
      if (n.car) st.closed.delete(groupKey('car', n.car));
      st.closed[depthOf <= 0 ? 'add' : 'delete'](groupKey('division', n.div));
      if (n.sub) st.closed[depthOf <= 1 ? 'add' : 'delete'](groupKey('subsystem', n.sub));
      st.closed[depthOf <= 2 ? 'add' : 'delete'](n.pid);
    }
    st.level = lv;
  };

  // ---- colors: one meaning at a time, with a legend
  const legend = new Map();
  const auto = new Map();
  const toneFor = (k) => auto.get(k) || (auto.set(k, PALETTE[auto.size % PALETTE.length]), auto.get(k));
  const colorOf = (i) => {
    let name;
    let tone;
    if (st.colorBy === 'status') [name, tone] = [CATEGORIES.find((c) => c[0] === i.category)?.[1] || i.category, CAT_TONE[i.category] || 'gray'];
    else if (st.colorBy === 'subsystem') {
      const id = i.subsystem_id || i.division_id;
      [name, tone] = id ? [b.subsystemById.get(i.subsystem_id)?.name || b.divisionById.get(i.division_id)?.name || 'Subsystem', toneFor(`s:${id}`)] : ['No subsystem', 'gray'];
    } else if (st.colorBy === 'owner') [name, tone] = i.owner_id ? [personName(b, i.owner_id) || 'Someone', toneFor(`o:${i.owner_id}`)] : ['No owner', 'gray'];
    else if (st.colorBy === 'priority') [name, tone] = [PRIORITIES.find((p) => p[0] === i.priority)?.[1] || 'No priority', PRI_TONE[i.priority] || 'gray'];
    else {
      const t = scope.cfgOf(i)?.typeById.get(i.type_id);
      [name, tone] = [t?.name || 'Item', TONE[t?.color] ? t.color : toneFor(`t:${i.type_id}`)];
    }
    if (!legend.has(name)) legend.set(name, tone);
    return { name, tone, hex: TONE[tone] || TONE.blue };
  };
  const col = new Map(rowItems.map((i) => [i.id, colorOf(i)]));
  const dim = (i) => (st.only && col.get(i.id)?.name !== st.only ? ' is-dim' : '');

  // ---- the days shown, and how wide a day is
  const workDays = [];   // the work itself (not today, not team dates): what "Fit: everything shown" fits
  for (const i of rowItems) {
    const p = plan.byId.get(i.id);
    const t = target(i);
    workDays.push(...[t.start, t.due, st.plan.forecast && p?.start, st.plan.forecast && p?.finish, baseline?.[i.id]?.start, baseline?.[i.id]?.due].filter(Boolean).map(toDay));
  }
  for (const r of rows) {
    const s = r.header ? spanHeader(r.header) : r.item && r.children ? spanUnder(r.item) : null;
    if (s) workDays.push(toDay(s[0]), toDay(s[1]));
  }
  const days = [tday, ...workDays];
  // team dates near the work (or near today)
  const near = [Math.min(tday, ...workDays) - 30, Math.max(tday, ...workDays) + 60];
  const keysShown = st.show.team ? keyDates.filter((k) => k.kind !== 'season' && toDay(k.end_day || k.day) >= near[0] && toDay(k.day) <= near[1]) : [];
  for (const k of keysShown) days.push(toDay(k.day), toDay(k.end_day || k.day));
  const seasons = keyDates.filter((k) => k.kind === 'season').sort((a, z) => (a.day < z.day ? -1 : 1));
  let first = Math.min(...days) - 7;
  let last = Math.max(...days) + 21;
  const seasonRow = seasons.filter((k) => toDay(k.day) <= Math.max(first + 14, tday)).pop() || seasons[0] || null;
  const season = seasonRow ? toDay(seasonRow.day) : null;
  // Fit: the dates to fill the width with (the chart still reaches everything shown; it scrolls to the start).
  // "Everything shown" is the work itself: today can be months before it (a tag at the edge says where).
  const fitSpan = !st.fit ? null : st.fit === 'all' ? [workDays.length ? Math.min(...workDays) - 7 : first, last]
    : fixedWindow ? [...fixedWindow] : [first, last];
  if (fitSpan) {
    first = Math.min(first, fitSpan[0]);
    last = Math.max(last, fitSpan[1]);
  }
  // start on a week boundary (the season's weekday, else Monday) so week columns line up
  const weekday0 = season ?? (tday - ((new Date(tday * 864e5).getUTCDay() + 6) % 7));
  first -= ((first - weekday0) % 7 + 7) % 7;
  const labelW = Math.max(160, Math.min(520, Number(st.labelW) || 340));   // C5: wider to start with (still draggable)
  // The chart's width. This draws before it's on the page, so it's worked out from the page (and checked once it's there).
  const room = st.room || Math.max(320, (document.getElementById('app')?.clientWidth || el.clientWidth || 900) - labelW - 40);
  if (fitSpan) fitSpan[0] = fitSpan[0] < first ? first : fitSpan[0] - ((fitSpan[0] - weekday0) % 7 + 7) % 7;   // from a week boundary
  const px = fitSpan ? clampPx(room / (fitSpan[1] - fitSpan[0] + 1)) : clampPx(st.px);
  if ((last - first + 1) * px < room) last = first + Math.ceil(room / px) - 1;   // fill the width
  const x = (iso) => (toDay(iso) - first) * px;
  const width = Math.round((last - first + 1) * px);
  const { row: ROW, bar: BAR } = DENSITY[st.density] || DENSITY.comfortable;
  // group headers are thinner than rows of work
  const HROW = Math.round(ROW * 0.78);
  const rowH = (r) => (r.header ? HROW : ROW);
  const tops = [];
  let height = 0;
  for (const r of rows) (tops.push(height), (height += rowH(r)));
  const rowAt = (y) => {
    let lo = 0;
    let hi = rows.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (y < tops[m]) hi = m - 1;
      else if (y >= tops[m] + rowH(rows[m])) lo = m + 1;
      else return m;
    }
    return -1;
  };
  // car cycles: a band behind the chart for each one in view (or this project's), named in the header. One without an
  // end date runs until the next one starts (or the end of the chart).
  const allCycles = cyclesOf(b).filter((g) => g.start_date);
  const cycleEnd = (g) => g.end_date || (allCycles[allCycles.indexOf(g) + 1] ? toISO(toDay(allCycles[allCycles.indexOf(g) + 1].start_date) - 1) : toISO(last));
  const cyclesShown = !st.show.cycles ? [] : (project ? [cycleOfProject(b, project)].filter(Boolean)
    : cyclesInView(b) ? allCycles.filter((g) => cyclesInView(b).includes(g.id)) : allCycles)
    .filter((g) => g.start_date).map((g) => ({ ...g, end_date: cycleEnd(g) }))
    .filter((g) => toDay(g.end_date) >= first && toDay(g.start_date) <= last)
    .map((g) => ({ ...g, start_date: toISO(Math.max(first, toDay(g.start_date))), end_date: toISO(Math.min(last, toDay(g.end_date))), starts: toDay(g.start_date) >= first }));
  // V4: the project's phases (Settings → Details), shaded behind the chart and named in the header
  const phasesShown = (settings.phases || []).filter((ph) => ph.start && ph.end && toDay(ph.end) >= first && toDay(ph.start) <= last)
    .map((ph) => ({ ...ph, s: Math.max(first, toDay(ph.start)), e: Math.min(last, toDay(ph.end)), c: TONE[ph.tone] || TONE.blue }));
  const cal = makeCalendar(settings);
  const snap = px >= 10 ? 1 : 7;   // dragging moves by days when they're wide enough, else by weeks

  // ---- header: months over season weeks (or dates), with team dates
  const weekStarts = [];
  for (let d = first; d <= last; d += 7) weekStarts.push(d);
  const monthStarts = [];
  for (let d = first; d <= last; d++) if (new Date(d * 864e5).getUTCDate() === 1 || d === first) monthStarts.push(d);
  const tier = px >= 20 ? 'day' : 7 * px >= 18 ? 'week' : 'month';
  const yearStarts = monthStarts.filter((d) => d === first || new Date(d * 864e5).getUTCMonth() === 0);
  /** A month's name for the room it has: "November 2026", "Nov 2026", "November", "Nov", "N" or nothing. */
  const monthName = (d, w, withYear) => {
    const date = new Date(d * 864e5);
    const year = withYear && w >= 64;
    if (w < 12) return '';
    if (w < 28) return date.toLocaleDateString('en-US', { month: 'narrow', timeZone: 'UTC' });
    return date.toLocaleDateString('en-US', { month: w >= (year ? 112 : 86) ? 'long' : 'short', year: year ? 'numeric' : undefined, timeZone: 'UTC' });
  };
  const weekLabel = (d) => (season !== null ? (d >= season ? String(Math.floor((d - season) / 7) + 1).padStart(2, '0') : '') : String(new Date(d * 864e5).getUTCDate()));
  const head = () => {
    const cell = (cls, d, end, text, title = '') => `<span class="${cls}" style="left:${(d - first) * px}px;width:${(end - d) * px}px"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
    let months;
    let weeks;
    if (tier === 'month') {
      // far out: years on top, months below
      months = yearStarts.map((d, n) => cell('pm-g-month', d, yearStarts[n + 1] ?? last + 1, (yearStarts[n + 1] ?? last + 1) - d >= 6 / px ? String(new Date(d * 864e5).getUTCFullYear()) : '')).join('');
      weeks = monthStarts.map((d, n) => cell('pm-g-wk', d, monthStarts[n + 1] ?? last + 1, monthName(d, ((monthStarts[n + 1] ?? last + 1) - d) * px, false),
        new Date(d * 864e5).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }))).join('');
    } else {
      months = monthStarts.map((d, n) => {
        const end = monthStarts[n + 1] ?? last + 1;
        return cell('pm-g-month', d, end, monthName(d, (end - d) * px, n === 0 || new Date(d * 864e5).getUTCMonth() === 0));
      }).join('');
      weeks = tier === 'week' ? weekStarts.map((d) => `<span class="pm-g-wk" style="left:${(d - first) * px}px;width:${7 * px}px">${weekLabel(d)}</span>`).join('')
        : Array.from({ length: last - first + 1 }, (_, n) => {
          const date = new Date((first + n) * 864e5);
          return `<span class="pm-g-wk is-day${date.getUTCDay() === 0 || date.getUTCDay() === 6 ? ' is-weekend' : ''}" style="left:${n * px}px;width:${px}px" title="${esc(date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }))}">${date.getUTCDate()}</span>`;
        }).join('');
    }
    const keys = keysShown.map((k) => `<span class="pm-g-keyhead is-${esc(k.kind)}" style="left:${x(k.day)}px" title="${esc(`${k.name}: ${fmtDate(k.day)}${k.end_day && k.end_day !== k.day ? ` – ${fmtDate(k.end_day)}` : ''}${k.note ? ` · ${k.note}` : ''}`)}">${esc(k.name)}</span>`).join('')
      + phasesShown.map((ph) => `<span class="pm-g-keyhead is-phase" data-stick="${(ph.s - first) * px},${(ph.e - first + 1) * px}" style="--c:${ph.c};left:${(ph.s - first) * px}px" title="${esc(`${ph.name}: ${fmtDate(ph.start)} – ${fmtDate(ph.end)}`)}">${esc(ph.name)}</span>`).join('')
      + cyclesShown.map((g) => `<span class="pm-g-keyhead is-cycle" data-stick="${x(g.start_date)},${x(g.end_date) + px}" style="left:${x(g.start_date)}px" title="${esc(`${g.name}: ${fmtDate(g.start_date)} – ${fmtDate(g.end_date)}`)}">${esc(g.name)}</span>`).join('');
    return `<div class="pm-g-head" style="width:${width}px">${months}${weeks}${keys}</div>`;
  };
  const gridLines = () => (7 * px >= 10 ? weekStarts.map((d) => `<div class="pm-g-vl" style="left:${(d - first) * px}px"></div>`).join('') : '')
    + monthStarts.slice(1).map((d) => `<div class="pm-g-vl is-month${new Date(d * 864e5).getUTCMonth() === 0 ? ' is-year' : ''}" style="left:${(d - first) * px}px"></div>`).join('')
    + (px >= 10 ? Array.from({ length: last - first + 1 }, (_, n) => (cal.isWork(first + n) ? '' : `<div class="pm-g-off" style="left:${n * px}px;width:${px}px"></div>`)).join('') : '');

  // ---- bars
  const rowIndex = new Map();
  rows.forEach((r, n) => (r.item ? [r.item] : r.lane || []).forEach((i) => rowIndex.set(i.id, n)));
  const shortDate = (iso) => new Date(toDay(iso) * 864e5).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const shortRange = (a, z) => (a === z ? shortDate(a) : `${shortDate(a)} – ${shortDate(z)}`);
  /** What a bar's label says (Show → Labels on bars → says). */
  const barWords = (i, a, z) => ({ name: i.title, dates: shortRange(a, z), both: `${i.title} · ${shortRange(a, z)}`,
    owner: i.owner_id ? personName(b, i.owner_id) || 'Someone' : 'No owner', progress: `${i.category === 'done' ? 100 : Number(i.progress) || 0}%` })[st.barText] || i.title;
  const span = (i) => {
    const t = target(i);
    const p = plan.byId.get(i.id);
    return { start: t.start || t.due || p?.start, end: t.due || t.start || p?.finish, p, t };
  };
  /**
   * A label beside a bar, milestone or summary (in its own row): to its right, or to its left when it would run off
   * the chart. `room` caps it (a packed row: up to the next bar); with too little room there's no label (the tooltip has it).
   */
  const outLabel = (text, top, right, left, { h = ROW, cls = '', room = Infinity } = {}) => {
    const w = text.length * 6.6 + 8;
    const flip = room === Infinity && right + w > width && left - w >= 0;
    if (room < 36) return '';
    return `<span class="pm-g-barlabel is-out${cls}${flip ? ' is-left' : ''}" style="top:${top}px;height:${h}px;line-height:${h}px;left:${flip ? left : right}px${room < w ? `;max-width:${Math.floor(room)}px` : ''}">${esc(text)}</span>`;
  };
  /** A summary bar (a group, or what's under an item): its span, how far along it is, and late work in red; dates beside it. */
  const summary = (s, top, title, info, side = null) => {
    if (!s) return '';
    const [l, w] = [x(s[0]), (toDay(s[1]) - toDay(s[0]) + 1) * px];
    const words = `${shortRange(s[0], s[1])}${info ? ` · ${info.pct}% done` : ''}${info?.late ? ` · ${info.late} late` : ''}`;
    return `<div class="pm-g-sum${info?.late ? ' is-late' : ''}" style="top:${top}px;left:${l}px;width:${w}px" title="${esc(`${title}: ${rangeText(s[0], s[1])}${info ? ` · ${info.pct}% done` : ''}${info?.late ? ` · ${info.late} late` : ''}`)}">${info && st.show.progress && info.pct ? `<span class="pm-g-sum-fill" style="width:${info.pct}%"></span>` : ''}</div>`
      + (side && st.show.sums ? outLabel(words, side.top, l + w + 8, l - 8, { h: side.h, cls: ' is-sum' }) : '');
  };
  const bar = (r, n) => {
    const top = tops[n];
    const h = rowH(r);
    if (r.header) {
      return `<div class="pm-g-row is-group is-${r.header.kind}" data-ri="${n}" style="top:${top}px;height:${h}px;width:${width}px"></div>`
        + summary(spanHeader(r.header), top + h / 2 - 3, r.header.name, headerInfo(r.header), { top, h });
    }
    if (r.lane) {
      // a packed row: each bar's label stops where the next bar starts
      const sorted = [...r.lane].sort((a, z) => toDay(own(a)[0]) - toDay(own(z)[0]));
      return `<div class="pm-g-row is-lane" data-ri="${n}" style="top:${top}px;height:${h}px;width:${width}px"></div>`
        + sorted.map((i, k) => marks(i, top, sorted[k + 1] ? x(own(sorted[k + 1])[0]) : Infinity, true)).join('');
    }
    const i = r.item;
    const { t } = span(i);
    const drag = can(b, i.project_id, 'plan') && i.category !== 'done';
    const draw = drag && !t.start && !t.due && !i.is_milestone;
    let out = `<div class="pm-g-row${r.children ? ' is-group' : ''}${draw ? ' is-drawable' : ''}${dim(i)}" data-ri="${n}" ${draw ? `data-draw="${esc(i.id)}" title="Drag across this row to give ${esc(i.key)} its dates"` : ''} style="top:${top}px;height:${h}px;width:${width}px"></div>`;
    const hasOwn = !!(t.start || t.due);
    if (r.children) {
      const u = spanUnder(i);
      const info = infoOf((kids.get(i.id) || []).flatMap(leavesOf));
      // its own bar shows the span already: a bracket under it only when the work under it runs outside it
      if (!hasOwn) out += summary(u, top + ROW / 2 - 3, `Everything under ${i.key}`, info, { top, h: ROW });
      else if (u && (u[0] < (t.start || t.due) || u[1] > (t.due || t.start))) out += summary(u, top + ROW - 6, `Everything under ${i.key}`, info);
    }
    return out + marks(i, top, Infinity, false, r.children > 0);
  };
  /** An item's bar (or milestone), and what goes with it: baseline, links to other projects, forecast, label. */
  const marks = (i, top, until, packed, parent = false) => {
    const { p, t } = span(i);
    const c = col.get(i.id);
    const drag = can(b, i.project_id, 'plan') && i.category !== 'done';
    const y = top + (ROW - BAR) / 2;
    let out = '';
    const labels = st.show.labels || packed;   // a packed row's bars always say what they are
    const bl = baseline?.[i.id];
    if (bl && (bl.start || bl.due)) out += `<div class="pm-g-baseline" style="top:${top + ROW - 5}px;left:${x(bl.start || bl.due)}px;width:${(toDay(bl.due || bl.start) - toDay(bl.start || bl.due) + 1) * px}px" title="Baseline: ${esc(rangeText(bl.start || bl.due, bl.due || bl.start))}"></div>`;
    // dependencies on items in other projects: a tag where the other item ends (it waits on) or starts (waiting on this)
    if (st.show.deps) {
      for (const d of deps) {
        const inbound = d.to_item === i.id && outsideById.has(d.from_item);
        const outbound = d.from_item === i.id && outsideById.has(d.to_item);
        if (!inbound && !outbound) continue;
        const o = outsideById.get(inbound ? d.from_item : d.to_item);
        const at = inbound ? (o.due_date || plan.byId.get(o.id)?.finish || o.start_date) : (o.start_date || o.due_date);
        if (!at) continue;
        const proj = b.projectById.get(o.project_id);
        const tip = `${inbound ? 'Waits on' : 'Waiting on this:'} ${o.key} ${o.title}${proj ? ` (${proj.name})` : ''}\n${inbound ? 'Finishes' : 'Starts'} ${fmtDate(at)} · ${DEP_KINDS[d.kind]}`;
        out += `<a class="pm-g-ext${inbound ? '' : ' is-out'}${inbound && o.category !== 'done' ? '' : ' is-done'}" href="${itemHref(o.key)}" style="top:${top + ROW / 2 - 8}px;left:${inbound ? x(at) + px - 2 : x(at) - 2}px" title="${esc(tip)}">${inbound ? `${esc(o.key)} ▸` : `◂ ${esc(o.key)}`}</a>`;
      }
    }
    const crit = st.plan.critical && p?.critical ? ' is-critical' : '';
    const overdue = i.category !== 'done' && t.due && t.due < today;
    const waits = deps.filter((d) => d.to_item === i.id).map((d) => (byId.get(d.from_item) || outsideById.get(d.from_item))?.key).filter(Boolean);
    const facts = [CATEGORIES.find((q) => q[0] === i.category)?.[1], i.owner_id && personName(b, i.owner_id), Number(i.progress) && i.category !== 'done' ? `${Number(i.progress)}% done` : ''].filter(Boolean).join(' · ');
    const tip = `${i.key} ${i.title}\n${t.start || t.due ? rangeText(t.start || t.due, t.due || t.start) : 'No dates yet'}${facts ? `\n${facts}` : ''}${overdue ? `\nOverdue by ${tday - toDay(t.due)} day${tday - toDay(t.due) === 1 ? '' : 's'}` : ''}${waits.length ? `\nWaits on ${waits.join(', ')}` : ''}${c ? `\n${c.name}` : ''}${st.plan.forecast && p ? `\nForecast: ${fmtDate(p.start)} – ${fmtDate(p.finish)}${p.slack === null ? '' : ` · slack ${p.slack} working day${p.slack === 1 ? '' : 's'}`}` : ''}${drag ? '\nDrag to move · click to edit' : ''}`;
    const common = `data-bar="${esc(i.id)}" ${drag ? 'data-drag' : ''} tabindex="0" role="button" aria-label="${esc(`${i.key} ${i.title}, ${t.start || t.due ? rangeText(t.start || t.due, t.due || t.start) : 'no dates'}`)}" title="${esc(tip)}"`;
    const link = st.show.deps && drag ? `<span class="pm-g-link" data-link-from="${esc(i.id)}" title="Drag onto another bar: it then waits on ${esc(i.key)}"></span>` : '';
    if (i.is_milestone) {
      const at = t.due || t.start || p?.finish;
      const right = at ? x(at) + px / 2 + BAR / 2 + 6 : 0;
      if (at) out += `<div class="pm-g-ms is-${esc(i.category)}${crit}${dim(i)}${overdue ? ' is-overdue' : ''}${st.overrides[i.id] ? ' is-trying' : ''}" ${common} style="top:${top + (ROW - BAR) / 2}px;left:${x(at) + px / 2 - BAR / 2}px;width:${BAR}px;height:${BAR}px;--c:${c.hex}"></div>`
        + (labels ? outLabel(barWords(i, at, at), top, right, x(at) + px / 2 - BAR / 2 - 6, { room: until - right - 4 }) : '');
    } else if (t.start || t.due) {
      const a = t.start || t.due;
      const z = t.due || t.start;
      const w = (toDay(z) - toDay(a) + 1) * px;
      const words = barWords(i, a, z);
      const fits = words.length * 6.6 + 16 < w;
      const right = x(z) + px + 6;
      out += `<div class="pm-g-bar is-${esc(i.category)}${crit}${dim(i)}${parent ? ' is-parent' : ''}${overdue ? ' is-overdue' : ''}${st.overrides[i.id] ? ' is-trying' : ''}${t.start && t.due ? '' : ' is-open'}" ${common} style="top:${y}px;left:${x(a)}px;width:${w}px;height:${BAR}px;--c:${c.hex}">
        ${st.show.progress && Number(i.progress) ? `<span class="pm-g-fill" style="width:${Number(i.progress)}%"></span>` : ''}
        ${labels && fits ? `<span class="pm-g-barlabel">${esc(words)}</span>` : ''}
        ${drag ? '<span class="pm-g-h pm-g-h-l"></span><span class="pm-g-h pm-g-h-r"></span>' : ''}${link}</div>`
        + (labels && !fits ? outLabel(words, top, right, x(a) - 6, { room: until - right - 4 }) : '');
    }
    // the forecast, where it differs from the target (or there is no target)
    if (st.plan.forecast && p && i.category !== 'done' && !i.is_milestone && (p.start !== t.start || p.finish !== t.due)) {
      out += `<div class="pm-g-forecast${p.late ? ' is-late' : ''}" style="top:${y - 3}px;height:${BAR + 6}px;left:${x(p.start)}px;width:${(toDay(p.finish) - toDay(p.start) + 1) * px}px" title="${esc(tip)}"></div>`;
    }
    if (st.plan.forecast && p?.late) out += `<span class="pm-g-late" style="top:${top + ROW / 2 - 8}px;left:${x(p.finish) + px + 4}px" title="${esc(p.warnings.map((w) => w.text).join('\n'))}">⚠ ${p.late}d</span>`;
    return out;
  };
  const arrows = () => {
    if (!st.show.deps && !st.plan.critical) return '';
    let out = '';
    for (const d of deps) {
      const [a, z] = [rowIndex.get(d.from_item), rowIndex.get(d.to_item)];
      if (a === undefined || z === undefined) continue;
      const [sa, sz] = [span(byId.get(d.from_item)), span(byId.get(d.to_item))];
      if (!sa.start || !sz.start) continue;
      const x1 = ['SS', 'SF'].includes(d.kind) ? x(sa.start) : x(sa.end) + px;
      const x2 = ['FF', 'SF'].includes(d.kind) ? x(sz.end) + px : x(sz.start);
      const [y1, y2] = [tops[a] + ROW / 2, tops[z] + ROW / 2];
      const out1 = ['SS', 'SF'].includes(d.kind) ? x1 - 8 : x1 + 8;
      const in2 = ['FF', 'SF'].includes(d.kind) ? x2 + 8 : x2 - 8;
      const crit = st.plan.critical && plan.byId.get(d.from_item)?.critical && plan.byId.get(d.to_item)?.critical;
      // finish → start that overlaps (minus any lag): the arrow turns red
      const broken = d.kind === 'FS' && toDay(sz.start) <= toDay(sa.end) + Math.min(0, d.lag_days || 0);
      const path = `M${x1} ${y1} H${out1} V${y1 + (y2 > y1 ? ROW / 2 : -ROW / 2)} H${in2} V${y2} H${x2}`;
      const what = `${byId.get(d.from_item).key} → ${byId.get(d.to_item).key}: ${DEP_KINDS[d.kind]}${d.lag_days ? `, ${d.lag_days > 0 ? '+' : ''}${d.lag_days} working days` : ''}${broken ? ' (overlaps)' : ''}`;
      out += `<path class="pm-g-arrow${crit ? ' is-critical' : ''}${broken ? ' is-broken' : ''}" d="${path}" marker-end="url(#pm-g-tip${crit || broken ? '-c' : ''})"></path>
        <path class="pm-g-arrow-hit" d="${path}" data-dep="${esc(d.id)}" data-what="${esc(what)}"><title>${esc(what)}. Click to remove.</title></path>`;
    }
    return out;
  };

  // ---- labels
  const indentTarget = (i) => {
    const sib = kids.get(parentKey(i)) || [];
    const prev = sib[sib.indexOf(i) - 1];
    return prev && kindsUnder(scope.cfgOf(i), prev).some((t) => t.id === i.type_id) ? prev : null;
  };
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
  const slipped = baseline ? items.map((i) => ({ i, s: slipOf(i) })).filter((v) => v.s).sort((a, z) => z.s - a.s) : [];
  const divTone = (id) => TONE[PALETTE[Math.max(0, divOrder.findIndex((d) => d.id === id)) % PALETTE.length]];
  // W8: Show → Status: an item's status, or for one with items under it, how much of that is done
  const statusCell = (i, r) => {
    if (r.children) {
      const inf = infoOf((kids.get(i.id) || []).flatMap(leavesOf));
      return inf ? `<span class="pm-g-stat" title="${inf.pct}% of what's under it is done"><i style="width:${inf.pct}%"></i></span>` : '';
    }
    const s = scope.cfgOf(i)?.statusById.get(i.status_id);
    return s ? `<span class="chip-tone tone-${esc(s.color)} pm-g-status">${esc(s.name)}</span>` : '';
  };
  const label = (r, n) => {
    if (r.lane) {
      return `<div class="pm-g-label is-lane" data-ri="${n}" style="height:${ROW}px;padding-left:${6 + r.depth * 18}px"><span class="pm-g-grip is-empty"></span><span class="pm-g-toggle"></span>
        <span class="pm-g-name pm-g-lane">${r.lane.map((i) => `<button type="button" class="pm-g-lane-item${dim(i)}" data-details="${esc(i.id)}" title="${esc(`${i.key} ${i.title}`)}"><span class="pm-g-dot${i.is_milestone ? ' is-ms' : ''}" style="--c:${col.get(i.id).hex}"></span>${esc(i.title)}</button>`).join('')}</span>
        <span class="pm-g-label-end"><span class="muted small" title="These don't overlap in time, so they share a row (Rows → Pack rows)">${r.lane.length} in a row</span></span></div>`;
    }
    if (r.header) {
      const h = r.header;
      const pid = h.id;
      const open = !st.closed.has(h.toggle);
      const toggle = `<button type="button" class="pm-g-toggle" data-toggle="${esc(h.toggle)}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} ${esc(h.name)}">${open ? '▾' : '▸'}</button>`;
      const late = h.late ? `<span class="pm-g-chip is-warn" title="Items in ${esc(h.name)} past their due date">${h.late} late</span>` : '';
      if (h.kind === 'group') {
        return `<div class="pm-g-label is-group is-header is-level is-group-by" data-ri="${n}" style="height:${HROW}px;padding-left:${6 + r.depth * 18}px">${toggle}
          <span class="pm-g-title">${esc(h.name)}</span>
          <span class="pm-g-label-end">${late}<span class="muted small">${h.count} item${h.count === 1 ? '' : 's'}</span></span></div>`;
      }
      if (h.kind !== 'project') {
        return `<div class="pm-g-label is-group is-header is-level is-${h.kind}" data-ri="${n}" style="height:${HROW}px;padding-left:${6 + r.depth * 18}px${h.kind === 'division' ? `;--dc:${divTone(h.id)}` : ''}">${toggle}
          <button type="button" class="pm-g-title pm-g-level" data-focus="${h.kind}:${esc(h.id)}" title="Show only ${esc(h.name)}">${esc(h.name)}</button>
          <span class="pm-g-label-end">${late}<span class="muted small">${h.count} space${h.count === 1 ? '' : 's'}</span></span></div>`;
      }
      return `<div class="pm-g-label is-group is-header" data-ri="${n}" style="height:${HROW}px;padding-left:${6 + r.depth * 18}px">
        ${toggle}
        <a class="pm-g-title" href="${projectHref(h.key, 'timeline')}">${esc(h.name)}</a>${st.closed.has(pid) ? late : ''}
        <span class="pm-g-label-end">${can(b, pid, 'create') ? `<button type="button" class="pm-g-more" data-add-root="${esc(pid)}" title="Add to ${esc(r.header.name)}" aria-label="Add to ${esc(r.header.name)}">+</button>` : ''}</span></div>`;
    }
    const i = r.item;
    const c = col.get(i.id);
    const mayEdit = can(b, i.project_id, 'edit');
    return `<div class="pm-g-label${r.children ? ' is-group' : ''}${plan.byId.get(i.id)?.critical && st.plan.critical ? ' is-critical' : ''}${dim(i)}${st.selected === i.id ? ' is-selected' : ''}" data-row="${esc(i.id)}" data-ri="${n}" style="height:${ROW}px;padding-left:${6 + r.depth * 18}px">
      ${mayEdit && i.category !== 'done' ? `<span class="pm-g-grip" data-grip="${esc(i.id)}" title="Drag onto another row: the middle puts it under that row, the top or bottom edge before or after it" aria-hidden="true">⋮⋮</span>` : '<span class="pm-g-grip is-empty"></span>'}
      ${pickBox(i)}${r.children ? `<button type="button" class="pm-g-toggle" data-toggle="${esc(i.id)}" aria-expanded="${!st.closed.has(i.id)}" aria-label="${st.closed.has(i.id) ? 'Show' : 'Hide'} what's under ${esc(i.key)}">${st.closed.has(i.id) ? '▸' : '▾'}</button>` : '<span class="pm-g-toggle"></span>'}
      <span class="pm-g-dot${i.is_milestone ? ' is-ms' : ''}" style="--c:${c.hex}" title="${esc(c.name)}"></span>
      <span class="pm-g-name">${r.prefix ? `<a class="pm-g-prefix" href="${projectHref(r.prefix.key, 'timeline')}" title="${esc(r.prefix.name)}: its only item is ${esc(i.title)}">${esc(r.prefix.name)}</a><span class="pm-g-crumb-sep" aria-hidden="true">›</span>` : ''}${st.show.keys ? `<a class="pm-g-key" href="${itemHref(i.key)}">${esc(i.key)}</a>` : ''}<span class="pm-g-title${i.category === 'done' ? ' is-done' : ''}" ${mayEdit ? `data-rename="${esc(i.id)}" title="${esc(i.key)} ${esc(i.title)}${undated(i) ? ' (no dates yet: drag across its row)' : ''} (double-click to rename)"` : `title="${esc(i.key)} ${esc(i.title)}"`}>${esc(i.title)}</span></span>
      ${slipChip(i)}${(ordersFor.get(i.id) || []).length ? `<span class="pm-g-chip is-warn" title="${esc(ordersFor.get(i.id).map((w) => `${w.number} is ${w.status}, not ordered yet`).join('\n'))}">order ⚠</span>` : ''}
      <span class="pm-g-label-end">${st.show.status ? statusCell(i, r) : ''}${st.show.owners ? avatar(b, i.owner_id) : ''}<button type="button" class="pm-g-more" data-menu="${esc(i.id)}" aria-label="More for ${esc(i.key)}" title="More">⋯</button></span></div>`;
  };

  // ---- the toolbar and its menus
  const filterCount = (filter ? 1 : 0) + (st.f.q ? 1 : 0) + (st.undated ? 1 : 0);
  const pop = (name, labelHtml, body) => `<details class="pm-pop" data-pop="${name}" ${st.pop === name ? 'open' : ''}><summary class="btn btn-sm">${labelHtml}</summary><div class="pm-pop-body">${body}</div></details>`;
  const check = (attr, k, label, on, hint = '') => `<label class="pm-pop-check" ${hint ? `title="${esc(hint)}"` : ''}><input type="checkbox" ${attr}="${k}" ${on ? 'checked' : ''}> ${esc(label)}</label>`;
  const pick = (attr, map, v, label) => `<div class="pm-pop-row"><span>${esc(label)}</span><select ${attr} aria-label="${esc(label)}">${Object.entries(map).map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
  const showMenu = pop('show', 'Show ▾', `${pick('data-color-by', COLOR_BY, st.colorBy, 'Color by')}
    ${Object.entries(SHOW).map(([k, l]) => check('data-show', k, l, st.show[k])).join('')}
    ${pick('data-bar-text', BAR_TEXT, st.barText, 'Labels say')}
    <div class="pm-pop-row"><span>Rows</span><select data-density aria-label="Row size"><option value="comfortable" ${st.density === 'comfortable' ? 'selected' : ''}>Comfortable</option><option value="compact" ${st.density === 'compact' ? 'selected' : ''}>Compact</option></select></div>`);
  const rowsMenu = pop('rows', `Rows${grouped || st.sortBy !== 'rank' || st.pack || hiding ? ' •' : ''} ▾`, `<p class="pm-pop-note">How the rows are arranged, top to bottom.</p>
    ${pick('data-group-by', GROUP_BY, st.groupBy, 'Group by')}
    ${pick('data-sort-by', SORT_BY, st.sortBy, 'Order')}
    ${check('data-row-opt', 'pack', 'Pack rows', st.pack, 'Things side by side in time share a row, so the chart is shorter')}
    ${!project && !grouped ? check('data-row-opt', 'merge', 'One row for a space with one item', st.merge, '"Battery Pack › Cell Selection" on one row instead of two') : ''}
    <label class="pm-pop-check" title="${fixedWindow ? 'Only rows with something between the dates in Fit' : 'Pick dates under Fit first (e.g. Next 3 months)'}"><input type="checkbox" data-row-opt="hideOutside" ${st.hideOutside ? 'checked' : ''} ${fixedWindow ? '' : 'disabled'}> Hide rows outside the fitted dates</label>`);
  const planMenu = pop('plan', `Plan${trying || st.plan.forecast || st.plan.critical || st.plan.baseline || st.plan.whatIf ? ' •' : ''} ▾`, `
    ${check('data-plan', 'forecast', 'Forecast', st.plan.forecast, 'Dashed outlines: where the scheduling engine expects each item to really fall, from dependencies, working days and what has happened')}
    ${check('data-plan', 'critical', 'Critical path', st.plan.critical, 'Red: the chain of items with no slack, which decides the finish date')}
    ${mayPlanAny ? check('data-plan', 'whatIf', 'What-if mode', st.plan.whatIf, 'Moving bars only tries the change out and shows what else moves; "Apply" saves it') : ''}
    ${project ? `<div class="pm-pop-row"><span>Baseline</span><select data-baseline aria-label="Baseline"><option value="">None</option>${baselines.map((v) => `<option value="${esc(v.id)}" ${st.plan.baseline === v.id ? 'selected' : ''}>${esc(v.name)} (${esc(fmtDate(v.created_at))})</option>`).join('')}</select></div>` : ''}
    ${project && can(b, project.id, 'plan') ? `<button type="button" class="btn btn-sm" data-save-baseline>Save a baseline</button>
      ${scenarios.length ? `<div class="pm-pop-row"><span>What-ifs</span><select data-scenario aria-label="Saved what-ifs"><option value="">Saved what-ifs…</option>${scenarios.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}${s.applied_at ? ' (applied)' : ''}</option>`).join('')}</select></div>` : ''}
      <button type="button" class="btn btn-sm" data-to-forecast title="Try out moving every unfinished item's dates to where the forecast says they'll really be">Reschedule to forecast…</button>` : ''}
    ${auth.can('projects.manage') ? '<button type="button" class="btn btn-sm" data-key-dates>Team dates…</button>' : ''}`);
  const zoomName = st.fit ? '' : ZOOMS.find(([, , p]) => Math.abs(Math.log(px / p)) < 0.15)?.[0] || '';
  const ZOOM_TIPS = { day: 'Each day', week: 'Week by week', month: 'Month by month', quarter: 'About a season on the screen', year: 'A year or more on the screen' };
  const fitWords = !st.fit ? '' : typeof st.fit === 'object' ? `${fmtDate(st.fit.from)} – ${fmtDate(st.fit.to)}` : FITS[st.fit];
  const fitMenu = pop('fit', st.fit ? `Fit: ${esc(fitWords)} ▾` : 'Fit ▾', `<p class="pm-pop-note">Fit a span of dates to the width of the screen.</p>
    ${Object.entries(FITS).filter(([k]) => k !== 'cycle' || cycleSpan()).map(([k, l]) => `<button type="button" class="pm-pop-item${st.fit === k ? ' is-on' : ''}" data-fit="${k}">${esc(l)}${k === 'cycle' ? ` <span class="muted small">${esc(rangeText(toISO(cycleSpan()[0]), toISO(cycleSpan()[1])).split(' · ')[0])}</span>` : ''}</button>`).join('')}
    <div class="pm-pop-row pm-fit-range"><input type="date" data-fit-from aria-label="From" value="${esc(typeof st.fit === 'object' && st.fit ? st.fit.from : toISO(tday))}">
      <span>to</span><input type="date" data-fit-to aria-label="To" value="${esc(typeof st.fit === 'object' && st.fit ? st.fit.to : toISO(tday + 120))}">
      <button type="button" class="btn btn-sm" data-fit-custom>Show</button></div>
    ${st.fit ? '<button type="button" class="pm-pop-item" data-fit="">Stop fitting (keep this zoom)</button>' : ''}`);
  const toolbar = `<div class="pm-g-toolbar">
      <div class="pm-g-zoom" role="group" aria-label="Zoom">
        <button type="button" class="btn btn-sm" data-zoom-step="-1" title="Zoom out (Ctrl + scroll, a pinch, or the − key)" aria-label="Zoom out" ${px <= PX_MIN ? 'disabled' : ''}>−</button>
        <select data-zoom-pick aria-label="Zoom" title="Zoom (Ctrl + scroll or a pinch works too)">${zoomName ? '' : `<option value="" selected>${st.fit ? 'Fitted' : 'Custom'}</option>`}${ZOOMS.map(([k, l, p]) => `<option value="${p}" ${zoomName === k ? 'selected' : ''} title="${esc(ZOOM_TIPS[k])}">${l}</option>`).join('')}</select>
        <button type="button" class="btn btn-sm" data-zoom-step="1" title="Zoom in (Ctrl + scroll, a pinch, or the + key)" aria-label="Zoom in" ${px >= PX_MAX ? 'disabled' : ''}>+</button>
      </div>
      <span class="pm-g-when"><button type="button" class="btn btn-sm" data-today>Today</button>${fitMenu}</span>
      ${!project && nodes.length && !grouped ? `<div class="pm-seg" role="group" aria-label="Level">${LEVELS.map(([k, l]) => `<button type="button" data-level="${k}" class="${st.level === k ? 'is-on' : ''}" aria-pressed="${st.level === k}" title="Fold the rows down to ${l.toLowerCase()}">${l}</button>`).join('')}</div>` : ''}
      ${rowsMenu}
      ${showMenu}
      <button type="button" class="btn btn-sm${st.filters || filterCount ? ' is-on' : ''}" data-filters aria-expanded="${st.filters}">Filter${filterCount ? ` · ${filterCount}` : ''}</button>
      ${planMenu}
      <span class="pm-g-spacer"></span>
      ${rows.length ? pop('more', '⋯', '<button type="button" class="pm-pop-item" data-present>Present (full screen, PNG, print)</button>') : ''}
      ${project && can(b, project.id, 'create') ? `<button type="button" class="btn btn-sm btn-primary" data-add-root="${esc(project.id)}">+ Add</button>` : ''}
      ${!project && canCreateProjects() ? '<button type="button" class="btn btn-sm btn-primary" data-new-project>+ New space</button>' : ''}</div>
    ${st.filters ? `<div class="pm-g-filters">${filterBar(b, st.f, { types: scope.types })}
      <label class="pm-check" title="Only items without a start or due date (and what they're under)"><input type="checkbox" data-opt="undated" ${st.undated ? 'checked' : ''}> Only undated${undatedCount ? ` (${undatedCount})` : ''}</label></div>` : ''}`;

  // what a what-if changes downstream
  const moved = trying ? [...plan.byId].filter(([id, p]) => base.byId.get(id) && base.byId.get(id).finish !== p.finish && !st.overrides[id] && byId.has(id))
    .map(([id, p]) => ({ item: byId.get(id), from: base.byId.get(id).finish, to: p.finish })) : [];
  const warnings = st.plan.forecast || st.plan.critical ? plan.warnings.filter((w) => byId.has(w.id)) : [];
  const legendHtml = [...legend].map(([name, tone]) => `<button type="button" class="pm-g-leg${st.only === name ? ' is-on' : ''}${st.only && st.only !== name ? ' is-off' : ''}" data-legend="${esc(name)}" title="${st.only === name ? 'Show everything' : `Highlight ${esc(name)}`}"><span class="pm-g-dot" style="--c:${TONE[tone]}"></span>${esc(name)}</button>`).join('');
  const seasonNote = season !== null ? `Weeks count from ${esc(seasonRow.name)} (${esc(fmtDate(seasonRow.day))})` : auth.can('projects.manage') ? 'Add a "Season start" team date (Plan → Team dates) to number the weeks' : '';

  const again = () => (persist(), scope.rerender());
  if (st.present) return renderPresent();

  el.innerHTML = `${toolbar}
    ${trying ? `<div class="alert alert-info pm-whatif" role="status"><strong>What-if: ${Object.keys(st.overrides).length} date change${Object.keys(st.overrides).length === 1 ? '' : 's'} tried out. Nothing is saved yet.</strong>
        <div>Forecast finish: ${esc(fmtDate(base.finish))} → <strong>${esc(fmtDate(plan.finish))}</strong>${plan.finish === base.finish ? ' (no change)' : ''}. Warnings: ${base.warnings.length} → <strong>${plan.warnings.length}</strong>.
          ${moved.length ? `Also moves ${moved.length} other item${moved.length === 1 ? '' : 's'}: ${moved.slice(0, 6).map((m) => `${esc(m.item.key)} (${esc(fmtDate(m.from))} → ${esc(fmtDate(m.to))})`).join(', ')}${moved.length > 6 ? '…' : ''}.` : 'No other item\'s forecast moves.'}</div>
        <div class="card-actions"><button type="button" class="btn btn-sm btn-primary" data-apply>Apply to the plan</button>${project ? '<button type="button" class="btn btn-sm" data-save-scenario>Keep as a what-if</button>' : ''}<button type="button" class="btn btn-sm btn-ghost" data-discard>Discard</button></div></div>` : ''}
    ${crumbs()}
    ${total > all.length ? `<p class="alert alert-info">Showing the first ${all.length} of ${total} items.</p>` : ''}
    ${plan.loop.length ? `<p class="alert alert-error">Some items depend on each other in a loop, so they can't be scheduled: ${plan.loop.map((id) => esc(byId.get(id)?.key || '')).join(', ')}.</p>` : ''}
    ${rows.length ? `<div class="pm-gantt-wrap${st.density === 'compact' ? ' is-compact' : ''}" style="--label-w:${labelW}px;--row:${ROW}px">
      <div class="pm-gantt">
        <div class="pm-g-left"><div class="pm-g-head pm-g-lhead"><span>Work package</span>
          <span class="pm-g-label-end"><button type="button" class="pm-g-more" data-collapse-all title="Collapse all" aria-label="Collapse all">⊟</button><button type="button" class="pm-g-more" data-expand-all title="Expand all" aria-label="Expand all">⊞</button></span></div>
          ${rows.map((r, n) => label(r, n)).join('')}</div>
        <div class="pm-g-resize" data-resize title="Drag to make the list wider or narrower" aria-hidden="true"></div>
        <div class="pm-g-right" data-scroll>${head()}
          <div class="pm-g-body" style="width:${width}px;height:${height}px">
            ${phasesShown.map((ph) => `<div class="pm-g-phase" style="--c:${ph.c};left:${(ph.s - first) * px}px;width:${(ph.e - ph.s + 1) * px}px;height:${height}px"></div>`).join('')}
            ${cyclesShown.map((g, k) => `<div class="pm-g-cycle${k % 2 ? ' is-alt' : ''}${g.starts ? '' : ' is-cut'}" style="left:${x(g.start_date)}px;width:${(toDay(g.end_date) - toDay(g.start_date) + 1) * px}px;height:${height}px" title="${esc(`${g.name}: ${fmtDate(g.start_date)} – ${fmtDate(g.end_date)}`)}"></div>`).join('')}
            ${gridLines()}
            ${keysShown.map((k) => `<div class="pm-g-keydate is-${esc(k.kind)}" style="left:${x(k.day)}px;width:${Math.max((toDay(k.end_day || k.day) - toDay(k.day) + 1) * px, 2)}px;height:${height}px"></div>`).join('')}
            <div class="pm-g-today" style="left:${x(today) + px / 2}px;height:${height}px" title="Today"></div>
            ${rows.map(bar).join('')}
            <svg class="pm-g-svg" width="${width}" height="${height}" aria-hidden="true"><defs>
              <marker id="pm-g-tip" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z"/></marker>
              <marker id="pm-g-tip-c" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z"/></marker></defs>${arrows()}</svg>
          </div></div>
        <button type="button" class="pm-g-offtoday" data-today hidden></button></div>
      <div class="pm-g-legend">${legendHtml}${hiddenOutside ? `<button type="button" class="pm-g-leg pm-g-leg-add" data-show-outside title="Rows → Hide rows outside the fitted dates">${hiddenOutside} outside these dates · show them</button>` : ''}${st.colorBy === 'type' && canEditKinds() ? '<button type="button" class="pm-g-leg pm-g-leg-add" data-new-kind title="Add a kind of work to every space (Calc, Test plan…)">+ New kind</button>' : ''}<span class="pm-g-spacer"></span><span class="muted small">${seasonNote}${st.plan.forecast ? `${seasonNote ? ' · ' : ''}Forecast finish: <strong>${esc(fmtDate(plan.finish))}</strong>` : ''}</span></div>
      ${project && can(b, project.id, 'create') && !project.archived_at ? quickAdd(b, { project_id: project.id }, { placeholder: '+ Add an item (Enter; then drag across its row to give it dates)', cls: 'pm-qa-gantt' }) : ''}
      <div data-panel-slot></div></div>`
      : st.undated ? '<div class="empty"><p><strong>Every open item has dates.</strong></p></div>'
      : `<div class="empty"><p><strong>${shown ? 'Nothing matches the filters.' : 'Nothing on the timeline yet.'}</strong></p>${project && can(b, project.id, 'create') && !shown ? `<p><button type="button" class="btn btn-primary" data-add-root="${esc(project.id)}">+ Add the first item</button></p>` : ''}</div>`}
    ${orderWarnings.length || warnings.length || st.plan.critical || baseline ? `<div class="pm-summary">
      ${orderWarnings.length || warnings.length ? `<section class="card"><h2>Schedule warnings <span class="muted">${warnings.length + orderWarnings.length}</span></h2>
        ${orderWarnings.length ? `<h3>Orders not placed in time</h3><ul class="pm-mini">${orderWarnings.map((w) => `<li><a href="${itemHref(w.key)}">${esc(w.key)}</a> <span>${w.start < today ? 'started' : 'starts'} ${esc(fmtDate(w.start))}, but ${esc(w.number)} (${esc(w.request_title)}) is ${esc(w.status)}.</span></li>`).join('')}</ul>` : ''}
        ${warnings.length ? `<ul class="pm-mini">${warnings.slice(0, 40).map((w) => `<li><a href="${itemHref(byId.get(w.id).key)}">${esc(byId.get(w.id).key)}</a> <span>${esc(w.text)}</span></li>`).join('')}</ul>` : ''}</section>` : ''}
      ${st.plan.critical ? `<section class="card"><h2>Critical path</h2>
        ${plan.critical.filter((id) => byId.has(id)).length ? `<ol class="pm-crit">${plan.critical.filter((id) => byId.has(id)).map((id) => `<li><a href="${itemHref(byId.get(id).key)}">${esc(byId.get(id).key)} · ${esc(byId.get(id).title)}</a> <span class="muted small">${esc(fmtDate(plan.byId.get(id).start))} – ${esc(fmtDate(plan.byId.get(id).finish))}</span></li>`).join('')}</ol>
          <p class="hint">These have no slack: a day lost on any of them is a day lost at the end.</p>` : '<p class="muted">Nothing is linked into a chain yet. Drag from the dot at the end of a bar onto another bar to link them.</p>'}
        <p class="hint">Working days: ${(settings.working_days?.length ? settings.working_days : [1, 2, 3, 4, 5]).map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')}${(settings.holidays || []).length ? `; ${settings.holidays.length} day(s) off` : ''}${project ? '' : ' (across spaces the standard week is used)'}.</p></section>` : ''}
      ${baseline ? `<section class="card"><h2>Moved since the baseline <span class="muted">${slipped.length}</span></h2>
        ${slipped.length ? `<ul class="pm-mini">${slipped.slice(0, 40).map(({ i, s }) => `<li><a href="${itemHref(i.key)}">${esc(i.key)}</a> ${esc(i.title)} <strong class="${s > 0 ? 'text-bad' : ''}">${s > 0 ? '+' : '−'}${Math.abs(s)} day${Math.abs(s) === 1 ? '' : 's'}</strong></li>`).join('')}</ul>` : '<p class="muted">Nothing: every item still finishes when the baseline said.</p>'}</section>` : ''}
    </div>` : ''}`;

  const wrap = el.querySelector('.pm-gantt-wrap');
  /** Zoom to `to` pixels a day, keeping the date at `ax` pixels into the chart (default: the middle) where it is. */
  const setZoom = (to, ax = null) => {
    const sc = el.querySelector('[data-scroll]');
    const at = ax ?? (sc ? sc.clientWidth / 2 : 0);
    st.anchor = sc ? { day: first + (sc.scrollLeft + at) / px, x: at } : null;
    st.px = clampPx(to);
    st.fit = '';
    persist();
    again();
  };
  const scroller = el.querySelector('[data-scroll]');
  if (scroller) {
    // Where to scroll: after a zoom, the same date under the mouse; a fit, its start; else where it was, or today.
    // (Only possible once the chart is on the page: see check() below.)
    const want = Math.max(0, st.anchor ? (st.anchor.day - first) * px - st.anchor.x
      : st.scroll ?? (fitSpan ? (fitSpan[0] - first) * px : x(today) - 160));
    st.anchor = null;
    st.scroll = want;
    scroller.scrollLeft = want;
    // today off the edge of what's on the screen: a tag there says how far, and goes to it
    const offToday = el.querySelector('.pm-g-offtoday');
    const markToday = () => {
      if (!offToday || !scroller.clientWidth) return;
      const tx = x(today) + px / 2;
      const [l, r] = [scroller.scrollLeft, scroller.scrollLeft + scroller.clientWidth];
      if (tx >= l && tx <= r) return void (offToday.hidden = true);
      const n = Math.round((tx < l ? l - tx : tx - r) / px);
      const far = n >= 60 ? `${Math.round(n / 30.4)} months` : n >= 14 ? `${Math.round(n / 7)} weeks` : `${n} day${n === 1 ? '' : 's'}`;
      offToday.hidden = false;
      offToday.classList.toggle('is-right', tx > r);
      offToday.textContent = tx < l ? `◂ Today · ${far} before this` : `Today · ${far} after this ▸`;
    };
    // C5: a phase or car cycle that started off to the left keeps its name at the left edge until it ends
    const sticks = [...scroller.querySelectorAll('[data-stick]')].map((n) => [n, ...n.dataset.stick.split(',').map(Number)]);
    const stick = () => sticks.forEach(([n, s, e]) => {
      const l = scroller.scrollLeft;
      n.style.transform = l > s && l < e - n.offsetWidth ? `translateX(${l - s}px)` : '';
    });
    scroller.addEventListener('scroll', () => {
      if (!scroller.isConnected) return;
      st.scroll = scroller.scrollLeft;
      markToday();
      stick();
    }, { passive: true });
    requestAnimationFrame(stick);
    // Ctrl / ⌘ + scroll (and a trackpad pinch) zooms around the mouse; it redraws once the wheel stops.
    let pending = 1;
    let wheelTimer = 0;
    let wheelAt = 0;
    scroller.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      pending *= Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.01);
      wheelAt = e.clientX - scroller.getBoundingClientRect().left;
      scroller.querySelector('.pm-g-head')?.style.setProperty('opacity', '.6');
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => {
        const f = pending;
        pending = 1;
        setZoom(px * f, wheelAt);
      }, 140);
    }, { passive: false });
    // The real width, once it's on the page: draw again if the guess was off (or the window changed size).
    let tries = 0;
    const check = () => {
      if (!scroller.isConnected) return void (++tries < 20 && requestAnimationFrame(check));
      const real = scroller.clientWidth;
      if (real && Math.abs(real - room) > 3) {
        st.room = real;
        again();
      } else {
        st.room = real || st.room;
        scroller.scrollLeft = want;
        markToday();
      }
    };
    requestAnimationFrame(check);
    onResize = () => {
      if (!scroller.isConnected) return void (onResize = null);
      if (Math.abs(scroller.clientWidth - room) > 3) {
        st.room = scroller.clientWidth;
        again();
      }
    };
  }
  // the row under the mouse is highlighted across the list and the chart
  const leftPane = el.querySelector('.pm-g-left');
  const bodyPane = el.querySelector('.pm-g-body');
  let hovered = -1;
  const hover = (n) => {
    if (n === hovered) return;
    el.querySelectorAll('[data-ri].is-hover').forEach((x) => x.classList.remove('is-hover'));
    hovered = n;
    if (n >= 0) el.querySelectorAll(`[data-ri="${n}"]`).forEach((x) => x.classList.add('is-hover'));
  };
  leftPane?.addEventListener('mouseover', (e) => hover(Number(e.target.closest('[data-ri]')?.dataset.ri ?? -1)));
  bodyPane?.addEventListener('mousemove', (e) => hover(rowAt(e.clientY - bodyPane.getBoundingClientRect().top)));
  [leftPane, bodyPane].forEach((p) => p?.addEventListener('mouseleave', () => hover(-1)));

  if (st.filters) bindFilterBar(el, b, st.f, again, { fields: scope.fields, statuses: scope.statuses });
  bindSelection(el, { b, items: () => rowItems, cfgOf: scope.cfgOf, done: again, sprints: scope.cfg?.sprints || [] });
  bindQuickAdd(el, { b, done: again });
  if (st.selected && byId.has(st.selected)) openPanel(byId.get(st.selected));

  /** Save new dates straight away (with Undo), or, in what-if mode, only try them out. */
  async function saveDates(i, s, z) {
    if (st.plan.whatIf) return tryDates(i.id, s, z);
    const old = { start_date: i.start_date || null, due_date: i.due_date || null };
    if (old.start_date === (s || null) && old.due_date === (z || null)) return again();
    if (await attempt(() => pm.updateItem(i.id, i.version, { start_date: s || null, due_date: z || null }))) {
      again();
      undoBar(`${i.key}: ${rangeText(s || z, z || s)}`, async () => (await attempt(() => pm.updateItem(i.id, null, old), 'Put back.')) && scope.rerender());
    } else again();
  }
  /** Try out new target dates for an item (kept in the page only, until "Apply"). */
  function tryDates(id, start, due) {
    const i = byId.get(id);
    if ((start || null) === (i.start_date || null) && (due || null) === (i.due_date || null)) delete st.overrides[id];
    else st.overrides[id] = { start: start || null, due: due || null };
    again();
  }

  /** The side panel: edit an item without leaving the timeline. */
  function openPanel(i) {
    const slot = el.querySelector('[data-panel-slot]');
    if (!slot) return;
    st.selected = i.id;
    el.querySelectorAll('.pm-g-label.is-selected').forEach((n) => n.classList.remove('is-selected'));
    el.querySelector(`.pm-g-label[data-row="${CSS.escape(i.id)}"]`)?.classList.add('is-selected');
    const cfg = scope.cfgOf(i);
    const mayEdit = mayEditItem(b, i);
    const c = col.get(i.id) || colorOf(i);
    // each field saves as soon as it's changed (with Undo), like everywhere else; in what-if mode dates are only tried out
    const row = (label, html) => `<div class="pm-g-panel-row"><span class="pm-g-panel-label">${label}</span><span>${html}</span></div>`;
    const dates = st.plan.whatIf && mayDateItem(b, i)
      ? `<button type="button" class="pm-ie" data-dates="${esc(i.id)}">${esc(i.start_date || i.due_date ? rangeText(i.start_date || i.due_date, i.due_date || i.start_date) : 'No dates')} · try other dates…</button>`
      : `${ie(b, cfg, i, 'start')} → ${ie(b, cfg, i, 'due')}`;
    slot.innerHTML = `<aside class="pm-g-panel" aria-label="${esc(i.key)} ${esc(i.title)}">
      <div class="pm-g-panel-head"><span class="pm-g-dot" style="--c:${c.hex}"></span><a href="${itemHref(i.key)}">${esc(i.key)}</a>
        <button type="button" class="pm-g-more" data-close-panel aria-label="Close" title="Close (Esc)">×</button></div>
      ${mayEdit ? `<input class="pm-g-panel-title" data-panel-title type="text" maxlength="200" value="${esc(i.title)}" aria-label="Title" title="Click to rename; Enter saves">` : `<h3 class="pm-g-panel-title">${esc(i.title)}</h3>`}
      ${row('Status', ie(b, cfg, i, 'status'))}${row('Kind', ie(b, cfg, i, 'type'))}${row('Dates', dates)}
      ${row('Owner', ie(b, cfg, i, 'owner', 'name'))}${row('Priority', ie(b, cfg, i, 'priority'))}${row('Progress', ie(b, cfg, i, 'progress'))}
      <label class="field">Notes<textarea data-panel-notes rows="5" placeholder="Loading…" ${mayEdit ? '' : 'disabled'}></textarea><span class="hint">Saved when you click away.</span></label>
      <div class="form-actions"><a class="btn btn-sm btn-ghost" href="${itemHref(i.key)}">Open full item</a></div></aside>`;
    const panel = slot.querySelector('.pm-g-panel');
    bindInline(slot, { b, itemOf: (id) => byId.get(id), cfgOf: scope.cfgOf, after: () => again() });
    const notes = panel.querySelector('[data-panel-notes]');
    let desc = null;
    pm.itemDescription(i.id).then((d) => {
      desc = d;
      notes.value = d;
      notes.placeholder = 'Anything people should know';
    }).catch(() => (notes.placeholder = ''));
    notes.addEventListener('blur', () => desc !== null && notes.value !== desc && saveField({ b, item: i, cfg, root: slot }, { description: notes.value }).then((ok) => ok && (desc = notes.value)));
    const title = panel.querySelector('[data-panel-title]');
    title?.addEventListener('keydown', (e) => (e.key === 'Enter' ? (e.preventDefault(), title.blur()) : e.key === 'Escape' ? ((title.value = i.title), title.blur()) : null));
    title?.addEventListener('blur', async () => {
      const v = title.value.trim();
      if (!v) title.value = i.title;
      else if (v !== i.title && (await saveField({ b, item: i, cfg, root: slot }, { title: v }))) again();
    });
    slot.querySelector('[data-close-panel]').onclick = () => closePanel();
  }
  function closePanel() {
    st.selected = '';
    const slot = el.querySelector('[data-panel-slot]');
    if (slot) slot.innerHTML = '';
    el.querySelectorAll('.pm-g-label.is-selected').forEach((n) => n.classList.remove('is-selected'));
  }

  /** A row's ⋯ menu. */
  function openMenu(btn, i) {
    el.querySelector('.pm-g-menu')?.remove();
    const cfg = scope.cfgOf(i);
    const up = indentTarget(i);
    const menu = document.createElement('div');
    menu.className = 'pm-g-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = [
      `<button type="button" role="menuitem" data-details="${esc(i.id)}">Details…</button>`,
      `<a role="menuitem" href="${itemHref(i.key)}">Open ${esc(i.key)}</a>`,
      can(b, i.project_id, 'create') && kindsUnder(cfg, i).length && i.category !== 'done' ? `<button type="button" role="menuitem" data-add-child="${esc(i.id)}">Add under it…</button>` : '',
      can(b, i.project_id, 'plan') && i.category !== 'done' ? `<button type="button" role="menuitem" data-dates="${esc(i.id)}">Set dates…</button>` : '',
      can(b, i.project_id, 'edit') && up ? `<button type="button" role="menuitem" data-indent="${esc(i.id)}">Put under ${esc(up.key)}</button>` : '',
      can(b, i.project_id, 'edit') && i.parent_id && byId.has(i.parent_id) ? `<button type="button" role="menuitem" data-outdent="${esc(i.id)}">Take out a level</button>` : '',
    ].join('');
    const host = wrap || el;
    host.append(menu);
    const r = btn.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    menu.style.left = `${Math.max(0, r.right - h.left - menu.offsetWidth)}px`;
    menu.style.top = `${r.bottom - h.top + 4}px`;
    menu.querySelector('button, a')?.focus();
  }

  /** A new item, at the top of a project or under `parent`, with its kind, title and dates. Saved straight away. */
  const addItem = async (pid, parent) => {
    const cfg = scope.cfgOf({ project_id: pid });
    const kinds = kindsUnder(cfg, parent);
    if (!kinds.length) return toast(parent ? `Nothing can go under a ${cfg?.typeById.get(parent.type_id)?.name || 'this'} in this space (Settings → Work types).` : 'This space has no work-item types yet. Add one in Settings → Work types.', 'bad');
    const start = (parent && (target(parent).start || plan.byId.get(parent.id)?.start)) || today;
    const pt = parent && target(parent);
    const due = pt?.due && pt.due >= start ? (toDay(pt.due) - toDay(start) < 7 ? pt.due : toISO(toDay(start) + 6)) : toISO(toDay(start) + 6);
    const opId = newId();
    return formDialog({
      title: parent ? `Add under ${esc(parent.key)}` : `Add to ${esc(b.projectById.get(pid)?.name || 'the space')}`, submit: 'Add',
      body: `${parent ? `<p class="muted">${esc(parent.title)}</p>` : ''}<div class="form-grid">
          <div class="field"><label for="ga-kind">Kind</label><select id="ga-kind" name="kind">${kinds.map((t) => `<option value="${esc(t.id)}">${esc(`${t.icon ? `${t.icon} ` : ''}${t.name}`)}</option>`).join('')}</select></div>
          <div class="field span-3"><label for="ga-title">Title</label><input id="ga-title" name="title" type="text" maxlength="200" required></div>
          <div class="field span-2"><label for="ga-start">Start</label><input id="ga-start" name="start" type="date" value="${esc(start)}"></div>
          <div class="field span-2"><label for="ga-due">Due</label><input id="ga-due" name="due" type="date" value="${esc(due)}"></div></div>
        <p class="hint">Leave the dates empty to draw them on the timeline later. More details (owner, estimate…) are in the side panel or on the item's page.</p>`,
      onOpen: (form) => form.elements.title.focus(),
      onSubmit: (f) => {
        const [s, z] = [f.elements.start.value, f.elements.due.value];
        if (s && z && s > z) throw new Error('The start date is after the due date.');
        return pm.createItem(opId, { project_id: pid, type_id: f.elements.kind.value, title: f.elements.title.value.trim(), parent_id: parent?.id || null,
          start_date: s || null, due_date: z || null, division_id: parent?.division_id || null, subsystem_id: parent?.subsystem_id || null });
      },
    });
  };

  const closePops = (except) => el.querySelectorAll('details.pm-pop[open]').forEach((d) => d !== except && d.removeAttribute('open'));
  el.querySelectorAll('details.pm-pop').forEach((d) => d.addEventListener('toggle', () => {
    if (d.open) (closePops(d), (st.pop = d.dataset.pop));
    else if (st.pop === d.dataset.pop) st.pop = '';
  }));

  el.addEventListener('change', (e) => {
    const t = e.target;
    const d = t.dataset;
    if (d.show) (st.show[d.show] = t.checked);
    else if (d.plan) {
      st.plan[d.plan] = t.checked;
      if (d.plan === 'whatIf' && !t.checked && Object.keys(st.overrides).length) toast('The tried-out changes are still there: Apply or Discard them.');
    } else if (d.density !== undefined) st.density = t.value;
    else if (d.colorBy !== undefined) ((st.colorBy = t.value), (st.only = ''));
    else if (d.zoomPick !== undefined) return void (t.value && setZoom(Number(t.value)));
    else if (d.barText !== undefined) st.barText = t.value;
    else if (d.groupBy !== undefined) ((st.groupBy = t.value), (st.level = ''));
    else if (d.sortBy !== undefined) st.sortBy = t.value;
    else if (d.rowOpt) st[d.rowOpt] = t.checked;
    else if (d.baseline !== undefined) st.plan.baseline = t.value;
    else if (d.opt === 'undated') st.undated = t.checked;
    else if (d.scenario !== undefined) {
      const s = scenarios.find((q) => q.id === t.value);
      if (!s) return;
      st.overrides = { ...s.changes };
      st.scenario = s.id;
      st.plan.whatIf = true;
    } else return;
    persist();
    again();
  });

  el.addEventListener('keydown', (e) => {
    const node = e.target.closest?.('[data-bar]');
    if (node && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openPanel(byId.get(node.dataset.bar));
    } else if (node && node.dataset.drag !== undefined && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const i = byId.get(node.dataset.bar);
      const n = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 7 : snap);
      const t0 = target(i);
      const shift = (iso) => (iso ? toISO(toDay(iso) + n) : iso);
      saveDates(i, shift(t0.start), shift(t0.due));
    } else if (e.key === 'Escape') {
      el.querySelector('.pm-g-menu')?.remove();
      closePops();
    } else if (['-', '+', '='].includes(e.key) && !e.ctrlKey && !e.metaKey && !e.target.closest?.('input, textarea, select, [contenteditable]')) {
      e.preventDefault();
      setZoom(px * (e.key === '-' ? 1 / 1.6 : 1.6));
    }
  });

  el.addEventListener('click', async (e) => {
    // an arrow: remove that dependency
    const dep = e.target.closest('[data-dep]');
    if (dep) {
      if (confirm(`Remove the dependency ${dep.dataset.what}?`) && (await attempt(() => pm.unlink(dep.dataset.dep), 'Dependency removed.'))) again();
      return;
    }
    if (!e.target.closest('.pm-pop')) closePops();
    if (!e.target.closest('.pm-g-menu') && !e.target.closest('[data-menu]')) el.querySelector('.pm-g-menu')?.remove();
    const t = e.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (d.menu) {
      if (el.querySelector('.pm-g-menu')) return void el.querySelector('.pm-g-menu').remove();
      openMenu(t, byId.get(d.menu));
      return;
    }
    el.querySelector('.pm-g-menu')?.remove();
    if (d.toggle) (st.closed[st.closed.has(d.toggle) ? 'delete' : 'add'](d.toggle), (st.level = ''), again());
    else if (d.focus !== undefined) {
      const [kind, id] = d.focus.split(':');
      st.focus = kind ? { kind, id } : null;
      st.scroll = null;
      again();
    } else if (d.level) (setLevel(d.level), again());
    else if (d.zoomPx) setZoom(Number(d.zoomPx));
    else if (d.zoomStep) setZoom(px * (Number(d.zoomStep) > 0 ? 1.6 : 1 / 1.6));
    else if (d.fit !== undefined) {
      if (d.fit === '') st.px = px;   // stop fitting: keep what's on the screen
      st.fit = d.fit;
      st.pop = '';
      st.scroll = null;
      persist();
      again();
    } else if (d.fitCustom !== undefined) {
      const from = el.querySelector('[data-fit-from]').value;
      const to = el.querySelector('[data-fit-to]').value;
      if (!from || !to || to < from) return void toast('Pick a start and an end after it.', 'bad');
      st.fit = { from, to };
      st.pop = '';
      st.scroll = null;
      persist();
      again();
    }
    else if (d.today !== undefined) scroller && (scroller.scrollLeft = Math.max(0, x(today) - 160));
    else if (d.filters !== undefined) ((st.filters = !st.filters), again());
    else if (d.showOutside !== undefined) ((st.hideOutside = false), again());
    else if (d.legend !== undefined) ((st.only = st.only === d.legend ? '' : d.legend), again());
    else if (d.collapseAll !== undefined) {
      for (const [k, list] of kids) if (!k.startsWith('root:') && list.length) st.closed.add(k);
      if (!project) scope.projectIds.forEach((pid) => st.closed.add(pid));
      st.level = '';
      again();
    } else if (d.expandAll !== undefined) (st.closed.clear(), (st.level = ''), again());
    else if (d.details) openPanel(byId.get(d.details));
    else if (d.present !== undefined) ((st.present = true), again());
    else if (d.newKind !== undefined) {
      const { kindDialog } = await import('./kinds.js');
      const k = await kindDialog(b);
      if (k) (toast(`${k.name} is now a kind of work in every space.`), again());
    }
    else if (d.keyDates !== undefined) (await keyDatesDialog(keyDates)) && again();
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
      const res = await formDialog({ title: `Dates for ${esc(i.key)}`, submit: st.plan.whatIf ? 'Try these dates' : 'Save',
        body: `<p class="muted">${esc(i.title)}.${st.plan.whatIf ? ' What-if mode: you\'ll see what else moves before anything is saved.' : ''}</p>
          <div class="form-grid"><div class="field span-2"><label for="gd-start">Start</label><input id="gd-start" name="start" type="date" value="${esc(t0.start || '')}"></div>
            <div class="field span-2"><label for="gd-due">Due</label><input id="gd-due" name="due" type="date" value="${esc(t0.due || '')}"></div></div>
          ${st.plan.forecast ? `<p class="hint">Forecast: ${esc(fmtDate(plan.byId.get(i.id)?.start))} – ${esc(fmtDate(plan.byId.get(i.id)?.finish))}.</p>` : ''}`,
        onSubmit: (f) => {
          if (f.elements.start.value && f.elements.due.value && f.elements.start.value > f.elements.due.value) throw new Error('The start date is after the due date.');
          return { start: f.elements.start.value, due: f.elements.due.value };
        } });
      if (res) saveDates(i, res.start, res.due);
    } else if (d.discard !== undefined) ((st.overrides = {}), (st.scenario = ''), again());
    else if (d.toForecast !== undefined) {
      const proposed = proposeDates(items.map((i) => ({ ...i, start_date: target(i).start, due_date: target(i).due })), plan);
      if (!Object.keys(proposed).length) return toast('The target dates already match the forecast.');
      st.overrides = { ...st.overrides, ...proposed };
      st.plan.whatIf = true;
      persist();
      again();
    } else if (d.saveBaseline !== undefined) {
      const name = await askText({ title: 'Save a baseline', label: 'Name', placeholder: 'Plan of record', hint: 'Remembers today\'s target dates so you can see later how far the plan has moved.', ok: 'Save' });
      if (name && (await attempt(() => pm.saveBaseline(project.id, name), 'Baseline saved.'))) again();
    } else if (d.saveScenario !== undefined) {
      const name = await askText({ title: 'Keep this what-if', label: 'Name', placeholder: 'If the cells arrive a week late', ok: 'Keep it' });
      if (name && (await attempt(() => pm.saveScenario(project.id, null, { name, changes: st.overrides }), 'Kept. Find it under Plan → What-ifs.'))) again();
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

  // dragging a bar: move it, or pull an end; snaps to days (Weeks) or weeks (Months, Season). A click opens the panel.
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('[data-link-from]')) return;
    const node = e.target.closest('[data-bar]');
    if (!node) return;
    const i = byId.get(node.dataset.bar);
    if (node.dataset.drag === undefined) return void node.addEventListener('pointerup', () => openPanel(i), { once: true });
    e.preventDefault();
    const t0 = target(i);
    const p = plan.byId.get(i.id);
    const s0 = t0.start || t0.due || p?.start;
    const d0 = t0.due || t0.start || p?.finish;
    const mode = e.target.classList.contains('pm-g-h-l') ? 'l' : e.target.classList.contains('pm-g-h-r') ? 'r' : 'm';
    const [x0, left0, width0] = [e.clientX, node.offsetLeft, node.offsetWidth];
    let delta = 0;
    let moved = false;
    const shift = (iso, n) => (iso ? toISO(toDay(iso) + n) : iso);
    const range = () => {
      if (i.is_milestone || mode === 'm') return [shift(s0, delta), shift(d0, delta)];
      if (mode === 'r') return [s0, toDay(shift(d0, delta)) < toDay(s0) ? s0 : shift(d0, delta)];
      return [toDay(shift(s0, delta)) > toDay(d0) ? d0 : shift(s0, delta), d0];
    };
    const tip = document.createElement('div');
    tip.className = 'pm-g-dragtip';
    node.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 4) return;
      if (!moved) ((moved = true), node.classList.add('is-dragging'), node.parentElement.append(tip));
      delta = Math.round(dx / px / snap) * snap;
      if (i.is_milestone || mode === 'm') node.style.left = `${left0 + delta * px}px`;
      else if (mode === 'r') node.style.width = `${Math.max(px, width0 + delta * px)}px`;
      else {
        const d2 = Math.min(delta, Math.round(width0 / px) - 1);
        node.style.left = `${left0 + d2 * px}px`;
        node.style.width = `${width0 - d2 * px}px`;
      }
      const [a, z] = range();
      tip.textContent = rangeText(a, z);
      tip.style.left = `${node.offsetLeft}px`;
      tip.style.top = `${node.offsetTop - 28}px`;
    };
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', () => {
      node.removeEventListener('pointermove', onMove);
      node.classList.remove('is-dragging');
      tip.remove();
      if (!moved) return openPanel(i);
      if (!delta) return again();
      const [a, z] = range();
      if (i.is_milestone) return saveDates(i, t0.start ? a : t0.start, t0.due || !t0.start ? z : t0.due);
      saveDates(i, a, z);
    }, { once: true });
    node.addEventListener('pointercancel', () => (node.removeEventListener('pointermove', onMove), tip.remove(), again()), { once: true });
  });

  // from the dot at a bar's end onto another bar: that one waits on this one
  el.addEventListener('pointerdown', (e) => {
    const dot = e.target.closest('[data-link-from]');
    if (!dot || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const from = byId.get(dot.dataset.linkFrom);
    const body = el.querySelector('.pm-g-body');
    const svg = body.querySelector('.pm-g-svg');
    const r0 = body.getBoundingClientRect();
    const dr = dot.getBoundingClientRect();
    const [x1, y1] = [dr.left + dr.width / 2 - r0.left, dr.top + dr.height / 2 - r0.top];
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('class', 'pm-g-arrow is-drawing');
    svg.append(line);
    dot.setPointerCapture(e.pointerId);
    let over = null;
    const onMove = (ev) => {
      line.setAttribute('d', `M${x1} ${y1} L${ev.clientX - r0.left} ${ev.clientY - r0.top}`);
      over?.classList.remove('is-link-target');
      over = document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => n.dataset?.bar && n.dataset.bar !== from.id) || null;
      over?.classList.add('is-link-target');
    };
    dot.addEventListener('pointermove', onMove);
    dot.addEventListener('pointerup', async () => {
      dot.removeEventListener('pointermove', onMove);
      line.remove();
      over?.classList.remove('is-link-target');
      if (!over) return;
      const to = byId.get(over.dataset.bar);
      if (await attempt(() => pm.link({ from: from.id, to: to.id, kind: 'FS' }), `${to.key} now waits on ${from.key}.`)) again();
    }, { once: true });
  });

  // drawing on an undated item's row: from where you press to where you let go becomes its dates
  el.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('[data-draw]');
    if (!row || e.button !== 0) return;
    e.preventDefault();
    const i = byId.get(row.dataset.draw);
    const body = row.parentElement;
    const dayAt = (clientX) => Math.max(0, Math.floor((clientX - body.getBoundingClientRect().left) / px));
    const snapTo = (n) => (snap === 1 ? n : Math.floor(n / 7) * 7);
    const d0 = snapTo(dayAt(e.clientX));
    let d1 = d0;
    const ghost = document.createElement('div');
    ghost.className = 'pm-g-bar is-drawing';
    ghost.style.cssText = `top:${row.offsetTop + (ROW - BAR) / 2}px;height:${BAR}px;left:${d0 * px}px;width:${px * snap}px`;
    const tip = document.createElement('div');
    tip.className = 'pm-g-dragtip';
    body.append(ghost, tip);
    row.setPointerCapture(e.pointerId);
    const ends = () => {
      const [a, z] = [Math.min(d0, d1), Math.max(d0, d1)];
      return [a, snap === 1 ? z : z + 6];
    };
    const onMove = (ev) => {
      d1 = snapTo(dayAt(ev.clientX));
      const [a, z] = ends();
      ghost.style.left = `${a * px}px`;
      ghost.style.width = `${(z - a + 1) * px}px`;
      tip.textContent = rangeText(toISO(first + a), toISO(first + z));
      tip.style.left = `${a * px}px`;
      tip.style.top = `${row.offsetTop - 24}px`;
    };
    row.addEventListener('pointermove', onMove);
    row.addEventListener('pointerup', () => {
      row.removeEventListener('pointermove', onMove);
      ghost.remove();
      tip.remove();
      const [a, z] = ends();
      // a single click gives it a week, the usual first guess
      saveDates(i, toISO(first + a), toISO(first + (a === z ? a + 6 : z)));
    }, { once: true });
  });

  // dragging a row by its handle onto another row: into it (middle), or before / after it (edges)
  el.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('[data-grip]');
    if (!grip || e.button !== 0) return;
    e.preventDefault();
    const i = byId.get(grip.dataset.grip);
    const labels = [...el.querySelectorAll('.pm-g-label[data-row]')];
    const isUnder = (a, z) => {
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
      const over = labels.find((l) => {
        const r = l.getBoundingClientRect();
        return ev.clientY >= r.top && ev.clientY < r.bottom;
      });
      if (!over) return;
      const tgt = byId.get(over.dataset.row);
      const r = over.getBoundingClientRect();
      const f = (ev.clientY - r.top) / r.height;
      const where = f < 0.28 ? 'before' : f > 0.72 ? 'after' : 'into';
      const parent = where === 'into' ? tgt : tgt.parent_id && byId.has(tgt.parent_id) ? byId.get(tgt.parent_id) : null;
      const ok = tgt.id !== i.id && tgt.project_id === i.project_id && !isUnder(i.id, tgt.id) && kindsUnder(scope.cfgOf(i), parent).some((t) => t.id === i.type_id);
      over.classList.add(ok ? `is-drop-${where}` : 'is-drop-no');
      if (ok) drop = { tgt, where, parent };
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', async () => {
      grip.removeEventListener('pointermove', onMove);
      clear();
      el.querySelector('.pm-g-label.is-dragging')?.classList.remove('is-dragging');
      if (!drop) return;
      const { tgt, where, parent } = drop;
      const sibs = (kids.get(parent ? parent.id : `root:${i.project_id}`) || []).filter((s) => s.id !== i.id);
      let rank;
      if (where === 'into') rank = rankBetween(sibs[sibs.length - 1]?.rank, null);
      else {
        const at = sibs.indexOf(tgt) + (where === 'after' ? 1 : 0);
        rank = rankBetween(sibs[at - 1]?.rank, sibs[at]?.rank);
      }
      const patch = { rank, ...((parent?.id || null) !== (i.parent_id && byId.has(i.parent_id) ? i.parent_id : null) ? { parent_id: parent?.id || null } : {}) };
      if (await attempt(() => pm.updateItem(i.id, i.version, patch), where === 'into' ? `${i.key} is under ${tgt.key} now.` : `${i.key} moved.`)) {
        if (where === 'into') st.closed.delete(tgt.id);
        again();
      }
    }, { once: true });
  });

  // the list's width: drag the line between the list and the chart
  el.querySelector('[data-resize]')?.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const w0 = labelW;
    const x0 = e.clientX;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      st.labelW = Math.max(160, Math.min(520, w0 + ev.clientX - x0));
      wrap.style.setProperty('--label-w', `${st.labelW}px`);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', () => (handle.removeEventListener('pointermove', onMove), persist()), { once: true });
  });

  // double-click a title to rename it there
  el.addEventListener('dblclick', (e) => {
    const nameEl = e.target.closest('[data-rename]');
    if (!nameEl || nameEl.querySelector('input')) return;
    const i = byId.get(nameEl.dataset.rename);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pm-g-rename';
    input.maxLength = 200;
    input.value = i.title;
    input.setAttribute('aria-label', `New title for ${i.key}`);
    nameEl.textContent = '';
    nameEl.append(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      if (!save || !title || title === i.title) return void (nameEl.textContent = i.title);
      nameEl.textContent = title;
      if (await attempt(() => pm.updateItem(i.id, i.version, { title }), 'Renamed.')) again();
      else nameEl.textContent = i.title;
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') (ev.preventDefault(), finish(true));
      else if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  });

  // ---- Present: a clean chart with a title and a legend, to show or to download
  function renderPresent() {
    const dark = siteDark();
    const seasonName = seasonRow?.name || '';
    if (st.title === null) st.title = project ? project.name : 'Spaces';
    if (st.subtitle === null) st.subtitle = `${seasonName ? `${seasonName} / ` : ''}${project ? `${project.name} roadmap` : 'Roadmap'}`;
    el.innerHTML = `<div class="pm-present${dark ? ' is-dark' : ''}">
      <div class="pm-present-tools">
        <label class="field">Title<input data-present-title type="text" maxlength="80" value="${esc(st.title)}"></label>
        <label class="field">Subtitle<input data-present-sub type="text" maxlength="120" value="${esc(st.subtitle)}"></label>
        <div class="card-actions"><button type="button" class="btn btn-sm" data-present-png>Download PNG</button>
          <button type="button" class="btn btn-sm" data-present-print>Print / PDF</button>
          <button type="button" class="btn btn-sm" data-present-full>Full screen</button>
          <button type="button" class="btn btn-sm btn-primary" data-present-exit>Done</button></div></div>
      <div class="pm-present-chart" data-present-chart>${exportSvg()}</div></div>`;
    const chart = el.querySelector('[data-present-chart]');
    const redraw = () => (chart.innerHTML = exportSvg());
    el.querySelector('[data-present-title]').oninput = (e) => ((st.title = e.target.value), redraw());
    el.querySelector('[data-present-sub]').oninput = (e) => ((st.subtitle = e.target.value), redraw());
    el.querySelector('[data-present-exit]').onclick = () => ((st.present = false), document.fullscreenElement && document.exitFullscreen(), again());
    el.querySelector('[data-present-print]').onclick = () => window.print();
    el.querySelector('[data-present-full]').onclick = () => chart.requestFullscreen?.().catch(() => toast('Full screen isn\'t available here.', 'bad'));
    el.querySelector('[data-present-png]').onclick = () => {
      const svg = chart.querySelector('svg');
      const [w, h] = [Number(svg.getAttribute('width')), Number(svg.getAttribute('height'))];
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = w * 2;
        c.height = h * 2;
        const ctx = c.getContext('2d');
        ctx.scale(2, 2);
        ctx.drawImage(img, 0, 0);
        c.toBlob((blob) => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `${(st.title || 'timeline').replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'timeline'}.png`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        }, 'image/png');
      };
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.outerHTML)}`;
    };
  }

  /** The chart as one SVG (16:9-ish, like a slide): title, months over weeks, the work, bars, team dates and a legend. */
  function exportSvg() {
    // the site's own colors (light or dark, whichever the account menu is on), so the slide matches the app
    const css = getComputedStyle(document.documentElement);
    const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const dark = siteDark();
    const C = { bg: v('--surface', dark ? '#081f3d' : '#ffffff'), panel: v('--surface-2', dark ? '#0d2b50' : '#f8fafc'), text: v('--text', dark ? '#f7f9ff' : '#1c2733'),
      muted: v('--muted', dark ? '#a8b8ce' : '#5d6d7e'), line: v('--border-soft', dark ? '#17375c' : '#edf1f5'), month: v('--border', dark ? '#23486f' : '#dde3ea') };
    const list = rows;
    const W = 1600;
    const pad = 48;
    const LW = 420;
    const RH = Math.max(30, Math.min(44, Math.floor(620 / Math.max(list.length, 1))));
    const top0 = 150;
    const headH = 64;
    const cw = W - pad * 2 - LW;
    const ends = (r, k) => (r.item ? [own(r.item)?.[k]] : r.lane ? r.lane.map((i) => own(i)?.[k]) : spanHeader(r.header) ? [spanHeader(r.header)[k]] : []);
    const lo = Math.min(...[tday, ...list.flatMap((r) => ends(r, 0)).filter(Boolean).map(toDay)]);
    const hi = Math.max(...[tday, ...list.flatMap((r) => ends(r, 1)).filter(Boolean).map(toDay)]);
    let f0 = lo - 3;
    f0 -= ((f0 - weekday0) % 7 + 7) % 7;
    const f1 = Math.max(hi + 4, f0 + 27);
    const ppx = cw / (f1 - f0 + 1);
    const X = (d) => pad + LW + (d - f0) * ppx;
    const H = top0 + headH + list.length * RH + 90;
    const t = (s) => esc(String(s));
    let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Helvetica, Arial, sans-serif">
      <rect width="${W}" height="${H}" fill="${C.bg}"/>
      <text x="${pad}" y="${pad + 44}" font-size="46" font-weight="700" fill="${C.text}">${t(st.title || '')}</text>
      <text x="${pad}" y="${pad + 82}" font-size="20" font-weight="600" letter-spacing="2" fill="${C.muted}">${t((st.subtitle || '').toUpperCase())}</text>
      <rect x="${pad}" y="${top0}" width="${W - pad * 2}" height="${headH}" fill="${C.panel}" rx="6"/>
      <text x="${pad + 16}" y="${top0 + headH / 2 + 6}" font-size="15" font-weight="700" letter-spacing="2" fill="${C.muted}">WORK PACKAGE</text>`;
    // months and weeks
    for (let d = f0; d <= f1; d++) {
      const date = new Date(d * 864e5);
      if (date.getUTCDate() === 1 || d === f0) {
        let end = d + 1;
        while (end <= f1 && new Date(end * 864e5).getUTCDate() !== 1) end++;
        if ((end - d) * ppx > 40) out += `<text x="${(X(d) + X(end)) / 2}" y="${top0 + 26}" font-size="15" font-weight="700" letter-spacing="2" text-anchor="middle" fill="${C.text}">${t(date.toLocaleDateString('en-US', { month: (end - d) * ppx > 110 ? 'long' : 'short', timeZone: 'UTC' }).toUpperCase())}</text>`;
        if (d !== f0 && (30 * ppx >= 8 || date.getUTCMonth() === 0)) out += `<line x1="${X(d)}" y1="${top0}" x2="${X(d)}" y2="${top0 + headH + list.length * RH}" stroke="${C.month}" stroke-width="1.5"/>`;
      }
    }
    if (30 * ppx < 40) {   // years, when months are too narrow to name
      for (let d = f0; d <= f1; d++) {
        const date = new Date(d * 864e5);
        if (d === f0 || (date.getUTCMonth() === 0 && date.getUTCDate() === 1)) out += `<text x="${X(d) + 6}" y="${top0 + 26}" font-size="15" font-weight="700" letter-spacing="2" fill="${C.text}">${date.getUTCFullYear()}</text>`;
      }
    }
    for (let d = f0; d <= f1 && 7 * ppx >= 8; d += 7) {
      if (7 * ppx >= 22) out += `<text x="${X(d) + 3.5 * ppx}" y="${top0 + 52}" font-size="14" font-weight="600" text-anchor="middle" fill="${C.muted}">${t(weekLabel(d))}</text>`;
      out += `<line x1="${X(d)}" y1="${top0 + headH}" x2="${X(d)}" y2="${top0 + headH + list.length * RH}" stroke="${C.line}" stroke-width="1"/>`;
    }
    for (const k of keyDates.filter((q) => q.kind !== 'season' && toDay(q.end_day || q.day) >= f0 && toDay(q.day) <= f1)) {
      const a = Math.max(f0, toDay(k.day));
      const z = Math.min(f1, toDay(k.end_day || k.day));
      out += `<rect x="${X(a)}" y="${top0 + headH}" width="${Math.max((z - a + 1) * ppx, 2)}" height="${list.length * RH}" fill="${TONE[k.kind === 'review' ? 'blue' : k.kind === 'break' ? 'gray' : 'red']}" opacity="0.12"/>`
        + `<text x="${X(a) + 4}" y="${top0 + headH + list.length * RH + 18}" font-size="12" fill="${C.muted}">${t(k.name)}</text>`;
    }
    // rows
    list.forEach((r, n) => {
      const y = top0 + headH + n * RH;
      if (n % 2 === 1) out += `<rect x="${pad}" y="${y}" width="${W - pad * 2}" height="${RH}" fill="${C.panel}" opacity="0.5"/>`;
      if (r.header) {
        out += `<text x="${pad + 16}" y="${y + RH / 2 + 6}" font-size="17" font-weight="700" fill="${C.text}">${t(r.header.name)}</text>`;
        const s = spanHeader(r.header);
        if (s) out += `<rect x="${X(toDay(s[0]))}" y="${y + RH / 2 - 2}" width="${(toDay(s[1]) - toDay(s[0]) + 1) * ppx}" height="4" rx="2" fill="${C.muted}"/>`;
        return;
      }
      if (r.lane) {
        const names = r.lane.map((i) => i.title).join(' · ');
        out += `<text x="${pad + 28 + r.depth * 18}" y="${y + RH / 2 + 6}" font-size="17" fill="${C.text}">${t(names.length > 44 ? `${names.slice(0, 43)}…` : names)}</text>`;
        const bh = Math.round(RH * 0.52);
        for (const i of r.lane) {
          const s = own(i);
          if (s) out += `<rect x="${X(toDay(s[0]))}" y="${y + (RH - bh) / 2}" width="${Math.max((toDay(s[1]) - toDay(s[0]) + 1) * ppx, 4)}" height="${bh}" rx="5" fill="${col.get(i.id).hex}" opacity="${i.category === 'done' ? 0.55 : 1}"/>`;
        }
        return;
      }
      const i = r.item;
      const c = col.get(i.id);
      const full = r.prefix ? `${r.prefix.name} › ${i.title}` : i.title;
      const name = full.length > 44 ? `${full.slice(0, 43)}…` : full;
      out += `<rect x="${pad + 12 + r.depth * 18}" y="${y + RH / 2 - 9}" width="5" height="18" rx="1" fill="${c.hex}"/>`
        + `<text x="${pad + 28 + r.depth * 18}" y="${y + RH / 2 + 6}" font-size="17" font-weight="${r.children ? 700 : 400}" fill="${C.text}">${t(name)}</text>`;
      const s = own(i);
      const tt = target(i);
      if (r.children && !(tt.start || tt.due)) {
        const u = spanUnder(i);
        if (u) out += `<rect x="${X(toDay(u[0]))}" y="${y + RH / 2 - 2}" width="${(toDay(u[1]) - toDay(u[0]) + 1) * ppx}" height="4" rx="2" fill="${C.muted}"/>`;
      } else if (s && i.is_milestone) {
        const cx = X(toDay(s[1])) + ppx / 2;
        const cy = y + RH / 2;
        const m = RH * 0.28;
        out += `<path d="M${cx} ${cy - m} L${cx + m} ${cy} L${cx} ${cy + m} L${cx - m} ${cy} Z" fill="${c.hex}"/>`;
      } else if (s) {
        const bh = Math.round(RH * 0.52);
        out += `<rect x="${X(toDay(s[0]))}" y="${y + (RH - bh) / 2}" width="${Math.max((toDay(s[1]) - toDay(s[0]) + 1) * ppx, 4)}" height="${bh}" rx="5" fill="${c.hex}" opacity="${i.category === 'done' ? 0.55 : 1}"/>`;
      }
    });
    // legend
    let lx = pad;
    const ly = H - 34;
    for (const [name, tone] of legend) {
      out += `<rect x="${lx}" y="${ly - 12}" width="22" height="14" rx="3" fill="${TONE[tone]}"/><text x="${lx + 32}" y="${ly}" font-size="15" font-weight="700" letter-spacing="1.5" fill="${C.muted}">${t(name.toUpperCase())}</text>`;
      lx += 60 + name.length * 11;
    }
    return `${out}</svg>`;
  }
}

/** 061: the team's dates (competitions, design reviews, breaks, the season start): add one, or remove one. */
function keyDatesDialog(list) {
  let changed = false;
  return formDialog({
    title: 'Team dates', submit: 'Add this date', wide: true,
    body: `<p class="muted">Competitions, design reviews, breaks… Every space's timeline shows them. A <strong>Season start</strong> numbers the timeline's weeks from it (week 01).</p>
      <ul class="pm-mini" data-key-list>${list.length ? list.map((k) => `<li>${esc(fmtDate(k.day))}${k.end_day && k.end_day !== k.day ? ` – ${esc(fmtDate(k.end_day))}` : ''} <strong>${esc(k.name)}</strong>
        <span class="muted small">${esc(KEY_KINDS[k.kind] || k.kind)}${k.note ? ` · ${esc(k.note)}` : ''}</span>
        <button type="button" class="btn btn-sm btn-ghost" data-del-key="${esc(k.id)}" aria-label="Remove ${esc(k.name)}">✕</button></li>`).join('') : '<li class="muted">None yet.</li>'}</ul>
      <div class="form-grid">
        <div class="field span-3"><label for="kd-name">Name</label><input id="kd-name" name="name" type="text" maxlength="120" required placeholder="Spring 2027"></div>
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
        end_day: f.elements.kind.value === 'season' ? null : f.elements.end.value || null, note: f.elements.note.value.trim() });
    },
  }).then((r) => r || changed);
}
