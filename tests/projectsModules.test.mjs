/**
 * Projects: the pure modules (no database, no browser): the scheduling engine, Smart Links, calculated
 * fields, and the small helpers the pages share.
 *
 *   node tests/projectsModules.test.mjs
 */
import assert from 'node:assert/strict';
import { schedule, makeCalendar, toDay, toISO, durationOf, proposeDates, occurrences } from '../orders/js/projects/schedule.js';
import { recognise, resourceIcon, guessCategory } from '../orders/js/projects/links.js';
import { evalFormula, checkFormula, formulaRefs } from '../orders/js/projects/formula.js';
import { linkFromUrl, exactFirst } from '../orders/js/linkParse.js';
import { layoutFor, movesFor, moveTo, moveNeeds, boardColumns, rankBetween, progressOf, attention, workload, findMentions, filterText, fieldLabel, unreachableStatuses, treeOrder } from '../orders/js/projects/core.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${String(err.message).split('\n').join('\n    ')}`);
    process.exitCode = 1;
  }
}

// 2027-01-04 is a Monday.
const TODAY = '2027-01-04';
const item = (id, start, due, extra = {}) => ({ id, key: id, start_date: start, due_date: due, category: 'todo', ...extra });
const plan = (items, deps, opts = {}, settings = {}) => schedule(items, deps, settings, { today: TODAY, ...opts });
const dep = (from_item, to_item, kind = 'FS', lag_days = 0) => ({ from_item, to_item, kind, lag_days });

console.log('Working calendar');

test('working days skip weekends and days off', () => {
  const cal = makeCalendar({ working_days: [1, 2, 3, 4, 5], holidays: ['2027-01-06'] });
  assert.equal(cal.isWork(toDay('2027-01-04')), true);
  assert.equal(cal.isWork(toDay('2027-01-09')), false, 'Saturday');
  assert.equal(cal.isWork(toDay('2027-01-06')), false, 'a day off');
  assert.equal(toISO(cal.add(toDay('2027-01-05'), 1)), '2027-01-07', 'over the day off');
  assert.equal(toISO(cal.add(toDay('2027-01-08'), 1)), '2027-01-11', 'over the weekend');
  assert.equal(toISO(cal.add(toDay('2027-01-11'), -1)), '2027-01-08');
  assert.equal(toISO(cal.add(toDay('2027-01-09'), 0)), '2027-01-11', 'a weekend day lands on Monday');
  assert.equal(cal.span(toDay('2027-01-04'), toDay('2027-01-08')), 4);
  const sixDay = makeCalendar({ working_days: [1, 2, 3, 4, 5, 6] });
  assert.equal(toISO(sixDay.add(toDay('2027-01-08'), 1)), '2027-01-09');
});

test('an item\'s length: its dates, else its estimate at 8 hours a day, else one day; a milestone has none', () => {
  const cal = makeCalendar();
  assert.equal(durationOf(item('a', '2027-01-04', '2027-01-08'), cal), 5);
  assert.equal(durationOf(item('a', '2027-01-08', '2027-01-11'), cal), 2, 'Friday and Monday');
  assert.equal(durationOf(item('a', null, null, { estimate_hours: 20 }), cal), 3);
  assert.equal(durationOf(item('a', null, null), cal), 1);
  assert.equal(durationOf(item('a', null, '2027-01-08', { is_milestone: true }), cal), 0);
});

console.log('Scheduling');

test('finish-to-start: the next item starts the working day after, over a weekend', () => {
  const p = plan([item('a', '2027-01-04', '2027-01-08'), item('b', '2027-01-11', '2027-01-13')], [dep('a', 'b')]);
  assert.deepEqual([p.byId.get('a').start, p.byId.get('a').finish], ['2027-01-04', '2027-01-08']);
  assert.deepEqual([p.byId.get('b').start, p.byId.get('b').finish], ['2027-01-11', '2027-01-13']);
  assert.deepEqual(p.warnings, []);
  assert.equal(p.finish, '2027-01-13');
});

