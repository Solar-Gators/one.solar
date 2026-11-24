/**
 * one.solar: the command palette (Ctrl/⌘ + K in every app). One box to go anywhere and do anything:
 *   - pages of the app you're in (its top bar links) and the other apps (the ⊞ switcher's list);
 *   - actions apps register ("New request", "Add a part"…) plus a few of its own (dark mode, home);
 *   - requests, parts, sponsors, projects, work items and events, found by name or number in the database
 *     (search_everything, migration 066; row-level security decides what each person finds).
 *
 *   import { mountCommandPalette, registerCommands } from '../shared/command-palette.js';
 *   mountCommandPalette({ supabase });   // app-switcher.js mounts it; apps with a database pass their client
 *   registerCommands([{ id: 'new-request', title: 'New request', href: appUrl('orders/#/new'), keywords: 'order buy' }]);
 *
 * A command is { id, title, hint?, icon?, href? | run?(), keywords?, group? }. Styles are built in (GatorWire
 * doesn't load shared/onesolar.css); they use the shared colour tokens when present and follow data-theme.
 */
import { appUrl, getTheme, setTheme } from './onesolar.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const PALETTE_KEY = isMac ? '⌘ K' : 'Ctrl + K';

// Shared by every copy of this module on the page (apps import it by different relative paths).
const state = (globalThis.__osPalette ||= { commands: new Map(), supabase: null, appsSource: null, mounted: false, open: null });

/** Add (or replace, by id) commands the palette offers. Returns a function that removes them again. */
export function registerCommands(list) {
  for (const c of list) state.commands.set(c.id, c);
  return () => list.forEach((c) => state.commands.delete(c.id));
}

/** Open the palette from code (a button, the shortcuts list). */
export const openPalette = (text = '') => state.open?.(text);

/**
 * A page with its own Ctrl/⌘ + K (Projects' command bar) claims the key while `when()` is true; the palette
 * then stays closed and that page offers "Search all of one.solar" itself.
 */
export function claimPaletteKey(when) {
  state.claims ||= [];
  state.claims.push(when);
}
const claimed = () => (state.claims || []).some((f) => { try { return f(); } catch { return false; } });


/** Where a search result goes. */
const RECORD = {
  request: { label: 'Request', icon: '📦', href: (id) => appUrl(`orders/#/requests/${encodeURIComponent(id)}`) },
  part: { label: 'Part', icon: '🔩', href: (id) => appUrl(`inventory/#/inventory/items/${encodeURIComponent(id)}`) },
  sponsor: { label: 'Sponsor', icon: '🤝', href: (id) => appUrl(`sponsors/#/sponsors/${encodeURIComponent(id)}`) },
  project: { label: 'Project', icon: '🗂️', href: (id) => appUrl(`projects/#/projects/p/${encodeURIComponent(id)}`) },
  item: { label: 'Work item', icon: '✅', href: (id) => appUrl(`projects/#/projects/item/${encodeURIComponent(id)}`) },
  event: { label: 'Event', icon: '📅', href: (id) => appUrl(`events/#/events/e/${encodeURIComponent(id)}`) },
};
const STATUS_WORD = { todo: 'To do', doing: 'In progress', done: 'Done' };

const CSS = `
.os-pal{position:fixed;inset:0;z-index:2000;display:flex;justify-content:center;align-items:flex-start;padding:12vh 16px 16px;background:rgba(8,20,38,.38)}
.os-pal[hidden]{display:none}
.os-pal-box{width:640px;max-width:100%;max-height:min(72vh,560px);display:flex;flex-direction:column;border-radius:12px;overflow:hidden;
  background:var(--surface,#fff);color:var(--text,#1c2733);border:1px solid var(--border,#dde3ea);box-shadow:0 24px 64px rgba(11,37,69,.28);
  font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:left}
.os-pal-in{display:flex;align-items:center;gap:10px;padding:0 14px;border-bottom:1px solid var(--border,#dde3ea)}
.os-pal-in span{color:var(--muted,#5d6d7e);font-size:16px}
.os-pal-in input{flex:1;min-width:0;height:50px;border:0;outline:0;background:none;color:inherit;font:inherit;font-size:16px;padding:0;min-height:0;box-shadow:none}
.os-pal-list{overflow:auto;padding:6px;flex:1}
.os-pal-group{padding:8px 10px 4px;font-size:11px;font-weight:600;color:var(--muted,#5d6d7e);text-transform:uppercase;letter-spacing:.04em}
.os-pal-row{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;color:inherit;text-decoration:none;cursor:pointer;min-width:0}
.os-pal-row[aria-selected=true]{background:var(--nav-active,#e8eef8)}
.os-pal-ic{flex:none;width:22px;text-align:center;font-size:15px}
.os-pal-t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.os-pal-h{flex:none;color:var(--muted,#5d6d7e);font-size:12px;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.os-pal-none{padding:18px 12px;color:var(--muted,#5d6d7e);text-align:center}
.os-pal-foot{display:flex;gap:14px;padding:8px 14px;border-top:1px solid var(--border,#dde3ea);color:var(--muted,#5d6d7e);font-size:12px;background:var(--surface-2,#f8fafc)}
.os-pal-foot kbd,.os-keys kbd{font:600 11px/1 system-ui,sans-serif;padding:2px 5px;border-radius:4px;border:1px solid var(--border,#dde3ea);background:var(--surface,#fff);color:var(--text,#1c2733)}
[data-theme=dark] .os-pal{background:rgba(0,0,0,.55)}
[data-theme=dark] .os-pal-box{background:var(--surface,#081f3d);color:var(--text,#f7f9ff);border-color:var(--border,#23486f);box-shadow:0 24px 64px #000c}
[data-theme=dark] .os-pal-row[aria-selected=true]{background:var(--nav-active,#0d2b50)}
[data-theme=dark] .os-pal-foot{background:var(--surface-2,#061a35)}
@media(max-width:640px){.os-pal{padding:8px}.os-pal-box{max-height:calc(100vh - 16px)}.os-pal-foot{display:none}}
`;

