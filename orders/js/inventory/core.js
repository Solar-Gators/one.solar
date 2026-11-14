/**
 * Inventory: small pure helpers shared by the pages (and tested in Node: tests/inventoryModules.test.mjs).
 * Nothing here talks to the database; the rules that matter are enforced there (migration 050).
 */

/** A new operation id. The database recognises a repeat of the same id, so a double click or retry happens once. */
export function newOpId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 12.5 → "12.5", 1200 → "1,200", null → "". At most `decimals` places (default 4). */
export function fmtNum(n, decimals = 4) {
  if (n === null || n === undefined || n === '') return '';
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return v.toLocaleString('en-US', { maximumFractionDigits: decimals });
}

/** "12.5 m", "3 ea". */
export const fmtQty = (n, unit = '', decimals = 4) => `${fmtNum(n, decimals) || '0'}${unit ? ` ${unit}` : ''}`;

/** Convert between units of the same kind (the units list from the database). null if they don't mix. */
export function convert(qty, from, to, units) {
  const f = units.find((u) => u.code === from);
  const t = units.find((u) => u.code === to);
  if (!f || !t || f.dimension !== t.dimension) return null;
  return (Number(qty) * Number(f.factor)) / Number(t.factor);
}

/** Units an amount of this item can be entered in: its own, then the others of the same kind. */
export const unitsFor = (item, units) => {
  const own = units.find((u) => u.code === item.unit);
  return own ? [own, ...units.filter((u) => u.dimension === own.dimension && u.code !== own.code)] : units.filter((u) => u.code === item.unit);
};

/**
 * Where an item stands against its reorder point, from the overview's numbers:
 *   out      nothing available
 *   low      at or under the reorder point, and what's ordered won't lift it above
 *   covered  at or under the reorder point, but enough is on order (Ordered in Orders: approved isn't ordered)
 *   ok       above it (or no reorder point)
 */
export function stockState(item) {
  const available = Number(item.available) || 0;
  const point = item.reorder_point === null || item.reorder_point === undefined || item.reorder_point === '' ? null : Number(item.reorder_point);
  const onOrder = Number(item.on_order) || 0;
  if (point === null) return available <= 0 && Number(item.on_hand) > 0 ? { key: 'low', label: 'None usable' } : available <= 0 ? { key: 'out', label: 'None in stock' } : { key: 'ok', label: 'In stock' };
  if (available > point) return { key: 'ok', label: 'In stock' };
  if (available + onOrder > point) return { key: 'covered', label: 'Low, more on order' };
  return available <= 0 ? { key: 'out', label: 'Out, reorder' } : { key: 'low', label: 'Low, reorder' };
}

/** How many to order for a low item: its reorder quantity, else enough to get back to twice the reorder point. */
export function suggestedOrder(item) {
  if (Number(item.reorder_qty) > 0) return Number(item.reorder_qty);
  const point = Number(item.reorder_point) || 0;
  const need = point * 2 - (Number(item.available) || 0) - (Number(item.on_order) || 0);
  return Math.max(Math.ceil(need), 1);
}

/** Needs attention on the dashboard: low or out, and not already covered by what's ordered. */
export const needsReorder = (item) => ['low', 'out'].includes(stockState(item).key) && item.reorder_point !== null && item.reorder_point !== undefined;

/** The page addresses a QR label points at. They use the record's id, so renaming or re-coding never breaks a label. */
export function inventoryLink(base, kind, id) {
  const root = String(base).replace(/\/?$/, '/');
  const path = kind === 'location' ? 'locations' : 'items';
  return `${root}inventory/#/inventory/${path}/${encodeURIComponent(id)}`;
}

