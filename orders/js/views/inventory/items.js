/**
 * Inventory → Items: the catalog. Search by name, SKU, manufacturer or supplier part number; filter by category,
 * location, state; download it; print labels for what's shown.
 */
import { esc, takeFlash } from '../../ui.js';
import { inv } from '../../inventory/api.js';
import { locationAndChildren } from '../../inventory/core.js';
import { loadBase, header, needsDatabase, stateChip, qty, itemHref, can, hazardChips } from './kit.js';
import { listBar, bindListBar, setListCount } from '../../listBar.js';
import { bindPeek } from '../../peek.js';
import { downloadWorkbook, catalogSheet, stockSheet, lowStockSheet, fileDate } from './exporting.js';
import { setLabelSelection } from './labels.js';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Does an item match the search? Name words, SKU, manufacturer part number or any supplier part number. */
export function matches(item, q, supplierPns = []) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${item.name} ${item.sku} ${item.manufacturer} ${item.mpn} ${item.description || ''}`.toLowerCase();
  const compact = norm(q);
  if (compact.length >= 3 && [item.sku, item.mpn, ...supplierPns].some((p) => norm(p).includes(compact))) return true;
  return words.every((w) => hay.includes(w));
}

export async function renderInvItems(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  const query = ctx.params.query || new URLSearchParams();
  const [b, parts] = await Promise.all([loadBase(), inv.supplierParts()]);
  const pnsOf = new Map();
  for (const p of parts) pnsOf.set(p.item_id, [...(pnsOf.get(p.item_id) || []), p.supplier_pn]);
  const stockByLoc = query.get('location') ? await inv.stock({ locationIds: locationAndChildren(query.get('location'), b.locations) }) : null;

  const state = { q: query.get('q') || '', category: query.get('category') || '', location: query.get('location') || '', show: query.get('state') || 'active' };
  // The Filter ▾ menu (listBar.js). "Current items" is the default (no filter); the filters live in the page's address.
  const filters = [
    { key: 'category', label: 'Category', all: 'All categories', options: b.categories.filter((c) => !c.archived_at).map((c) => [c.id, c.name]) },
    { key: 'location', label: 'Location', all: 'All locations', options: b.tree.map((l) => [l.id, `${' '.repeat(l.depth)}${l.code}${l.name && l.name !== l.code ? ` · ${l.name}` : ''}`]) },
    { key: 'show', label: 'Show', all: 'Current items', options: [['low', 'Low or out'], ['aside', 'Has set-aside stock'], ['lots', 'Lots to check'], ['hazard', 'Hazardous'], ['due', 'Due for a count'], ['all', 'Everything, with archived']] },
  ];
  const values = { category: state.category, location: state.location, show: state.show === 'active' ? '' : state.show };
  el.innerHTML = `${takeFlash()}${header('Items', 'Everything the shop keeps, and how much of it there is.',
    `${can.receive() ? '<a class="btn btn-primary" href="#/inventory/items/new" data-shortcut="create">Add an item</a>' : ''}
     <button type="button" class="btn" data-download>Download Excel</button><button type="button" class="btn" data-labels>Print labels</button>`)}
    ${listBar({ q: state.q, placeholder: 'Search name, SKU, part number…', filters, values })}
    <div data-list></div>`;

  const lotItems = new Set((b.overview.lots || []).map((l) => l.item_id));
  const list = () => {
    const inLoc = stockByLoc ? new Set(stockByLoc.filter((s) => Number(s.qty) > 0).map((s) => s.item_id)) : null;
    return b.items.filter((i) => {
      if (state.show !== 'all' && i.status === 'archived') return false;
      if (state.category && i.category_id !== state.category) return false;
      if (inLoc && !inLoc.has(i.id)) return false;
      if (state.show === 'low' && !(i.reorder_point !== null ? Number(i.available) <= Number(i.reorder_point) : Number(i.available) <= 0)) return false;
      if (state.show === 'aside' && !(Number(i.quarantined) > 0)) return false;
      if (state.show === 'lots' && !lotItems.has(i.id)) return false;
      if (state.show === 'hazard' && !i.hazardous) return false;
      if (state.show === 'due' && !(i.count_due && Number(i.on_hand) > 0)) return false;
      return matches(i, state.q, pnsOf.get(i.id));
    });
  };
  const draw = () => {
    const rows = list();
    setListCount(el, rows.length, b.items.filter((i) => state.show === 'all' || i.status !== 'archived').length, 'items');
    el.querySelector('[data-list]').innerHTML = rows.length
      ? `<div class="table-wrap"><table class="table inv-items" data-fit>
        <thead><tr><th>Item</th><th>SKU</th><th>Category</th><th class="num">Available</th><th class="num">On hand</th><th class="num">Places</th><th>State</th></tr></thead>
        <tbody>${rows.map((i) => `<tr data-href="${itemHref(i.id)}">
          <td data-label="Item"><a href="${itemHref(i.id)}">${esc(i.name)}</a>${i.status !== 'active' ? ` <span class="chip chip-tone tone-gray">${esc(i.status)}</span>` : ''}${i.hazardous ? ' <span class="inv-hazard-dot" title="Hazardous">⚠</span>' : ''}
            ${i.mpn ? `<div class="muted small">${esc(i.manufacturer)} ${esc(i.mpn)}</div>` : ''}</td>
          <td data-label="SKU" class="mono">${esc(i.sku)}</td>
          <td data-label="Category">${esc(b.categories.find((c) => c.id === i.category_id)?.name || '')}</td>
          <td class="num" data-label="Available">${esc(qty(i.available, i))}</td>
          <td class="num" data-label="On hand">${esc(qty(i.on_hand, i))}${Number(i.quarantined) ? `<div class="muted small">${esc(qty(i.quarantined, i))} set aside</div>` : ''}</td>
          <td class="num" data-label="Places">${i.locations}</td>
          <td data-label="State">${stateChip(i)}</td></tr>`).join('')}</tbody></table></div>`
      : `<p class="empty">${b.items.length ? 'No items match.' : `No items yet.${can.receive() ? ' <a href="#/inventory/items/new">Add the first one</a>' : ''}${can.manage() ? ', or <a href="#/inventory/setup/import">import a spreadsheet</a>' : ''}.`}</p>`;
  };
  draw();

  const setQuery = () => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q: state.q, category: state.category, location: state.location, state: state.show === 'active' ? '' : state.show })) if (v) p.set(k, v);
    history.replaceState(null, '', `#/inventory/items${p.toString() ? `?${p}` : ''}`);
  };
  el.querySelector('[data-list-q]').addEventListener('input', (e) => ((state.q = e.target.value), setQuery(), draw()));
  bindListBar(el, { filters, values, onChange: () => {
    const moved = values.location !== state.location;
    Object.assign(state, { category: values.category, location: values.location, show: values.show || 'active' });
    setQuery();
    if (moved) ctx.rerender(); // needs that location's stock
    else draw();
  } });
  bindPeek(el.querySelector('[data-list]'), { ctx });   // a click opens the item beside the list
  el.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-href]');
    if (row && !e.target.closest('a, button, input')) location.hash = row.dataset.href;
  });
  el.querySelector('[data-download]').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await downloadWorkbook(`inventory-${fileDate()}.xlsx`, [catalogSheet(b, list()), await stockSheet(b), lowStockSheet(b)]);
    } finally {
      e.target.disabled = false;
    }
  });
  el.querySelector('[data-labels]').addEventListener('click', () => {
    setLabelSelection({ items: list().map((i) => i.id) });
    location.hash = '#/inventory/labels';
  });
}

export { hazardChips };
