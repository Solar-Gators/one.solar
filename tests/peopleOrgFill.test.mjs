/**
 * People's division & subsystem filled in from their Solar Evals (migration 057), against PGlite with every
 * migration loaded, plus a database that already had evals before 057 (the one-time fill).
 *
 *   node tests/peopleOrgFill.test.mjs
 */
import assert from 'node:assert/strict';
import { freshDb } from './support/supabase-stub.mjs';

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

let n = 0;
async function person(db, email, name, roles) {
  const id = `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`;
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, email, { full_name: name }]);
  await db.query(`delete from profile_roles where user_id = $1`, [id]);
  for (const r of roles) await db.query(`insert into profile_roles (user_id, role) values ($1, $2)`, [id, r]);
  return id;
}
const one = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
async function team(db) {
  const elec = (await one(db, `insert into org_divisions (name) values ('Electrical') returning id`)).id;
  const mech = (await one(db, `insert into org_divisions (name) values ('Mechanical') returning id`)).id;
  await db.query(`insert into org_subsystems (division_id, name) values ($1, 'BMS'), ($1, 'Motor Controller'), ($2, 'Suspension')`, [elec, mech]);
  return { elec, mech };
}
const evalFor = (db, who, division, subsystem, kind = 'self') => db.query(
  `insert into evals (kind, rubric, subject_id, evaluator_id, division, subsystem, updated_at)
   values ($1, '{}', $2, $2, $3, $4, now() + (random() * interval '1 second'))`, [kind, who, division, subsystem]);
const placesOf = async (db, who) => (await db.query(
  `select coalesce(s.name, d.name || ' (all)') n, p.main, p.updated_by_name by from person_org p join org_divisions d on d.id = p.division_id
   left join org_subsystems s on s.id = p.subsystem_id where p.user_id = $1 order by n`, [who])).rows;
async function as(db, uid, fn) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
  await db.exec('set role authenticated');
  try { return await fn(); } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}

console.log('People\'s division & subsystem from Solar Evals (057)');

await test('the update fills in everyone who did an eval before it, and nobody who already has one', async () => {
  let ids;
  const db = await freshDb({ before: async (d, file) => {
    if (!file.startsWith('057_')) return;
    n = 100;
    const { mech } = await team(d);
    const kim = await person(d, 'kim@ufl.edu', 'Kim', ['member']);
    const kai = await person(d, 'kai@ufl.edu', 'Kai', ['member']);
    const ned = await person(d, 'ned@ufl.edu', 'Ned', ['member']);
    const set = await person(d, 'set@ufl.edu', 'Set', ['member']);
    const odd = await person(d, 'odd@ufl.edu', 'Odd', ['member']);
    await evalFor(d, kim, 'Electrical CE', 'bms');                 // case and " CE" don't matter
    await evalFor(d, kai, 'Mechanical', '');                       // no subsystem: the whole division
    await evalFor(d, ned, 'Electrical CE', 'Suspension');          // a subsystem in another division still counts
    await evalFor(d, set, 'Electrical CE', 'BMS');
    await d.query(`insert into person_org (user_id, division_id, main) values ($1, $2, true)`, [set, mech]);   // set by hand
    await evalFor(d, odd, 'Aero CE', 'Wings');                     // nothing by that name
    ids = { kim, kai, ned, set, odd };
  } });
  assert.deepEqual(await placesOf(db, ids.kim), [{ n: 'BMS', main: true, by: 'From Solar Evals' }]);
  assert.deepEqual((await placesOf(db, ids.kai)).map((r) => r.n), ['Mechanical (all)']);
  assert.deepEqual((await placesOf(db, ids.ned)).map((r) => r.n), ['Suspension']);
  assert.deepEqual((await placesOf(db, ids.set)).map((r) => r.n), ['Mechanical (all)']);   // left alone
  assert.deepEqual(await placesOf(db, ids.odd), []);
});

const db = await freshDb();
n = 0;
const admin = await person(db, 'admin@ufl.edu', 'Ada Admin', ['admin']);
const kim = await person(db, 'kim@ufl.edu', 'Kim', ['member']);
const kai = await person(db, 'kai@ufl.edu', 'Kai', ['member']);
const { elec } = await team(db);

await test('saving an eval fills in its person once; what they set themselves is never changed', async () => {
  await evalFor(db, kim, 'Electrical CE', 'Motor Controller');
  assert.deepEqual((await placesOf(db, kim)).map((r) => r.n), ['Motor Controller']);
  await evalFor(db, kim, 'Mechanical CE', 'Suspension');   // they have one now: no change
  assert.deepEqual((await placesOf(db, kim)).map((r) => r.n), ['Motor Controller']);
  await as(db, kim, () => db.query(`select set_person_org($1, $2)`, [kim, JSON.stringify([{ division_id: elec }])]));
  await db.query(`update evals set subsystem = 'BMS' where subject_id = $1`, [kim]);
  assert.deepEqual((await placesOf(db, kim)).map((r) => r.n), ['Electrical (all)']);
});

await test('an eval whose names match nothing still saves', async () => {
  await evalFor(db, kai, 'Nope CE', 'Nothing');
  assert.equal((await one(db, `select count(*)::int c from evals where subject_id = $1`, [kai])).c, 1);
  assert.deepEqual(await placesOf(db, kai), []);
});

await test('"Fill in from Solar Evals": people managers only, after subsystems are added', async () => {
  await db.query(`insert into org_divisions (name) values ('Nope')`);
  await assert.rejects(as(db, kai, () => db.query(`select person_org_fill_from_evals() n`)), /Manage people/);
  const r = await as(db, admin, () => db.query(`select person_org_fill_from_evals() n`));
  assert.equal(r.rows[0].n, 1);
  assert.deepEqual((await placesOf(db, kai)).map((x) => x.n), ['Nope (all)']);
  assert.equal((await as(db, admin, () => db.query(`select person_org_fill_from_evals() n`))).rows[0].n, 0);
  await assert.rejects(as(db, kai, () => db.query(`select person_org_fill($1)`, [kai])), /permission denied/);
});

console.log(`\n${passed} passed`);
