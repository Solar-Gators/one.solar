/**
 * Receive: what's been ordered in Orders and not all here yet, line by line. Each line can be received in part
 * (6 of 10 now, 4 later), into stock at a location, straight to a subsystem (used on arrival, never in stock), or
 * as "not an inventory item" (a service, a one-off). A line not linked to the catalog is linked first: the
 * suggestion is only ever an exact part-number match. Plus a manual receive for things that didn't come
 * through Orders (donations, found stock).
 *
 *   #/inventory/receive                     every ordered, open line
 *   #/inventory/receive/RSG-0042            one request's lines
 *   #/inventory/receive?location=<id>       manual receive, into that location
 */
import { esc, fmtDate, fmtMoney, takeFlash, setFlash } from '../../ui.js';
import { inv } from '../../inventory/api.js';
import { fmtNum } from '../../inventory/core.js';
import { loadBase, invalidate, header, needsDatabase, can, qty, itemHref, locationOptions, attributionFields, bindAttribution, formDialog, stockDialog,
  firstExpiringFirst, lotLabel } from './kit.js';
import { matches } from './items.js';

const requestHref = (id) => `../orders/#/requests/${encodeURIComponent(id)}`;

export async function renderInvReceive(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  if (!can.receive()) {
    el.innerHTML = '<section class="card no-access"><h1>Receiving needs "Receive & move stock"</h1><p>Ask an inventory manager or an Admin.</p></section>';
    return;
  }
  const number = ctx.params.id;
  const query = ctx.params.query || new URLSearchParams();
  const b = await loadBase();
  let request = null;
  if (number) {
    request = await inv.requestByNumber(number);
    if (!request) {
      el.innerHTML = `<section class="card no-access"><h1>No request ${esc(number)}</h1><a class="btn" href="#/inventory/receive">Everything to receive</a></section>`;
      return;
    }
  }
  const [lines, prefs] = await Promise.all([inv.orderLines(request?.id || null, false), inv.myPrefs().catch(() => null)]);
  const open = request ? lines : lines.filter((l) => Number(l.outstanding) > 0);
  const groups = new Map();
  for (const l of open) {
    if (!groups.has(l.request_id)) groups.set(l.request_id, { ...l, lines: [] });
    groups.get(l.request_id).lines.push(l);
  }
  const receivable = (l) => ['Ordered', 'Received'].includes(l.status);

  el.innerHTML = `${takeFlash()}${header(request ? `Receive ${esc(request.request_number)}` : 'Receive',
    request ? `${esc(request.title)} · ${esc(request.status)}` : 'Deliveries from Orders that aren\'t all here yet. Receive what arrived, even part of a line.',
    `<button type="button" class="btn" data-manual>Receive something else</button>${request ? '<a class="btn btn-ghost" href="#/inventory/receive">Everything to receive</a>' : ''}`)}
    <form class="inv-find" data-find role="search"><input type="search" name="n" placeholder="Request number, e.g. RSG-0042" aria-label="Request number" value="${esc(number || '')}"><button class="btn" type="submit">Open</button></form>
    ${request && !['Ordered', 'Received'].includes(request.status) ? `<div class="alert alert-warning">${esc(request.request_number)} is "${esc(request.status)}". Only ordered requests can be received: approved isn't ordered until the Treasurer marks it Ordered.</div>` : ''}
    ${groups.size ? [...groups.values()].map((g) => `<section class="card inv-receive-req">
      <div class="card-head"><h2><a href="${requestHref(g.request_id)}">${esc(g.request_number)}</a> · ${esc(g.title)}</h2>
        <span class="muted small">${esc(g.status)}${g.ordered_on ? ` · ordered ${esc(fmtDate(g.ordered_on))}` : ''}${g.subsystem ? ` · ${esc(g.subsystem)}` : ''}</span></div>
      <div class="table-wrap"><table class="table" data-fit><thead><tr><th>Line</th><th class="num">Ordered</th><th class="num">Received</th><th>Catalog item</th><th></th></tr></thead><tbody>
      ${g.lines.map((l) => {
        const done = Number(l.outstanding) <= 0;
        return `<tr data-line="${esc(l.line_id)}" class="${done ? 'is-done' : ''}">
          <td data-label="Line"><strong>${esc(l.item_name || 'Item')}</strong>${l.part_number ? ` <span class="mono small">${esc(l.part_number)}</span>` : ''}
            <div class="muted small">${esc(l.vendor || '')}${l.unit_price !== null ? ` · ${fmtMoney(l.unit_price)} each` : ''}</div></td>
          <td class="num" data-label="Ordered">${esc(fmtNum(l.quantity))}</td>
          <td class="num" data-label="Received">${esc(fmtNum(l.received))}${done ? ' <span class="chip chip-tone tone-green">all here</span>' : ''}</td>
          <td data-label="Catalog item">${l.link ? `<a href="${itemHref(l.link.item_id)}">${esc(l.link.name)}</a>${Number(l.link.units_per) !== 1 ? ` <span class="muted small">(1 ordered = ${esc(fmtNum(l.link.units_per))} ${esc(l.link.unit)})</span>` : ''}
              <button type="button" class="link-btn small" data-link="${esc(l.line_id)}">change</button>`
            : l.suggest?.length ? `<span class="muted small">Same part number:</span> ${l.suggest.map((s) => `<button type="button" class="btn btn-sm" data-use-suggest="${esc(l.line_id)}" data-item="${esc(s.item_id)}" data-per="${esc(s.pack_qty)}">${esc(s.name)} (${esc(s.sku)})</button>`).join(' ')}
              <button type="button" class="link-btn small" data-link="${esc(l.line_id)}">another</button>`
            : `<button type="button" class="btn btn-sm" data-link="${esc(l.line_id)}">Link to an item</button>`}</td>
          <td class="nowrap">${!done && receivable(l) ? `<button type="button" class="btn btn-sm btn-primary" data-receive="${esc(l.line_id)}">Receive</button>` : ''}</td></tr>`;
      }).join('')}</tbody></table></div></section>`).join('')
    : `<p class="empty">${request ? 'This request has no lines.' : 'Nothing ordered is waiting to be received.'} ${request ? '' : 'Requests show up here once the Treasurer marks them Ordered.'}</p>`}`;

  const lineById = new Map(open.map((l) => [l.line_id, l]));
  const reload = (msg) => {
    invalidate();
    if (msg) setFlash(msg);
    ctx.rerender();
  };

  el.querySelector('[data-find]').addEventListener('submit', (e) => {
    e.preventDefault();
    const n = e.target.n.value.trim().toUpperCase();
    location.hash = n ? `#/inventory/receive/${encodeURIComponent(n)}` : '#/inventory/receive';
  });

  el.addEventListener('click', async (e) => {
    const sug = e.target.closest('[data-use-suggest]');
    if (sug) {
      await linkDialog(b, lineById.get(sug.dataset.useSuggest), { itemId: sug.dataset.item, per: sug.dataset.per }) && reload('Linked.');
      return;
    }
    const link = e.target.closest('[data-link]');
    if (link) {
      await linkDialog(b, lineById.get(link.dataset.link)) && reload('Linked.');
      return;
    }
    const rec = e.target.closest('[data-receive]');
    if (rec) {
      const res = await receiveLineDialog(b, lineById.get(rec.dataset.receive), prefs || {});
      if (res) reload(`Received. ${fmtNum(res.received)} of this line here${Number(res.outstanding) ? `, ${fmtNum(res.outstanding)} still to come` : ', all of it'}.${res.request_status === 'Received' ? ' The request is now Received in Orders.' : ''}${res.replay ? ' (It was already saved.)' : ''}`);
      return;
    }
    if (e.target.closest('[data-manual]')) {
      const res = await manualReceive(b, prefs || {}, query.get('location') || '');
      if (res) reload(`Received. ${res.name}: ${qty(res.available, res.item)} available now.`);
    }
  });
  if (query.get('location') && !number) el.querySelector('[data-manual]').click();
}

