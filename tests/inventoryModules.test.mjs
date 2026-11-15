/**
 * Inventory's browser modules that don't need a page: stock states, units, labels' QR codes (decoded back with
 * jsQR, the way a phone reads them), spreadsheet import checks, CSV, and report roll-ups.
 *
 *   node tests/inventoryModules.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import jsQR from 'jsqr';
import { stockState, suggestedOrder, needsReorder, convert, unitsFor, inventoryLink, parseInventoryLink, useForLabel, locationTree,
  locationAndChildren, firstExpiringFirst, lotProblem, fmtQty, newOpId } from '../orders/js/inventory/core.js';
import { parseCsv, detectMapping, checkRows, normalizeUnit, parseNumber, parseDate, toCsv, fileHash } from '../orders/js/inventory/importer.js';
import { rollup, byItem, groupTotals, byMonth, suggestClasses } from '../orders/js/inventory/reports.js';
import { qrMatrix, qrSvg } from '../orders/js/inventory/qr.js';

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

const UNITS = [
  { code: 'ea', label: 'each', dimension: 'count', factor: 1 }, { code: 'm', label: 'm', dimension: 'length', factor: 1 },
  { code: 'ft', label: 'ft', dimension: 'length', factor: 0.3048 }, { code: 'mm', label: 'mm', dimension: 'length', factor: 0.001 },
  { code: 'kg', label: 'kg', dimension: 'mass', factor: 1 }, { code: 'roll', label: 'roll', dimension: 'roll', factor: 1 },
];

console.log('Stock levels');

await test('low stock looks at what\'s available, and only counts what\'s actually ordered as coming', async () => {
  assert.equal(stockState({ available: 50, reorder_point: 40 }).key, 'ok');
  assert.equal(stockState({ available: 30, reorder_point: 40, on_order: 0, requested: 100 }).key, 'low', 'requested (not ordered) doesn\'t cover it');
  assert.equal(stockState({ available: 30, reorder_point: 40, on_order: 20 }).key, 'covered');
  assert.equal(stockState({ available: 0, reorder_point: 5 }).key, 'out');
  assert.equal(stockState({ available: 0, on_hand: 4, reorder_point: null }).key, 'low', 'all of it set aside or expired');
  assert.equal(stockState({ available: 3, reorder_point: null }).key, 'ok');
  assert.equal(needsReorder({ available: 30, reorder_point: 40 }), true);
  assert.equal(needsReorder({ available: 30, reorder_point: 40, on_order: 20 }), false);
  assert.equal(suggestedOrder({ reorder_qty: 100 }), 100);
  assert.equal(suggestedOrder({ reorder_point: 40, available: 30, on_order: 0 }), 50);
});

await test('units convert only within a kind; amounts show cleanly', async () => {
  assert.equal(Math.round(convert(10, 'ft', 'm', UNITS) * 1000) / 1000, 3.048);
  assert.equal(convert(1, 'kg', 'm', UNITS), null);
  assert.equal(convert(1, 'roll', 'ea', UNITS), null);
  assert.deepEqual(unitsFor({ unit: 'm' }, UNITS).map((u) => u.code), ['m', 'ft', 'mm']);
  assert.equal(fmtQty(1200.5, 'm'), '1,200.5 m');
  assert.equal(fmtQty(0, 'ea'), '0 ea');
  assert.match(newOpId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

await test('what stock was used for, in words', async () => {
  const org = { divisions: [{ id: 'd1', name: 'Powertrain' }], subsystems: [{ id: 's1', name: 'Battery' }] };
  assert.equal(useForLabel({ use_for: 'subsystem', division_id: 'd1', subsystem_id: 's1' }, org), 'Battery (Powertrain)');
  assert.equal(useForLabel({ use_for: 'division', division_id: 'd1' }, org), 'Powertrain (whole division)');
  assert.equal(useForLabel({ use_for: 'general' }, org), 'General shop');
  assert.equal(useForLabel({ use_for: 'subsystem', division_id: 'gone', subsystem_id: 'gone', division_name: 'Old', subsystem_name: 'Thing' }, org), 'Thing (Old)');
});

await test('locations as a tree; a location and everything inside it', async () => {
  const locs = [
    { id: 'b', code: 'CAB-B', parent_id: 's' }, { id: 'a', code: 'CAB-A', parent_id: 's' }, { id: 's', code: 'SHOP', parent_id: null },
    { id: 'a1', code: 'CAB-A-1', parent_id: 'a' }, { id: 'x', code: 'OLD', parent_id: null, archived_at: '2026-01-01' },
  ];
  assert.deepEqual(locationTree(locs).map((l) => `${'-'.repeat(l.depth)}${l.code}`), ['SHOP', '-CAB-A', '--CAB-A-1', '-CAB-B']);
  assert.equal(locationTree(locs).find((l) => l.id === 'a1').path, 'SHOP › CAB-A › CAB-A-1');
  assert.deepEqual(locationAndChildren('a', locs).sort(), ['a', 'a1']);
});

await test('lots: first expiring first; expired / retest / damaged lots are flagged', async () => {
  const lots = [{ id: 1, expires_on: '2031-01-01' }, { id: 2, expires_on: '2027-05-01' }, { id: 3 }, { id: 4, retest_on: '2026-12-01' }];
  assert.deepEqual(firstExpiringFirst(lots).map((l) => l.id), [4, 2, 1, 3]);
  assert.equal(lotProblem({ expires_on: '2026-01-01' }, '2026-11-14'), 'expired 2026-01-01');
  assert.equal(lotProblem({ retest_on: '2026-11-13' }, '2026-11-14'), 'retest was due 2026-11-13');
  assert.equal(lotProblem({ condition: 'damaged', expires_on: '2030-01-01' }, '2026-11-14'), 'marked damaged');
  assert.equal(lotProblem({ expires_on: '2026-11-14' }, '2026-11-14'), '', 'usable on its expiry date');
});

console.log('QR labels');

await test('a label\'s QR code reads back as the one.solar address of that item (as a phone camera would)', async () => {
  const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const url = inventoryLink('https://one.ufsolargators.org/', 'item', id);
  assert.equal(url, `https://one.ufsolargators.org/inventory/#/inventory/items/${id}`);
  const m = qrMatrix(url);
  const scale = 4;
  const margin = 4;
  const size = (m.length + margin * 2) * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  m.forEach((row, r) => row.forEach((dark, c) => {
    if (!dark) return;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const i = (((r + margin) * scale + y) * size + (c + margin) * scale + x) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
    }
  }));
  const read = jsQR(pixels, size, size);
  assert.ok(read, 'the code could be read');
  assert.equal(read.data, url);
  assert.deepEqual(parseInventoryLink(read.data), { kind: 'item', id });
  assert.deepEqual(parseInventoryLink(inventoryLink('http://localhost:5173', 'location', id)), { kind: 'location', id });
  assert.equal(parseInventoryLink('https://example.com/'), null);
});

await test('the SVG is black on white and scales; the vendored library is the npm package, unchanged', async () => {
  const svg = qrSvg('https://one.ufsolargators.org/inventory/', { title: 'A & B' });
  assert.match(svg, /^<svg class="qr"[^>]*viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /fill="#fff"/);
  assert.match(svg, /<title>A &amp; B<\/title>/);
  // Compared with the same line endings: a Windows checkout may turn the vendored copy's LF into CRLF.
  const lf = (t) => t.replace(/\r\n/g, '\n');
  const vendored = lf(readFileSync(new URL('../shared/vendor/qrcode-generator.mjs', import.meta.url), 'utf8')).split('\n').slice(2).join('\n');
  const npm = lf(readFileSync(new URL('../node_modules/qrcode-generator/dist/qrcode.mjs', import.meta.url), 'utf8'));
  assert.equal(vendored, npm);
});

console.log('Spreadsheet import');

await test('CSV: quotes, commas inside quotes, CRLF, a byte-order mark, semicolons; blank lines skipped', async () => {
  const csv = '﻿Name,Qty,Notes\r\n"Bolt, M3",12,"say ""hi"""\r\n\r\nNut,4,\r\n';
  const s = parseCsv(csv);
  assert.deepEqual(s.columns, ['Name', 'Qty', 'Notes']);
  assert.deepEqual(s.rows.map((r) => r.values), [{ Name: 'Bolt, M3', Qty: '12', Notes: 'say "hi"' }, { Name: 'Nut', Qty: '4' }]);
  assert.deepEqual(s.rows.map((r) => r.row_number), [2, 4]);
  assert.deepEqual(parseCsv('a;b\n1;2').rows[0].values, { a: '1', b: '2' });
  assert.equal(toCsv([['a', 'b, c'], ['x"y', 1]]), 'a,"b, c"\r\n"x""y",1');
});

await test('columns are matched by their usual names, each used once', async () => {
  const map = detectMapping(['Part #', 'Item Name', 'Qty on hand', 'Units', 'Bin', 'Mfr', 'Mfr Part #', 'Vendor', 'DigiKey Part #', 'Unit Cost', 'Reorder Point', 'Expiry']);
  assert.deepEqual(map, { sku: 'Part #', name: 'Item Name', qty: 'Qty on hand', unit: 'Units', location: 'Bin', manufacturer: 'Mfr', mpn: 'Mfr Part #',
    supplier: 'Vendor', supplier_pn: 'DigiKey Part #', unit_cost: 'Unit Cost', reorder_point: 'Reorder Point', expires_on: 'Expiry' });
});

await test('numbers, dates and unit words people actually type', async () => {
  assert.deepEqual([parseNumber('$1,234.50'), parseNumber(''), Number.isNaN(parseNumber('lots'))], [1234.5, null, true]);
  assert.deepEqual([parseDate('3/15/2027'), parseDate('2027-3-5'), parseDate(''), parseDate('soon')], ['2027-03-15', '2027-03-05', '', null]);
  assert.deepEqual(['Pieces', 'meters', 'FT', 'each', 'furlong'].map((u) => normalizeUnit(u, UNITS)), ['ea', 'm', 'ft', 'ea', 'furlong']);
});

await test('every row is checked before anything is sent; duplicates are pointed out, never merged', async () => {
  const sheet = parseCsv([
    'SKU,Name,Qty,Unit,Location,Mfr Part #',
    'CONN-1,,5,,CAB-A,',               // existing SKU: fine without a name
    ',Bolt M3,10,pcs,CAB-A,',            // new
    ',Solder,lots,furlong,NOPE,',        // three problems
    ',Washer,1.5,ea,CAB-A,',             // whole items only
    ',PP45 housing,2,ea,NEW-BIN,1327G6', // same part number as an existing item; new location
  ].join('\n'));
  const items = [{ id: 'i1', sku: 'CONN-1', name: 'Anderson PP45', unit: 'ea', decimals: 0, mpn: '1327G6' }];
  const rows = checkRows(sheet, detectMapping(sheet.columns), { items, units: UNITS, locations: [{ code: 'CAB-A' }], categories: [], createLocations: true });
  assert.deepEqual(rows.map((r) => r.match.kind), ['sku', 'new', 'new', 'new', 'new']);
  assert.deepEqual(rows[0].errors, []);
  assert.equal(rows[1].out.unit, 'ea');
  assert.deepEqual(rows[2].errors, ['Unknown unit "furlong".', 'Quantity "lots" isn\'t a number.']);
  assert.deepEqual(rows[3].errors, ['Quantity 1.5 has more decimal places than the item keeps (0).']);
  assert.deepEqual(rows[4].errors, []);
  assert.deepEqual(rows[4].similar.map((s) => s.id), ['i1']);
  assert.match(rows[4].warnings.join(' '), /Location NEW-BIN will be added.*Might already be in the catalog: Anderson PP45 \(CONN-1\)/);
  const strict = checkRows(sheet, detectMapping(sheet.columns), { items, units: UNITS, locations: [{ code: 'CAB-A' }], categories: [] });
  assert.deepEqual(strict[4].errors, ['No location with the code NEW-BIN.']);
});

await test('the same file always gives the same fingerprint (so it isn\'t imported twice)', async () => {
  const a = await fileHash(new TextEncoder().encode('Name,Qty\nBolt,1\n'));
  const b = await fileHash(new TextEncoder().encode('Name,Qty\nBolt,1\n'));
  const c = await fileHash(new TextEncoder().encode('Name,Qty\nBolt,2\n'));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});

console.log('Reports');

const USAGE = [
  { division_id: 'pt', division_name: 'Powertrain', subsystem_id: 'bat', subsystem_name: 'Battery', item_id: 'c', sku: 'C', item_name: 'Cell', unit: 'ea', used_by: 'Mia', month: '2026-09', qty: 10, cost: 60, cost_known: true, lines: 2 },
  { division_id: 'pt', division_name: 'Powertrain', subsystem_id: 'mot', subsystem_name: 'Motor', item_id: 'b', sku: 'B', item_name: 'Bolt', unit: 'ea', used_by: 'Mia', month: '2026-11', qty: 40, cost: 4, cost_known: true, lines: 1 },
  { division_id: 'pt', division_name: 'Powertrain', subsystem_id: null, subsystem_name: null, item_id: 'b', sku: 'B', item_name: 'Bolt', unit: 'ea', used_by: 'Otto', month: '2026-11', qty: 10, cost: 1, cost_known: true, lines: 1 },
  { division_id: 'aero', division_name: 'Aero', subsystem_id: 'bat', subsystem_name: 'Battery', item_id: 'c', sku: 'C', item_name: 'Cell', unit: 'ea', used_by: 'Otto', month: '2026-11', qty: 1, cost: null, cost_known: false, lines: 1 },
  { division_id: null, use_for: 'general', item_id: 'b', sku: 'B', item_name: 'Bolt', unit: 'ea', used_by: 'Mia', month: '2026-11', qty: 5, cost: 0.5, cost_known: true, lines: 1 },
];

await test('divisions roll up their subsystems and whole-division use, each line once', async () => {
  const r = rollup(USAGE);
  assert.deepEqual(r.map((d) => [d.name, d.cost, d.lines]), [['Powertrain', 65, 4], ['Aero', 0, 1], ['General shop', 0.5, 1]]);
  const pt = r[0];
  assert.deepEqual(pt.subsystems.map((s) => [s.name, s.cost]), [['Battery', 60], ['Motor', 4]]);
  assert.deepEqual([pt.whole.cost, pt.whole.qty], [1, 10]);
  assert.equal(pt.cost, pt.subsystems.reduce((s, x) => s + x.cost, 0) + pt.whole.cost, 'subsystems + whole division = the division');
  assert.deepEqual(pt.items.map((i) => [i.name, i.qty]), [['Cell', 10], ['Bolt', 50]]);
  assert.equal(r.find((d) => d.name === 'Aero').costUnknown, true, 'a missing cost is flagged, not counted as zero silently');
  // A subsystem that moved between divisions shows under each division for the time it was there.
  assert.ok(r.find((d) => d.name === 'Aero').subsystems.some((s) => s.id === 'bat'));
});

await test('by person, by item, month by month (gaps filled), and suggested count classes', async () => {
  assert.deepEqual(groupTotals(USAGE, (r) => r.used_by).map((g) => [g.key, g.cost]), [['Mia', 64.5], ['Otto', 1]]);
  assert.deepEqual(byItem(USAGE).map((i) => [i.name, i.qty]), [['Cell', 11], ['Bolt', 55]]);
  assert.deepEqual(byMonth(USAGE).map((m) => [m.month, m.cost]), [['2026-09', 60], ['2026-10', 0], ['2026-11', 5.5]]);
  const classes = suggestClasses([{ id: 'x', on_hand: 100, unit_cost: 50 }, { id: 'y', on_hand: 10, unit_cost: 50 }, { id: 'z', on_hand: 1000, unit_cost: 0.01 }, { id: 'w', on_hand: 5 }]);
  assert.deepEqual(classes, { x: 'A', y: 'B', z: 'C', w: 'C' });
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
