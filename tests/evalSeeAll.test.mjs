/**
 * Solar Evals "See every eval (troubleshooting)" (migration 055): evals.all reads every evaluation and every
 * submitted self-eval, read only. Run as real users against PGlite with every migration loaded.
 *
 *   node tests/evalSeeAll.test.mjs
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
const seen = async (uid) => (await as(uid, () => db.query(`select id from evals`))).rows.map((r) => r.id);

let n = 0;
async function person(email, name, roles) {
  const id = `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`;
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, email, { full_name: name }]);
  await db.query(`delete from profile_roles where user_id = $1`, [id]);
  for (const r of roles) await db.query(`insert into profile_roles (user_id, role) values ($1, $2)`, [id, r]);
  return id;
}
const admin = await person('admin@ufl.edu', 'Ada Admin', ['admin']);
const ce = await person('ce@ufl.edu', 'Cy Engineer', ['ce']);
const eboard = await person('eb@ufl.edu', 'Eli Board', ['eboard']);
const kid = await person('kid@ufl.edu', 'Kim Member', ['member']);
const kid2 = await person('kid2@ufl.edu', 'Kai Member', ['member']);
const tid = (await db.query(`select t.id from eval_templates t join eval_tracks k on k.id = t.track_id
  where (k.id = 'master' or k.parent_id = 'master') and t.removed_at is null order by (k.id = 'master'), t.created_at limit 1`)).rows[0].id;

console.log('Solar Evals: see every eval (055)');

const draftEval = await by(ce, 'eval_save', null, { type_id: 'member', template_id: tid, subject_id: kid2 });
const selfDraft = await by(kid2, 'eval_self_save', null, { type_id: 'member', template_id: tid, semester: 'Fall 2026', answers: { a: 'not yet' } });
const selfSent = await by(kid, 'eval_self_save', null, { type_id: 'member', template_id: tid, semester: 'Fall 2026', ce_id: ce, answers: { a: 'done' } });
await by(kid, 'eval_self_submit', selfSent, true);

await test('Admin reads every eval (drafts too) and every submitted self-eval; self-eval drafts stay private', async () => {
  const ids = await seen(admin);
  assert.ok(ids.includes(draftEval));
  assert.ok(ids.includes(selfSent));
  assert.ok(!ids.includes(selfDraft));
  const ans = (await as(admin, () => db.query(`select answers from evals where id = $1`, [selfSent]))).rows[0].answers;
  assert.equal(ans.a, 'done');
});

await test('"See all evals" alone still follows each type\'s "Who sees what"', async () => {
  const ids = await seen(eboard);
  assert.ok(!ids.includes(draftEval));     // a draft: only its CE
  assert.ok(!ids.includes(selfSent));      // answers: once the CE's eval is finished
  assert.ok(!(await seen(kid2)).includes(draftEval));
});

await test('read only: seeing it doesn\'t let Admin change, finish or delete it', async () => {
  await rejects(by(admin, 'eval_save', draftEval, { semester: 'x' }), /Only the .* who wrote this eval/);
  await rejects(by(admin, 'eval_set_status', draftEval, 'final'), /Only|can't|isn't/i);
  await rejects(by(admin, 'eval_delete', draftEval), /Only|can't|isn't/i);
  await rejects(as(admin, () => db.query(`update evals set semester = 'x' where id = $1`, [draftEval])), /permission denied/);
});

await test('another role gets it by ticking the permission (and loses it by unticking)', async () => {
  await db.query(`insert into role_permissions (role, permission) values ('eboard', 'evals.all')`);
  assert.ok((await seen(eboard)).includes(draftEval));
  await db.query(`delete from role_permissions where role = 'eboard' and permission = 'evals.all'`);
  assert.ok(!(await seen(eboard)).includes(draftEval));
});

console.log(`\n${passed} passed`);
