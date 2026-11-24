/**
 * Projects: the command bar (Ctrl+K, or ⌘K on a Mac) and keyboard shortcuts. Type to jump to any project or item
 * or page, or to start something ("new item"). Shortcuts work on the row or card under the mouse (or with the
 * keyboard focus): S status, A owner, D due date, P priority, E estimate, X select, Enter open; J / K move between
 * rows; C new item; G then a letter goes somewhere; / searches; ? lists them all. Nothing here saves anything by
 * itself: it opens the same pickers and forms as clicking would.
 */
import { esc } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { loadBase, loadConfig, createItemDialog, itemHref, projectHref, can, formDialog } from './kit.js';
import { claimPaletteKey, openPalette } from '../../../../shared/command-palette.js';


const PAGES = [
  ['My work', '#/projects', 'm'], ['All projects', '#/projects/all', 'p'], ['Inbox', '#/projects/inbox', 'i'], ['Boards', '#/projects/boards', 'b'],
  ['Timeline (every project)', '#/projects/timeline', 't'], ['Calendar', '#/projects/calendar', 'c'], ['All work (search)', '#/projects/list', 'l'], ['Dashboards', '#/projects/dashboards', 'd'], ['Kinds of work', '#/projects/kinds', 'k'],
];
const TABS = [['Summary', ''], ['List', 'list'], ['Board', 'board'], ['Backlog', 'backlog'], ['Timeline', 'timeline'], ['Calendar', 'calendar'], ['Documents', 'docs']];
const RECENT = 'pm.recentItems';

