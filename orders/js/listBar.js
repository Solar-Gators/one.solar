/**
 * One toolbar for every list (Orders → Requests, Inventory → Items, …): search on the left, then one "Filter ▾" menu
 * with the list's filters, the filters in use as chips (× takes one off), and the count on the right.
 *
 *   el.innerHTML = listBar({ id: 'requests', q, placeholder, filters, values, extra });
 *   bindListBar(el, { id: 'requests', filters, values, onChange });
 *
 * filters: [{ key, label, all: 'Any status', options: [[value, label], …] }]; values: { key: value } (changed in place).
 * The filters picked are remembered per list in this browser (localStorage "onesolar:list:<id>"), so a list opens the
 * way it was left. extra: more controls placed after the Filter menu (e.g. a season picker); end: a button after the
 * count (e.g. "+ Add").
 */
import { esc } from './ui.js';

const KEY = (id) => `onesolar:list:${id}`;

/** The filters remembered for this list (only keys and values the list still has). */
export function rememberedFilters(id, filters) {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY(id)) || '{}');
    const out = {};
    for (const f of filters) if (saved[f.key] && f.options.some(([v]) => v === saved[f.key])) out[f.key] = saved[f.key];
    return out;
  } catch {
    return {};
  }
}
function remember(id, values) {
  if (!id) return;   // a list that keeps its filters in its address instead
  try { localStorage.setItem(KEY(id), JSON.stringify(values)); } catch { /* private window: fine */ }
}

const chips = (filters, values) => filters.filter((f) => values[f.key]).map((f) => {
  const label = f.options.find(([v]) => v === values[f.key])?.[1] || values[f.key];
  return `<span class="list-chip">${esc(f.label)}: <strong>${esc(label)}</strong><button type="button" data-unfilter="${esc(f.key)}" aria-label="Remove the ${esc(f.label)} filter">×</button></span>`;
}).join('');

export function listBar({ q = '', placeholder = 'Search…', filters = [], values = {}, extra = '', end = '', searchAttr = 'data-list-q' }) {
  const on = filters.filter((f) => values[f.key]).length;
  return `<div class="list-bar">
      <input type="search" ${searchAttr} value="${esc(q)}" placeholder="${esc(placeholder)}" aria-label="Search" autocomplete="off">
      ${filters.length ? `<details class="list-filter"><summary class="btn btn-sm${on ? ' is-on' : ''}">Filter${on ? ` · ${on}` : ''} <span aria-hidden="true">▾</span></summary>
        <div class="list-filter-pop">${filters.map((f) => `<label><span>${esc(f.label)}</span><select data-filter="${esc(f.key)}" aria-label="${esc(f.label)}">
          <option value="">${esc(f.all)}</option>${f.options.map(([v, l]) => `<option value="${esc(v)}" ${values[f.key] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`).join('')}
          ${on ? '<button type="button" class="link-btn" data-unfilter="*">Clear all filters</button>' : ''}</div></details>` : ''}
      ${extra}
      <span class="list-chips" data-list-chips>${chips(filters, values)}</span>
      <span class="list-count muted" data-list-count></span>${end}
    </div>`;
}

/** Wire the bar: a filter change (menu, chip ×, Clear all) updates `values`, is remembered, and calls onChange(). */
export function bindListBar(el, { id, filters, values, onChange }) {
  const bar = el.querySelector('.list-bar');
  if (!bar) return;
  const redraw = () => {
    const on = filters.filter((f) => values[f.key]).length;
    bar.querySelector('[data-list-chips]').innerHTML = chips(filters, values);
    const sum = bar.querySelector('.list-filter > summary');
    if (sum) {
      sum.classList.toggle('is-on', !!on);
      sum.innerHTML = `Filter${on ? ` · ${on}` : ''} <span aria-hidden="true">▾</span>`;
    }
    bar.querySelectorAll('[data-filter]').forEach((s) => { s.value = values[s.dataset.filter] || ''; });
    const pop = bar.querySelector('.list-filter-pop');
    pop?.querySelector('[data-unfilter="*"]')?.remove();
    if (pop && on) pop.insertAdjacentHTML('beforeend', '<button type="button" class="link-btn" data-unfilter="*">Clear all filters</button>');
  };
  const changed = () => (remember(id, values), redraw(), onChange());
  bar.addEventListener('change', (e) => {
    const s = e.target.closest('[data-filter]');
    if (!s) return;
    values[s.dataset.filter] = s.value;
    const menu = s.closest('details');
    if (menu) menu.open = false;   // the menu sits over the list: close it so the list shows
    changed();
  });
  bar.addEventListener('click', (e) => {
    const x = e.target.closest('[data-unfilter]');
    if (!x) return;
    if (x.dataset.unfilter === '*') for (const f of filters) values[f.key] = '';
    else values[x.dataset.unfilter] = '';
    changed();
  });
  // the menu closes on a click elsewhere or Esc (one listener for the whole page, however often lists redraw)
  const menu = bar.querySelector('.list-filter');
  menu?.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); menu.open = false; menu.querySelector('summary').focus(); } });
  if (!outsideBound) {
    outsideBound = true;
    document.addEventListener('click', (e) => document.querySelectorAll('details.list-filter[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; }));
  }
}
let outsideBound = false;

/** "12 of 40" (or just "40") on the right of the bar. */
export function setListCount(el, shown, total, noun = '') {
  const c = el.querySelector('[data-list-count]');
  if (c) c.textContent = shown === total ? `${total}${noun ? ` ${noun}` : ''}` : `${shown} of ${total}${noun ? ` ${noun}` : ''}`;
}
