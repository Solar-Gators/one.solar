/**
 * Projects → List: a searchable, sortable table of items (one project's, or everything I can see), a page at a
 * time from the database. Columns, sort and filter can be saved as a view; several items can be changed at once.
 */
import { esc } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { filterBar, bindFilterBar, filterOf, itemTable, TABLE_COLUMNS, can, formDialog, attempt, moreMenu, treeOrder } from './kit.js';
import { loadViews, viewsFor, pickView, viewPicker, bindViewPicker, readySearches } from './saved.js';
import { recentItems } from './command.js';
import { bindInline } from './inline.js';
import { bindSelection } from './select.js';
import { quickAdd, addUnderButton, bindAddUnder } from './quick.js';

const PAGE = 50;
const states = new Map();
const SORTS = [['rank', 'Backlog order'], ['due', 'Due date'], ['updated', 'Last changed'], ['created', 'Created'], ['priority', 'Priority'], ['status', 'Status'], ['title', 'Title'], ['owner', 'Owner']];
const stateOf = (key) => states.get(key) || states.set(key, { f: { q: '', owner: '', category: 'open', priority: '', type: '', more: null }, sort: 'rank', dir: 'asc', page: 0, columns: null, view: undefined, dirty: false, tree: true }).get(key);
// W5: which items' children are folded away in the tree, on this device
const CLOSED_KEY = 'pm.listClosed';
const readClosed = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(CLOSED_KEY) || '[]'));
  } catch {
    return new Set();
  }
};
const saveClosed = (set) => {
  try {
    localStorage.setItem(CLOSED_KEY, JSON.stringify([...set].slice(-500)));
  } catch { /* private window: it just isn't remembered */ }
};

// W6: the Summary's 7-day tiles open the List with one of these (…/list?show=finished)
const SHOW = {
  finished: { category: 'done', more: { f: 'completed', op: 'last', v: 7 } },
  changed: { category: '', more: { f: 'updated', op: 'last', v: 7 } },
  added: { category: '', more: { f: 'created', op: 'last', v: 7 } },
  due: { category: 'open', more: { f: 'due', op: 'within', v: 7 } },
};

