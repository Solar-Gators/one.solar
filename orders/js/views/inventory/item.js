/**
 * One item: big quick-action buttons at the top (this is where a scanned label lands), where it is, its lots,
 * suppliers, details and safety information, its label, its history (with Undo) and every change to its record.
 */
import { esc, fmtDate, fmtDateTime, fmtMoney, takeFlash, setFlash } from '../../ui.js';
import { inv } from '../../inventory/api.js';
import { HAZARDS } from '../../inventory/core.js';
import { loadBase, invalidate, header, needsDatabase, stateChip, hazardChips, qty, locHref, locLabel, can, actionsFor, stockDialog,
  formDialog, lotLabel, lotProblem, firstExpiringFirst } from './kit.js';
import { loadHistory, historyList, bindUndo } from './history.js';
import { labelHtml, setLabelSelection } from './labels.js';

export async function renderInvItem(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  const id = ctx.params.id;
  const [b, item, stock, lots, parts, prefs, history, audit, receipts] = await Promise.all([
    loadBase(), inv.item(id), inv.stock({ itemId: id }), inv.lots(id), inv.supplierParts(id), inv.myPrefs().catch(() => null),
    loadHistory({ itemId: id }, 60), inv.audit(id).catch(() => []), inv.receipts({ itemId: id }).catch(() => []),
  ]);
  if (!item) {
    el.innerHTML = `<section class="card no-access"><h1>Item not found</h1><p>It may have been removed, or the label is from somewhere else.</p>
      <a class="btn" href="#/inventory/items">All items</a></section>`;
    return;
  }
  const totals = b.itemById.get(id) || { ...item, on_hand: 0, available: 0, quarantined: 0, on_order: 0 };
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const here = stock.filter((s) => Number(s.qty) > 0).sort((a, c) => locLabel(b, a.location_id).localeCompare(locLabel(b, c.location_id)));
  const category = b.categories.find((c) => c.id === item.category_id);
  const actions = actionsFor(item);
  const lastCount = totals.last_counted ? fmtDate(totals.last_counted) : 'never';

  el.innerHTML = `${takeFlash()}<div data-result></div>${header(esc(item.name),
    `<span class="mono">${esc(item.sku)}</span>${item.mpn ? ` · ${esc(item.manufacturer)} ${esc(item.mpn)}` : ''}${category ? ` · ${esc(category.name)}` : ''}
     ${item.status !== 'active' ? ` <span class="chip chip-tone tone-gray">${esc(item.status)}</span>` : ''}`,
    `${can.manage() ? `<a class="btn" href="#/inventory/items/${esc(id)}/edit">Edit</a>` : ''}<button type="button" class="btn" data-print-label>Print label</button>`)}
    ${item.hazardous ? `<div class="alert alert-warning inv-safety"><strong>Hazardous.</strong> ${hazardChips(item.hazard_classes)}
      ${item.storage_notes ? `<div>Storage: ${esc(item.storage_notes)}</div>` : ''}${item.sds_url ? `<div><a href="${esc(item.sds_url)}" target="_blank" rel="noopener">Safety data sheet (SDS)</a></div>` : ''}
      <div class="small">This complements UF's official hazardous-material inventory and safety procedures; it doesn't replace them.</div></div>` : ''}

    <div class="inv-summary">
      <div class="inv-big"><span class="fin-tile-label">Available</span><strong>${esc(qty(totals.available, item))}</strong>${stateChip(totals)}</div>
      <div><span class="fin-tile-label">On hand</span><strong>${esc(qty(totals.on_hand, item))}</strong>${Number(totals.quarantined) ? `<span class="muted small">${esc(qty(totals.quarantined, item))} set aside</span>` : ''}${Number(totals.unusable) ? `<span class="muted small">${esc(qty(totals.unusable, item))} in expired lots</span>` : ''}</div>
      <div><span class="fin-tile-label">On order</span><strong>${esc(qty(totals.on_order, item))}</strong>${Number(totals.requested) ? `<span class="muted small">${esc(qty(totals.requested, item))} requested, not ordered yet</span>` : ''}</div>
      <div><span class="fin-tile-label">Reorder at</span><strong>${item.reorder_point === null ? '—' : esc(qty(item.reorder_point, item))}</strong><span class="muted small">Class ${esc(item.count_class)} · counted ${esc(lastCount)}</span></div>
    </div>

    ${actions.length ? `<div class="inv-actions">${actions.map(([k, l]) => `<button type="button" class="btn ${k === 'use' ? 'btn-primary' : ''} btn-lg" data-act="${k}">${esc(l)}</button>`).join('')}</div>` : ''}

    <section class="card"><div class="card-head"><h2>Where it is</h2></div>
      ${here.length ? `<div class="table-wrap"><table class="table" data-fit><thead><tr><th>Location</th>${item.track_lots ? '<th>Lot</th><th>Expires</th>' : ''}<th>Status</th><th class="num">Quantity</th><th></th></tr></thead><tbody>
        ${here.map((s) => {
          const lot = lotById.get(s.lot_id);
          const problem = lotProblem(lot);
          return `<tr><td data-label="Location"><a href="${locHref(s.location_id)}">${esc(locLabel(b, s.location_id))}</a></td>
            ${item.track_lots ? `<td data-label="Lot">${lot ? esc(lotLabel(lot)) : '—'}</td><td data-label="Expires">${lot?.expires_on ? esc(lot.expires_on) : '—'}${problem ? ` <span class="chip chip-tone tone-red">${esc(problem)}</span>` : ''}</td>` : ''}
            <td data-label="Status">${s.status === 'quarantine' ? '<span class="chip chip-tone tone-amber">Set aside</span>' : 'Available'}</td>
            <td class="num" data-label="Quantity"><strong>${esc(qty(s.qty, item))}</strong></td>
            <td class="nowrap">${s.status === 'available' && can.use() && !problem ? `<button type="button" class="btn btn-sm" data-act="use" data-loc="${esc(s.location_id)}" data-lot="${esc(s.lot_id || '')}">Use</button>` : ''}
              ${can.receive() ? `<button type="button" class="btn btn-sm btn-ghost" data-act="move" data-loc="${esc(s.location_id)}" data-lot="${esc(s.lot_id || '')}" data-status="${esc(s.status)}">Move</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>` : `<p class="empty">None in stock.${can.receive() ? ' Use Receive to add some.' : ''}</p>`}
    </section>

    ${item.track_lots || lots.length ? `<section class="card"><div class="card-head"><h2>Lots</h2></div>
      ${lots.length ? `<div class="table-wrap"><table class="table" data-fit><thead><tr><th>Lot</th><th>Received</th><th>Opened</th><th>Expires</th><th>Retest</th><th>Condition</th><th></th></tr></thead><tbody>
        ${firstExpiringFirst(lots).map((l) => `<tr><td data-label="Lot">${esc(lotLabel(l))}</td><td data-label="Received">${esc(l.received_on || '—')}</td><td data-label="Opened">${esc(l.opened_on || '—')}</td>
          <td data-label="Expires">${esc(l.expires_on || '—')}</td><td data-label="Retest">${esc(l.retest_on || '—')}</td>
          <td data-label="Condition">${l.condition === 'good' && !lotProblem(l) ? 'Good' : `<span class="chip chip-tone tone-red">${esc(lotProblem(l) || l.condition)}</span>`}</td>
          <td>${can.setAside() ? `<button type="button" class="btn btn-sm btn-ghost" data-lot-edit="${esc(l.id)}">Edit</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
        <p class="muted small">Use the lot that expires first. Expired, damaged or suspect lots can't be used or released until their dates or condition are fixed.</p>` : '<p class="empty">No lots yet: each receipt asks for its lot.</p>'}
    </section>` : ''}

    <div class="two-col">
      <section class="card"><div class="card-head"><h2>Details</h2></div>
        <dl class="meta-grid">
          <dt>Unit</dt><dd>${esc(item.unit)}${item.decimals ? ` (to ${item.decimals} decimal place${item.decimals === 1 ? '' : 's'})` : ' (whole numbers)'}</dd>
          <dt>Usual place</dt><dd>${item.default_location_id ? `<a href="${locHref(item.default_location_id)}">${esc(locLabel(b, item.default_location_id))}</a>` : '—'}</dd>
          <dt>Reorder</dt><dd>${item.reorder_point === null ? 'No reorder point' : `at ${esc(qty(item.reorder_point, item))}${item.reorder_qty ? `, order ${esc(qty(item.reorder_qty, item))}` : ''}`}</dd>
          <dt>Unit cost</dt><dd>${item.unit_cost === null ? '—' : `${fmtMoney(item.unit_cost)} per ${esc(item.unit)} (estimate)`}</dd>
          ${!item.hazardous && item.storage_notes ? `<dt>Storage</dt><dd>${esc(item.storage_notes)}</dd>` : ''}
          ${Object.entries(item.specs || {}).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
        </dl>
        ${item.description ? `<p class="pre-wrap">${esc(item.description)}</p>` : ''}
        ${item.image_url ? `<img class="inv-photo" src="${esc(item.image_url)}" alt="${esc(item.name)}" loading="lazy">` : ''}
      </section>
      <section class="card"><div class="card-head"><h2>Suppliers</h2>${can.receive() ? '<button type="button" class="btn btn-sm" data-supplier="">Add</button>' : ''}</div>
        ${parts.length ? `<ul class="plain-list">${parts.map((p) => `<li>${p.preferred ? '<span class="chip chip-tone tone-green">Preferred</span> ' : ''}<strong>${esc(p.supplier)}</strong>
          ${p.supplier_pn ? `<span class="mono">${esc(p.supplier_pn)}</span>` : ''}${Number(p.pack_qty) !== 1 ? ` · pack of ${esc(qty(p.pack_qty, item))}${p.pack_label ? ` (${esc(p.pack_label)})` : ''}` : ''}
          ${p.last_price !== null ? ` · ${fmtMoney(p.last_price)}` : ''}${p.url ? ` · <a href="${esc(p.url)}" target="_blank" rel="noopener">link</a>` : ''}
          ${can.manage() ? ` <button type="button" class="link-btn" data-supplier="${esc(p.id)}">edit</button>` : ''}</li>`).join('')}</ul>` : '<p class="empty">No suppliers yet.</p>'}
        <div class="inv-label-preview">${labelHtml({ kind: 'item', id, title: item.name, code: item.sku }, 'small')}</div>
      </section>
    </div>

    ${receipts.some((r) => r.order_ref) ? `<section class="card"><div class="card-head"><h2>From Orders</h2></div><ul class="plain-list">
      ${receipts.filter((r) => r.order_ref).map((r) => `<li>${esc(r.order_ref)} · ${esc(r.line_name)} · ${esc(qty(r.qty || r.qty_order, item))} ${r.destination === 'direct' ? 'used on arrival' : 'received'} ${esc(fmtDate(r.received_on))}${r.reversed_at ? ' <span class="chip chip-tone tone-gray">undone</span>' : ''}</li>`).join('')}</ul></section>` : ''}

    <section class="card"><div class="card-head"><h2>History</h2><a class="btn btn-sm btn-ghost" href="#/inventory/activity?item=${esc(id)}">All</a></div>
      <div data-history>${historyList(history.groups, b)}</div></section>

    <details class="card inv-changes"><summary><h2>Changes to this item's record</h2></summary>
      ${audit.length ? `<ul class="plain-list small">${audit.map((a) => `<li><strong>${esc(a.action)}</strong> by ${esc(a.actor_name || 'someone')} · ${esc(fmtDateTime(a.created_at))}
        <span class="muted">${esc(Object.keys(a.changes || {}).filter((k) => k !== 'id').join(', '))}</span></li>`).join('')}</ul>` : '<p class="empty">No changes recorded.</p>'}</details>`;

  const reopen = (result, message) => {
    invalidate();
    if (message) setFlash(message);
    ctx.rerender();
  };
  el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      const kind = act.dataset.act;
      const res = await stockDialog(kind, b, { item, stock, lots, prefs: prefs || {}, locationId: act.dataset.loc || '', lotId: act.dataset.lot || '', status: act.dataset.status });
      if (res) reopen(res, `${{ use: 'Taken out', return: 'Put back', receive: 'Received', move: 'Moved', setaside: 'Set aside', release: 'Released', correct: 'Corrected' }[kind]}. ${item.name}: ${qty(res.available, item)} available now.${res.replay ? ' (It was already saved.)' : ''}`);
      return;
    }
    if (e.target.closest('[data-print-label]')) {
      setLabelSelection({ items: [id] });
      location.hash = '#/inventory/labels';
      return;
    }
    const sup = e.target.closest('[data-supplier]');
    if (sup) {
      const p = parts.find((x) => x.id === sup.dataset.supplier) || { pack_qty: 1 };
      const saved = await formDialog({
        title: p.id ? 'Edit supplier' : 'Add a supplier',
        body: `<div class="form-grid">
          <div class="field span-2"><label for="s-sup">Supplier</label><input id="s-sup" name="supplier" required maxlength="80" value="${esc(p.supplier || '')}"></div>
          <div class="field span-2"><label for="s-pn">Their part number</label><input id="s-pn" name="supplier_pn" maxlength="80" value="${esc(p.supplier_pn || '')}"></div>
          <div class="field span-2"><label for="s-pack">One unit they sell holds (${esc(item.unit)})</label><input id="s-pack" name="pack_qty" type="number" min="0" step="any" value="${esc(p.pack_qty)}"><div class="hint">1 unless it comes in packs (a box of 100 → 100).</div></div>
          <div class="field span-2"><label for="s-plabel">Pack name <span class="muted">(optional)</span></label><input id="s-plabel" name="pack_label" maxlength="40" value="${esc(p.pack_label || '')}" placeholder="box of 100"></div>
          <div class="field span-2"><label for="s-price">Price per pack</label><input id="s-price" name="last_price" type="number" min="0" step="any" value="${esc(p.last_price ?? '')}"></div>
          <div class="field span-2"><label for="s-url">Link</label><input id="s-url" name="url" type="url" maxlength="500" value="${esc(p.url || '')}" placeholder="https://"></div>
        </div><label class="inline-check"><input type="checkbox" name="preferred" ${p.preferred || !parts.length ? 'checked' : ''}> Preferred supplier (used when starting an Orders request)</label>
        ${p.id && can.manage() ? '<p><button type="button" class="link-btn danger-link" data-remove>Remove this supplier</button></p>' : ''}`,
      onOpen: (f) => f.querySelector('[data-remove]')?.addEventListener('click', async () => {
          await inv.deleteSupplierPart(p.id);
          f.closest('dialog').close();
          reopen(null, 'Supplier removed.');
        }),
        onSubmit: (f) => inv.saveSupplierPart(p.id || null, id, { supplier: f.supplier.value, supplier_pn: f.supplier_pn.value, pack_qty: f.pack_qty.value || 1,
          pack_label: f.pack_label.value, last_price: f.last_price.value || null, url: f.url.value.trim(), preferred: f.preferred.checked }),
      });
      if (saved) reopen(saved, 'Supplier saved.');
      return;
    }
    const lotBtn = e.target.closest('[data-lot-edit]');
    if (lotBtn) {
      const l = lotById.get(lotBtn.dataset.lotEdit);
      const saved = await formDialog({
        title: `Lot ${esc(lotLabel(l))}`,
        body: `<div class="form-grid">
          <div class="field span-2"><label for="lt-code">Lot / batch</label><input id="lt-code" name="lot_code" maxlength="60" value="${esc(l.lot_code)}"></div>
          <div class="field span-2"><label for="lt-box">Container</label><input id="lt-box" name="container" maxlength="60" value="${esc(l.container)}"></div>
          <div class="field span-2"><label for="lt-rec">Received</label><input id="lt-rec" name="received_on" type="date" value="${esc(l.received_on || '')}"></div>
          <div class="field span-2"><label for="lt-open">Opened</label><input id="lt-open" name="opened_on" type="date" value="${esc(l.opened_on || '')}"></div>
          <div class="field span-2"><label for="lt-exp">Expires</label><input id="lt-exp" name="expires_on" type="date" value="${esc(l.expires_on || '')}"></div>
          <div class="field span-2"><label for="lt-ret">Retest by</label><input id="lt-ret" name="retest_on" type="date" value="${esc(l.retest_on || '')}"></div>
          <div class="field span-2"><label for="lt-cond">Condition</label><select id="lt-cond" name="condition">${['good', 'suspect', 'damaged', 'expired'].map((c) => `<option ${c === l.condition ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
          <div class="field span-2"><label for="lt-notes">Notes</label><input id="lt-notes" name="notes" maxlength="500" value="${esc(l.notes)}"></div>
        </div><p class="hint">Changing the dates after a retest is how an expired lot becomes usable again (then release it if it was set aside).</p>`,
        onSubmit: (f) => inv.saveLot(l.id, Object.fromEntries(['lot_code', 'container', 'received_on', 'opened_on', 'expires_on', 'retest_on', 'condition', 'notes'].map((k) => [k, f[k].value]))),
      });
      if (saved) reopen(saved, 'Lot saved.');
    }
  });
  bindUndo(el, () => reopen(null, ''));
  void HAZARDS;
}