/** The record a scanned / typed link or code points at: { kind: 'item' | 'location', id } or null. */
export function parseInventoryLink(text) {
  const m = String(text || '').match(/#\/inventory\/(items|locations)\/([0-9a-f-]{36})\b/i);
  return m ? { kind: m[1] === 'locations' ? 'location' : 'item', id: m[2].toLowerCase() } : null;
}

/** "Battery (Powertrain)", "Powertrain (whole division)", "General shop". */
export function useForLabel(row, { divisions = [], subsystems = [] } = {}) {
  const d = divisions.find((x) => x.id === row.division_id);
  const s = subsystems.find((x) => x.id === row.subsystem_id);
  if (row.use_for === 'general' || (!row.division_id && !row.subsystem_id && row.use_for)) return 'General shop';
  if (row.use_for === 'subsystem') return `${s?.name || row.subsystem_name || 'Subsystem'} (${d?.name || row.division_name || 'division'})`;
  if (row.use_for === 'division') return `${d?.name || row.division_name || 'Division'} (whole division)`;
  return '';
}

/** Locations as an indented list: [{ ...location, depth, path: "SHOP › CAB-A" }] in tree order. */
export function locationTree(locations, { includeArchived = false } = {}) {
  const list = locations.filter((l) => includeArchived || !l.archived_at);
  const ids = new Set(list.map((l) => l.id));
  const kids = new Map();
  for (const l of list) {
    const parent = l.parent_id && ids.has(l.parent_id) ? l.parent_id : null;
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(l);
  }
  for (const k of kids.values()) k.sort((a, b) => (a.sort ?? 100) - (b.sort ?? 100) || a.code.localeCompare(b.code));
  const out = [];
  const walk = (parent, depth, path) => {
    for (const l of kids.get(parent) || []) {
      const here = path ? `${path} › ${l.code}` : l.code;
      out.push({ ...l, depth, path: here });
      if (depth < 20) walk(l.id, depth + 1, here);
    }
  };
  walk(null, 0, '');
  return out;
}

/** A location and everything inside it (ids). */
export function locationAndChildren(id, locations) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const l of locations) if (l.parent_id && out.has(l.parent_id) && !out.has(l.id)) (out.add(l.id), (grew = true));
  }
  return [...out];
}

/** A lot's name for people: "L-2024 / can 3". */
export const lotLabel = (lot) => [lot?.lot_code, lot?.container].filter(Boolean).join(' / ') || 'Lot';

/** Lots in the order they should be used: soonest expiry (or retest) first, then oldest received. */
export function firstExpiringFirst(lots) {
  const when = (l) => [l.expires_on, l.retest_on].filter(Boolean).sort()[0] || '9999-12-31';
  return [...lots].sort((a, b) => when(a).localeCompare(when(b)) || String(a.received_on || '').localeCompare(String(b.received_on || '')));
}

/** Why a lot can't be used today ('' if it can). Mirrors the database's inv_lot_problem. */
export function lotProblem(lot, today = new Date().toISOString().slice(0, 10)) {
  if (!lot) return '';
  if (lot.condition && lot.condition !== 'good') return `marked ${lot.condition}`;
  if (lot.expires_on && lot.expires_on < today) return `expired ${lot.expires_on}`;
  if (lot.retest_on && lot.retest_on < today) return `retest was due ${lot.retest_on}`;
  return '';
}

export const HAZARDS = {
  flammable: 'Flammable', oxidizer: 'Oxidizer', corrosive: 'Corrosive', toxic: 'Toxic', health_hazard: 'Health hazard',
  irritant: 'Irritant', compressed_gas: 'Compressed gas', explosive: 'Explosive', environmental: 'Environmental hazard',
  lithium_battery: 'Lithium battery',
};

export const KIND_LABELS = {
  receive: 'Received', consume: 'Used', return: 'Put back', transfer: 'Moved', adjust: 'Corrected', quarantine: 'Set aside / released',
  count: 'Count', import: 'Imported', direct_use: 'Used on arrival',
};
export const OP_LABELS = {
  receive: 'Received', consume: 'Used', return: 'Put back', transfer: 'Moved', adjust: 'Corrected', quarantine: 'Set aside',
  release: 'Released', reverse: 'Undone', count: 'Count applied', import: 'Imported', order_receipt: 'Received from Orders',
};
