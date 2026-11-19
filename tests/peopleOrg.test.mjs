/**
 * Who is in which CE division and subsystem (migration 056). Run as real users against PGlite with every
 * migration loaded.
 *
 *   node tests/peopleOrg.test.mjs
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
const set = (uid, who, items) => as(uid, () => db.query(`select public.set_person_org($1, $2)`, [who, JSON.stringify(items)]));
const placesOf = async (who) => (await db.query(
  `select coalesce(s.name, d.name || ' (all)') n, p.main from person_org p join org_divisions d on d.id = p.division_id
   left join org_subsystems s on s.id = p.subsystem_id where p.user_id = $1 order by n`, [who])).rows;

let n = 0;
async function person(email, name, roles) {
  const id = `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`;
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, email, { full_name: name }]);
  await db.query(`delete from profile_roles where user_id = $1`, [id]);
  for (const r of roles) await db.query(`insert into profile_roles (user_id, role) values ($1, $2)`, [id, r]);
  return id;
}
const admin = await person('admin@ufl.edu', 'Ada Admin', ['admin']);
const elecCe = await person('ece@ufl.edu', 'Eve Electrical', ['ce']);
const newCe = await person('nce@ufl.edu', 'Ned New', ['ce']);
const kid = await person('kid@ufl.edu', 'Kim Member', ['member']);
const kid2 = await person('kid2@ufl.edu', 'Kai Member', ['member']);
const guest = await person('guest@ufl.edu', 'Gus Guest', ['guest']);

const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
// CEs can "Manage people & roles" by default, which changes anyone; take it away here to test the division limit.
await db.query(`delete from role_permissions where role = 'ce' and permission = 'users.manage'`);
const elec = (await one(`insert into org_divisions (name) values ('Electrical') returning id`)).id;
const mech = (await one(`insert into org_divisions (name) values ('Mechanical') returning id`)).id;
const bms = (await one(`insert into org_subsystems (division_id, name) values ($1, 'BMS') returning id`, [elec])).id;
const mc = (await one(`insert into org_subsystems (division_id, name) values ($1, 'Motor Controller') returning id`, [elec])).id;
const susp = (await one(`insert into org_subsystems (division_id, name) values ($1, 'Suspension') returning id`, [mech])).id;
const old = (await one(`insert into org_subsystems (division_id, name, archived_at) values ($1, 'Old Aero', now()) returning id`, [mech])).id;

console.log('People in divisions and subsystems (056)');

await test('anyone on the team sets their own: several subsystems across divisions; the first is main', async () => {
  await set(kid, kid, [{ subsystem_id: bms }, { subsystem_id: susp }]);
  assert.deepEqual(await placesOf(kid), [{ n: 'BMS', main: true }, { n: 'Suspension', main: false }]);
  await set(kid, kid, [{ subsystem_id: bms }, { subsystem_id: susp, main: true }, { subsystem_id: susp }]);   // twice is once
  assert.deepEqual(await placesOf(kid), [{ n: 'BMS', main: false }, { n: 'Suspension', main: true }]);
  await set(elecCe, elecCe, [{ division_id: elec }]);   // a whole division
  assert.deepEqual(await placesOf(elecCe), [{ n: 'Electrical (all)', main: true }]);
});

await test('a member can\'t change someone else; a guest can\'t do anything', async () => {
  await rejects(set(kid2, kid, [{ subsystem_id: mc }]), /only change subsystems in your own divisions/);
  await rejects(set(guest, guest, [{ subsystem_id: mc }]), /accepted/);
  const seen = await as(guest, async () => (await db.query(`select count(*)::int c from person_org`)).rows[0].c);
  assert.equal(seen, 0);
  assert.ok(await as(kid2, async () => (await db.query(`select count(*)::int c from person_org`)).rows[0].c) > 0);
});

await test('a CE changes people only in their own divisions', async () => {
  await set(elecCe, kid, [{ subsystem_id: bms }, { subsystem_id: mc }, { subsystem_id: susp, main: true }]);   // added Motor Controller
  assert.deepEqual((await placesOf(kid)).map((r) => r.n), ['BMS', 'Motor Controller', 'Suspension']);
  await rejects(set(elecCe, kid, [{ subsystem_id: bms }, { subsystem_id: mc }]), /not Mechanical/);            // taking away Suspension
  await rejects(set(elecCe, kid2, [{ subsystem_id: susp }]), /not Mechanical/);
  await set(elecCe, kid2, [{ subsystem_id: bms }]);
  await rejects(set(newCe, kid2, [{ subsystem_id: mc }]), /own divisions/);                                      // in no division yet
});

await test('people managers change anyone; archived subsystems stay but nobody new goes in', async () => {
  await set(admin, kid2, [{ subsystem_id: susp }, { subsystem_id: bms }]);
  await rejects(set(admin, kid2, [{ subsystem_id: old }]), /Old Aero has been archived/);
  await db.query(`insert into person_org (user_id, division_id, subsystem_id) values ($1, $2, $3)`, [kid2, mech, old]);
  await set(admin, kid2, [{ subsystem_id: susp }, { subsystem_id: old }]);   // keeps it
  assert.deepEqual((await placesOf(kid2)).map((r) => r.n), ['Old Aero', 'Suspension']);
  await set(admin, kid2, []);
  assert.deepEqual(await placesOf(kid2), []);
  await rejects(set(admin, kid2, [{ subsystem_id: '00000000-0000-0000-0000-00000000ffff' }]), /doesn't exist/);
});

await test('nobody writes the table directly; it goes when the person does', async () => {
  await rejects(as(kid, () => db.query(`delete from person_org`)), /permission denied/);
  await db.query(`delete from profiles where id = $1`, [kid]);
  assert.equal((await one(`select count(*)::int c from person_org where user_id = $1`, [kid])).c, 0);
  assert.ok((await one(`select 1 x from role_permissions where role = 'ce' and permission = 'people.subsystems'`)));
});

console.log(`\n${passed} passed`);