test('all four kinds of dependency, with lag and lead', () => {
  const a = item('a', '2027-01-04', '2027-01-08');
  const b = item('b', null, null, { estimate_hours: 16 }); // 2 days
  const at = (kind, lag) => {
    const r = plan([a, b], [dep('a', 'b', kind, lag)]).byId.get('b');
    return [r.start, r.finish];
  };
  assert.deepEqual(at('FS', 0), ['2027-01-11', '2027-01-12']);
  assert.deepEqual(at('FS', 2), ['2027-01-13', '2027-01-14']);
  assert.deepEqual(at('FS', -1), ['2027-01-08', '2027-01-11'], 'one day of lead: overlaps the last day');
  assert.deepEqual(at('SS', 0), ['2027-01-04', '2027-01-05']);
  assert.deepEqual(at('SS', 2), ['2027-01-06', '2027-01-07']);
  assert.deepEqual(at('FF', 0), ['2027-01-07', '2027-01-08'], 'finishes when a finishes');
  assert.deepEqual(at('FF', 1), ['2027-01-08', '2027-01-11']);
  assert.deepEqual(at('SF', 3), ['2027-01-06', '2027-01-07'], 'finishes 3 days after a starts');
});

test('a delayed item gives an accurate warning and pushes what depends on it', () => {
  // a was due Friday the 8th but is still going on Wednesday the 13th
  const items = [
    item('a', '2027-01-04', '2027-01-08', { category: 'doing', actual_start: '2027-01-04' }),
    item('b', '2027-01-11', '2027-01-13'),
    item('c', '2027-01-14', '2027-01-15'),
  ];
  const p = plan(items, [dep('a', 'b'), dep('b', 'c')], { today: '2027-01-13' });
  assert.equal(p.byId.get('a').finish, '2027-01-13', 'can\'t finish before today');
  assert.equal(p.byId.get('a').late, 3);
  assert.deepEqual([p.byId.get('b').start, p.byId.get('b').finish], ['2027-01-14', '2027-01-18']);
  assert.deepEqual([p.byId.get('c').start, p.byId.get('c').finish], ['2027-01-19', '2027-01-20']);
  const kinds = p.warnings.map((w) => `${w.id}:${w.kind}:${w.days}`).sort();
  assert.deepEqual(kinds, ['a:late:3', 'b:dependency:3', 'b:late:3', 'c:dependency:3', 'c:late:3']);
  assert.match(p.warnings.find((w) => w.id === 'b' && w.kind === 'dependency').text, /a finishes too late: earliest start is 2027-01-14/);
  assert.equal(p.finish, '2027-01-20');
  // the target dates are untouched: the engine only reports
  assert.equal(items[1].start_date, '2027-01-11');
});

test('the critical path is the chain with no slack; a side task has slack', () => {
  const items = [
    item('design', '2027-01-04', '2027-01-08'),
    item('build', '2027-01-11', '2027-01-20'),
    item('test', '2027-01-21', '2027-01-22'),
    item('docs', '2027-01-11', '2027-01-12'),   // only needs design; has until the end
  ];
  const p = plan(items, [dep('design', 'build'), dep('build', 'test'), dep('design', 'docs')]);
  assert.deepEqual(p.critical, ['design', 'build', 'test']);
  assert.equal(p.byId.get('docs').critical, false);
  assert.equal(p.byId.get('docs').slack, 8);
  assert.equal(p.byId.get('build').slack, 0);
  assert.equal(p.byId.get('docs').lateFinish, '2027-01-22');
});

