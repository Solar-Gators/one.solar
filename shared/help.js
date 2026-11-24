/**
 * one.solar: the longer explanations on a page sit behind one "How this works" line that opens on click, the same in
 * every app, so a page starts with what you came to do. Each one remembers in this browser whether you left it open
 * or closed (localStorage "onesolar:help:<id>"); nothing is ever hidden for good.
 *
 *   import { howItWorks } from '../shared/help.js';
 *   el.innerHTML = `<h2>Approval rules</h2><p class="muted small">The first rule that matches decides who approves.</p>
 *     ${howItWorks('<p>If none match, any Chief Engineer can approve. …</p>', { id: 'admin-rules' })}`;
 *
 * Options: id (needed to remember it), summary ('How this works'), open (how it starts before anyone has touched it).
 * Styles: shared/onesolar.css (.about). Plain pages that can't import a module can write the same markup by hand
 * (<details class="about" data-help="…">) and load this file once for the remembering.
 */
const KEY = (id) => `onesolar:help:${id}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Whether a "How this works" was left open ('1'), closed ('0'), or never touched (null). */
function saved(id) {
  try { return id ? localStorage.getItem(KEY(id)) : null; } catch { return null; }
}

/** Whether the one with this id should start open (for pages that write their own <details data-help="id">). */
export const helpOpen = (id, fallback = false) => { const was = saved(id); return was === null ? fallback : was === '1'; };

export function howItWorks(html, { id = '', summary = 'How this works', open = false } = {}) {
  const isOpen = helpOpen(id, open);
  return `<details class="about"${id ? ` data-help="${esc(id)}"` : ''}${isOpen ? ' open' : ''}><summary>${esc(summary)}</summary><div>${html}</div></details>`;
}

// One listener for the whole page: opening or closing any of them is remembered.
if (typeof document !== 'undefined' && !globalThis.__onesolarHelp) {
  globalThis.__onesolarHelp = true;
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!(d instanceof HTMLElement) || !d.matches('details[data-help]')) return;
    try { localStorage.setItem(KEY(d.dataset.help), d.open ? '1' : '0'); } catch { /* private window: fine */ }
  }, true);
}
