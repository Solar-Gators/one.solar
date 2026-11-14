/**
 * Inventory's first page: what needs attention (low stock, deliveries to receive, lots expiring, counts due), the
 * quick ways in (scan a label, find an item), and what happened lately.
 */
import { esc, fmtMoney, takeFlash } from '../../ui.js';
import { needsReorder, suggestedOrder, lotLabel } from '../../inventory/core.js';
import { loadBase, header, needsDatabase, stateChip, qty, itemHref, can, formDialog } from './kit.js';
import { loadHistory, historyList, bindUndo } from './history.js';
import { startRestockRequests } from './restock.js';

const tile = (label, value, note, href, bad = false) => `<a class="fin-tile inv-tile ${bad ? 'is-bad' : ''}" href="${href}">
  <span class="fin-tile-label">${esc(label)}</span><strong>${value}</strong>${note ? `<span class="muted small">${esc(note)}</span>` : ''}</a>`;

export async function renderInvDashboard(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  const b = await loadBase({ fresh: true });
  const items = b.items.filter((i) => i.status !== 'archived');
  const low = items.filter(needsReorder);
  const covered = items.filter((i) => i.reorder_point !== null && Number(i.available) <= Number(i.reorder_point) && !needsReorder(i));
  const value = items.reduce((s, i) => s + (Number(i.on_hand) || 0) * (Number(i.unit_cost) || 0), 0);
  const due = items.filter((i) => i.count_due && Number(i.on_hand) > 0);
  const lots = b.overview.lots || [];
  const history = await loadHistory({}, 15);

  el.innerHTML = `${takeFlash()}<div data-made></div>${header('Inventory', `${items.length} item${items.length === 1 ? '' : 's'} · about ${fmtMoney(value)} on the shelves`,
    `<a class="btn" href="#/inventory/scan">Scan a label</a>${can.receive() ? '<a class="btn btn-primary" href="#/inventory/receive">Receive</a>' : ''}`)}
    <form class="inv-find" data-find role="search">
      <input type="search" name="q" placeholder="Find an item: name, SKU, part number…" aria-label="Find an item" autocomplete="off">
      <button class="btn" type="submit">Find</button>
    </form>
    <div class="fin-tiles">
      ${tile('Low or out', low.length, covered.length ? `${covered.length} more already ordered` : 'at or under their reorder point', '#/inventory/items?state=low', low.length > 0)}
      ${tile('Deliveries to receive', b.overview.waitingLines || 0, 'ordered lines not here yet', can.receive() ? '#/inventory/receive' : '#/inventory/items')}
      ${tile('Lots to check', lots.length, 'expired, expiring or not good', '#/inventory/items?state=lots', lots.some((l) => l.problem))}
      ${tile('Due for a count', due.length, 'by their count class', '#/inventory/counts')}
    </div>

    <section class="card">
      <div class="card-head"><h2>Needs reordering</h2>${low.length ? '<button type="button" class="btn btn-sm btn-primary" data-restock>Start an Orders request</button>' : ''}</div>
      ${low.length ? `<p class="muted small">Only stock that's ordered counts as coming; requests not ordered yet are shown but don't cover the gap.</p>
      <div class="table-wrap"><table class="table" data-fit><thead><tr><th><input type="checkbox" data-all aria-label="Select all" checked></th><th>Item</th><th class="num">Available</th><th class="num">Reorder at</th><th class="num">On order</th><th class="num">Suggested</th><th>State</th></tr></thead><tbody>
        ${low.map((i) => `<tr><td data-label=""><input type="checkbox" data-pick="${esc(i.id)}" checked aria-label="Include ${esc(i.name)}"></td>
          <td data-label="Item"><a href="${itemHref(i.id)}">${esc(i.name)}</a> <span class="muted small">${esc(i.sku)}</span></td>
          <td class="num" data-label="Available">${esc(qty(i.available, i))}</td><td class="num" data-label="Reorder at">${esc(qty(i.reorder_point, i))}</td>
          <td class="num" data-label="On order">${esc(qty(i.on_order, i))}${Number(i.requested) ? `<div class="muted small">${esc(qty(i.requested, i))} requested, not ordered</div>` : ''}</td>
          <td class="num" data-label="Suggested">${esc(qty(suggestedOrder(i), i))}</td><td data-label="State">${stateChip(i)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="empty">Nothing is below its reorder point.</p>'}
    </section>

    ${lots.length ? `<section class="card"><div class="card-head"><h2>Lots to check</h2></div><ul class="plain-list inv-lot-alerts">
      ${lots.map((l) => {
        const item = b.itemById.get(l.item_id);
        return `<li><a href="${itemHref(l.item_id)}">${esc(item?.name || 'Item')}</a> · lot ${esc(l.lot || lotLabel(l))} · ${esc(qty(l.qty, item))}
          <span class="chip chip-tone tone-${l.problem ? 'red' : 'amber'}">${esc(l.problem || `expires ${l.expires_on || l.retest_on}`)}</span></li>`;
      }).join('')}</ul></section>` : ''}

    <section class="card">
      <div class="card-head"><h2>Recently</h2><a class="btn btn-sm btn-ghost" href="#/inventory/activity">All activity</a></div>
      <div data-history>${historyList(history.groups, b, { showItem: true, empty: 'Nothing yet. Add items, then receive stock into them.' })}</div>
    </section>`;

  el.querySelector('[data-find]').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    location.hash = `#/inventory/items${q ? `?q=${encodeURIComponent(q)}` : ''}`;
  });
  el.querySelector('[data-all]')?.addEventListener('change', (e) => el.querySelectorAll('[data-pick]').forEach((c) => (c.checked = e.target.checked)));
  el.querySelector('[data-restock]')?.addEventListener('click', async () => {
    const picked = low.filter((i) => el.querySelector(`[data-pick="${CSS.escape(i.id)}"]`)?.checked);
    if (!picked.length) return;
    const made = await formDialog({
      title: 'Start an Orders request',
      body: `<p>This makes a <strong>draft</strong> request in Orders for ${picked.length} item${picked.length === 1 ? '' : 's'} (one draft per supplier),
        filled in from each item's preferred supplier. Check it, then submit it for approval as usual. Nothing is bought until it's approved and ordered.</p>`,
      submit: 'Make the draft',
      onSubmit: () => startRestockRequests(picked),
    });
    if (!made) return;
    el.querySelector('[data-made]').innerHTML = `<div class="alert alert-success" role="status">Draft request${made.length === 1 ? '' : 's'} made:
      ${made.map((m) => `<a href="${esc(m.href)}">${esc(m.number)}</a> (${esc(m.supplier)}, ${m.lines} item${m.lines === 1 ? '' : 's'})`).join(', ')}.
      Open ${made.length === 1 ? 'it' : 'each'} to check and submit it.</div>`;
  });
  bindUndo(el, ctx.rerender);
}
