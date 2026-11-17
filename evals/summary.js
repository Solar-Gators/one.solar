/**
 * Solar Evals → Summary: average ratings of finished evals, semester by semester, for the team, each CE division
 * and each subsystem, and per rubric category. Pure functions (no page, no database), so they're tested on their
 * own (tests/evalSummary.test.mjs).
 *
 * How a number is worked out:
 *  - An eval's score is the average of its ratings. "N/O" and empty rows don't count.
 *  - Ratings are put on a 1–5 scale, so a form with a different number of levels still compares
 *    (1 stays 1, the top level becomes 5).
 *  - A group's average is the average of its evals' scores: every person counts once, however many rows their form had.
 *  - Only finished or shared evaluator evals count (not drafts, not self-evals).
 */

const TERMS = { winter: 0, spring: 1, summer: 2, fall: 3, autumn: 3 };

/** "Spring 2027" < "Summer 2027" < "Fall 2027" < "Spring 2028". Labels it can't read sort last, by text. */
export function semesterKey(label) {
  const m = String(label || '').match(/\b(winter|spring|summer|fall|autumn)\b\D*(\d{4}|\d{2})\b/i);
  if (!m) return [Infinity, String(label || '')];
  const y = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  return [y * 10 + TERMS[m[1].toLowerCase()], ''];
}
export const bySemester = (a, b) => {
  const [x, xs] = semesterKey(a), [y, ys] = semesterKey(b);
  return x === y ? xs.localeCompare(ys) : x - y;
};

/** A rating put on the 1–5 scale. null for N/O, blanks and anything out of range. */
export function toFive(value, levels) {
  const v = Number(value), n = Number(levels) || 5;
  if (value === 'NO' || value == null || value === '' || !Number.isFinite(v) || v < 1 || v > n || n < 2) return null;
  return 1 + ((v - 1) * 4) / (n - 1);
}

