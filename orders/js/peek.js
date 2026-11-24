/**
 * "Peek": a click on a row in a list opens that record in a panel on the right, without leaving the list
 * (Orders → Requests, Inventory → Items). The panel shows the record's own page, so everything on it works the same.
 *   - Esc or × closes it; ↑ / ↓ (or K / J) open the previous / next row; "Open full page" goes to the record's page.
 *   - Ctrl / ⌘ / Shift / middle click, and phones (up to 760px wide), still open the full page.
 *   - Anything changed in the panel shows in the list once the panel closes.
 *
 *   bindPeek(listContainer, { ctx: { config, rerender } });   // rows: <tr data-href="#/requests/SG27-104">
 */
import { esc, errorBox } from './ui.js';

// Which pages can be peeked, by their address: the record's id from the address, and how to draw its page.
const KINDS = [
  { re: /^#\/requests\/([^/?]+)$/, label: 'Request', view: async () => (await import('./views/requestDetail.js')).renderRequestDetail },
  { re: /^#\/inventory\/items\/([^/?]+)$/, label: 'Item', view: async () => (await import('./views/inventory/item.js')).renderInvItem, skip: (id) => id === 'new' },
];
const kindOf = (href) => {
  for (const k of KINDS) {
    const m = String(href || '').match(k.re);
    if (m && !k.skip?.(decodeURIComponent(m[1]))) return { kind: k, id: decodeURIComponent(m[1]) };
  }
  return null;
};
const narrow = () => matchMedia('(max-width: 760px)').matches;
const typing = (t) => !!t?.closest?.('input, textarea, select, [contenteditable="true"]');

let panel = null;   // the one panel on the page: { el, body, list, href, changed, ctx, seq }

function rowsOf(list) {
  return [...list.querySelectorAll('tr[data-href]')].filter((r) => kindOf(r.dataset.href) && r.offsetParent !== null);
}

function close({ refresh = true } = {}) {
  if (!panel) return;
  const p = panel;
  panel = null;
  p.el.remove();
  document.body.classList.remove('has-peek');
  document.querySelectorAll('tr.is-peeked').forEach((r) => r.classList.remove('is-peeked'));
  removeEventListener('hashchange', onHash);
  document.removeEventListener('keydown', onKey, true);
  if (refresh && p.changed && p.list.isConnected) p.ctx.rerender?.();
  p.lastRow?.focus?.({ preventScroll: true });
}
const onHash = () => close({ refresh: false });   // a link in the panel went to another page

function onKey(e) {
  if (!panel || document.querySelector('dialog[open], .os-pal:not([hidden])')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    return close();
  }
  if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[e.key];
  if (!step) return;
  const rows = rowsOf(panel.list);
  const i = rows.findIndex((r) => r.dataset.href === panel.href);
  const next = rows[i + step];
  if (!next) return;
  e.preventDefault();
  e.stopPropagation();
  show(panel.list, next, panel.ctx);
}

async function show(list, row, ctx) {
  const href = row.dataset.href;
  const found = kindOf(href);
  if (!found) return;
  if (!panel) {
    const el = document.createElement('aside');
    el.className = 'peek';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Preview');
    el.innerHTML = `<div class="peek-head">
        <button type="button" class="btn btn-sm btn-ghost" data-peek-prev title="Previous (↑)" aria-label="Previous">↑</button>
        <button type="button" class="btn btn-sm btn-ghost" data-peek-next title="Next (↓)" aria-label="Next">↓</button>
        <span class="peek-title muted small"></span>
        <a class="btn btn-sm" data-peek-full href="#">Open full page</a>
        <button type="button" class="btn btn-sm btn-ghost" data-peek-close title="Close (Esc)" aria-label="Close">×</button>
      </div><div class="peek-body"></div>`;
    document.body.append(el);
    document.body.classList.add('has-peek');
    panel = { el, body: el.querySelector('.peek-body'), list, ctx, changed: false, seq: 0 };
    el.querySelector('[data-peek-close]').onclick = () => close();
    el.querySelector('[data-peek-prev]').onclick = () => onKey({ key: 'ArrowUp', target: el, preventDefault() {}, stopPropagation() {} });
    el.querySelector('[data-peek-next]').onclick = () => onKey({ key: 'ArrowDown', target: el, preventDefault() {}, stopPropagation() {} });
    // saving anything in the panel means the list may be out of date
    el.addEventListener('submit', () => (panel && (panel.changed = true)), true);
    el.addEventListener('click', (e) => { if (panel && e.target.closest('.peek-body button')) panel.changed = true; }, true);
    addEventListener('hashchange', onHash);
    document.addEventListener('keydown', onKey, true);
  }
  panel.href = href;
  panel.lastRow = row;
  document.querySelectorAll('tr.is-peeked').forEach((r) => r.classList.remove('is-peeked'));
  row.classList.add('is-peeked');
  row.scrollIntoView({ block: 'nearest' });
  panel.el.querySelector('.peek-title').textContent = found.kind.label;
  panel.el.querySelector('[data-peek-full]').setAttribute('href', href);
  const rows = rowsOf(list);
  const i = rows.indexOf(row);
  panel.el.querySelector('[data-peek-prev]').disabled = i <= 0;
  panel.el.querySelector('[data-peek-next]').disabled = i < 0 || i >= rows.length - 1;

  const seq = ++panel.seq;
  const p = panel;
  const draw = async () => {
    const target = document.createElement('div');
    target.className = 'peek-page';
    try {
      const view = await found.kind.view();
      await view(target, { ...ctx, params: { id: found.id, query: new URLSearchParams(), parts: [found.id] }, rerender: () => ((p.changed = true), draw()) });
    } catch (err) {
      target.innerHTML = errorBox(err);
    }
    if (panel !== p || p.seq !== seq) return;   // closed, or another row was picked meanwhile
    p.body.replaceChildren(target);
  };
  p.body.innerHTML = `<p class="muted peek-loading">Loading ${esc(found.kind.label.toLowerCase())}…</p>`;
  await draw();
}

export function bindPeek(list, { ctx }) {
  if (!list) return;
  list.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || narrow()) return;
    const row = e.target.closest('tr[data-href]');
    if (!row || !kindOf(row.dataset.href)) return;
    // a control in the row (a checkbox, a menu) does its own thing; a link to the record itself peeks too
    const ctl = e.target.closest('button, input, select, textarea, label, a');
    if (ctl && !(ctl.matches('a') && ctl.getAttribute('href') === row.dataset.href)) return;
    e.preventDefault();
    e.stopPropagation();
    show(list, row, ctx);
  });
}

/** Close the panel (e.g. before a list redraws itself from scratch). */
export const closePeek = () => close({ refresh: false });
