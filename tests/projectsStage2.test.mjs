/**
 * Projects Stage 2 (migration 069): three more move checks (children_done, parent_status, been_in), and Events,
 * Sponsors and related items in the link registry. Run as real users against PGlite with every migration.
 *
 *   node tests/projectsStage2.test.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb } from './support/supabase-stub.mjs';
import { starterRules } from '../orders/js/projects/core.js';

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
const admin = await person('s2-admin@ufl.edu', 'Ada Admin', ['admin']);
const member = await person('s2-member@ufl.edu', 'Mia Member');
const outsider = await person('s2-out@ufl.edu', 'Otto Outside');

const project = await by(admin, 'pm_save_project', null, { key: 'stg', name: 'Stage two' });
await by(admin, 'pm_set_member', project.id, member, (await one(`select id from pm_roles where project_id = $1 and key = 'contributor'`, [project.id])).id);
const taskType = (await one(`select id, workflow_id from pm_types where project_id = $1 and level = 1 order by sort limit 1`, [project.id]));
const statuses = (await db.query(`select id, name, category from pm_statuses where workflow_id = $1 order by sort`, [taskType.workflow_id])).rows;
const first = statuses[0];
const doing = statuses.find((s) => s.category === 'doing');
const done = statuses.find((s) => s.category === 'done');
const moveTo = async (statusId) => (await one(`select id from pm_transitions where workflow_id = $1 and to_status = $2 order by from_status nulls first limit 1`, [taskType.workflow_id, statusId])).id;
const newItem = (title) => by(member, 'pm_create_item', randomUUID(), { project_id: project.id, type_id: taskType.id, title });
const matches = (item, c) => call('pmx_matches', item.id, c);

console.log('Projects Stage 2 (069)');

await test('"all items under it are done": false while one is open, true once all are done, true with none', async () => {
  const parent = await newItem('Pack assembly');
  const a = await newItem('Cell holders');
  const b = await newItem('Busbars');
  await db.query(`update pm_items set parent_id = $1 where id = any($2)`, [parent.id, [a.id, b.id]]);
  assert.equal(await matches(parent, { f: 'children_done' }), false);
  assert.equal(await matches(parent, { f: 'children_done', v: false }), true);
  await db.query(`update pm_items set category = 'done' where id = $1`, [a.id]);
  assert.equal(await matches(parent, { f: 'children_done' }), false);
  await db.query(`update pm_items set archived_at = now() where id = $1`, [b.id]);
  assert.equal(await matches(parent, { f: 'children_done' }), true, 'archived items under it don\'t count');
  assert.equal(await matches(a, { f: 'children_done' }), true, 'nothing under it');
});

await test('"parent\'s status" checks the parent by status name; no parent never matches "is"', async () => {
  const parent = await newItem('Enclosure');
  const child = await newItem('Lid');
  await db.query(`update pm_items set parent_id = $1 where id = $2`, [parent.id, child.id]);
  assert.equal(await matches(child, { f: 'parent_status', op: 'eq', v: first.name }), true);
  assert.equal(await matches(child, { f: 'parent_status', op: 'eq', v: doing.name }), false);
  assert.equal(await matches(child, { f: 'parent_status', op: 'in', v: [doing.name, first.name] }), true);
  assert.equal(await matches(parent, { f: 'parent_status', op: 'eq', v: first.name }), false);
  assert.equal(await matches(parent, { f: 'parent_status', op: 'ne', v: first.name }), true);
});

await test('"status history" knows the current status and every status it moved into or out of', async () => {
  const it = await newItem('Thermal test');
  assert.equal(await matches(it, { f: 'been_in', op: 'eq', v: first.name }), true, 'where it is now');
  assert.equal(await matches(it, { f: 'been_in', op: 'eq', v: doing.name }), false);
  await by(admin, 'pm_transition', it.id, await moveTo(doing.id), {});
  await by(admin, 'pm_transition', it.id, await moveTo(done.id), {});
  assert.equal(await matches(it, { f: 'been_in', op: 'eq', v: doing.name }), true, 'moved through it');
  assert.equal(await matches(it, { f: 'been_in', op: 'eq', v: first.name }), true, 'where it started');
  assert.equal(await matches(it, { f: 'been_in', op: 'ne', v: doing.name }), false);
  assert.equal(await matches(it, { f: 'been_in', op: 'in', v: ['Nope', doing.name] }), true);
  await rejects(matches(it, { f: 'been_in', op: 'lt', v: doing.name }), /Unknown filter operator/);
  await rejects(matches(it, { f: 'been_in', op: 'eq', v: [] }), /needs a value/);
  // the same condition works in a view (pm_search runs it with the person's own access)
  const res = await by(member, 'pm_search', { project: project.id, filter: { f: 'been_in', op: 'eq', v: doing.name } });
  assert.deepEqual(res.items.map((x) => x.key), [it.key]);
});

await test('a move with "all items under it are done" is refused until they are', async () => {
  const parent = await newItem('Wiring harness');
  const child = await newItem('Crimp lugs');
  await db.query(`update pm_items set parent_id = $1 where id = $2`, [parent.id, child.id]);
  const tr = await moveTo(done.id);
  const saved = (await one(`select conditions from pm_transitions where id = $1`, [tr])).conditions;
  await db.query(`update pm_transitions set conditions = '{"f": "children_done"}' where id = $1`, [tr]);
  try {
    await rejects(by(admin, 'pm_transition', parent.id, tr, {}), /doesn't meet the conditions/);
    await db.query(`update pm_items set category = 'done' where id = $1`, [child.id]);
    const moved = await by(admin, 'pm_transition', parent.id, tr, {});
    assert.equal(moved.status_id, done.id);
  } finally {
    await db.query(`update pm_transitions set conditions = $2 where id = $1`, [tr, saved]);
  }
});

await test('Events: only events the person can see, with when it is and whether it happened', async () => {
  const ev = (await one(`insert into ev_events (title, starts_at, location, created_by) values ('Pack design review', now() + interval '3 days', 'MAE-B', $1) returning id`, [admin])).id;
  assert.deepEqual(await by(member, 'os_link_search', 'event', 'design review'), [], 'not invited yet');
  await db.query(`insert into ev_invitees (event_id, user_id) values ($1, $2)`, [ev, member]);
  const [hit] = await by(member, 'os_link_search', 'event', 'MAE');
  assert.deepEqual([hit.title, hit.status, hit.tone, hit.path], ['Pack design review', 'Upcoming', 'blue', `events/#/events/e/${ev}`]);
  assert.match(hit.detail, /\d{4}$/);
  const task = await newItem('Sign off pack');
  const ref = await by(member, 'pm_add_ref', task.id, 'event', ev, 'Signed off here');
  assert.equal(ref.label, 'Pack design review');
  await db.query(`update ev_events set cancelled_at = now() where id = $1`, [ev]);
  const [d] = await by(member, 'os_link_describe', 'event', [ev]);
  assert.deepEqual([d.status, d.tone], ['Cancelled', 'red']);
  assert.deepEqual(await by(outsider, 'os_link_describe', 'event', [ev]), [], 'someone not invited sees nothing');
});

await test('Sponsors: needs a Sponsors permission, shows the stage\'s name, and never the amount or contact', async () => {
  const card = (await one(`insert into sponsor_cards (name, stage, season, amount, contact_email) values ('Acme Cells', 'talks', '2026-2027', 5000, 'pat@acme.test') returning id`)).id;
  await rejects(by(member, 'os_link_search', 'sponsor', 'Acme'), /can't see Sponsors/, '42501');
  const task = await newItem('Cell sourcing');
  await rejects(by(member, 'pm_add_ref', task.id, 'sponsor', card, ''), /can't see Sponsors/, '42501');
  await db.query(`insert into role_permissions (role, permission) values ('member', 'sponsors.view') on conflict do nothing`);
  try {
    const [hit] = await by(member, 'os_link_search', 'sponsor', 'acme');
    assert.deepEqual([hit.title, hit.status, hit.tone, hit.detail, hit.path], ['Acme Cells', 'In talks', 'amber', '2026-2027', `sponsors/#/sponsors/${card}`]);
    assert.deepEqual(Object.keys(hit).sort(), ['code', 'detail', 'id', 'path', 'status', 'title', 'tone']);
    assert.ok(!JSON.stringify(hit).includes('5000') && !JSON.stringify(hit).includes('pat@'));
    await by(member, 'pm_add_ref', task.id, 'sponsor', card, 'Donating the cells');
    await db.query(`update sponsor_cards set stage = 'received' where id = $1`, [card]);
    const [d] = await by(member, 'os_link_describe', 'sponsor', [card]);
    assert.deepEqual([d.status, d.tone], ['Received', 'green']);
  } finally {
    await db.query(`delete from role_permissions where role = 'member' and permission = 'sponsors.view'`);
  }
  assert.deepEqual(await by(member, 'os_link_describe', 'sponsor', [card]), [], 'permission gone: hidden, not an error');
});

await test('related items: link two items once, not to itself, and only items the person can see', async () => {
  const a = await newItem('BMS firmware');
  const b = await newItem('BMS harness');
  const ref = await by(member, 'pm_add_ref', a.id, 'item', b.id, 'Same connector');
  assert.equal(ref.label, `${b.key} · BMS harness`);
  assert.equal((await one(`select summary from pm_events where item_id = $1 order by id desc limit 1`, [a.id])).summary, `Linked the related item ${b.key} · BMS harness`);
  await rejects(by(member, 'pm_add_ref', a.id, 'item', a.id, ''), /can't be related to itself/);
  await rejects(by(member, 'pm_add_ref', b.id, 'item', a.id, ''), /already related/);
  const [d] = await by(member, 'os_link_describe', 'item', [b.id]);
  assert.deepEqual([d.code, d.status, d.tone, d.path], [b.key, first.name, 'gray', `projects/#/projects/item/${b.key}`]);
  assert.deepEqual((await by(member, 'os_link_search', 'item', 'BMS harness')).map((x) => x.code), [b.key]);
  // someone who can't see the project gets nothing back
  const hidden = await by(outsider, 'os_link_describe', 'item', [b.id]);
  const visible = await as(outsider, async () => (await db.query(`select 1 from pm_items where id = $1`, [b.id])).rows.length);
  assert.equal(hidden.length, visible, 'the link shows exactly when the item itself does');
});

// ---- starter rules (069): each one saves as an ordinary rule and does what it says ---------------------
const rp = await by(admin, 'pm_save_project', null, { key: 'rul', name: 'Rules' });
await by(admin, 'pm_set_member', rp.id, member, (await one(`select id from pm_roles where project_id = $1 and key = 'contributor'`, [rp.id])).id);
const rType = await one(`select id, workflow_id from pm_types where project_id = $1 and level = 1 order by sort limit 1`, [rp.id]);
const rCfg = { statuses: (await db.query(`select id, name, category, workflow_id from pm_statuses where project_id = $1 order by sort`, [rp.id])).rows,
  types: (await db.query(`select id, level, is_milestone, archived_at from pm_types where project_id = $1 order by sort`, [rp.id])).rows };
const rStatus = (cat) => rCfg.statuses.find((x) => x.workflow_id === rType.workflow_id && x.category === cat);
const rMove = async (item, cat, who = admin) => by(who, 'pm_transition', item.id, (await one(`select id from pm_transitions where workflow_id = $1 and to_status = $2 order by from_status nulls first limit 1`, [rType.workflow_id, rStatus(cat).id])).id, {});
const rItem = (title, extra = {}) => by(member, 'pm_create_item', randomUUID(), { project_id: rp.id, type_id: rType.id, title, ...extra });
const starters = starterRules(rCfg);
const saveStarter = (key, change = {}) => by(admin, 'pm_save_automation', rp.id, null, { ...starters.find((x) => x.key === key).rule, ...change });
const lastRun = async (rule) => one(`select status, detail from pm_automation_runs where rule_id = $1 order by created_at desc, id desc limit 1`, [rule.id]);
const runTimed = async () => {
  await db.query(`update pm_schedule_state set last_run = null`);
  return call('pm_run_scheduled');
};

await test('starter rules: there are five, filled in with this project\'s statuses and work type', async () => {
  assert.deepEqual(starters.map((x) => x.key), ['close_parent', 'close_children', 'assign_on_start', 'due_heads_up', 'recurring']);
  assert.equal(starters[0].rule.actions[0].status, rStatus('done').id);
  assert.equal(starters[1].rule.actions[0].type, 'move_children');
  assert.equal(starters[2].rule.trigger_config.to, rStatus('doing').id);
  assert.equal(starters[4].rule.actions[0].type_id, rType.id);
  assert.deepEqual(starterRules({ statuses: [{ id: 's', category: 'todo' }], types: [] }).map((x) => x.key), ['due_heads_up'], 'left out when there\'s nothing to point at');
});

await test('"close the parent": the parent moves to Done only when the last item under it is done', async () => {
  const rule = await saveStarter('close_parent');
  const parent = await rItem('Motor controller');
  const a = await rItem('Gate driver');
  const b = await rItem('Current sensing');
  await db.query(`update pm_items set parent_id = $1 where id = any($2)`, [parent.id, [a.id, b.id]]);
  await rMove(a, 'done');
  assert.equal((await one(`select status_id from pm_items where id = $1`, [parent.id])).status_id, rStatus('todo').id);
  assert.match((await lastRun(rule)).detail, /something under it is still open/);
  await rMove(b, 'done');
  assert.equal((await one(`select status_id from pm_items where id = $1`, [parent.id])).status_id, rStatus('done').id);
  assert.deepEqual(await lastRun(rule), { status: 'ok', detail: `moved ${parent.key} to "${rStatus('done').name}"` });
  await by(admin, 'pm_save_automation', rp.id, rule.id, { enabled: false });
});

await test('"assign it to whoever starts it": an unowned item moved to In progress gets that person', async () => {
  const rule = await saveStarter('assign_on_start');
  const it = await rItem('Wire the dash');
  await db.query(`update pm_items set owner_id = null where id = $1`, [it.id]);
  await rMove(it, 'doing', member);
  assert.equal((await one(`select owner_id from pm_items where id = $1`, [it.id])).owner_id, member);
  const owned = await rItem('Already owned');
  await db.query(`update pm_items set owner_id = $2 where id = $1`, [owned.id, admin]);
  await rMove(owned, 'doing', member);
  assert.equal((await one(`select owner_id from pm_items where id = $1`, [owned.id])).owner_id, admin, 'someone who already owns it keeps it');
  await by(admin, 'pm_save_automation', rp.id, rule.id, { enabled: false });
});

await test('"heads-up before it\'s due" and "recurring work" run with the timed work', async () => {
  const heads = await saveStarter('due_heads_up');
  const weekly = await saveStarter('recurring', { trigger_config: { every: 'week', weekday: new Date().getDay(), day: 1 } });
  const it = await rItem('Order the tires', { due_date: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10) });
  await db.query(`insert into pm_people (item_id, user_id, kind, project_id) values ($1, $2, 'watch', $3) on conflict do nothing`, [it.id, admin, rp.id]);
  await runTimed();
  const note = await one(`select title from pm_notifications where item_id = $1 and user_id = $2 and kind = 'automation' order by created_at desc limit 1`, [it.id, admin]);
  assert.match(note?.title || '', new RegExp(`${it.key} "Order the tires" is due`));
  assert.equal((await lastRun(heads)).status, 'ok');
  const made = (await db.query(`select key, owner_id from pm_items where project_id = $1 and title = 'Weekly check'`, [rp.id])).rows;
  assert.equal(made.length, 1, 'one item this week');
  assert.equal(made[0].owner_id, (await one(`select lead_id from pm_projects where id = $1`, [rp.id])).lead_id);
  await runTimed();
  assert.equal((await db.query(`select 1 from pm_items where project_id = $1 and title = 'Weekly check'`, [rp.id])).rows.length, 1, 'not twice on the same day');
  assert.equal((await lastRun(weekly)).status, 'ok');
});

await test('"move its parent" is checked when a rule is saved', async () => {
  await rejects(by(admin, 'pm_save_automation', rp.id, null, { name: 'x', trigger: 'status', actions: [{ type: 'move_parent', status: randomUUID() }] }),
    /moves the parent to a status this project doesn't have/);
});

// ---- 069, later additions: close the items under it, "worked on", choice colors, files on items -----------------
await test('"close the items under it": the open items under it move to Done with it; one that can\'t move is left and counted', async () => {
  const rule = await saveStarter('close_children');
  const parent = await rItem('Wiring loom');
  const a = await rItem('Crimp the connectors');
  const b = await rItem('Label the wires');
  const c = await rItem('Already finished bit');
  await db.query(`update pm_items set parent_id = $1 where id = any($2)`, [parent.id, [a.id, b.id, c.id]]);
  await rMove(c, 'done');
  // b's move to Done needs a field filled in, so the rule leaves it
  const tr = await one(`select id, require_fields from pm_transitions where workflow_id = $1 and to_status = $2 order by from_status nulls first limit 1`, [rType.workflow_id, rStatus('done').id]);
  await db.query(`update pm_transitions set require_fields = '{estimate_hours}' where workflow_id = $1 and to_status = $2`, [rType.workflow_id, rStatus('done').id]);
  await db.query(`update pm_items set estimate_hours = 2 where id = any($1)`, [[parent.id, a.id]]);
  await rMove(parent, 'done');
  await db.query(`update pm_transitions set require_fields = $3 where workflow_id = $1 and to_status = $2`, [rType.workflow_id, rStatus('done').id, tr.require_fields]);
  const cat = async (it) => (await one(`select category from pm_items where id = $1`, [it.id])).category;
  assert.equal(await cat(a), 'done');
  assert.equal(await cat(b), 'todo', 'left: a field its move needs is empty');
  const run = await one(`select status, detail from pm_automation_runs where rule_id = $1 and item_id = $2 order by id desc limit 1`, [rule.id, parent.id]);
  assert.equal(run.status, 'ok');
  assert.match(run.detail, /moved 1 item under it, left 1/);
  await by(admin, 'pm_save_automation', rp.id, rule.id, { enabled: false });
  await rejects(by(admin, 'pm_save_automation', rp.id, null, { name: 'x', trigger: 'status', actions: [{ type: 'move_children', status: randomUUID() }] }),
    /moves the items under it to a status this project doesn't have/);
});

await test('"worked on": items I changed in the last 30 days, not ones only someone else touched', async () => {
  const mine = await newItem('Torque the busbars');          // created by member
  const theirs = await by(admin, 'pm_create_item', randomUUID(), { project_id: project.id, type_id: taskType.id, title: 'Admin only' });
  const found = async (uid) => (await by(uid, 'pm_search', { filter: { f: 'worked_on' }, limit: 200 })).items.map((i) => i.key);
  assert.ok((await found(member)).includes(mine.key));
  assert.ok(!(await found(member)).includes(theirs.key));
  // (history can't be edited by anyone, so the test turns that guard off for a moment to age it)
  await db.exec(`set session_replication_role = replica`);
  await db.query(`update pm_events set created_at = now() - interval '40 days' where item_id = $1`, [mine.id]);
  await db.exec(`set session_replication_role = default`);
  assert.ok(!(await found(member)).includes(mine.key), 'older than 30 days');
});

await test('dropdown choices keep their colors; unknown colors are refused and colors of removed choices dropped', async () => {
  let f = await by(admin, 'pm_save_field', project.id, null, { key: 'result', name: 'Result', type: 'select', options: ['Pass', 'Fail'], option_tones: { Pass: 'green', Fail: 'red' } });
  assert.deepEqual(f.option_tones, { Pass: 'green', Fail: 'red' });
  f = await by(admin, 'pm_save_field', project.id, f.id, { options: ['Pass', 'Retest'] });
  assert.deepEqual(f.option_tones, { Pass: 'green' }, 'Fail is gone, so its color is too');
  await rejects(by(admin, 'pm_save_field', project.id, f.id, { option_tones: { Pass: 'chartreuse' } }), /Unknown color/);
  const text = await by(admin, 'pm_save_field', project.id, null, { key: 'note2', name: 'Note 2', type: 'text', option_tones: { x: 'red' } });
  assert.deepEqual(text.option_tones, {}, 'only dropdowns have choice colors');
});

await test('files on an item: whoever can edit it adds and removes them; people who can\'t see the project get nothing', async () => {
  const it = await newItem('Cell holder drawing');
  const path = `item/${it.id}/${randomUUID()}-holder.pdf`;
  const id = await by(member, 'add_attachment', 'item', it.id, path, null, 'holder.pdf', 1200, 'application/pdf', 'Rev B');
  assert.match((await one(`select summary from pm_events where item_id = $1 and kind = 'file' order by id desc limit 1`, [it.id])).summary, /Added the file "Rev B"/);
  const seen = (uid) => as(uid, async () => (await db.query(`select id from attachments where pm_item_id = $1`, [it.id])).rows.length);
  assert.equal(await seen(member), 1);
  assert.equal(await seen(admin), 1);
  assert.equal(await seen(outsider), 1, 'the project is visible to the whole team, so its files are too');
  await rejects(by(outsider, 'add_attachment', 'item', it.id, null, 'https://example.com/x', '', null, '', ''), /can't add files here/);   // not a project member, so can't edit it
  await db.query(`update pm_projects set visibility = 'private' where id = $1`, [project.id]);
  assert.equal(await seen(outsider), 0, "a private project's files are only for its members");
  assert.equal(await seen(member), 1);
  await db.query(`update pm_projects set visibility = 'team' where id = $1`, [project.id]);
  await rejects(by(member, 'add_attachment', 'item', it.id, `item/${randomUUID()}/x.pdf`, null, 'x.pdf', 1, 'application/pdf', ''), /wrong place/);
  // an archived item's files can still be read, not added to
  await by(admin, 'pm_archive_item', it.id, true);
  await rejects(by(member, 'add_attachment', 'item', it.id, null, 'https://example.com/y', '', null, '', ''), /can't add files here/);
  assert.equal(await seen(member), 1);
  await by(admin, 'pm_archive_item', it.id, false);
  assert.equal(await by(member, 'delete_attachment', id), path, 'the website then deletes the stored file');
  assert.equal(await seen(member), 0);
});

await test('071: a project from Engineering design puts each engineering field on its own work types', async () => {
  const tpl = await one(`select id from pm_templates where name = 'Engineering design'`);
  const p = await by(admin, 'pm_save_project', null, { key: 'ENG', name: 'Engineering', template_id: tpl.id });
  const rows = (await db.query(`select f.key, array(select t.name from pm_types t where t.id = any(f.type_ids) order by t.name) as types
    from pm_fields f where f.project_id = $1 order by f.key`, [p.id])).rows;
  const on = Object.fromEntries(rows.map((r) => [r.key, r.types.join(', ')]));
  assert.deepEqual(on, { analysis_type: 'Analysis', measured_result: 'Test', outcome: 'Test', requirement: 'Design Task, Epic', review_date: 'Design Review', test_procedure: 'Test' });
});

console.log(`\n${passed} Projects Stage 2 tests passed`);
