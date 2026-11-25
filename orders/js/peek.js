/**
 * "Peek": a click on a row in a list opens that record in a panel on the right, without leaving the list
 * (Orders → Requests, Inventory → Items; W1: Workbench work items from the List, Board, Backlog, Timeline and
 * Calendar). The panel shows the record's own page, so everything on it works the same.
 *   - Esc or × closes it; ↑ / ↓ (or K / J) open the previous / next row; "Open full page" goes to the record's page.
 *   - Ctrl / ⌘ / Shift / middle click, and phones (up to 760px wide), still open the full page.
 *   - Anything changed in the panel shows in the list once the panel closes.
 *
 *   bindPeek(listContainer, { ctx: { config, rerender } });        // rows: <tr data-href="#/requests/SG27-104">
 *   bindPeekLinks(container, { ctx, share });                       // any <a href="#/projects/item/BAT-8"> in it
 *   share(href) gives the address to show while that record is open (share(null) when it closes), so the view
 *   with the record open can be copied and sent; openPeek(container, href, opts) opens one from such an address.
 */
import { esc, errorBox } from './ui.js';

// Which pages can be peeked, by their address: the record's id from the address, and how to draw its page.
const KINDS = [
  { re: /^#\/requests\/([^/?]+)$/, label: 'Request', view: async () => (await import('./views/requestDetail.js')).renderRequestDetail },
  { re: /^#\/inventory\/items\/([^/?]+)$/, label: 'Item', view: async () => (await import('./views/inventory/item.js')).renderInvItem, skip: (id) => id === 'new' },
  { re: /^#\/projects\/item\/([^/?]+)$/, label: 'Work item', wide: true, view: async () => (await import('./views/projects/item.js')).renderItem },
];
const hrefOf = (node) => node?.dataset?.href || node?.getAttribute?.('href') || '';
const markOf = (node) => node.closest?.('.kcard, .pm-g-label, tr, li, .pm-cal-item') || node;
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
  // rows with data-href, or (W1) links to records: one per record, in page order
  const seen = new Set();
  return [...list.querySelectorAll('tr[data-href], a[href^="#/"]')].filter((r) => {
    const h = hrefOf(r);
    if ((r.matches('a') && r.closest('tr[data-href]')) || !kindOf(h) || r.offsetParent === null || seen.has(h)) return false;
    return seen.add(h), true;
  });
}

function close({ refresh = true } = {}) {
  if (!panel) return;
  const p = panel;
  panel = null;
  p.el.remove();
  document.body.classList.remove('has-peek');
  document.querySelectorAll('.is-peeked').forEach((r) => r.classList.remove('is-peeked'));
  removeEventListener('hashchange', onHash);
  if (p.share) history.replaceState(history.state, '', p.share(null));
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
  const i = rows.findIndex((r) => hrefOf(r) === panel.href);
  const next = rows[i + step];
  if (!next) return;
  e.preventDefault();
  e.stopPropagation();
  show(panel.list, next, panel.ctx);
}

async function show(list, row, ctx, share = null) {
  const href = hrefOf(row);
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
    panel = { el, body: el.querySelector('.peek-body'), list, ctx, share, changed: false, seq: 0 };
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
  panel.el.classList.toggle('peek-wide', !!found.kind.wide);
  document.querySelectorAll('.is-peeked').forEach((r) => r.classList.remove('is-peeked'));
  if (row.isConnected) (markOf(row).classList.add('is-peeked'), row.scrollIntoView({ block: 'nearest' }));
  // the address says which record is open (replaceState: no page change, no new history entry)
  if (panel.share) history.replaceState(history.state, '', panel.share(href));
  panel.el.querySelector('.peek-title').textContent = found.kind.label;
  panel.el.querySelector('[data-peek-full]').setAttribute('href', href);
  const rows = rowsOf(list);
  const i = rows.findIndex((r) => hrefOf(r) === href);
  panel.el.querySelector('[data-peek-prev]').disabled = i <= 0;
  // (opened from a link before the list was drawn: i is -1 and Next starts at the first row)
  panel.el.querySelector('[data-peek-next]').disabled = i >= rows.length - 1 && i >= 0;

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

/**
 * W1: links to records anywhere in a container (cards, list rows, timeline names, calendar entries) open in the
 * panel. A plain left click only: Ctrl / ⌘ / Shift / middle click and phones still go to the full page.
 */
export function bindPeekLinks(list, { ctx, share = null }) {
  if (!list) return;
  list.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || narrow()) return;
    const a = e.target.closest('a[href^="#/"]');
    if (!a || a.closest('tr[data-href]') || !kindOf(a.getAttribute('href'))) return;
    e.preventDefault();
    e.stopPropagation();
    show(list, a, ctx, share);
  });
}

/** W1: open one record in the panel by its address (e.g. from ?item= in a shared link). */
export function openPeek(list, href, { ctx, share = null }) {
  if (!kindOf(href) || narrow()) return false;
  const a = [...(list?.querySelectorAll('a[href^="#/"]') || [])].find((x) => x.getAttribute('href') === href) || Object.assign(document.createElement('a'), { href });
  if (!a.isConnected) a.setAttribute('href', href);
  show(list || document.body, a, ctx, share);
  return true;
}

/** Close the panel (e.g. before a list redraws itself from scratch). */
export const closePeek = () => close({ refresh: false });
