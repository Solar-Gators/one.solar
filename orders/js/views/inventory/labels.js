/**
 * Inventory → labels: QR labels for items and locations, one or a whole sheet, printed from the browser.
 * Each code holds the one.solar address of the item or location (by id), so it still works after a rename, and any
 * phone camera opens it: the page then offers Use / Receive / Put back / Move.
 */
import { esc } from '../../ui.js';
import { appUrl } from '../../../../shared/onesolar.js';
import { inventoryLink, locationTree } from '../../inventory/core.js';
import { qrSvg } from '../../inventory/qr.js';
import { loadBase, header, needsDatabase } from './kit.js';

const KEY = 'inv-labels';
/** Which labels the Labels page should show: { items: [ids], locations: [ids] }. */
export function setLabelSelection(sel) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(sel));
  } catch {
    window.__invLabels = sel; // storage blocked: keep it for this page
  }
}
function getSelection() {
  try {
    return JSON.parse(sessionStorage.getItem(KEY)) || window.__invLabels || {};
  } catch {
    return window.__invLabels || {};
  }
}

/** The address a label points at, on this site (one.ufsolargators.org on the live site). */
export const labelUrl = (kind, id) => inventoryLink(appUrl(''), kind, id);

/** One label's HTML. */
export function labelHtml({ kind, id, title, code, line = '' }, size = 'medium') {
  return `<figure class="inv-label inv-label-${size}">
    ${qrSvg(labelUrl(kind, id), { title: `${title} (${code})` })}
    <figcaption><strong>${esc(title)}</strong><span class="mono">${esc(code)}</span>${line ? `<span class="inv-label-line">${esc(line)}</span>` : ''}</figcaption>
  </figure>`;
}

export async function renderInvLabels(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  const b = await loadBase();
  const sel = getSelection();
  const state = { size: 'medium', desc: true, items: new Set(sel.items || []), locations: new Set(sel.locations || []) };

  el.innerHTML = `${header('Print labels', 'QR codes open the item or location in one.solar from any phone camera. Print on plain paper or label sheets, then cut.',
    '<button type="button" class="btn btn-primary" data-print>Print</button>')}
    <div class="card no-print inv-label-setup">
      <div class="form-grid">
        <div class="field"><label for="l-size">Size</label><select id="l-size" data-size>
          <option value="small">Small (bins: 1 inch)</option><option value="medium" selected>Medium (2 inch)</option><option value="large">Large (cabinets: 3 inch)</option></select></div>
        <label class="inline-check field"><input type="checkbox" data-desc checked> Short description on item labels</label>
      </div>
      <details><summary>Choose items and locations (${state.items.size + state.locations.size} chosen)</summary>
        <div class="two-col inv-label-pick">
          <div><h3>Items</h3><input type="search" data-filter placeholder="Filter" aria-label="Filter items">
            <ul class="plain-list inv-pick-list">${b.items.filter((i) => i.status !== 'archived').map((i) => `<li data-name="${esc(`${i.name} ${i.sku}`.toLowerCase())}"><label><input type="checkbox" data-item="${esc(i.id)}" ${state.items.has(i.id) ? 'checked' : ''}> ${esc(i.name)} <span class="muted small">${esc(i.sku)}</span></label></li>`).join('')}</ul></div>
          <div><h3>Locations</h3><ul class="plain-list inv-pick-list">${locationTree(b.locations).map((l) => `<li><label style="padding-left:${l.depth}em"><input type="checkbox" data-loc="${esc(l.id)}" ${state.locations.has(l.id) ? 'checked' : ''}> ${esc(l.code)} <span class="muted small">${esc(l.name)}</span></label></li>`).join('')}</ul></div>
        </div></details>
    </div>
    <div class="inv-label-sheet" data-sheet></div>`;

  const draw = () => {
    const labels = [
      ...b.tree.filter((l) => state.locations.has(l.id)).map((l) => ({ kind: 'location', id: l.id, title: l.name || l.code, code: l.code, line: l.path.includes('›') ? l.path : '' })),
      ...b.items.filter((i) => state.items.has(i.id)).map((i) => ({ kind: 'item', id: i.id, title: i.name, code: i.sku,
        line: state.desc ? String(i.description || [i.manufacturer, i.mpn].filter(Boolean).join(' ')).slice(0, 60) : '' })),
    ];
    el.querySelector('[data-sheet]').innerHTML = labels.length
      ? labels.map((l) => labelHtml(l, state.size)).join('')
      : '<p class="empty no-print">Choose items or locations above (or use "Print labels" on Items, an item or a location).</p>';
    el.querySelector('summary').textContent = `Choose items and locations (${labels.length} chosen)`;
  };
  draw();
  el.querySelector('[data-size]').addEventListener('change', (e) => ((state.size = e.target.value), draw()));
  el.querySelector('[data-desc]').addEventListener('change', (e) => ((state.desc = e.target.checked), draw()));
  el.querySelector('[data-filter]').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    el.querySelectorAll('[data-name]').forEach((li) => (li.hidden = q && !li.dataset.name.includes(q)));
  });
  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.item) t.checked ? state.items.add(t.dataset.item) : state.items.delete(t.dataset.item);
    else if (t.dataset.loc) t.checked ? state.locations.add(t.dataset.loc) : state.locations.delete(t.dataset.loc);
    else return;
    setLabelSelection({ items: [...state.items], locations: [...state.locations] });
    draw();
  });
  el.querySelector('[data-print]').addEventListener('click', () => window.print());
}