test('the critical path is recalculated when a different chain becomes the longest', () => {
  const items = [item('a', '2027-01-04', '2027-01-06'), item('b', '2027-01-04', '2027-01-05'), item('end', null, null, { is_milestone: true })];
  const deps = [dep('a', 'end'), dep('b', 'end')];
  assert.deepEqual(plan(items, deps).critical, ['a', 'end']);
  const longerB = plan(items, deps, { overrides: { b: { start: '2027-01-04', due: '2027-01-12' } } });
  assert.deepEqual(longerB.critical, ['b', 'end']);
  assert.equal(longerB.byId.get('end').finish, '2027-01-12');
  assert.equal(longerB.byId.get('a').slack, 4);
});

test('finished work stays put; work not started can\'t start in the past', () => {
  const p = plan([
    item('done', '2026-12-01', '2026-12-04', { category: 'done', completed_at: '2026-12-07T15:00:00Z', actual_start: '2026-12-01' }),
    item('late', '2026-12-14', '2026-12-16'),
  ], [dep('done', 'late')]);
  assert.deepEqual([p.byId.get('done').start, p.byId.get('done').finish], ['2026-12-01', '2026-12-07']);
  assert.equal(p.byId.get('done').critical, false);
  assert.deepEqual([p.byId.get('late').start, p.byId.get('late').finish], [TODAY, '2027-01-06']);
  assert.ok(p.warnings.some((w) => w.id === 'late' && w.kind === 'not-started'));
  assert.ok(p.warnings.some((w) => w.id === 'late' && w.kind === 'late'));
});

test('days off move the forecast; a what-if never touches the real items', () => {
  const items = [item('a', '2027-01-04', '2027-01-05'), item('b', null, null, { estimate_hours: 8 })];
  const deps = [dep('a', 'b')];
  assert.equal(plan(items, deps).byId.get('b').start, '2027-01-06');
  assert.equal(plan(items, deps, {}, { holidays: ['2027-01-06'] }).byId.get('b').start, '2027-01-07');
  const whatIf = plan(items, deps, { overrides: { a: { start: '2027-01-04', due: '2027-01-11' } } });
  assert.equal(whatIf.byId.get('b').start, '2027-01-12');
  assert.equal(items[0].due_date, '2027-01-05');
  const proposed = proposeDates([{ ...items[0], due_date: '2027-01-11' }, { ...items[1], start_date: '2027-01-06', due_date: '2027-01-06' }], whatIf);
  assert.deepEqual(proposed, { b: { start: '2027-01-12', due: '2027-01-12' } });
});

test('dependencies on items that aren\'t loaded are ignored; a loop is reported, not followed forever', () => {
  const p = plan([item('a', '2027-01-04', '2027-01-05')], [dep('elsewhere', 'a')]);
  assert.equal(p.byId.get('a').start, '2027-01-04');
  const loop = plan([item('a', null, null), item('b', null, null), item('c', null, null)], [dep('a', 'b'), dep('b', 'a')]);
  assert.deepEqual(loop.loop.sort(), ['a', 'b']);
  assert.ok(loop.byId.has('c'));
});

test('the same input always gives the same plan, and 2,000 items are quick', () => {
  const items = [];
  const deps = [];
  for (let i = 0; i < 2000; i++) {
    items.push(item(`i${i}`, null, null, { estimate_hours: 8 + (i % 5) * 8 }));
    if (i % 10) deps.push(dep(`i${i - 1}`, `i${i}`, ['FS', 'SS', 'FF'][i % 3], i % 4));
  }
  const t0 = Date.now();
  const a = plan(items, deps);
  const ms = Date.now() - t0;
  const b = plan([...items].reverse(), [...deps].reverse());
  assert.equal(a.finish, b.finish);
  assert.deepEqual(a.byId.get('i1999'), b.byId.get('i1999'));
  assert.ok(ms < 3000, `took ${ms} ms`);
});

