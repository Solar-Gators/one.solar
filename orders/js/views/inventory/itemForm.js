/**
 * Add or edit an item. While typing a name or part number, items that look the same show up underneath so the
 * catalog doesn't end up with two of one thing; the database refuses an exact part-number or name match
 * unless "this is a different item" is ticked (OS412).
 */
import { esc, setFlash } from '../../ui.js';
import { inv } from '../../inventory/api.js';
import { HAZARDS } from '../../inventory/core.js';
import { loadBase, invalidate, header, needsDatabase, can, itemHref, locationOptions } from './kit.js';

const field = (id, label, input, hint = '', span = 'span-2') =>
  `<div class="field ${span}"><label for="${id}">${label}</label>${input}${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;

export async function renderInvItemForm(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  const id = ctx.params.id;
  if (id ? !can.manage() : !can.receive()) {
    el.innerHTML = `<section class="card no-access"><h1>You can't ${id ? 'edit items' : 'add items'}</h1>
      <p>${id ? 'Editing items needs "Manage inventory".' : 'Adding items needs "Receive & move stock" or "Manage inventory".'} Ask an inventory manager or an Admin.</p></section>`;
    return;
  }
  const [b, item] = await Promise.all([loadBase(), id ? inv.item(id) : null]);
  if (id && !item) {
    el.innerHTML = '<section class="card no-access"><h1>Item not found</h1></section>';
    return;
  }
  const query = ctx.params.query || new URLSearchParams();
  const it = item || { name: query.get('name') || '', mpn: query.get('mpn') || '', manufacturer: '', unit: 'ea', decimals: 0, status: 'active', count_class: 'C',
    specs: {}, hazard_classes: [], default_location_id: '', category_id: '', reorder_point: null, reorder_qty: null, unit_cost: null };
  const units = b.units;
  const specs = Object.entries(it.specs || {});

  el.innerHTML = `${header(id ? `Edit ${esc(it.name)}` : 'Add an item', id ? `<span class="mono">${esc(it.sku)}</span>` : 'One entry per kind of thing the shop keeps. Quantities come from receiving it.')}
    <form class="card" data-form novalidate>
      <div class="inv-dialog-error" data-error aria-live="polite"></div>
      <div class="form-grid">
        ${field('i-name', 'Name', `<input id="i-name" name="name" required maxlength="120" value="${esc(it.name)}" autocomplete="off">`, 'What people call it, e.g. "M3×8 socket head cap screw".', 'span-4')}
        ${field('i-sku', 'SKU <span class="muted">(optional)</span>', `<input id="i-sku" name="sku" maxlength="32" value="${esc(it.sku || '')}" class="mono" placeholder="made for you">`, 'Leave empty for INV-00001 style.')}
        ${field('i-cat', 'Category', `<select id="i-cat" name="category_id"><option value="">None</option>${b.categories.filter((c) => !c.archived_at || c.id === it.category_id).map((c) => `<option value="${esc(c.id)}" ${c.id === it.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`)}
        ${field('i-mfr', 'Manufacturer', `<input id="i-mfr" name="manufacturer" maxlength="120" value="${esc(it.manufacturer)}">`)}
        ${field('i-mpn', 'Manufacturer part number', `<input id="i-mpn" name="mpn" maxlength="80" value="${esc(it.mpn)}" class="mono" autocomplete="off">`)}
        ${field('i-unit', 'Unit', `<select id="i-unit" name="unit">${units.map((u) => `<option value="${esc(u.code)}" ${u.code === it.unit ? 'selected' : ''}>${esc(u.code)} · ${esc(u.name)}</option>`).join('')}</select>`,
          id ? 'Fixed once it has history.' : 'How you count it: each, metres, grams…')}
        ${field('i-dec', 'Decimal places', `<input id="i-dec" name="decimals" type="number" min="0" max="4" value="${esc(it.decimals)}">`, '0 for things you count whole.')}
        ${field('i-loc', 'Usual place', `<select id="i-loc" name="default_location_id">${locationOptions(b, it.default_location_id || '', { blank: 'None' })}</select>`)}
        ${field('i-status', 'Status', `<select id="i-status" name="status">${[['active', 'Active'], ['discontinued', 'Discontinued (use up, don\'t reorder)'], ['archived', 'Archived (hidden)']].map(([v, l]) => `<option value="${v}" ${v === it.status ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
        ${field('i-rp', 'Reorder point', `<input id="i-rp" name="reorder_point" type="number" min="0" step="any" value="${esc(it.reorder_point ?? '')}">`, 'Shows as low at or under this. Empty: never.')}
        ${field('i-rq', 'Reorder quantity', `<input id="i-rq" name="reorder_qty" type="number" min="0" step="any" value="${esc(it.reorder_qty ?? '')}">`)}
        ${field('i-cost', 'Unit cost (estimate)', `<input id="i-cost" name="unit_cost" type="number" min="0" step="any" value="${esc(it.unit_cost ?? '')}">`, 'Per unit above. Used for usage reports.')}
        ${field('i-class', 'Count class', `<select id="i-class" name="count_class">${['A', 'B', 'C'].map((c) => `<option ${c === it.count_class ? 'selected' : ''}>${c}</option>`).join('')}</select>`,
          `A every ${esc(b.settings.countDays?.A ?? 30)} days, B ${esc(b.settings.countDays?.B ?? 90)}, C ${esc(b.settings.countDays?.C ?? 180)}.`)}
        ${field('i-desc', 'Description', `<textarea id="i-desc" name="description" rows="2" maxlength="2000">${esc(it.description || '')}</textarea>`, '', 'span-4')}
        ${field('i-img', 'Photo link <span class="muted">(optional)</span>', `<input id="i-img" name="image_url" type="url" maxlength="500" value="${esc(it.image_url || '')}" placeholder="https://">`, '', 'span-4')}
      </div>
      <div data-matches aria-live="polite"></div>

      <fieldset class="inv-fieldset"><legend>Specifications <span class="muted">(optional)</span></legend>
        <div data-specs>${(specs.length ? specs : [['', '']]).map(([k, v]) => specRow(k, v)).join('')}</div>
        <button type="button" class="btn btn-sm btn-ghost" data-add-spec>Add a specification</button></fieldset>

      <fieldset class="inv-fieldset"><legend>Lots and safety</legend>
        <label class="inline-check"><input type="checkbox" name="track_lots" ${it.track_lots ? 'checked' : ''}> Track lots (batch numbers, expiry dates): epoxies, resins, adhesives, chemicals, cells</label>
        <label class="inline-check"><input type="checkbox" name="hazardous" ${it.hazardous ? 'checked' : ''}> Hazardous material</label>
        <div class="inv-hazard-pick">${Object.entries(HAZARDS).map(([k, l]) => `<label class="inline-check"><input type="checkbox" name="hz" value="${k}" ${(it.hazard_classes || []).includes(k) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>
        <div class="form-grid">
          ${field('i-sds', 'Safety data sheet (SDS) link', `<input id="i-sds" name="sds_url" type="url" maxlength="500" value="${esc(it.sds_url || '')}" placeholder="https://">`, '', 'span-4')}
          ${field('i-store', 'Storage notes', `<input id="i-store" name="storage_notes" maxlength="500" value="${esc(it.storage_notes || '')}" placeholder="e.g. flammables cabinet, keep below 25 °C">`, '', 'span-4')}
        </div></fieldset>

      ${id ? '' : `<fieldset class="inv-fieldset"><legend>Where you buy it <span class="muted">(optional)</span></legend><div class="form-grid">
        ${field('i-sup', 'Supplier', '<input id="i-sup" name="supplier" maxlength="80" placeholder="e.g. McMaster-Carr">')}
        ${field('i-spn', 'Their part number', '<input id="i-spn" name="supplier_pn" maxlength="80" class="mono" autocomplete="off">')}
        ${field('i-pack', 'One unit they sell holds', '<input id="i-pack" name="pack_qty" type="number" min="0" step="any" value="1">', 'A box of 100 → 100.')}
        ${field('i-price', 'Price per pack', '<input id="i-price" name="last_price" type="number" min="0" step="any">')}
        ${field('i-url', 'Link', '<input id="i-url" name="url" type="url" maxlength="500" placeholder="https://">', '', 'span-4')}
      </div></fieldset>`}
      ${field('i-notes', 'Notes', `<textarea id="i-notes" name="notes" rows="2" maxlength="2000">${esc(it.notes || '')}</textarea>`, '', '')}
      <label class="inline-check" data-dup-box hidden><input type="checkbox" name="confirm_duplicate"> This is a different item from the ones listed above</label>
      <div class="form-actions"><a class="btn btn-ghost" href="${id ? itemHref(id) : '#/inventory/items'}">Cancel</a><button class="btn btn-primary" type="submit">${id ? 'Save' : 'Add item'}</button></div>
    </form>`;

  const form = el.querySelector('[data-form]');
  el.querySelector('[data-add-spec]').addEventListener('click', () => el.querySelector('[data-specs]').insertAdjacentHTML('beforeend', specRow('', '')));
  el.querySelector('[data-specs]').addEventListener('click', (e) => e.target.closest('[data-del-spec]')?.closest('.inv-spec').remove());
  form.querySelectorAll('[name="hz"]').forEach((c) => c.addEventListener('change', () => {
    if (c.checked) form.hazardous.checked = true;
  }));

  // Look-alikes, as they type.
  let timer;
  let seq = 0;
  const lookup = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = ++seq;
      const p = { name: form.name.value, mpn: form.mpn.value, supplier_pn: form.supplier_pn?.value || '', exclude_id: id || '' };
      if (!p.name.trim() && !p.mpn.trim() && !p.supplier_pn.trim()) return (el.querySelector('[data-matches]').innerHTML = '');
      const found = await inv.findMatches(p).catch(() => []);
      if (mine !== seq) return;
      el.querySelector('[data-matches]').innerHTML = found.length
        ? `<div class="alert alert-warning inv-matches"><strong>Already in the catalog?</strong><ul class="plain-list">${found.slice(0, 6).map((m) => `<li><a href="${itemHref(m.id)}" target="_blank" rel="noopener">${esc(m.name)}</a>
            <span class="mono small">${esc(m.sku)}</span> <span class="muted small">${esc(m.reasons.join(', '))}</span></li>`).join('')}</ul></div>`
        : '';
      el.querySelector('[data-dup-box]').hidden = id || !found.some((m) => m.reasons.some((r) => /^Same (manufacturer|supplier|name)/.test(r)));
    }, 300);
  };
  ['name', 'mpn', 'supplier_pn'].forEach((n) => form[n]?.addEventListener('input', lookup));
  if (!id && (it.name || it.mpn)) lookup();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = el.querySelector('[data-error]');
    err.innerHTML = '';
    const specsObj = {};
    el.querySelectorAll('.inv-spec').forEach((row) => {
      const [k, v] = row.querySelectorAll('input');
      if (k.value.trim()) specsObj[k.value.trim()] = v.value.trim();
    });
    const f = form;
    const p = {
      name: f.name.value, sku: f.sku.value, category_id: f.category_id.value, manufacturer: f.manufacturer.value, mpn: f.mpn.value, unit: f.unit.value,
      decimals: f.decimals.value, default_location_id: f.default_location_id.value, status: f.status.value, reorder_point: f.reorder_point.value,
      reorder_qty: f.reorder_qty.value, unit_cost: f.unit_cost.value, count_class: f.count_class.value, description: f.description.value,
      image_url: f.image_url.value.trim(), specs: specsObj, track_lots: f.track_lots.checked, hazardous: f.hazardous.checked,
      hazard_classes: [...f.querySelectorAll('[name="hz"]:checked')].map((c) => c.value), sds_url: f.sds_url.value.trim(), storage_notes: f.storage_notes.value,
      notes: f.notes.value, confirm_duplicate: f.confirm_duplicate.checked,
    };
    if (!id && f.supplier.value.trim()) p.supplier = { supplier: f.supplier.value, supplier_pn: f.supplier_pn.value, pack_qty: f.pack_qty.value || 1, last_price: f.last_price.value, url: f.url.value.trim() };
    if (!p.name.trim()) return (err.innerHTML = '<div class="alert alert-error">Give the item a name.</div>');
    const btn = f.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      const saved = await inv.saveItem(id || null, p);
      invalidate();
      setFlash(id ? 'Item saved.' : `Added. ${can.receive() ? 'Use Receive to put stock in.' : ''}`);
      location.hash = itemHref(saved);
    } catch (ex) {
      err.innerHTML = `<div class="alert alert-error" role="alert">${esc(ex.message)}</div>`;
      if (ex.duplicate) el.querySelector('[data-dup-box]').hidden = false;
      err.scrollIntoView({ block: 'center' });
    } finally {
      btn.disabled = false;
    }
  });
}

function specRow(k, v) {
  return `<div class="inv-spec"><input aria-label="Specification" placeholder="e.g. Thread" maxlength="60" value="${esc(k)}"><input aria-label="Value" placeholder="e.g. M3 × 0.5" maxlength="200" value="${esc(v)}">
    <button type="button" class="btn btn-sm btn-ghost" data-del-spec aria-label="Remove">✕</button></div>`;
}
