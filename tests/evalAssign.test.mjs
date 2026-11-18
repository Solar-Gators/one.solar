/**
 * Solar Evals assignments (migration 053): who evaluates whom, set by Admin or the President. Run as real users
 * against PGlite with every migration loaded, the way tests/sgaa.test.mjs does.
 *
 *   node tests/evalAssign.test.mjs
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
const vp = await person('vp@ufl.edu', 'Val Vice', ['eboard', 'vp']);
const sec = await person('sec@ufl.edu', 'Sam Secretary', ['eboard', 'secretary']);
const tres = await person('tres@ufl.edu', 'Tara Treasurer', ['eboard', 'treasurer']);
const ce1 = await person('ce1@ufl.edu', 'Cy Engineer', ['ce']);
const ce2 = await person('ce2@ufl.edu', 'Cam Engineer', ['ce']);
const kid = await person('kid@ufl.edu', 'Kim Member', ['member']);

const variant = async (parent) => (await one(
  `select t.id from eval_templates t join eval_tracks k on k.id = t.track_id where (k.parent_id = $1 or k.id = $1) and t.removed_at is null order by (k.id = $1), t.created_at limit 1`, [parent])).id;
const setAssigned = (type, on) => db.query(`update eval_types set settings = jsonb_set(settings, '{assigned}', to_jsonb($2::boolean)) where id = $1`, [type, on]);
const assign = (uid, type, sk, sv, ek, ev) => by(uid, 'eval_assign', { type_id: type, subject_kind: sk, subject_value: sv, evaluator_kind: ek, evaluator_value: ev });
const assigned = async (type, uid) => (await by(admin, 'eval_assigned_evaluators', type, uid)).slice().sort();

console.log('Solar Evals assignments (053)');

await test('President, Vice President and Secretary are positions; only Admin and the President can assign', async () => {
  const roles = (await db.query(`select key, label from roles where key in ('president', 'vp', 'secretary') order by key`)).rows;
  assert.deepEqual(roles.map((r) => r.label), ['President', 'Secretary', 'Vice President']);
  const holders = (await db.query(`select role from role_permissions where permission = 'evals.assign' order by role`)).rows.map((r) => r.role);
  assert.deepEqual(holders, ['admin', 'president']);
  // The titles carry nothing else: E-board members keep the E-board position for what they can do.
  assert.equal((await one(`select count(*)::int c from role_permissions where role in ('vp', 'secretary')`)).c, 0);
  await rejects(assign(vp, 'eboard', 'role', 'vp', 'role', 'president'), /does not allow/);
  await rejects(assign(admin, 'eboard', 'role', 'vp', 'role', 'vp'), /Nobody evaluates themselves/);
  await rejects(assign(admin, 'eboard', 'role', 'nope', 'role', 'president'), /doesn't exist/);
  await rejects(assign(admin, 'eboard', 'role', 'alumni', 'role', 'president'), /doesn't exist/);
  await rejects(assign(admin, 'nope', 'role', 'vp', 'role', 'president'), /doesn't exist any more/);
});

await test('by position, with a person row replacing their positions; the same row twice is one row', async () => {
  const a1 = await assign(pres, 'eboard', 'role', 'vp', 'role', 'president');
  assert.equal(await assign(pres, 'eboard', 'role', 'vp', 'role', 'president'), a1);
  await assign(pres, 'eboard', 'role', 'treasurer', 'role', 'president');
  await assign(pres, 'eboard', 'role', 'treasurer', 'role', 'vp');
  assert.deepEqual(await assigned('eboard', vp), [pres]);
  assert.deepEqual(await assigned('eboard', tres), [pres, vp].sort());
  assert.deepEqual(await assigned('eboard', sec), []);             // not assigned: picks from the list
  assert.deepEqual(await assigned('member', vp), []);              // per eval type
  const p1 = await assign(admin, 'eboard', 'person', tres, 'person', sec);
  assert.deepEqual(await assigned('eboard', tres), [sec]);
  await by(admin, 'eval_unassign', p1);
  assert.deepEqual(await assigned('eboard', tres), [pres, vp].sort());
  // Nobody is their own evaluator, even through a position they hold.
  await assign(admin, 'eboard', 'role', 'eboard', 'role', 'secretary');
  assert.deepEqual(await assigned('eboard', sec), []);
  await db.query(`delete from eval_assignments where subject_value = 'eboard'`);
});

await test('writing an E-board eval: only an assigned evaluator, once the type uses assignments', async () => {
  const tid = await variant('leadership');
  const start = (uid, subject) => by(uid, 'eval_save', null, { type_id: 'eboard', template_id: tid, subject_id: subject });
  await setAssigned('eboard', false);
  await start(sec, vp);                                            // off: anyone on the E-board, as before
  await setAssigned('eboard', true);
  await rejects(start(sec, vp), /Val Vice is assigned to Pat President, not you/);
  assert.ok(await start(pres, vp));
  assert.ok(await start(vp, sec));                                 // the Secretary has no assignment
  // Changing who an eval is about is checked too.
  const id = await start(vp, sec);
  await rejects(by(vp, 'eval_save', id, { subject_id: vp }), /can't write your own|assigned/);
  await rejects(by(sec, 'eval_save', await start(sec, pres), { subject_id: vp }), /assigned to Pat President/);
});

await test('a self-eval (Member eval): they pick from their assigned evaluators; submitting checks again', async () => {
  const tid = await variant('master');
  await setAssigned('member', true);
  await assign(admin, 'member', 'person', kid, 'person', ce1);
  const self = await by(kid, 'eval_self_save', null, { type_id: 'member', template_id: tid, semester: 'Fall 2026', answers: { a: 'x' } });
  await rejects(by(kid, 'eval_self_save', self, { ce_id: ce2 }), /Your ce is assigned: pick Cy Engineer/i);
  await by(kid, 'eval_self_save', self, { ce_id: ce1 });
  // Assignments narrow "Who evaluates", never widen it: the Secretary can't fill out member evals.
  await assign(admin, 'member', 'person', kid, 'person', sec);
  await rejects(by(kid, 'eval_self_save', self, { ce_id: sec }), /doesn't fill out evals/);
  // Reassigned after they picked: submitting asks them to pick again.
  await db.query(`delete from eval_assignments where type_id = 'member' and evaluator_value = $1`, [ce1]);
  await db.query(`delete from eval_assignments where type_id = 'member' and evaluator_value = $1`, [sec]);
  await assign(admin, 'member', 'person', kid, 'person', ce2);
  await rejects(by(kid, 'eval_self_submit', self, true), /pick Cam Engineer/);
  await by(kid, 'eval_self_save', self, { ce_id: ce2 });
  await by(kid, 'eval_self_submit', self, true);
  // The CE starts their eval from it (already checked when it was picked).
  assert.ok(await by(ce2, 'eval_start_review', self));
  await setAssigned('member', false);
});

await test('Setup saves the "Assigned" switch with the rest of a type', async () => {
  const t = await one(`select name, description, active, settings from eval_types where id = 'eboard'`);
  await by(admin, 'eval_type_save', 'eboard', t.name, t.description, t.active, { ...t.settings, assigned: false }, 'off');
  assert.equal((await one(`select settings ->> 'assigned' a from eval_types where id = 'eboard'`)).a, 'false');
  await by(admin, 'eval_type_save', 'eboard', t.name, t.description, t.active, { ...t.settings, assigned: true }, 'on');
  assert.equal(await by(admin, 'eval_type_assigned', 'eboard'), true);
});

await test('the team can read assignments; a person or a position that goes takes its rows with it', async () => {
  const seen = await as(kid, async () => (await db.query(`select count(*)::int c from eval_assignments`)).rows[0].c);
  assert.ok(seen > 0);
  await rejects(as(kid, () => db.query(`insert into eval_assignments (type_id, subject_kind, subject_value, evaluator_kind, evaluator_value) values ('member', 'role', 'member', 'role', 'ce')`)), /permission denied/);
  await rejects(as(kid, () => db.query(`delete from eval_assignments`)), /permission denied/);
  const before = (await one(`select count(*)::int c from eval_assignments where evaluator_value = 'vp' or subject_value = 'vp'`)).c;
  assert.ok(before > 0);
  await db.query(`select set_config('request.jwt.claim.sub', '', false)`);   // as the database itself
  await db.query(`delete from roles where key = 'vp'`);
  assert.equal((await one(`select count(*)::int c from eval_assignments where evaluator_value = 'vp' or subject_value = 'vp'`)).c, 0);
  await db.query(`delete from profiles where id = $1`, [kid]);
  assert.equal((await one(`select count(*)::int c from eval_assignments where subject_value = $1`, [kid])).c, 0);
});

console.log(`\n${passed} passed`);