test('calendar events repeat weekly, every two weeks or monthly, until their end date', () => {
  const ev = { starts_on: '2027-01-05', ends_on: null, repeat: 'weekly', repeat_until: '2027-01-26' };
  assert.deepEqual(occurrences(ev, '2027-01-01', '2027-02-28').map((o) => o.start), ['2027-01-05', '2027-01-12', '2027-01-19', '2027-01-26']);
  assert.equal(occurrences({ ...ev, repeat: 'biweekly', repeat_until: null }, '2027-01-01', '2027-01-31').length, 2);
  assert.deepEqual(occurrences({ starts_on: '2027-01-31', repeat: 'monthly' }, '2027-02-01', '2027-03-31').map((o) => o.start), ['2027-02-28', '2027-03-31']);
  assert.deepEqual(occurrences({ starts_on: '2027-01-05', ends_on: '2027-01-07', repeat: 'none' }, '2027-01-06', '2027-01-06'), [{ start: '2027-01-05', end: '2027-01-07' }]);
});

console.log('Smart Links');

test('SharePoint, Teams and OneDrive links are recognised from the address alone', () => {
  const sp = recognise('https://uflorida.sharepoint.com/:x:/r/sites/SolarGators/Shared%20Documents/Battery/Pack_sizing-v3.xlsx?d=wabc&csf=1&web=1&e=xyz');
  assert.deepEqual([sp.ok, sp.provider, sp.kind, sp.file_type, sp.title, sp.note], [true, 'sharepoint', 'file', 'xlsx', 'Pack sizing v3', '']);
  const folder = recognise('https://uflorida.sharepoint.com/:f:/r/sites/SolarGators/Shared%20Documents/Aerobody/Molds?csf=1&web=1');
  assert.deepEqual([folder.kind, folder.title], ['folder', 'Molds']);
  const library = recognise('https://uflorida.sharepoint.com/sites/SolarGators/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FSolarGators%2FShared%20Documents%2FChassis%2FCAD&viewid=1');
  assert.deepEqual([library.kind, library.title], ['folder', 'CAD']);
  const shared = recognise('https://uflorida.sharepoint.com/:w:/s/SolarGators/EbcDefGhijk?e=abc123');
  assert.equal(shared.file_type, 'docx');
  assert.match(shared.note, /sharing link/);
  const teams = recognise('https://teams.microsoft.com/l/file/ABC123?tenantId=1&fileType=pptx&objectUrl=https%3A%2F%2Fuflorida.sharepoint.com%2Fsites%2FSolarGators%2FShared%20Documents%2FPDR%2FPDR%20slides.pptx&threadId=19%3Aabc');
  assert.deepEqual([teams.provider, teams.kind, teams.file_type, teams.title], ['teams', 'file', 'pptx', 'PDR slides']);
  assert.equal(recognise('https://teams.microsoft.com/l/channel/19%3Aabc%40thread.tacv2/Battery?groupId=1').kind, 'folder');
  assert.equal(recognise('https://uflorida-my.sharepoint.com/:b:/g/personal/x_ufl_edu/Abc').provider, 'onedrive');
  assert.equal(recognise('https://1drv.ms/x/s!abc').provider, 'onedrive');
});

test('GitHub, CAD systems and other one.solar apps use the same link model', () => {
  const gh = recognise('https://github.com/Solar-Gators/one.solar/blob/main/docs/inventory.md');
  assert.deepEqual([gh.provider, gh.kind, gh.file_type, gh.title], ['github', 'file', 'md', 'inventory.md']);
  assert.equal(recognise('https://github.com/Solar-Gators/one.solar').kind, 'repo');
  assert.equal(recognise('https://cad.onshape.com/documents/abc/w/def/e/ghi').provider, 'onshape');
  const own = recognise('https://one.ufsolargators.org/gatorwire/#/harness/3', { siteUrl: 'https://one.ufsolargators.org/' });
  assert.deepEqual([own.provider, own.title], ['onesolar', 'one.solar: GatorWire']);
  const other = recognise('https://example.com/reports/Tensile_test.pdf');
  assert.deepEqual([other.provider, other.file_type, other.title, resourceIcon(other)], ['link', 'pdf', 'Tensile test', '📕']);
  assert.equal(guessCategory(recognise('https://x.sharepoint.com/sites/a/Shared%20Documents/top_shell.SLDPRT')), 'CAD');
});

