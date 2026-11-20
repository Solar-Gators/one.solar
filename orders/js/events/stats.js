/**
 * Events (064): attendance stats, worked out in the browser from what the person may read (leads with "See
 * attendance" read everything). Pure functions, tested in tests/eventsModules.test.mjs.
 *
 *   data = { events, invitees, rsvps, attendance, people, org, divisions, subsystems }
 *     org: person_org rows { user_id, division_id, subsystem_id (null: the whole division) }
 *   filters = { categories: [ids] (none: all), semester: 'Fall 2026', from: 'YYYY-MM-DD', to, division, subsystem, role,
 *               now: Date, noIsExcused: true }
 *
 * Nothing here weighs one event over another: the team decides what the numbers mean.
 */
import { semesterOf, hasStarted, standing } from './core.js';

const key = (e, u) => `${e}|${u}`;

/** Every invitation, RSVP and check-in by event and person. */
export function indexOf(data) {
  const recs = new Map();
  const rec = (e, u) => {
    const k = key(e, u);
    if (!recs.has(k)) recs.set(k, { event_id: e, user_id: u, invited: false, excused: false, rsvp: null, att: null });
    return recs.get(k);
  };
  for (const i of data.invitees || []) Object.assign(rec(i.event_id, i.user_id), { invited: true, excused: !!i.excused, excused_note: i.excused_note || '' });
  for (const r of data.rsvps || []) rec(r.event_id, r.user_id).rsvp = r;
  for (const a of data.attendance || []) rec(a.event_id, a.user_id).att = a;
  return recs;
}

/** The events the stats count: not cancelled, already started, and in the filters' categories, semester and dates. */
export function countedEvents(data, f = {}) {
  const now = f.now || new Date();
  return (data.events || []).filter((e) => !e.cancelled_at && hasStarted(e, now)
    && (!f.categories?.length || f.categories.includes(e.category_id))
    && (!f.semester || semesterOf(e.starts_at) === f.semester)
    && (!f.from || e.starts_at.slice(0, 10) >= f.from)
    && (!f.to || e.starts_at.slice(0, 10) <= f.to))
    .sort((a, z) => (a.starts_at < z.starts_at ? -1 : 1));
}

/** Where each person is on the team: division ids and subsystem ids. */
export function placesOf(data) {
  const out = new Map();
  for (const o of data.org || []) {
    if (!out.has(o.user_id)) out.set(o.user_id, { divisions: new Set(), subsystems: new Set() });
    out.get(o.user_id).divisions.add(o.division_id);
    if (o.subsystem_id) out.get(o.user_id).subsystems.add(o.subsystem_id);
  }
  return out;
}

/** The people the filters keep (division, subsystem, position). */
export function peopleIn(data, f = {}) {
  const places = placesOf(data);
  return (data.people || []).filter((p) => {
    const at = places.get(p.id);
    if (f.division && !at?.divisions.has(f.division)) return false;
    if (f.subsystem && !at?.subsystems.has(f.subsystem)) return false;
    if (f.role && !(p.roles || []).includes(f.role)) return false;
    return true;
  });
}

const rate = (came, of) => (of > 0 ? came / of : null);

/**
 * One row per person: invited, came (all check-ins, walk-ins too), came late, walk-ins, excused, missed, the
 * rate (events they came to out of those they were invited to and not excused from), when they last came, and
 * how many of each category they came to.
 */
export function peopleStats(data, f = {}) {
  const recs = indexOf(data);
  const events = countedEvents(data, f);
  const opts = { now: f.now || new Date(), noIsExcused: f.noIsExcused !== false };
  return peopleIn(data, f).map((p) => {
    const row = { person: p, invited: 0, came: 0, cameInvited: 0, late: 0, walkIns: 0, excused: 0, missed: 0, lastCame: '', byCategory: {} };
    for (const e of events) {
      const r = recs.get(key(e.id, p.id));
      if (!r) continue;
      const s = standing(e, r, opts);
      if (s === 'invited') continue;   // still going on and not checked in yet: doesn't count either way
      if (r.invited) row.invited++;
      if (s === 'came' || s === 'late') {
        row.came++;
        if (r.invited) row.cameInvited++;
        else row.walkIns++;
        if (s === 'late') row.late++;
        if (e.starts_at > row.lastCame) row.lastCame = e.starts_at;
        row.byCategory[e.category_id || ''] = (row.byCategory[e.category_id || ''] || 0) + 1;
      } else if (s === 'excused') row.excused++;
      else if (s === 'missed') row.missed++;
    }
    row.rate = rate(row.cameInvited, row.invited - row.excused);
    return row;
  });
}