export async function renderList(el, scope) {
  const { b, project, cfg } = scope;
  const st = stateOf(project?.id || '');
  const show = scope.params?.query?.get?.('show') || '';
  if (SHOW[show] && st.shown !== show) {
    // keep what the List showed before, to go back to it when the List is opened without ?show=
    if (!st.shown) st.before = { f: { ...st.f }, view: st.view, dirty: st.dirty, sort: st.sort, dir: st.dir, page: st.page };
    Object.assign(st, { view: 'none', dirty: true, page: 0, sort: show === 'due' ? 'due' : 'updated', dir: show === 'due' ? 'asc' : 'desc' });
    Object.assign(st.f, { q: '', owner: '', category: '', priority: '', type: '', more: null }, SHOW[show]);
  } else if (!SHOW[show] && st.shown && st.before) {
    const { f, ...rest } = st.before;
    Object.assign(st, rest);
    Object.assign(st.f, f);
    st.before = null;
  }
  st.shown = SHOW[show] ? show : '';
  const views = [...readySearches(recentItems().map((r) => r.key)), ...viewsFor(await loadViews(), 'list', project?.id)];
  if (st.view === undefined) applyView(st, pickView(views.filter((v) => !v.ready), null, b.me));
  const current = views.find((v) => v.id === st.view) || null;
  const defaults = project ? ['key', 'title', 'status', 'owner', 'priority', 'due_date'] : ['key', 'title', 'project', 'status', 'owner', 'due_date'];
  const columns = st.columns || defaults;
  const custom = (cfg?.fields || []).filter((f) => !f.archived_at).map((f) => [`cf.${f.key}`, f.name]);

  let page;
  try {
    page = await pm.search({ project: project?.id, projects: scope.only, filter: filterOf(st.f), q: st.f.q, sort: st.sort, dir: st.dir, limit: PAGE, offset: st.page * PAGE });
  } catch (err) {
    el.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div><p><button type="button" class="btn" data-reset>Clear the filter</button></p>`;
    el.querySelector('[data-reset]').onclick = () => (states.delete(project?.id || ''), scope.rerender());
    return;
  }
  const pages = Math.max(1, Math.ceil(page.total / PAGE));
  // W5: in backlog order, items sit under their parent (when both are on this page); any other sort is a flat list
  const treeOn = st.tree && st.sort === 'rank';
  const tree = treeOn ? treeOrder(page.items, readClosed()) : null;
  const shown = tree ? tree.items : page.items;
  const canBulk = project ? can(b, project.id, 'edit') || can(b, project.id, 'create') : true;

  el.innerHTML = `<div class="pm-toolbar pm-tbar">${viewPicker(b, views, current, { dirty: st.dirty })}${filterBar(b, st.f, { types: scope.types })}
      <div class="card-actions"><select data-sort aria-label="Sort">${SORTS.flatMap(([k, l]) => ['asc', 'desc'].map((d) => `<option value="${k}:${d}" ${st.sort === k && st.dir === d ? 'selected' : ''}>${l} ${d === 'asc' ? '↑' : '↓'}</option>`)).join('')}</select>
        ${moreMenu([['data-tree', st.tree ? 'Show as a flat list' : 'Show as a tree (parents with the items under them)'], ['data-columns', 'Columns…'], ['data-csv', 'Download (CSV)']])}</div></div>
    <p class="muted small" aria-live="polite">${page.total} item${page.total === 1 ? '' : 's'}${page.total > PAGE ? `, showing ${st.page * PAGE + 1}–${Math.min(page.total, (st.page + 1) * PAGE)}` : ''}
      ${page.items.length ? '<span class="pm-tip">Click a status, owner, priority or date to change it.</span>' : ''}
      ${st.tree && !treeOn && page.items.length ? '<span class="pm-tip">Sorted this way the list is flat; Backlog order shows items under their parents.</span>' : ''}</p>
    ${itemTable(b, shown, scope.cfgOf, { columns, select: canBulk, tree, addUnder: (c, i) => addUnderButton(b, c, i),
      empty: Object.values(st.f).some((v) => v && v !== 'open') ? '<p><strong>No items match.</strong></p><p><button type="button" class="btn btn-sm" data-clear-filters>Clear the filter</button></p>'
        : project ? '<p><strong>No open items in this space yet.</strong></p><p>Type a title below and press Enter. You can fill in the rest later, right in the list.</p>'
          : '<p><strong>Nothing open that you can see.</strong></p><p>Items show here once they\'re added to a space.</p>',
      foot: project && can(b, project.id, 'create') && !project.archived_at ? quickAdd(b, { project_id: project.id }, { placeholder: '+ Add an item (Enter to add, Shift+Enter for the full form)', cls: 'pm-qa-table' }) : '' })}
    ${pages > 1 ? `<nav class="pm-pages" aria-label="Pages"><button type="button" class="btn btn-sm" data-page="${st.page - 1}" ${st.page ? '' : 'disabled'}>← Previous</button>
      <span>Page ${st.page + 1} of ${pages}</span><button type="button" class="btn btn-sm" data-page="${st.page + 1}" ${st.page + 1 < pages ? '' : 'disabled'}>Next →</button></nav>` : ''}`;

  const changed = () => {
    st.page = 0;
    st.dirty = true;
    scope.rerender();
  };
  bindFilterBar(el, b, st.f, changed, { fields: cfg?.fields, statuses: scope.statuses, sprints: cfg?.sprints });
  bindViewPicker(el, { b, kind: 'list', projectId: project?.id, views, current, getConfig: () => ({ filter_state: st.f, sort: st.sort, dir: st.dir, columns, tree: st.tree }),
    onPick: (v, id) => (applyView(st, v, id), scope.rerender()) });
  el.querySelector('[data-sort]').onchange = (e) => (([st.sort, st.dir] = e.target.value.split(':')), changed());
  el.querySelectorAll('[data-page]').forEach((n) => (n.onclick = () => ((st.page = Number(n.dataset.page)), scope.rerender())));
  el.querySelector('[data-columns]').onclick = async () => {
    const all = [...TABLE_COLUMNS, ...custom];
    const picked = await formDialog({ title: 'Columns', submit: 'Show these',
      body: `<div class="pm-checks">${all.map(([k, l]) => `<label class="pm-check"><input type="checkbox" name="c" value="${esc(k)}" ${columns.includes(k) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>`,
      onSubmit: (f) => [...f.querySelectorAll('[name=c]:checked')].map((n) => n.value) });
    if (Array.isArray(picked) && picked.length) ((st.columns = picked), (st.dirty = true), scope.rerender());
  };
  el.querySelector('[data-tree]').onclick = () => ((st.tree = !st.tree), (st.dirty = true), scope.rerender());
  // fold / unfold without reloading the page
  el.addEventListener('click', (e) => {
    const tog = e.target.closest('[data-tree-tog]');
    if (!tog || !tree) return;
    const id = tog.dataset.treeTog;
    const closed = readClosed();
    if (closed.has(id)) closed.delete(id);
    else closed.add(id);
    saveClosed(closed);
    const next = treeOrder(page.items, closed);
    el.querySelectorAll('tr.pm-tree-row').forEach((r) => (r.hidden = next.hidden.has(r.dataset.item)));
    tog.setAttribute('aria-expanded', String(!closed.has(id)));
    tog.textContent = closed.has(id) ? '▸' : '▾';
  });
  el.querySelector('[data-csv]').onclick = async () => {
    const all = await attempt(() => pm.searchAll({ project: project?.id, projects: scope.only, filter: filterOf(st.f), q: st.f.q, sort: st.sort, dir: st.dir }));
    if (all) downloadCsv(b, all.items, scope, `${project?.key || 'projects'}-items.csv`);
  };

  // change in place, several at once, add with a title
  const byId = new Map(page.items.map((i) => [i.id, i]));
  bindInline(el, { b, itemOf: (id) => byId.get(id), cfgOf: scope.cfgOf });
  if (canBulk) bindSelection(el, { b, items: () => page.items, cfgOf: scope.cfgOf, done: () => scope.rerender(), sprints: cfg?.sprints || [] });
  bindAddUnder(el, { b, done: () => scope.rerender() });   // also the quick-add lines (V8a)
  el.querySelector('.empty [data-clear-filters]')?.addEventListener('click', () => {
    Object.assign(st.f, { q: '', owner: '', category: '', priority: '', type: '', more: null });
    changed();
  });
}