test('unsafe or broken addresses are refused with a plain reason', () => {
  for (const bad of ['', 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'http://example.com/x', 'file:///C:/secrets.txt', 'vbscript:x',
    'not a link', 'https://example.com/a b', 'https://user:pass@example.com/x', 'https://example.com/"><script>', `https://example.com/${'a'.repeat(2100)}`]) {
    const r = recognise(bad);
    assert.equal(r.ok, false, bad);
    assert.ok(r.error.length > 5);
  }
});

console.log('Calculated fields');

test('formulas: arithmetic, comparisons, functions, and blanks that stay blank', () => {
  const it = { estimate_hours: 12, progress: 50, due_date: '2027-01-10', start_date: '2027-01-04', custom: { budget: 200, spent: '50', cells: 4, outcome: 'Pass' } };
  assert.equal(evalFormula('budget - spent', it), 150);
  assert.equal(evalFormula('round(spent / budget * 100, 1)', it), 25);
  assert.equal(evalFormula('(1 + 2) * 3 - -4', it), 13);
  assert.equal(evalFormula('max(cells, 10) + min(1, 2)', it), 11);
  assert.equal(evalFormula('days_between(start_date, due_date)', it), 6);
  assert.equal(evalFormula('outcome == \'Pass\' ? 1 : 0', it), 1);
  assert.equal(evalFormula('if(budget > 100 and not (spent > 100), "ok", "over")', it), 'ok');
  assert.equal(evalFormula('estimate_hours * (100 - progress) / 100', it), 6);
  assert.equal(evalFormula('missing * 2', it), null, 'a blank field gives a blank result');
  assert.equal(evalFormula('budget / 0', it), null);
  assert.equal(evalFormula('coalesce(missing, 7)', it), 7);
});

