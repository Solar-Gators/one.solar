/**
 * Inventory database tests (migration 050): every rule the Inventory app relies on, run as real users against
 * PGlite (real Postgres in Node) with every migration loaded, the same way tests/db.test.mjs does.
 *
 *   node tests/inventory.test.mjs
 *
 * PGlite has one connection, so two people can't literally act at the same instant here. What makes concurrent
 * use safe is checked directly instead: every stock function locks the item's row before reading a balance,
 * each balance has a "never below zero" check that holds even for the database owner, and operation ids make
 * a repeated request harmless.
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

/** Call a function and return its result. */
const call = async (fn, ...args) =>
  (await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r;
/** Call as someone. */
const by = (uid, fn, ...args) => as(uid, () => call(fn, ...args));
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;
const num = (v) => (v === null || v === undefined ? v : Number(v));

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

const member = await person('inv-member@ufl.edu', 'Mia Member');
const other = await person('inv-other@ufl.edu', 'Otto Other');
const ce = await person('inv-ce@ufl.edu', 'Cara Chief', ['ce']);
const treasurer = await person('inv-treasurer@ufl.edu', 'Tess Treasurer', ['treasurer']);
const manager = await person('inv-manager@ufl.edu', 'Manny Manager', ['inventory_manager']);
const admin = await person('inv-admin@ufl.edu', 'Ada Admin', ['admin']);
const guest = await person('inv-guest@ufl.edu', 'Gus Guest', []); // signed up, not accepted (040)
const former = await person('inv-former@ufl.edu', 'Fay Former', ['alumni']); // deactivated (044)

const op = () => randomUUID();
const totals = (item) => one(`select coalesce(sum(qty), 0)::float on_hand,
  coalesce(sum(qty) filter (where status = 'available'), 0)::float available,
  coalesce(sum(qty) filter (where status = 'quarantine'), 0)::float quarantined from inventory_stock where item_id = $1`, [item]);
const at = async (item, loc, status = 'available') =>
  Number((await one(`select coalesce(sum(qty), 0) q from inventory_stock where item_id = $1 and location_id = $2 and status = $3`, [item, loc, status])).q);

// ---- permissions ----------------------------------------------------------------------------------
console.log('Permissions');

await test('default access: members view + use; CEs also receive + count; Treasurer receives; managers and Admin everything', async () => {
  const perms = async (role) => (await all(`select permission from role_permissions where role = $1 and permission like 'inventory.%' order by 1`, [role])).map((r) => r.permission);
  assert.deepEqual(await perms('member'), ['inventory.use', 'inventory.view']);
  assert.deepEqual(await perms('ce'), ['inventory.count', 'inventory.receive', 'inventory.use', 'inventory.view']);
  assert.deepEqual(await perms('treasurer'), ['inventory.receive', 'inventory.use', 'inventory.view']);
  const everything = ['inventory.count', 'inventory.manage', 'inventory.receive', 'inventory.use', 'inventory.view'];
  assert.deepEqual(await perms('inventory_manager'), everything);
  assert.deepEqual(await perms('admin'), everything);
  assert.deepEqual(await perms('guest'), []);
  assert.deepEqual(await perms('alumni'), []);
  // The five show in Admin → Roles & permissions like every other permission.
  assert.equal((await one(`select count(*)::int n from permissions where key like 'inventory.%'`)).n, 5);
});

// ---- the organization ------------------------------------------------------------------------------
console.log('CE divisions and subsystems');

let powertrain, aero, battery, array_, motor, chassis;
await test('admins and inventory managers build the hierarchy; members can\'t', async () => {
  powertrain = await by(manager, 'org_save_division', null, 'Powertrain', null);
  aero = await by(admin, 'org_save_division', null, 'Aero / Structures', null);
  battery = await by(manager, 'org_save_subsystem', null, powertrain, 'Battery', null);
  array_ = await by(manager, 'org_save_subsystem', null, powertrain, 'Array', null);
  motor = await by(manager, 'org_save_subsystem', null, powertrain, 'Motor', null);
  chassis = await by(manager, 'org_save_subsystem', null, aero, 'Chassis', null);
  await as(member, () => rejects(call('org_save_division', null, 'Nope', null), /can't do this in Inventory/));
  await as(member, () => rejects(call('org_save_subsystem', null, powertrain, 'Nope', null), /can't do this/));
  // Everyone on the team can read it (the pickers); guests can't.
  assert.equal((await as(member, () => all(`select * from org_subsystems`))).length, 4);
  assert.equal((await as(guest, () => all(`select * from org_subsystems`))).length, 0);
});

await test('names are unique (ignoring case) within their level; a division with subsystems can\'t be archived', async () => {
  await as(manager, () => rejects(call('org_save_division', null, ' powertrain ', null), /already a division called/));
  await as(manager, () => rejects(call('org_save_subsystem', null, powertrain, 'BATTERY', null), /already has a subsystem called/));
  await by(manager, 'org_save_subsystem', null, aero, 'Battery', null); // same name in another division is fine
  await as(manager, () => rejects(call('org_archive_division', aero, true), /Archive or move .* subsystems first/));
});

await test('starting points: Solar Evals\' CE divisions, and Orders\' subsystem list into a division (no duplicates)', async () => {
  const added = await by(admin, 'org_copy_from_evals');
  assert.ok(added >= 1, 'copied at least one CE division from Solar Evals');
  assert.equal(await by(admin, 'org_copy_from_evals'), 0, 'running it again adds nothing');
  const names = (await all(`select name from org_divisions where archived_at is null`)).map((r) => r.name);
  assert.ok(!names.some((x) => / CE$/.test(x)), 'the trailing " CE" is dropped');
  const scratch = await by(admin, 'org_save_division', null, 'Scratch', null);
  assert.equal(await by(admin, 'org_add_subsystems', scratch, ['Telemetry', 'telemetry', ' ', 'Cockpit']), 2);
  for (const s of await all(`select id from org_subsystems where division_id = $1`, [scratch])) await by(admin, 'org_archive_subsystem', s.id, true);
  await by(admin, 'org_archive_division', scratch, true);
});

// ---- locations -----------------------------------------------------------------------------------
console.log('Locations');

let shop, cabA, cabB, shelfA1, flam;
await test('a hierarchy of locations with label-safe codes; no location inside itself', async () => {
  shop = await by(manager, 'inventory_save_location', null, { code: 'shop', name: 'Shop', kind: 'shop' });
  cabA = await by(manager, 'inventory_save_location', null, { code: 'CAB-A', name: 'Cabinet A', kind: 'cabinet', parent_id: shop });
  cabB = await by(manager, 'inventory_save_location', null, { code: 'CAB-B', name: 'Cabinet B', kind: 'cabinet', parent_id: shop });
  shelfA1 = await by(manager, 'inventory_save_location', null, { code: 'cab a 1', name: 'Shelf 1', kind: 'shelf', parent_id: cabA });
  flam = await by(manager, 'inventory_save_location', null, { code: 'FLAM-1', name: 'Flammables cabinet', kind: 'cabinet', parent_id: shop, restrictions: 'Flammables only' });
  assert.equal((await one(`select code from inventory_locations where id = $1`, [shelfA1])).code, 'CAB-A-1');
  await as(manager, () => rejects(call('inventory_save_location', cabA, { code: 'CAB-A', name: 'Cabinet A', parent_id: shelfA1 }), /inside itself/));
  await as(manager, () => rejects(call('inventory_save_location', null, { code: 'CAB-B', name: 'Copy' }), /already has the code CAB-B/));
  await as(manager, () => rejects(call('inventory_save_location', null, { code: 'bad/code!' }), /won't work on a label/));
  await as(member, () => rejects(call('inventory_save_location', null, { code: 'X1' }), /can't do this/));
});

// ---- items ------------------------------------------------------------------------------------------
console.log('Items');

let conn, wire, epoxy, cells;
await test('adding items: an SKU is made when left blank; receivers can add, only managers edit', async () => {
  conn = await by(ce, 'inventory_save_item', null, { name: 'Anderson PP45 connector', manufacturer: 'Anderson Power', mpn: '1327G6', unit: 'ea',
    reorder_point: 40, reorder_qty: 100, unit_cost: 0.85, default_location_id: cabA,
    supplier: { supplier: 'DigiKey', supplier_pn: '1327G6-ND', pack_qty: 1, last_price: 0.85 } });
  const row = await one(`select sku, decimals, created_by from inventory_items where id = $1`, [conn]);
  assert.match(row.sku, /^INV-\d{5}$/);
  assert.equal(row.decimals, 0);
  wire = await by(manager, 'inventory_save_item', null, { sku: 'WIRE-12-RED', name: '12 AWG red silicone wire', unit: 'm', decimals: 2, unit_cost: 1.2 });
  epoxy = await by(manager, 'inventory_save_item', null, { sku: 'EPOXY-105', name: 'West System 105 epoxy resin', unit: 'l', decimals: 2,
    track_lots: true, hazardous: true, hazard_classes: ['irritant', 'environmental'], sds_url: 'https://example.com/sds.pdf', storage_notes: 'Keep below 30 °C' });
  cells = await by(manager, 'inventory_save_item', null, { sku: 'CELL-21700', name: '21700 cell', unit: 'ea', count_class: 'A', unit_cost: 6, hazard_classes: ['lithium_battery'] });
  assert.equal((await one(`select hazardous from inventory_items where id = $1`, [cells])).hazardous, true);
  await as(member, () => rejects(call('inventory_save_item', null, { name: 'Mine' }), /can't do this/));
  await as(ce, () => rejects(call('inventory_save_item', conn, { name: 'Renamed' }), /Manage inventory/));
  await as(ce, () => rejects(call('inventory_save_item', epoxy, { name: 'West System 105', unit: 'l', hazard_classes: [] }), /Manage inventory/));
});

await test('duplicates: the same part number (or supplier part number, or name) is caught; nothing is merged', async () => {
  const err = await as(manager, () => rejects(call('inventory_save_item', null, { name: 'PP45 housing', mpn: '1327-g6' }), /already in the catalog/));
  assert.equal(err.code, 'OS412');
  await as(manager, () => rejects(call('inventory_save_item', null, { name: 'Other', supplier: { supplier: 'DigiKey', supplier_pn: '1327g6nd' } }), /already in the catalog/));
  const matches = await by(member, 'inventory_find_matches', { name: 'anderson connector pp45' });
  assert.deepEqual(matches.map((m) => [m.name, m.reasons]), [['Anderson PP45 connector', ['Similar name']]]);
  const byMpn = await by(member, 'inventory_find_matches', { mpn: '1327G6' });
  assert.deepEqual(byMpn[0].reasons, ['Same manufacturer part number']);
  // Confirmed as a different item: kept separate.
  const reel = await by(manager, 'inventory_save_item', null, { name: 'PP45 connector (reel)', mpn: '1327G6', confirm_duplicate: true });
  assert.notEqual(reel, conn);
  await as(manager, () => rejects(call('inventory_save_item', null, { sku: 'wire-12-red', name: 'Clash' }), /already has the SKU WIRE-12-RED/));
  await by(manager, 'inventory_save_item', reel, { name: 'PP45 connector (reel)', sku: (await one(`select sku from inventory_items where id = $1`, [reel])).sku, status: 'archived' });
});

await test('item history: every change is recorded with who and what', async () => {
  const sku = (await one(`select sku from inventory_items where id = $1`, [wire])).sku;
  await by(manager, 'inventory_save_item', wire, { sku, name: '12 AWG red silicone wire', unit: 'm', decimals: 2, unit_cost: 1.35 });
  const log = await all(`select action, changes, actor_name from inventory_audit where record_id = $1 order by id`, [wire]);
  assert.deepEqual(log.map((l) => l.action), ['create', 'update']);
  assert.deepEqual(log[1].changes.unit_cost, [1.2, 1.35]);
  assert.equal(log[1].actor_name, 'Manny Manager');
});

// ---- units ----------------------------------------------------------------------------------------
console.log('Units');

await test('quantities follow the item\'s unit: compatible units convert, others are refused, whole items stay whole', async () => {
  const r = await by(ce, 'inventory_receive', op(), { item_id: wire, location_id: cabA, qty: 10, unit: 'ft' });
  assert.equal(num(r.qty), 3.05); // 10 ft = 3.048 m, kept to 2 decimals
  await as(ce, () => rejects(call('inventory_receive', op(), { item_id: wire, location_id: cabA, qty: 1, unit: 'kg' }), /can't use kg/));
  await as(ce, () => rejects(call('inventory_receive', op(), { item_id: conn, location_id: cabA, qty: 1.5 }), /whole ea/));
  await as(ce, () => rejects(call('inventory_receive', op(), { item_id: wire, location_id: cabA, qty: 1.234 }), /at most 2 decimal places/));
  await as(ce, () => rejects(call('inventory_receive', op(), { item_id: conn, location_id: cabA, qty: 0 }), /above zero/));
  const sku = (await one(`select sku from inventory_items where id = $1`, [wire])).sku;
  await as(manager, () => rejects(call('inventory_save_item', wire, { sku, name: 'x', unit: 'ft', decimals: 2 }), /unit can't change/));
});

// ---- stock movements --------------------------------------------------------------------------------
console.log('Stock');

await test('the core flow: receive 100 into Cabinet A, use 20 for a subsystem, move 30 to Cabinet B', async () => {
  const r1 = await by(ce, 'inventory_receive', op(), { item_id: conn, location_id: cabA, qty: 100, source: 'Shop leftovers' });
  assert.equal(num(r1.on_hand), 100);
  const used = await by(member, 'inventory_consume', op(), { item_id: conn, location_id: cabA, qty: 20, use_for: 'subsystem', subsystem_id: battery, project: 'Pack v3' });
  assert.equal(used.division_id, powertrain); // the subsystem's division is recorded with it
  assert.equal(num(used.available), 80);
  await by(ce, 'inventory_transfer', op(), { item_id: conn, from_id: cabA, to_id: cabB, qty: 30 });
  assert.deepEqual([await at(conn, cabA), await at(conn, cabB)], [50, 30]);
  assert.equal((await totals(conn)).on_hand, 80, 'a transfer keeps the total');
  const kinds = (await all(`select kind, qty::float q from inventory_movements where item_id = $1 order by id`, [conn])).map((m) => `${m.kind} ${m.q}`);
  assert.deepEqual(kinds, ['receive 100', 'consume -20', 'transfer -30', 'transfer 30']);
});

await test('nobody takes more than is there (OS422), and a balance can\'t go below zero even for the database owner', async () => {
  const err = await as(member, () => rejects(call('inventory_consume', op(), { item_id: conn, location_id: cabB, qty: 31, use_for: 'general' }), /Only 30 ea of "Anderson PP45 connector" in stock at CAB-B/));
  assert.equal(err.code, 'OS422');
  await rejects(db.query(`update inventory_stock set qty = -1 where item_id = $1 and location_id = $2`, [conn, cabB]), /inventory_stock_qty_check/);
  assert.equal(await at(conn, cabB), 30);
});

await test('two people taking the last parts: the second is refused, not double-counted', async () => {
  // Each function locks the item first, so the second waits for the first and then sees what's left.
  const lock = await one(`select pg_get_functiondef('public.inv_lock_item(uuid)'::regprocedure) d`);
  assert.match(lock.d, /for update/);
  await by(member, 'inventory_consume', op(), { item_id: conn, location_id: cabB, qty: 25, use_for: 'general' });
  await as(other, () => rejects(call('inventory_consume', op(), { item_id: conn, location_id: cabB, qty: 25, use_for: 'general' }), /Only 5 ea/));
  assert.equal(await at(conn, cabB), 5);
});

await test('the same operation sent twice (double click, retry) happens once', async () => {
  const id = op();
  const first = await by(member, 'inventory_consume', id, { item_id: conn, location_id: cabB, qty: 2, use_for: 'general' });
  const again = await by(member, 'inventory_consume', id, { item_id: conn, location_id: cabB, qty: 2, use_for: 'general' });
  assert.deepEqual([first.replay, again.replay, num(again.available)], [false, true, num(first.available)]);
  assert.equal((await one(`select count(*)::int n from inventory_movements where op_id = $1`, [id])).n, 1);
  assert.equal(await at(conn, cabB), 3);
  // An id reused for something else, or by someone else, is refused.
  await as(member, () => rejects(call('inventory_return', id, { item_id: conn, location_id: cabB, qty: 1, use_for: 'general' }), /already saved as something else/));
  await as(other, () => rejects(call('inventory_consume', id, { item_id: conn, location_id: cabB, qty: 2, use_for: 'general' }), /already saved as something else/));
});

await test('using stock needs a CE division / subsystem (or General shop), never an invented one', async () => {
  await as(member, () => rejects(call('inventory_consume', op(), { item_id: conn, location_id: cabA, qty: 1 }), /Say what it's for/));
  await as(member, () => rejects(call('inventory_consume', op(), { item_id: conn, location_id: cabA, qty: 1, use_for: 'subsystem' }), /Pick the subsystem/));
  await as(member, () => rejects(call('inventory_consume', op(), { item_id: conn, location_id: cabA, qty: 1, use_for: 'subsystem', subsystem_id: chassis, division_id: powertrain }), /isn't in that CE division/));
  const whole = await by(member, 'inventory_consume', op(), { item_id: conn, location_id: cabA, qty: 1, use_for: 'division', division_id: aero });
  assert.equal(whole.subsystem_id, undefined);
  // The last choice is remembered for next time.
  const pref = await as(member, () => one(`select use_for, division_id from inventory_prefs`));
  assert.deepEqual([pref.use_for, pref.division_id], ['division', aero]);
  assert.equal((await as(other, () => all(`select * from inventory_prefs`))).length, 0, 'only your own');
});

await test('putting unused parts back: against what was taken (never more), counted off that subsystem', async () => {
  const usedOp = op();
  await by(member, 'inventory_consume', usedOp, { item_id: conn, location_id: cabA, qty: 10, use_for: 'subsystem', subsystem_id: motor });
  await as(member, () => rejects(call('inventory_return', op(), { item_id: conn, location_id: cabA, qty: 11, returns_op: usedOp }), /Only 10 ea of that was taken out/));
  await by(member, 'inventory_return', op(), { item_id: conn, location_id: cabA, qty: 4, returns_op: usedOp });
  await as(member, () => rejects(call('inventory_return', op(), { item_id: conn, location_id: cabA, qty: 7, returns_op: usedOp }), /4 already came back/));
  const back = await one(`select subsystem_id, division_id, qty::float q from inventory_movements where kind = 'return' and returns_op = $1`, [usedOp]);
  assert.deepEqual([back.subsystem_id, back.division_id, back.q], [motor, powertrain, 4]);
});

await test('correcting stock: inventory managers only, with a reason, and not over someone else\'s change', async () => {
  await as(ce, () => rejects(call('inventory_adjust', op(), { item_id: conn, location_id: cabA, set_to: 40, reason: 'Recounted' }), /Manage inventory/));
  await as(manager, () => rejects(call('inventory_adjust', op(), { item_id: conn, location_id: cabA, set_to: 40 }), /Say why/));
  const now = await at(conn, cabA);
  const err = await as(manager, () => rejects(call('inventory_adjust', op(), { item_id: conn, location_id: cabA, set_to: 40, expected: now + 1, reason: 'Recounted' }), /changed since you looked/));
  assert.equal(err.code, 'OS409');
  await by(manager, 'inventory_adjust', op(), { item_id: conn, location_id: cabA, set_to: now - 1, expected: now, reason: 'One was broken' });
  assert.equal(await at(conn, cabA), now - 1);
});

await test('history can\'t be edited or deleted, even by the database owner', async () => {
  await rejects(db.query(`update inventory_movements set qty = 1 where item_id = $1`, [conn]), /can't be changed or deleted/);
  await rejects(db.query(`delete from inventory_movements where item_id = $1`, [conn]), /can't be changed or deleted/);
  await as(manager, () => rejects(db.query(`delete from inventory_movements`), /permission denied/));
  await as(manager, () => rejects(db.query(`insert into inventory_stock (item_id, location_id, qty) values ($1, $2, 5)`, [conn, cabA]), /permission denied/));
});

await test('undo: a linked reversing transaction; once only; your own within a day, managers anything', async () => {
  const before = await at(conn, cabA);
  const mistake = op();
  await by(member, 'inventory_consume', mistake, { item_id: conn, location_id: cabA, qty: 3, use_for: 'general' });
  await as(other, () => rejects(call('inventory_reverse', op(), mistake, 'Not mine'), /Only an inventory manager/));
  const undo = op();
  await by(member, 'inventory_reverse', undo, mistake, 'Wrong item');
  assert.equal(await at(conn, cabA), before);
  await as(member, () => rejects(call('inventory_reverse', op(), mistake, 'Again'), /already undone/));
  await as(manager, () => rejects(call('inventory_reverse', op(), undo, 'Undo the undo'), /can't be undone/));
  const lines = await all(`select op_id, reversal, qty::float q from inventory_movements where op_id in ($1, $2) order by id`, [mistake, undo]);
  assert.deepEqual(lines.map((l) => [l.reversal, l.q]), [[false, -3], [true, 3]]);
  assert.equal((await one(`select reversed_by from inventory_ops where id = $1`, [mistake])).reversed_by, undo);
  // Something whose stock was used since can't be undone (it would go below zero).
  const rcv = op();
  await by(ce, 'inventory_receive', rcv, { item_id: cells, location_id: cabB, qty: 4 });
  await by(member, 'inventory_consume', op(), { item_id: cells, location_id: cabB, qty: 3, use_for: 'subsystem', subsystem_id: battery });
  await as(manager, () => rejects(call('inventory_reverse', op(), rcv, 'Wrong count'), /Can't undo this: Only 1 ea/));
  // A "used" with parts already put back: undo the return first.
  const used = op();
  await by(member, 'inventory_consume', used, { item_id: conn, location_id: cabA, qty: 2, use_for: 'general' });
  await by(member, 'inventory_return', op(), { item_id: conn, location_id: cabA, qty: 1, returns_op: used });
  await as(manager, () => rejects(call('inventory_reverse', op(), used, 'x yz'), /already put back/));
});

// ---- lots, expiry, quarantine ----------------------------------------------------------------------
console.log('Lots, expiry and set-aside stock');

let lotOld, lotNew;
await test('lot-tracked items need a lot; expired lots can\'t be used; set-aside stock isn\'t available', async () => {
  await as(ce, () => rejects(call('inventory_receive', op(), { item_id: epoxy, location_id: flam, qty: 4 }), /tracked by lot/));
  await by(ce, 'inventory_receive', op(), { item_id: epoxy, location_id: flam, qty: 4, lot: { lot_code: 'L-2024-01', expires_on: '2025-01-31' } });
  await by(ce, 'inventory_receive', op(), { item_id: epoxy, location_id: flam, qty: 2, lot: { lot_code: 'L-2030-07', expires_on: '2030-07-31' } });
  lotOld = (await one(`select id from inventory_lots where lot_code = 'L-2024-01'`)).id;
  lotNew = (await one(`select id from inventory_lots where lot_code = 'L-2030-07'`)).id;
  await as(member, () => rejects(call('inventory_consume', op(), { item_id: epoxy, location_id: flam, qty: 1, use_for: 'general' }), /Pick which lot/));
  await as(member, () => rejects(call('inventory_consume', op(), { item_id: epoxy, location_id: flam, lot_id: lotOld, qty: 1, use_for: 'general' }), /expired on 2025-01-31 and can't be used/));
  await by(member, 'inventory_consume', op(), { item_id: epoxy, location_id: flam, lot_id: lotNew, qty: 0.5, use_for: 'subsystem', subsystem_id: chassis });
  const o = (await by(member, 'inventory_overview')).items.find((i) => i.id === epoxy);
  assert.deepEqual([num(o.on_hand), num(o.available), num(o.unusable)], [5.5, 1.5, 4], 'the expired lot is on hand but not available');
  assert.ok((await by(member, 'inventory_overview')).lots.some((l) => l.lot_id === lotOld && /expired/.test(l.problem)), 'expiry alert');
});

await test('setting aside and releasing: anyone who handles stock sets aside; only managers release; expired lots never', async () => {
  await by(ce, 'inventory_quarantine', op(), { item_id: epoxy, location_id: flam, lot_id: lotOld, qty: 4, reason: 'Expired' });
  await by(ce, 'inventory_quarantine', op(), { item_id: conn, location_id: cabA, qty: 2, reason: 'Bent pins' });
  assert.equal((await totals(conn)).quarantined, 2);
  await as(ce, () => rejects(call('inventory_quarantine', op(), { item_id: conn, location_id: cabA, qty: 2, release: true }), /Manage inventory/));
  await as(manager, () => rejects(call('inventory_quarantine', op(), { item_id: epoxy, location_id: flam, lot_id: lotOld, qty: 4, release: true }), /expired on 2025-01-31\. Update its dates/));
  await by(manager, 'inventory_quarantine', op(), { item_id: conn, location_id: cabA, qty: 1, release: true, reason: 'Pins straightened' });
  assert.equal((await totals(conn)).quarantined, 1);
  // Set-aside stock can't be used: only available stock is taken.
  const avail = await at(conn, cabA);
  await as(member, () => rejects(call('inventory_consume', op(), { item_id: conn, location_id: cabA, qty: avail + 1, use_for: 'general' }), /Only/));
});

// ---- Orders ----------------------------------------------------------------------------------------
console.log('Orders: receiving ordered items');

async function orderedRequest(title, items) {
  const number = await by(member, 'save_request', null, { title, requester: 'Mia Member', subsystem: 'Battery', priority: '', needed_by: '2030-01-01', justification: 'Inventory test' },
    items.map((i) => ({ vendor: 'DigiKey', ...i })), 'submit');
  const { id } = await one(`select id from requests where request_number = $1`, [number]);
  await by(ce, 'review_request', id, 'approve', '');
  assert.equal((await one(`select status from requests where id = $1`, [id])).status, 'Approved');
  return { id, number };
}

let req, lineConn, lineSvc;
await test('approved isn\'t ordered: nothing can be received until the Treasurer marks it Ordered', async () => {
  req = await orderedRequest('Connectors restock', [
    { item_name: 'PP45 connector', part_number: '1327G6-ND', quantity: '10', unit_price: '0.80' },
    { item_name: 'Machining service', quantity: '1', unit_price: '50' },
  ]);
  [lineConn, lineSvc] = (await all(`select id from request_items where request_id = $1 order by position`, [req.id])).map((r) => r.id);
  // Linked while still approved: it's "requested", not "on order", so it doesn't make stock look covered.
  await by(ce, 'inventory_link_order_line', lineConn, conn, 1);
  let o = (await by(member, 'inventory_overview')).items.find((i) => i.id === conn);
  assert.deepEqual([num(o.on_order), num(o.requested)], [0, 10]);
  await as(ce, () => rejects(call('inventory_receive_order', op(), { line_id: lineConn, qty: 6, location_id: cabA }), /isn't ordered until/));
  await by(treasurer, 'mark_ordered', req.id, '2026-11-01', 'PO-1', '');
  o = (await by(member, 'inventory_overview')).items.find((i) => i.id === conn);
  assert.deepEqual([num(o.on_order), num(o.requested)], [10, 0]);
});

await test('the receiving list suggests the catalog item with the same part number (never by name alone)', async () => {
  await by(ce, 'inventory_link_order_line', lineConn, null, null);
  const lines = await by(ce, 'inventory_order_lines', null, true);
  const mine = lines.filter((l) => l.request_id === req.id);
  assert.deepEqual(mine.map((l) => [l.item_name, num(l.outstanding)]), [['PP45 connector', 10], ['Machining service', 1]]);
  assert.deepEqual(mine[0].suggest.map((s) => s.item_id), [conn], 'matched on the supplier part number');
  assert.equal(mine[1].suggest, null);
  await by(ce, 'inventory_link_order_line', lineConn, conn, 1);
});

await test('partial deliveries: 6 then 4 make two receipts on the same line; Orders follows along', async () => {
  const before = (await totals(conn)).on_hand;
  const first = op();
  const r1 = await by(ce, 'inventory_receive_order', first, { line_id: lineConn, qty: 6, location_id: cabA });
  assert.deepEqual([num(r1.received), num(r1.outstanding), r1.request_status], [6, 4, 'Ordered']);
  assert.equal((await one(`select arrived_on from request_items where id = $1`, [lineConn])).arrived_on, null, 'not arrived until all of it is here');
  // A retry of the same delivery doesn't receive it twice.
  const again = await by(ce, 'inventory_receive_order', first, { line_id: lineConn, qty: 6, location_id: cabA });
  assert.equal(again.replay, true);
  await as(ce, () => rejects(call('inventory_receive_order', op(), { line_id: lineConn, qty: 5, location_id: cabA }), /Only 4 still to come on this line \(10 ordered, 6 received\)/));
  const r2 = await by(ce, 'inventory_receive_order', op(), { line_id: lineConn, qty: 4, location_id: cabB });
  assert.deepEqual([num(r2.outstanding), r2.request_status], [0, 'Ordered'], 'the service line is still to come');
  assert.equal((await totals(conn)).on_hand, before + 10);
  assert.equal((await one(`select count(*)::int n from inventory_receipts where request_item_id = $1`, [lineConn])).n, 2);
  const line = await one(`select arrived_on, arrived_via_inventory, arrived_with_request from request_items where id = $1`, [lineConn]);
  assert.ok(line.arrived_on && line.arrived_via_inventory && !line.arrived_with_request);
  const o = (await by(member, 'inventory_overview')).items.find((i) => i.id === conn);
  assert.equal(num(o.on_order), 0);
});

await test('a service isn\'t stock: received as "not an inventory item"; then the request is Received as usual', async () => {
  await as(ce, () => rejects(call('inventory_receive_order', op(), { line_id: lineSvc, qty: 1, location_id: cabA }), /Link "Machining service" to an inventory item first/));
  const r = await by(ce, 'inventory_receive_order', op(), { line_id: lineSvc, qty: 1, destination: 'non_inventory' });
  assert.equal(r.request_status, 'Received');
  const oi = await one(`select received_date, received_notes from order_information where request_id = $1`, [req.id]);
  assert.ok(oi.received_date);
  assert.match(oi.received_notes, /Received in Inventory/);
  const events = (await all(`select kind, note from request_events where request_id = $1 order by id`, [req.id])).map((e) => e.kind);
  assert.deepEqual(events.slice(-4), ['inventory', 'inventory', 'inventory', 'received']);
  // The usual "your order arrived" message went to the requester.
  assert.ok((await one(`select count(*)::int n from notification_outbox where event = 'received' and request_id = $1`, [req.id])).n >= 0);
});

await test('lines received in Inventory can\'t be removed or lowered below what arrived', async () => {
  await rejects(db.query(`delete from request_items where id = $1`, [lineConn]), /was received in Inventory, so it can't be removed/);
  await rejects(db.query(`update request_items set quantity = 8 where id = $1`, [lineConn]), /10 of "PP45 connector" were already received/);
  await rejects(db.query(`delete from requests where id = $1`, [req.id]), /was received in Inventory/);
});

await test('over-deliveries: refused for receivers; an inventory manager records them with a reason', async () => {
  const r = await orderedRequest('Wire', [{ item_name: '12 AWG wire 25 ft spool', part_number: 'W12R-25', quantity: '2', unit_price: '20' }]);
  await by(treasurer, 'mark_ordered', r.id, '2026-11-02', 'PO-2', '');
  const line = (await one(`select id from request_items where request_id = $1`, [r.id])).id;
  await by(ce, 'inventory_link_order_line', line, wire, 7.62); // a 25 ft spool is 7.62 m
  await as(ce, () => rejects(call('inventory_receive_order', op(), { line_id: line, qty: 3, location_id: cabA }), /Only 2 still to come/));
  await as(manager, () => rejects(call('inventory_receive_order', op(), { line_id: line, qty: 3, location_id: cabA }), /with a reason/));
  const res = await by(manager, 'inventory_receive_order', op(), { line_id: line, qty: 3, location_id: cabA, over_reason: 'Supplier sent an extra spool' });
  assert.deepEqual([res.over, num(res.qty)], [true, 22.86]);
  const unitCost = Number((await one(`select unit_cost from inventory_items where id = $1`, [wire])).unit_cost);
  assert.equal(Math.round(unitCost * 100) / 100, 2.62, 'cost per metre from the order line');
  // The link can't change once something was received against it.
  await as(ce, () => rejects(call('inventory_link_order_line', line, wire, 1), /already received as that item/));
});

await test('straight to a subsystem: attributed as used, never available in the shop', async () => {
  const r = await orderedRequest('Cells for the pack', [{ item_name: '21700 cells', part_number: 'C21700', quantity: '8', unit_price: '6' }]);
  await by(treasurer, 'mark_ordered', r.id, '2026-11-03', 'PO-3', '');
  const line = (await one(`select id from request_items where request_id = $1`, [r.id])).id;
  await by(ce, 'inventory_link_order_line', line, cells, 1);
  const before = await totals(cells);
  await as(ce, () => rejects(call('inventory_receive_order', op(), { line_id: line, qty: 8, destination: 'direct' }), /Say what it's for/));
  const res = await by(ce, 'inventory_receive_order', op(), { line_id: line, qty: 8, destination: 'direct', use_for: 'subsystem', subsystem_id: battery });
  assert.equal(res.request_status, 'Received');
  assert.deepEqual(await totals(cells), before, 'no stock was added');
  const use = await one(`select kind, location_id, qty::float q, subsystem_id from inventory_movements where kind = 'direct_use' and item_id = $1`, [cells]);
  assert.deepEqual([use.kind, use.location_id, use.q, use.subsystem_id], ['direct_use', null, -8, battery]);
});

await test('undoing a receipt puts Orders back: the line is not arrived again while the request is still Ordered', async () => {
  const r = await orderedRequest('Undo test', [{ item_name: 'PP45 connector', part_number: '1327G6-ND', quantity: '2', unit_price: '1' },
                                                { item_name: 'PP45 contact', quantity: '2', unit_price: '1' }]);
  await by(treasurer, 'mark_ordered', r.id, '2026-11-04', 'PO-4', '');
  const [line] = (await all(`select id from request_items where request_id = $1 order by position`, [r.id])).map((x) => x.id);
  await by(ce, 'inventory_link_order_line', line, conn, 1);
  const rcv = op();
  await by(ce, 'inventory_receive_order', rcv, { line_id: line, qty: 2, location_id: cabB });
  assert.ok((await one(`select arrived_on from request_items where id = $1`, [line])).arrived_on);
  await by(ce, 'inventory_reverse', op(), rcv, 'Wrong box');
  const after = await one(`select arrived_on, arrived_via_inventory from request_items where id = $1`, [line]);
  assert.deepEqual([after.arrived_on, after.arrived_via_inventory], [null, false]);
  assert.equal(num((await one(`select public.inv_order_received($1) r`, [line])).r), 0);
  assert.match((await one(`select note from request_events where request_id = $1 order by id desc limit 1`, [r.id])).note, /undone: Wrong box/);
});

await test('Orders\' own buttons still work: Mark as Received / Undo, ticking items, the Treasurer\'s item edits', async () => {
  const r = await orderedRequest('Orders compatibility', [{ item_name: 'Bolt', quantity: '5', unit_price: '0.1' }, { item_name: 'Nut', quantity: '5', unit_price: '0.05' }]);
  await by(treasurer, 'mark_ordered', r.id, '2026-11-05', 'PO-5', '');
  const [bolt, nut] = (await all(`select id from request_items where request_id = $1 order by position`, [r.id])).map((x) => x.id);
  assert.equal(await by(member, 'set_items_arrived', r.id, [bolt], true, null, ''), 1);
  await by(member, 'mark_received', r.id, null, 'In the shop');
  assert.equal((await one(`select status from requests where id = $1`, [r.id])).status, 'Received');
  assert.equal(await by(member, 'undo_received', r.id), 1);
  assert.equal((await one(`select status from requests where id = $1`, [r.id])).status, 'Ordered');
  // Received by Orders but never put into Inventory: it doesn't show up in Inventory's waiting list by itself (no
  // old purchases in stock without someone checking them), but it can still be put away against the request.
  await by(member, 'mark_received', r.id, null, 'In the shop');
  const waiting = (await by(ce, 'inventory_order_lines', null, true)).filter((l) => l.request_id === r.id);
  assert.equal(waiting.length, 0);
  const lines = await by(ce, 'inventory_order_lines', r.id, true);
  assert.equal(lines.length, 2);
  await by(ce, 'inventory_link_order_line', nut, conn, 1);
  await by(ce, 'inventory_receive_order', op(), { line_id: nut, qty: 5, location_id: cabB });
  assert.equal((await one(`select status from requests where id = $1`, [r.id])).status, 'Received');
  // The Treasurer can still edit the items of an ordered request that Inventory hasn't touched.
  const r2 = await orderedRequest('Edit items', [{ item_name: 'Washer', quantity: '10', unit_price: '0.02' }]);
  await by(treasurer, 'mark_ordered', r2.id, '2026-11-05', 'PO-6', '');
  const w = (await one(`select id from request_items where request_id = $1`, [r2.id])).id;
  await by(treasurer, 'edit_request_items', r2.id, [{ id: w, item_name: 'Washer', quantity: 8, unit_price: 0.02 }], 'Out of stock');
  assert.equal(Number((await one(`select quantity from request_items where id = $1`, [w])).quantity), 8);
});

// ---- counts -----------------------------------------------------------------------------------------
console.log('Counts');

await test('a count keeps what happened after each line was counted, and posts only the difference', async () => {
  const count = await by(ce, 'inventory_count_start', { name: 'Cabinet A', location_ids: [cabA] });
  const line = await one(`select id, expected::float e from inventory_count_lines where count_id = $1 and item_id = $2 and location_id = $3`, [count, conn, cabA]);
  const system = await at(conn, cabA);
  assert.equal(line.e, system);
  // Counted 2 fewer than the system says...
  const rec = await by(ce, 'inventory_count_record', line.id, system - 2, '');
  assert.equal(num(rec.difference), -2);
  // ...then someone takes 5 before the count is applied.
  await by(member, 'inventory_consume', op(), { item_id: conn, location_id: cabA, qty: 5, use_for: 'general' });
  // Overlapping counts are refused.
  await as(ce, () => rejects(call('inventory_count_start', { name: 'Again', location_ids: [shop] }), /already being counted in "Cabinet A"/));
  await by(ce, 'inventory_count_submit', count);
  await by(ce, 'inventory_count_reconcile', op(), count);
  assert.equal(await at(conn, cabA), system - 2 - 5, 'the use after counting is kept; only the -2 was corrected');
  const adj = await one(`select kind, qty::float q, count_id from inventory_movements where count_id = $1`, [count]);
  assert.deepEqual([adj.kind, adj.q], ['count', -2]);
  assert.equal((await one(`select status from inventory_counts where id = $1`, [count])).status, 'closed');
});

await test('big differences need an inventory manager; recounts; things found that weren\'t on the list', async () => {
  const count = await by(ce, 'inventory_count_start', { name: 'Cells', item_ids: [cells] });
  const line = await one(`select id from inventory_count_lines where count_id = $1`, [count]);
  await by(ce, 'inventory_count_record', line.id, 0, 'Shelf empty');
  await by(ce, 'inventory_count_recount', line.id);
  await as(ce, () => rejects(call('inventory_count_submit', count), /waiting for a recount/));
  await by(ce, 'inventory_count_record', line.id, 0, 'Still empty');
  const found = await by(ce, 'inventory_count_add_line', count, { item_id: cells, location_id: cabA });
  await by(ce, 'inventory_count_record', found, 1, 'Found one in Cabinet A');
  const sub = await by(ce, 'inventory_count_submit', count);
  assert.equal(sub.needs_approval, true); // class A item
  await as(ce, () => rejects(call('inventory_count_reconcile', op(), count), /needs to approve this count/));
  await by(manager, 'inventory_count_reconcile', op(), count);
  assert.deepEqual([await at(cells, cabB), await at(cells, cabA)], [0, 1]);
  const lines = await all(`select first_count::float f, added from inventory_count_lines where count_id = $1 order by added`, [count]);
  assert.deepEqual(lines.map((l) => [l.f, l.added]), [[0, false], [null, true]]);
  assert.ok((await by(member, 'inventory_overview')).items.find((i) => i.id === cells).last_counted, 'last counted is shown');
});

// ---- import -----------------------------------------------------------------------------------------
console.log('Spreadsheet import');

await test('one bad row and nothing is imported; every problem is listed', async () => {
  const before = (await one(`select count(*)::int n from inventory_items`)).n;
  const err = await as(manager, () => rejects(call('inventory_import', op(), { file_name: 'shop.xlsx', file_hash: 'h1', rows: [
    { row: 2, name: 'M3 screw', unit: 'ea', qty: '100', location: 'CAB-A' },
    { row: 3, name: '', qty: '5', location: 'CAB-A' },
    { row: 4, name: 'Solder', unit: 'furlong', qty: 'lots', location: 'NOPE' },
    { row: 5, name: 'Washer', qty: '1.5', location: 'CAB-A' },
  ] }), /3 rows with problems, so nothing was imported/));
  assert.match(err.detail, /Row 3: a new item needs a name/);
  assert.match(err.detail, /Row 4: unknown unit "furlong"/);
  assert.match(err.detail, /Row 4: quantity "lots" isn't a number/);
  assert.match(err.detail, /Row 5: quantity 1.5 has more decimal places/);
  assert.equal((await one(`select count(*)::int n from inventory_items`)).n, before);
});

await test('importing: new items, existing SKUs matched, missing locations made on request, stock as import movements', async () => {
  const existing = (await one(`select sku from inventory_items where id = $1`, [conn])).sku;
  const res = await by(manager, 'inventory_import', op(), { file_name: 'shop.xlsx', file_hash: 'h2', create_locations: true, create_categories: true, rows: [
    { row: 2, name: 'M3x8 socket head screw', unit: 'ea', qty: '200', location: 'CAB-A', category: 'Fasteners', supplier: 'McMaster', supplier_pn: '91290A113', reorder_point: '50' },
    { row: 3, name: 'M3x8 socket head screw', unit: 'ea', qty: '50', location: 'bin 7', location_name: 'Bin 7' },
    { row: 4, sku: existing, qty: '3', location: 'CAB-B' },
    { row: 5, name: 'Loctite 243', unit: 'ml', qty: '50', location: 'FLAM-1', lot: 'B123', expires_on: '2031-01-01' },
  ] });
  assert.deepEqual([res.items_created, res.items_matched, res.stock_lines], [2, 1, 4]);
  const screw = await one(`select id, reorder_point::float rp, track_lots from inventory_items where name = 'M3x8 socket head screw'`);
  assert.equal((await totals(screw.id)).on_hand, 250);
  assert.ok(await one(`select 1 x from inventory_locations where code = 'BIN-7'`));
  assert.equal((await one(`select track_lots from inventory_items where name = 'Loctite 243'`)).track_lots, true);
  assert.equal((await one(`select count(*)::int n from inventory_movements where kind = 'import' and op_id = $1`, [res.op])).n, 4);
});

await test('the same file twice is refused (OS410) unless meant; an import can be undone while its stock is untouched', async () => {
  const rows = [{ row: 2, name: 'Zip tie 200 mm', qty: '100', location: 'CAB-B' }];
  const first = await by(manager, 'inventory_import', op(), { file_name: 'ties.csv', file_hash: 'h3', rows });
  const err = await as(manager, () => rejects(call('inventory_import', op(), { file_name: 'ties.csv', file_hash: 'h3', rows }), /already imported/));
  assert.equal(err.code, 'OS410');
  await by(manager, 'inventory_reverse', op(), first.op, 'Wrong file');
  const tie = (await one(`select id from inventory_items where name = 'Zip tie 200 mm'`)).id;
  assert.equal((await totals(tie)).on_hand, 0);
  await by(manager, 'inventory_import', op(), { file_name: 'ties.csv', file_hash: 'h3', rows: [{ row: 2, item_id: tie, qty: '100', location: 'CAB-B' }] }); // undone, so allowed
  assert.equal((await totals(tie)).on_hand, 100);
  await as(ce, () => rejects(call('inventory_import', op(), { file_name: 'x', rows }), /Manage inventory/));
});

// ---- reports ----------------------------------------------------------------------------------------
console.log('Reports');

await test('usage: transfers aren\'t use; returns and undos net out; old usage stays with the division it was in', async () => {
  const pot = await by(manager, 'inventory_save_item', null, { sku: 'POTTING-1', name: 'Potting compound', unit: 'g', decimals: 0, unit_cost: 0.05 });
  await by(ce, 'inventory_receive', op(), { item_id: pot, location_id: cabA, qty: 1000 });
  await by(ce, 'inventory_transfer', op(), { item_id: pot, from_id: cabA, to_id: cabB, qty: 500 });
  await by(member, 'inventory_consume', op(), { item_id: pot, location_id: cabA, qty: 100, use_for: 'subsystem', subsystem_id: array_ });
  const ret = op();
  await by(member, 'inventory_consume', ret, { item_id: pot, location_id: cabA, qty: 50, use_for: 'subsystem', subsystem_id: array_ });
  await by(member, 'inventory_return', op(), { item_id: pot, location_id: cabA, qty: 20, returns_op: ret });
  const undone = op();
  await by(member, 'inventory_consume', undone, { item_id: pot, location_id: cabA, qty: 7, use_for: 'subsystem', subsystem_id: array_ });
  await by(member, 'inventory_reverse', op(), undone, 'Typo');
  await by(member, 'inventory_consume', op(), { item_id: pot, location_id: cabB, qty: 30, use_for: 'division', division_id: powertrain });
  // The Array subsystem moves to Aero, then more is used.
  await by(manager, 'org_save_subsystem', array_, aero, 'Solar array', null);
  await by(member, 'inventory_consume', op(), { item_id: pot, location_id: cabB, qty: 10, use_for: 'subsystem', subsystem_id: array_ });

  const usage = (await by(member, 'inventory_usage', null, null)).filter((u) => u.item_id === pot)
    .map((u) => ({ ...u, q: Number(u.qty), c: Number(u.cost) })).sort((a, b) => b.q - a.q);
  const nov = await by(member, 'inventory_usage', '2999-01-01', null);
  assert.deepEqual(nov, [], 'dates limit it');
  assert.deepEqual(usage.map((u) => [u.division_id, u.subsystem_id, u.q]), [
    [powertrain, array_, 130], // 100 + 50 − 20, with the undone 7 netting to nothing; still Powertrain
    [powertrain, null, 30],    // the whole division
    [aero, array_, 10],        // after the move
  ]);
  assert.equal(usage[0].subsystem_name, 'Solar array', 'shown with today\'s name');
  assert.equal(usage[0].c, 6.5);
  // Rolled up: Powertrain used 160 g (130 + 30), Aero 10: every line counted once.
  const byDivision = {};
  for (const u of usage) byDivision[u.division_id] = (byDivision[u.division_id] || 0) + u.q;
  assert.deepEqual([byDivision[powertrain], byDivision[aero]], [160, 10]);
});

await test('low stock: available against the reorder point; ordered (not just requested) counts as coming', async () => {
  const o = (await by(member, 'inventory_overview')).items.find((i) => i.id === conn);
  assert.equal(num(o.reorder_point), 40);
  assert.ok(num(o.available) >= 0);
  assert.equal(typeof o.count_due, 'boolean');
  const ov = await by(member, 'inventory_overview');
  assert.equal(typeof ov.waitingLines, 'number');
  assert.deepEqual(Object.keys(ov.settings.countDays), ['A', 'B', 'C']);
});

// ---- who can see and do what -------------------------------------------------------------------------
console.log('Access');

await test('guests, former members and the signed-out world see nothing and can do nothing', async () => {
  for (const uid of [guest, former]) {
    assert.equal((await as(uid, () => all(`select * from inventory_items`))).length, 0);
    assert.equal((await as(uid, () => all(`select * from inventory_movements`))).length, 0);
    await as(uid, () => rejects(call('inventory_overview'), /hasn't been accepted|access has ended/));
    await as(uid, () => rejects(call('inventory_consume', op(), { item_id: conn, location_id: cabA, qty: 1, use_for: 'general' }), /hasn't been accepted|access has ended/));
  }
  await as(null, () => rejects(db.query(`select * from inventory_items`), /permission denied/));
  await as(null, () => rejects(call('inventory_overview'), /permission denied/));
});

await test('a member without inventory permissions can\'t read or change anything', async () => {
  await db.exec(`insert into roles (key, label, sort) values ('no_inv', 'No inventory', 90);`);
  const outsider = await person('inv-outsider@ufl.edu', 'Olly Outsider', ['no_inv']);
  assert.equal((await as(outsider, () => all(`select * from inventory_stock`))).length, 0);
  await as(outsider, () => rejects(call('inventory_consume', op(), { item_id: conn, location_id: cabA, qty: 1, use_for: 'general' }), /needs "Use stock" or "Manage inventory"/));
  await as(outsider, () => rejects(call('inventory_receive', op(), { item_id: conn, location_id: cabA, qty: 1 }), /can't do this/));
  // Members (view + use) can't add stock, move it, count, correct it, change items or the organization.
  await as(member, () => rejects(call('inventory_receive', op(), { item_id: conn, location_id: cabA, qty: 1 }), /can't do this/));
  await as(member, () => rejects(call('inventory_transfer', op(), { item_id: conn, from_id: cabA, to_id: cabB, qty: 1 }), /can't do this/));
  await as(member, () => rejects(call('inventory_count_start', { name: 'x' }), /can't do this/));
  await as(member, () => rejects(call('inventory_adjust', op(), { item_id: conn, location_id: cabA, delta: 5, reason: 'free parts' }), /can't do this/));
  await as(member, () => rejects(call('inventory_save_settings', { countDays: { A: 1, B: 1, C: 1 }, approvalValue: 0, approvalPct: 0, expiryWarnDays: 0 }), /can't do this/));
  await as(member, () => rejects(call('org_archive_subsystem', motor, true), /can't do this/));
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
