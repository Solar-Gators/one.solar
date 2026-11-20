/**
 * Projects database tests (migration 051): the rules the Projects app relies on, run as real users against
 * PGlite (real Postgres in Node) with every migration loaded, the same way tests/db.test.mjs does.
 *
 *   node tests/projects.test.mjs
 *
 * PGlite has one connection, so two people can't act at the same instant here. What makes concurrent use safe
 * is checked directly: item numbers come from the project row under its lock, edits carry the version they
 * started from, and operation ids make a repeated "create" harmless.
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
async function rejects(promise, pattern, code) {
  try {
    await promise;
  } catch (err) {
    if (pattern) assert.match(`${err.message} ${err.detail || ''}`, pattern);
    if (code) assert.equal(err.code, code);
    return err;
  }
  throw new Error(`expected an error matching ${pattern}`);
}
const call = async (fn, ...args) =>
  (await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r;
const by = (uid, fn, ...args) => as(uid, () => call(fn, ...args));
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;

let n = 0;
async function person(email, name, roles = ['member']) {
  const id = `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`;
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, email, { full_name: name }]);
  if (roles.length) {
    await db.query(`delete from profile_roles where user_id = $1`, [id]);
    for (const r of roles) await db.query(`insert into profile_roles (user_id, role) values ($1, $2)`, [id, r]);
  }
  return id;
}
const admin = await person('pm-admin@ufl.edu', 'Ada Admin', ['admin']);
const ce = await person('pm-ce@ufl.edu', 'Cara Chief', ['ce']);
const pmgr = await person('pm-manager@ufl.edu', 'Pat Manager');
const member = await person('pm-member@ufl.edu', 'Mia Member');
const other = await person('pm-other@ufl.edu', 'Otto Other');
const approver = await person('pm-approver@ufl.edu', 'Abe Approver');
const guest = await person('pm-guest@ufl.edu', 'Gus Guest', []);
const former = await person('pm-former@ufl.edu', 'Fay Former', ['alumni']);

const uuid = () => randomUUID();
const role = async (project, key) => (await one(`select id from pm_roles where project_id = $1 and key = $2`, [project, key])).id;
const typeId = async (project, name) => (await one(`select id from pm_types where project_id = $1 and name = $2`, [project, name])).id;
const statusId = async (project, name) => (await one(`select id from pm_statuses where project_id = $1 and name = $2`, [project, name])).id;
const transition = async (project, to, from = null) =>
  (await one(`select t.id from pm_transitions t join pm_statuses s on s.id = t.to_status left join pm_statuses f on f.id = t.from_status
              where t.project_id = $1 and s.name = $2 and ($3::text is null or f.name = $3) order by t.from_status nulls last limit 1`, [project, to, from])).id;
const item = async (id) => one(`select i.*, s.name as status from pm_items i join pm_statuses s on s.id = i.status_id where i.id = $1`, [id]);
const create = (uid, project, type, title, extra = {}) => by(uid, 'pm_create_item', uuid(), { project_id: project, type_id: type, title, ...extra });
const visibleCount = (uid, table, where = 'true', params = []) =>
  as(uid, async () => Number((await db.query(`select count(*) c from ${table} where ${where}`, params)).rows[0].c));

// ---- access ------------------------------------------------------------------------------------------
console.log('Access');

let bat;
let private1;
await test('default access: every team role can open Projects; CEs and Admins can create; only Admins manage everything', async () => {
  const perms = async (r) => (await all(`select permission from role_permissions where role = $1 and permission like 'projects.%' order by 1`, [r])).map((x) => x.permission);
  assert.deepEqual(await perms('member'), ['projects.view']);
  assert.deepEqual(await perms('ce'), ['projects.create', 'projects.kinds', 'projects.view']);   // 063: leads edit the kinds of work
  assert.deepEqual(await perms('admin'), ['projects.create', 'projects.kinds', 'projects.manage', 'projects.view']);
  assert.deepEqual(await perms('guest'), []);
  assert.deepEqual(await perms('alumni'), []);
});

await test('an Admin creates a project: it gets roles, a workflow and types, and they are its Project Administrator', async () => {
  bat = await by(admin, 'pm_save_project', null, { key: 'bat', name: 'Battery Engineering' });
  assert.equal(bat.key, 'BAT');
  assert.deepEqual((await all(`select key from pm_roles where project_id = $1 order by sort`, [bat.id])).map((r) => r.key), ['admin', 'manager', 'contributor', 'approver', 'viewer']);
  assert.deepEqual((await all(`select name from pm_statuses where project_id = $1 order by sort`, [bat.id])).map((r) => r.name), ['To Do', 'In Progress', 'In Review', 'Done']);
  assert.ok((await all(`select 1 from pm_types where project_id = $1`, [bat.id])).length >= 4);
  const m = await one(`select r.key from pm_members m join pm_roles r on r.id = m.role_id where m.project_id = $1 and m.user_id = $2`, [bat.id, admin]);
  assert.equal(m.key, 'admin');
  assert.equal((await one(`select r.key from pm_projects p join pm_roles r on r.id = p.team_role_id where p.id = $1`, [bat.id])).key, 'viewer');
});

await test('project keys are unique and well formed; a member without "Create projects" can\'t create one', async () => {
  await rejects(by(admin, 'pm_save_project', null, { key: 'BAT', name: 'Again' }), /already uses the key BAT/, 'OS412');
  await rejects(by(admin, 'pm_save_project', null, { key: '1x', name: 'Bad' }), /project key/);
  await rejects(by(member, 'pm_save_project', null, { key: 'MEM', name: 'Mine' }), /Create projects/, '42501');
});

await test('guests, former members and signed-out visitors get nothing: no rows, no functions', async () => {
  for (const who of [guest, former]) {
    assert.equal(await visibleCount(who, 'pm_projects'), 0);
    assert.equal(await visibleCount(who, 'pm_templates'), 0);
    await rejects(by(who, 'pm_search', {}), /accepted|access has ended/, '42501');
    await rejects(by(who, 'pm_save_project', null, { key: 'GST', name: 'x' }), /accepted|access has ended/, '42501');
  }
  await rejects(as(null, () => db.query('select * from pm_projects')), /permission denied/);
  await rejects(as(null, () => db.query(`select public.pm_search('{}')`)), /permission denied/);
});

await test('nobody can write a Projects table directly, even an Admin: every change is a checked function', async () => {
  for (const t of ['pm_projects', 'pm_items', 'pm_members', 'pm_roles', 'pm_statuses', 'pm_events', 'pm_views', 'pm_automations']) {
    await rejects(as(admin, () => db.query(`delete from ${t}`)), /permission denied/);
    await rejects(as(admin, () => db.query(`insert into ${t} default values`)), /permission denied/);
  }
  await rejects(as(member, () => db.query(`select public.pmx_update($1, null, '{}', true)`, [uuid()])), /permission denied/);
  await rejects(as(member, () => db.query(`select public.pmx_apply_config($1, '{}', '{}', false, current_date)`, [bat.id])), /permission denied/);
});

await test('a private project is invisible to non-members: rows, search, functions; a team project is read-only for them', async () => {
  private1 = await by(ce, 'pm_save_project', null, { key: 'SEC', name: 'Sponsor negotiations' });
  private1 = await by(ce, 'pm_save_project', private1.id, { visibility: 'private' });
  const task = await typeId(private1.id, 'Task');
  const secret = await create(ce, private1.id, task, 'Secret thing');
  for (const t of ['pm_projects', 'pm_items', 'pm_events', 'pm_types', 'pm_statuses', 'pm_roles', 'pm_members']) {
    const col = t === 'pm_projects' ? 'id' : 'project_id';
    assert.equal(await visibleCount(member, t, `${col} = $1`, [private1.id]), 0, t);
    assert.ok((await visibleCount(ce, t, `${col} = $1`, [private1.id])) > 0, `${t} for its owner`);
  }
  assert.equal((await by(member, 'pm_search', { project: private1.id })).total, 0);
  assert.equal((await by(member, 'pm_search', { q: 'Secret' })).total, 0);
  await rejects(by(member, 'pm_update_item', secret.id, null, { title: 'x' }), /doesn't exist, or you can't see it/, '42501');
  await rejects(by(member, 'pm_comment', secret.id, 'hi', []), /can't see it/, '42501');
  await rejects(by(member, 'pm_export_config', private1.id, false), /can't see it/, '42501');
  // "Manage all projects" sees it
  assert.equal(await visibleCount(admin, 'pm_items', 'project_id = $1', [private1.id]), 1);
  // team-visible BAT: a plain member is a Viewer
  assert.equal(await visibleCount(member, 'pm_projects', 'id = $1', [bat.id]), 1);
  await rejects(create(member, bat.id, await typeId(bat.id, 'Task'), 'nope'), /Create items/, '42501');
});

await test('members and roles: a project manager adds people without being an Admin, but can\'t hand out more than they have', async () => {
  await by(admin, 'pm_set_member', bat.id, pmgr, await role(bat.id, 'manager'));
  await by(pmgr, 'pm_set_member', bat.id, member, await role(bat.id, 'contributor'));
  await by(pmgr, 'pm_set_member', bat.id, approver, await role(bat.id, 'approver'));
  // the manager role has no "configure"/"workflows", so it can't give out Project Administrator or edit that role
  await rejects(by(pmgr, 'pm_set_member', bat.id, other, await role(bat.id, 'admin')), /more than yours/, '42501');
  await rejects(by(pmgr, 'pm_save_role', bat.id, await role(bat.id, 'contributor'), { name: 'Contributor', caps: ['view', 'workflows'] }), /your own role can't do/, '42501');
  await rejects(by(pmgr, 'pm_set_member', bat.id, admin, null), /more than yours/, '42501');
  await rejects(by(member, 'pm_set_member', bat.id, other, await role(bat.id, 'viewer')), /Members and roles/, '42501');
  await rejects(by(admin, 'pm_set_member', bat.id, guest, await role(bat.id, 'viewer')), /on the team/);
  await rejects(by(ce, 'pm_set_member', private1.id, ce, null), /has to be able to manage members/);
  // a custom role
  const r = await by(admin, 'pm_save_role', bat.id, null, { name: 'Test lead', caps: ['create', 'transition', 'approve'] });
  assert.deepEqual(r.caps.sort(), ['approve', 'create', 'transition', 'view']);
  await by(admin, 'pm_delete_role', r.id);
  const caps = await by(member, 'pm_my_caps');
  assert.deepEqual(caps[bat.id].sort(), ['assign', 'comment', 'create', 'edit', 'transition', 'view']);
  assert.equal(caps[private1.id], undefined);
});

// ---- configuration -------------------------------------------------------------------------------------
console.log('Configuration');

let wf;
let st = {};
let tr = {};
let designTask;
let review;
await test('a workflow with custom statuses and transitions is saved as a whole, versioned, and previewed first', async () => {
  wf = await one(`select * from pm_workflows where project_id = $1`, [bat.id]);
  const old = await all(`select * from pm_statuses where workflow_id = $1 order by sort`, [wf.id]);
  for (const name of ['Draft', 'In Design', 'In Review', 'Approved', 'Released']) st[name] = name === 'In Review' ? old[2].id : uuid();
  for (const k of ['design', 'review', 'approve', 'release', 'rework', 'reopen']) tr[k] = uuid();
  const statuses = [
    { id: st.Draft, name: 'Draft', category: 'todo', color: 'gray', sort: 10 },
    { id: st['In Design'], name: 'In Design', category: 'doing', color: 'blue', sort: 20 },
    { id: st['In Review'], name: 'In Review', category: 'doing', color: 'purple', sort: 30 },
    { id: st.Approved, name: 'Approved', category: 'doing', color: 'teal', sort: 40 },
    { id: st.Released, name: 'Released', category: 'done', color: 'green', sort: 50 },
  ];
  const transitions = [
    { id: tr.design, name: 'Start design', from_status: st.Draft, to_status: st['In Design'] },
    { id: tr.review, name: 'Send for review', from_status: st['In Design'], to_status: st['In Review'], require_fields: ['owner'] },
    { id: tr.approve, name: 'Approve', from_status: st['In Review'], to_status: st.Approved, require_approval: true, no_self_approval: true },
    { id: tr.release, name: 'Release', from_status: st.Approved, to_status: st.Released, role_ids: [await role(bat.id, 'manager'), await role(bat.id, 'admin')], require_comment: true },
    { id: tr.rework, name: 'Needs rework', from_status: st['In Review'], to_status: st['In Design'], require_comment: true },
    { id: tr.reopen, name: 'Reopen', from_status: null, to_status: st.Draft },
  ];
  // one item sits in "To Do", which the new workflow drops
  const stray = await create(admin, bat.id, await typeId(bat.id, 'Task'), 'Was in To Do');
  const p = { name: 'Design release', version: wf.version, statuses, transitions };
  const preview = await by(admin, 'pm_save_workflow', bat.id, wf.id, { ...p, dry_run: true });
  assert.equal(preview.dry_run, true);
  assert.deepEqual(preview.removed.map((r) => [r.name, r.items]).sort(), [['Done', 0], ['In Progress', 0], ['To Do', 1]]);
  assert.equal((await one(`select count(*)::int c from pm_statuses where workflow_id = $1`, [wf.id])).c, 4, 'a preview changes nothing');
  // without saying where "To Do" items go, it refuses: nothing is ever left without a status
  const err = await rejects(by(admin, 'pm_save_workflow', bat.id, wf.id, p), /Say which status they move to/, 'OS428');
  assert.match(err.detail, /To Do/);
  await rejects(by(pmgr, 'pm_save_workflow', bat.id, wf.id, p), /Workflows/, '42501');
  const saved = await by(admin, 'pm_save_workflow', bat.id, wf.id, { ...p, mapping: { [old[0].id]: st.Draft } });
  assert.equal(saved.version, wf.version + 1);
  assert.equal((await item(stray.id)).status, 'Draft');
  assert.match((await one(`select summary from pm_events where item_id = $1 and kind = 'status'`, [stray.id])).summary, /because the workflow changed/);
  assert.deepEqual((await all(`select name from pm_statuses where workflow_id = $1 order by sort`, [wf.id])).map((r) => r.name), Object.keys(st));
  assert.equal((await one(`select count(*)::int c from pm_workflow_versions where workflow_id = $1 and version = $2`, [wf.id, saved.version])).c, 1);
  // someone editing from the old version is told, not overwritten
  await rejects(by(admin, 'pm_save_workflow', bat.id, wf.id, p), /Someone else saved this workflow/, 'OS409');
  await by(admin, 'pm_archive_item', stray.id, true);
});

await test('a workflow is checked: names, categories, transitions inside the workflow, known roles and fields', async () => {
  const cur = (await one(`select public.pmx_workflow_json($1) j`, [wf.id])).j;
  const save = (change) => by(admin, 'pm_save_workflow', bat.id, wf.id, { ...cur, ...change });
  await rejects(save({ statuses: [] }), /at least one status/);
  await rejects(save({ statuses: cur.statuses.map((s, i) => (i === 1 ? { ...s, name: 'draft' } : s)) }), /same name/);
  await rejects(save({ statuses: cur.statuses.map((s, i) => (i === 1 ? { ...s, category: 'nope' } : s)) }), /category/);
  await rejects(save({ transitions: [{ id: uuid(), name: 'Out', from_status: null, to_status: uuid() }] }), /isn't in this workflow/);
  await rejects(save({ transitions: [{ id: uuid(), name: 'R', to_status: st.Draft, role_ids: [uuid()] }] }), /role this project doesn't have/);
  await rejects(save({ transitions: [{ id: uuid(), name: 'F', to_status: st.Draft, require_fields: ['cf.nope'] }] }), /field this project doesn't have/);
  await rejects(save({ transitions: [{ id: uuid(), name: 'C', to_status: st.Draft, conditions: { f: 'drop table', v: 1 } }] }), /Unknown filter field/);
  await rejects(save({ transitions: [{ id: uuid(), name: 'A', to_status: st.Draft, actions: [{ type: 'run_sql', sql: 'x' }] }] }), /Unknown action/);
  assert.equal((await one(`select version from pm_workflows where id = $1`, [wf.id])).version, cur.version, 'nothing was saved');
});

await test('custom work-item types with their own level and allowed parents', async () => {
  designTask = await by(admin, 'pm_save_type', bat.id, null, { name: 'Design Task', icon: '✎', color: 'blue', level: 1 });
  review = await by(admin, 'pm_save_type', bat.id, null, { name: 'Design Review', icon: '☑', color: 'orange', level: 1, defaults: { priority: 'high' } });
  assert.equal(designTask.workflow_id, wf.id);
  await rejects(by(admin, 'pm_save_type', bat.id, null, { name: 'design task' }), /duplicate|unique/i);
  await rejects(by(member, 'pm_save_type', bat.id, null, { name: 'Mine' }), /Project settings/, '42501');
  const r = await create(admin, bat.id, review.id, 'PDR');
  assert.equal(r.priority, 'high', 'the type\'s default');
  await by(admin, 'pm_archive_item', r.id, true);
});

await test('custom fields are checked on the server, kind by kind', async () => {
  const f = (p) => by(admin, 'pm_save_field', bat.id, null, p);
  await f({ key: 'cell_count', name: 'Cell count', type: 'integer', validation: { min: 1, max: 500 } });
  await f({ key: 'chemistry', name: 'Chemistry', type: 'select', options: ['NMC', 'LFP', 'LTO'] });
  await f({ key: 'reviewers', name: 'Reviewers', type: 'multiuser' });
  await f({ key: 'review_date', name: 'Review date', type: 'date' });
  await f({ key: 'spec_link', name: 'Spec', type: 'url' });
  await f({ key: 'hazards', name: 'Hazards', type: 'multiselect', options: ['HV', 'Thermal', 'Chemical'] });
  await f({ key: 'budget', name: 'Budget', type: 'currency' });
  await f({ key: 'margin', name: 'Margin', type: 'formula', formula: 'budget * 0.1' });
  await f({ key: 'review_notes', name: 'Review notes', type: 'longtext', type_ids: [review.id] });
  await rejects(f({ key: 'Bad Key', name: 'x', type: 'text' }), /field key/);
  await rejects(f({ key: 'chemistry', name: 'x', type: 'text' }), /already has a field/, 'OS412');
  await rejects(f({ key: 'empty', name: 'x', type: 'select', options: [] }), /at least one choice/);
  await rejects(f({ key: 'evil', name: 'x', type: 'formula', formula: 'fetch(`/x`); {}' }), /formula can only use/);
  await rejects(by(admin, 'pm_save_field', bat.id, (await one(`select id from pm_fields where key = 'budget'`)).id, { type: 'text' }), /kind can't change/);

  const t = await create(member, bat.id, designTask.id, 'Pack layout', { custom: { cell_count: '416', chemistry: 'NMC', hazards: ['HV', 'Thermal'], review_date: '2027-01-15', reviewers: [approver] } });
  assert.deepEqual(t.custom, { cell_count: 416, chemistry: 'NMC', hazards: ['HV', 'Thermal'], review_date: '2027-01-15', reviewers: [approver] });
  const bad = (custom, re) => rejects(by(member, 'pm_update_item', t.id, null, { custom }), re);
  await bad({ cell_count: 'many' }, /has to be a number/);
  await bad({ cell_count: 2.5 }, /whole number/);
  await bad({ cell_count: 9000 }, /can't be more than 500/);
  await bad({ chemistry: 'Lead' }, /isn't one of the choices/);
  await bad({ hazards: ['HV', 'Boredom'] }, /isn't one of its choices/);
  await bad({ review_date: 'soon' }, /has to be a date/);
  await bad({ spec_link: 'javascript:alert(1)' }, /https/);
  await bad({ reviewers: [guest] }, /people on the team/);
  await bad({ nope: 1 }, /no field "nope"/);
  await bad({ review_notes: 'x' }, /isn't used on this kind of item/);
  await bad({ budget: -5 }, /can't be negative/);
  const cleared = await by(member, 'pm_update_item', t.id, null, { custom: { chemistry: '', margin: 5 } });
  assert.equal('chemistry' in cleared.custom, false, 'a blank clears the field');
  assert.equal('margin' in cleared.custom, false, 'a formula is never stored');
  await by(admin, 'pm_archive_item', t.id, true);
});

await test('a form layout decides which fields are required when creating and when editing', async () => {
  await by(admin, 'pm_save_layout', bat.id, { type_id: designTask.id, kind: 'create', sections: [
    { title: 'What', fields: [{ key: 'description' }, { key: 'cf.chemistry', required: true }, { key: 'owner', required: true }] },
    { title: 'Numbers', fields: [{ key: 'cf.cell_count' }, { key: 'due_date' }] }] });
  await by(admin, 'pm_save_layout', bat.id, { type_id: designTask.id, kind: 'edit', sections: [{ title: 'What', fields: [{ key: 'cf.chemistry', required: true }, { key: 'description' }] }] });
  await rejects(by(admin, 'pm_save_layout', bat.id, { kind: 'create', sections: [{ title: 'x', fields: [{ key: 'cf.nope' }] }] }), /field this project doesn't have/);
  await rejects(by(member, 'pm_save_layout', bat.id, { kind: 'create', sections: [] }), /Project settings/, '42501');
  const err = await rejects(create(member, bat.id, designTask.id, 'No chemistry'), /Fill in: Chemistry, Owner/, 'OS428');
  assert.deepEqual(JSON.parse(err.detail), ['cf.chemistry', 'owner']);
  const ok = await create(member, bat.id, designTask.id, 'With chemistry', { owner_id: member, custom: { chemistry: 'LFP' } });
  await rejects(by(member, 'pm_update_item', ok.id, null, { custom: { chemistry: '' } }), /Chemistry can't be left empty/, 'OS428');
  await by(member, 'pm_update_item', ok.id, null, { description: 'still fine' });
  // other types aren't affected
  await create(member, bat.id, review.id, 'A review with no chemistry');
});

// ---- items ---------------------------------------------------------------------------------------------
console.log('Work items');

let t1;
await test('items get readable, unique numbers; a repeated create (same operation id) makes one item', async () => {
  const before = (await one(`select item_seq from pm_projects where id = $1`, [bat.id])).item_seq;
  const op = uuid();
  t1 = await by(member, 'pm_create_item', op, { project_id: bat.id, type_id: review.id, title: 'Cell selection review', owner_id: member });
  const again = await by(member, 'pm_create_item', op, { project_id: bat.id, type_id: review.id, title: 'Cell selection review', owner_id: member });
  assert.equal(again.id, t1.id);
  assert.equal(t1.key, `BAT-${before + 1}`);
  assert.equal((await one(`select item_seq from pm_projects where id = $1`, [bat.id])).item_seq, before + 1);
  const keys = [];
  for (let i = 0; i < 25; i++) keys.push((await create(member, bat.id, review.id, `Batch ${i}`)).key);
  assert.equal(new Set(keys).size, 25);
  assert.equal((await one(`select count(*)::int c, count(distinct key)::int d from pm_items where project_id = $1`, [bat.id])).c,
    (await one(`select count(distinct seq)::int d from pm_items where project_id = $1`, [bat.id])).d);
  await rejects(db.query(`insert into pm_items (project_id, type_id, seq, key, title, status_id, category) select project_id, type_id, 999, key, 'dup', status_id, category from pm_items where id = $1`, [t1.id]), /pm_items_key_key/);
});

await test('editing: a stale version is refused instead of overwriting someone else\'s change; history records what changed', async () => {
  const mine = await by(member, 'pm_update_item', t1.id, t1.version, { due_date: '2027-02-01', priority: 'urgent' });
  assert.equal(mine.version, t1.version + 1);
  await rejects(by(pmgr, 'pm_update_item', t1.id, t1.version, { title: 'Overwritten?' }), /changed by someone else/, 'OS409');
  assert.equal((await item(t1.id)).title, 'Cell selection review');
  const ev = await one(`select summary, data from pm_events where item_id = $1 and kind = 'updated' order by id desc limit 1`, [t1.id]);
  assert.match(ev.summary, /Priority/);
  assert.deepEqual(ev.data.changes.due_date, [null, '2027-02-01']);
  await rejects(db.query(`update pm_events set summary = 'x' where item_id = $1`, [t1.id]), /history is permanent/);
  await rejects(db.query(`delete from pm_events where item_id = $1`, [t1.id]), /history is permanent/);
  await rejects(by(member, 'pm_update_item', t1.id, null, { start_date: '2027-03-01' }), /start date is after the due date/);
  await rejects(by(member, 'pm_update_item', t1.id, null, { owner_id: guest }), /on the team/);
  t1 = await item(t1.id);
});

await test('assigning someone else needs "Assign people"; a viewer can\'t edit at all', async () => {
  await by(admin, 'pm_save_role', bat.id, await role(bat.id, 'approver'), { name: 'Approver', caps: ['view', 'comment', 'transition', 'approve', 'create'] });
  const own = await create(approver, bat.id, review.id, 'Approver\'s own item');
  await by(approver, 'pm_update_item', own.id, null, { title: 'Approver can edit their own' });
  await rejects(by(approver, 'pm_update_item', own.id, null, { owner_id: member }), /Assign people/, '42501');
  await rejects(by(approver, 'pm_update_item', t1.id, null, { title: 'not mine' }), /Edit items/, '42501');
  await rejects(by(other, 'pm_update_item', t1.id, null, { title: 'viewer' }), /Edit items/, '42501');
  await by(other, 'pm_comment', t1.id, 'Viewers can comment', []);
});

let epic;
await test('hierarchy: parents have to be higher up, in the same project, and never a loop', async () => {
  const epicType = await typeId(bat.id, 'Epic');
  const sub = await typeId(bat.id, 'Subtask');
  epic = await create(member, bat.id, epicType, 'Battery enclosure');
  const child = await create(member, bat.id, review.id, 'Bracket review', { parent_id: epic.id });
  const grand = await create(member, bat.id, sub, 'Check shear', { parent_id: child.id });
  await rejects(by(member, 'pm_update_item', epic.id, null, { parent_id: child.id }), /can't go under/);
  await rejects(by(member, 'pm_update_item', child.id, null, { parent_id: grand.id }), /can't go under/);
  await rejects(by(member, 'pm_update_item', child.id, null, { parent_id: child.id }), /underneath itself|can't go under|violates check/);
  const foreign = await create(ce, private1.id, await typeId(private1.id, 'Epic'), 'Other project epic');
  await rejects(by(admin, 'pm_update_item', child.id, null, { parent_id: foreign.id }), /same project/);
  // "only under these types"
  await by(admin, 'pm_save_type', bat.id, sub, { parent_type_ids: [designTask.id] });
  await rejects(create(member, bat.id, sub, 'Under a review', { parent_id: child.id }), /Subtask can't go under a Design Review/);
  await by(admin, 'pm_save_type', bat.id, sub, { parent_type_ids: [] });
  // same-level loop through allowed parent types
  await by(admin, 'pm_save_type', bat.id, review.id, { parent_type_ids: [review.id, epicType] });
  const a = await create(member, bat.id, review.id, 'A');
  const b = await create(member, bat.id, review.id, 'B', { parent_id: a.id });
  await rejects(by(member, 'pm_update_item', a.id, null, { parent_id: b.id }), /underneath itself/);
  await by(admin, 'pm_save_type', bat.id, review.id, { parent_type_ids: [] });
  // archiving takes what's under it; nothing is deleted
  await by(pmgr, 'pm_archive_item', epic.id, true);
  assert.ok((await item(grand.id)).archived_at);
  await by(pmgr, 'pm_archive_item', epic.id, false);
  assert.equal((await item(grand.id)).archived_at, null);
  await rejects(by(member, 'pm_archive_item', epic.id, true), /Archive items/, '42501');
});

// ---- workflow engine -----------------------------------------------------------------------------------
console.log('Workflow engine');

await test('only moves the workflow has, from where the item is, are allowed', async () => {
  assert.equal((await item(t1.id)).status, 'Draft');
  await rejects(by(member, 'pm_transition', t1.id, tr.release, { comment: 'skip ahead' }), /is now "Draft", so "Release" doesn't apply/, 'OS409');
  await rejects(by(member, 'pm_transition', t1.id, uuid(), {}), /isn't part of this item's workflow/);
  const other1 = await transition(private1.id, 'Done');
  await rejects(by(member, 'pm_transition', t1.id, other1, {}), /isn't part of this item's workflow/);
  await rejects(by(other, 'pm_transition', t1.id, tr.design, {}), /Move items between statuses/, '42501');
  const moved = await by(member, 'pm_transition', t1.id, tr.design, { version: t1.version });
  assert.equal(moved.category, 'doing');
  assert.ok(moved.actual_start);
  await rejects(by(member, 'pm_transition', t1.id, tr.design, { version: t1.version }), /changed by someone else/, 'OS409');
  // statuses can't be set any other way
  await by(member, 'pm_update_item', t1.id, null, { status_id: st.Released });
  assert.equal((await item(t1.id)).status, 'In Design');
});

await test('required fields, required comments and conditions are enforced by the database', async () => {
  await by(member, 'pm_update_item', t1.id, null, { owner_id: null });
  const err = await rejects(by(member, 'pm_transition', t1.id, tr.review, {}), /"Send for review" needs: Owner/, 'OS428');
  assert.deepEqual(JSON.parse(err.detail), ['owner']);
  // the transition's own form can fill what's missing
  await by(member, 'pm_transition', t1.id, tr.review, { fields: { owner_id: member } });
  assert.equal((await item(t1.id)).status, 'In Review');
  await rejects(by(member, 'pm_transition', t1.id, tr.rework, {}), /needs: a comment/, 'OS428');
  await by(member, 'pm_transition', t1.id, tr.rework, { comment: 'Missing the thermal case' });
  assert.equal((await one(`select body from pm_comments where item_id = $1 order by created_at desc limit 1`, [t1.id])).body, 'Missing the thermal case');
  await by(member, 'pm_transition', t1.id, tr.review, {});
});

await test('an approval gate: a contributor\'s move waits; the owner can\'t approve their own; an approver\'s decision makes the move', async () => {
  const res = await by(member, 'pm_transition', t1.id, tr.approve, {});
  assert.equal(res.pending, true);
  assert.equal((await item(t1.id)).status, 'In Review', 'not moved yet');
  await rejects(by(member, 'pm_transition', t1.id, tr.approve, {}), /already waiting for an approval/);
  await rejects(by(member, 'pm_decide_approval', res.approval_id, true, ''), /Approve/, '42501');
  assert.equal((await one(`select count(*)::int c from pm_notifications where user_id = $1 and kind = 'review' and item_id = $2`, [approver, t1.id])).c, 1);
  await rejects(by(approver, 'pm_decide_approval', res.approval_id, false, ''), /Say why/);
  await by(approver, 'pm_decide_approval', res.approval_id, false, 'Numbers don\'t add up');
  assert.equal((await item(t1.id)).status, 'In Review');
  const res2 = await by(member, 'pm_transition', t1.id, tr.approve, {});
  await by(approver, 'pm_decide_approval', res2.approval_id, true, 'Good now');
  assert.equal((await item(t1.id)).status, 'Approved');
  await rejects(by(approver, 'pm_decide_approval', res2.approval_id, true, ''), /already approved/, 'OS409');
  // no self-approval, even for someone who may approve
  const own = await create(approver, bat.id, review.id, 'Approver owns this', { owner_id: approver });
  await by(approver, 'pm_transition', own.id, tr.design, {});
  await by(approver, 'pm_transition', own.id, tr.review, {});
  const self = await by(approver, 'pm_transition', own.id, tr.approve, {});
  assert.equal(self.pending, true, 'the owner\'s own approval isn\'t enough');
  await rejects(by(approver, 'pm_decide_approval', self.approval_id, true, ''), /can't approve their own/, '42501');
  await by(pmgr, 'pm_decide_approval', self.approval_id, true, '');
  assert.equal((await item(own.id)).status, 'Approved');
});

await test('a move limited to some roles is refused for everyone else, straight from the database', async () => {
  await rejects(by(member, 'pm_transition', t1.id, tr.release, { comment: 'ship it' }), /Only Project (Manager|Administrator) or Project (Manager|Administrator) can make the move "Release"/, '42501');
  await rejects(by(approver, 'pm_transition', t1.id, tr.release, { comment: 'ship it' }), /Only Project/, '42501');
  const done = await by(pmgr, 'pm_transition', t1.id, tr.release, { comment: 'Released to manufacturing' });
  assert.equal(done.category, 'done');
  assert.equal(done.progress, 100);
  assert.ok(done.completed_at);
});

await test('finished and formally accepted are separate: acceptance needs "Approve" and a finished item; reopening clears both', async () => {
  await rejects(by(member, 'pm_accept', t1.id, true), /Approve/, '42501');
  const acc = await by(approver, 'pm_accept', t1.id, true);
  assert.ok(acc.accepted_at);
  assert.equal(acc.accepted_by, approver);
  const reopened = await by(pmgr, 'pm_transition', t1.id, tr.reopen, {});
  assert.equal(reopened.completed_at, null);
  assert.equal(reopened.accepted_at, null);
  await rejects(by(approver, 'pm_accept', t1.id, true), /isn't finished yet/);
});

await test('moving a type to another workflow needs a status for every status its items are in', async () => {
  const s2 = [uuid(), uuid()];
  const w2 = await by(admin, 'pm_save_workflow', bat.id, null, { name: 'Two step', statuses: [
    { id: s2[0], name: 'Open', category: 'todo', sort: 1 }, { id: s2[1], name: 'Closed', category: 'done', sort: 2 }],
    transitions: [{ id: uuid(), name: 'Close', from_status: null, to_status: s2[1] }, { id: uuid(), name: 'Open', from_status: null, to_status: s2[0] }] });
  const bug = await by(admin, 'pm_save_type', bat.id, null, { name: 'Defect', level: 1 });
  const d = await create(member, bat.id, bug.id, 'Loose terminal');
  const preview = await by(admin, 'pm_save_type', bat.id, bug.id, { workflow_id: w2.id, dry_run: true });
  assert.deepEqual(preview.statuses.map((s) => [s.name, s.items, s.to]), [['Draft', 1, null]]);
  await rejects(by(admin, 'pm_save_type', bat.id, bug.id, { workflow_id: w2.id }), /Say which status each one becomes/, 'OS428');
  await by(admin, 'pm_save_type', bat.id, bug.id, { workflow_id: w2.id, mapping: { [st.Draft]: s2[0] } });
  assert.equal((await item(d.id)).status, 'Open');
  // each type follows its own workflow
  await rejects(by(member, 'pm_transition', d.id, tr.design, {}), /isn't part of this item's workflow/);
  const closed = await by(member, 'pm_transition', d.id, await transition(bat.id, 'Closed'), {});
  assert.equal(closed.category, 'done');
  // changing an item's type across workflows asks for the status
  await rejects(by(member, 'pm_update_item', d.id, null, { type_id: review.id }), /Pick the status/, 'OS428');
  const changed = await by(member, 'pm_update_item', d.id, null, { type_id: review.id, status_id: st.Draft });
  assert.equal(changed.status_id, st.Draft);
});

// ---- dependencies --------------------------------------------------------------------------------------
console.log('Dependencies');

let chain;
await test('dependencies: four kinds with lag, across projects, and never a loop', async () => {
  chain = [];
  for (const title of ['Cell selection', 'Module design', 'Enclosure design', 'Pack assembly']) chain.push(await create(member, bat.id, review.id, title, { owner_id: member }));
  await rejects(by(member, 'pm_link', { from: chain[0].id, to: chain[1].id }), /Plan and schedule/, '42501');
  await by(pmgr, 'pm_link', { from: chain[0].id, to: chain[1].id, kind: 'FS' });
  await by(pmgr, 'pm_link', { from: chain[1].id, to: chain[2].id, kind: 'SS', lag_days: 2 });
  await by(pmgr, 'pm_link', { from: chain[2].id, to: chain[3].id, kind: 'FF', lag_days: -1 });
  await rejects(by(pmgr, 'pm_link', { from: chain[3].id, to: chain[0].id }), /would make a loop/);
  await rejects(by(pmgr, 'pm_link', { from: chain[1].id, to: chain[0].id }), /would make a loop/);
  await rejects(by(pmgr, 'pm_link', { from: chain[0].id, to: chain[0].id }), /can't depend on itself/);
  await rejects(by(pmgr, 'pm_link', { from: chain[0].id, to: chain[1].id, kind: 'XX' }), /Unknown kind/);
  const again = await by(pmgr, 'pm_link', { from: chain[0].id, to: chain[1].id, kind: 'FS', lag_days: 3 });
  assert.equal(again.lag_days, 3, 'linking the same pair again changes the link');
  assert.equal((await one(`select count(*)::int c from pm_deps where to_item = $1`, [chain[1].id])).c, 1);
  // across projects: Chassis CAD in another project holds up Pack assembly
  const cha = await by(ce, 'pm_save_project', null, { key: 'CHA', name: 'Chassis' });
  await by(ce, 'pm_set_member', cha.id, pmgr, await role(cha.id, 'manager'));
  const cad = await create(ce, cha.id, await typeId(cha.id, 'Task'), 'Chassis CAD', { owner_id: ce });
  await by(pmgr, 'pm_link', { from: cad.id, to: chain[3].id });
  const dep = await one(`select * from pm_deps where from_item = $1`, [cad.id]);
  assert.notEqual(dep.from_project, dep.to_project);
  // someone who can't see the other project can't link to it
  const sec = await one(`select id from pm_items where project_id = $1 limit 1`, [private1.id]);
  await rejects(by(pmgr, 'pm_link', { from: sec.id, to: chain[0].id }), /can't see it/, '42501');
  // open_deps in search, and "ready to start" when the last blocker is done
  const found = await by(member, 'pm_search', { filter: { f: 'open_deps' }, project: bat.id });
  assert.deepEqual(found.items.map((i) => i.title).sort(), ['Enclosure design', 'Module design', 'Pack assembly']);
  await by(ce, 'pm_transition', cad.id, await transition(cha.id, 'Done'), {});
  assert.equal((await one(`select count(*)::int c from pm_notifications where item_id = $1 and kind = 'dependency'`, [chain[3].id])).c, 0, 'still waiting on Enclosure design');
});

// ---- search and saved views ----------------------------------------------------------------------------
console.log('Search and saved views');

await test('filters: a checked model with AND / OR / NOT, built-in and custom fields; nothing from the page is run as SQL', async () => {
  const s = (filter, extra = {}) => by(member, 'pm_search', { project: bat.id, filter, ...extra });
  const a = await create(member, bat.id, designTask.id, 'Filter A', { owner_id: member, priority: 'urgent', due_date: '2020-01-01', labels: ['thermal'], custom: { chemistry: 'NMC', cell_count: 100, hazards: ['HV'] } });
  await create(member, bat.id, designTask.id, 'Filter B', { owner_id: member, priority: 'low', custom: { chemistry: 'LFP', cell_count: 300 } });
  const titles = async (f, extra) => (await s(f, extra)).items.map((i) => i.title).sort();
  assert.deepEqual(await titles({ f: 'cf.chemistry', v: 'NMC' }), ['Filter A']);
  assert.deepEqual(await titles({ f: 'cf.cell_count', op: 'gt', v: 200 }), ['Filter B']);
  assert.deepEqual(await titles({ f: 'cf.hazards', op: 'contains', v: 'HV' }), ['Filter A']);
  assert.deepEqual(await titles({ all: [{ f: 'type', v: designTask.id }, { any: [{ f: 'priority', v: 'urgent' }, { f: 'cf.chemistry', v: 'LFP' }] }, { not: { f: 'title', op: 'contains', v: 'chemistry' } }] }), ['Filter A', 'Filter B']);
  assert.deepEqual(await titles({ all: [{ f: 'overdue' }, { f: 'labels', v: 'thermal' }, { f: 'owner', v: 'me' }] }), ['Filter A']);
  assert.deepEqual(await titles({ f: 'type_name', v: 'Design Task' }, { q: 'filter b' }), ['Filter B']);
  assert.deepEqual(await titles({ f: 'due', op: 'past', v: 30 }), ['Filter A']);
  assert.deepEqual(await titles({ f: 'status_name', op: 'in', v: ['Released', 'Nope'] }), []);
  await rejects(s({ f: 'i.id); drop table pm_items; --', v: 1 }), /Unknown filter field/);
  await rejects(s({ f: 'priority', op: '; drop', v: 1 }), /Unknown filter operator/);
  await rejects(s({ f: 'owner', v: "x' or '1'='1" }), /isn't a valid id/);
  assert.equal((await s({ f: 'title', v: "'; drop table pm_items; --" })).total, 0);
  assert.equal((await s({ f: 'cf.chemistry', v: "NMC' or 'a'='a" })).total, 0);
  assert.ok((await one(`select count(*)::int c from pm_items`)).c > 0);
  assert.equal(a.category, 'todo');
});

await test('large lists: sorted pages with a total, a hard limit, and never another project\'s items', async () => {
  const big = await by(ce, 'pm_save_project', null, { key: 'BIG', name: 'Big project' });
  const task = await typeId(big.id, 'Task');
  const todo = await statusId(big.id, 'To Do');
  await db.query(`insert into pm_items (project_id, type_id, seq, key, title, status_id, category, rank, due_date)
    select $1, $2, g, 'BIG-' || g, 'Item ' || lpad(g::text, 4, '0'), $3, 'todo', g, current_date + (g % 50) from generate_series(1, 1200) g`, [big.id, task, todo]);
  await db.query(`update pm_projects set item_seq = 1200 where id = $1`, [big.id]);
  const p1 = await by(member, 'pm_search', { project: big.id, sort: 'title', limit: 100 });
  const p2 = await by(member, 'pm_search', { project: big.id, sort: 'title', limit: 100, offset: 100 });
  assert.equal(p1.total, 1200);
  assert.equal(p1.items.length, 100);
  assert.equal(p1.items[0].title, 'Item 0001');
  assert.equal(p2.items[0].title, 'Item 0101');
  assert.equal((await by(member, 'pm_search', { project: big.id, limit: 999999 })).items.length, 1000);
  assert.equal((await by(member, 'pm_search', { project: big.id, sort: 'due', dir: 'desc', limit: 1 })).items[0].due_date > p1.items[0].due_date, true);
  const everything = await by(member, 'pm_search', { limit: 1000, filter: { f: 'project', op: 'in', v: [big.id, private1.id] } });
  assert.equal(everything.total, 1200, 'the private project\'s items are not counted');
});

let sharedView;
await test('saved views: personal ones are private; sharing with a project needs "Shared boards and views"', async () => {
  const mine = await by(member, 'pm_save_view', null, { project_id: bat.id, kind: 'list', name: 'My urgent work', config: { filter: { all: [{ f: 'owner', v: 'me' }, { f: 'priority', v: 'urgent' }] }, columns: ['key', 'title', 'due_date'] } });
  assert.equal(mine.sharing, 'private');
  assert.equal(await visibleCount(pmgr, 'pm_views', 'id = $1', [mine.id]), 0);
  assert.equal(await visibleCount(member, 'pm_views', 'id = $1', [mine.id]), 1);
  await rejects(by(member, 'pm_save_view', null, { project_id: bat.id, kind: 'board', name: 'Team board', sharing: 'project', config: {} }), /Shared boards and views/, '42501');
  sharedView = await by(pmgr, 'pm_save_view', null, { project_id: bat.id, kind: 'board', name: 'Design board', sharing: 'project', is_default: true,
    config: { columns: [{ name: 'Not started', status_ids: [st.Draft] }, { name: 'Working', status_ids: [st['In Design'], st['In Review']], wip: 3 }, { name: 'Finished', status_ids: [st.Approved, st.Released] }], swimlane: 'owner' } });
  assert.equal(await visibleCount(member, 'pm_views', 'id = $1', [sharedView.id]), 1);
  assert.equal(await visibleCount(guest, 'pm_views'), 0);
  await rejects(by(member, 'pm_save_view', sharedView.id, { name: 'Renamed' }), /Shared boards and views/, '42501');
  await rejects(by(pmgr, 'pm_save_view', mine.id, { name: 'Not yours' }), /Only its owner/, '42501');
  await rejects(by(member, 'pm_save_view', null, { kind: 'list', name: 'Bad', config: { filter: { f: 'nope' } } }), /Unknown filter field/);
  await rejects(by(member, 'pm_save_view', null, { kind: 'dashboard', name: 'For everyone', sharing: 'team', config: {} }), /Create projects/, '42501');
  const team = await by(ce, 'pm_save_view', null, { kind: 'dashboard', name: 'Leadership', sharing: 'team', config: { widgets: [{ type: 'status' }] } });
  assert.equal(await visibleCount(member, 'pm_views', 'id = $1', [team.id]), 1);
  const withOne = await by(member, 'pm_save_view', null, { kind: 'list', name: 'For Pat', sharing: 'people', shared_with: [pmgr], config: {} });
  assert.equal(await visibleCount(pmgr, 'pm_views', 'id = $1', [withOne.id]), 1);
  assert.equal(await visibleCount(other, 'pm_views', 'id = $1', [withOne.id]), 0);
  await rejects(by(pmgr, 'pm_save_view', sharedView.id, { name: 'x', version: 99 }), /Someone else changed this view/, 'OS409');
  await by(member, 'pm_delete_view', mine.id);
  await rejects(by(member, 'pm_delete_view', sharedView.id), /Shared boards and views/, '42501');
});

// ---- templates -----------------------------------------------------------------------------------------
console.log('Templates');

let tpl;
let aero;
await test('a project\'s configuration is saved as a template; a new project made from it has its own copy', async () => {
  await rejects(by(member, 'pm_save_template', null, { name: 'Mine', from_project: bat.id }), /Create projects/, '42501');
  tpl = await by(admin, 'pm_save_template', null, { name: 'Battery design process', from_project: bat.id });
  assert.equal(await visibleCount(member, 'pm_templates', 'id = $1', [tpl.id]), 1);
  const copy = await by(ce, 'pm_save_project', null, { key: 'BAT2', name: 'Battery v2', template_id: tpl.id });
  const names = async (table, project) => (await all(`select name from ${table} where project_id = $1 order by name`, [project])).map((r) => r.name);
  for (const t of ['pm_statuses', 'pm_types', 'pm_fields', 'pm_transitions', 'pm_roles']) {
    assert.deepEqual(await names(t, copy.id), await names(t, bat.id), t);
  }
  assert.equal((await one(`select count(*)::int c from pm_statuses a join pm_statuses b on a.id = b.id where a.project_id = $1 and b.project_id = $2`, [copy.id, bat.id])).c, 0);
  // the copy's parts point at each other, not at the original
  assert.equal((await one(`select count(*)::int c from pm_transitions t join pm_statuses s on s.id = t.to_status where t.project_id = $1 and s.project_id <> $1`, [copy.id])).c, 0);
  assert.equal((await one(`select count(*)::int c from pm_types t join pm_workflows w on w.id = t.workflow_id where t.project_id = $1 and w.project_id <> $1`, [copy.id])).c, 0);
  const lay = await one(`select l.sections, t.name from pm_layouts l join pm_types t on t.id = l.type_id where l.project_id = $1 and l.kind = 'create'`, [copy.id]);
  assert.equal(lay.name, 'Design Task');
  const board = await one(`select config from pm_views where project_id = $1 and name = 'Design board'`, [copy.id]);
  const ownStatuses = new Set((await all(`select id from pm_statuses where project_id = $1`, [copy.id])).map((r) => r.id));
  assert.ok(board.config.columns.every((c) => c.status_ids.every((id) => ownStatuses.has(id))), 'the board\'s columns use the copy\'s statuses');
  // and it works like the original: the same rules, enforced independently
  const dt = await typeId(copy.id, 'Design Task');
  await rejects(create(ce, copy.id, dt, 'No chemistry'), /Fill in: Chemistry, Owner/, 'OS428');
  const it = await create(ce, copy.id, dt, 'Works', { owner_id: ce, custom: { chemistry: 'LTO' } });
  assert.equal(it.key, 'BAT2-1');
  await rejects(by(ce, 'pm_transition', it.id, tr.design, {}), /isn't part of this item's workflow/);
});

await test('a second, very different project runs next to the first without either affecting the other', async () => {
  aero = await by(ce, 'pm_save_project', null, { key: 'AERO', name: 'Aerobody Manufacturing', template_id: (await one(`select id from pm_templates where name = 'Manufacturing'`)).id });
  assert.deepEqual((await all(`select name from pm_statuses where project_id = $1 order by sort`, [aero.id])).map((r) => r.name), ['Planned', 'Material Ready', 'In Manufacturing', 'Inspection', 'Complete']);
  const job = await typeId(aero.id, 'Manufacturing Job');
  const mold = await create(ce, aero.id, job, 'Top shell mold', { custom: { process: 'Layup', material: 'Carbon prepreg' } });
  assert.equal(mold.key, 'AERO-1');
  await rejects(by(ce, 'pm_update_item', mold.id, null, { custom: { chemistry: 'NMC' } }), /no field "chemistry"/);
  await rejects(by(ce, 'pm_transition', mold.id, await transition(aero.id, 'Complete'), {}), /doesn't apply any more/, 'OS409');
  await by(ce, 'pm_transition', mold.id, await transition(aero.id, 'Material Ready', 'Planned'), {});
  await rejects(create(ce, aero.id, designTask.id, 'Wrong project\'s type'), /Pick one of this project's work-item types/);
  // BAT is untouched
  assert.equal((await one(`select count(*)::int c from pm_statuses where project_id = $1`, [bat.id])).c, 7);
});

await test('applying a template to a project in use: previewed first, adds and updates, never removes', async () => {
  const before = await all(`select id, name from pm_statuses where project_id = $1 order by name`, [aero.id]);
  const items = (await one(`select count(*)::int c from pm_items where project_id = $1`, [aero.id])).c;
  const preview = await by(ce, 'pm_apply_config', aero.id, { template_id: tpl.id, parts: ['fields'], dry_run: true });
  assert.ok(preview.changes.some((c) => c.part === 'fields' && c.name === 'Chemistry' && c.action === 'add'));
  assert.equal((await one(`select count(*)::int c from pm_fields where project_id = $1 and key = 'chemistry'`, [aero.id])).c, 0, 'a preview changes nothing');
  await by(ce, 'pm_apply_config', aero.id, { template_id: tpl.id, parts: ['fields'] });
  assert.equal((await one(`select count(*)::int c from pm_fields where project_id = $1 and key = 'chemistry'`, [aero.id])).c, 1);
  assert.equal((await one(`select count(*)::int c from pm_fields where project_id = $1 and key = 'process'`, [aero.id])).c, 1, 'its own fields stay');
  assert.deepEqual(await all(`select id, name from pm_statuses where project_id = $1 order by name`, [aero.id]), before);
  assert.equal((await one(`select count(*)::int c from pm_items where project_id = $1`, [aero.id])).c, items);
  await rejects(by(member, 'pm_apply_config', aero.id, { template_id: tpl.id, parts: ['fields'] }), /Project settings/, '42501');
  // a field can't silently change kind
  const cfg = await by(ce, 'pm_export_config', aero.id, false);
  cfg.fields.find((f) => f.key === 'material').type = 'integer';
  await rejects(by(ce, 'pm_apply_config', aero.id, { config: cfg, parts: ['fields'] }), /kind can't change/);
});

await test('export / import: a configuration document round-trips; a broken one is refused whole', async () => {
  const cfg = await by(admin, 'pm_export_config', bat.id, true);
  assert.equal(cfg.format, 1);
  assert.ok(cfg.items.length > 5);
  const imported = await by(admin, 'pm_save_template', null, { name: 'Imported', config: cfg });
  const p = await by(admin, 'pm_save_project', null, { key: 'IMP', name: 'Imported', template_id: imported.id, start_date: '2027-06-01' });
  assert.equal((await one(`select count(*)::int c from pm_items where project_id = $1`, [p.id])).c, cfg.items.length);
  assert.equal((await one(`select count(*)::int c from pm_deps where to_project = $1`, [p.id])).c, cfg.deps.length);
  assert.equal((await one(`select count(*)::int c from pm_items where project_id = $1 and parent_id is not null`, [p.id])).c, cfg.items.filter((i) => i.parent_id).length);
  const before = (await one(`select count(*)::int c from pm_projects`)).c;
  await rejects(by(admin, 'pm_save_template', null, { name: 'Broken', config: { format: 2 } }), /isn't a one.solar project configuration/);
  const broken = structuredClone(cfg);
  broken.types[0].workflow_id = uuid();
  await rejects(by(admin, 'pm_save_template', null, { name: 'Broken', config: broken }), /workflow/);
  const evil = structuredClone(cfg);
  evil.automations = [{ id: uuid(), name: 'x', trigger: 'created', actions: [{ type: 'run_sql' }] }];
  await rejects(by(admin, 'pm_save_template', null, { name: 'Evil', config: evil }), /Unknown action/);
  assert.equal((await one(`select count(*)::int c from pm_projects`)).c, before, 'the scratch project used for checking is gone');
  assert.equal((await one(`select count(*)::int c from pm_templates where name in ('Broken', 'Evil')`)).c, 0);
});

// ---- automation ----------------------------------------------------------------------------------------
console.log('Automation');

await test('a rule runs when its trigger and conditions match, and every run is logged', async () => {
  await rejects(by(member, 'pm_save_automation', bat.id, null, { name: 'x', trigger: 'status', actions: [{ type: 'comment', text: 'hi' }] }), /Automation rules/, '42501');
  await rejects(by(pmgr, 'pm_save_automation', bat.id, null, { name: 'x', trigger: 'status', actions: [] }), /at least one action/);
  await rejects(by(pmgr, 'pm_save_automation', bat.id, null, { name: 'x', trigger: 'status', actions: [{ type: 'eval', code: '1' }] }), /Unknown action/);
  await rejects(by(pmgr, 'pm_save_automation', bat.id, null, { name: 'x', trigger: 'status', actions: [{ type: 'set_field', field: 'project_id', value: private1.id }] }), /can't be set by a rule/);
  const rule = await by(pmgr, 'pm_save_automation', bat.id, null, { name: 'Review asked → tell the lead', trigger: 'status', trigger_config: { to: st['In Review'] },
    conditions: { f: 'type_name', v: 'Design Review' },
    actions: [{ type: 'comment', text: '{key} is ready for review by {owner}.' }, { type: 'add_label', label: 'in-review' }, { type: 'notify', to: 'lead', message: 'Review needed: {title}' }] });
  const preview = await by(pmgr, 'pm_test_automation', bat.id, { trigger: 'status', conditions: { f: 'type_name', v: 'Design Review' }, actions: rule.actions });
  assert.ok(preview.matches > 3);
  assert.equal((await one(`select count(*)::int c from pm_automation_runs where rule_id = $1`, [rule.id])).c, 0, 'trying a rule doesn\'t run it');
  const it = await create(member, bat.id, review.id, 'Busbar review', { owner_id: member });
  await by(member, 'pm_transition', it.id, tr.design, {});
  assert.equal((await one(`select count(*)::int c from pm_automation_runs where rule_id = $1`, [rule.id])).c, 0, 'not this status');
  await by(member, 'pm_transition', it.id, tr.review, {});
  const run = await one(`select * from pm_automation_runs where rule_id = $1`, [rule.id]);
  assert.equal(run.status, 'ok');
  assert.match(run.detail, /commented; labelled in-review; notified/);
  assert.equal((await one(`select body from pm_comments where item_id = $1 and author_id is null`, [it.id])).body, `${it.key} is ready for review by Mia Member.`);
  assert.deepEqual((await item(it.id)).labels, ['in-review']);
  assert.equal((await one(`select count(*)::int c from pm_notifications where user_id = $1 and kind = 'automation' and item_id = $2`, [admin, it.id])).c, 1);
  // a Design Task doesn't match the condition
  const dt = await create(member, bat.id, designTask.id, 'A design task', { owner_id: member, custom: { chemistry: 'NMC' } });
  await by(member, 'pm_transition', dt.id, tr.design, {});
  await by(member, 'pm_transition', dt.id, tr.review, {});
  assert.equal((await one(`select count(*)::int c from pm_automation_runs where rule_id = $1`, [rule.id])).c, 1);
  await by(pmgr, 'pm_save_automation', bat.id, rule.id, { enabled: false });
});

await test('rules that set each other off are stopped; a failing rule is logged and never breaks what the person did', async () => {
  const ping = await by(pmgr, 'pm_save_automation', bat.id, null, { name: 'Ping', trigger: 'updated', trigger_config: { field: 'priority' }, actions: [{ type: 'set_field', field: 'progress', value: 10 }, { type: 'set_field', field: 'priority', value: 'low' }] });
  const pong = await by(pmgr, 'pm_save_automation', bat.id, null, { name: 'Pong', trigger: 'updated', trigger_config: { field: 'priority' }, actions: [{ type: 'set_field', field: 'priority', value: 'urgent' }] });
  const it = await create(member, bat.id, review.id, 'Loop bait', { owner_id: member });
  const res = await by(member, 'pm_update_item', it.id, null, { priority: 'medium' });
  assert.equal(res.priority, 'medium', 'the person\'s own change went through');
  const runs = await all(`select status, detail from pm_automation_runs where rule_id in ($1, $2) and item_id = $3 order by id`, [ping.id, pong.id, it.id]);
  assert.ok(runs.length <= 12, `the chain ended (${runs.length} runs)`);
  assert.ok(runs.some((r) => r.status === 'skipped' && /setting each other off/.test(r.detail)));
  await by(pmgr, 'pm_delete_automation', ping.id);
  await by(pmgr, 'pm_delete_automation', pong.id);
  // a rule whose action can't be done: logged as an error, the transition itself still happens
  const bad = await by(pmgr, 'pm_save_automation', bat.id, null, { name: 'Jump to Released', trigger: 'status', trigger_config: { to: st['In Design'] }, actions: [{ type: 'set_status', status: st.Released }] });
  await by(member, 'pm_transition', it.id, tr.design, {});
  assert.equal((await item(it.id)).status, 'In Design');
  const run = await one(`select status, detail from pm_automation_runs where rule_id = $1`, [bad.id]);
  assert.equal(run.status, 'error');
  assert.match(run.detail, /no move from "In Design" to "Released"/);
  await by(pmgr, 'pm_delete_automation', bad.id);
});

await test('a rule can create a follow-up item and move items along the workflow', async () => {
  const sub = await typeId(bat.id, 'Subtask');
  const rule = await by(pmgr, 'pm_save_automation', bat.id, null, { name: 'New review → checklist task', trigger: 'created', conditions: { f: 'type', v: review.id },
    actions: [{ type: 'create_item', type_id: sub, title: 'Book a room for {title}', owner: 'reporter', due_in_days: 3 }, { type: 'set_status', status: st['In Design'] }] });
  const it = await create(member, bat.id, review.id, 'Harness review', { owner_id: member });
  const child = await one(`select * from pm_items where parent_id = $1`, [it.id]);
  assert.equal(child.title, 'Book a room for Harness review');
  assert.equal(child.owner_id, member);
  assert.equal((await item(it.id)).status, 'In Design');
  assert.equal((await one(`select data from pm_events where item_id = $1 and kind = 'status'`, [it.id])).data.how, 'automation');
  await by(pmgr, 'pm_delete_automation', rule.id);
});

await test('timed rules and reminders run once per item per date, however often they\'re asked to', async () => {
  const soon = await create(member, bat.id, review.id, 'Due tomorrow', { owner_id: member, due_date: (await one('select (current_date + 1)::text d')).d }); // the database's own idea of tomorrow
  const late = await create(pmgr, bat.id, review.id, 'Late one', { owner_id: member, due_date: '2020-01-01' });
  const rule = await by(pmgr, 'pm_save_automation', bat.id, null, { name: 'Overdue → flag', trigger: 'overdue', conditions: { f: 'title', op: 'contains', v: 'Late one' }, actions: [{ type: 'add_label', label: 'late' }, { type: 'set_field', field: 'priority', value: 'urgent' }] });
  const weekly = await by(pmgr, 'pm_save_automation', bat.id, null, { name: 'Daily standup notes', trigger: 'schedule', trigger_config: { every: 'day' }, actions: [{ type: 'create_item', type_id: review.id, title: 'Standup notes', owner: 'lead' }] });
  assert.equal((await by(member, 'pm_run_scheduled')).ran, true);
  assert.equal((await by(member, 'pm_run_scheduled')).ran, false, 'at most every 30 minutes');
  assert.deepEqual((await item(late.id)).labels, ['late']);
  assert.equal((await item(late.id)).priority, 'urgent');
  assert.equal((await one(`select count(*)::int c from pm_notifications where item_id = $1 and kind = 'due' and user_id = $2`, [soon.id, member])).c, 1);
  assert.equal((await one(`select count(*)::int c from pm_items where project_id = $1 and title = 'Standup notes'`, [bat.id])).c, 1);
  await db.query(`update pm_schedule_state set last_run = now() - interval '1 hour'`);
  await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  assert.equal((await call('pm_run_scheduled')).ran, true, 'a scheduled job with nobody signed in');
  assert.equal((await one(`select count(*)::int c from pm_automation_runs where rule_id = $1 and item_id = $2`, [rule.id, late.id])).c, 1, 'once per item per due date');
  assert.equal((await one(`select count(*)::int c from pm_items where project_id = $1 and title = 'Standup notes'`, [bat.id])).c, 1, 'once per day');
  assert.equal((await one(`select count(*)::int c from pm_notifications where item_id = $1 and kind = 'due'`, [soon.id])).c, 1);
  await as(pmgr, async () => { await call('pm_delete_automation', rule.id); await call('pm_delete_automation', weekly.id); });
});

// ---- notifications -------------------------------------------------------------------------------------
console.log('Notifications');

await test('the inbox: assignments, mentions and comments reach the right people, never the person who did it', async () => {
  const it = await create(pmgr, bat.id, review.id, 'Notify me', { owner_id: member });
  const inbox = (uid) => all(`select kind, title from pm_notifications where user_id = $1 and item_id = $2 order by id`, [uid, it.id]);
  assert.deepEqual((await inbox(member)).map((x) => x.kind), ['assigned']);
  assert.deepEqual(await inbox(pmgr), []);
  await by(pmgr, 'pm_comment', it.id, 'Can you look at this, Abe?', [approver, guest, other]);
  assert.deepEqual((await inbox(approver)).map((x) => x.kind), ['mentioned']);
  assert.deepEqual((await inbox(member)).map((x) => x.kind), ['assigned', 'comment']);
  assert.equal((await one(`select count(*)::int c from pm_notifications where user_id = $1`, [guest])).c, 0, 'a guest is never told anything');
  // the same notice twice in a row is one notice
  await by(pmgr, 'pm_comment', it.id, 'And one more thing', []);
  assert.deepEqual((await inbox(member)).map((x) => x.kind), ['assigned', 'comment']);
  assert.equal(await visibleCount(pmgr, 'pm_notifications', 'user_id = $1', [member]), 0, 'an inbox is private');
  await by(member, 'pm_mark_read', null);
  assert.equal((await one(`select count(*)::int c from pm_notifications where user_id = $1 and read_at is null`, [member])).c, 0);
  // turning a kind off
  await by(member, 'pm_save_prefs', { notify: { comment: { inapp: false } } });
  await by(pmgr, 'pm_comment', it.id, 'Muted?', []);
  assert.equal((await one(`select count(*)::int c from pm_notifications where user_id = $1 and item_id = $2 and read_at is null`, [member, it.id])).c, 0);
  await by(member, 'pm_save_prefs', { notify: {} });
});

await test('email / Teams go through the existing outbox, only when an Admin turned them on, and not for bulk edits', async () => {
  const count = async () => (await one(`select count(*)::int c from notification_outbox where event = 'project_update'`)).c;
  const a = await create(pmgr, bat.id, review.id, 'Outbox A', { owner_id: member });
  assert.equal(await count(), 0, 'off by default');
  await as(admin, () => call('update_settings', 'notifications', { enabled: true, events: { project_update: { email: true, teams: false } } }));
  const b = await create(pmgr, bat.id, review.id, 'Outbox B', { owner_id: member });
  const rows = await all(`select email, channel, payload from notification_outbox where event = 'project_update'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'pm-member@ufl.edu');
  assert.match(rows[0].payload.what, new RegExp(`^${b.key}: Assigned to you`));
  assert.equal(rows[0].payload.app_path, `projects/#/projects/item/${b.key}`);
  const res = await by(pmgr, 'pm_bulk_update', [a.id, b.id], { owner_id: approver, priority: 'high' });
  assert.equal(res.changed, 2);
  assert.equal(await count(), 1, 'a bulk edit sends no email');
  assert.equal((await one(`select count(*)::int c from pm_notifications where user_id = $1 and kind = 'assigned' and item_id = any($2)`, [approver, [a.id, b.id]])).c, 2, 'but the inbox still shows it');
  await as(admin, () => call('update_settings', 'notifications', { enabled: false, events: {} }));
});

await test('a bulk edit reports the items it couldn\'t change instead of failing or skipping silently', async () => {
  const a = await create(member, bat.id, review.id, 'Bulk A');
  const hidden = (await one(`select id from pm_items where project_id = $1 limit 1`, [private1.id])).id;
  const res = await by(member, 'pm_bulk_update', [a.id, hidden], { priority: 'low', add_labels: ['bulk'] });
  assert.equal(res.changed, 1);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].error, /can't see it/);
  assert.deepEqual((await item(a.id)).labels, ['bulk']);
  await rejects(by(member, 'pm_bulk_update', [a.id], { title: 'Same for all' }), /can't be changed on many items/);
});

// ---- documents and links -------------------------------------------------------------------------------
console.log('Documents and links');

await test('a Teams / SharePoint document is linked by its address alone; only https addresses are kept', async () => {
  const url = 'https://uflorida.sharepoint.com/:x:/r/sites/SolarGators/Shared%20Documents/Battery/Pack%20sizing.xlsx?d=w1&csf=1&web=1';
  const r = await by(member, 'pm_add_resource', { item_id: t1.id, url, title: 'Pack sizing', category: 'Analysis', provider: 'sharepoint', kind: 'file', file_type: 'xlsx' });
  assert.equal(r.url, url);
  const other2 = chain[0];
  await by(member, 'pm_add_resource', { item_id: other2.id, url, title: 'Pack sizing', category: '' });
  assert.equal((await one(`select count(*)::int c from pm_resources where project_id = $1 and url = $2`, [bat.id, url])).c, 1, 'one document');
  assert.equal((await one(`select count(*)::int c from pm_resource_links where resource_id = $1`, [r.id])).c, 2, 'on two items');
  await by(member, 'pm_add_resource', { project_id: bat.id, url: 'https://teams.microsoft.com/l/channel/19%3Aabc/General?groupId=1', title: 'Battery channel files', kind: 'folder', provider: 'teams' });
  for (const bad of ['javascript:alert(1)', 'http://insecure.example.com/x', 'data:text/html,<script>', 'https://ok.example.com/a b', 'https://x.example.com/"onmouseover="x', 'file:///etc/passwd', '']) {
    await rejects(by(member, 'pm_add_resource', { item_id: t1.id, url: bad, title: 'x' }), /full link/);
  }
  await rejects(by(other, 'pm_add_resource', { item_id: t1.id, url: 'https://example.com/x', title: 'viewer' }), /Create items/, '42501');
  const link = await one(`select id from pm_resource_links where resource_id = $1 and item_id = $2`, [r.id, other2.id]);
  await by(member, 'pm_remove_resource_link', link.id);
  assert.equal((await one(`select count(*)::int c from pm_resources where id = $1`, [r.id])).c, 1, 'still used by the other item');
  assert.equal(await visibleCount(guest, 'pm_resources'), 0);
});

await test('an item links to an Orders request and an Inventory item without changing either', async () => {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [member]);
  const req = (await db.query(`insert into requests (request_number, created_by, requester, title, status)
    values ('SG27-900', $1, 'Mia Member', 'Nickel strip', 'Ordered') returning id`, [member])).rows[0].id;
  const ref = await by(member, 'pm_add_ref', t1.id, 'order', req, 'Waiting on delivery');
  assert.equal(ref.label, 'SG27-900 · Nickel strip');
  await rejects(by(member, 'pm_add_ref', t1.id, 'order', uuid(), ''), /doesn't exist/);
  const unit = (await one(`select code from inventory_units limit 1`)).code;
  const cat = await by(admin, 'inventory_save_item', null, { name: 'Nickel strip 0.2mm', unit, sku: 'NI-STRIP' });
  const inv = await by(member, 'pm_add_ref', t1.id, 'inventory', cat, '');
  assert.match(inv.label, /NI-STRIP · Nickel strip/);
  assert.equal((await one(`select status from requests where id = $1`, [req])).status, 'Ordered');
  await db.query(`delete from role_permissions where role = 'member' and permission like 'inventory.%'`);
  await rejects(by(member, 'pm_add_ref', t1.id, 'inventory', cat, ''), /can't see Inventory/, '42501');
  await rejects(by(other, 'pm_add_ref', t1.id, 'order', req, ''), /Edit items/, '42501');
  await by(member, 'pm_remove_ref', inv.id);
  // 060: the project adds up what its linked requests cost; nobody who can't see the links gets them
  await db.query(`insert into request_items (request_id, item_name, quantity, unit_price, position) values ($1, 'Nickel strip', 2, 25, 0)`, [req]);
  const spend = await by(member, 'pm_project_spend', t1.project_id);
  assert.deepEqual(spend.map((x) => [x.number, x.status, Number(x.total), x.items]), [['SG27-900', 'Ordered', 50, [t1.key]]]);
  assert.deepEqual(await by(guest, 'pm_project_spend', t1.project_id), []);
});

await test('061: team dates, parts reserved from Inventory, and orders not placed in time', async () => {
  // team dates: everyone in Projects reads them; only "manage Projects" keeps them
  await rejects(by(member, 'pm_save_key_date', null, { day: '2027-07-01', name: 'ASC' }), /projects\.manage/);
  const asc = await by(admin, 'pm_save_key_date', null, { day: '2027-07-01', end_day: '2027-07-09', name: 'ASC', kind: 'competition' });
  await rejects(by(admin, 'pm_save_key_date', null, { day: '2027-07-09', end_day: '2027-07-01', name: 'Backwards' }), /check constraint/);
  assert.deepEqual((await as(member, () => db.query(`select name, kind from pm_key_dates`))).rows, [{ name: 'ASC', kind: 'competition' }]);
  assert.equal(await visibleCount(guest, 'pm_key_dates'), 0);
  await by(admin, 'pm_delete_key_date', asc);
  assert.equal((await one(`select count(*)::int c from pm_key_dates`)).c, 0);

  // parts: a quantity reserves them while the item is open
  const unit = (await one(`select code from inventory_units limit 1`)).code;
  const cells = await by(admin, 'inventory_save_item', null, { name: 'Cells 21700', unit, sku: 'CELL-21700' });
  const ref = await by(admin, 'pm_add_ref', t1.id, 'inventory', cells, '');
  await by(admin, 'pm_set_ref_qty', ref.id, 40);
  const res = await by(admin, 'inventory_reserved', [cells]);
  assert.equal(Number(res[cells].total), 40);
  assert.equal(res[cells].items[0].key, t1.key);
  await rejects(by(admin, 'pm_set_ref_qty', ref.id, -1), /above 0/);
  await rejects(by(other, 'pm_set_ref_qty', ref.id, 2), /Edit items/, '42501');
  assert.deepEqual(await by(guest, 'inventory_reserved', [cells]), {});

  // an order that isn't placed, for an item starting in 3 days: a warning, and its owner and manager are told once
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [member]);
  const req = (await db.query(`insert into requests (request_number, created_by, requester, title, status)
    values ('SG27-901', $1, 'Mia Member', 'Cells', 'Approved') returning id`, [member])).rows[0].id;
  const soon = (await one(`select (current_date + 3)::text d`)).d;
  const later = (await one(`select (current_date + 30)::text d`)).d;
  const job = await create(admin, t1.project_id, t1.type_id, 'Build the pack', { start_date: soon, owner_id: member });
  const far = await create(admin, t1.project_id, t1.type_id, 'Later job', { start_date: later });
  await by(admin, 'pm_add_ref', job.id, 'order', req, '');
  await by(admin, 'pm_add_ref', far.id, 'order', req, '');
  const warn = await by(admin, 'pm_order_warnings', t1.project_id);
  assert.deepEqual(warn.map((w) => [w.key, w.number, w.status]), [[job.key, 'SG27-901', 'Approved']]);
  assert.deepEqual(await by(guest, 'pm_order_warnings', t1.project_id), []);
  const told = () => all(`select user_id from pm_notifications where item_id = $1 and title like 'Order not placed%' order by user_id`, [job.id]);
  await db.query(`update pm_schedule_state set last_run = null`);
  const ran = await by(admin, 'pm_run_scheduled');
  assert.equal(ran.ran, true);
  assert.ok(ran.order_alerts >= 1);
  assert.ok((await told()).some((r) => r.user_id === member), 'the owner is told');
  const n = (await told()).length;
  await db.query(`update pm_schedule_state set last_run = null`);
  await by(admin, 'pm_run_scheduled');
  assert.equal((await told()).length, n, 'not again within 3 days');
  // ordered: no warning any more
  await db.query(`update requests set status = 'Ordered' where id = $1`, [req]);
  assert.deepEqual(await by(admin, 'pm_order_warnings', t1.project_id), []);
});

// ---- planning ------------------------------------------------------------------------------------------
console.log('Planning');

await test('sprints are optional: start one, close it, unfinished work carries over', async () => {
  await rejects(by(member, 'pm_save_sprint', bat.id, null, { name: 'S1' }), /Plan and schedule/, '42501');
  const s1 = await by(pmgr, 'pm_save_sprint', bat.id, null, { name: 'Sprint 1', start_date: '2027-01-04', end_date: '2027-01-17', goal: 'Cells chosen' });
  const s2 = await by(pmgr, 'pm_save_sprint', bat.id, null, { name: 'Sprint 2' });
  await by(pmgr, 'pm_save_sprint', bat.id, s1.id, { status: 'active' });
  await rejects(by(pmgr, 'pm_save_sprint', bat.id, s2.id, { status: 'active' }), /Another sprint is still running/);
  const a = await create(pmgr, bat.id, review.id, 'Sprint item A', { sprint_id: s1.id });
  const b = await create(pmgr, bat.id, review.id, 'Sprint item B', { sprint_id: s1.id });
  await rejects(by(member, 'pm_update_item', a.id, null, { sprint_id: s2.id }), /Plan and schedule/, '42501');
  await by(pmgr, 'pm_transition', a.id, tr.design, {});
  await by(admin, 'pm_save_workflow', bat.id, wf.id, { ...(await one(`select public.pmx_workflow_json($1) j`, [wf.id])).j });
  const closed = await by(pmgr, 'pm_save_sprint', bat.id, s1.id, { status: 'closed', move_to: s2.id });
  assert.equal(closed.summary.carried.length, 2);
  assert.equal((await item(b.id)).sprint_id, s2.id);
  await rejects(by(pmgr, 'pm_save_sprint', bat.id, s1.id, { name: 'x' }), /closed/);
});

await test('baselines and rescheduling: dates only move when someone says so, all together, and it\'s in the history', async () => {
  const [a, b] = chain;
  await by(pmgr, 'pm_reschedule', bat.id, { [a.id]: { start: '2027-01-04', due: '2027-01-08' }, [b.id]: { start: '2027-01-11', due: '2027-01-15' } }, 'First plan', null);
  const base = await by(pmgr, 'pm_save_baseline', bat.id, 'Plan of record');
  const snap = (await one(`select snapshot from pm_baselines where id = $1`, [base.id])).snapshot;
  assert.deepEqual(snap[a.id], { start: '2027-01-04', due: '2027-01-08' });
  // a what-if is kept apart from the live dates until it's applied
  const sc = await by(pmgr, 'pm_save_scenario', bat.id, null, { name: 'Cells arrive late', changes: { [a.id]: { start: '2027-01-11', due: '2027-01-15' }, [b.id]: { start: '2027-01-18', due: '2027-01-22' } } });
  assert.equal((await item(a.id)).due_date.toISOString?.().slice(0, 10) ?? String((await item(a.id)).due_date).slice(0, 10), '2027-01-08');
  await rejects(by(member, 'pm_reschedule', bat.id, sc.changes, '', sc.id), /Plan and schedule/, '42501');
  await rejects(by(pmgr, 'pm_reschedule', bat.id, { [a.id]: { start: '2027-02-01', due: '2027-01-01' } }, '', null), /start date is after/);
  const foreign = (await one(`select id from pm_items where project_id = $1 limit 1`, [aero.id])).id;
  await rejects(by(pmgr, 'pm_reschedule', bat.id, { [a.id]: { start: '2027-03-01', due: '2027-03-02' }, [foreign]: { start: '2027-03-01', due: '2027-03-02' } }, '', null), /isn't in this project/);
  assert.equal(String((await one(`select due_date::text d from pm_items where id = $1`, [a.id])).d), '2027-01-08', 'all or nothing');
  await by(pmgr, 'pm_reschedule', bat.id, sc.changes, 'Cells arrive a week late', sc.id);
  assert.equal((await one(`select due_date::text d from pm_items where id = $1`, [b.id])).d, '2027-01-22');
  assert.ok((await one(`select applied_at from pm_scenarios where id = $1`, [sc.id])).applied_at);
  assert.deepEqual((await one(`select data from pm_events where item_id = $1 and kind = 'updated' order by id desc limit 1`, [b.id])).data.changes.due_date, ['2027-01-15', '2027-01-22']);
  assert.deepEqual((await one(`select snapshot from pm_baselines where id = $1`, [base.id])).snapshot[b.id], { start: '2027-01-11', due: '2027-01-15' }, 'the baseline keeps the old plan');
  await by(pmgr, 'pm_save_event', bat.id, null, { title: 'Design review day', starts_on: '2027-01-20', repeat: 'monthly' });
  assert.equal(await visibleCount(member, 'pm_calendar_events', 'project_id = $1', [bat.id]), 1);
});

await test('moving an item to another project keeps its history, comments and documents; its old name still finds it', async () => {
  await by(admin, 'pm_save_field', bat.id, null, { key: 'bat_only', name: 'Battery only', type: 'text' });
  const it = await create(member, bat.id, designTask.id, 'Moves to Aero', { owner_id: member, custom: { chemistry: 'NMC', bat_only: 'x' } });
  await by(member, 'pm_comment', it.id, 'Context that must survive', []);
  await by(member, 'pm_add_resource', { item_id: it.id, url: 'https://example.sharepoint.com/sites/x/doc.docx', title: 'Spec' });
  const sub = await create(member, bat.id, await typeId(bat.id, 'Subtask'), 'Stays behind', { parent_id: it.id });
  await rejects(by(member, 'pm_move_item', it.id, { project_id: aero.id, type_id: await typeId(aero.id, 'Manufacturing Job') }), /Create items/, '42501');
  await by(ce, 'pm_set_member', aero.id, member, await role(aero.id, 'contributor'));
  await rejects(by(member, 'pm_move_item', it.id, { project_id: aero.id }), /Pick what kind of item/, 'OS428');
  const moved = await by(member, 'pm_move_item', it.id, { project_id: aero.id, type_id: await typeId(aero.id, 'Manufacturing Job') });
  assert.match(moved.key, /^AERO-\d+$/);
  assert.equal(moved.id, it.id, 'the same item');
  assert.deepEqual(moved.custom, { chemistry: 'NMC' }, 'only fields the new project has (chemistry was added from the template)');
  assert.equal((await one(`select item_id from pm_item_aliases where key = $1`, [it.key])).item_id, it.id);
  assert.equal((await one(`select count(*)::int c from pm_events where item_id = $1 and project_id = $2`, [it.id, aero.id])).c, (await one(`select count(*)::int c from pm_events where item_id = $1`, [it.id])).c);
  assert.equal((await one(`select count(*)::int c from pm_comments where item_id = $1 and project_id = $2`, [it.id, aero.id])).c, 1);
  assert.equal((await one(`select r.project_id from pm_resource_links l join pm_resources r on r.id = l.resource_id where l.item_id = $1`, [it.id])).project_id, aero.id);
  assert.deepEqual((await one(`select data from pm_events where item_id = $1 and kind = 'moved'`, [it.id])).data.dropped_fields, { bat_only: 'x' });
  assert.equal((await item(sub.id)).parent_id, null);
  assert.equal((await item(sub.id)).project_id, bat.id);
});

// ---- dashboards ----------------------------------------------------------------------------------------
console.log('Dashboards');

await test('the roll-up counts only projects its reader can see, by project, division and subsystem', async () => {
  const div = await by(admin, 'org_save_division', null, 'Electrical', null);
  const sub = await by(admin, 'org_save_subsystem', null, div.id ?? div, 'Battery', null);
  const subId = sub.id ?? sub;
  await by(member, 'pm_update_item', chain[0].id, null, { subsystem_id: subId, estimate_hours: 8 });
  assert.equal((await item(chain[0].id)).division_id, div.id ?? div, 'the division comes from the subsystem');
  const forAdmin = await by(admin, 'pm_rollup');
  const forMember = await by(member, 'pm_rollup');
  const projects = (r) => new Set(r.groups.map((g) => g.project_id));
  assert.ok(projects(forAdmin).has(private1.id));
  assert.equal(projects(forMember).has(private1.id), false);
  const g = forMember.groups.find((x) => x.project_id === bat.id && x.subsystem_id === subId);
  assert.equal(g.total, 1);
  assert.equal(Number(g.est_total), 8);
  const total = forMember.groups.filter((x) => x.project_id === bat.id).reduce((s, x) => s + x.total, 0);
  assert.equal(total, (await one(`select count(*)::int c from pm_items where project_id = $1 and archived_at is null`, [bat.id])).c);
  assert.deepEqual(await by(guest, 'pm_rollup'), { groups: [], trend: [] });
  // renaming a subsystem keeps the link; history keeps the names of the time
  await by(admin, 'org_save_subsystem', subId, div.id ?? div, 'Battery pack', null);
  assert.equal((await item(chain[0].id)).subsystem_id, subId);
});

await test('archiving a project hides nothing from history but stops new work; changing settings is versioned', async () => {
  const p = await one(`select * from pm_projects where id = $1`, [aero.id]);
  await rejects(by(ce, 'pm_save_project', aero.id, { name: 'Stale', version: p.version - 1 }), /Someone else changed this project/, 'OS409');
  await rejects(by(member, 'pm_save_project', aero.id, { name: 'Not mine' }), /Project settings/, '42501');
  await rejects(by(ce, 'pm_save_project', aero.id, { settings: { working_days: [] } }), /at least one working day/);
  await rejects(by(ce, 'pm_save_project', aero.id, { settings: { holidays: ['someday'] } }), /isn't a date/);
  const saved = await by(ce, 'pm_save_project', aero.id, { settings: { working_days: [1, 2, 3, 4, 5, 6], holidays: ['2027-01-18'] }, archived: true, version: p.version });
  assert.ok(saved.archived_at);
  await rejects(create(ce, aero.id, await typeId(aero.id, 'Manufacturing Job'), 'After archive'), /archived/);
  await by(ce, 'pm_save_project', aero.id, { archived: false });
});

console.log(`\n${passed} projects tests passed${process.exitCode ? ', some failed' : ''}`);
