/**
 * Keyboard shortcuts, the same in Orders, Inventory, Events, Sponsors, Finances and Admin (Projects has its own
 * set, views/projects/command.js, with these same keys and more):
 *   Ctrl/⌘ K  search or jump anywhere (shared/command-palette.js)
 *   C         start something new on this page (the button marked data-shortcut="create"; else the top bar's)
 *   /         search this page (its search box)
 *   J / K     next / previous row in the list; Enter opens it
 *   ?         this list
 * They never act while you're typing in a box, with a dialog open, or with Ctrl / Alt / ⌘ held. Nothing they do
 * saves anything: each one is the same as clicking.
 */
import { esc } from './ui.js';
import { openPalette, PALETTE_KEY } from '../../shared/command-palette.js';

const ROWS = '#app tr[data-href], #app table.table tbody tr.clickable, #app .task-list a, #app .recent-list a, #app .kcard, #app [data-row-link]';
const typing = (t) => !!t?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
const busy = () => !!document.querySelector('dialog[open], .os-pal:not([hidden]), .pm-pick, .pm-cmd, .os-switch-pop:not([hidden])');
const visible = (el) => !!el && el.offsetParent !== null && !el.hidden;
let at = null;   // the row J / K is on

function mark(row) {
  document.querySelectorAll('.kbd-at').forEach((r) => r.classList.remove('kbd-at'));
  at = row;
  if (!row) return;
  row.classList.add('kbd-at');
  if (!row.matches('a, button') && !row.hasAttribute('tabindex')) row.tabIndex = -1;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: 'nearest' });
}

function openRow(row) {
  if (row.matches('a')) return row.click();
  if (row.dataset.href) return void (location.hash = row.dataset.href);
  (row.querySelector('a[href]') || row).click();
}

export function shortcutsDialog() {
  if (document.querySelector('.kbd-help')) return;
  const key = (...k) => k.map((x) => `<kbd>${esc(x)}</kbd>`).join(' ');
  const dialog = document.createElement('dialog');
  dialog.className = 'sheet-dialog kbd-help';
  dialog.innerHTML = `<form method="dialog"><h2>Keyboard shortcuts</h2>
    <table class="kbd-table"><tbody>
      <tr><td>${key(...PALETTE_KEY.split(' + '))}</td><td>Search or jump anywhere: pages, apps, requests, parts, sponsors…</td></tr>
      <tr><td>${key('C')}</td><td>Start something new on this page (a request, an item, a sponsor…)</td></tr>
      <tr><td>${key('/')}</td><td>Search this page</td></tr>
      <tr><td>${key('J')} ${key('K')}</td><td>Next / previous row in a list</td></tr>
      <tr><td>${key('Enter')}</td><td>Open that row</td></tr>
      <tr><td>${key('Esc')}</td><td>Close a dialog or menu</td></tr>
      <tr><td>${key('?')}</td><td>This list</td></tr>
    </tbody></table>
    <p class="muted small">Shortcuts don't work while you're typing in a box. Projects has a few more (press ? there).</p>
    <div class="form-actions"><button class="btn btn-primary" value="ok">Done</button></div></form>`;
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

export function installShortcuts({ skip = () => false } = {}) {
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || busy() || skip()) return;
    const k = e.key;
    if (k === '?') return void (e.preventDefault(), shortcutsDialog());
    if (k === '/') {
      e.preventDefault();
      const box = [...document.querySelectorAll('#app input[type="search"], #app [data-search], #app .filters input[type="text"]')].find(visible);
      return void (box ? (box.focus(), box.select?.()) : openPalette());
    }
    if (k === 'c' || k === 'C') {
      const btn = [...document.querySelectorAll('#app [data-shortcut="create"]')].find(visible)
        || [...document.querySelectorAll('.topbar .new-cta:not([data-nav="inv-scan"])')].find(visible);
      if (btn) (e.preventDefault(), btn.click());
      return;
    }
    if (k === 'j' || k === 'k') {
      const rows = [...document.querySelectorAll(ROWS)].filter(visible);
      if (!rows.length) return;
      e.preventDefault();
      const i = rows.indexOf(at);
      mark(rows[i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + (k === 'j' ? 1 : -1)))]);
      return;
    }
    if (k === 'Enter' && at?.isConnected && document.activeElement === at && !at.matches('a, button')) {
      e.preventDefault();
      openRow(at);
    }
  });
  // A new page starts with no row picked.
  addEventListener('hashchange', () => { at = null; });
  document.addEventListener('mousedown', () => at && mark(null));
}
