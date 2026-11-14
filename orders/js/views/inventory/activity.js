/**
 * Activity: every stock change, newest first, filtered by item, location, kind and dates, with Undo where
 * allowed and an Excel download of the whole range. History is permanent: an undo is a new entry.
 */
import { esc, takeFlash } from '../../ui.js';
import { KIND_LABELS } from '../../inventory/core.js';
import { loadBase, header, needsDatabase, locationOptions } from './kit.js';
import { loadHistory, historyList, bindUndo } from './history.js';
import { downloadWorkbook, historySheet, fileDate } from './exporting.js';

const PAGE = 100;

export async function renderInvActivity(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  const query = ctx.params.query || new URLSearchParams();
  const f = { itemId: query.get('item') || '', locationId: query.get('location') || '', kind: query.get('kind') || '', from: query.get('from') || '', to: query.get('to') || '' };
  const limit = Number(query.get('n')) || PAGE;
  const b = await loadBase();
  const history = await loadHistory(Object.fromEntries(Object.entries(f).filter(([, v]) => v)), limit);
  const items = b.items.filter((i) => i.status !== 'archived' || i.id === f.itemId);

  el.innerHTML = `${takeFlash()}${header('Activity', 'Every change to stock. Nothing is ever deleted: an undo is a new entry that puts it back.',
    '<button type="button" class="btn" data-download>Download Excel</button>')}
    <form class="toolbar inv-filters" data-filters>
      <select name="item" aria-label="Item"><option value="">All items</option>${items.map((i) => `<option value="${esc(i.id)}" ${i.id === f.itemId ? 'selected' : ''}>${esc(i.name)} (${esc(i.sku)})</option>`).join('')}</select>
      <select name="location" aria-label="Location">${locationOptions(b, f.locationId, { blank: 'All locations' })}</select>
      <select name="kind" aria-label="What"><option value="">Everything</option>${Object.entries(KIND_LABELS).map(([k, l]) => `<option value="${k}" ${k === f.kind ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <label class="inline-field">From <input type="date" name="from" value="${esc(f.from)}"></label>
      <label class="inline-field">To <input type="date" name="to" value="${esc(f.to)}"></label>
      <button class="btn" type="submit">Show</button>
    </form>
    <section class="card">${historyList(history.groups, b, { showItem: true, empty: 'Nothing matches.' })}
      ${history.movements.length >= limit ? `<p><a class="btn btn-ghost" href="${esc(href({ ...f, n: limit + PAGE }))}">Show more</a></p>` : ''}</section>`;

  el.querySelector('[data-filters]').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = e.target;
    location.hash = href({ itemId: t.item.value, locationId: t.location.value, kind: t.kind.value, from: t.from.value, to: t.to.value });
  });
  el.querySelector('[data-download]').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await downloadWorkbook(`inventory-history-${fileDate()}.xlsx`, [await historySheet(b, { from: f.from, to: f.to })]);
    } finally {
      e.target.disabled = false;
    }
  });
  bindUndo(el, ctx.rerender);
}

function href({ itemId, locationId, kind, from, to, n }) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ item: itemId, location: locationId, kind, from, to, n })) if (v) p.set(k, v);
  return `#/inventory/activity${p.toString() ? `?${p}` : ''}`;
}
