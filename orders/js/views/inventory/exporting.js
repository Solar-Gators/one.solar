/**
 * Inventory downloads: Excel workbooks built in the browser with the same ExcelJS Orders uses (excel.js).
 *   catalog, stock by location, transaction history, low stock, usage by division / subsystem, count results.
 */
import { loadExcelJS } from '../../excel.js';
import { inv } from '../../inventory/api.js';
import { stockState, suggestedOrder, useForLabel, lotLabel, KIND_LABELS } from '../../inventory/core.js';
import { rollup } from '../../inventory/reports.js';
import { locCode } from './kit.js';

const today = () => new Date().toISOString().slice(0, 10);

/** sheets: [{ name, columns: [{ header, width, type: 'number' | 'money' | 'date' | 'text' }], rows: [[…]] }] */
export async function downloadWorkbook(filename, sheets) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'one.solar Inventory';
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31));
    ws.columns = s.columns.map((c) => ({ header: c.header, width: c.width || 14 }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of s.rows) {
      const row = ws.addRow(r.map((v, i) => {
        const t = s.columns[i]?.type;
        if (v === '' || v === null || v === undefined) return null;
        if ((t === 'number' || t === 'money') && !Number.isNaN(Number(v))) return Number(v);
        if (t === 'date' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
          const [y, m, d] = String(v).slice(0, 10).split('-').map(Number);
          return new Date(Date.UTC(y, m - 1, d));
        }
        return v;
      }));
      s.columns.forEach((c, i) => {
        if (c.type === 'money') row.getCell(i + 1).numFmt = '"$"#,##0.00';
        if (c.type === 'date') row.getCell(i + 1).numFmt = 'yyyy-mm-dd';
      });
    }
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: s.columns.length } };
  }
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const catName = (b, id) => b.categories.find((c) => c.id === id)?.name || '';

export const catalogSheet = (b, items = b.items) => ({
  name: 'Catalog',
  columns: [{ header: 'SKU', width: 14 }, { header: 'Name', width: 34 }, { header: 'Category', width: 16 }, { header: 'Manufacturer', width: 18 },
    { header: 'Manufacturer part number', width: 20 }, { header: 'Unit', width: 8 }, { header: 'On hand', type: 'number' }, { header: 'Available', type: 'number' },
    { header: 'Set aside', type: 'number' }, { header: 'On order', type: 'number' }, { header: 'Reorder point', type: 'number' }, { header: 'Reorder quantity', type: 'number' },
    { header: 'Unit cost', type: 'money' }, { header: 'Count class', width: 8 }, { header: 'Lots', width: 8 }, { header: 'Hazardous', width: 10 }, { header: 'Status', width: 12 }, { header: 'State', width: 18 }],
  rows: items.map((i) => [i.sku, i.name, catName(b, i.category_id), i.manufacturer, i.mpn, i.unit, i.on_hand, i.available, i.quarantined, i.on_order,
    i.reorder_point, i.reorder_qty, i.unit_cost, i.count_class, i.track_lots ? 'yes' : '', i.hazardous ? 'yes' : '', i.status, stockState(i).label]),
});

export async function stockSheet(b) {
  const [stock, lots] = await Promise.all([inv.stock(), inv.allLots()]);
  const lotById = new Map(lots.map((l) => [l.id, l]));
  return {
    name: 'Stock by location',
    columns: [{ header: 'Location', width: 14 }, { header: 'Location name', width: 22 }, { header: 'SKU', width: 14 }, { header: 'Item', width: 34 },
      { header: 'Lot', width: 16 }, { header: 'Expires', type: 'date' }, { header: 'Status', width: 12 }, { header: 'Quantity', type: 'number' }, { header: 'Unit', width: 8 }],
    rows: stock.filter((s) => Number(s.qty) > 0).map((s) => {
      const i = b.itemById.get(s.item_id) || {};
      const lot = lotById.get(s.lot_id);
      return [locCode(b, s.location_id), b.locById.get(s.location_id)?.name || '', i.sku, i.name, lot ? lotLabel(lot) : '', lot?.expires_on || '',
        s.status === 'quarantine' ? 'Set aside' : 'Available', s.qty, i.unit];
    }).sort((a, b2) => String(a[0]).localeCompare(String(b2[0])) || String(a[3]).localeCompare(String(b2[3]))),
  };
}