function applyView(st, v, id = null) {
  st.view = v?.id || id || 'none';
  st.dirty = false;
  st.page = 0;
  if (!v) return;
  Object.assign(st.f, { q: '', owner: '', category: '', priority: '', type: '', more: null }, v.config.filter_state || {});
  st.sort = v.config.sort || 'rank';
  st.dir = v.config.dir || 'asc';
  st.columns = v.config.columns || null;
  st.tree = v.config.tree !== false;
}

/** A CSV of items (opens in Excel). Values that could be read as a formula are made plain text. */
function downloadCsv(b, items, scope, name) {
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['Key', 'Title', 'Space', 'Kind', 'Status', 'Priority', 'Owner', 'CE division', 'Subsystem', 'Start', 'Due', 'Estimate (h)', 'Progress %', 'Blocked', 'Labels', 'Finished'];
  const lines = items.map((i) => {
    const c = scope.cfgOf(i);
    return [i.key, i.title, b.projectById.get(i.project_id)?.name, c?.typeById.get(i.type_id)?.name, c?.statusById.get(i.status_id)?.name, i.priority, b.personById.get(i.owner_id)?.full_name,
      b.divisionById.get(i.division_id)?.name, b.subsystemById.get(i.subsystem_id)?.name, i.start_date, i.due_date, i.estimate_hours, i.progress, i.blocked ? i.blocked_reason || 'Yes' : '',
      i.labels, (i.completed_at || '').slice(0, 10)].map(cell).join(',');
  });
  const url = URL.createObjectURL(new Blob([`﻿${head.join(',')}\n${lines.join('\n')}`], { type: 'text/csv' }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