/** Who has been invited to what, for one person: every counted event they were invited to or came to. */
export function personHistory(data, personId, f = {}) {
  const recs = indexOf(data);
  const opts = { now: f.now || new Date(), noIsExcused: f.noIsExcused !== false };
  return (data.events || []).filter((e) => recs.has(key(e.id, personId)))
    .filter((e) => (!f.categories?.length || f.categories.includes(e.category_id)) && (!f.semester || semesterOf(e.starts_at) === f.semester)
      && (!f.from || e.starts_at.slice(0, 10) >= f.from) && (!f.to || e.starts_at.slice(0, 10) <= f.to))
    .sort((a, z) => (a.starts_at < z.starts_at ? 1 : -1))
    .map((e) => ({ event: e, rec: recs.get(key(e.id, personId)), standing: standing(e, recs.get(key(e.id, personId)), opts) }));
}

/**
 * One event's numbers: invited, RSVPs, who came (and how many weren't invited), late, excused, missed, the
 * turnout (invited people who came, out of everyone invited), and the same by division and subsystem.
 */
export function eventStats(data, e, f = {}) {
  const recs = [...indexOf(data).values()].filter((r) => r.event_id === e.id);
  const opts = { now: f.now || new Date(), noIsExcused: f.noIsExcused !== false };
  const places = placesOf(data);
  const out = { invited: 0, yes: 0, maybe: 0, no: 0, noAnswer: 0, came: 0, cameInvited: 0, walkIns: 0, late: 0, excused: 0, missed: 0, groups: [] };
  const groups = new Map();
  const group = (kind, id) => {
    const k = `${kind}:${id}`;
    if (!groups.has(k)) {
      const list = kind === 'division' ? data.divisions : data.subsystems;
      const g = list?.find((x) => x.id === id);
      groups.set(k, { kind, id, name: g?.name || (kind === 'division' ? 'No division' : 'No subsystem'), division_id: kind === 'subsystem' ? g?.division_id || '' : id, invited: 0, came: 0 });
    }
    return groups.get(k);
  };
  for (const r of recs) {
    const s = standing(e, r, opts);
    const came = s === 'came' || s === 'late';
    if (r.invited) {
      out.invited++;
      if (r.rsvp) out[r.rsvp.answer]++;
      else out.noAnswer++;
    }
    if (came) {
      out.came++;
      if (r.invited) out.cameInvited++;
      else out.walkIns++;
      if (s === 'late') out.late++;
    }
    if (s === 'excused') out.excused++;
    if (s === 'missed') out.missed++;
    const at = places.get(r.user_id);
    const into = [...(at?.divisions || [])].map((id) => group('division', id)).concat([...(at?.subsystems || [])].map((id) => group('subsystem', id)));
    if (!at?.divisions.size) into.push(group('division', ''));
    for (const g of into) {
      if (r.invited) g.invited++;
      if (came) g.came++;
    }
  }
  out.turnout = rate(out.cameInvited, out.invited);
  out.groups = [...groups.values()].sort((a, z) => (a.kind === z.kind ? a.name.localeCompare(z.name) : a.kind === 'division' ? -1 : 1));
  return out;
}

/** Every counted event's numbers, for the Events tab (newest first). */
export function eventsTable(data, f = {}) {
  return countedEvents(data, f).reverse().map((e) => ({ event: e, ...eventStats(data, e, f) }));
}

/**
 * By division or subsystem (by: 'division' | 'subsystem'): how many people, their average rate, and how many
 * are at or above / below the threshold (0–1; only a filter, not a rule). People in several count in each.
 */
export function groupStats(data, f = {}, by = 'division', threshold = 0.5) {
  const rows = peopleStats(data, f);
  const places = placesOf(data);
  const list = by === 'division' ? data.divisions || [] : data.subsystems || [];
  const groups = new Map();
  const add = (id, row) => {
    if (!groups.has(id)) {
      const g = list.find((x) => x.id === id);
      groups.set(id, { id, name: g?.name || (by === 'division' ? 'Not in a division' : 'Not in a subsystem'), division_id: by === 'subsystem' ? g?.division_id || '' : id,
        people: 0, rated: 0, rateSum: 0, above: 0, below: 0, came: 0, invited: 0 });
    }
    const g = groups.get(id);
    g.people++;
    g.came += row.came;
    g.invited += row.invited;
    if (row.rate !== null) {
      g.rated++;
      g.rateSum += row.rate;
      if (row.rate >= threshold) g.above++;
      else g.below++;
    }
  };
  for (const row of rows) {
    const ids = [...(places.get(row.person.id)?.[by === 'division' ? 'divisions' : 'subsystems'] || [])];
    if (!ids.length) add('', row);
    for (const id of ids) add(id, row);
  }
  return [...groups.values()].map((g) => ({ ...g, avgRate: g.rated ? g.rateSum / g.rated : null }))
    .sort((a, z) => (a.id === '' ? 1 : z.id === '' ? -1 : a.name.localeCompare(z.name)));
}

/** "73%" (or "—" when there's nothing to count). */
export const pct = (r) => (r === null || r === undefined ? '—' : `${Math.round(r * 100)}%`);