/** One eval: its average and its ratings by category (rows typed in by hand, like a CE's own criteria, aren't categories). */
export function scoreEval(e) {
  const r = e?.rubric || {}, n = r.scale?.length || 5, cats = new Map();
  let sum = 0, count = 0;
  for (const p of r.pages || []) {
    for (const c of p.criteria || []) {
      const v = toFive(e.ratings?.[c.id], n);
      if (v == null) continue;
      sum += v; count++;
      const name = String(c.name || '').trim();
      if (name && !c.writeIn) cats.set(name, (cats.get(name) || []).concat(v));
    }
  }
  const catAvg = new Map([...cats].map(([k, vs]) => [k, vs.reduce((a, b) => a + b, 0) / vs.length]));
  return count ? { avg: sum / count, rated: count, cats: catAvg } : null;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ');
const keyOf = (s) => norm(s).toLowerCase();

/** The spelling most people used for a name typed by hand ("BMS", "bms", "BMS " → "BMS"). */
function display(spellings) {
  let best = '', most = 0;
  for (const [s, n] of spellings) if (n > most || (n === most && s < best)) { best = s; most = n; }
  return best;
}

/**
 * The summary for one eval type.
 * evals: rows with kind, status, type_id, semester, division, subsystem, rubric, ratings.
 * Returns { semesters, team, divisions: [{ name, cells, subsystems: [{ name, cells }] }], categories: [names],
 *           catTeam: Map(sem → Map(cat → {avg, n})), catDivision: Map(sem → Map(div → Map(cat → {avg, n}))) },
 * where cells is Map(semester → { avg, n }).
 */
export function summarize(evals, { typeId = 'member', defaultType = 'member' } = {}) {
  const use = (evals || []).filter((e) => e.kind !== 'self' && (e.status === 'final' || e.status === 'shared')
    && (e.type_id || defaultType) === typeId);
  const scored = [];
  for (const e of use) {
    const s = scoreEval(e);
    if (s) scored.push({ e, s, sem: norm(e.semester) || 'No semester', div: norm(e.division) || 'No division', sub: norm(e.subsystem) });
  }
  const semesters = [...new Set(scored.map((x) => x.sem))].sort(bySemester);

  const cellsOf = (list) => new Map(semesters.map((sem) => {
    const xs = list.filter((x) => x.sem === sem).map((x) => x.s.avg);
    return [sem, { avg: mean(xs), n: xs.length }];
  }));

  // Divisions and their subsystems, matched without caring about capitals or extra spaces.
  const divs = new Map();
  for (const x of scored) {
    const dk = keyOf(x.div);
    if (!divs.has(dk)) divs.set(dk, { spell: new Map(), items: [], subs: new Map() });
    const d = divs.get(dk);
    d.spell.set(x.div, (d.spell.get(x.div) || 0) + 1);
    d.items.push(x);
    if (x.sub) {
      const sk = keyOf(x.sub);
      if (!d.subs.has(sk)) d.subs.set(sk, { spell: new Map(), items: [] });
      const s = d.subs.get(sk);
      s.spell.set(x.sub, (s.spell.get(x.sub) || 0) + 1);
      s.items.push(x);
    }
  }
  const divisions = [...divs.values()].map((d) => ({
    name: display(d.spell),
    cells: cellsOf(d.items),
    subsystems: [...d.subs.values()].map((s) => ({ name: display(s.spell), cells: cellsOf(s.items) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  })).sort((a, b) => (a.name === 'No division') - (b.name === 'No division') || a.name.localeCompare(b.name));

  // Categories (rubric rows) in the order they first appear on the forms.
  const categories = [];
  for (const x of scored) for (const c of x.s.cats.keys()) if (!categories.includes(c)) categories.push(c);
  const catStats = (list) => new Map(categories.map((c) => {
    const vs = list.map((x) => x.s.cats.get(c)).filter((v) => v != null);
    return [c, { avg: mean(vs), n: vs.length }];
  }));
  const catTeam = new Map(semesters.map((sem) => [sem, catStats(scored.filter((x) => x.sem === sem))]));
  const catDivision = new Map(semesters.map((sem) => [sem, new Map(divisions.map((d) => [d.name,
    catStats(scored.filter((x) => x.sem === sem && keyOf(x.div) === keyOf(d.name)))]))]));

  return { semesters, team: cellsOf(scored), divisions, categories, catTeam, catDivision, counted: scored.length };
}

/** Change between two cells (null when either is missing). */
export const change = (a, b) => (a?.avg != null && b?.avg != null ? b.avg - a.avg : null);

/**
 * Who was on the team in a semester, by CE division and subsystem: each person once, from the division and subsystem
 * on their eval that semester (an evaluator's eval is preferred to their own self-eval). Only evals of `typeId`
 * (the Member eval by default), since other types (e.g. leadership) use positions, not divisions.
 * Returns { total, divisions: [{ name, count, subsystems: [{ name, count }], noSubsystem }] }, biggest first.
 */
export function teamMakeup(evals, semester, { typeId = 'member', defaultType = 'member' } = {}) {
  const who = new Map();
  for (const e of evals || []) {
    if (norm(e.semester) !== semester || (e.type_id || defaultType) !== typeId) continue;
    const id = e.member_id || e.subject_id || (e.kind === 'self' ? e.evaluator_id : '') || `name:${keyOf(e.member_name)}`;
    if (!id || id === 'name:') continue;
    const prev = who.get(id), better = !prev || (prev.kind === 'self' && e.kind !== 'self') || (!norm(prev.division) && norm(e.division));
    if (better) who.set(id, e);
  }
  const divs = new Map();
  for (const e of who.values()) {
    const name = norm(e.division) || 'No division', dk = keyOf(name);
    if (!divs.has(dk)) divs.set(dk, { spell: new Map(), count: 0, subs: new Map(), noSubsystem: 0 });
    const d = divs.get(dk);
    d.spell.set(name, (d.spell.get(name) || 0) + 1);
    d.count++;
    const sub = norm(e.subsystem);
    if (!sub) { d.noSubsystem++; continue; }
    const sk = keyOf(sub);
    if (!d.subs.has(sk)) d.subs.set(sk, { spell: new Map(), count: 0 });
    const s = d.subs.get(sk);
    s.spell.set(sub, (s.spell.get(sub) || 0) + 1);
    s.count++;
  }
  const divisions = [...divs.values()].map((d) => ({
    name: display(d.spell), count: d.count, noSubsystem: d.noSubsystem,
    subsystems: [...d.subs.values()].map((s) => ({ name: display(s.spell), count: s.count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { total: who.size, divisions };
}
