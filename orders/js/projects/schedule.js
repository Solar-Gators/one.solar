/**
 * Projects: the scheduling engine (pure; tested in Node: tests/projectsModules.test.mjs).
 *
 * It never changes anything. Given items, their dependencies and the project's working calendar it works out
 * a FORECAST (when each item can really start and finish), compares it with the TARGET dates people typed, and
 * finds the critical path. Target dates only move when someone applies a reschedule (pm_reschedule).
 *
 * Assumptions (also in docs/projects.md):
 *   - Time is whole days. Work happens on the project's working days, never on its days off.
 *   - An item's length is the working days from its target start to its target due date (inclusive). With only
 *     one date or none: its estimate at 8 hours a day, at least 1 day. A milestone has no length.
 *   - Finished items stay where they finished. Items in progress started when they actually started and can't
 *     finish before today. Items not started can't start before today, their target start, or what their
 *     dependencies allow, whichever is latest.
 *   - Dependencies ("from" first): FS to starts after from finishes; SS to starts after from starts; FF to
 *     finishes after from finishes; SF to finishes after from starts. Lag is in working days (negative = lead).
 *   - Slack is how many working days an item can slip without moving the last finish date. Critical: no slack.
 */

const DAY = 86400000;
/** "2027-01-04" → day number; day number → "2027-01-04". */
export const toDay = (iso) => (iso ? Math.round(Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`) / DAY) : null);
export const toISO = (day) => (day === null || day === undefined ? null : new Date(day * DAY).toISOString().slice(0, 10));
export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** A working calendar from project settings { working_days: [1..5] (0 = Sunday), holidays: ['2027-01-18'] }. */
export function makeCalendar(settings = {}) {
  const days = new Set((settings.working_days?.length ? settings.working_days : [1, 2, 3, 4, 5]).map(Number));
  const off = new Set((settings.holidays || []).map(toDay));
  const isWork = (d) => days.has((((d + 4) % 7) + 7) % 7) && !off.has(d); // day 0 (1970-01-01) was a Thursday
  /** The first working day on or after d (or on or before, going back). */
  const snap = (d, back = false) => {
    let x = d;
    for (let i = 0; i < 4000 && !isWork(x); i++) x += back ? -1 : 1;
    return x;
  };
  /** d moved by n working days (n may be negative). add(d, 0) is d itself, snapped onto a working day. */
  const add = (d, n) => {
    let x = snap(d, n < 0);
    for (let left = Math.abs(n); left > 0; left--) x = snap(x + (n < 0 ? -1 : 1), n < 0);
    return x;
  };
  /** Working days from a to b, counting both ends (0 if b is before a). */
  const span = (a, b) => {
    let n = 0;
    for (let x = a; x <= b; x++) if (isWork(x)) n++;
    return n;
  };
  return { isWork, snap, add, span };
}

/** How many working days an item takes. */
export function durationOf(item, cal) {
  if (item.is_milestone) return 0;
  const s = toDay(item.start_date);
  const d = toDay(item.due_date);
  if (s !== null && d !== null) return Math.max(1, cal.span(s, d));
  const est = Number(item.estimate_hours);
  return est > 0 ? Math.max(1, Math.ceil(est / 8)) : 1;
}

/** The items in dependency order, or the ids caught in a loop. */
function order(ids, deps) {
  const indeg = new Map(ids.map((id) => [id, 0]));
  const out = new Map(ids.map((id) => [id, []]));
  for (const d of deps) {
    indeg.set(d.to_item, indeg.get(d.to_item) + 1);
    out.get(d.from_item).push(d);
  }
  const queue = ids.filter((id) => !indeg.get(id));
  const sorted = [];
  while (queue.length) {
    const id = queue.shift();
    sorted.push(id);
    for (const d of out.get(id)) {
      indeg.set(d.to_item, indeg.get(d.to_item) - 1);
      if (!indeg.get(d.to_item)) queue.push(d.to_item);
    }
  }
  return { sorted, loop: ids.filter((id) => !sorted.includes(id)) };
}

/**
 * schedule(items, deps, settings, { today, overrides })
 *   items: [{ id, start_date, due_date, estimate_hours, category, actual_start, completed_at, is_milestone }]
 *   deps:  [{ from_item, to_item, kind, lag_days }]  (ones pointing at items not given are ignored)
 *   overrides: { id: { start, due } } target dates to try out instead (what-if)
 * → { byId: Map(id → { start, finish, lateStart, lateFinish, slack, critical, duration, late, warnings }),
 *     finish, critical: [ids in order], warnings: [{ id, kind, text, days }], loop: [ids] }
 * Dates are ISO strings. `late` is working days the forecast finish is past the target due date.
 */
export function schedule(items, deps, settings = {}, { today = todayISO(), overrides = {} } = {}) {
  const cal = makeCalendar(settings);
  const now = cal.snap(toDay(today));
  const byId = new Map();
  for (const raw of items) {
    const o = overrides[raw.id];
    const it = o ? { ...raw, start_date: o.start ?? null, due_date: o.due ?? null } : raw;
    byId.set(it.id, { it, dur: durationOf(it, cal), es: null, ef: null, ls: null, lf: null });
  }
  const live = deps.filter((d) => byId.has(d.from_item) && byId.has(d.to_item));
  const { sorted, loop } = order([...byId.keys()], live);
  const into = new Map();
  const outOf = new Map();
  for (const d of live) {
    (into.get(d.to_item) || into.set(d.to_item, []).get(d.to_item)).push(d);
    (outOf.get(d.from_item) || outOf.set(d.from_item, []).get(d.from_item)).push(d);
  }
  const len = (n) => Math.max(0, n.dur - 1);
  const gap = (a, b) => (a.dur === 0 || b.dur === 0 ? 0 : 1);

  // Forward: the earliest each item can start and finish.
  for (const id of sorted) {
    const n = byId.get(id);
    const { it } = n;
    const tStart = toDay(it.start_date);
    const tDue = toDay(it.due_date);
    if (it.category === 'done') {
      n.ef = cal.snap(toDay(it.completed_at) ?? tDue ?? tStart ?? now, true);
      n.es = Math.min(n.ef, cal.snap(toDay(it.actual_start) ?? tStart ?? cal.add(n.ef, -len(n))));
      continue;
    }
    let es = null;
    for (const d of into.get(id) || []) {
      const p = byId.get(d.from_item);
      const lag = Number(d.lag_days) || 0;
      const need = d.kind === 'SS' ? cal.add(p.es, lag)
        : d.kind === 'FF' ? cal.add(cal.add(p.ef, lag), -len(n))
        : d.kind === 'SF' ? cal.add(cal.add(p.es, lag), -len(n))
        : cal.add(p.ef, gap(p, n) + lag);   // FS: the working day after it finishes (a milestone takes no day)
      es = es === null ? need : Math.max(es, need);
    }
    if (it.category === 'doing') {
      n.es = cal.snap(toDay(it.actual_start) ?? tStart ?? now);
      n.ef = Math.max(cal.add(n.es, len(n)), now);
    } else {
      const own = tStart ?? (tDue !== null && !n.dur ? tDue : null) ?? (tDue !== null ? cal.add(tDue, -len(n)) : null);
      n.es = cal.snap(Math.max(es ?? -Infinity, own ?? -Infinity, es === null && own === null ? now : -Infinity, now));
      n.ef = cal.add(n.es, len(n));
    }
  }
  const scheduled = sorted.map((id) => byId.get(id));
  const finish = scheduled.length ? Math.max(...scheduled.map((n) => n.ef)) : now;

  // Backward: the latest each can finish without moving the last finish date.
  for (const id of [...sorted].reverse()) {
    const n = byId.get(id);
    let lf = finish;
    for (const d of outOf.get(id) || []) {
      const s = byId.get(d.to_item);
      const lag = Number(d.lag_days) || 0;
      const allow = d.kind === 'SS' ? cal.add(cal.add(s.ls, -lag), len(n))
        : d.kind === 'FF' ? cal.add(s.lf, -lag)
        : d.kind === 'SF' ? cal.add(cal.add(s.lf, -lag), len(n))
        : cal.add(s.ls, -(gap(n, s) + lag));
      lf = Math.min(lf, allow);
    }
    n.lf = Math.max(lf, n.ef);
    n.ls = cal.add(n.lf, -len(n));
  }

  const result = new Map();
  const warnings = [];
  const title = (id) => byId.get(id).it.key || byId.get(id).it.title || 'another item';
  for (const id of sorted) {
    const n = byId.get(id);
    const { it } = n;
    const done = it.category === 'done';
    const slack = done ? null : Math.max(0, cal.span(n.ef, n.lf) - 1);
    const tStart = toDay(it.start_date);
    const tDue = toDay(it.due_date);
    const mine = [];
    const late = !done && tDue !== null && n.ef > tDue ? cal.span(tDue, n.ef) - 1 : 0;
    if (late > 0) mine.push({ id, kind: 'late', days: late, text: `Forecast to finish ${toISO(n.ef)}, ${late} working day${late === 1 ? '' : 's'} after its due date` });
    for (const d of into.get(id) || []) {
      const p = byId.get(d.from_item);
      if (done || tStart === null) continue;
      const lag = Number(d.lag_days) || 0;
      const need = d.kind === 'SS' ? cal.add(p.es, lag) : d.kind === 'FS' ? cal.add(p.ef, gap(p, n) + lag) : null;
      if (need !== null && tStart < need && it.category === 'todo') {
        mine.push({ id, kind: 'dependency', days: cal.span(tStart, need) - 1, from: d.from_item,
          text: `Planned to start ${it.start_date}, but ${title(d.from_item)} ${d.kind === 'SS' ? 'starts' : 'finishes'} too late: earliest start is ${toISO(need)}` });
      }
    }
    // late starting on its own account (when a dependency is the reason, that warning already says so)
    if (!done && it.category === 'todo' && tStart !== null && tStart < now && n.es > tStart && !mine.some((w) => w.kind === 'dependency')) {
      mine.push({ id, kind: 'not-started', days: cal.span(tStart, now) - 1, text: `Was meant to start ${it.start_date} and hasn't` });
    }
    warnings.push(...mine);
    result.set(id, {
      start: toISO(n.es), finish: toISO(n.ef), lateStart: toISO(n.ls), lateFinish: toISO(n.lf), slack,
      critical: !done && slack === 0 && scheduled.length > 1, duration: n.dur, late, warnings: mine,
    });
  }
  const critical = sorted.filter((id) => result.get(id).critical).sort((a, b) => (result.get(a).start < result.get(b).start ? -1 : 1));
  return { byId: result, finish: toISO(finish), critical, warnings, loop };
}

