/**
 * Spaces (migration 072): every subsystem gets its own Workbench Space, made automatically, and the people in
 * that subsystem (person_org) work in it as Contributors without being added.
 *
 *   node tests/spaces.test.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
const call = async (fn, ...args) => (await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r;
const by = (uid, fn, ...args) => as(uid, () => call(fn, ...args));
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;

let n = 0;
async function person(email, name, roles = ['member']) {
  const id = `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`;
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, email, { full_name: name }]);
  await db.query(`delete from profile_roles where user_id = $1`, [id]);
  for (const r of roles) await db.query(`insert into profile_roles (user_id, role) values ($1, $2)`, [id, r]);
  return id;
}
const admin = await person('sp-admin@ufl.edu', 'Ada Admin', ['admin']);
const batt = await person('sp-batt@ufl.edu', 'Bea Battery');
const aero = await person('sp-aero@ufl.edu', 'Al Aero');

console.log('Spaces');
const elec = (await one(`insert into org_divisions (name) values ('Electrical') returning id`)).id;
const space = (sub) => one(`select * from pm_projects where subsystem_id = $1 and archived_at is null`, [sub]);
let battery;
let pe;

await test('a new subsystem gets its own Space, named after it, with a key from its name', async () => {
  battery = (await one(`insert into org_subsystems (division_id, name) values ($1, 'Battery') returning id`, [elec])).id;
  pe = (await one(`insert into org_subsystems (division_id, name) values ($1, 'Power Electronics') returning id`, [elec])).id;
  const s = await space(battery);
  assert.equal(s.name, 'Battery');
  assert.equal(s.key, 'BATT');
  assert.equal(s.division_id, elec);
  assert.equal(s.visibility, 'team');
  assert.equal((await space(pe)).key, 'PE');
  assert.ok((await all(`select 1 from pm_types where project_id = $1`, [s.id])).length >= 4, 'it has the starting work types (epics, tasks…)');
  // a second subsystem with a similar name gets a key of its own
  const other = (await one(`insert into org_subsystems (division_id, name) values ($1, 'Battery Box') returning id`, [elec])).id;
  assert.equal((await space(other)).key, 'BB');
  const again = (await one(`insert into org_subsystems (division_id, name) values ($1, 'Batt') returning id`, [elec])).id;
  assert.equal((await space(again)).key, 'BATT2');
});

await test('only one Space per subsystem: renaming or saving again makes no second one', async () => {
  await db.query(`update org_subsystems set name = 'Battery Pack' where id = $1`, [battery]);
  assert.equal((await one(`select count(*)::int c from pm_projects where subsystem_id = $1`, [battery])).c, 1);
  assert.equal(await call('pmx_ensure_space', battery), (await space(battery)).id);
});

await test('people in the subsystem are Contributors there without being added; others on the team only view', async () => {
  const s = await space(battery);
  await db.query(`insert into person_org (user_id, division_id, subsystem_id, main) values ($1, $2, $3, true)`, [batt, elec, battery]);
  const caps = async (uid) => (await one(`select public.pmx_caps_for($1, $2) as c`, [s.id, uid])).c;
  assert.ok((await caps(batt)).includes('create'));
  assert.ok((await caps(batt)).includes('transition'));
  assert.ok(!(await caps(batt)).includes('configure'));
  assert.ok(!(await caps(aero)).includes('create'));
  const task = (await one(`select id from pm_types where project_id = $1 and name = 'Task'`, [s.id])).id;
  const made = await by(batt, 'pm_create_item', randomUUID(), { project_id: s.id, type_id: task, title: 'Cell holder' });
  assert.match(made.key, /^BATT-\d+$/);
  await rejects(by(aero, 'pm_create_item', randomUUID(), { project_id: s.id, type_id: task, title: 'Nope' }), /Create items/);
});

await test('a private Space is still seen by its subsystem\'s people', async () => {
  const s = await space(pe);
  await db.query(`update pm_projects set visibility = 'private' where id = $1`, [s.id]);
  await db.query(`insert into person_org (user_id, division_id, subsystem_id) values ($1, $2, $3)`, [aero, elec, pe]);
  const sees = (uid) => as(uid, async () => (await db.query(`select count(*)::int c from pm_projects where id = $1`, [s.id])).rows[0].c);
  assert.equal(await sees(aero), 1);
  assert.equal(await sees(batt), 0);
});

await test('an archived subsystem keeps its Space; bringing the subsystem back doesn\'t make another', async () => {
  await db.query(`update org_subsystems set archived_at = now() where id = $1`, [pe]);
  await db.query(`update org_subsystems set archived_at = null where id = $1`, [pe]);
  assert.equal((await one(`select count(*)::int c from pm_projects where subsystem_id = $1`, [pe])).c, 1);
});

await test('the website can\'t call the Space helpers', async () => {
  await rejects(by(admin, 'pmx_ensure_space', battery), /permission denied/);
  await rejects(by(admin, 'pmx_space_key', 'X'), /permission denied/);
});

console.log('Deleting (073)');

await test('an item and everything under it can be deleted for good, by a role with "Archive and delete items" only; a dry run only counts', async () => {
  const s = await space(battery);
  const type = async (name) => (await one(`select id from pm_types where project_id = $1 and name = $2`, [s.id, name])).id;
  const epic = await by(batt, 'pm_create_item', randomUUID(), { project_id: s.id, type_id: await type('Epic'), title: 'Pack v2' });
  const task = await by(batt, 'pm_create_item', randomUUID(), { project_id: s.id, type_id: await type('Task'), title: 'Cell tabs', parent_id: epic.id });
  // a Contributor has no "Delete"; an Admin has everything
  await rejects(by(batt, 'pm_delete_item', epic.id, false), /Archive and delete items/);
  assert.equal((await by(admin, 'pm_delete_item', epic.id, true)).items, 2);
  assert.equal((await one(`select count(*)::int c from pm_items where id in ($1, $2)`, [epic.id, task.id])).c, 2, 'a dry run deletes nothing');
  const res = await by(admin, 'pm_delete_item', epic.id, false);
  assert.deepEqual(res, { key: epic.key, items: 2 });
  assert.equal((await one(`select count(*)::int c from pm_items where id in ($1, $2)`, [epic.id, task.id])).c, 0);
  assert.match((await one(`select summary from pm_events where project_id = $1 and kind = 'deleted' order by id desc limit 1`, [s.id])).summary, /Deleted BATT-\d+ "Pack v2" and 1 under it/);
});

await test('a Space is deleted only by an Admin who types its key; its subsystem gets a fresh, empty one', async () => {
  const s = await space(battery);
  const task = (await one(`select id from pm_types where project_id = $1 and name = 'Task'`, [s.id])).id;
  await by(batt, 'pm_create_item', randomUUID(), { project_id: s.id, type_id: task, title: 'Will go' });
  await rejects(by(batt, 'pm_delete_project', s.id, s.key), /Only an Admin/);
  await rejects(by(admin, 'pm_delete_project', s.id, 'NOPE'), /Type the Space's key/);
  const res = await by(admin, 'pm_delete_project', s.id, s.key.toLowerCase());
  assert.equal(res.key, s.key);
  assert.ok(res.items >= 1);
  assert.equal((await one(`select count(*)::int c from pm_projects where id = $1`, [s.id])).c, 0);
  assert.equal((await one(`select count(*)::int c from pm_items where project_id = $1`, [s.id])).c, 0);
  const fresh = await space(battery);
  assert.ok(fresh && fresh.id !== s.id, 'a new Space for the subsystem');
  assert.equal(res.new_space, fresh.key);
  assert.equal((await one(`select count(*)::int c from pm_items where project_id = $1`, [fresh.id])).c, 0);
  // a Space with no subsystem just goes
  const loose = await by(admin, 'pm_save_project', null, { key: 'LOOSE', name: 'Loose' });
  assert.equal((await by(admin, 'pm_delete_project', loose.id, 'LOOSE')).new_space, null);
});

console.log('The car is on the work (074)');

await test('a Space has no car; each item has one: given, else its parent\'s, else the current car; the car filter is the item\'s', async () => {
  const car5 = await by(admin, 'pm_save_program', null, { name: 'Car 5', start_date: '2026-08-01', current: true });
  const car6 = await by(admin, 'pm_save_program', null, { name: 'Car 6', start_date: '2027-08-01' });
  const s = await space(battery);
  assert.equal(s.program_id, null);
  const type = async (name) => (await one(`select id from pm_types where project_id = $1 and name = $2`, [s.id, name])).id;
  const now = await by(batt, 'pm_create_item', randomUUID(), { project_id: s.id, type_id: await type('Epic'), title: 'Pack for Car 5' });
  assert.equal(now.program_id, car5.id, 'the current car when none is given');
  const next = await by(batt, 'pm_create_item', randomUUID(), { project_id: s.id, type_id: await type('Epic'), title: 'Pack for Car 6', program_id: car6.id });
  assert.equal(next.program_id, car6.id);
  const child = await by(batt, 'pm_create_item', randomUUID(), { project_id: s.id, type_id: await type('Task'), title: 'Cells for 6', parent_id: next.id });
  assert.equal(child.program_id, car6.id, 'under an item: its car');
  // moved to the other car like any other field
  const moved = await by(batt, 'pm_update_item', now.id, null, { program_id: car6.id });
  assert.equal(moved.program_id, car6.id);
  await by(batt, 'pm_update_item', now.id, null, { program_id: car5.id });
  // the switcher's filter: by the item's car, in one Space
  const found = await by(batt, 'pm_search', { project: s.id, filter: { f: 'program', op: 'in', v: [car6.id] } });
  assert.deepEqual(found.items.map((i) => i.title).sort(), ['Cells for 6', 'Pack for Car 6']);
  // an archived car can't be given
  await by(admin, 'pm_save_program', car6.id, { name: 'Car 6', archived: true });
  await rejects(by(batt, 'pm_update_item', now.id, null, { program_id: car6.id }), /car cycle doesn't exist, or it's archived/);
});

console.log(`\n${passed} spaces tests passed`);
