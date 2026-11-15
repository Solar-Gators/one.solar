/**
 * Projects → Backlog: unfinished work in priority order. Drag rows (or use the arrows / "Move to" menu) to
 * reorder; estimate and assign in place. Sprints are optional: a project that works as a continuous board never
 * needs them; one that plans in cycles turns them on here and moves items from the backlog into a sprint.
 */
import { esc, fmtDate } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { rankBetween, newId } from '../../projects/core.js';
import { todayISO } from '../../projects/schedule.js';
import { bindKanbanDnd } from '../../kanbanDnd.js';
import { filterBar, bindFilterBar, filterOf, can, formDialog, attempt, toast, itemHref, typeBadge, statusChip, priorityChip, dueChip, peopleOptions, loadConfig, invalidate } from './kit.js';

const states = new Map();
const stateOf = (key) => states.get(key) || states.set(key, { f: { q: '', owner: '', category: '', priority: '', type: '', more: null }, group: '' }).get(key);

export async function renderBacklog(el, scope) {
  const { b, project, cfg } = scope;
  const st = stateOf(project.id);
  const plan = can(b, project.id, 'plan') && !project.archived_at;
  const edit = can(b, project.id, 'edit') && !project.archived_at;
  const user = filterOf(st.f);
  const { items, total } = await pm.searchAll({ project: project.id, filter: { all: [{ f: 'category', op: 'ne', v: 'done' }, ...(user ? [user] : [])] }, q: st.f.q, sort: 'rank' }, 2000);
  const sprintsOn = !!project.settings.sprints || cfg.sprints.some((s) => s.status !== 'closed');
  const open = cfg.sprints.filter((s) => s.status !== 'closed').sort((a, c) => (a.status === 'active' ? -1 : c.status === 'active' ? 1 : (a.start_date || '9') < (c.start_date || '9') ? -1 : 1));
  const closed = cfg.sprints.filter((s) => s.status === 'closed').sort((a, c) => (a.closed_at < c.closed_at ? 1 : -1));
  const inList = (sprintId) => items.filter((i) => (i.sprint_id || '') === sprintId && (sprintId || !open.some((s) => s.id === i.sprint_id)));
  const hours = (list) => list.reduce((s, i) => s + (Number(i.estimate_hours) || 0), 0);
  const titleOf = new Map(items.map((i) => [i.id, i]));

  const row = (i, n, list) => `<li class="pm-bl-row" data-card="${esc(i.id)}" ${plan || edit ? 'draggable="true"' : ''}>
    <span class="pm-bl-grip" aria-hidden="true">⋮⋮</span>
    <div class="pm-bl-main">${typeBadge(cfg.typeById.get(i.type_id))} <a class="pm-keylink" href="${itemHref(i.key)}">${esc(i.key)}</a> <a href="${itemHref(i.key)}">${esc(i.title)}</a>
      ${statusChip(cfg.statusById.get(i.status_id))} ${priorityChip(i.priority)} ${dueChip(i)}${i.blocked ? ' <span class="chip-tone tone-red">⛔</span>' : ''}</div>
    ${edit ? `<input class="pm-bl-est" type="number" min="0" step="any" value="${esc(i.estimate_hours ?? '')}" placeholder="h" data-est="${esc(i.id)}" aria-label="Estimate in hours for ${esc(i.key)}" title="Estimate (hours)">
      <select class="pm-bl-owner" data-owner="${esc(i.id)}" aria-label="Owner of ${esc(i.key)}">${peopleOptions(b, i.owner_id, 'No owner')}</select>`
      : `<span class="muted small">${i.estimate_hours === null ? '' : `${Number(i.estimate_hours)} h`}</span>`}
    ${plan || edit ? `<span class="pm-bl-move"><button type="button" class="btn btn-sm btn-ghost" data-up="${esc(i.id)}" ${n ? '' : 'disabled'} aria-label="Move ${esc(i.key)} up">↑</button>
      <button type="button" class="btn btn-sm btn-ghost" data-down="${esc(i.id)}" ${n < list.length - 1 ? '' : 'disabled'} aria-label="Move ${esc(i.key)} down">↓</button>
      <select data-send="${esc(i.id)}" aria-label="Move ${esc(i.key)} to"><option value="">Move to…</option><option value="top">Top of this list</option><option value="bottom">Bottom of this list</option>
        ${plan && sprintsOn ? `${i.sprint_id ? '<option value="sprint:">Backlog</option>' : ''}${open.filter((s) => s.id !== i.sprint_id).map((s) => `<option value="sprint:${esc(s.id)}">${esc(s.name)}</option>`).join('')}` : ''}</select></span>` : ''}</li>`;
  const listHtml = (sprintId, list) => {
    if (st.group === 'parent' && list.length) {
      const groups = [...new Set(list.map((i) => i.parent_id || ''))];
      return groups.map((g) => `<li class="pm-bl-group">${g ? `${esc(titleOf.get(g)?.key || '')} ${esc(titleOf.get(g)?.title || 'Another item')}` : 'No parent'}</li>${list.filter((i) => (i.parent_id || '') === g).map(row).join('')}`).join('');
    }
    return list.map(row).join('') || '<li class="muted pm-bl-empty">Nothing here. Drag items in, or use an item\'s "Move to…" menu.</li>';
  };
  const sprintBox = (s) => {
    const list = inList(s.id);
    return `<section class="card pm-sprint ${s.status === 'active' ? 'is-active' : ''}" data-sprint="${esc(s.id)}">
      <div class="pm-sprint-head"><h2>${esc(s.name)} ${s.status === 'active' ? '<span class="chip-tone tone-green">Running</span>' : '<span class="chip-tone tone-gray">Planned</span>'}</h2>
        <span class="muted small">${s.start_date ? `${esc(fmtDate(s.start_date))} – ${esc(fmtDate(s.end_date || s.start_date))} · ` : ''}${list.length} item${list.length === 1 ? '' : 's'} · ${hours(list)} h estimated</span>
        ${plan ? `<span class="card-actions"><button type="button" class="btn btn-sm btn-ghost" data-edit-sprint>Edit</button>${s.status === 'planned' ? '<button type="button" class="btn btn-sm" data-start-sprint>Start</button>' : '<button type="button" class="btn btn-sm btn-primary" data-close-sprint>Close sprint</button>'}</span>` : ''}</div>
      ${s.goal ? `<p class="muted">Goal: ${esc(s.goal)}</p>` : ''}
      <ul class="pm-bl" data-drop="${esc(s.id)}">${listHtml(s.id, list)}</ul></section>`;
  };
  const backlog = inList('');

  el.innerHTML = `<div class="pm-toolbar"><div class="card-actions"><label class="inline-field">Group by <select data-group><option value="">Nothing</option><option value="parent" ${st.group === 'parent' ? 'selected' : ''}>Parent (epic)</option></select></label></div>
      <div class="card-actions">${plan ? (sprintsOn ? '<button type="button" class="btn" data-new-sprint>New sprint</button>' : '<button type="button" class="btn" data-sprints-on title="Plan work in cycles of a week or two. Optional.">Use sprints</button>') : ''}</div></div>
    ${filterBar(b, st.f, { types: cfg.types })}
    ${total > items.length ? `<p class="alert alert-info">Showing the first ${items.length} of ${total} open items. Narrow the filter to see the rest.</p>` : ''}
    ${sprintsOn ? open.map(sprintBox).join('') : ''}
    <section class="card"><div class="pm-sprint-head"><h2>Backlog</h2><span class="muted small">${backlog.length} item${backlog.length === 1 ? '' : 's'} · ${hours(backlog)} h estimated${backlog.some((i) => i.estimate_hours === null) ? ` · ${backlog.filter((i) => i.estimate_hours === null).length} without an estimate` : ''}</span></div>
      ${can(b, project.id, 'create') && !project.archived_at ? '<form data-quick-add class="pm-inline-add"><input type="text" maxlength="200" placeholder="+ Add to the backlog (press Enter)" aria-label="Add an item to the backlog"></form>' : ''}
      <ul class="pm-bl" data-drop="">${listHtml('', backlog)}</ul></section>
    ${closed.length ? `<details class="card"><summary>Finished sprints (${closed.length})</summary>${closed.map((s) => `<div class="pm-sprint-done"><strong>${esc(s.name)}</strong> <span class="muted small">closed ${esc(fmtDate(s.closed_at))}</span>
      <div>${(s.summary?.done || []).length} finished, ${(s.summary?.carried || []).length} carried over${s.goal ? ` · Goal: ${esc(s.goal)}` : ''}</div>
      ${(s.summary?.done || []).length ? `<div class="muted small">Finished: ${s.summary.done.map((d) => esc(d.key)).join(', ')}</div>` : ''}</div>`).join('')}</details>` : ''}`;

  const again = () => scope.rerender();
  const reload = async () => (invalidate(project.id), await loadConfig(b, project.id), again());
  bindFilterBar(el, b, st.f, again, { fields: cfg.fields, statuses: cfg.statuses, sprints: cfg.sprints });
  el.querySelector('[data-group]').onchange = (e) => ((st.group = e.target.value), again());

  /** Put an item in a list (a sprint, or '' for the backlog) before another item (or at the end). */
  const place = async (id, sprintId, beforeId, atTop = false) => {
    const item = items.find((i) => i.id === id);
    const list = inList(sprintId).filter((i) => i.id !== id);
    const at = atTop ? 0 : beforeId ? list.findIndex((i) => i.id === beforeId) : list.length;
    const patch = { rank: rankBetween(list[at - 1]?.rank, list[at]?.rank) };
    if ((item.sprint_id || '') !== sprintId) patch.sprint_id = sprintId || null;
    if (await attempt(() => pm.updateItem(id, null, patch))) again();
  };
  bindKanbanDnd(el, { card: '.pm-bl-row', onDrop: (id, sprintId, beforeId) => place(id, sprintId, beforeId) });
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const id = t.dataset.up || t.dataset.down;
    if (id) {
      const item = items.find((i) => i.id === id);
      const list = inList(item.sprint_id && open.some((s) => s.id === item.sprint_id) ? item.sprint_id : '');
      const n = list.findIndex((i) => i.id === id);
      return place(id, item.sprint_id && open.some((s) => s.id === item.sprint_id) ? item.sprint_id : '', t.dataset.up ? list[n - 1].id : list[n + 2]?.id);
    }
    const sprint = cfg.sprints.find((s) => s.id === t.closest('[data-sprint]')?.dataset.sprint);
    if (t.dataset.sprintsOn !== undefined) (await attempt(() => pm.saveProject(project.id, { settings: { sprints: true } }), 'Sprints are on for this project.')) && (invalidate(), again());
    else if (t.dataset.newSprint !== undefined || t.dataset.editSprint !== undefined) (await sprintDialog(project, sprint, cfg.sprints.length)) && reload();
    else if (t.dataset.startSprint !== undefined) (await attempt(() => pm.saveSprint(project.id, sprint.id, { status: 'active' }), `${sprint.name} has started.`)) && reload();
    else if (t.dataset.closeSprint !== undefined) {
      const left = inList(sprint.id);
      const res = await formDialog({ title: `Close ${esc(sprint.name)}`, submit: 'Close sprint',
        body: `<p>${left.length ? `${left.length} item${left.length === 1 ? ' isn\'t' : 's aren\'t'} finished.` : 'Everything in it is finished.'} A summary of what was done is kept.</p>
          ${left.length ? `<div class="field"><label for="cs-to">Move unfinished items to</label><select id="cs-to" name="to"><option value="">The backlog</option>${open.filter((s) => s.id !== sprint.id).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></div>` : ''}`,
        onSubmit: (f) => pm.saveSprint(project.id, sprint.id, { status: 'closed', move_to: f.elements.to?.value || null }) });
      if (res) (toast(`${sprint.name} is closed.`), reload());
    }
  });
  el.addEventListener('change', async (e) => {
    const d = e.target.dataset;
    if (d.est) await attempt(() => pm.updateItem(d.est, null, { estimate_hours: e.target.value === '' ? null : Number(e.target.value) }));
    else if (d.owner) await attempt(() => pm.updateItem(d.owner, null, { owner_id: e.target.value || null }));
    else if (d.send && e.target.value) {
      const item = items.find((i) => i.id === d.send);
      const here = item.sprint_id && open.some((s) => s.id === item.sprint_id) ? item.sprint_id : '';
      if (e.target.value === 'top') return place(d.send, here, null, true);
      if (e.target.value === 'bottom') return place(d.send, here, null);
      return place(d.send, e.target.value.slice(7), null);
    } else return;
    if (d.est) again();
  });
  el.querySelector('[data-quick-add]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = e.target.querySelector('input').value.trim();
    const type = cfg.types.find((t) => !t.archived_at && t.level === 1) || cfg.types.find((t) => !t.archived_at);
    if (title && (await attempt(() => pm.createItem(newId(), { project_id: project.id, type_id: type.id, title })))) again();
  });
}

