/**
 * The link registry (migration 068): any one.solar app can be linked from Projects by registering a kind of
 * record and two functions, with no change to Projects. Run as real users against PGlite with every migration.
 *
 *   node tests/linkRegistry.test.mjs
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

let n = 0;
async function person(email, name, roles = ['member']) {
  const id = `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`;
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, email, { full_name: name }]);
  await db.query(`delete from profile_roles where user_id = $1`, [id]);
  for (const r of roles) await db.query(`insert into profile_roles (user_id, role) values ($1, $2)`, [id, r]);
  return id;
}
const admin = await person('lr-admin@ufl.edu', 'Ada Admin', ['admin']);
const member = await person('lr-member@ufl.edu', 'Mia Member');
const guest = await person('lr-guest@ufl.edu', 'Gus Guest', []);

const project = await by(admin, 'pm_save_project', null, { key: 'lnk', name: 'Links' });
await by(admin, 'pm_set_member', project.id, member, (await one(`select id from pm_roles where project_id = $1 and key = 'contributor'`, [project.id])).id);
const taskType = (await one(`select id from pm_types where project_id = $1 and level = 1 order by sort limit 1`, [project.id])).id;
const task = await by(member, 'pm_create_item', randomUUID(), { project_id: project.id, type_id: taskType, title: 'Busbar design' });

await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [member]);
const req = (await one(`insert into requests (request_number, created_by, requester, title, status)
  values ('SG27-101', $1, 'Mia Member', 'Nickel 100%_strip', 'Approved') returning id`, [member])).id;
const unit = (await one(`select code from inventory_units limit 1`)).code;
const part = await by(admin, 'inventory_save_item', null, { name: 'Nickel strip 0.2mm', unit, sku: 'NI-STRIP' });

console.log('Link registry (068)');

await test('Orders and Inventory are registered, and the website can read the registry but not change it', async () => {
  const kinds = await as(member, async () => (await db.query(`select key, label, add_label from os_link_types order by sort`)).rows);
  assert.deepEqual(kinds, [
    { key: 'order', label: 'Order', add_label: 'Link an order' },
    { key: 'inventory', label: 'Inventory', add_label: 'Link an inventory item' },
    { key: 'event', label: 'Event', add_label: 'Link an event' },              // 069
    { key: 'sponsor', label: 'Sponsor', add_label: 'Link a sponsor' },
    { key: 'item', label: 'Related item', add_label: 'Link a related item' },
  ]);
  await rejects(as(admin, () => db.query(`delete from os_link_types`)), /permission denied/);
  await rejects(as(admin, () => db.query(`update os_link_types set active = false`)), /permission denied/);
});

await test('search finds Orders requests by number or title, and treats % and _ as plain text', async () => {
  const hits = await by(member, 'os_link_search', 'order', '101');
  assert.deepEqual(hits.map((h) => [h.code, h.title, h.status, h.tone, h.path]), [['SG27-101', 'Nickel 100%_strip', 'Approved', 'amber', 'orders/#/requests/SG27-101']]);
  assert.equal((await by(member, 'os_link_search', 'order', '100%_')).length, 1);
  assert.equal((await by(member, 'os_link_search', 'order', 'Nickel%strip')).length, 0, 'a % is a %, not "anything"');
  assert.deepEqual(await by(member, 'os_link_search', 'order', '   '), []);
});

await test('describe gives each record as it is now: status, color, a detail line and where it opens', async () => {
  let [d] = await by(member, 'os_link_describe', 'order', [req]);
  assert.deepEqual([d.status, d.tone, d.detail], ['Approved', 'amber', 'not here yet']);
  await db.query(`update requests set status = 'Received' where id = $1`, [req]);
  [d] = await by(member, 'os_link_describe', 'order', [req]);
  assert.deepEqual([d.status, d.tone, d.detail], ['Received', 'green', null]);
  assert.deepEqual(await by(member, 'os_link_describe', 'nope', [req]), [], 'an unknown kind is just empty');
  assert.deepEqual(await by(member, 'os_link_describe', 'order', [randomUUID()]), []);
});

await test('each app decides who sees its records: Inventory needs an Inventory permission', async () => {
  const saved = (await db.query(`select role, permission from role_permissions where role = 'member' and permission like 'inventory.%'`)).rows;
  try {
    assert.equal((await by(member, 'os_link_search', 'inventory', 'NI-')).length, 1);
    await db.query(`delete from role_permissions where role = 'member' and permission like 'inventory.%'`);
    await rejects(by(member, 'os_link_search', 'inventory', 'NI-'), /can't see Inventory/, '42501');
    assert.deepEqual(await by(member, 'os_link_describe', 'inventory', [part]), [], 'hidden, not an error');
  } finally {
    for (const r of saved) await db.query(`insert into role_permissions (role, permission) values ($1, $2) on conflict do nothing`, [r.role, r.permission]);
  }
});

await test('the apps\' own link functions can\'t be called from the website, only through the checked ones', async () => {
  for (const f of [`orders_link_describe(array[$1::uuid])`, `inventory_link_search('x', 5)`, `os_link_type('order')`]) {
    await rejects(as(member, () => db.query(`select * from public.${f.replace('$1::uuid', `'${req}'::uuid`)}`)), /permission denied/);
  }
  await rejects(as(null, () => db.query(`select public.os_link_search('order', 'x')`)), /permission denied/);
  await rejects(as(guest, () => call('os_link_search', 'order', 'x')), /accepted team members/);
});

await test('pm_add_ref still links Orders and Inventory as before, and an unregistered kind can\'t be stored', async () => {
  const ref = await by(member, 'pm_add_ref', task.id, 'order', req, 'Waiting on delivery');
  assert.equal(ref.label, 'SG27-101 · Nickel 100%_strip');
  assert.equal((await one(`select summary from pm_events where item_id = $1 order by id desc limit 1`, [task.id])).summary, 'Linked the order SG27-101 · Nickel 100%_strip');
  await rejects(by(member, 'pm_add_ref', task.id, 'nope', req, ''), /Unknown kind of link/);
  await rejects(db.query(`insert into pm_refs (item_id, project_id, kind, ref_id) values ($1, $2, 'nope', $3)`, [task.id, project.id, req]), /foreign key/);
});

await test('a new app joins by registering two functions: no Projects change, and its permission rule holds', async () => {
  // a stand-in "widgets" app with its own table and its own rule (only people who may create projects see widgets)
  await db.exec(`
    create table public.widgets (id uuid primary key default gen_random_uuid(), tag text not null, name text not null, state text not null);
    create function public.widgets_can() returns boolean language sql stable security definer set search_path = public as $$ select has_permission('projects.create') $$;
    create function public.widgets_link_describe(p_ids uuid[]) returns setof public.os_link_row language sql stable security definer set search_path = public as $$
      select w.id, w.tag, w.name, w.state, case w.state when 'ready' then 'green' else 'gray' end, null::text, 'widgets/#/' || w.id
      from widgets w where widgets_can() and w.id = any(p_ids) $$;
    create function public.widgets_link_search(p_q text, p_limit int) returns setof public.os_link_row language sql stable security definer set search_path = public as $$
      select d.* from widgets w cross join lateral widgets_link_describe(array[w.id]) d where w.name ilike '%' || p_q || '%' limit p_limit $$;
    revoke execute on function public.widgets_link_describe(uuid[]), public.widgets_link_search(text, int) from public, anon, authenticated;
    insert into public.os_link_types (key, app, label, noun, add_label, search_fn, describe_fn, can_fn, deny_message, sort)
      values ('widget', 'widgets', 'Widget', 'widget', 'Link a widget', 'public.widgets_link_search(text, int)', 'public.widgets_link_describe(uuid[])',
              'public.widgets_can()', 'Only approvers can link widgets.', 30);`);
  const w = (await one(`insert into widgets (tag, name, state) values ('W-7', 'Cell holder jig', 'ready') returning id`)).id;
  await rejects(by(member, 'pm_add_ref', task.id, 'widget', w, ''), /Only approvers can link widgets/, '42501');
  await db.query(`insert into role_permissions (role, permission) values ('member', 'projects.create') on conflict do nothing`);
  try {
    assert.deepEqual((await by(member, 'os_link_search', 'widget', 'jig')).map((x) => x.code), ['W-7']);
    const ref = await by(member, 'pm_add_ref', task.id, 'widget', w, '');
    assert.equal(ref.label, 'W-7 · Cell holder jig');
    assert.equal((await one(`select summary from pm_events where item_id = $1 order by id desc limit 1`, [task.id])).summary, 'Linked the widget W-7 · Cell holder jig');
    const [d] = await by(member, 'os_link_describe', 'widget', [w]);
    assert.deepEqual([d.status, d.tone, d.path], ['ready', 'green', `widgets/#/${w}`]);
  } finally {
    await db.query(`delete from role_permissions where role = 'member' and permission = 'projects.create'`);
  }
});

await test('the other side: a linked record lists the project items, only for people who can see the project', async () => {
  const seen = (uid) => as(uid, async () => (await db.query(`select i.key from pm_refs f join pm_items i on i.id = f.item_id where f.kind = 'order' and f.ref_id = $1`, [req])).rows.map((r) => r.key));
  assert.deepEqual(await seen(member), [task.key]);
  assert.deepEqual(await seen(guest), []);
});

console.log(`\n${passed} link registry tests passed`);
