/**
 * One location (a scanned cabinet or bin label lands here): what's in it and in the places inside it, with Use /
 * Move buttons per line, its sub-locations, and its history.
 */
import { esc, takeFlash, setFlash } from '../../ui.js';
import { inv } from '../../inventory/api.js';
import { locationAndChildren } from '../../inventory/core.js';
import { loadBase, invalidate, header, needsDatabase, qty, itemHref, locHref, locLabel, can, stockDialog, lotLabel, lotProblem } from './kit.js';
import { loadHistory, historyList, bindUndo } from './history.js';
import { labelHtml, setLabelSelection } from './labels.js';

export async function renderInvLocation(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  const id = ctx.params.id;
  const b = await loadBase();
  const loc = b.locById.get(id);
  if (!loc) {
    el.innerHTML = `<section class="card no-access"><h1>Location not found</h1><p>It may have been removed, or the label is from somewhere else.</p>
      <a class="btn" href="#/inventory/setup/locations">All locations</a></section>`;
    return;
  }
  const ids = locationAndChildren(id, b.locations);
  const [stock, history, prefs] = await Promise.all([inv.stock({ locationIds: ids }), loadHistory({ locationId: id }, 40), inv.myPrefs().catch(() => null)]);
  const lotIds = [...new Set(stock.map((s) => s.lot_id).filter(Boolean))];
  const lots = lotIds.length ? (await inv.allLots()).filter((l) => lotIds.includes(l.id)) : [];
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const rows = stock.filter((s) => Number(s.qty) > 0)
    .map((s) => ({ ...s, item: b.itemById.get(s.item_id) }))
    .filter((s) => s.item)
    .sort((a, c) => a.item.name.localeCompare(c.item.name));
  const children = b.tree.filter((l) => l.parent_id === id);
  const parentChain = [];
  for (let p = b.locById.get(loc.parent_id); p; p = b.locById.get(p.parent_id)) parentChain.unshift(p);

  el.innerHTML = `${takeFlash()}${header(`${esc(loc.code)}${loc.name !== loc.code ? ` · ${esc(loc.name)}` : ''}`,
    `${parentChain.map((p) => `<a href="${locHref(p.id)}">${esc(p.code)}</a> › `).join('')}${esc(loc.kind)}${loc.archived_at ? ' · <span class="chip chip-tone tone-gray">archived</span>' : ''}`,
    `<button type="button" class="btn" data-print-label>Print label</button>${can.manage() ? '<a class="btn" href="#/inventory/setup/locations">Edit locations</a>' : ''}
     <a class="btn" href="#/inventory/items?location=${esc(id)}">As a list</a>`)}
    ${loc.restrictions ? `<div class="alert alert-warning"><strong>Only for:</strong> ${esc(loc.restrictions)}</div>` : ''}
    ${loc.description ? `<p>${esc(loc.description)}</p>` : ''}
    ${children.length ? `<p class="inv-children">Inside: ${children.map((c) => `<a class="chip" href="${locHref(c.id)}">${esc(c.code)}</a>`).join(' ')}</p>` : ''}
    <section class="card"><div class="card-head"><h2>What's here</h2>${can.receive() ? '<a class="btn btn-sm" href="#/inventory/receive?location=' + esc(id) + '">Receive here</a>' : ''}</div>
      ${rows.length ? `<div class="table-wrap"><table class="table" data-fit><thead><tr><th>Item</th>${ids.length > 1 ? '<th>Place</th>' : ''}<th>Lot</th><th class="num">Quantity</th><th></th></tr></thead><tbody>
        ${rows.map((s) => {
          const lot = lotById.get(s.lot_id);
          const problem = lotProblem(lot);
          return `<tr><td data-label="Item"><a href="${itemHref(s.item_id)}">${esc(s.item.name)}</a> <span class="muted small mono">${esc(s.item.sku)}</span>
              ${s.status === 'quarantine' ? ' <span class="chip chip-tone tone-amber">Set aside</span>' : ''}</td>
            ${ids.length > 1 ? `<td data-label="Place">${s.location_id === id ? 'here' : `<a href="${locHref(s.location_id)}">${esc(locLabel(b, s.location_id))}</a>`}</td>` : ''}
            <td data-label="Lot">${lot ? `${esc(lotLabel(lot))}${problem ? ` <span class="chip chip-tone tone-red">${esc(problem)}</span>` : ''}` : '—'}</td>
            <td class="num" data-label="Quantity"><strong>${esc(qty(s.qty, s.item))}</strong></td>
            <td class="nowrap">${s.status === 'available' && can.use() && !problem ? `<button type="button" class="btn btn-sm btn-primary" data-act="use" data-item="${esc(s.item_id)}" data-loc="${esc(s.location_id)}" data-lot="${esc(s.lot_id || '')}">Use</button>` : ''}
              ${can.receive() ? `<button type="button" class="btn btn-sm btn-ghost" data-act="move" data-item="${esc(s.item_id)}" data-loc="${esc(s.location_id)}" data-lot="${esc(s.lot_id || '')}" data-status="${esc(s.status)}">Move</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>` : '<p class="empty">Nothing is here.</p>'}
    </section>
    <section class="card"><div class="card-head"><h2>History here</h2><a class="btn btn-sm btn-ghost" href="#/inventory/activity?location=${esc(id)}">All</a></div>
      ${historyList(history.groups, b, { showItem: true })}</section>
    <div class="inv-label-preview">${labelHtml({ kind: 'location', id, title: loc.name || loc.code, code: loc.code }, 'small')}</div>`;

  el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      const item = b.itemById.get(act.dataset.item);
      const [itemStock, itemLots] = await Promise.all([inv.stock({ itemId: item.id }), item.track_lots ? inv.lots(item.id) : []]);
      const res = await stockDialog(act.dataset.act, b, { item, stock: itemStock, lots: itemLots, prefs: prefs || {}, locationId: act.dataset.loc, lotId: act.dataset.lot, status: act.dataset.status });
      if (res) {
        invalidate();
        setFlash(`${act.dataset.act === 'use' ? 'Taken out' : 'Moved'}. ${item.name}: ${qty(res.available, item)} available now.`);
        ctx.rerender();
      }
      return;
    }
    if (e.target.closest('[data-print-label]')) {
      setLabelSelection({ locations: [id] });
      location.hash = '#/inventory/labels';
    }
  });
  bindUndo(el, ctx.rerender);
}
