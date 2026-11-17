/**
 * evals/summary.js: the Solar Evals Summary tab's averages (team, CE division, subsystem, category; semester by semester).
 *
 *   node tests/evalSummary.test.mjs
 */
import assert from 'node:assert/strict';
import { semesterKey, bySemester, toFive, scoreEval, summarize, change, teamMakeup } from '../evals/summary.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

const SCALE = ['Unsatisfactory', 'Below', 'Meets', 'Exceeds', 'Exceptional'];
const rubric = {
  scale: SCALE,
  pages: [{ criteria: [
    { id: 'com', name: 'Communication' },
    { id: 'rel', name: 'Reliability' },
    { id: 'ce1', name: 'Criterion 1', writeIn: true },
  ] }],
};
let n = 0;
const ev = (semester, division, subsystem, ratings, extra = {}) =>
  ({ id: `e${++n}`, kind: 'ce', status: 'final', type_id: 'member', semester, division, subsystem, rubric, ratings, ...extra });

console.log('Eval summary');

test('semesters sort Spring < Summer < Fall, by year; unreadable labels last', () => {
  assert.deepEqual(['Fall 2026', 'Spring 2027', 'Spring 2026', 'Summer 2026', 'Whenever', "Fall '25"].sort(bySemester),
    ["Fall '25", 'Spring 2026', 'Summer 2026', 'Fall 2026', 'Spring 2027', 'Whenever']);
  assert.equal(semesterKey('fall 2026')[0], 20263);
});

test('ratings go on a 1–5 scale; N/O, blanks and nonsense are left out', () => {
  assert.equal(toFive(3, 5), 3);
  assert.equal(toFive(1, 3), 1);
  assert.equal(toFive(3, 3), 5);
  assert.equal(toFive(2, 3), 3);
  for (const bad of ['NO', null, '', 0, 6, 'x']) assert.equal(toFive(bad, 5), null, String(bad));
});

test("an eval's score averages its ratings; typed-in rows count toward it but aren't categories", () => {
  const s = scoreEval(ev('Fall 2026', 'Electrical', 'BMS', { com: 4, rel: 'NO', ce1: 2 }));
  assert.equal(s.avg, 3);
  assert.equal(s.rated, 2);
  assert.deepEqual([...s.cats], [['Communication', 4]]);
  assert.equal(scoreEval(ev('Fall 2026', 'Electrical', 'BMS', { com: 'NO' })), null);
});

test('team, division and subsystem averages, semester by semester; each person counts once', () => {
  const list = [
    ev('Fall 2026', 'Electrical', 'BMS', { com: 4, rel: 4 }),
    ev('Fall 2026', 'electrical ', 'bms', { com: 2, rel: 2, ce1: 2 }),   // same division and subsystem, typed differently
    ev('Fall 2026', 'Aero', 'Body', { com: 5, rel: 5 }),
    ev('Spring 2027', 'Electrical', 'BMS', { com: 5, rel: 3 }),
    ev('Spring 2027', 'Electrical', '', { com: 3, rel: 3 }),               // no subsystem: in the division only
    ev('Spring 2027', 'Electrical', 'BMS', { com: 1, rel: 1 }, { status: 'draft' }),   // drafts don't count
    ev('Spring 2027', 'Electrical', 'BMS', { com: 1, rel: 1 }, { kind: 'self' }),      // nor self-evals
    ev('Spring 2027', 'Electrical', 'BMS', { com: 1, rel: 1 }, { type_id: 'leadership' }), // nor other eval types
  ];
  const s = summarize(list, { typeId: 'member' });
  assert.deepEqual(s.semesters, ['Fall 2026', 'Spring 2027']);
  assert.equal(s.counted, 5);
  assert.deepEqual(s.team.get('Fall 2026'), { avg: (4 + 2 + 5) / 3, n: 3 });
  assert.deepEqual(s.team.get('Spring 2027'), { avg: 3.5, n: 2 });
  assert.deepEqual(s.divisions.map((d) => d.name), ['Aero', 'Electrical']);
  const el = s.divisions[1];
  assert.deepEqual(el.cells.get('Fall 2026'), { avg: 3, n: 2 });
  assert.deepEqual(el.subsystems.map((x) => x.name), ['BMS']);   // "BMS" and "bms" are one subsystem
  assert.deepEqual(el.subsystems[0].cells.get('Spring 2027'), { avg: 4, n: 1 });
  assert.deepEqual(s.divisions[0].cells.get('Spring 2027'), { avg: null, n: 0 });   // Aero had nobody that semester
  assert.equal(change(s.team.get('Fall 2026'), s.team.get('Spring 2027')), 3.5 - 11 / 3);
  assert.equal(change(s.team.get('Fall 2026'), { avg: null, n: 0 }), null);
});

test('categories: team and per-division averages for each rubric row', () => {
  const s = summarize([
    ev('Fall 2026', 'Electrical', 'BMS', { com: 4, rel: 2 }),
    ev('Fall 2026', 'Aero', 'Body', { com: 2, rel: 'NO' }),
  ]);
  assert.deepEqual(s.categories, ['Communication', 'Reliability']);
  assert.deepEqual(s.catTeam.get('Fall 2026').get('Communication'), { avg: 3, n: 2 });
  assert.deepEqual(s.catTeam.get('Fall 2026').get('Reliability'), { avg: 2, n: 1 });
  assert.deepEqual(s.catDivision.get('Fall 2026').get('Aero').get('Reliability'), { avg: null, n: 0 });
});

test('evals from before eval types (no type) count as the Member eval; missing division is grouped', () => {
  const s = summarize([ev('Fall 2026', '', '', { com: 3 }, { type_id: null })]);
  assert.equal(s.counted, 1);
  assert.deepEqual(s.divisions.map((d) => d.name), ['No division']);
});


test('team makeup: each person once per semester, by division and subsystem', () => {
  const list = [
    ev('Fall 2026', 'Electrical', 'BMS', {}, { member_id: 'kit', kind: 'self', evaluator_id: 'kit' }),
    ev('Fall 2026', 'Electrical', 'bms', {}, { member_id: 'kit' }),                // Kit's CE eval wins over the self-eval: counted once, as "bms"
    ev('Fall 2026', 'Electrical', 'Telemetry', {}, { member_id: 'ana', status: 'draft' }),
    ev('Fall 2026', 'Aero', '', {}, { member_name: 'Sam Old' }),                   // no account: counted by name
    ev('Fall 2026', 'President', '', {}, { member_id: 'pres', type_id: 'leadership' }), // other eval types don't count
    ev('Spring 2027', 'Aero', 'Body', {}, { member_id: 'kit' }),
  ];
  const m = teamMakeup(list, 'Fall 2026');
  assert.equal(m.total, 3);
  assert.deepEqual(m.divisions.map((d) => [d.name, d.count, d.noSubsystem]), [['Electrical', 2, 0], ['Aero', 1, 1]]);
  assert.deepEqual(m.divisions[0].subsystems, [{ name: 'bms', count: 1 }, { name: 'Telemetry', count: 1 }]);
  assert.equal(teamMakeup(list, 'Spring 2027').divisions[0].name, 'Aero');
});

console.log(`\n${passed} passed`);