function sprintDialog(project, sprint, count) {
  const days = Number(project.settings.sprint_days) || 14;
  const start = sprint?.start_date || todayISO();
  const end = sprint?.end_date || new Date(Date.parse(start) + (days - 1) * 864e5).toISOString().slice(0, 10);
  return formDialog({ title: sprint ? `Edit ${esc(sprint.name)}` : 'New sprint', submit: 'Save',
    body: `<div class="field"><label for="sp-name">Name</label><input id="sp-name" name="name" type="text" maxlength="80" required value="${esc(sprint?.name || `Sprint ${count + 1}`)}"></div>
      <div class="form-grid"><div class="field span-2"><label for="sp-start">Starts</label><input id="sp-start" name="start" type="date" value="${esc(start)}"></div>
        <div class="field span-2"><label for="sp-end">Ends</label><input id="sp-end" name="end" type="date" value="${esc(end)}"><div class="hint">${days} days by default (change it in Settings → Details).</div></div></div>
      <div class="field"><label for="sp-goal">Goal (optional)</label><textarea id="sp-goal" name="goal" rows="2">${esc(sprint?.goal || '')}</textarea></div>
      ${sprint?.status === 'planned' ? '<label class="pm-check"><input type="checkbox" name="delete"> Delete this sprint (its items go back to the backlog)</label>' : ''}`,
    onSubmit: (f) => pm.saveSprint(project.id, sprint?.id || null, f.elements.delete?.checked ? { delete: true }
      : { name: f.elements.name.value.trim(), start_date: f.elements.start.value, end_date: f.elements.end.value, goal: f.elements.goal.value }).then((r) => r ?? true) });
}
