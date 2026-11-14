/**
 * Inventory → Reports: rolling up the usage rows from inventory_usage (one row per division × subsystem × item ×
 * person × project × month, net of returns and undos; transfers aren't use). Pure functions, tested in Node.
 *
 * Each usage row is counted exactly once: in its subsystem if it has one, else as "whole division" use, else as
 * General shop. A division's total is its subsystems' rows plus its whole-division rows, never both twice.
 */

const add = (into, row) => {
  into.qty += Number(row.qty) || 0;
  into.cost += Number(row.cost) || 0;
  into.lines += Number(row.lines) || 0;
  if (row.cost_known === false || row.cost === null || row.cost === undefined) into.costUnknown = true;
  return into;
};
const blank = (extra) => ({ qty: 0, cost: 0, lines: 0, costUnknown: false, ...extra });

/** Items used, summed: [{ key, item_id, sku, name, unit, qty, cost, lines }] biggest cost (then qty) first. */
export function byItem(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.item_id || `direct:${r.item_name}`;
    if (!map.has(key)) map.set(key, blank({ key, item_id: r.item_id || null, sku: r.sku || '', name: r.item_name, unit: r.unit }));
    add(map.get(key), r);
  }
  return [...map.values()].filter((x) => x.qty !== 0 || x.cost !== 0).sort((a, b) => b.cost - a.cost || b.qty - a.qty || a.name.localeCompare(b.name));
}

/**
 * Division → subsystem → items. Returns [{ id, name, cost, lines, costUnknown, items, whole: { items, cost }, subsystems:
 * [{ id, name, cost, items }] }] plus a General shop entry (id 'general') when there is any.
 */
export function rollup(rows) {
  const divisions = new Map();
  const general = { id: 'general', name: 'General shop', rows: [] };
  for (const r of rows) {
    if (!r.division_id) {
      general.rows.push(r);
      continue;
    }
    if (!divisions.has(r.division_id)) divisions.set(r.division_id, { id: r.division_id, name: r.division_name || 'Division', rows: [], whole: [], subs: new Map() });
    const d = divisions.get(r.division_id);
    d.rows.push(r);
    if (r.subsystem_id) {
      if (!d.subs.has(r.subsystem_id)) d.subs.set(r.subsystem_id, { id: r.subsystem_id, name: r.subsystem_name || 'Subsystem', rows: [] });
      d.subs.get(r.subsystem_id).rows.push(r);
    } else d.whole.push(r);
  }
  const total = (list) => list.reduce((s, r) => add(s, r), blank());
  const out = [...divisions.values()].map((d) => {
    const subsystems = [...d.subs.values()].map((s) => ({ id: s.id, name: s.name, ...total(s.rows), items: byItem(s.rows) }))
      .sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
    return { id: d.id, name: d.name, ...total(d.rows), items: byItem(d.rows), whole: { ...total(d.whole), items: byItem(d.whole) }, subsystems };
  }).sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
  if (general.rows.length) out.push({ id: 'general', name: 'General shop', ...total(general.rows), items: byItem(general.rows), whole: { ...total(general.rows), items: byItem(general.rows) }, subsystems: [] });
  return out;
}

/** Sum by any key: groupTotals(rows, (r) => r.used_by || 'Unknown') → [{ key, qty, cost, lines }] biggest cost first. */
export function groupTotals(rows, keyOf) {
  const map = new Map();
  for (const r of rows) {
    const key = keyOf(r);
    if (key === null || key === undefined) continue;
    if (!map.has(key)) map.set(key, blank({ key }));
    add(map.get(key), r);
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost || b.lines - a.lines || String(a.key).localeCompare(String(b.key)));
}

/** Month by month (oldest first), with empty months filled in between: [{ month: '2026-09', cost, lines }]. */
export function byMonth(rows) {
  const totals = groupTotals(rows, (r) => r.month).sort((a, b) => a.key.localeCompare(b.key));
  if (!totals.length) return [];
  const out = [];
  let [y, m] = totals[0].key.split('-').map(Number);
  const last = totals.at(-1).key;
  for (let guard = 0; guard < 240; guard++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const t = totals.find((x) => x.key === key);
    out.push({ month: key, cost: t?.cost || 0, lines: t?.lines || 0, qty: t?.qty || 0 });
    if (key === last) break;
    m += 1;
    if (m > 12) (m = 1), (y += 1);
  }
  return out;
}

/**
 * Suggested count classes by value (on hand × unit cost): the items making up the first 80% of the value are A,
 * the next 15% B, the rest C. Items without a cost are C. Returns { itemId: 'A' | 'B' | 'C' }.
 */
export function suggestClasses(items) {
  const valued = items.map((i) => ({ id: i.id, value: (Number(i.on_hand) || 0) * (Number(i.unit_cost) || 0) })).sort((a, b) => b.value - a.value);
  const total = valued.reduce((s, i) => s + i.value, 0);
  const out = {};
  let running = 0;
  for (const i of valued) {
    if (!total || i.value <= 0) {
      out[i.id] = 'C';
      continue;
    }
    const before = running / total;
    running += i.value;
    out[i.id] = before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C';
  }
  return out;
}