/** Remember an item I opened (for the command bar's "Recent"). */
export function noteRecentItem(item) {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT) || '[]').filter((x) => x.key !== item.key);
    localStorage.setItem(RECENT, JSON.stringify([{ key: item.key, title: item.title }, ...list].slice(0, 8)));
  } catch { /* fine */ }
}
const recentItems = () => {
  try {
    return JSON.parse(localStorage.getItem(RECENT) || '[]');
  } catch {
    return [];
  }
};
const inProjects = () => /^#\/projects(\/|$)/.test(location.hash);
const currentProjectKey = () => (location.hash.match(/^#\/projects\/p\/([^/?]+)/) || [])[1] || null;
const typing = (t) => !!t?.closest?.('input, textarea, select, [contenteditable="true"]');

let installed = false;
let hovered = null;
/** Turn on the command bar and the shortcuts (once; they only act on Projects pages). */
export function installCommands() {
  if (installed) return;
  installed = true;
  claimPaletteKey(inProjects);   // Ctrl+K here is this command bar; it offers the one.solar-wide search too
  document.addEventListener('mouseover',
 (e) => (hovered = e.target.closest?.('[data-item], [data-card], .pm-g-label[data-row]') || hovered));
  let g = 0;
  document.addEventListener('keydown', (e) => {
    if (!inProjects()) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      return void openCommandBar();
    }
    if (mod || e.altKey || typing(e.target) || document.querySelector('dialog[open], .pm-pick, .pm-cmd')) return;
    const k = e.key;
    if (Date.now() - g < 1200) {
      g = 0;
      const page = PAGES.find((p) => p[2] === k.toLowerCase());
      if (page) (e.preventDefault(), (location.hash = page[1]));
      return;
    }
    if (k === 'g') return void (g = Date.now());
    if (k === '?') return void (e.preventDefault(), helpDialog());
    if (k === '/') {
      e.preventDefault();
      const search = document.querySelector('#app [data-f="q"], #app #proj-q, #app input[type="search"]');
      return void (search ? search.focus() : openCommandBar());
    }
    if (k === 'c') return void (e.preventDefault(), newItem());
    const rows = [...document.querySelectorAll('#app [data-item], #app [data-card]')].filter((n) => n.offsetParent);
    if (k === 'j' || k === 'k') {
      if (!rows.length) return;
      e.preventDefault();
      const at = rows.indexOf(document.activeElement?.closest?.('[data-item], [data-card]') || hovered);
      const next = rows[Math.max(0, Math.min(rows.length - 1, at + (k === 'j' ? 1 : -1)))] || rows[0];
      if (!next.hasAttribute('tabindex')) next.tabIndex = -1;
      next.focus();
      hovered = next;
      return;
    }
    const target = (document.activeElement?.closest?.('[data-item], [data-card], .pm-g-label[data-row]')) || (hovered?.isConnected ? hovered : null);
    if (!target) return;
    const field = { s: 'status', a: 'owner', d: 'due', p: 'priority', e: 'estimate' }[k.toLowerCase()];
    if (field) {
      const btn = target.querySelector(`[data-ie="${field}"]`);
      if (btn) (e.preventDefault(), btn.click());
    } else if (k === 'x') {
      const box = target.querySelector('[data-select]');
      if (box) (e.preventDefault(), box.click());
    } else if (k === 'Enter' && target === document.activeElement?.closest?.('[data-item], [data-card]')) {
      const a = target.querySelector('a[href^="#/projects/item/"]');
      if (a) (e.preventDefault(), (location.hash = a.getAttribute('href')));
    }
  });
}

/** "C": a new item in the project I'm looking at, or pick the project first. */
async function newItem() {
  const b = await loadBase();
  const key = currentProjectKey();
  let project = key ? b.projectByKey.get(key.toUpperCase()) : null;
  if (!project || !can(b, project.id, 'create')) {
    const mine = b.projects.filter((p) => !p.archived_at && can(b, p.id, 'create'));
    if (!mine.length) return;
    if (mine.length === 1) project = mine[0];
    else {
      const id = await openCommandBar({ mode: 'project', title: 'New item in which project?' });
      project = id && b.projectById.get(id);
    }
  }
  if (!project) return;
  const made = await createItemDialog(b, await loadConfig(b, project.id));
  if (made) location.hash = itemHref(made.key);
}

/** The command bar. mode 'project' only lists projects and resolves with the one picked. */
export async function openCommandBar({ mode = 'all', title = 'Go to or do anything' } = {}) {
  if (document.querySelector('.pm-cmd')) return null;
  const b = await loadBase();
  const here = currentProjectKey() ? b.projectByKey.get(currentProjectKey().toUpperCase()) : null;
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'pm-cmd';
    dialog.setAttribute('aria-label', title);
    dialog.innerHTML = `<input type="search" class="pm-cmd-q" placeholder="${esc(mode === 'project' ? 'Find a project' : 'Type a project, an item (BAT-12 or words), or a page…')}" aria-label="${esc(title)}" autocomplete="off">
      <div class="pm-cmd-list" role="listbox"></div>
      <div class="pm-cmd-foot"><span>↑↓ to choose · Enter to open · Esc to close</span>${mode === 'all' ? '<button type="button" class="pm-cmd-help" data-help>Shortcuts (?)</button>' : ''}</div>`;
    document.body.append(dialog);
    const q = dialog.querySelector('.pm-cmd-q');
    const list = dialog.querySelector('.pm-cmd-list');
    let rows = [];
    let at = 0;
    let found = [];
    let seq = 0;
    let result = null;
    const run = (r) => {
      if (!r) return;
      if (mode === 'project') result = r.value;
      dialog.close();
      if (r.href) location.hash = r.href;
      else r.act?.();
    };
    const draw = () => {
      const needle = q.value.trim().toLowerCase();
      const has = (s) => !needle || s.toLowerCase().includes(needle);
      const projects = b.projects.filter((p) => !p.archived_at && has(`${p.name} ${p.key}`));
      if (mode === 'project') rows = projects.filter((p) => can(b, p.id, 'create')).map((p) => ({ group: 'Projects', label: p.name, hint: p.key, value: p.id }));
      else {
        rows = [
          ...(needle ? [] : recentItems().map((r) => ({ group: 'Recent', label: r.title, hint: r.key, href: itemHref(r.key) }))),
          ...found.map((i) => ({ group: 'Items', label: i.title, hint: `${i.key} · ${b.projectById.get(i.project_id)?.name || ''}`, href: itemHref(i.key) })),
          ...(here && can(b, here.id, 'create') && has(`new item add create ${here.name}`) ? [{ group: 'Do', label: `New item in ${here.name}`, hint: 'C', act: () => newItem() }] : []),
          ...(has('new item add create') && !here ? [{ group: 'Do', label: 'New item…', hint: 'C', act: () => newItem() }] : []),
          ...(here ? TABS.filter(([l]) => has(`${here.name} ${here.key} ${l}`)).map(([l, tab]) => ({ group: here.name, label: l, hint: here.key, href: projectHref(here.key, tab) })) : []),
          ...PAGES.filter(([l]) => has(l)).map(([l, href, k]) => ({ group: 'Go to', label: l, hint: `G ${k.toUpperCase()}`, href })),
          ...projects.slice(0, needle ? 8 : 6).map((p) => ({ group: 'Projects', label: p.name, hint: p.key, href: projectHref(p.key) })),
          ...(needle ? [{ group: 'Everywhere', label: 'Search all of one.solar', hint: 'Requests, parts, sponsors, events…', act: () => openPalette(q.value.trim()) }] : []),
        ];
      }
      at = Math.min(at, Math.max(rows.length - 1, 0));
      let group = null;
      list.innerHTML = rows.map((r, n) => `${r.group !== group ? `<div class="pm-cmd-group">${esc((group = r.group))}</div>` : ''}<button type="button" role="option" class="pm-cmd-row${n === at ? ' is-at' : ''}" data-n="${n}">
        <span>${esc(r.label)}</span>${r.hint ? `<span class="pm-cmd-hint">${esc(r.hint)}</span>` : ''}</button>`).join('') || `<div class="pm-cmd-none">${found.length || !needle ? 'Nothing here.' : 'Nothing matches yet…'}</div>`;
      list.querySelector('.is-at')?.scrollIntoView({ block: 'nearest' });
    };
    const search = async () => {
      const text = q.value.trim();
      const mine = ++seq;
      if (mode !== 'all' || text.length < 2) return ((found = []), draw());
      const res = await pm.search({ q: text, limit: 8, sort: 'updated', dir: 'desc' }).catch(() => ({ items: [] }));
      if (mine !== seq) return;
      // an exact key first (BAT-12)
      found = res.items.sort((x, y) => (y.key.toLowerCase() === text.toLowerCase()) - (x.key.toLowerCase() === text.toLowerCase()));
      draw();
    };
    let timer;
    q.addEventListener('input', () => {
      at = 0;
      draw();
      clearTimeout(timer);
      timer = setTimeout(search, 180);
    });
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        at = (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % Math.max(rows.length, 1);
        draw();
      } else if (e.key === 'Enter') (e.preventDefault(), run(rows[at]));
    });
    list.addEventListener('click', (e) => {
      const r = e.target.closest('[data-n]');
      if (r) run(rows[Number(r.dataset.n)]);
    });
    dialog.querySelector('[data-help]')?.addEventListener('click', () => (dialog.close(), helpDialog()));
    dialog.addEventListener('click', (e) => e.target === dialog && dialog.close());
    dialog.addEventListener('close', () => (dialog.remove(), resolve(result)));
    draw();
    dialog.showModal();
    q.focus();
  });
}