/**
 * The target dates that would make the plan match the forecast: { id: { start, due } } for every unfinished,
 * dated item whose forecast differs from its targets. Nothing is saved; the page shows this as a preview.
 */
export function proposeDates(items, plan) {
  const out = {};
  for (const it of items) {
    const p = plan.byId.get(it.id);
    if (!p || it.category === 'done' || (!it.start_date && !it.due_date)) continue;
    const start = it.is_milestone ? null : p.start;
    if ((it.start_date || null) !== (it.is_milestone ? it.start_date || null : start) || it.due_date !== p.finish) {
      out[it.id] = { start: it.is_milestone ? it.start_date || null : start, due: p.finish };
    }
  }
  return out;
}

/** The days a calendar event falls on between two ISO dates (repeat: none | weekly | biweekly | monthly). */
export function occurrences(ev, from, to) {
  const out = [];
  const a = toDay(from);
  const b = Math.min(toDay(to), toDay(ev.repeat_until) ?? Infinity);
  const first = toDay(ev.starts_on);
  const len = (toDay(ev.ends_on) ?? first) - first;
  const push = (d) => d + len >= a && d <= b && out.push({ start: toISO(d), end: toISO(d + len) });
  if (ev.repeat === 'weekly' || ev.repeat === 'biweekly') {
    const step = ev.repeat === 'weekly' ? 7 : 14;
    for (let d = first; d <= b; d += step) push(d);
  } else if (ev.repeat === 'monthly') {
    const base = new Date(first * DAY);
    for (let i = 0; i < 240; i++) {
      const d = Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + i, 1) / DAY;
      const last = Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + i + 1, 0) / DAY;
      const day = Math.min(d + base.getUTCDate() - 1, last);
      if (day > b) break;
      push(day);
    }
  } else push(first);
  return out;
}
