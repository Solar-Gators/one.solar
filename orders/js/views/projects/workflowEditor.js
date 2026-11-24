/**
 * Projects → Settings → Workflows: the workflow editor.
 *
 * A drawing of the statuses (drag them around; arrows are the allowed moves), a list of statuses (name, category,
 * colour, order) and of moves with their rules: who may make the move, which fields and whether a comment are
 * required, whether it needs approval, conditions, and what happens right after. Nothing is saved until "Save":
 * the save is previewed first, a status that still has items in it has to be given a replacement, and every
 * saved version is kept so an earlier one can be brought back.
 */
import { esc, fmtDateTime } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { CATEGORIES, TONES, REQUIRABLE, newId, fieldLabel, filterText, unreachableStatuses } from '../../projects/core.js';
import { formDialog, toast, conditionDialog, personName, invalidate, loadConfig, can } from './kit.js';
import { guardLeaving, releaseGuard } from '../../leaveGuard.js';
import { helpOpen } from '../../../../shared/help.js';

const NODE = { w: 150, h: 46 };

/** The rows of an "actions" editor (used for a move's follow-up actions and for automation rules). */
export function actionsEditor(b, cfg, actions) {
  const model = actions.map((a) => ({ ...a }));
  const who = (v, extra = []) => [...extra, ['owner', 'The item\'s owner'], ['reporter', 'Whoever created it'], ['lead', 'The project manager'], ['actor', 'Whoever triggered the rule'],
    ...b.people.map((p) => [p.id, p.full_name || p.email])].map(([k, l]) => `<option value="${esc(k)}" ${v === k ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const TYPES = [['notify', 'Send a notice'], ['comment', 'Add a comment'], ['set_status', 'Move it to a status'], ['assign', 'Assign it'], ['set_field', 'Set a field'], ['add_label', 'Add a label'],
    ['add_watcher', 'Add a watcher'], ['create_item', 'Create an item'], ['move_parent', 'Move its parent (once everything under it is done)'], ['move_children', 'Move the open items under it']];
  const settable = [['priority', 'Priority'], ['due_date', 'Due date'], ['start_date', 'Start date'], ['blocked', 'Blocked'], ['progress', 'Progress %'], ['estimate_hours', 'Estimate (hours)'],
    ...cfg.fields.filter((f) => !f.archived_at && f.type !== 'formula').map((f) => [`cf.${f.key}`, f.name])];
  const params = (a, n) => {
    const at = (k) => `data-a="${n}" data-k="${k}"`;
    switch (a.type) {
      case 'notify': return `<select ${at('to')} aria-label="Who">${who(a.to || 'owner', [['watchers', 'Everyone on the item']])}</select><input type="text" ${at('message')} value="${esc(a.message || '')}" placeholder="Message. {key}, {title}, {status}, {owner}, {due} are filled in" aria-label="Message">`;
      case 'comment': return `<input type="text" ${at('text')} value="${esc(a.text || '')}" placeholder="Comment text. {key}, {title}, {owner}… are filled in" aria-label="Comment">`;
      case 'set_status': case 'move_parent': case 'move_children': return `<select ${at('status')} aria-label="Status">${cfg.statuses.map((s) => `<option value="${esc(s.id)}" ${a.status === s.id ? 'selected' : ''}>${esc(s.name)}${cfg.workflows.length > 1 ? ` (${esc(cfg.workflows.find((w) => w.id === s.workflow_id)?.name || '')})` : ''}</option>`).join('')}</select>`;
      case 'assign': return `<select ${at('user')} aria-label="Who">${who(a.user || 'lead', [['none', 'Nobody (clear the owner)']])}</select>`;
      case 'add_watcher': return `<select ${at('user')} aria-label="Who">${who(a.user || 'lead')}</select>`;
      case 'add_label': return `<input type="text" ${at('label')} maxlength="40" value="${esc(a.label || '')}" placeholder="Label" aria-label="Label">`;
      case 'set_field': {
        const isDate = ['due_date', 'start_date'].includes(a.field);
        return `<select ${at('field')} aria-label="Field">${settable.map(([k, l]) => `<option value="${esc(k)}" ${a.field === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
          ${isDate ? `<input type="number" ${at('days')} value="${esc(a.value?.days ?? 7)}" aria-label="Days from today" style="width:90px"> <span class="muted small">days from that day</span>`
            : `<input type="text" ${at('value')} value="${esc(typeof a.value === 'object' ? '' : a.value ?? '')}" placeholder="${a.field === 'blocked' ? 'true or false' : 'Value'}" aria-label="Value">`}`;
      }
      case 'create_item': return `<select ${at('type_id')} aria-label="Kind">${cfg.types.filter((t) => !t.archived_at).map((t) => `<option value="${esc(t.id)}" ${a.type_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
        <input type="text" ${at('title')} value="${esc(a.title || '')}" placeholder="Title. {title} is the title of the item that triggered the rule" aria-label="Title">
        <select ${at('owner')} aria-label="Owner">${who(a.owner || 'none', [['none', 'No owner']])}</select>
        <input type="number" ${at('due_in_days')} value="${esc(a.due_in_days ?? '')}" placeholder="Due in … days" aria-label="Due in days" style="width:120px">`;
      default: return '';
    }
  };
  const html = () => `${model.map((a, n) => `<div class="pm-cond-row pm-action" data-n="${n}"><select data-a="${n}" data-k="type" aria-label="Action">${TYPES.map(([k, l]) => `<option value="${k}" ${a.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${params(a, n)}<button type="button" class="btn btn-sm btn-ghost" data-del-action="${n}" aria-label="Remove action">✕</button></div>`).join('')}
    <button type="button" class="btn btn-sm" data-add-action>+ Action</button>`;
  const defaults = (type) => ({ notify: { to: 'owner', message: '' }, comment: { text: '' }, set_status: { status: cfg.statuses[0]?.id }, assign: { user: 'lead' }, add_watcher: { user: 'lead' },
    add_label: { label: '' }, move_parent: { status: (cfg.statuses.find((s) => s.category === 'done') || cfg.statuses[0])?.id }, move_children: { status: (cfg.statuses.find((s) => s.category === 'done') || cfg.statuses[0])?.id }, set_field: { field: 'priority', value: 'high' }, create_item: { type_id: cfg.types.find((t) => !t.archived_at)?.id, title: '', owner: 'none' } }[type]);
  return {
    html: () => `<div data-actions>${html()}</div>`,
    bind(root) {
      const box = root.querySelector('[data-actions]');
      const draw = () => (box.innerHTML = html());
      box.addEventListener('change', (e) => {
        const { a, k } = e.target.dataset;
        if (a === undefined) return;
        const row = model[Number(a)];
        if (k === 'type') (model[Number(a)] = { type: e.target.value, ...defaults(e.target.value) }, draw());
        else if (k === 'days') row.value = { days: Number(e.target.value) || 0 };
        else if (k === 'due_in_days') e.target.value === '' ? delete row.due_in_days : (row.due_in_days = Number(e.target.value));
        else if (k === 'field') ((row.field = e.target.value), (row.value = ['due_date', 'start_date'].includes(e.target.value) ? { days: 7 } : ''), draw());
        else row[k] = e.target.value;
      });
      box.addEventListener('input', (e) => {
        const { a, k } = e.target.dataset;
        if (a !== undefined && e.target.tagName === 'INPUT' && !['days', 'due_in_days'].includes(k)) model[Number(a)][k] = e.target.value;
      });
      box.addEventListener('click', (e) => {
        if (e.target.closest('[data-add-action]')) (model.push({ type: 'notify', ...defaults('notify') }), draw());
        const del = e.target.closest('[data-del-action]');
        if (del) (model.splice(Number(del.dataset.delAction), 1), draw());
      });
    },
    read: () => model.map((a) => (a.type === 'set_field' && a.field === 'blocked' ? { ...a, value: String(a.value) === 'true' } : a.type === 'set_field' && ['progress', 'estimate_hours'].includes(a.field) ? { ...a, value: Number(a.value) || 0 } : a)),
  };
}

export function workflowSvg(m, { current = null } = {}) {
  const w = Math.max(640, ...m.statuses.map((s) => s.x + NODE.w + 60));
  const h = Math.max(200, ...m.statuses.map((s) => s.y + NODE.h + 60));
  const center = (s) => [s.x + NODE.w / 2, s.y + NODE.h / 2];
  // where the line from a to b leaves a's box
  const edge = (a, to) => {
    const [cx, cy] = center(a);
    const [dx, dy] = [to[0] - cx, to[1] - cy];
    const k = Math.min(NODE.w / 2 / Math.abs(dx || 1e-6), NODE.h / 2 / Math.abs(dy || 1e-6));
    return [cx + dx * k, cy + dy * k];
  };
  const pairs = new Set(m.transitions.filter((t) => t.from_status).map((t) => `${t.from_status}>${t.to_status}`));
  const lines = m.transitions.map((t) => {
    const to = m.statuses.find((s) => s.id === t.to_status);
    const from = m.statuses.find((s) => s.id === t.from_status);
    if (!to) return '';
    if (!from) { // from any status: a short stub into the box from above
      const [cx] = center(to);
      return `<path class="pm-wf-line is-any" d="M${cx} ${to.y - 26} V${to.y - 2}" marker-end="url(#pm-wf-tip)"><title>${esc(t.name)}: from any status</title></path><text class="pm-wf-any" x="${cx}" y="${to.y - 30}" text-anchor="middle">any</text>`;
    }
    const both = pairs.has(`${t.to_status}>${t.from_status}`);
    const [a, z] = [edge(from, center(to)), edge(to, center(from))];
    // two-way moves bend apart so both arrows show
    const [mx, my] = [(a[0] + z[0]) / 2, (a[1] + z[1]) / 2];
    const [nx, ny] = [-(z[1] - a[1]), z[0] - a[0]];
    const len = Math.hypot(nx, ny) || 1;
    const bend = both ? 22 : 0;
    return `<path class="pm-wf-line${t.require_approval ? ' is-gate' : ''}" d="M${a[0]} ${a[1]} Q${mx + (nx / len) * bend} ${my + (ny / len) * bend} ${z[0]} ${z[1]}" marker-end="url(#pm-wf-tip)"><title>${esc(t.name)}: ${esc(from.name)} → ${esc(to.name)}${t.require_approval ? ' (needs approval)' : ''}</title></path>`;
  }).join('');
  return `<svg class="pm-wf-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Workflow drawing: ${esc(m.statuses.map((s) => s.name).join(', '))}">
    <defs><marker id="pm-wf-tip" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 L8 4 L0 8 z"/></marker></defs>${lines}
    ${m.statuses.map((s, n) => `<g class="pm-wf-node is-${esc(s.category)}${s.id === current ? ' is-current' : ''}" data-node="${esc(s.id)}" transform="translate(${s.x} ${s.y})"><rect width="${NODE.w}" height="${NODE.h}" rx="9"/>
      <text x="${NODE.w / 2}" y="20" text-anchor="middle">${esc(s.name.length > 18 ? `${s.name.slice(0, 17)}…` : s.name)}</text>
      <text class="pm-wf-cat" x="${NODE.w / 2}" y="36" text-anchor="middle">${esc(CATEGORIES.find(([k]) => k === s.category)[1])}${n === 0 ? ' · new items start here' : ''}</text></g>`).join('')}</svg>`;
}

/** "View workflow" from an item's status menu: the drawing with the item's status marked, where it can go from here, and who may change the workflow. */
export async function showWorkflow(b, cfg, item) {
  const type = cfg.typeById?.get(item.type_id) || cfg.types.find((t) => t.id === item.type_id);
  const wf = cfg.workflows.find((w) => w.id === type?.workflow_id);
  if (!wf) return toast('This kind of work has no workflow.', 'bad');
  const m = { statuses: cfg.statuses.filter((s) => s.workflow_id === wf.id).sort((x, y) => x.sort - y.sort).map((s) => ({ ...s })),
    transitions: cfg.transitions.filter((t) => t.workflow_id === wf.id) };
  if (m.statuses.every((s) => !s.x && !s.y)) m.statuses.forEach((s, n) => Object.assign(s, { x: 40 + n * 190, y: 70 }));
  const name = (id) => m.statuses.find((s) => s.id === id)?.name || 'Any status';
  const here = m.transitions.filter((t) => (t.from_status || item.status_id) === item.status_id && t.to_status !== item.status_id);
  const editors = cfg.roles.filter((r) => r.caps?.includes('workflows')).map((r) => r.name);
  const mayEdit = can(b, item.project_id, 'workflows');
  const project = b.projectById?.get(item.project_id);
  await formDialog({ title: `Workflow: ${esc(wf.name)}`, submit: '', wide: true,
    body: `<p class="muted small">Used by ${esc(type.name)}${wf.description ? ` · ${esc(wf.description)}` : ''}. ${esc(item.key)} is in <strong>${esc(name(item.status_id))}</strong> (outlined).</p>
      <div class="pm-wf-canvas">${workflowSvg(m, { current: item.status_id })}</div>
      <h3>From here it can go to</h3>
      ${here.length ? `<ul class="pm-mini">${here.map((t) => `<li><strong>${esc(name(t.to_status))}</strong>${t.name !== name(t.to_status) && !/^(Move to|Back to) /.test(t.name) ? ` <span class="muted">(${esc(t.name)})</span>` : ''}
        ${[t.role_ids?.length && `only ${t.role_ids.map((id) => cfg.roles.find((r) => r.id === id)?.name).filter(Boolean).join(' / ')}`, t.require_approval && 'needs approval', t.require_comment && 'asks for a comment',
          t.require_fields?.length && `needs ${t.require_fields.map((k) => fieldLabel(k, cfg.fields)).join(', ')}`].filter(Boolean).map((x) => ` · <span class="muted small">${esc(x)}</span>`).join('')}</li>`).join('')}</ul>` : '<p class="muted">Nowhere: no move leads out of this status.</p>'}
      <p class="hint">Who can change this workflow: ${esc(editors.join(', ') || 'Project Administrators')} (Settings → Workflows)${mayEdit && project ? `. <a href="#/projects/p/${encodeURIComponent(project.key)}/settings/workflows/${esc(wf.id)}">Edit it</a>` : ''}.</p>`,
    onOpen(form, dialog) { form.querySelector('[data-cancel]').textContent = 'Close'; form.addEventListener('click', (e) => e.target.closest('a[href]') && dialog.close()); },
  });
}

export async function renderWorkflows(el, scope) {
  const { b, project, cfg } = scope;
  const flows = cfg.workflows.filter((w) => !w.archived_at);
  const wfId = scope.params.sub2 && flows.some((w) => w.id === scope.params.sub2) ? scope.params.sub2 : scope.params.sub2 === 'new' ? null : flows[0]?.id;
  const wf = flows.find((w) => w.id === wfId) || null;
  // the editor's working copy
  const m = {
    name: wf?.name || 'New workflow', description: wf?.description || '',
    statuses: wf ? cfg.statuses.filter((s) => s.workflow_id === wf.id).map((s) => ({ ...s })) : [
      { id: newId(), name: 'To Do', category: 'todo', color: 'gray', sort: 10, x: 40, y: 70 }, { id: newId(), name: 'Done', category: 'done', color: 'green', sort: 20, x: 260, y: 70 }],
    transitions: wf ? cfg.transitions.filter((t) => t.workflow_id === wf.id).map((t) => ({ ...t })) : [],
  };
  if (!wf) m.transitions = m.statuses.map((s, n) => ({ id: newId(), name: s.name, from_status: null, to_status: s.id, sort: (n + 1) * 10 }));
  m.statuses.sort((x, y) => x.sort - y.sort);
  if (m.statuses.every((s) => !s.x && !s.y)) m.statuses.forEach((s, n) => Object.assign(s, { x: 40 + n * 190, y: 70 }));
  let dirty = false;
  const versions = wf ? await pm.workflowVersions(wf.id).catch(() => []) : [];
  const usedBy = wf ? cfg.types.filter((t) => t.workflow_id === wf.id && !t.archived_at) : [];
  const sName = (id) => m.statuses.find((s) => s.id === id)?.name || 'Any status';

  const svg = () => workflowSvg(m);
  const rules = (t) => [t.role_ids?.length ? `only ${t.role_ids.map((id) => cfg.roles.find((r) => r.id === id)?.name).filter(Boolean).join(' / ')}` : '',
    t.require_fields?.length ? `needs ${t.require_fields.map((k) => fieldLabel(k, cfg.fields)).join(', ')}` : '', t.require_comment ? 'needs a comment' : '',
    t.require_approval ? `needs approval${t.no_self_approval ? ' (not the owner\'s own)' : ''}` : '', t.conditions ? `if ${filterText(t.conditions)}` : '', t.actions?.length ? `then ${t.actions.length} action${t.actions.length === 1 ? '' : 's'}` : '']
    .filter(Boolean).join(' · ');
  // How items may move, as one choice: any status to any other, one step at a time (forward and back), or a custom grid.
  const pairKey = (t) => `${t.from_status || ''}>${t.to_status}`;
  const freeSet = () => m.statuses.map((s) => ({ from_status: null, to_status: s.id, name: s.name }));
  const stepSet = () => m.statuses.slice(0, -1).flatMap((s, n) => [
    { from_status: s.id, to_status: m.statuses[n + 1].id, name: `Move to ${m.statuses[n + 1].name}` },
    { from_status: m.statuses[n + 1].id, to_status: s.id, name: `Back to ${s.name}` }]);
  const same = (set) => set.length === m.transitions.length && set.every((x) => m.transitions.some((t) => pairKey(t) === pairKey(x)));
  const modeNow = () => (m.statuses.length && same(freeSet()) ? 'free' : m.statuses.length > 1 && same(stepSet()) ? 'steps' : 'custom');
  /** Use a mode's moves; a move that stays (same from and to) keeps its name and rules. */
  const applyMode = (set) => {
    m.transitions = set.map((x, n) => {
      const old = m.transitions.find((t) => pairKey(t) === pairKey(x));
      return old ? { ...old, sort: (n + 1) * 10 } : { id: newId(), ...x, sort: (n + 1) * 10 };
    });
  };
  const MODES = [['free', 'Any order', 'An item can go from any status to any other. The simplest, and right for most work.'],
    ['steps', 'Step by step', 'Each status leads to the next one, or back one. For work that passes the same stages in order (design → review → release).'],
    ['custom', 'Custom', 'Tick exactly which moves are allowed.']];
  const ruled = (t) => !!rules(t);
  const matrix = () => `<div class="table-wrap"><table class="pm-table pm-wf-matrix"><thead><tr><th>From ↓ &nbsp; To →</th>${m.statuses.map((s) => `<th>${esc(s.name)}</th>`).join('')}</tr></thead><tbody>
    ${[{ id: null, name: 'Any status' }, ...m.statuses].map((f) => `<tr><th>${esc(f.name)}</th>${m.statuses.map((to) => (f.id === to.id ? '<td class="muted">—</td>'
      : `<td><input type="checkbox" data-cell="${esc(f.id || '')}>${esc(to.id)}" ${m.transitions.some((t) => (t.from_status || null) === f.id && t.to_status === to.id) ? 'checked' : ''} aria-label="${esc(f.name)} to ${esc(to.name)}"></td>`)).join('')}</tr>`).join('')}</tbody></table></div>`;
  const catIx = (cat) => CATEGORIES.findIndex(([k]) => k === cat);
  /** Where a new status (or one dropped at the end of a column) goes: after the last one in that column. */
  const endOf = (cat) => m.statuses.reduce((last, q, k) => (q.category === cat ? k + 1 : last), m.statuses.filter((q) => catIx(q.category) < catIx(cat)).length);
  const lane = (cat, label) => {
    const list = m.statuses.filter((s) => s.category === cat);
    return `<div class="pm-wf-lane is-${cat}" data-lane="${cat}"><h3>${esc(label)} <span class="muted small">${list.length}</span></h3><ul>${list.map((s) => {
      const n = m.statuses.indexOf(s);
      return `<li class="pm-wf-st" data-s="${esc(s.id)}">
        <span class="pm-wf-grip" draggable="true" title="Drag to reorder, or into another column" aria-hidden="true">⋮⋮</span>
        <button type="button" class="pm-wf-dot tone-${esc(s.color)}" data-s-color title="Colour: ${esc(s.color)}. Click for the next one." aria-label="Change the colour of ${esc(s.name)}"></button>
        <input type="text" data-s-name maxlength="40" value="${esc(s.name)}" aria-label="Status name" required>
        ${n === 0 ? '<span class="chip-tone tone-gray pm-wf-start" title="New items start here">Start</span>' : ''}
        <span class="pm-wf-st-tools"><button type="button" class="btn btn-sm btn-ghost" data-s-up ${n ? '' : 'disabled'} aria-label="Move ${esc(s.name)} up">↑</button><button type="button" class="btn btn-sm btn-ghost" data-s-down ${n < m.statuses.length - 1 ? '' : 'disabled'} aria-label="Move ${esc(s.name)} down">↓</button><button type="button" class="btn btn-sm btn-ghost" data-s-del ${m.statuses.length > 1 ? '' : 'disabled'} aria-label="Remove ${esc(s.name)}">✕</button></span></li>`;
    }).join('')}</ul><button type="button" class="btn btn-sm btn-ghost pm-wf-add" data-s-add="${cat}">+ Add a status</button></div>`;
  };
  /** Statuses stay in column order: To do, then In progress, then Done. */
  const tidy = () => {
    m.statuses = m.statuses.map((s, n) => [s, n]).sort((a, z) => catIx(a[0].category) - catIx(z[0].category) || a[1] - z[1]).map(([s]) => s);
  };
  let mode = (tidy(), modeNow());
  const unsaved = () => ((dirty = true), (el.querySelector('[data-wf-dirty]').textContent = 'Unsaved changes'), el.querySelector('[data-wf-save]').classList.add('btn-primary'));

  const draw = () => {
    tidy();
    if (mode === 'free') applyMode(freeSet());
    else if (mode === 'steps') applyMode(stepSet());
    el.querySelector('[data-wf-draw]').innerHTML = svg();
    el.querySelector('[data-wf-statuses]').innerHTML = CATEGORIES.map(([k, l]) => lane(k, l)).join('');
    el.querySelectorAll('[data-mode]').forEach((x) => { x.classList.toggle('is-on', x.dataset.mode === mode); x.setAttribute('aria-checked', String(x.dataset.mode === mode)); });
    el.querySelector('[data-mode-hint]').textContent = MODES.find(([k]) => k === mode)[2];
    const grid = el.querySelector('[data-wf-matrix]');
    grid.hidden = mode !== 'custom';
    grid.innerHTML = mode === 'custom' ? matrix() : '';
    el.querySelector('[data-t-add]').hidden = mode !== 'custom';
    const list = mode === 'custom' ? m.transitions : m.transitions.filter(ruled);
    el.querySelector('[data-wf-moves]').innerHTML = list.length ? list.map((t) => `<tr data-t="${esc(t.id)}"><td><strong>${esc(t.name)}</strong></td><td>${esc(sName(t.from_status))} → ${esc(sName(t.to_status))}</td>
      <td class="muted small">${esc(rules(t)) || 'No rules'}</td><td class="pm-nowrap"><button type="button" class="btn btn-sm" data-t-edit>Rules…</button>${mode === 'custom' ? ' <button type="button" class="btn btn-sm btn-ghost" data-t-del>Remove</button>' : ''}</td></tr>`).join('')
      : `<tr><td colspan="4" class="muted">${mode === 'custom' ? 'No moves yet: items can\'t leave the status they start in. Tick boxes in the grid, or add one.' : 'No move has rules yet: anyone whose role may move items can make any of them.'}</td></tr>`;
    const pick = el.querySelector('[data-wf-rule-pick]');
    const plain = m.transitions.filter((t) => !ruled(t));
    pick.innerHTML = `<option value="">+ Add rules to a move…</option>${plain.map((t) => `<option value="${esc(t.id)}">${esc(sName(t.from_status))} → ${esc(sName(t.to_status))}</option>`).join('')}`;
    pick.hidden = mode === 'custom' || !plain.length;
    el.querySelector('[data-wf-save]').classList.toggle('btn-primary', dirty);
    el.querySelector('[data-wf-dirty]').textContent = dirty ? 'Unsaved changes' : '';
  };
  const touch = () => ((dirty = true), draw());

  el.innerHTML = `<div class="pm-toolbar pm-wf-bar"><div class="card-actions"><label class="inline-field">Workflow <select data-wf-pick>${flows.map((w) => `<option value="${esc(w.id)}" ${w.id === wfId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}${wf ? '' : '<option selected>New workflow</option>'}</select></label>
        <a class="btn btn-sm btn-ghost" href="${scope.base}/workflows/new">+ New workflow</a></div>
      <div class="card-actions"><span class="muted small" data-wf-dirty aria-live="polite"></span><button type="button" class="btn" data-wf-save>Save workflow</button></div></div>
    <p class="muted small">${wf ? `Used by ${usedBy.map((t) => `<strong>${esc(t.name)}</strong>`).join(', ') || 'no work type yet (pick it on a type in Work types)'}. Version ${wf.version}.` : 'Not saved yet. Pick it on a work type to use it.'}</p>
    <section class="card"><h2>Statuses</h2><p class="hint">Type to rename. Drag ⋮⋮ to reorder, or into another column to change whether it counts as to do, in progress or done. New items start in the first one.</p>
      <div class="pm-wf-lanes" data-wf-statuses></div></section>
    <section class="card"><h2>How items move</h2>
      <div class="pm-seg pm-wf-modes" role="radiogroup" aria-label="How items move">${MODES.map(([k, l]) => `<button type="button" role="radio" data-mode="${k}">${esc(l)}</button>`).join('')}</div>
      <p class="hint" data-mode-hint></p>
      <div data-wf-matrix></div>
      <h3>Rules on moves</h3><p class="hint">Optional: who may make a move, what it needs first (fields, a comment, approval), and what happens right after.</p>
      <div class="table-wrap"><table class="pm-table"><thead><tr><th>Move</th><th>From → to</th><th>Rules</th><th></th></tr></thead><tbody data-wf-moves></tbody></table></div>
      <p class="card-actions"><select data-wf-rule-pick aria-label="Add rules to a move"></select><button type="button" class="btn btn-sm" data-t-add>+ Move</button></p></section>
    <details class="card pm-wf-more" data-help="pm-wf-more"${helpOpen('pm-wf-more') ? ' open' : ''}><summary>Name, diagram and earlier versions</summary>
      <div class="form-grid"><div class="field span-2"><label for="wf-name">Name</label><input id="wf-name" type="text" maxlength="80" value="${esc(m.name)}"></div>
        <div class="field span-2"><label for="wf-desc">What it's for</label><input id="wf-desc" type="text" maxlength="300" value="${esc(m.description)}"></div></div>
      <h3>Diagram</h3><p class="hint">Arrows are the allowed moves; a dashed arrow needs approval; "any" means from every status. Drag a box to tidy it.</p>
      <div class="pm-wf-canvas" data-wf-draw></div>
      ${versions.length ? `<h3>Earlier versions (${versions.length})</h3><ul class="pm-mini">${versions.map((v) => `<li>Version ${v.version} <span class="muted small">${esc(fmtDateTime(v.created_at))} · ${esc(personName(b, v.created_by) || 'one.solar')}${v.note ? ` · ${esc(v.note)}` : ''}</span>
      ${v.version !== wf.version ? `<button type="button" class="btn btn-sm" data-restore="${v.version}">Load into the editor</button>` : '<span class="chip-tone tone-green">Current</span>'}</li>`).join('')}</ul>
      <p class="hint">Loading a version only fills the editor. It becomes the workflow when you save, as a new version; nothing is lost.</p>` : ''}</details>`;
  draw();
  guardLeaving(el, () => dirty);

  el.querySelector('[data-wf-pick]').onchange = (e) => (location.hash = `${scope.base}/workflows/${e.target.value}`);
  el.querySelector('#wf-name').oninput = (e) => ((m.name = e.target.value), unsaved());
  el.querySelector('#wf-desc').oninput = (e) => ((m.description = e.target.value), unsaved());

  // dragging a box in the diagram
  const canvas = el.querySelector('[data-wf-draw]');
  canvas.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('[data-node]');
    if (!g) return;
    const s = m.statuses.find((q) => q.id === g.dataset.node);
    const [x0, y0, sx, sy] = [e.clientX, e.clientY, s.x, s.y];
    const move = (ev) => {
      s.x = Math.max(4, Math.round((sx + ev.clientX - x0) / 10) * 10);
      s.y = Math.max(34, Math.round((sy + ev.clientY - y0) / 10) * 10);
      canvas.innerHTML = svg();
    };
    const up = () => (window.removeEventListener('pointermove', move), (dirty = true), draw());
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    e.preventDefault();
  });

  // dragging a status by its ⋮⋮: to reorder, or into another column
  const lanes = el.querySelector('[data-wf-statuses]');
  let dragging = null;
  lanes.addEventListener('dragstart', (e) => {
    const li = e.target.closest?.('[data-s]');
    if (!li) return;
    dragging = li.dataset.s;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragging);
    li.classList.add('is-dragging');
  });
  lanes.addEventListener('dragover', (e) => {
    if (!dragging || !e.target.closest('[data-lane]')) return;
    e.preventDefault();
    lanes.querySelectorAll('.is-over').forEach((x) => x.classList.remove('is-over'));
    e.target.closest('[data-lane]').classList.add('is-over');
  });
  lanes.addEventListener('drop', (e) => {
    const laneEl = e.target.closest('[data-lane]');
    if (!dragging || !laneEl) return;
    e.preventDefault();
    const s = m.statuses.find((q) => q.id === dragging);
    const before = [...laneEl.querySelectorAll('[data-s]')].find((li) => li.dataset.s !== dragging && e.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2);
    m.statuses.splice(m.statuses.indexOf(s), 1);
    s.category = laneEl.dataset.lane;
    m.statuses.splice(before ? m.statuses.findIndex((q) => q.id === before.dataset.s) : endOf(s.category), 0, s);
    dragging = null;
    touch();
  });
  lanes.addEventListener('dragend', () => {
    dragging = null;
    lanes.querySelectorAll('.is-dragging, .is-over').forEach((x) => x.classList.remove('is-dragging', 'is-over'));
  });

  el.addEventListener('input', (e) => {
    const s = m.statuses.find((q) => q.id === e.target.closest('[data-s]')?.dataset.s);
    if (!s || !e.target.matches('[data-s-name]')) return;
    // a move named after the status follows its new name
    const was = s.name;
    s.name = e.target.value;
    for (const t of m.transitions) {
      if (t.to_status === s.id && t.name === was) t.name = s.name;
      else if (t.to_status === s.id && t.name === `Move to ${was}`) t.name = `Move to ${s.name}`;
      else if (t.to_status === s.id && t.name === `Back to ${was}`) t.name = `Back to ${s.name}`;
    }
    canvas.innerHTML = svg();
    unsaved();
  });
  el.addEventListener('change', async (e) => {
    const s = m.statuses.find((q) => q.id === e.target.closest('[data-s]')?.dataset.s);
    if (s && e.target.matches('[data-s-name]')) touch();
    else if (e.target.dataset.cell) {
      const [from, to] = e.target.dataset.cell.split('>');
      if (e.target.checked) m.transitions.push({ id: newId(), name: from ? `${sName(from)} → ${sName(to)}` : sName(to), from_status: from || null, to_status: to, sort: (m.transitions.length + 1) * 10 });
      else m.transitions = m.transitions.filter((t) => !((t.from_status || '') === from && t.to_status === to));
      touch();
    } else if (e.target.matches('[data-wf-rule-pick]') && e.target.value) {
      const tr = m.transitions.find((q) => q.id === e.target.value);
      const res = await moveDialog(b, cfg, m, tr, { fixed: true });
      if (res) Object.assign(tr, res);
      touch();
    }
  });
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const sRow = t.closest('[data-s]');
    const n = sRow ? m.statuses.findIndex((q) => q.id === sRow.dataset.s) : -1;
    const tr = m.transitions.find((q) => q.id === t.closest('[data-t]')?.dataset.t);
    if (t.dataset.mode) {
      const next = t.dataset.mode;
      if (next === mode) return;
      const keep = next === 'free' ? freeSet() : next === 'steps' ? stepSet() : m.transitions;
      const lose = m.transitions.filter((q) => ruled(q) && !keep.some((x) => pairKey(x) === pairKey(q)));
      if (lose.length && !confirm(`${lose.length === 1 ? 'A move with rules' : `${lose.length} moves with rules`} (${lose.map((q) => q.name).join(', ')}) won't exist any more. Switch anyway?`)) return;
      mode = next;
      touch();
    } else if (t.dataset.sAdd) {
      const cat = t.dataset.sAdd;
      const s = { id: newId(), name: 'New status', category: cat, color: cat === 'done' ? 'green' : cat === 'todo' ? 'gray' : 'blue', x: 40 + (m.statuses.length % 4) * 190, y: 70 + Math.floor(m.statuses.length / 4) * 110 };
      m.statuses.splice(endOf(cat), 0, s);
      touch();
      const input = el.querySelector(`[data-s="${CSS.escape(s.id)}"] [data-s-name]`);
      input?.focus();
      input?.select();
    } else if (t.dataset.sColor !== undefined) ((m.statuses[n].color = TONES[(TONES.indexOf(m.statuses[n].color) + 1) % TONES.length]), touch());
    else if (t.dataset.sUp !== undefined || t.dataset.sDown !== undefined) {
      const to = t.dataset.sUp !== undefined ? n - 1 : n + 1;
      const [a, other] = [m.statuses[n], m.statuses[to]];
      // at the edge of its column it moves into the next column; otherwise it swaps with its neighbour
      if (other.category !== a.category) a.category = other.category;
      else [m.statuses[n], m.statuses[to]] = [other, a];
      touch();
    } else if (t.dataset.sDel !== undefined) {
      const id = m.statuses[n].id;
      m.statuses.splice(n, 1);
      m.transitions = m.transitions.filter((q) => q.from_status !== id && q.to_status !== id);
      touch();
    } else if (t.dataset.tAdd !== undefined || t.dataset.tEdit !== undefined) {
      const res = await moveDialog(b, cfg, m, tr, { fixed: mode !== 'custom' });
      if (res) (tr ? Object.assign(tr, res) : m.transitions.push({ id: newId(), sort: (m.transitions.length + 1) * 10, ...res }), touch());
    } else if (t.dataset.tDel !== undefined) ((m.transitions = m.transitions.filter((q) => q !== tr)), touch());
    else if (t.dataset.restore) {
      const snap = versions.find((v) => v.version === Number(t.dataset.restore)).snapshot;
      Object.assign(m, { name: snap.name, description: snap.description, statuses: snap.statuses.map((s) => ({ ...s })), transitions: snap.transitions.map((q) => ({ ...q })) });
      el.querySelector('#wf-name').value = m.name;
      tidy();
      mode = modeNow();
      touch();
      toast(`Version ${t.dataset.restore} is in the editor. Save to make it the workflow.`);
    } else if (t.dataset.wfSave !== undefined) save();
  });

  async function save() {
    m.statuses.forEach((s, n) => (s.sort = (n + 1) * 10));
    const payload = { name: m.name.trim(), description: m.description, version: wf?.version,
      statuses: m.statuses.map(({ id, name, category, color, sort, x, y }) => ({ id, name: name.trim(), category, color, sort, x, y })),
      transitions: m.transitions.map((t, n) => ({ id: t.id, name: t.name, from_status: t.from_status || null, to_status: t.to_status, description: t.description || '', role_ids: t.role_ids || [],
        require_fields: t.require_fields || [], require_comment: !!t.require_comment, require_approval: !!t.require_approval, no_self_approval: !!t.no_self_approval,
        conditions: t.conditions || null, actions: t.actions || [], sort: (n + 1) * 10 })) };
    let preview;
    try {
      preview = await pm.saveWorkflow(project.id, wf?.id || null, { ...payload, dry_run: true });
    } catch (err) {
      return toast(err.message, 'bad');
    }
    // 069: a status no chain of moves gets to (new items start in the first one)
    for (const st of unreachableStatuses(m.statuses, m.transitions)) preview.warnings.push(`No move leads to "${st.name}", so items can never get there.`);
    const stuck = preview.removed.filter((r) => r.items > 0);
    const res = await formDialog({ title: 'Save this workflow?', submit: 'Save as a new version',
      body: `<p>${wf ? `${preview.items} item${preview.items === 1 ? '' : 's'} use this workflow.` : 'A new workflow. Pick it on a work-item type to use it.'}</p>
        ${preview.warnings.length ? `<div class="alert alert-info"><strong>Worth a look:</strong><ul>${preview.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
        ${preview.removed.length ? `<p>Removing: ${preview.removed.map((r) => `${esc(r.name)} (${r.items} item${r.items === 1 ? '' : 's'})`).join(', ')}.</p>` : ''}
        ${stuck.map((r) => `<div class="field"><label for="map-${esc(r.id)}">Items now in "${esc(r.name)}" (${r.items}) become</label>
          <select id="map-${esc(r.id)}" name="map:${esc(r.id)}" required><option value="">Pick a status</option>${m.statuses.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></div>`).join('')}
        ${preview.recategorized ? `<p>${preview.recategorized} item${preview.recategorized === 1 ? '' : 's'} will count differently (open / in progress / finished) because a status changed category.</p>` : ''}
        <div class="field"><label for="wf-note">Note for the version history (optional)</label><input id="wf-note" name="note" type="text" maxlength="300"></div>
        <p class="hint">Each moved item gets a line in its history. The current version stays in "Earlier versions".</p>`,
      onSubmit: (f) => pm.saveWorkflow(project.id, wf?.id || null, { ...payload, note: f.elements.note.value,
        mapping: Object.fromEntries(stuck.map((r) => [r.id, f.elements[`map:${r.id}`].value])) }) });
    if (!res) return;
    dirty = false;
    releaseGuard();
    invalidate(project.id);
    await loadConfig(b, project.id);
    toast(`Saved "${m.name}" as version ${res.version}.`);
    if (!wf) location.hash = `${scope.base}/workflows/${res.id}`;
    else scope.rerender();
  }
}

/** One move and its rules. Returns the fields to put on the transition, or null. */
/** fixed: from and to are set by "How items move" and can't be changed here (only the name and rules). */
function moveDialog(b, cfg, m, tr, { fixed = false } = {}) {
  let conditions = tr?.conditions || null;
  const acts = actionsEditor(b, cfg, tr?.actions || []);
  const opt = (v, l, on) => `<option value="${esc(v)}" ${on ? 'selected' : ''}>${esc(l)}</option>`;
  const fields = [...REQUIRABLE.map((k) => [k, fieldLabel(k)]), ...cfg.fields.filter((f) => !f.archived_at && f.type !== 'formula').map((f) => [`cf.${f.key}`, f.name])];
  return formDialog({
    title: tr ? `Move: ${esc(tr.name)}` : 'New move', submit: 'Done', wide: true,
    body: `<div class="form-grid"><div class="field span-2"><label for="mv-name">Name (the button people press)</label><input id="mv-name" name="name" type="text" maxlength="60" required value="${esc(tr?.name || '')}" placeholder="Send for review"></div>
        <div class="field"><label for="mv-from">From</label><select id="mv-from" name="from" ${fixed ? 'disabled' : ''}>${opt('', 'Any status', !tr?.from_status)}${m.statuses.map((s) => opt(s.id, s.name, tr?.from_status === s.id)).join('')}</select></div>
        <div class="field"><label for="mv-to">To</label><select id="mv-to" name="to" required ${fixed ? 'disabled' : ''}>${m.statuses.map((s) => opt(s.id, s.name, tr?.to_status === s.id)).join('')}</select></div>
        <div class="field span-4"><label for="mv-desc">Explanation shown when making the move (optional)</label><input id="mv-desc" name="description" type="text" maxlength="500" value="${esc(tr?.description || '')}"></div></div>
      <fieldset class="pm-section"><legend>Who can make it</legend><div class="pm-checks">${cfg.roles.map((r) => `<label class="pm-check"><input type="checkbox" name="role" value="${esc(r.id)}" ${tr?.role_ids?.includes(r.id) ? 'checked' : ''}> ${esc(r.name)}</label>`).join('')}</div>
        <p class="hint">None ticked: anyone whose project role may move items.</p></fieldset>
      <fieldset class="pm-section"><legend>What it needs first</legend><div class="pm-checks">${fields.map(([k, l]) => `<label class="pm-check"><input type="checkbox" name="req" value="${esc(k)}" ${tr?.require_fields?.includes(k) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>
        <div class="pm-checks" style="margin-top:8px"><label class="pm-check"><input type="checkbox" name="comment" ${tr?.require_comment ? 'checked' : ''}> A comment</label>
          <label class="pm-check"><input type="checkbox" name="approval" ${tr?.require_approval ? 'checked' : ''}> Approval by someone whose role may approve</label>
          <label class="pm-check"><input type="checkbox" name="noself" ${tr?.no_self_approval ? 'checked' : ''}> …who isn't the item's owner</label></div>
        <p>Only when: <span data-cond-text class="muted">${esc(filterText(conditions) || 'always')}</span> <button type="button" class="btn btn-sm" data-cond>Set a condition</button></p>
        <p class="hint">More fields can be asked for (not required) on this move's own form: Settings → Forms → "When making a move".</p></fieldset>
      <fieldset class="pm-section"><legend>Then, right after the move</legend>${acts.html()}</fieldset>`,
    onOpen(form) {
      acts.bind(form);
      form.querySelector('[data-cond]').onclick = async () => {
        const next = await conditionDialog(b, conditions, { fields: cfg.fields, statuses: cfg.statuses, sprints: cfg.sprints }, 'Only allow this move when…');
        if (next !== undefined) ((conditions = next), (form.querySelector('[data-cond-text]').textContent = filterText(conditions) || 'always'));
      };
    },
    onSubmit(f) {
      const e = f.elements;
      if (e.from.value === e.to.value) throw new Error('A move has to go to a different status.');
      return { name: e.name.value.trim(), from_status: e.from.value || null, to_status: e.to.value, description: e.description.value, role_ids: [...f.querySelectorAll('[name=role]:checked')].map((n) => n.value),
        require_fields: [...f.querySelectorAll('[name=req]:checked')].map((n) => n.value), require_comment: e.comment.checked, require_approval: e.approval.checked,
        no_self_approval: e.approval.checked && e.noself.checked, conditions, actions: acts.read() };
    },
  });
}