/** Link an Orders line to a catalog item (or add one), with how many of its units one ordered unit holds. */
async function linkDialog(b, line, { itemId = '', per = '' } = {}) {
  const items = b.items.filter((i) => i.status !== 'archived');
  return formDialog({
    title: `Link "${esc(line.item_name)}"`,
    wide: true,
    body: `<p class="muted small">${esc(line.vendor || '')}${line.part_number ? ` · part number <span class="mono">${esc(line.part_number)}</span>` : ''}${line.product_link ? ` · <a href="${esc(line.product_link)}" target="_blank" rel="noopener">product page</a>` : ''}</p>
      <div class="field"><label for="k-q">Find the catalog item</label><input id="k-q" type="search" data-q placeholder="Name, SKU, part number" autocomplete="off" value="${esc(itemId ? '' : line.part_number || '')}"></div>
      <div class="field"><label for="k-item">Item</label><select id="k-item" name="item" required size="6" data-items></select>
        <div class="hint">Not in the catalog? <a href="#/inventory/items/new?name=${encodeURIComponent(line.item_name || '')}&mpn=${encodeURIComponent(line.part_number || '')}" target="_blank" rel="noopener">Add it</a> (opens a new tab), then search again.</div></div>
      <div class="field"><label for="k-per">One ordered unit holds</label><div class="inv-amount"><input id="k-per" name="per" type="number" min="0" step="any" required value="${esc(per || line.link?.units_per || 1)}"><span data-unit></span></div>
        <div class="hint">1 unless the order is in packs: a box of 100 screws → 100; a 25 ft spool when you track feet → 25.</div></div>`,
    submit: 'Link',
    onOpen: (f) => {
      const sel = f.querySelector('[data-items]');
      const draw = () => {
        const q = f.querySelector('[data-q]').value;
        const list = items.filter((i) => matches(i, q)).slice(0, 80);
        const keep = sel.value || itemId || line.link?.item_id || '';
        sel.innerHTML = list.map((i) => `<option value="${esc(i.id)}" ${i.id === keep ? 'selected' : ''}>${esc(i.name)} · ${esc(i.sku)} (${esc(i.unit)})</option>`).join('');
        if (keep && !list.some((i) => i.id === keep) && b.itemById.get(keep)) sel.insertAdjacentHTML('afterbegin', `<option value="${esc(keep)}" selected>${esc(b.itemById.get(keep).name)}</option>`);
        unit();
      };
      const unit = () => (f.querySelector('[data-unit]').textContent = b.itemById.get(sel.value)?.unit || '');
      f.querySelector('[data-q]').addEventListener('input', draw);
      sel.addEventListener('change', unit);
      draw();
    },
    onSubmit: (f) => {
      if (!f.item.value) throw new Error('Pick an item.');
      return inv.linkOrderLine(line.line_id, f.item.value, Number(f.per.value)).then(() => true);
    },
  });
}

