/**
 * Projects → List: a searchable, sortable table of items (one project's, or everything I can see), a page at a
 * time from the database. Columns, sort and filter can be saved as a view; several items can be changed at once.
 */
import { esc } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { PRIORITIES } from '../../projects/core.js';
import { filterBar, bindFilterBar, filterOf, itemTable, TABLE_COLUMNS, can, formDialog, peopleOptions, toast, attempt } from './kit.js';
import { loadViews, viewsFor, pickView, viewPicker, bindViewPicker } from './saved.js';

const PAGE = 50;
const states = new Map();
const SORTS = [['rank', 'Backlog order'], ['due', 'Due date'], ['updated', 'Last changed'], ['created', 'Created'], ['priority', 'Priority'], ['status', 'Status'], ['title', 'Title'], ['owner', 'Owner']];
const stateOf = (key) => states.get(key) || states.set(key, { f: { q: '', owner: '', category: 'open', priority: '', type: '', more: null }, sort: 'rank', dir: 'asc', page: 0, columns: null, view: undefined, dirty: false }).get(key);

export async function renderList(el, scope) {
  const { b, project, cfg } = scope;
  const st = stateOf(project?.id || '');
  const views = viewsFor(await loadViews(), 'list', project?.id);
  if (st.view === undefined) applyView(st, pickView(views, null, b.me));
  const current = views.find((v) => v.id === st.view) || null;
  const defaults = project ? ['key', 'title', 'status', 'owner', 'priority', 'due_date'] : ['key', 'title', 'project', 'status', 'owner', 'due_date'];
  const columns = st.columns || defaults;
  const custom = (cfg?.fields || []).filter((f) => !f.archived_at).map((f) => [`cf.${f.key}`, f.name]);

  let page;
  try {
    page = await pm.search({ project: project?.id, filter: filterOf(st.f), q: st.f.q, sort: st.sort, dir: st.dir, limit: PAGE, offset: st.page * PAGE });
  } catch (err) {
    el.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div><p><button type="button" class="btn" data-reset>Clear the filter</button></p>`;
    el.querySelector('[data-reset]').onclick = () => (states.delete(project?.id || ''), scope.rerender());
    return;
  }
  const pages = Math.max(1, Math.ceil(page.total / PAGE));
  const canBulk = project ? can(b, project.id, 'edit') || can(b, project.id, 'create') : true;

  el.innerHTML = `<div class="pm-toolbar">${viewPicker(b, views, current, { dirty: st.dirty })}
      <div class="card-actions"><label class="inline-field">Sort <select data-sort>${SORTS.map(([k, l]) => `<option value="${k}" ${st.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <button type="button" class="btn btn-sm" data-dir aria-label="Reverse the order">${st.dir === 'asc' ? '↑' : '↓'}</button>
        <button type="button" class="btn btn-sm" data-columns>Columns</button><button type="button" class="btn btn-sm" data-csv>Download</button></div></div>
    ${filterBar(b, st.f, { types: scope.types })}
    <div class="pm-bulk" data-bulk hidden><strong data-count></strong>
      <select data-bulk-priority aria-label="Set priority"><option value="">Priority…</option>${PRIORITIES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
      <select data-bulk-owner aria-label="Set owner"><option value="">Owner…</option>${peopleOptions(b, null, '')}</select>
      <button type="button" class="btn btn-sm" data-bulk-more>More…</button><button type="button" class="btn btn-sm btn-ghost" data-bulk-archive>Archive</button></div>
    <p class="muted small" aria-live="polite">${page.total} item${page.total === 1 ? '' : 's'}${page.total > PAGE ? `, showing ${st.page * PAGE + 1}–${Math.min(page.total, (st.page + 1) * PAGE)}` : ''}</p>
    ${itemTable(b, page.items, scope.cfgOf, { columns, select: canBulk, empty: 'No items match. Change the filter, or add one with "New item".' })}
    ${pages > 1 ? `<nav class="pm-pages" aria-label="Pages"><button type="button" class="btn btn-sm" data-page="${st.page - 1}" ${st.page ? '' : 'disabled'}>← Previous</button>
      <span>Page ${st.page + 1} of ${pages}</span><button type="button" class="btn btn-sm" data-page="${st.page + 1}" ${st.page + 1 < pages ? '' : 'disabled'}>Next →</button></nav>` : ''}`;

  const changed = () => {
    st.page = 0;
    st.dirty = true;
    scope.rerender();
  };
  bindFilterBar(el, b, st.f, changed, { fields: cfg?.fields, statuses: scope.statuses, sprints: cfg?.sprints });
  bindViewPicker(el, { b, kind: 'list', projectId: project?.id, views, current, getConfig: () => ({ filter_state: st.f, sort: st.sort, dir: st.dir, columns }),
    onPick: (v, id) => (applyView(st, v, id), scope.rerender()) });
  el.querySelector('[data-sort]').onchange = (e) => ((st.sort = e.target.value), changed());
  el.querySelector('[data-dir]').onclick = () => ((st.dir = st.dir === 'asc' ? 'desc' : 'asc'), changed());
  el.querySelectorAll('[data-page]').forEach((n) => (n.onclick = () => ((st.page = Number(n.dataset.page)), scope.rerender())));
  el.querySelector('[data-columns]').onclick = async () => {
    const all = [...TABLE_COLUMNS, ...custom];
    const picked = await formDialog({ title: 'Columns', submit: 'Show these',
      body: `<div class="pm-checks">${all.map(([k, l]) => `<label class="pm-check"><input type="checkbox" name="c" value="${esc(k)}" ${columns.includes(k) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>`,
      onSubmit: (f) => [...f.querySelectorAll('[name=c]:checked')].map((n) => n.value) });
    if (Array.isArray(picked) && picked.length) ((st.columns = picked), (st.dirty = true), scope.rerender());
  };
  el.querySelector('[data-csv]').onclick = async () => {
    const all = await attempt(() => pm.searchAll({ project: project?.id, filter: filterOf(st.f), q: st.f.q, sort: st.sort, dir: st.dir }));
    if (all) downloadCsv(b, all.items, scope, `${project?.key || 'projects'}-items.csv`);
  };

  // several at once
  const picked = () => [...el.querySelectorAll('[data-select]:checked')].map((n) => n.dataset.select);
  const bulk = el.querySelector('[data-bulk]');
  const sync = () => {
    bulk.hidden = !picked().length;
    bulk.querySelector('[data-count]').textContent = `${picked().length} selected`;
  };
  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-select-all]')) el.querySelectorAll('[data-select]').forEach((n) => (n.checked = e.target.checked));
    if (e.target.matches('[data-select], [data-select-all]')) sync();
  });
  const apply = async (p) => {
    const res = await attempt(() => pm.bulkUpdate(picked(), p));
    if (!res) return;
    toast(`Changed ${res.changed} item${res.changed === 1 ? '' : 's'}.${res.failed.length ? ` ${res.failed.length} couldn't be changed: ${res.failed.slice(0, 3).map((f) => `${f.key || 'an item'} (${f.error})`).join('; ')}` : ''}`, res.failed.length ? 'bad' : 'ok');
    scope.rerender();
  };
  bulk.querySelector('[data-bulk-priority]').onchange = (e) => e.target.value && apply({ priority: e.target.value });
  bulk.querySelector('[data-bulk-owner]').onchange = (e) => e.target.value && apply({ owner_id: e.target.value });
  bulk.querySelector('[data-bulk-archive]').onclick = () => confirm(`Archive ${picked().length} item(s) and everything under them? They can be restored.`) && apply({ archived: true });
  bulk.querySelector('[data-bulk-more]').onclick = async () => {
    const p = await formDialog({ title: `Change ${picked().length} items`, submit: 'Change them',
      body: `<p class="muted">Only what you fill in is changed.</p><div class="form-grid">
        <div class="field"><label for="bk-start">Start date</label><input id="bk-start" name="start_date" type="date"></div>
        <div class="field"><label for="bk-due">Due date</label><input id="bk-due" name="due_date" type="date"></div>
        <div class="field span-2"><label for="bk-labels">Add labels</label><input id="bk-labels" name="labels" type="text" placeholder="Separate with commas"></div>
        ${cfg?.sprints.some((s) => s.status !== 'closed') ? `<div class="field span-2"><label for="bk-sprint">Sprint</label><select id="bk-sprint" name="sprint"><option value="">Leave as is</option><option value="none">Backlog (no sprint)</option>${cfg.sprints.filter((s) => s.status !== 'closed').map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></div>` : ''}
      </div>`,
      onSubmit: (f) => ({ ...(f.elements.start_date.value ? { start_date: f.elements.start_date.value } : {}), ...(f.elements.due_date.value ? { due_date: f.elements.due_date.value } : {}),
        ...(f.elements.labels.value.trim() ? { add_labels: f.elements.labels.value.split(',').map((x) => x.trim()).filter(Boolean) } : {}),
        ...(f.elements.sprint?.value ? { sprint_id: f.elements.sprint.value === 'none' ? null : f.elements.sprint.value } : {}) }) });
    if (p && Object.keys(p).length) apply(p);
  };
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
}

/** A CSV of items (opens in Excel). Values that could be read as a formula are made plain text. */
function downloadCsv(b, items, scope, name) {
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['Key', 'Title', 'Project', 'Kind', 'Status', 'Priority', 'Owner', 'CE division', 'Subsystem', 'Start', 'Due', 'Estimate (h)', 'Progress %', 'Blocked', 'Labels', 'Finished'];
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
