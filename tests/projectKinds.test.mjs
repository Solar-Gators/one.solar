/**
 * Projects: the team-wide kinds of work and car cycles (migration 063), against PGlite with every migration
 * loaded, plus a database that already had projects before 063 (kinds of one name become one team kind).
 *
 *   node tests/projectKinds.test.mjs
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
async function as(db, uid, fn) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
  await db.exec('set role authenticated');
  try { return await fn(); } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}
const by = (db, uid, fn, ...args) => as(db, uid, async () =>
  (await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r);
async function rejects(promise, pattern, code) {
  try { await promise; } catch (err) {
    assert.match(err.message, pattern);
    if (code) assert.equal(err.code, code);
    return;
  }
  throw new Error(`expected an error matching ${pattern}`);
}
const kindsOf = async (db, project) => (await db.query(
  `select t.name, t.color, t.kind_id is not null as team, t.archived_at is not null as hidden from pm_types t where t.project_id = $1 order by t.name`, [project])).rows;

console.log('Kinds of work and car cycles (063)');

await test('the update makes one team kind per name, from the projects that already had them', async () => {
  let ids;
  const db = await freshDb({ before: async (d, file) => {
    if (!file.startsWith('063_')) return;
    n = 100;
    const admin = await person(d, 'old-admin@ufl.edu', 'Ada', ['admin']);
    const bat = await by(d, admin, 'pm_save_project', null, { key: 'BAT', name: 'Battery' });
    const aero = await by(d, admin, 'pm_save_project', null, { key: 'AERO', name: 'Aero' });
    // Aero calls it "task" in a different color, and has a kind of its own
    await d.query(`update pm_types set name = 'task', color = 'pink' where project_id = $1 and name = 'Task'`, [aero.id]);
    await d.query(`insert into pm_types (project_id, name, color, workflow_id) select $1, 'Wind tunnel run', 'teal', workflow_id from pm_types where project_id = $1 limit 1`, [aero.id]);
    ids = { bat: bat.id, aero: aero.id };
  } });
  const kinds = (await db.query(`select name from pm_kinds order by name`)).rows.map((r) => r.name);
  assert.ok(kinds.some((k) => k.toLowerCase() === 'task') && kinds.includes('Wind tunnel run'), kinds.join(', '));
  assert.equal(kinds.filter((k) => k.toLowerCase() === 'task').length, 1);
  const task = async (p) => (await db.query(`select t.kind_id, t.color from pm_types t where t.project_id = $1 and lower(t.name) = 'task'`, [p])).rows[0];
  const [a, z] = [await task(ids.bat), await task(ids.aero)];
  assert.equal(a.kind_id, z.kind_id);
  assert.equal(a.color, z.color, 'one look everywhere');
});

const db = await freshDb();
const admin = await person(db, 'admin@ufl.edu', 'Ada Admin', ['admin']);
const ce = await person(db, 'ce@ufl.edu', 'Cara Chief', ['ce']);
const lead = await person(db, 'lead@ufl.edu', 'Lee Lead', ['subsystem_lead']);
const member = await person(db, 'member@ufl.edu', 'Mia Member', ['member']);
const bat = await by(db, admin, 'pm_save_project', null, { key: 'BAT', name: 'Battery' });
const aero = await by(db, ce, 'pm_save_project', null, { key: 'AERO', name: 'Aero' });

await test('leads (Subsystem Lead, Chief Engineer, E-board) and Admins may change the list; members and titles may not', async () => {
  const perms = async (r) => (await db.query(`select 1 from role_permissions where role = $1 and permission = 'projects.kinds'`, [r])).rows.length;
  for (const r of ['subsystem_lead', 'ce', 'eboard', 'admin']) assert.equal(await perms(r), 1, r);
  for (const r of ['member', 'president', 'vp']) assert.equal(await perms(r), 0, r);
  assert.equal(await by(db, lead, 'pm_may_edit_kinds'), true);
  assert.equal(await by(db, member, 'pm_may_edit_kinds'), false);
  await rejects(by(db, member, 'pm_save_kind', null, { name: 'Calc' }), /Only leads/, '42501');
});

let calc;
await test('a new kind is in every project at once, on that project\'s main workflow', async () => {
  calc = await by(db, lead, 'pm_save_kind', null, { name: 'Calc', icon: '∑', color: 'purple' });
  for (const p of [bat, aero]) {
    const row = (await db.query(`select t.*, (t.workflow_id = pmx_main_workflow(t.project_id)) as main from pm_types t where t.project_id = $1 and t.kind_id = $2`, [p.id, calc.id])).rows[0];
    assert.ok(row, p.key);
    assert.equal(row.name, 'Calc');
    assert.equal(row.color, 'purple');
    assert.equal(row.main, true);
  }
  await rejects(by(db, lead, 'pm_save_kind', null, { name: ' calc ' }), /already a kind/, 'OS412');
});

await test('a project made later gets the team kinds too', async () => {
  const mc = await by(db, ce, 'pm_save_project', null, { key: 'MC', name: 'Motor controller' });
  assert.ok((await kindsOf(db, mc.id)).some((k) => k.name === 'Calc' && k.team));
});

await test('renaming or recoloring changes it in every project; a project can\'t rename it on its own', async () => {
  await by(db, ce, 'pm_save_kind', calc.id, { name: 'Calculation', color: 'teal' });
  for (const p of [bat, aero]) assert.ok((await kindsOf(db, p.id)).some((k) => k.name === 'Calculation' && k.color === 'teal'), p.key);
  const t = (await db.query(`select id from pm_types where project_id = $1 and kind_id = $2`, [bat.id, calc.id])).rows[0].id;
  await by(db, admin, 'pm_save_type', bat.id, t, { name: 'My calc', color: 'red' });
  assert.ok((await kindsOf(db, bat.id)).some((k) => k.name === 'Calculation' && k.color === 'teal'), 'the team look stays');
});

await test('a rename that would clash with a project\'s own kind says which projects', async () => {
  const wf = (await db.query(`select pmx_main_workflow($1) w`, [aero.id])).rows[0].w;
  await db.query(`insert into pm_types (project_id, name, workflow_id) values ($1, 'Analysis', $2)`, [aero.id, wf]);
  await rejects(by(db, lead, 'pm_save_kind', calc.id, { name: 'Analysis' }), /AERO already have a kind called "Analysis"/);
});

await test('retiring hides it everywhere; putting it back shows it again, except where a project hid it itself', async () => {
  const mine = await by(db, lead, 'pm_save_kind', null, { name: 'Test plan', color: 'amber' });
  const hidden = (await db.query(`select id from pm_types where project_id = $1 and kind_id = $2`, [aero.id, mine.id])).rows[0].id;
  await by(db, ce, 'pm_save_type', aero.id, hidden, { archived: true });           // Aero doesn't use it
  await by(db, lead, 'pm_save_kind', mine.id, { archived: true });
  assert.ok((await kindsOf(db, bat.id)).find((k) => k.name === 'Test plan').hidden);
  await by(db, lead, 'pm_save_kind', mine.id, { archived: false });
  assert.equal((await kindsOf(db, bat.id)).find((k) => k.name === 'Test plan').hidden, false);
  assert.equal((await kindsOf(db, aero.id)).find((k) => k.name === 'Test plan').hidden, true, 'Aero had hidden it');
});

await test('the usage count is per kind: projects showing it, items of it', async () => {
  const t = (await db.query(`select id from pm_types where project_id = $1 and kind_id = $2`, [bat.id, calc.id])).rows[0].id;
  await by(db, admin, 'pm_create_item', '00000000-0000-4000-8000-0000000000c1', { project_id: bat.id, type_id: t, title: 'Busbar ampacity' });
  const use = await by(db, member, 'pm_kind_usage');
  assert.equal(use[calc.id].items, 1);
  assert.equal(use[calc.id].projects, 3);
});

await test('car cycles: one is current; making another current moves the flag; dates must be in order', async () => {
  const c7 = await by(db, ce, 'pm_save_program', null, { name: 'Car 7', start_date: '2025-08-20', end_date: '2027-07-01' });
  assert.equal(c7.is_current, true, 'the first one is current');
  const c8 = await by(db, ce, 'pm_save_program', null, { name: 'Car 8', start_date: '2027-01-10' });
  assert.equal(c8.is_current, false);
  await by(db, ce, 'pm_save_program', c8.id, { current: true });
  const cur = (await db.query(`select name from pm_programs where is_current`)).rows.map((r) => r.name);
  assert.deepEqual(cur, ['Car 8']);
  await rejects(by(db, ce, 'pm_save_program', null, { name: 'Bad', start_date: '2027-05-01', end_date: '2027-01-01' }), /end is before the start/);
  await rejects(by(db, member, 'pm_save_program', null, { name: 'Car 9' }), /Create projects/, '42501');
});

console.log(`\n${passed} passed`);