/** Receive part or all of a line. */
async function receiveLineDialog(b, line, prefs) {
  const item = line.link ? b.itemById.get(line.link.item_id) : null;
  const lots = item?.track_lots ? await inv.lots(item.id) : [];
  const per = Number(line.link?.units_per || 1);
  return formDialog({
    title: `Receive ${esc(line.item_name)}`,
    body: `<p class="muted small">${esc(line.request_number)} · ${esc(fmtNum(line.quantity))} ordered, ${esc(fmtNum(line.received))} received, <strong>${esc(fmtNum(line.outstanding))} still to come</strong></p>
      <div class="field"><label for="r-qty">How many arrived <span class="muted">(as ordered)</span></label>
        <input id="r-qty" name="qty" type="number" min="0" step="any" required value="${esc(fmtNum(line.outstanding))}" inputmode="decimal">
        <div class="hint" data-conv></div></div>
      <fieldset class="inv-fieldset"><legend>Where it goes</legend>
        <label class="inline-check"><input type="radio" name="dest" value="stock" ${item ? 'checked' : 'disabled'}> Into stock${item ? '' : ' (link it to an item first)'}</label>
        <label class="inline-check"><input type="radio" name="dest" value="direct" ${item ? '' : 'checked'}> Straight to a subsystem (used on arrival, never on a shelf)</label>
        <label class="inline-check"><input type="radio" name="dest" value="non_inventory"> Not an inventory item (a service, a one-off)</label>
      </fieldset>
      <fieldset class="inv-plain" data-stock>
        <div class="field"><label for="r-loc">Location</label><select id="r-loc" name="location_id">${locationOptions(b, item?.default_location_id || '')}</select></div>
        ${item?.track_lots ? `<fieldset class="inv-lot-fields"><legend>Lot</legend>
          <div class="field"><label for="r-lot">Lot</label><select id="r-lot" name="lot_id"><option value="">A new lot…</option>${firstExpiringFirst(lots).map((l) => `<option value="${esc(l.id)}">${esc(lotLabel(l))}</option>`).join('')}</select></div>
          <div class="form-grid" data-newlot>
            <div class="field span-2"><label for="r-lotcode">Lot / batch number</label><input id="r-lotcode" name="lot_code" maxlength="60"></div>
            <div class="field span-2"><label for="r-box">Container</label><input id="r-box" name="container" maxlength="60"></div>
            <div class="field span-2"><label for="r-exp">Expires</label><input id="r-exp" name="expires_on" type="date"></div>
            <div class="field span-2"><label for="r-ret">Retest by</label><input id="r-ret" name="retest_on" type="date"></div>
          </div></fieldset>` : ''}
        <label class="inline-check"><input type="checkbox" name="quarantine"> Set it aside (damaged or to inspect): not usable until released</label>
      </fieldset>
      <fieldset class="inv-plain" data-direct hidden>${attributionFields(b, prefs, { prefix: 'rcv' })}
        <div class="field"><label for="r-proj">Project <span class="muted">(optional)</span></label><input id="r-proj" name="project" maxlength="120"></div></fieldset>
      <div class="field"><label for="r-date">Arrived on</label><input id="r-date" name="date" type="date"></div>
      <div class="field" data-over hidden><label for="r-over">Why more than ordered?</label><input id="r-over" name="over_reason" maxlength="500" placeholder="e.g. supplier sent an extra pack">
        <div class="hint">Only an inventory manager can record an over-delivery.</div></div>
      <div class="field"><label for="r-note">Note <span class="muted">(optional)</span></label><input id="r-note" name="note" maxlength="500"></div>`,
    submit: 'Receive',
    onOpen: (f) => {
      const readAttr = bindAttribution(f, b, prefs, { prefix: 'rcv' });
      f._readAttr = readAttr;
      const sync = () => {
        const dest = f.dest.value;
        for (const [sel, on] of [['[data-stock]', dest === 'stock'], ['[data-direct]', dest === 'direct']]) {
          const box = f.querySelector(sel);
          box.hidden = !on;
          box.disabled = !on; // what's hidden isn't checked or sent
        }
        const n = Number(f.qty.value) || 0;
        f.querySelector('[data-over]').hidden = !(n > Number(line.outstanding));
        f.querySelector('[data-conv]').textContent = item && per !== 1 && dest !== 'non_inventory' ? `= ${qty(n * per, item)}` : '';
      };
      f.addEventListener('input', sync);
      f.addEventListener('change', sync);
      const nl = f.querySelector('[data-newlot]');
      if (nl) f.lot_id.addEventListener('change', () => (nl.hidden = !!f.lot_id.value));
      sync();
    },
    onSubmit: (f, op) => {
      const dest = f.dest.value;
      const p = { line_id: line.line_id, qty: Number(f.qty.value), destination: dest, date: f.date.value, note: f.note.value, over_reason: f.over_reason.value };
      if (dest === 'stock') {
        if (!f.location_id.value) throw new Error('Pick where it goes.');
        Object.assign(p, { location_id: f.location_id.value, quarantine: f.quarantine.checked });
        if (item?.track_lots) Object.assign(p, f.lot_id.value ? { lot_id: f.lot_id.value } : { lot: { lot_code: f.lot_code.value.trim(), container: f.container.value.trim(), expires_on: f.expires_on.value, retest_on: f.retest_on.value } });
      } else if (dest === 'direct') {
        const att = f._readAttr();
        if (!att.use_for) throw new Error('Say what it\'s for: a CE division (and subsystem), or General shop.');
        Object.assign(p, att, { project: f.project.value });
      }
      return inv.receiveOrder(op, p);
    },
  });
}

