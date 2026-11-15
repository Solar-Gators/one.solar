/**
 * Projects → Board: a kanban of one project, or of every project I can see. Columns are a saved mapping of
 * statuses (several statuses can share a column; each column can have a work-in-progress limit); swimlanes group
 * the cards. Moving a card (dragging it, or the "Move" menu on the card for phones and keyboards) makes a
 * workflow move through the same rules as anywhere else: a move that needs fields, a comment or an approval
 * opens its dialog, and a move the workflow doesn't have is refused.
 */
import { esc } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { boardColumns, moveTo, rankBetween, PRIORITIES, newId } from '../../projects/core.js';
import { bindKanbanDnd } from '../../kanbanDnd.js';
import { filterBar, bindFilterBar, filterOf, can, formDialog, toast, attempt, runMove, moveSelect, itemHref, typeBadge, avatar, priorityChip, dueChip, personName, fieldInput, readFields, bindOrgPickers } from './kit.js';
import { loadViews, viewsFor, pickView, viewPicker, bindViewPicker } from './saved.js';

const states = new Map();
const stateOf = (key) => states.get(key) || states.set(key, { f: { q: '', owner: '', category: '', priority: '', type: '', more: null }, view: undefined, config: {}, dirty: false, closed: new Set() }).get(key);
const LANES = [['', 'No swimlanes'], ['owner', 'Owner'], ['subsystem', 'Subsystem'], ['priority', 'Priority'], ['parent', 'Parent (epic)'], ['type', 'Kind'], ['project', 'Project']];
const CARD_EXTRAS = [['estimate_hours', 'Estimate'], ['labels', 'Labels'], ['subsystem', 'Subsystem'], ['progress', 'Progress']];