/** The top bar's page links in this app (what "Go to" offers), including ones folded into "More ▾". */
function pageLinks() {
  const seen = new Set();
  return [...document.querySelectorAll('.topbar .nav > a, .os-bar nav a')]
    .filter((a) => !a.classList.contains('os-nav-apps') && !a.hidden && a.getAttribute('href') && a.textContent.trim())
    .map((a) => ({ title: a.textContent.replace(/\s+/g, ' ').trim(), href: a.href, el: a }))
    .filter((p) => !seen.has(p.title) && seen.add(p.title));
}

/** How well a command matches what's typed: every word typed must appear in its title or keywords. 0 = no match. */
const score = (title, keywords, q) => {
  if (!q) return 1;
  const t = title.toLowerCase();
  const all = `${t} ${String(keywords || '').toLowerCase()}`;
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.every((w) => all.includes(w))) return 0;
  if (t.startsWith(q)) return 4;
  const starts = t.split(/[\s·/:–-]+/);
  if (words.every((w) => starts.some((s) => s.startsWith(w)))) return 3;
  return words.every((w) => t.includes(w)) ? 2 : 1;
};


export function mountCommandPalette({ supabase = null, apps = null } = {}) {
  if (supabase) state.supabase = supabase;
  if (apps) state.appsSource = apps;
  if (state.mounted) return;
  state.mounted = true;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const root = document.createElement('div');
  root.className = 'os-pal';
  root.hidden = true;
  root.innerHTML = `<div class="os-pal-box" role="dialog" aria-modal="true" aria-label="Command palette">
      <div class="os-pal-in"><span aria-hidden="true">⌕</span><input type="text" role="combobox" aria-expanded="true" aria-controls="os-pal-list"
        aria-autocomplete="list" placeholder="Search or jump to…" autocomplete="off" spellcheck="false" aria-label="Search or jump to"></div>
      <div class="os-pal-list" id="os-pal-list" role="listbox"></div>
      <div class="os-pal-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span><span style="margin-left:auto">${esc(PALETTE_KEY)}</span></div>
    </div>`;
  document.body.append(root);
  const box = root.querySelector('input');
  const listEl = root.querySelector('.os-pal-list');
  let rows = [];        // what's shown, in order: { title, hint, icon, href, run, group }
  let sel = 0;
  let records = [];     // database matches for `recordsFor`
  let recordsFor = '';
  let timer = 0;
  let lastFocus = null;
  let appList = [];

  const builtIns = () => [
    { id: 'os-home', title: 'one.solar home', icon: '⌂', href: appUrl(''), keywords: 'apps start', group: 'Actions' },
    {
      id: 'os-theme', group: 'Actions', icon: '◐', keywords: 'appearance theme dark light mode',
      title: document.documentElement.getAttribute('data-theme') === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
      run: () => setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'),
    },
    ...(getTheme() !== 'auto' ? [{ id: 'os-theme-auto', group: 'Actions', icon: '◐', title: 'Match my device (light / dark)', keywords: 'appearance theme auto', run: () => setTheme('auto') }] : []),
    { id: 'os-account', title: 'My account & notifications', icon: '👤', href: appUrl('orders/#/account'), keywords: 'profile settings email password', group: 'Actions' },
  ];

  function build() {
    const q = box.value.trim().toLowerCase();
    const groups = [];
    const add = (name, items, max) => {
      const list = items.map((c) => ({ ...c, s: score(c.title, c.keywords, q) }))
        .filter((c) => c.s > 0).sort((a, b) => b.s - a.s).slice(0, max);
      if (list.length) groups.push([name, list]);
    };
    const here = location.href.split('#')[0];
    add('Go to', pageLinks().map((p) => ({ ...p, icon: '→', hint: 'Page' })), q ? 6 : 8);
    add('Actions', [...state.commands.values(), ...builtIns()].map((c) => ({ icon: '＋', ...c })), q ? 6 : 5);
    add('Apps', appList.map((a) => ({ title: a.name, icon: a.icon, href: a.url, hint: a.url.split('#')[0] === here ? 'This app' : 'App', external: a.external })), q ? 5 : 0);
    if (q.length >= 2 && recordsFor === q && records.length) {
      groups.push(['Found', records.map((r) => {
        const k = RECORD[r.kind];
        return { title: r.title, icon: k.icon, href: k.href(r.id), hint: [k.label, STATUS_WORD[r.sub] || r.sub].filter(Boolean).join(' · ') };
      })]);
    }
    rows = groups.flatMap(([g, list]) => list.map((r) => ({ ...r, group: g })));
    sel = Math.min(sel, Math.max(rows.length - 1, 0));
    let i = -1;
    listEl.innerHTML = rows.length
      ? groups.map(([g, list]) => `<div class="os-pal-group" role="presentation">${esc(g)}</div>${list.map((r) => {
          i++;
          return `<div class="os-pal-row" role="option" id="os-pal-${i}" data-i="${i}" aria-selected="${i === sel}">
            <span class="os-pal-ic" aria-hidden="true">${esc(r.icon || '')}</span><span class="os-pal-t">${esc(r.title)}${r.external ? ' ↗' : ''}</span>${r.hint ? `<span class="os-pal-h">${esc(r.hint)}</span>` : ''}</div>`;
        }).join('')}`).join('')
      : `<p class="os-pal-none">${q.length >= 2 && state.supabase && recordsFor !== q ? 'Searching…' : 'Nothing matches. Try a request number, a part, a sponsor or a page name.'}</p>`;
    box.setAttribute('aria-activedescendant', rows.length ? `os-pal-${sel}` : '');
  }

  function move(to) {
    if (!rows.length) return;
    sel = (to + rows.length) % rows.length;
    listEl.querySelectorAll('.os-pal-row').forEach((el) => el.setAttribute('aria-selected', String(+el.dataset.i === sel)));
    listEl.querySelector(`#os-pal-${sel}`)?.scrollIntoView({ block: 'nearest' });
    box.setAttribute('aria-activedescendant', `os-pal-${sel}`);
  }

  function choose(r, newTab = false) {
    if (!r) return;
    close();
    if (r.run) return r.run();
    if (r.el && !newTab) return r.el.click();   // the app's own link (its click handlers, hash routing)
    if (newTab || r.external) return void window.open(r.href, '_blank', 'noopener');
    location.href = r.href;
  }

  async function search(q) {
    if (!state.supabase || q.length < 2) return;
    try {
      const { data, error } = await state.supabase.rpc('search_everything', { p_q: q, p_limit: 5 });
      if (box.value.trim().toLowerCase() !== q) return;   // they kept typing
      records = !error && Array.isArray(data) ? data.filter((r) => RECORD[r.kind]) : [];
    } catch {
      records = [];
    }
    recordsFor = q;
    build();
  }

  box.addEventListener('input', () => {
    sel = 0;
    build();
    clearTimeout(timer);
    const q = box.value.trim().toLowerCase();
    if (q.length >= 2 && state.supabase) timer = setTimeout(() => search(q), 160);
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), move(sel + 1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), move(sel - 1));
    else if (e.key === 'Enter') (e.preventDefault(), choose(rows[sel], e.ctrlKey || e.metaKey));
    else if (e.key === 'Escape') (e.preventDefault(), close());
    else if (e.key === 'Tab') e.preventDefault();
  });
  listEl.addEventListener('mousemove', (e) => {
    const row = e.target.closest('.os-pal-row');
    if (row && +row.dataset.i !== sel) move(+row.dataset.i);
  });
  listEl.addEventListener('click', (e) => {
    const row = e.target.closest('.os-pal-row');
    if (row) choose(rows[+row.dataset.i], e.ctrlKey || e.metaKey);
  });
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });

  async function open(text = '') {
    lastFocus = document.activeElement;
    root.hidden = false;
    box.value = text;
    sel = 0;
    records = [];
    recordsFor = '';
    build();
    box.focus();
    try { appList = state.appsSource ? await state.appsSource() : []; } catch { appList = []; }
    if (!root.hidden) build();
  }
  function close() {
    if (root.hidden) return;
    root.hidden = true;
    clearTimeout(timer);
    if (lastFocus?.isConnected) lastFocus.focus?.();
  }
  state.open = open;

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      if (root.hidden && claimed()) return;
      e.preventDefault();
      if (root.hidden) open(); else close();
    }
  });
  addEventListener('hashchange', close);
}