/** Receive something that didn't come through Orders: pick the item, then the usual Receive dialog. */
async function manualReceive(b, prefs, locationId) {
  const items = b.items.filter((i) => i.status !== 'archived');
  const picked = await formDialog({
    title: 'Receive something else',
    body: `<p class="muted small">For stock that didn't come through Orders: a donation, a sample, stock found on a shelf. Orders deliveries are received from their line above, so the request stays up to date.</p>
      <div class="field"><label for="m-q">Find the item</label><input id="m-q" type="search" data-q autocomplete="off" placeholder="Name, SKU, part number"></div>
      <div class="field"><select name="item" size="8" aria-label="Item" data-items required></select>
        <div class="hint">Not in the catalog? <a href="#/inventory/items/new">Add it first</a>.</div></div>`,
    submit: 'Next',
    onOpen: (f) => {
      const sel = f.querySelector('[data-items]');
      const draw = () => (sel.innerHTML = items.filter((i) => matches(i, f.querySelector('[data-q]').value)).slice(0, 100)
        .map((i) => `<option value="${esc(i.id)}">${esc(i.name)} · ${esc(i.sku)}</option>`).join(''));
      f.querySelector('[data-q]').addEventListener('input', draw);
      draw();
    },
    onSubmit: (f) => {
      if (!f.item.value) throw new Error('Pick an item.');
      return f.item.value;
    },
  });
  if (!picked) return null;
  const item = b.itemById.get(picked);
  const [stock, lots] = await Promise.all([inv.stock({ itemId: item.id }), item.track_lots ? inv.lots(item.id) : []]);
  const res = await stockDialog('receive', b, { item, stock, lots, prefs, locationId: locationId || item.default_location_id || '' });
  return res ? { ...res, item, name: item.name } : null;
}
