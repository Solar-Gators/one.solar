/**
 * Solar Evals: changing who an eval's evaluator is (migration 059). Run as real users against PGlite with every
 * migration loaded.
 *
 *   node tests/evalChangeEvaluator.test.mjs
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
const row = async (id) => (await db.query(`select kind, status, ce_id, evaluator_id from evals where id = $1`, [id])).rows[0];

let n = 0;
async function person(email, name, roles) {
  const id = `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`;
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, email, { full_name: name }]);
  await db.query(`delete from profile_roles where user_id = $1`, [id]);
  for (const r of roles) await db.query(`insert into profile_roles (user_id, role) values ($1, $2)`, [id, r]);
  return id;
}
const admin = await person('admin@ufl.edu', 'Ada Admin', ['admin']);
const wrongCe = await person('ce1@ufl.edu', 'Wes Wrong', ['ce']);
const rightCe = await person('ce2@ufl.edu', 'Rita Right', ['ce']);
const kid = await person('kid@ufl.edu', 'Kim Member', ['member']);
const kid2 = await person('kid2@ufl.edu', 'Kai Member', ['member']);
const guest = await person('g@ufl.edu', 'Gus Guest', ['guest']);
const tid = (await db.query(`select t.id from eval_templates t join eval_tracks k on k.id = t.track_id
  where (k.id = 'master' or k.parent_id = 'master') and t.removed_at is null order by (k.id = 'master'), t.created_at limit 1`)).rows[0].id;

console.log('Solar Evals: change the evaluator (059)');

const self = await by(kid, 'eval_self_save', null, { type_id: 'member', template_id: tid, semester: 'Fall 2026', ce_id: wrongCe, answers: { a: 'done' } });
await by(kid, 'eval_self_submit', self, true);

await test('only "Assign evaluators" can change it; only to someone on the team, never to themselves', async () => {
  await rejects(by(wrongCe, 'eval_change_evaluator', self, rightCe, ''), /does not allow this action \(evals\.assign\)/);
  await rejects(by(admin, 'eval_change_evaluator', self, guest, ''), /isn't on the team/);
  await rejects(by(admin, 'eval_change_evaluator', self, kid, ''), /their own evaluator/);
});

await test('a self-eval goes to the new evaluator, the CE eval started from it moves along, and the change is kept', async () => {
  const review = await by(wrongCe, 'eval_start_review', self);   // the wrong CE already started the evaluation
  await by(admin, 'eval_change_evaluator', self, rightCe, 'Kim is in Rita\'s division');
  assert.equal((await row(self)).ce_id, rightCe);
  assert.equal((await row(review)).evaluator_id, rightCe);
  const log = (await as(admin, () => db.query(`select from_id, to_id, note, changed_by_name from eval_evaluator_changes where eval_id = $1`, [self]))).rows;
  assert.deepEqual(log, [{ from_id: wrongCe, to_id: rightCe, note: 'Kim is in Rita\'s division', changed_by_name: 'Ada Admin' }]);
  // the new evaluator sees both; the old one doesn't see the draft evaluation any more
  const sees = async (uid) => (await as(uid, () => db.query(`select id from evals where id = any($1)`, [[self, review]]))).rows.map((r) => r.id).sort();
  assert.ok((await sees(rightCe)).includes(review));   // the evaluation, still a draft, is theirs now
  assert.ok(!(await sees(wrongCe)).includes(review));
  assert.equal((await as(kid, () => db.query(`select count(*)::int c from eval_evaluator_changes`))).rows[0].c, 0);   // members don't see the log
});

await test('a finished evaluation has to go back to a draft first', async () => {
  const other = await by(wrongCe, 'eval_save', null, { type_id: 'member', template_id: tid, subject_id: kid2 });
  await by(wrongCe, 'eval_set_status', other, 'final');
  await rejects(by(admin, 'eval_change_evaluator', other, rightCe, ''), /already finished by Wes Wrong/);
  await by(wrongCe, 'eval_set_status', other, 'draft');
  await by(admin, 'eval_change_evaluator', other, rightCe, '');
  assert.equal((await row(other)).evaluator_id, rightCe);
});

await test('a wrong eval can be deleted at any stage, kept, and put back (linked again)', async () => {
  const self2 = await by(kid2, 'eval_self_save', null, { type_id: 'member', template_id: tid, semester: 'Fall 2026', ce_id: rightCe, answers: { a: 'oops' } });
  await by(kid2, 'eval_self_submit', self2, true);
  const review2 = await by(rightCe, 'eval_start_review', self2);
  await rejects(by(kid2, 'eval_remove', self2, ''), /does not allow this action \(evals\.assign\)/);
  await rejects(by(rightCe, 'eval_remove', self2, ''), /does not allow this action \(evals\.assign\)/);
  const del = await by(admin, 'eval_remove', self2, 'Wrong type');
  assert.equal(await row(self2), undefined);
  const linkOf = async (id) => (await db.query(`select self_eval_id from evals where id = $1`, [id])).rows[0].self_eval_id;
  assert.equal(await linkOf(review2), null);   // the evaluation started from it stays
  const kept = (await as(admin, () => db.query(`select kind, status, subject_name, evaluator_name, note, deleted_by_name, linked from eval_deletions where id = $1`, [del]))).rows[0];
  assert.deepEqual(kept, { kind: 'self', status: 'final', subject_name: 'Kai Member', evaluator_name: 'Rita Right', note: 'Wrong type', deleted_by_name: 'Ada Admin', linked: [review2] });
  assert.equal((await as(kid2, () => db.query(`select count(*)::int c from eval_deletions`))).rows[0].c, 0);   // members don't see them
  await rejects(by(kid2, 'eval_restore', del), /evals\.assign/);
  assert.equal(await by(admin, 'eval_restore', del), self2);
  assert.equal((await row(self2)).status, 'final');
  assert.equal(await linkOf(review2), self2);   // linked again
  await rejects(by(admin, 'eval_restore', del), /already put back/);
  // a finished evaluation can go too
  await by(rightCe, 'eval_set_status', review2, 'final');
  await by(admin, 'eval_remove', review2, '');
  assert.equal(await row(review2), undefined);
});

console.log(`\n${passed} passed`);
