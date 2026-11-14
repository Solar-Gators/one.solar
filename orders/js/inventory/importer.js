/**
 * Inventory → Setup → Import: reading a shop's existing spreadsheet (CSV or Excel), matching its columns,
 * checking every row before anything is saved, and spotting duplicates. Pure functions (tested in Node:
 * tests/inventoryModules.test.mjs); the page (views/inventory/setup.js) reads the file and sends the rows to
 * inventory_import, which checks everything again and imports all or nothing.
 */

/** The fields a row can fill, with the column names that usually hold them. */
export const IMPORT_FIELDS = [
  { key: 'sku', label: 'SKU / internal part number', match: [/^sku$/i, /internal/i, /^part ?(no\.?|#|number|num)$/i, /^p\/?n$/i] },
  { key: 'name', label: 'Name', required: true, match: [/^(item|part)?\s*name$/i, /^item$/i, /^part$/i, /^description$/i, /name/i] },
  { key: 'description', label: 'Description / notes', match: [/descr/i, /notes?/i, /details/i] },
  { key: 'category', label: 'Category', match: [/categ/i, /^type$/i, /^group$/i] },
  { key: 'qty', label: 'Quantity on hand', match: [/^(qty|quantity)$/i, /on ?hand/i, /^count(ed)?$/i, /qty|quantity|stock/i] },
  { key: 'unit', label: 'Unit', match: [/^units?$/i, /^uom$/i, /unit of measure/i] },
  { key: 'location', label: 'Location code', match: [/^loc(ation)?( code)?$/i, /^bin$/i, /cabinet|shelf|where/i, /location/i] },
  { key: 'manufacturer', label: 'Manufacturer', match: [/^(mfr|mfg|manufacturer|brand|make)$/i, /manufact/i] },
  { key: 'mpn', label: 'Manufacturer part number', match: [/^mpn$/i, /mfr ?(part|p\/n|pn|#)/i, /manufacturer ?(part|p\/n|pn|#)/i] },
  { key: 'supplier', label: 'Supplier', match: [/^(supplier|vendor|source|store)$/i, /supplier|vendor/i] },
  { key: 'supplier_pn', label: 'Supplier part number', match: [/(supplier|vendor|digi-?key|mcmaster|mouser) ?(part|p\/n|pn|#|sku)/i] },
  { key: 'supplier_url', label: 'Supplier link', match: [/^(link|url)$/i, /link|url/i] },
  { key: 'unit_cost', label: 'Unit cost', match: [/unit ?(cost|price)/i, /^(cost|price)$/i, /cost|price/i] },
  { key: 'reorder_point', label: 'Reorder point', match: [/reorder ?(point|level|at)/i, /^min(imum)?( qty| stock)?$/i, /^par$/i] },
  { key: 'reorder_qty', label: 'Reorder quantity', match: [/reorder ?(qty|quantity|amount)/i, /order ?qty/i] },
  { key: 'lot', label: 'Lot / batch', match: [/^lot\b/i, /batch/i] },
  { key: 'expires_on', label: 'Expiry date', match: [/expir/i, /^exp\b/i, /best before|use by/i] },
  { key: 'count_class', label: 'Count class (A/B/C)', match: [/class/i, /^abc$/i] },
];

/**
 * CSV text → { columns, rows: [{ row_number, values: { header: text } }] } (the same shape the Excel reader
 * gives). Quotes, "" inside quotes, CR/LF line ends, a byte-order mark and ; or tab separators are all fine.
 */
export function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => (first.match(new RegExp(ch === '\t' ? '\t' : `\\${ch}`, 'g')) || []).length;
  const sep = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const lines = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) (row.push(cell), (cell = ''));
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      lines.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) (row.push(cell), lines.push(row));
  return tableToSheet(lines);
}

/** A grid of cell texts (first non-empty row = headers) → { columns, rows }. */
export function tableToSheet(grid) {
  const trimmed = grid.map((r) => r.map((c) => String(c ?? '').trim()));
  const headerAt = trimmed.findIndex((r) => r.filter(Boolean).length >= 2);
  if (headerAt < 0) return { columns: [], rows: [] };
  const seen = new Map();
  const columns = trimmed[headerAt].map((h, i) => {
    const base = h || `Column ${i + 1}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base} (${n})` : base;
  });
  const rows = [];
  trimmed.slice(headerAt + 1).forEach((cells, i) => {
    if (!cells.some(Boolean)) return;
    const values = {};
    columns.forEach((c, j) => cells[j] && (values[c] = cells[j]));
    rows.push({ row_number: headerAt + i + 2, values });
  });
  return { columns, rows };
}

/** Guess which column holds each field: { fieldKey: columnName }. Each column is used once. */
export function detectMapping(columns) {
  const used = new Set();
  const map = {};
  // Most specific first, so "Supplier part number" isn't taken as the name or the supplier.
  const order = ['supplier_pn', 'mpn', 'reorder_point', 'reorder_qty', 'unit_cost', 'expires_on', 'sku', 'qty', 'unit', 'location', 'manufacturer',
    'supplier', 'supplier_url', 'category', 'lot', 'count_class', 'name', 'description'];
  for (const key of order) {
    const field = IMPORT_FIELDS.find((f) => f.key === key);
    for (const re of field.match) {
      const col = columns.find((c) => !used.has(c) && re.test(c));
      if (col) {
        map[key] = col;
        used.add(col);
        break;
      }
    }
  }
  return map;
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const UNIT_WORDS = { each: 'ea', pcs: 'ea', pc: 'ea', piece: 'ea', pieces: 'ea', unit: 'ea', units: 'ea', ft: 'ft', feet: 'ft', foot: 'ft',
  meter: 'm', meters: 'm', metre: 'm', metres: 'm', inch: 'in', inches: 'in', gram: 'g', grams: 'g', kilogram: 'kg', pounds: 'lb', lbs: 'lb',
  ounce: 'oz', ounces: 'oz', liter: 'l', liters: 'l', litre: 'l', litres: 'l', milliliter: 'ml', ml: 'ml', gallon: 'gal', gallons: 'gal',
  rolls: 'roll', spools: 'spool', sheets: 'sheet', bottles: 'bottle', cans: 'can', tubes: 'tube', bags: 'bag', boxes: 'box', pairs: 'pair', sets: 'set', kits: 'kit' };

/** "Pieces" → "ea", "Meters" → "m"; unknown text comes back as typed (so the check can say so). */
export function normalizeUnit(text, units = []) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return '';
  if (units.some((u) => u.code === t)) return t;
  const byLabel = units.find((u) => u.label.toLowerCase() === t);
  if (byLabel) return byLabel.code;
  return UNIT_WORDS[t] || UNIT_WORDS[t.replace(/\.$/, '')] || t;
}

/** "$1,234.50" → 1234.5; "" → null; anything else → NaN. */
export function parseNumber(text) {
  const t = String(text ?? '').replace(/[$,\s]/g, '');
  if (t === '') return null;
  return /^-?\d*\.?\d+$/.test(t) ? Number(t) : NaN;
}

/** "3/15/2027", "2027-03-15", an Excel date → "2027-03-15"; '' when blank; null when it isn't a date. */
export function parseDate(text) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

/**
 * The sheet's rows as import rows, checked. ctx: { items (overview), supplierParts, locations, units, categories,
 * createLocations, createCategories }. Each result: { row, values: {field: text}, out (what's sent), errors,
 * warnings, match: { kind: 'sku' | 'new', item }, similar: [items that might be the same] }.
 */
export function checkRows(sheet, mapping, ctx) {
  const units = ctx.units || [];
  const items = ctx.items || [];
  const skuOf = new Map(items.map((i) => [String(i.sku).toUpperCase(), i]));
  const locCodes = new Set((ctx.locations || []).filter((l) => !l.archived_at).map((l) => l.code));
  const cats = new Set((ctx.categories || []).filter((c) => !c.archived_at).map((c) => c.name.toLowerCase()));
  const byMpn = new Map();
  for (const i of items) if (norm(i.mpn).length >= 3) byMpn.set(norm(i.mpn), i);
  const bySpn = new Map();
  for (const sp of ctx.supplierParts || []) if (norm(sp.supplier_pn).length >= 3) bySpn.set(norm(sp.supplier_pn), items.find((i) => i.id === sp.item_id));
  const byName = new Map(items.map((i) => [norm(i.name), i]));
  const seenSku = new Map();

  return sheet.rows.map(({ row_number, values: raw }) => {
    const v = {};
    for (const [key, col] of Object.entries(mapping)) if (col) v[key] = String(raw[col] ?? '').trim();
    const errors = [];
    const warnings = [];
    const sku = (v.sku || '').toUpperCase();
    const existing = sku ? skuOf.get(sku) : null;
    const unit = existing ? existing.unit : normalizeUnit(v.unit, units) || 'ea';
    const unitRow = units.find((u) => u.code === unit);
    const decimals = existing ? Number(existing.decimals) : unitRow && ['count', 'pair', 'set', 'kit'].includes(unitRow.dimension) ? 0 : unitRow?.dimension && !['length', 'mass', 'volume', 'area'].includes(unitRow.dimension) ? 0 : 2;

    if (!existing) {
      if (!v.name) errors.push('A new item needs a name.');
      if (sku && !/^[A-Z0-9][A-Z0-9._/-]{0,31}$/.test(sku)) errors.push(`SKU "${v.sku}" has characters a label can't use.`);
      if (units.length && !unitRow) errors.push(`Unknown unit "${v.unit}".`);
      if (v.category && !cats.has(v.category.toLowerCase()) && !ctx.createCategories) errors.push(`No category called "${v.category}".`);
      if (v.count_class && !/^[ABC]$/i.test(v.count_class)) errors.push('Count class must be A, B or C.');
    } else if (v.unit && normalizeUnit(v.unit, units) !== existing.unit) {
      errors.push(`"${existing.name}" is kept in ${existing.unit}, not ${v.unit}.`);
    }
    const qty = parseNumber(v.qty);
    if (Number.isNaN(qty)) errors.push(`Quantity "${v.qty}" isn't a number.`);
    else if (qty < 0) errors.push('The quantity can\'t be negative.');
    else if (qty !== null && Math.round(qty * 10 ** decimals) / 10 ** decimals !== qty) errors.push(`Quantity ${qty} has more decimal places than the item keeps (${decimals}).`);
    for (const key of ['unit_cost', 'reorder_point', 'reorder_qty']) {
      if (v[key] && Number.isNaN(parseNumber(v[key]))) errors.push(`${IMPORT_FIELDS.find((f) => f.key === key).label} "${v[key]}" isn't a number.`);
    }
    const expires = parseDate(v.expires_on);
    if (expires === null) errors.push(`"${v.expires_on}" isn't a date (use YYYY-MM-DD).`);
    const code = String(v.location || '').trim().toUpperCase().replace(/\s+/g, '-');
    if (qty > 0) {
      if (!code) errors.push('Say where the stock is (a location code).');
      else if (!locCodes.has(code)) {
        if (!ctx.createLocations) errors.push(`No location with the code ${code}.`);
        else if (!/^[A-Z0-9][A-Z0-9._-]{0,23}$/.test(code)) errors.push(`"${v.location}" can't be a location code.`);
        else warnings.push(`Location ${code} will be added.`);
      }
    }
    if (existing && (v.lot || v.expires_on) && !existing.track_lots) errors.push(`"${existing.name}" isn't tracked by lot; turn that on first or leave lot and expiry blank.`);

    // Possible duplicates of a new item: never merged automatically; the person picks.
    const similar = [];
    if (!existing) {
      for (const hit of [byMpn.get(norm(v.mpn)), bySpn.get(norm(v.supplier_pn)), byName.get(norm(v.name))]) if (hit && !similar.includes(hit)) similar.push(hit);
      if (similar.length) warnings.push(`Might already be in the catalog: ${similar.map((s) => `${s.name} (${s.sku})`).join(', ')}.`);
      if (sku) {
        if (seenSku.has(sku) && seenSku.get(sku) !== norm(v.name)) warnings.push(`SKU ${sku} appears earlier with a different name; both rows go to one item.`);
        seenSku.set(sku, norm(v.name));
      }
    }

    const out = {
      row: row_number,
      sku: v.sku || '',
      name: v.name || '',
      description: v.description || '',
      category: v.category || '',
      unit: existing ? '' : unit,
      manufacturer: v.manufacturer || '',
      mpn: v.mpn || '',
      supplier: v.supplier || '',
      supplier_pn: v.supplier_pn || '',
      supplier_url: v.supplier_url || '',
      location: code,
      qty: qty === null || Number.isNaN(qty) ? '' : String(qty),
      lot: v.lot || '',
      expires_on: expires || '',
      unit_cost: v.unit_cost ? String(parseNumber(v.unit_cost)) : '',
      reorder_point: v.reorder_point ? String(parseNumber(v.reorder_point)) : '',
      reorder_qty: v.reorder_qty ? String(parseNumber(v.reorder_qty)) : '',
      count_class: (v.count_class || '').toUpperCase(),
    };
    return { row: row_number, values: v, out, errors, warnings, match: { kind: existing ? 'sku' : 'new', item: existing || null }, similar };
  });
}

/** SHA-256 of a file's bytes (hex), so the same file isn't imported twice by accident. */
export async function fileHash(buffer) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A CSV file's text for a list of rows (header row first). Values with , " or line breaks are quoted. */
export function toCsv(rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}
