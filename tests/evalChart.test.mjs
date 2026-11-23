/**
 * Solar Evals evaluation chart (migration 054): one org chart, edited by Admin or the President, that decides
 * who evaluates whom and who gives feedback. Run as real users against PGlite with every migration loaded.
 *
 *   node tests/evalChart.test.mjs
 */
import assert from 'node:assert/strict';
import { freshDb } from './support/supabase-stub.mjs';

const db = await freshDb();

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${String(err.message).split('\n').join('\n    ')}`);
    process.exitCode = 1;
  }
}
async function as(uid, fn) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid || '']);
  await db.exec(uid ? 'set role authenticated' : 'set role anon');
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}
async function rejects(promise, pattern) {
  try {
    await promise;
  } catch (err) {
    if (pattern) assert.match(`${err.message} ${err.detail || ''}`, pattern);
    return err;
  }
  throw new Error(`expected an error matching ${pattern}`);
}
const call = async (fn, ...args) =>
  (await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r;
const by = (uid, fn, ...args) => as(uid, () => call(fn, ...args));
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const sorted = (a) => (a || []).slice().sort();

let n = 0;
async function person(email, name, roles) {
  const id = `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`;
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, email, { full_name: name }]);
  await db.query(`delete from profile_roles where user_id = $1`, [id]);
  for (const r of roles) await db.query(`insert into profile_roles (user_id, role) values ($1, $2)`, [id, r]);
  return id;
}

const admin = await person('admin@ufl.edu', 'Ada Admin', ['admin']);
const pres = await person('pres@ufl.edu', 'Pat President', ['eboard', 'president']);
const vp = await person('vp@ufl.edu', 'Val Vice', ['eboard', 'vp']);
const tres = await person('tres@ufl.edu', 'Tara Treasurer', ['eboard', 'treasurer']);
const sec = await person('sec@ufl.edu', 'Sam Secretary', ['eboard', 'secretary']);
const ce1 = await person('ce1@ufl.edu', 'Cy Engineer', ['ce']);
const ce2 = await person('ce2@ufl.edu', 'Cam Engineer', ['ce']);
const lead = await person('lead@ufl.edu', 'Lee Lead', ['subsystem_lead']);
const kid = await person('kid@ufl.edu', 'Kim Member', ['member']);
const eboardOnly = await person('eb@ufl.edu', 'Eli Board', ['eboard']);

const template = async (track) => (await one(
  `select t.id from eval_templates t join eval_tracks k on k.id = t.track_id where (k.id = $1 or k.parent_id = $1) and t.removed_at is null order by (k.id = $1), t.created_at limit 1`, [track])).id;
const box = (role) => one(`select * from eval_chart where role = $1`, [role]);
const assigned = async (type, uid) => sorted(await by(admin, 'eval_assigned_evaluators', type, uid));

console.log('Solar Evals evaluation chart (054)');

await test('the chart starts as the team\'s Evaluation Flow drawing, with Subsystem Lead and Integration PM positions', async () => {
  const roles = (await db.query(`select key from roles where key in ('subsystem_lead', 'integration_pm') order by key`)).rows.map((r) => r.key);
  assert.deepEqual(roles, ['integration_pm', 'subsystem_lead']);
  const p = await box('president');
  assert.equal(p.reports_to, null);
  assert.deepEqual(p.evaluators, ['vp']);
  assert.deepEqual(sorted(p.feedback), ['ce', 'eboard']);
  assert.equal(p.type_id, 'eboard');
  assert.equal((await box('ce')).reports_to, 'president');
  assert.deepEqual((await box('ce')).feedback, ['ce']);
  assert.equal((await box('treasurer')).form_id, 'lead-treasurer');
  const m = await box('member');
  assert.equal(m.type_id, 'member');
  assert.equal(m.reports_to, 'subsystem_lead');
  assert.deepEqual(m.evaluators, ['ce']);
  assert.deepEqual(m.feedback_pick, ['subsystem_lead']);
  // Nothing changes until someone turns it on.
  assert.deepEqual(await assigned('member', kid), []);
  assert.equal((await one(`select settings -> 'evaluators' ->> 'rule' r from eval_types where id = 'member'`)).r, 'permission');
});

await test('only Admin or the President edit it; no loops; removing a box moves the ones under it up', async () => {
  await rejects(by(vp, 'eval_chart_save', 'secretary', { reports_to: 'president', type_id: 'eboard', evaluators: ['president'] }), /does not allow/);
  await rejects(by(pres, 'eval_chart_save', 'president', { reports_to: 'ce', type_id: 'eboard', evaluators: ['vp'] }), /under itself/);
  await rejects(by(pres, 'eval_chart_save', 'ce', { reports_to: 'ce', type_id: 'eboard' }), /under itself/);
  await rejects(by(pres, 'eval_chart_save', 'ce', { reports_to: 'president', type_id: 'eboard', evaluators: ['nope'] }), /doesn't exist/);
  await rejects(by(pres, 'eval_chart_save', 'guest', { type_id: 'member' }), /doesn't exist/);
  await rejects(by(pres, 'eval_chart_save', 'inventory_manager', { reports_to: 'admin', type_id: 'member' }), /on the chart first/);
  await by(pres, 'eval_chart_save', 'inventory_manager', { reports_to: 'secretary', type_id: 'member', evaluators: ['secretary'] });
  await by(pres, 'eval_chart_save', 'admin', { reports_to: 'inventory_manager', type_id: 'member', evaluators: ['inventory_manager'] });
  await by(admin, 'eval_chart_remove', 'inventory_manager');
  assert.equal((await box('admin')).reports_to, 'secretary');
  await by(admin, 'eval_chart_remove', 'admin');
  assert.equal(await box('admin'), undefined);
});

await test('"Use the chart": Admin or the President switch an eval type over, and back to its old rules', async () => {
  await rejects(by(ce1, 'eval_chart_use', 'member', true), /does not allow/);   // (E-board can: they "Set up Solar Evals")
  await by(pres, 'eval_chart_use', 'member', true);
  const s = (await one(`select settings from eval_types where id = 'member'`)).settings;
  assert.deepEqual(s.evaluators, { rule: 'chart', value: 'member', side: 'evaluator' });
  assert.deepEqual(s.subjects, { rule: 'anyone', except_others: 'member' });   // "anyone" stays (065: minus positions with their own eval)
  await by(pres, 'eval_chart_use', 'eboard', true);
  const e = (await one(`select settings from eval_types where id = 'eboard'`)).settings;
  assert.deepEqual(e.subjects, { rule: 'chart', value: 'eboard', side: 'subject' });
  await by(admin, 'eval_chart_use', 'eboard', false);
  const back = (await one(`select settings from eval_types where id = 'eboard'`)).settings;
  assert.deepEqual([back.subjects, back.evaluators, back.beforeChart], [{ rule: 'role', value: 'eboard' }, { rule: 'role', value: 'eboard' }, undefined]);
  await by(admin, 'eval_chart_use', 'eboard', true);
  assert.equal((await one(`select count(*)::int c from eval_type_history where type_id = 'eboard' and note like '%chart%'`)).c, 3);
});

await test('members: their CE evaluates them (from the chart); anyone else is refused', async () => {
  assert.deepEqual(await assigned('member', kid), sorted([ce1, ce2]));
  const self = await by(kid, 'eval_self_save', null, { type_id: 'member', template_id: await template('master'), semester: 'Fall 2026', answers: { a: 'x' } });
  await rejects(by(kid, 'eval_self_save', self, { ce_id: eboardOnly }), /doesn't fill out evals/);
  await by(kid, 'eval_self_save', self, { ce_id: ce1, input_ids: [lead] });
  await by(kid, 'eval_self_submit', self, true);
  const ceEval = await by(ce1, 'eval_start_review', self);
  assert.deepEqual((await one(`select input_ids from evals where id = $1`, [ceEval])).input_ids, [lead]);
  // An E-board member who isn't a CE can't write member evals any more.
  await rejects(by(eboardOnly, 'eval_save', null, { type_id: 'member', template_id: await template('master'), subject_id: kid }), /don't write/);
  // A person row (053) still wins over the chart.
  await by(admin, 'eval_assign', { type_id: 'member', subject_kind: 'person', subject_value: kid, evaluator_kind: 'person', evaluator_value: ce2 });
  assert.deepEqual(await assigned('member', kid), [ce2]);
  await db.query(`delete from eval_assignments`);
});

await test('leadership: the chart picks the evaluator and adds the feedback people as input', async () => {
  const tid = await template('leadership');
  const start = (uid, subject) => by(uid, 'eval_save', null, { type_id: 'eboard', template_id: tid, subject_id: subject });
  // The Treasurer: evaluated by the President, feedback from the CEs.
  await rejects(start(ce1, tres), /You give feedback on Tara Treasurer's eval; you don't write it/);   // 065 (was "assigned to Pat President, not you")
  await rejects(start(eboardOnly, tres), /don't write/);              // E-board alone isn't on the chart
  const t = await start(pres, tres);
  const row = await one(`select input_ids, lead_id from evals where id = $1`, [t]);
  assert.deepEqual(sorted(row.input_ids), sorted([ce1, ce2]));
  // The President: evaluated by the VP, feedback from the rest of the E-board and the CEs (not the VP, not themselves).
  const p = await start(vp, pres);
  assert.deepEqual(sorted((await one(`select input_ids from evals where id = $1`, [p])).input_ids), sorted([tres, sec, eboardOnly, ce1, ce2]));
  // A CE: feedback from the other CEs only.
  const c = await start(pres, ce1);
  assert.deepEqual((await one(`select input_ids from evals where id = $1`, [c])).input_ids, [ce2]);
  // The limit (3) counts people you add, not the chart's: taking one off is fine, adding one more isn't.
  await by(vp, 'eval_save', p, { input_ids: [tres, sec, eboardOnly, ce1] });
  await rejects(by(vp, 'eval_save', p, { input_ids: [tres, sec, eboardOnly, ce1, lead] }), /Pick up to 3/);
  await by(vp, 'eval_save', p, { input_ids: [tres, sec, eboardOnly, lead] });   // a swap is fine
});

await test('a subsystem lead is on the leadership eval, evaluated by the CEs; the team reads the chart', async () => {
  assert.deepEqual(await assigned('eboard', lead), sorted([ce1, ce2]));
  assert.ok(await by(ce2, 'eval_save', null, { type_id: 'eboard', template_id: await template('leadership'), subject_id: lead }));
  const seen = await as(kid, async () => (await db.query(`select count(*)::int c from eval_chart`)).rows[0].c);
  assert.ok(seen >= 9);
  await rejects(as(kid, () => db.query(`update eval_chart set note = 'x'`)), /permission denied/);
  // A position that goes comes off the chart's lists.
  await db.query(`delete from roles where key = 'integration_pm'`);
  assert.equal(await box('integration_pm'), undefined);
});

await test('positions that already exist under another key, by name, are used (the live database had a "Subsystem Lead")', async () => {
  const old = await freshDb({ upTo: 54, before: async (d, file) => {
    if (file.startsWith('054')) await d.exec(`insert into roles (key, label, sort) values ('lead', 'Subsystem Lead', 20), ('pres', 'president', 21)`);
  } });
  const rows = (await old.query(`select role, reports_to, evaluators, feedback_pick from eval_chart order by sort`)).rows;
  assert.deepEqual(rows.find((r) => r.role === 'lead'), { role: 'lead', reports_to: 'ce', evaluators: ['ce'], feedback_pick: [] });
  assert.equal(rows.find((r) => r.role === 'member').reports_to, 'lead');
  assert.deepEqual(rows.find((r) => r.role === 'member').feedback_pick, ['lead']);
  assert.equal((await old.query(`select count(*)::int c from roles where key = 'subsystem_lead'`)).rows[0].c, 0);
  assert.equal(rows.find((r) => r.role === 'president').reports_to, null);   // 053 made "president"; it's used first
});

console.log(`\n${passed} passed`);