/** "?": every shortcut on one page. */
export function helpDialog() {
  const row = (keys, what) => `<tr><td>${keys.map((k) => `<kbd>${esc(k)}</kbd>`).join(' ')}</td><td>${esc(what)}</td></tr>`;
  return formDialog({
    title: 'Keyboard shortcuts', submit: '',
    body: `<table class="pm-keys"><tbody>
      ${row(['Ctrl', 'K'], 'Go to or do anything (⌘K on a Mac)')}${row(['C'], 'New item')}${row(['/'], 'Search this page')}
      ${row(['J', 'K'], 'Next / previous row')}${row(['Enter'], 'Open the row')}
      ${row(['S'], 'Change status of the row under the mouse')}${row(['A'], 'Change owner')}${row(['D'], 'Change due date')}${row(['P'], 'Change priority')}${row(['E'], 'Change estimate')}
      ${row(['X'], 'Select the row (Shift-click a box to select a range)')}${row(['Esc'], 'Close, or clear the selection')}
      ${PAGES.map(([l, , k]) => row(['G', k.toUpperCase()], l)).join('')}
      ${row(['?'], 'This list')}</tbody></table>
      <p class="hint">Shortcuts don't work while you're typing in a box. Everything they do can also be done by clicking.</p>`,
  });
}