export async function historySheet(b, { from, to } = {}) {
  const movements = await inv.allMovements({ from, to });
  const ops = new Map();
  const ids = [...new Set(movements.map((m) => m.op_id))];
  for (let i = 0; i < ids.length; i += 200) for (const o of await inv.ops(ids.slice(i, i + 200))) ops.set(o.id, o);
  return {
    name: 'History',
    columns: [{ header: 'Date', type: 'date' }, { header: 'Recorded', width: 20 }, { header: 'What', width: 14 }, { header: 'SKU', width: 14 }, { header: 'Item', width: 30 },
      { header: 'Change', type: 'number' }, { header: 'Unit', width: 8 }, { header: 'Location', width: 12 }, { header: 'Set aside', width: 9 }, { header: 'For', width: 28 },
      { header: 'Project', width: 16 }, { header: 'Reason / note', width: 30 }, { header: 'By', width: 18 }, { header: 'Undo of an earlier entry', width: 10 }, { header: 'Undone', width: 9 }, { header: 'Operation', width: 38 }],
    rows: movements.map((m) => {
      const i = b.itemById.get(m.item_id) || {};
      const op = ops.get(m.op_id) || {};
      return [m.occurred_on, new Date(m.created_at).toLocaleString(), KIND_LABELS[m.kind] || m.kind, i.sku, i.name, m.qty, i.unit, m.location_id ? locCode(b, m.location_id) : '',
        m.status === 'quarantine' ? 'yes' : '', useForLabel(m, b), m.project, [m.reason, op.note].filter(Boolean).join(' · '), m.actor_name, m.reversal ? 'yes' : '', op.reversed_by ? 'yes' : '', m.op_id];
    }),
  };
}

export const lowStockSheet = (b) => ({
  name: 'Low stock',
  columns: [{ header: 'SKU', width: 14 }, { header: 'Item', width: 34 }, { header: 'Unit', width: 8 }, { header: 'Available', type: 'number' }, { header: 'Reorder point', type: 'number' },
    { header: 'On order (ordered)', type: 'number' }, { header: 'Requested, not ordered', type: 'number' }, { header: 'Suggested order', type: 'number' }, { header: 'State', width: 18 }],
  rows: b.items.filter((i) => i.reorder_point !== null && Number(i.available) <= Number(i.reorder_point))
    .map((i) => [i.sku, i.name, i.unit, i.available, i.reorder_point, i.on_order, i.requested, suggestedOrder(i), stockState(i).label]),
});

export function usageSheets(usage) {
  const tree = rollup(usage);
  const summary = [];
  for (const d of tree) {
    summary.push([d.name, '(division total)', '', '', '', d.cost, d.lines]);
    if (d.whole.lines) summary.push([d.name, '(whole division)', '', '', '', d.whole.cost, d.whole.lines]);
    for (const s of d.subsystems) summary.push([d.name, s.name, '', '', '', s.cost, s.lines]);
    for (const s of d.subsystems) for (const it of s.items) summary.push([d.name, s.name, it.sku, it.name, `${it.qty} ${it.unit}`, it.cost, it.lines]);
    for (const it of d.whole.items) summary.push([d.name, d.id === 'general' ? '' : '(whole division)', it.sku, it.name, `${it.qty} ${it.unit}`, it.cost, it.lines]);
  }
  return [
    {
      name: 'Usage by division',
      columns: [{ header: 'CE division', width: 22 }, { header: 'Subsystem', width: 22 }, { header: 'SKU', width: 14 }, { header: 'Item', width: 30 }, { header: 'Used', width: 14 },
        { header: 'Estimated cost', type: 'money' }, { header: 'Entries', type: 'number' }],
      rows: summary,
    },
    {
      name: 'Usage detail',
      columns: [{ header: 'Month', width: 9 }, { header: 'CE division', width: 22 }, { header: 'Subsystem', width: 22 }, { header: 'SKU', width: 14 }, { header: 'Item', width: 30 },
        { header: 'Used', type: 'number' }, { header: 'Unit', width: 8 }, { header: 'Estimated cost', type: 'money' }, { header: 'Cost known', width: 10 }, { header: 'By', width: 18 }, { header: 'Project', width: 16 }],
      rows: usage.map((u) => [u.month, u.division_name || (u.use_for === 'general' ? 'General shop' : ''), u.subsystem_name || '', u.sku || '', u.item_name, u.qty, u.unit, u.cost,
        u.cost_known ? 'yes' : 'no', u.used_by || '', u.project || '']),
    },
  ];
}

export const countSheet = (b, count, lines, lotById = new Map()) => ({
  name: 'Count',
  columns: [{ header: 'Location', width: 12 }, { header: 'SKU', width: 14 }, { header: 'Item', width: 30 }, { header: 'Lot', width: 14 }, { header: 'Expected at start', type: 'number' },
    { header: 'System when counted', type: 'number' }, { header: 'Counted', type: 'number' }, { header: 'Difference', type: 'number' }, { header: 'Unit', width: 8 },
    { header: 'Est. value of difference', type: 'money' }, { header: 'Counted by', width: 18 }, { header: 'Note', width: 26 }],
  rows: lines.map((l) => {
    const i = b.itemById.get(l.item_id) || {};
    const diff = l.counted === null || l.counted === undefined ? '' : Number(l.counted) - Number(l.system_qty);
    return [locCode(b, l.location_id), i.sku, i.name, lotById.get(l.lot_id) ? lotLabel(lotById.get(l.lot_id)) : '', l.expected, l.system_qty, l.counted, diff, i.unit,
      diff === '' || !i.unit_cost ? '' : diff * Number(i.unit_cost), l.counted_by_name, l.note];
  }),
});

export const fileDate = today;