test('a formula can only do arithmetic: no code, no properties, no unknown functions', () => {
  const it = { custom: { a: 1 } };
  for (const evil of ['constructor', 'a.constructor', 'this', 'a[0]', 'fetch("/x")', 'eval("1")', 'a; b', '(function(){})()', '`x`', 'a = 5', '__proto__', 'window.location', 'process.exit()', 'toString()', 'constructor("return 1")()']) {
    const v = evalFormula(evil, it);
    assert.ok(v === null || v === undefined, `${evil} → ${String(v)}`);
  }
  assert.equal(evalFormula('constructor', { custom: {} }), null, 'only the item\'s own fields can be read');
  assert.match(checkFormula('budget * rate', ['budget']), /no field with the key "rate"/);
  assert.match(checkFormula('nope(1)', []), /isn't a function/);
  assert.match(checkFormula('1 +', []), /ends too soon/);
  assert.match(checkFormula('(1 + 2', []), /missing "\)"/);
  assert.equal(checkFormula('round(budget * 0.1, 2)', ['budget']), '');
  assert.deepEqual(formulaRefs('a + max(b, due_date)').sort(), ['a', 'b', 'due_date']);
});

console.log('Shared helpers');

const cfg = {
  types: [{ id: 't1', workflow_id: 'w1' }, { id: 't2', workflow_id: 'w2' }],
  fields: [{ key: 'chem', name: 'Chemistry', type_ids: [] }, { key: 'notes', name: 'Review notes', type_ids: ['t2'] }, { key: 'old', name: 'Old', type_ids: [], archived_at: 'x' }],
  layouts: [
    { type_id: null, kind: 'create', transition_id: null, sections: [{ title: 'Project form', fields: [{ key: 'owner' }] }] },
    { type_id: 't1', kind: 'create', transition_id: null, sections: [{ title: 'Type form', fields: [{ key: 'cf.chem', required: true }] }] },
    { type_id: null, kind: 'transition', transition_id: 'x2', sections: [{ title: 'On review', fields: [{ key: 'cf.notes', required: true }, { key: 'due_date' }] }] },
  ],
  transitions: [
    { id: 'x1', workflow_id: 'w1', from_status: 's1', to_status: 's2', name: 'Start', sort: 1, role_ids: [] },
    { id: 'x2', workflow_id: 'w1', from_status: 's2', to_status: 's3', name: 'Review', sort: 2, role_ids: ['r-mgr'], require_fields: ['owner'], require_comment: true },
    { id: 'x3', workflow_id: 'w1', from_status: null, to_status: 's1', name: 'Reopen', sort: 3, role_ids: [] },
    { id: 'x4', workflow_id: 'w2', from_status: null, to_status: 'z1', name: 'Other workflow', sort: 1, role_ids: [] },
    { id: 'x5', workflow_id: 'w1', from_status: null, to_status: 's2', name: 'Any → doing', sort: 9, role_ids: [] },
  ],
};

test('forms: the type\'s own layout, else the project\'s, else the standard one with the fields that apply', () => {
  assert.equal(layoutFor(cfg, 't1', 'create')[0].title, 'Type form');
  assert.equal(layoutFor(cfg, 't2', 'create')[0].title, 'Project form');
  const std = layoutFor(cfg, 't2', 'edit');
  assert.deepEqual(std[1].fields.map((f) => f.key), ['cf.chem', 'cf.notes']);
  assert.deepEqual(layoutFor(cfg, 't1', 'edit')[1].fields.map((f) => f.key), ['cf.chem'], 'not the other type\'s field, not the archived one');
  assert.deepEqual(layoutFor(cfg, 't1', 'transition', 'x1'), []);
  assert.equal(fieldLabel('cf.chem', cfg.fields), 'Chemistry');
  assert.equal(fieldLabel('due_date'), 'Due date');
});

test('moves: only the workflow\'s own, from where the item is, that the person\'s role may make', () => {
  const it = { type_id: 't1', status_id: 's2' };
  assert.deepEqual(movesFor(cfg, it).map((t) => t.name), ['Reopen']);
  assert.deepEqual(movesFor(cfg, it, { roleIds: ['r-mgr'] }).map((t) => t.name), ['Review', 'Reopen']);
  assert.deepEqual(movesFor(cfg, it, { manage: true }).map((t) => t.name), ['Review', 'Reopen']);
  assert.equal(moveTo(cfg, { type_id: 't1', status_id: 's1' }, 's2').name, 'Start', 'the specific move beats "from any"');
  assert.equal(moveTo(cfg, { type_id: 't1', status_id: 's3' }, 's2').name, 'Any → doing');
  assert.equal(moveTo(cfg, { type_id: 't1', status_id: 's1' }, 's3'), null);
  assert.equal(moveTo(cfg, { type_id: 't2', status_id: 'z0' }, 's1'), null, 'another type\'s workflow');
  const needs = moveNeeds(cfg, it, cfg.transitions[1]);
  assert.deepEqual([needs.keys, [...needs.required].sort(), needs.comment], [['owner', 'cf.notes', 'due_date'], ['cf.notes', 'owner'], true]);
});

test('board columns: saved mappings (minus deleted statuses), or statuses of the same name sharing a column', () => {
  const statuses = [{ id: 'a', name: 'To Do', category: 'todo', sort: 1 }, { id: 'b', name: 'Doing', category: 'doing', sort: 2 }, { id: 'c', name: 'Done', category: 'done', sort: 3 },
    { id: 'd', name: 'to do', category: 'todo', sort: 1 }];
  assert.deepEqual(boardColumns({ columns: [{ name: 'Open', status_ids: ['a', 'gone', 'b'], wip: '3' }, { name: 'Closed', status_ids: ['c'] }] }, statuses),
    [{ name: 'Open', wip: 3, status_ids: ['a', 'b'] }, { name: 'Closed', wip: null, status_ids: ['c'] }]);
  assert.deepEqual(boardColumns({}, statuses).map((c) => [c.name, c.status_ids]), [['To Do', ['a', 'd']], ['Doing', ['b']], ['Done', ['c']]]);
  assert.equal(rankBetween(1000, 2000), 1500);
  assert.equal(rankBetween(null, 2000), 1000);
  assert.equal(rankBetween(3000, null), 4000);
});

test('progress is shown three ways, each saying how it\'s worked out; "needs attention" has reasons', () => {
  const rows = [
    { total: 10, done: 4, doing: 3, todo: 3, overdue: 3, blocked: 1, unassigned: 4, est_total: 100, est_done: 10, est_missing: 2, ms_total: 4, ms_done: 1, ms_late: 1, next_ms: '2027-02-01' },
    { total: 10, done: 6, doing: 2, todo: 2, overdue: 2, blocked: 2, unassigned: 0, est_total: 0, est_done: 0, est_missing: 0, ms_total: 0, ms_done: 0, ms_late: 0, next_ms: '2027-01-20' },
  ];
  const p = progressOf(rows);
  assert.deepEqual([p.byCount.value, p.byEffort.value, p.byMilestones.value], [50, 10, 25]);
  assert.match(p.byEffort.how, /2 items have no estimate/);
  assert.equal(p.nextMs, '2027-01-20');
  assert.deepEqual(attention(p), ['1 milestone late', '5 of 20 items overdue', '3 items blocked', '4 open items have no owner']);
  assert.deepEqual(attention(progressOf([{ total: 5, done: 5 }])), []);
  assert.equal(progressOf([]).byCount.value, null, 'nothing to measure isn\'t 0%');
});

test('workload by week, mentions, and filters in words', () => {
  const w = workload([
    { owner_id: 'u1', estimate_hours: 10, due_date: '2027-01-06', category: 'todo' },
    { owner_id: 'u1', estimate_hours: 30, due_date: '2027-01-07', category: 'doing' },
    { owner_id: 'u1', estimate_hours: 5, due_date: '2026-12-01', category: 'todo' },
    { owner_id: 'u1', estimate_hours: 99, due_date: '2027-01-06', category: 'done' },
    { owner_id: null, estimate_hours: null, due_date: null, category: 'todo' },
  ], [{ id: 'u1' }, { id: 'u2' }], [{ user_id: 'u1', hours_per_week: 12 }], { weeks: 2, today: new Date(2027, 0, 5) });
  assert.deepEqual(w.weeks, ['2027-01-04', '2027-01-11']);
  const u1 = w.rows.find((r) => r.id === 'u1');
  assert.deepEqual([u1.byWeek['2027-01-04'], u1.late, u1.total, u1.hours], [40, 5, 45, 12]);
  assert.equal(w.rows.find((r) => r.id === '').unestimated, 1);
  assert.ok(w.rows.some((r) => r.id === 'u2' && r.total === 0));
  const people = [{ id: 'a', full_name: 'Ana Li' }, { id: 'b', full_name: 'Ana' }, { id: 'c', full_name: 'Bo Chen' }];
  assert.deepEqual(findMentions('Thanks @Ana Li and @bo chen!', people).sort(), ['a', 'b', 'c'].filter((x) => x !== 'b').concat(['b']).sort());
  assert.deepEqual(findMentions('no one here', people), []);
  assert.equal(filterText({ all: [{ f: 'mine' }, { any: [{ f: 'priority', v: 'urgent' }, { f: 'due', op: 'within', v: 7 }] }, { f: 'cf.chem', op: 'in', v: ['NMC', 'LFP'] }] }),
    '(mine and (priority is urgent or due in the next 7 days) and chem is NMC or LFP)');
});

test('069: the new conditions read in words, and the workflow check finds statuses nothing leads to', () => {
  assert.equal(filterText({ all: [{ f: 'children_done' }, { f: 'been_in', op: 'eq', v: 'Review' }, { f: 'been_in', op: 'ne', v: 'Fab' }, { f: 'parent_status', op: 'eq', v: 'Build' }] }),
    '(everything under it done and has been in Review and has never been in Fab and parent status is Build)');
  assert.equal(filterText({ f: 'children_done', v: false }), 'not everything under it done');
  const st = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase() }));
  assert.deepEqual(unreachableStatuses(st, [{ from_status: 'a', to_status: 'b' }, { from_status: 'b', to_status: 'c' }, { from_status: 'd', to_status: 'a' }]).map((s) => s.id), ['d'],
    'D only has moves out of it');
  assert.deepEqual(unreachableStatuses(st, [{ from_status: null, to_status: 'd' }, { from_status: 'd', to_status: 'c' }]).map((s) => s.id), ['b'], '"from any status" reaches D, and D reaches C');
  assert.deepEqual(unreachableStatuses(st, []).map((s) => s.id), ['b', 'c', 'd']);
  assert.deepEqual(unreachableStatuses([], []), []);
});