export async function renderBoard(el, scope) {
  const { b, project, cfg } = scope;
  const st = stateOf(project?.id || '');
  const views = viewsFor(await loadViews(), 'board', project?.id);
  if (st.view === undefined) applyView(st, pickView(views, null, b.me));
  const current = views.find((v) => v.id === st.view) || null;
  const columns = boardColumns(st.config, scope.statuses);
  const lane = st.config.swimlane || '';

  // Open work, plus what was finished in the last 30 days (so "Done" doesn't grow for ever).
  const recent = { any: [{ f: 'category', op: 'ne', v: 'done' }, { f: 'completed', op: 'last', v: 30 }] };
  const user = filterOf(st.f);
  const { items, total } = await pm.searchAll({ project: project?.id, filter: { all: [recent, ...(user ? [user] : []), ...(st.config.filter ? [st.config.filter] : [])] }, q: st.f.q, sort: 'rank' }, 2000);
  const byId = new Map(items.map((i) => [i.id, i]));
  const colOf = (i) => columns.findIndex((c) => c.status_ids.includes(i.status_id));

  const laneKey = (i) => (lane === 'owner' ? i.owner_id || '' : lane === 'subsystem' ? i.subsystem_id || i.division_id || '' : lane === 'priority' ? i.priority
    : lane === 'parent' ? i.parent_id || '' : lane === 'type' ? scope.cfgOf(i)?.typeById.get(i.type_id)?.name || '' : lane === 'project' ? i.project_id
    : lane.startsWith('cf.') ? String([].concat(i.custom?.[lane.slice(3)] ?? '')[0] ?? '') : '');
  const laneName = (k) => (lane === 'owner' ? personName(b, k) || 'No owner' : lane === 'subsystem' ? b.subsystemById.get(k)?.name || b.divisionById.get(k)?.name || 'No subsystem'
    : lane === 'priority' ? PRIORITIES.find(([p]) => p === k)?.[1] || k : lane === 'parent' ? (byId.get(k) ? `${byId.get(k).key} · ${byId.get(k).title}` : k ? 'Another item' : 'No parent')
    : lane === 'project' ? b.projectById.get(k)?.name || '' : k || 'None');
  const lanes = lane ? [...new Set(items.map(laneKey))].sort((x, y) => (lane === 'priority' ? PRIORITIES.findIndex(([p]) => p === x) - PRIORITIES.findIndex(([p]) => p === y) : laneName(x).localeCompare(laneName(y)))) : [''];

  const extras = st.config.card_fields || [];
  const card = (i) => {
    const c = scope.cfgOf(i);
    const drag = c && can(b, i.project_id, 'transition');
    const extra = extras.map((k) => {
      if (k === 'estimate_hours') return i.estimate_hours === null ? '' : `<span class="chip">${Number(i.estimate_hours)} h</span>`;
      if (k === 'labels') return (i.labels || []).map((l) => `<span class="chip">${esc(l)}</span>`).join('');
      if (k === 'subsystem') return b.subsystemById.get(i.subsystem_id) ? `<span class="chip">${esc(b.subsystemById.get(i.subsystem_id).name)}</span>` : '';
      if (k === 'progress') return Number(i.progress) ? `<span class="chip">${Number(i.progress)}%</span>` : '';
      const v = i.custom?.[k.slice(3)];
      return v === undefined || v === '' ? '' : `<span class="chip" title="${esc(c?.fields.find((f) => f.key === k.slice(3))?.name || k)}">${esc(Array.isArray(v) ? v.join(', ') : v === true ? '✓' : v)}</span>`;
    }).join('');
    return `<article class="kcard pm-card tone-edge-${esc(c?.typeById.get(i.type_id)?.color || 'gray')}" data-card="${esc(i.id)}" ${drag ? 'draggable="true"' : ''}>
      <div class="kcard-meta"><span>${typeBadge(c?.typeById.get(i.type_id))} <a class="pm-keylink" href="${itemHref(i.key)}">${esc(i.key)}</a></span>${avatar(b, i.owner_id)}</div>
      <a class="kcard-name" href="${itemHref(i.key)}">${esc(i.title)}</a>
      <div class="kcard-tags">${priorityChip(i.priority)}${dueChip(i)}${i.blocked ? `<span class="chip-tone tone-red" title="${esc(i.blocked_reason || 'Blocked')}">⛔ Blocked</span>` : ''}
        ${Number(i.open_deps) ? `<span class="chip-tone tone-amber" title="Waiting on ${i.open_deps} other item(s)">⏳ ${i.open_deps}</span>` : ''}
        ${Number(i.children) ? `<span class="chip" title="Items under it that are done">☑ ${i.children_done}/${i.children}</span>` : ''}${extra}</div>
      <div class="kcard-foot">${drag ? moveSelect(c, i, 'Move…') : ''}${c && (can(b, i.project_id, 'edit') || i.owner_id === b.me) ? `<button type="button" class="btn btn-sm btn-ghost" data-quick="${esc(i.id)}" aria-label="Quick edit ${esc(i.key)}">✎</button>` : ''}</div>
    </article>`;
  };
  const column = (c, ci, laneId) => {
    const list = items.filter((i) => colOf(i) === ci && (!lane || laneKey(i) === laneId));
    const all = items.filter((i) => colOf(i) === ci).length;
    const over = c.wip && all > c.wip;
    const kind = c.status_ids.map((id) => scope.statuses.find((s) => s.id === id)?.category).every((x) => x === 'done') ? 'done' : 'open';
    const addable = project && can(b, project.id, 'create') && !project.archived_at && kind !== 'done';
    return `<section class="kanban-col kind-${kind}${list.length ? '' : ' is-empty'}${over ? ' is-over-wip' : ''}" aria-label="${esc(c.name)}">
      ${laneId === lanes[0] ? `<header><h2>${esc(c.name)}</h2><span class="muted small" title="${c.wip ? `Limit: ${c.wip} at a time` : 'Cards in this column'}">${all}${c.wip ? ` / ${c.wip}` : ''}</span></header>
        ${over ? `<p class="pm-wip-warn" role="status">Over the limit of ${c.wip}: finish something before starting more.</p>` : ''}` : ''}
      <div class="kanban-cards" data-drop="${ci}|${esc(laneId)}">${list.map(card).join('') || '<p class="kanban-empty muted small">Nothing here.</p>'}</div>
      ${addable ? `<form class="kanban-add" data-add="${ci}|${esc(laneId)}"><input type="text" placeholder="+ Add an item" aria-label="Add an item to ${esc(c.name)}" maxlength="200"></form>` : ''}</section>`;
  };
  const stray = items.filter((i) => colOf(i) < 0);

  el.innerHTML = `<div class="pm-toolbar">${viewPicker(b, views, current, { noun: 'board', dirty: st.dirty })}
      <div class="card-actions"><label class="inline-field">Swimlanes <select data-lane>${[...LANES.filter(([k]) => k !== 'project' || !project),
        ...(cfg?.fields || []).filter((f) => !f.archived_at && ['select', 'user', 'checkbox'].includes(f.type)).map((f) => [`cf.${f.key}`, f.name])]
        .map(([k, l]) => `<option value="${esc(k)}" ${lane === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <button type="button" class="btn btn-sm" data-board-settings>Columns &amp; cards</button></div></div>
    ${filterBar(b, st.f, { types: scope.types })}
    ${total > items.length ? `<p class="alert alert-info">Showing the first ${items.length} of ${total} items. Narrow the filter to see the rest.</p>` : ''}
    ${lanes.map((l) => `${lane ? `<details class="pm-lane" ${st.closed.has(l) ? '' : 'open'} data-lane-id="${esc(l)}"><summary>${esc(laneName(l))} <span class="muted">${items.filter((i) => laneKey(i) === l).length}</span></summary>` : ''}
      <div class="kanban pm-kanban">${columns.map((c, ci) => column(c, ci, l)).join('')}</div>${lane ? '</details>' : ''}`).join('')}
    ${stray.length ? `<details class="card"><summary>${stray.length} item${stray.length === 1 ? ' is' : 's are'} in a status that no column shows</summary>
      <ul class="pm-mini">${stray.map((i) => `<li><a href="${itemHref(i.key)}">${esc(i.key)} · ${esc(i.title)}</a> <span class="muted">${esc(scope.statuses.find((s) => s.id === i.status_id)?.name || '')}</span></li>`).join('')}</ul>
      <p class="hint">Add the status to a column in "Columns &amp; cards".</p></details>` : ''}
    ${items.length ? '' : '<div class="empty"><p><strong>No items on this board.</strong></p><p>Add one with "New item", or change the filter.</p></div>'}`;

  const changed = () => ((st.dirty = true), scope.rerender());
  bindFilterBar(el, b, st.f, changed, { fields: cfg?.fields, statuses: scope.statuses, sprints: cfg?.sprints });
  bindViewPicker(el, { b, kind: 'board', projectId: project?.id, views, current, noun: 'board', getConfig: () => ({ ...st.config, columns, filter_state: st.f }),
    onPick: (v, id) => (applyView(st, v, id), scope.rerender()) });
  el.querySelector('[data-lane]').onchange = (e) => ((st.config = { ...st.config, swimlane: e.target.value }), changed());
  el.querySelectorAll('.pm-lane').forEach((d) => d.addEventListener('toggle', () => st.closed[d.open ? 'delete' : 'add'](d.dataset.laneId)));

  /** Put a card in a column (and lane): the workflow move if its status changes, then its place in the column. */
  const move = async (id, dropKey, beforeId) => {
    const item = byId.get(id);
    const [ci, laneId] = [Number(dropKey.split('|')[0]), dropKey.split('|').slice(1).join('|')];
    const c = scope.cfgOf(item);
    const col = columns[ci];
    if (!item || !c || !col) return;
    if (!col.status_ids.includes(item.status_id)) {
      const tr = col.status_ids.map((sid) => moveTo(c, item, sid, c.who)).find(Boolean);
      if (!tr) {
        const from = c.statusById.get(item.status_id)?.name;
        const own = col.status_ids.map((sid) => c.statusById.get(sid)).filter(Boolean);
        return toast(own.length ? `${item.key}: the workflow has no move from "${from}" to "${own.map((s) => s.name).join('" or "')}" that your role can make.`
          : `"${col.name}" has no status that ${c.typeById.get(item.type_id)?.name || 'this kind of'} items use.`, 'bad');
      }
      const res = await runMove(b, c, item, tr);
      if (!res) return;
      if (res.pending) return scope.rerender();
    }
    // its place among the cards it was dropped between, and the lane's value when the lane is something that can be set
    const peers = items.filter((i) => colOf(i) === ci && i.id !== id && (!lane || laneKey(i) === laneId));
    const at = beforeId ? peers.findIndex((i) => i.id === beforeId) : peers.length;
    const patch = { rank: rankBetween(peers[at - 1]?.rank, peers[at]?.rank) };
    if (lane && laneKey(item) !== laneId) {
      if (lane === 'owner') patch.owner_id = laneId || null;
      else if (lane === 'priority') patch.priority = laneId;
      else if (lane === 'parent') patch.parent_id = laneId || null;
    }
    await pm.updateItem(id, null, patch).catch((err) => Object.keys(patch).length > 1 && toast(err.message, 'bad'));
    scope.rerender();
  };
  bindKanbanDnd(el, { onDrop: move });
  el.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-move]');
    if (!sel || !sel.value) return;
    const item = byId.get(sel.dataset.move);
    const c = scope.cfgOf(item);
    const res = await runMove(b, c, item, c.transitions.find((t) => t.id === sel.value));
    sel.value = '';
    if (res) scope.rerender();
  });
  el.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-add]');
    if (!form) return;
    e.preventDefault();
    const title = form.querySelector('input').value.trim();
    if (!title) return;
    const [ci, laneId] = [Number(form.dataset.add.split('|')[0]), form.dataset.add.split('|').slice(1).join('|')];
    const type = cfg.types.find((t) => !t.archived_at && t.level === 1) || cfg.types.find((t) => !t.archived_at);
    const statusId = columns[ci].status_ids.find((sid) => cfg.statusById.get(sid)?.workflow_id === type.workflow_id);
    const made = await attempt(() => pm.createItem(newId(), { project_id: project.id, type_id: type.id, title, status_id: statusId,
      ...(lane === 'owner' && laneId ? { owner_id: laneId } : {}), ...(lane === 'priority' && laneId ? { priority: laneId } : {}), ...(lane === 'parent' && laneId ? { parent_id: laneId } : {}) }));
    if (made) scope.rerender();
  });
  el.addEventListener('click', async (e) => {
    const q = e.target.closest('[data-quick]');
    if (q) {
      const item = byId.get(q.dataset.quick);
      const c = scope.cfgOf(item);
      const full = { ...item, ...(await pm.itemByKey(item.key)) };
      const saved = await formDialog({ title: `${esc(item.key)} · ${esc(item.title)}`, submit: 'Save',
        body: `<div class="field"><label for="qe-title">Title</label><input id="qe-title" name="title" type="text" maxlength="200" required value="${esc(item.title)}"></div>
          <div class="form-grid">${['owner', 'priority', 'due_date', 'estimate_hours', 'blocked'].map((k) => fieldInput(k, { b, cfg: c, item: full })).join('')}</div>
          <p><a href="${itemHref(item.key)}">Open the full item</a></p>`,
        onOpen: bindOrgPickers,
        onSubmit: (f) => pm.updateItem(item.id, full.version, { title: f.elements.title.value.trim(), ...readFields(f, c) }) });
      if (saved) scope.rerender();
    } else if (e.target.closest('[data-board-settings]')) {
      const next = await boardSettings(scope, columns, st.config);
      if (next) ((st.config = next), changed());
    }
  });
}

function applyView(st, v, id = null) {
  st.view = v?.id || id || 'none';
  st.dirty = false;
  st.config = v ? { ...v.config } : {};
  Object.assign(st.f, { q: '', owner: '', category: '', priority: '', type: '', more: null }, v?.config.filter_state || {});
}

/** Columns (name, which statuses, limit), in order, and what the cards show. Returns the new board config or null. */
function boardSettings(scope, columns, config) {
  const model = columns.map((c) => ({ ...c, status_ids: [...c.status_ids] }));
  // statuses are offered by name: across projects, every status with that name goes with it
  const names = [...new Map(scope.statuses.map((s) => [s.name.trim().toLowerCase(), s.name])).entries()];
  const idsOf = (key) => scope.statuses.filter((s) => s.name.trim().toLowerCase() === key).map((s) => s.id);
  const draw = (form) => {
    const used = (key, ci) => model.some((c, i) => i !== ci && idsOf(key).some((id) => c.status_ids.includes(id)));
    form.querySelector('[data-cols]').innerHTML = model.map((c, ci) => `<fieldset class="pm-section pm-col-edit" data-ci="${ci}">
      <div class="pm-col-head"><input type="text" data-col-name value="${esc(c.name)}" maxlength="40" aria-label="Column name" required>
        <label class="inline-field">Limit <input type="number" data-col-wip min="0" value="${esc(c.wip || '')}" placeholder="none" aria-label="Work-in-progress limit"></label>
        <button type="button" class="btn btn-sm btn-ghost" data-up ${ci ? '' : 'disabled'} aria-label="Move left">←</button><button type="button" class="btn btn-sm btn-ghost" data-down ${ci < model.length - 1 ? '' : 'disabled'} aria-label="Move right">→</button>
        <button type="button" class="btn btn-sm btn-ghost" data-remove aria-label="Remove column">Remove</button></div>
      <div class="pm-checks">${names.map(([key, name]) => `<label class="pm-check${used(key, ci) ? ' is-used' : ''}"><input type="checkbox" data-col-status="${esc(key)}" ${idsOf(key).some((id) => c.status_ids.includes(id)) ? 'checked' : ''}> ${esc(name)}</label>`).join('')}</div></fieldset>`).join('');
    const missing = names.filter(([key]) => !model.some((c) => idsOf(key).some((id) => c.status_ids.includes(id)))).map(([, n]) => n);
    form.querySelector('[data-missing]').textContent = missing.length ? `Not on the board: ${missing.join(', ')}. Items in these statuses won't show in a column.` : '';
  };
  const extras = [...CARD_EXTRAS, ...scope.fields.filter((f) => !f.archived_at && f.type !== 'formula' && f.type !== 'longtext' && f.type !== 'richtext').map((f) => [`cf.${f.key}`, f.name])];
  return formDialog({
    title: 'Columns and cards', submit: 'Apply', wide: true,
    body: `<p class="muted">A column can hold several statuses. A limit warns when a column has too much in it at once. Apply, then "Save" or "Save as…" to keep it.</p>
      <div data-cols></div><p class="hint" data-missing></p><p><button type="button" class="btn btn-sm" data-add-col>+ Column</button></p>
      <fieldset class="pm-section"><legend>Also show on each card</legend><div class="pm-checks">${extras.map(([k, l]) => `<label class="pm-check"><input type="checkbox" name="extra" value="${esc(k)}" ${(config.card_fields || []).includes(k) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div></fieldset>`,
    onOpen(form) {
      draw(form);
      form.addEventListener('input', (e) => {
        const ci = Number(e.target.closest('[data-ci]')?.dataset.ci);
        if (e.target.matches('[data-col-name]')) model[ci].name = e.target.value;
        if (e.target.matches('[data-col-wip]')) model[ci].wip = Number(e.target.value) || null;
      });
      form.addEventListener('change', (e) => {
        if (!e.target.matches('[data-col-status]')) return;
        const ci = Number(e.target.closest('[data-ci]').dataset.ci);
        const ids = idsOf(e.target.dataset.colStatus);
        model.forEach((c, i) => (c.status_ids = c.status_ids.filter((id) => !ids.includes(id) || (i === ci && e.target.checked))));
        if (e.target.checked) model[ci].status_ids.push(...ids.filter((id) => !model[ci].status_ids.includes(id)));
        draw(form);
      });
      form.addEventListener('click', (e) => {
        const t = e.target.closest('button');
        const ci = Number(t?.closest('[data-ci]')?.dataset.ci);
        if (!t) return;
        if (t.dataset.addCol !== undefined) model.push({ name: 'New column', wip: null, status_ids: [] });
        else if (t.dataset.remove !== undefined) model.splice(ci, 1);
        else if (t.dataset.up !== undefined) model.splice(ci - 1, 0, model.splice(ci, 1)[0]);
        else if (t.dataset.down !== undefined) model.splice(ci + 1, 0, model.splice(ci, 1)[0]);
        else return;
        draw(form);
      });
    },
    onSubmit(form) {
      if (!model.length) throw new Error('A board needs at least one column.');
      return { ...config, columns: model.map((c) => ({ name: c.name.trim() || 'Column', wip: c.wip, status_ids: c.status_ids })), card_fields: [...form.querySelectorAll('[name=extra]:checked')].map((n) => n.value) };
    },
  });
}
