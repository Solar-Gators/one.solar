/**
 * Solar Evals guardrails (migration 065): "except" positions on who is evaluated / who evaluates, feedback givers
 * can't write the eval, "Only who's assigned", and the check that lists evals breaking the rules. Run as real
 * users against PGlite with every migration loaded.
 *
 *   node tests/evalGuardrails.test.mjs
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
const coord = await person('coord@ufl.edu', 'Cory Coordinator', ['eboard', 'coordinator']);
const ce1 = await person('ce1@ufl.edu', 'Cy Engineer', ['ce']);
const ce2 = await person('ce2@ufl.edu', 'Cam Engineer', ['ce']);
const lead = await person('lead@ufl.edu', 'Lee Lead', ['member', 'subsystem_lead']);
const kid = await person('kid@ufl.edu', 'Kim Member', ['member']);

const template = async (track) => (await one(
  `select t.id from eval_templates t join eval_tracks k on k.id = t.track_id where (k.id = $1 or k.parent_id = $1) and t.removed_at is null order by (k.id = $1), t.created_at limit 1`, [track])).id;
const typeRow = (id) => one(`select name, description, active, settings from eval_types where id = $1`, [id]);
async function saveType(id, change) {
  const t = await typeRow(id);
  return by(admin, 'eval_type_save', id, t.name, t.description, t.active, change(structuredClone(t.settings)), 'test');
}
const selfStart = (uid) => by(uid, 'eval_self_save', null, { type_id: 'member', template_id: tid, semester: 'Fall 2026', answers: { a: 'x' } });
const tid = await template('master');

console.log('Solar Evals guardrails (065)');

let leadSelf;
await test('the Member eval leaves out people whose position has its own eval on the chart (on by default, can be turned off)', async () => {
  assert.equal((await typeRow('member')).settings.subjects.except_others, 'member');
  await rejects(selfStart(lead), /aren't someone who gets/);
  await rejects(by(ce1, 'eval_save', null, { type_id: 'member', template_id: tid, subject_id: lead }), /Lee Lead isn't someone who gets/);
  assert.ok(await selfStart(kid));
  // turned off in Setup (false drops it; true is pointed at the type)
  await saveType('member', (s) => ({ ...s, subjects: { ...s.subjects, except_others: false } }));
  assert.equal((await typeRow('member')).settings.subjects.except_others, undefined);
  leadSelf = await selfStart(lead);   // started while it's off (the check finds it below)
  await saveType('member', (s) => ({ ...s, subjects: { ...s.subjects, except_others: true } }));
  assert.equal((await typeRow('member')).settings.subjects.except_others, 'member');
  const found = await by(admin, 'eval_rule_check', 'member');
  assert.match(found.find((r) => r.id === leadSelf).problems[0], /Lee Lead is Subsystem Lead, which has its own eval, and Member eval is left out for them/);
  await saveType('member', (s) => ({ ...s, subjects: { ...s.subjects, except_others: false } }));
});

await test('"except" on who is evaluated: a Subsystem Lead can\'t start a Member eval self-eval; members still can', async () => {
  await saveType('member', (s) => ({ ...s, subjects: { ...s.subjects, except: ['subsystem_lead'] } }));
  assert.deepEqual((await typeRow('member')).settings.subjects.except, ['subsystem_lead']);
  await rejects(selfStart(lead), /aren't someone who gets/);
  assert.ok(await selfStart(kid));
  // and nobody can start one about them
  await rejects(by(ce1, 'eval_save', null, { type_id: 'member', template_id: tid, subject_id: lead }), /Lee Lead isn't someone who gets/);
});

await test('"except" only takes positions that exist (and not Guest or Alumni)', async () => {
  await rejects(saveType('member', (s) => ({ ...s, subjects: { ...s.subjects, except: ['nope'] } })), /positions to leave out doesn't exist/);
  await rejects(saveType('member', (s) => ({ ...s, subjects: { ...s.subjects, except: ['guest'] } })), /positions to leave out doesn't exist/);
  await rejects(saveType('member', (s) => ({ ...s, evaluators: { ...s.evaluators, except: 'ce' } })), /incomplete/);
});

await test('"except" on who evaluates: someone left out can\'t write one', async () => {
  await saveType('member', (s) => ({ ...s, evaluators: { ...s.evaluators, except: ['eboard'] } }));
  await db.query(`insert into profile_roles (user_id, role) values ($1, 'eboard')`, [ce2]);
  await rejects(by(ce2, 'eval_save', null, { type_id: 'member', template_id: tid, subject_id: kid }), /don't write/);
  await db.query(`delete from profile_roles where user_id = $1 and role = 'eboard'`, [ce2]);
  await saveType('member', (s) => { delete s.evaluators.except; return s; });
});

await test('the chart keeps "except" when it fills in its rules', async () => {
  await by(admin, 'eval_chart_use', 'eboard', true);
  await saveType('eboard', (s) => ({ ...s, subjects: { ...s.subjects, except: ['integration_pm'] } }));
  const s = (await typeRow('eboard')).settings;
  assert.equal(s.subjects.rule, 'chart');
  assert.deepEqual(s.subjects.except, ['integration_pm']);
  await saveType('eboard', (x) => { delete x.subjects.except; return x; });
});

await test('someone who only gives feedback on a person\'s eval can\'t write it', async () => {
  const lt = await template('leadership');
  // a CE's box: evaluated by the President, feedback from the other CEs
  await rejects(by(ce1, 'eval_save', null, { type_id: 'eboard', template_id: lt, subject_id: ce2 }),
    /You give feedback on Cam Engineer's eval; you don't write it\. You're added as input when Pat President starts it/);
  assert.ok(await by(pres, 'eval_save', null, { type_id: 'eboard', template_id: lt, subject_id: ce2 }));
});

await test('"Only who\'s assigned": nobody assigned means nobody starts it', async () => {
  const lt = await template('leadership');
  await db.query(`update eval_chart set evaluators = '{}' where role = 'coordinator'`);
  const start = () => by(pres, 'eval_save', null, { type_id: 'eboard', template_id: lt, subject_id: coord });
  const before = await start();   // off: anyone who evaluates this type may
  await saveType('eboard', (s) => ({ ...s, strict: true }));
  await rejects(start(), /Nobody is assigned to evaluate Cory Coordinator yet/);
  // the check lists the one started before
  const found = await by(admin, 'eval_rule_check', 'eboard');
  assert.ok(found.some((r) => r.id === before && r.problems.some((p) => /Nobody is assigned to evaluate Cory Coordinator/.test(p))));
});

await test('the check lists evals breaking the rules now, for setup and assigners only', async () => {
  const found = await by(admin, 'eval_rule_check', 'member');
  const row = found.find((r) => r.id === leadSelf);
  assert.ok(row, 'the lead\'s self-eval is listed');
  assert.equal(row.subject, 'Lee Lead');
  assert.match(row.problems[0], /Lee Lead is Subsystem Lead, and Member eval is left out for them/);
  assert.ok(!found.some((r) => r.subject === 'Kim Member'));
  await rejects(by(kid, 'eval_rule_check', 'member'), /does not allow/);
  await rejects(by(admin, 'eval_rule_check', 'nope'), /doesn't exist/);
});

console.log(`\n${passed} passed`);