test('069: a pasted one.solar link becomes the record it points at', () => {
  const id = '61111aef-9515-4aae-b0c1-e3055c4ef00f';
  assert.deepEqual(linkFromUrl(`https://one.solar/events/#/events/e/${id}`), { kind: 'event', id });
  assert.deepEqual(linkFromUrl(`http://localhost:5191/sponsors/#/sponsors/${id.toUpperCase()}`), { kind: 'sponsor', id });
  assert.deepEqual(linkFromUrl(`https://one.solar/inventory/#/inventory/items/${id}`), { kind: 'inventory', id });
  assert.deepEqual(linkFromUrl('https://one.solar/orders/#/requests/sg27-900'), { kind: 'order', code: 'SG27-900' });
  assert.deepEqual(linkFromUrl('  https://one.solar/projects/#/projects/item/BPBAT-12 '), { kind: 'item', code: 'BPBAT-12' });
  assert.equal(linkFromUrl('BPBAT-12'), null, 'a number on its own is a search');
  assert.equal(linkFromUrl('https://example.com/page'), null);
  assert.equal(linkFromUrl('https://one.solar/projects/#/projects/p/BPBAT'), null, 'a project page isn\'t a record');
});

test('069: in the link picker an exact number match comes first', () => {
  const rows = [{ code: 'SG27-9001' }, { code: 'SG27-900' }, { code: 'SG27-90' }];
  assert.deepEqual(exactFirst(rows, 'sg27-900').map((r) => r.code), ['SG27-900', 'SG27-9001', 'SG27-90']);
  assert.deepEqual(exactFirst(rows, 'nickel').map((r) => r.code), rows.map((r) => r.code), 'order kept when nothing matches exactly');
});

test('W5: the List tree puts items under their parent on the same page, and folds them away', () => {
  const it = (id, parent = null) => ({ id, parent_id: parent });
  const page = [it('epic'), it('other'), it('task', 'epic'), it('sub', 'task'), it('away', 'not-on-page')];
  const t = treeOrder(page);
  assert.deepEqual(t.items.map((i) => i.id), ['epic', 'task', 'sub', 'other', 'away']);
  assert.deepEqual([...t.depth.entries()], [['epic', 0], ['task', 1], ['sub', 2], ['other', 0], ['away', 0]]);
  assert.deepEqual([...t.kids].sort(), ['epic', 'task']);
  assert.deepEqual([...treeOrder(page, new Set(['epic'])).hidden].sort(), ['sub', 'task'], 'folding the epic hides everything under it');
  assert.equal(treeOrder([it('a', 'b'), it('b', 'a')]).items.length, 2, 'a loop in the data still shows both');
});

console.log(`\n${passed} projects module tests passed${process.exitCode ? ', some failed' : ''}`);
