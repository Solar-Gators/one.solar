/**
 * Projects → a project's Settings: everything that makes this project work the way it does, edited here and
 * never in code. Details, People & roles, Work types, Workflows, Fields, Forms, Rules, Templates. Each part
 * shows only to people whose project role may change it, and the database checks every save again.
 */
import { esc, fmtDateTime } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { CAPS, TONES, FIELD_TYPES, BUILTIN_FIELDS, PRIORITIES, DOC_CATEGORIES, fieldLabel, layoutFor, filterText, starterRules, newId } from '../../projects/core.js';
import { checkFormula, FORMULA_FUNCTIONS, FORMULA_BUILTINS } from '../../projects/formula.js';
import { can, formDialog, attempt, toast, invalidate, loadConfig, peopleField, personName, avatar, bindOrgPickers, typeBadge, formSections, conditionDialog, projectHref, OPTIONAL_TABS, infoTip } from './kit.js';
import { renderWorkflows, actionsEditor } from './workflowEditor.js';
import { applyConfigDialog, download } from './templates.js';

// C8: the last item says which tab a page sits under; pages with one aren't tabs of their own (their links still work)
const TABS = [['details', 'Details', 'configure'], ['people', 'People & roles', 'members'], ['types', 'Work types & fields', 'configure'], ['workflows', 'Workflows', 'workflows'],
  ['fields', 'Fields', 'configure', 'types'], ['forms', 'Forms', 'configure', 'types'], ['rules', 'Rules', 'automations'], ['templates', 'Templates', 'configure', 'details']];
const opt = (v, l, on) => `<option value="${esc(v)}" ${on ? 'selected' : ''}>${esc(l)}</option>`;
const TRIGGERS = [['created', 'An item is created'], ['updated', 'An item is changed'], ['status', 'An item changes status'], ['assigned', 'An item gets a new owner'], ['comment', 'Someone comments'],
  ['dependency_done', 'Everything it was waiting on is finished'], ['milestone', 'A milestone is reached'], ['due_soon', 'An item is due soon'], ['overdue', 'An item is overdue'], ['schedule', 'On a schedule']];

export async function renderSettings(el, scope) {
  const { b, project } = scope;
  const tabs = TABS.filter(([, , cap]) => can(b, project.id, cap));
  if (!tabs.length) return void (el.innerHTML = '<div class="empty"><p><strong>Your role in this project can\'t change its settings.</strong></p><p>Ask the project manager.</p></div>');
  const tab = tabs.find(([k]) => k === scope.params.sub) ? scope.params.sub : tabs[0][0];
  const base = projectHref(project.key, 'settings');
  const under = tabs.find(([k]) => k === tab)[3];
  const back = under && tabs.find(([k]) => k === under);
  el.innerHTML = `<div class="pm-settings"><nav class="pm-subtabs" aria-label="Settings">${tabs.filter((t) => !t[3]).map(([k, l]) => `<a href="${base}/${k}" ${k === (under || tab) ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
    ${back ? `<p class="pm-back-line"><a href="${base}/${back[0]}">← ${esc(back[1])}</a></p>` : ''}<div data-pane></div></div>`;
  const pane = el.querySelector('[data-pane]');
  const s = { ...scope, base, reload: async () => (invalidate(project.id), await loadConfig(b, project.id), scope.rerender()) };
  return ({ details, people, types, workflows: renderWorkflows, fields, forms, rules, templates })[tab](pane, s);
}

// ---- Details -----------------------------------------------------------------------------------------
/** V4: one phase in Settings → Details: name, from, to, color. */
const phaseRow = (ph) => `<div class="pm-phase-row"><input type="text" data-ph="name" maxlength="40" value="${esc(ph.name || '')}" placeholder="Design" aria-label="Phase name">
  <input type="date" data-ph="start" value="${esc(ph.start || '')}" aria-label="Starts"><input type="date" data-ph="end" value="${esc(ph.end || '')}" aria-label="Ends">
  <select data-ph="tone" aria-label="Color">${TONES.map((t) => `<option value="${t}" ${(ph.tone || 'blue') === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
  <button type="button" class="btn btn-sm btn-ghost" data-del-phase aria-label="Remove this phase">✕</button></div>`;

async function details(el, { b, project, cfg, rerender }) {
  const st = project.settings;
  const days = st.working_days?.length ? st.working_days.map(Number) : [1, 2, 3, 4, 5];
  const mayShare = can(b, project.id, 'members');
  el.innerHTML = `<form class="card" data-details><h2>Details</h2>
      <div class="form-grid"><div class="field span-3"><label for="pd-name">Name</label><input id="pd-name" name="name" type="text" maxlength="120" required value="${esc(project.name)}"></div>
        <div class="field"><label>Key</label><output class="pm-formula">${esc(project.key)}</output><div class="hint">Can't change: it's in every item's name.</div></div>
        <div class="field span-4"><label for="pd-desc">About this project</label><textarea id="pd-desc" name="description" rows="3">${esc(project.description)}</textarea></div>
        <div class="field span-2"><label for="pd-program">Car cycle</label><select id="pd-program" name="program">${opt('', 'None', !project.program_id)}${b.programs.filter((g) => !g.archived_at || g.id === project.program_id).map((g) => opt(g.id, g.name, g.id === project.program_id)).join('')}</select></div>
        <div class="field span-2"><label for="pd-lead">Project manager</label>${peopleField('lead', 'pd-lead', b, project.lead_id, { blank: 'Nobody' })}</div>
        <div class="field span-2"><label for="pd-div">Owning CE division</label><select id="pd-div" name="division" data-division>${opt('', '—', !project.division_id)}${b.divisions.filter((d) => !d.archived_at || d.id === project.division_id).map((d) => opt(d.id, d.name, d.id === project.division_id)).join('')}</select></div>
        <div class="field span-2"><label for="pd-sub">Owning subsystem</label><select id="pd-sub" name="subsystem" data-subsystem>${opt('', '—', !project.subsystem_id)}${b.subsystems.filter((s) => !s.archived_at || s.id === project.subsystem_id).map((s) => `<option value="${esc(s.id)}" data-div="${esc(s.division_id)}" ${s.id === project.subsystem_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
        <div class="field span-2"><label for="pd-vehicle">Vehicle (optional)</label><input id="pd-vehicle" name="vehicle" type="text" maxlength="80" value="${esc(project.vehicle)}"></div></div>
      <fieldset class="pm-section"><legend>Other subsystems involved</legend><details class="pm-multi"><summary>${project.participants.length || 'No'} other subsystem${project.participants.length === 1 ? '' : 's'}</summary>
        <div class="pm-checks">${b.subsystems.filter((s) => !s.archived_at).map((s) => `<label class="pm-check"><input type="checkbox" name="part" value="${esc(s.id)}" data-div="${esc(s.division_id)}" ${project.participants.some((p) => p.subsystem_id === s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('')}</div></details></fieldset>
      <fieldset class="pm-section"><legend>Who can see it</legend>
        <label class="pm-check"><input type="radio" name="visibility" value="team" ${project.visibility === 'team' ? 'checked' : ''} ${mayShare ? '' : 'disabled'}> The whole team</label>
        <label class="pm-check"><input type="radio" name="visibility" value="private" ${project.visibility === 'private' ? 'checked' : ''} ${mayShare ? '' : 'disabled'}> Only the people added to it (a sensitive project)</label>
        <div class="field" style="max-width:340px;margin-top:8px"><label for="pd-team-role">Role for team members who haven't been added</label>
          <select id="pd-team-role" name="team_role" ${mayShare ? '' : 'disabled'}>${opt('', 'Viewer only (can see, nothing more)', !project.team_role_id)}${cfg.roles.map((r) => opt(r.id, r.name, r.id === project.team_role_id)).join('')}</select>
          <div class="hint">Only for a project the whole team can see. People added to the project get the role you give them.</div></div></fieldset>
      <fieldset class="pm-section"><legend>Working days (for the timeline's forecast)</legend><div class="pm-checks">${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, n) => `<label class="pm-check"><input type="checkbox" name="wd" value="${n}" ${days.includes(n) ? 'checked' : ''}> ${d}</label>`).join('')}</div>
        <div class="field" style="margin-top:8px"><label for="pd-off">Days off (one date per line, e.g. 2027-03-15)</label><textarea id="pd-off" name="holidays" rows="3" placeholder="2027-03-15">${esc((st.holidays || []).join('\n'))}</textarea></div></fieldset>
      <fieldset class="pm-section"><legend>Planning</legend><label class="pm-check"><input type="checkbox" name="sprints" ${st.sprints ? 'checked' : ''}> Plan in sprints (optional; leave off for a continuous board)</label>
        <div class="field" style="max-width:220px;margin-top:8px"><label for="pd-sprint-days">A sprint lasts (days)</label><input id="pd-sprint-days" name="sprint_days" type="number" min="1" max="90" value="${esc(st.sprint_days || 14)}"></div></fieldset>
      <fieldset class="pm-section"><legend>Tabs</legend><p class="hint" style="margin-top:0">Hide the ones this project doesn't use. Summary and Settings always show; a hidden tab still opens from a link.</p>
        <div class="pm-checks">${OPTIONAL_TABS.map(([k, l]) => `<label class="pm-check"><input type="checkbox" name="tab" value="${esc(k)}" ${(st.hidden_tabs || []).includes(k) ? '' : 'checked'}> ${esc(l)}</label>`).join('')}</div></fieldset>
      <fieldset class="pm-section"><legend>Phases (shaded on the timeline) ${infoTip('Named stretches of time, like Design, Build and Test. They only show on the timeline; they never move items.')}</legend>
        <div data-phases class="pm-phases">${(st.phases || []).map(phaseRow).join('')}</div>
        <p><button type="button" class="btn btn-sm" data-add-phase>+ Phase</button></p></fieldset>
      <fieldset class="pm-section"><legend>Document categories</legend><div class="field"><label for="pd-cats">One per line</label><textarea id="pd-cats" name="cats" rows="4">${esc((st.doc_categories?.length ? st.doc_categories : DOC_CATEGORIES).join('\n'))}</textarea></div></fieldset>
      ${can(b, project.id, 'configure') ? `<p class="muted small">Reuse this set-up in other projects, or bring one in: <a href="${projectHref(project.key, 'settings/templates')}">Templates…</a></p>` : ''}
      <label class="pm-check"><input type="checkbox" name="archived" ${project.archived_at ? 'checked' : ''}> Archive this project (nothing is deleted; no new items until it's restored)</label>
      <div class="form-actions"><button type="submit" class="btn btn-primary">Save</button></div></form>`;
  bindOrgPickers(el);
  const phasesBox = el.querySelector('[data-phases]');
  el.querySelector('[data-add-phase]').onclick = () => {
    if (phasesBox.children.length >= 20) return toast('Up to 20 phases.', 'bad');
    phasesBox.insertAdjacentHTML('beforeend', phaseRow({}));
    phasesBox.lastElementChild.querySelector('input').focus();
  };
  phasesBox.addEventListener('click', (e) => e.target.closest('[data-del-phase]')?.closest('.pm-phase-row').remove());
  el.querySelector('[data-details]').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const lines = (v) => v.split('\n').map((x) => x.trim()).filter(Boolean);
    const phases = [...phasesBox.querySelectorAll('.pm-phase-row')].map((r) => ({ name: r.querySelector('[data-ph=name]').value.trim(), start: r.querySelector('[data-ph=start]').value,
      end: r.querySelector('[data-ph=end]').value, tone: r.querySelector('[data-ph=tone]').value })).filter((p) => p.name || p.start || p.end);
    const bad = phases.find((p) => !p.name || !p.start || !p.end || p.end < p.start);
    if (bad) return toast(bad.name ? `"${bad.name}" needs a start and an end, and the end can't be before the start.` : 'Give each phase a name.', 'bad');
    const saved = await attempt(() => pm.saveProject(project.id, {
      version: project.version, name: f.name.value.trim(), description: f.description.value, program_id: f.program.value || null, lead_id: f.lead.value || null,
      division_id: f.division.value || null, subsystem_id: f.subsystem.value || null, vehicle: f.vehicle.value,
      participants: [...e.target.querySelectorAll('[name=part]:checked')].map((n) => ({ division_id: n.dataset.div, subsystem_id: n.value })),
      ...(mayShare ? { visibility: f.visibility.value, team_role_id: f.team_role.value || null } : {}), archived: f.archived.checked,
      settings: { working_days: [...e.target.querySelectorAll('[name=wd]:checked')].map((n) => Number(n.value)), holidays: lines(f.holidays.value), sprints: f.sprints.checked,
        sprint_days: Number(f.sprint_days.value) || 14, doc_categories: lines(f.cats.value),
        hidden_tabs: OPTIONAL_TABS.map(([k]) => k).filter((k) => !e.target.querySelector(`[name=tab][value="${k}"]`).checked), phases },
    }), 'Saved.');
    if (saved) (invalidate(), rerender());
  };
}

// ---- People & roles ------------------------------------------------------------------------------------
async function people(el, { b, project, cfg, reload }) {
  const mine = new Set(b.caps[project.id]);
  const roleOpts = (sel) => cfg.roles.map((r) => `<option value="${esc(r.id)}" ${r.id === sel ? 'selected' : ''} ${r.caps.every((c) => mine.has(c)) ? '' : 'disabled'}>${esc(r.name)}</option>`).join('');
  const outside = b.people.filter((p) => !cfg.members.some((m) => m.user_id === p.id));
  el.innerHTML = `<section class="card"><h2>People</h2>
      <p class="muted">${project.visibility === 'team' ? 'The whole team can see this project. People listed here can do more, by their role.' : 'Only these people (and anyone who manages all projects) can see this project.'}</p>
      <div class="table-wrap"><table class="pm-table"><thead><tr><th>Person</th><th>Role in this project</th><th></th></tr></thead><tbody>${cfg.members.map((m) => `<tr data-user="${esc(m.user_id)}">
        <td>${avatar(b, m.user_id)} ${esc(personName(b, m.user_id))}</td><td><select data-role aria-label="Role of ${esc(personName(b, m.user_id))}">${roleOpts(m.role_id)}</select></td>
        <td><button type="button" class="btn btn-sm btn-ghost" data-remove>Remove</button></td></tr>`).join('')}</tbody></table></div>
      <form data-add class="pm-filters" style="margin-top:10px">${peopleField('user', 'pm-add-member', b, null, { blank: 'Add someone…', required: true, among: outside.map((p) => p.id) })}
        <select name="role" aria-label="Their role">${roleOpts(cfg.roles.find((r) => r.key === 'contributor')?.id)}</select><button type="submit" class="btn">Add</button></form>
      <p class="hint">You can only hand out roles that can do no more than your own.</p></section>
    <section class="card"><h2>Roles</h2><p class="muted">What each role can do in this project. Change them, or make your own.</p>
      <div class="table-wrap"><table class="pm-table pm-caps"><thead><tr><th>Can…</th>${cfg.roles.map((r) => `<th>${esc(r.name)}</th>`).join('')}</tr></thead><tbody>
        ${CAPS.map(([cap, label, about]) => `<tr><td title="${esc(about)}">${esc(label)}<div class="muted small">${esc(about)}</div></td>${cfg.roles.map((r) => `<td><input type="checkbox" data-cap="${cap}" data-role-id="${esc(r.id)}" ${r.caps.includes(cap) ? 'checked' : ''}
          ${cap === 'view' || !mine.has(cap) || !r.caps.every((c) => mine.has(c)) ? 'disabled' : ''} aria-label="${esc(r.name)}: ${esc(label)}"></td>`).join('')}</tr>`).join('')}
        <tr><td></td>${cfg.roles.map((r) => `<td><button type="button" class="btn btn-sm btn-ghost" data-rename="${esc(r.id)}">Rename</button><button type="button" class="btn btn-sm btn-ghost" data-del-role="${esc(r.id)}">Delete</button></td>`).join('')}</tr></tbody></table></div>
      <p><button type="button" class="btn btn-sm" data-new-role>+ Role</button></p></section>`;
  el.addEventListener('change', async (e) => {
    const user = e.target.closest('[data-user]')?.dataset.user;
    if (user && e.target.matches('[data-role]')) (await attempt(() => pm.setMember(project.id, user, e.target.value), 'Role changed.')) ? (invalidate(), reload()) : reload();
    else if (e.target.dataset.cap) {
      const r = cfg.roles.find((x) => x.id === e.target.dataset.roleId);
      const caps = e.target.checked ? [...r.caps, e.target.dataset.cap] : r.caps.filter((c) => c !== e.target.dataset.cap);
      (await attempt(() => pm.saveRole(project.id, r.id, { name: r.name, caps }), 'Saved.')) ? (invalidate(), reload()) : reload();
    }
  });
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const user = t.closest('[data-user]')?.dataset.user;
    if (t.dataset.remove !== undefined && confirm(`Remove ${personName(b, user)} from this project? Their items and history stay.`)) (await attempt(() => pm.setMember(project.id, user, null), 'Removed.')) && (invalidate(), reload());
    else if (t.dataset.newRole !== undefined || t.dataset.rename) {
      const r = cfg.roles.find((x) => x.id === t.dataset.rename);
      const res = await formDialog({ title: r ? 'Rename role' : 'New role', submit: 'Save',
        body: `<div class="field"><label for="rl-name">Name</label><input id="rl-name" name="name" type="text" maxlength="60" required value="${esc(r?.name || '')}" placeholder="Test lead"></div>
          ${r ? '' : '<p class="hint">A new role can see and comment. Tick anything else it should be able to do in the table.</p>'}`,
        onSubmit: (f) => pm.saveRole(project.id, r?.id || null, { name: f.elements.name.value.trim(), caps: r?.caps || ['view', 'comment'] }) });
      if (res) (invalidate(), reload());
    } else if (t.dataset.delRole && confirm('Delete this role?')) (await attempt(() => pm.deleteRole(t.dataset.delRole), 'Deleted.')) && reload();
  });
  el.querySelector('[data-add]').onsubmit = async (e) => {
    e.preventDefault();
    if (await attempt(() => pm.setMember(project.id, e.target.elements.user.value, e.target.elements.role.value), 'Added.')) (invalidate(), reload());
  };
}

// ---- Work types ----------------------------------------------------------------------------------------
async function types(el, { b, project, cfg, reload }) {
  const flows = cfg.workflows.filter((w) => !w.archived_at);
  const mayFlows = can(b, project.id, 'workflows');
  const sharing = (t) => cfg.types.filter((x) => !x.archived_at && x.workflow_id === t.workflow_id).length;
  const list = [...cfg.types].sort((x, y) => !!x.archived_at - !!y.archived_at || x.level - y.level || x.sort - y.sort);
  el.innerHTML = `<section class="card"><h2>Work-item types ${infoTip(`Each type has its own workflow, its own forms and its place in the hierarchy. The ones marked <span class="chip">Team</span> are on the whole team's list (<a href="#/projects/kinds">Kinds of work</a>): their name, icon and color are the same in every project, and only leads change them. You can still hide one here, and pick its workflow and what it goes under. Level 0 is the top (an epic); an item can go under any item of a lower-numbered level, or only under the types you name.`)}</h2>
    <p class="muted">The kinds of work this project has.</p>
    <div class="table-wrap"><table class="pm-table"><thead><tr><th>Type</th><th>Level</th><th>Goes under</th><th>Workflow</th><th></th></tr></thead><tbody>${list.map((t) => `<tr class="${t.archived_at ? 'is-done' : ''}">
      <td>${typeBadge(t)} <strong>${esc(t.name)}</strong>${t.kind_id ? ' <span class="chip" title="On the whole team\'s list of kinds of work">Team</span>' : ''}${t.is_milestone ? ' <span class="chip">Milestone</span>' : ''}${t.archived_at ? ` <span class="chip-tone tone-gray">${t.kind_id ? 'Hidden here' : 'Archived'}</span>` : ''}<div class="muted small">${esc(t.description)}</div></td>
      <td>${t.level}</td><td>${t.parent_type_ids.length ? t.parent_type_ids.map((id) => esc(cfg.typeById.get(id)?.name || '')).join(', ') : t.level === 0 ? '<span class="muted">Top level</span>' : '<span class="muted">Anything higher up</span>'}</td>
      <td>${mayFlows ? `<a href="${projectHref(project.key, `settings/workflows/${t.workflow_id}`)}">${esc(flows.find((w) => w.id === t.workflow_id)?.name || '')}</a>` : esc(flows.find((w) => w.id === t.workflow_id)?.name || '')}
        ${mayFlows && !t.archived_at && sharing(t) > 1 ? `<div class="muted small">Shared by ${sharing(t)} types · <button type="button" class="link-btn" data-own-flow="${esc(t.id)}">Give it its own</button></div>` : ''}</td><td class="pm-nowrap"><button type="button" class="btn btn-sm" data-edit-type="${esc(t.id)}">Edit</button>
        ${t.archived_at ? '' : `<a class="btn btn-sm" href="${projectHref(project.key, 'settings/forms')}" data-type-form="${esc(t.id)}">Form &amp; fields</a>`}</td></tr>`).join('')}</tbody></table></div>
    <p><button type="button" class="btn btn-primary" data-new-type>+ Work type</button></p>
    </section>
    <div data-fields-here></div>`;
  fields(el.querySelector('[data-fields-here]'), { project, cfg, reload });
  // V5: straight to this type's form, with the fields beside it
  el.querySelectorAll('[data-type-form]').forEach((a) => (a.onclick = () => Object.assign(formState, { type: a.dataset.typeForm, kind: 'create', transition: '', draft: null })));
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (t?.dataset.ownFlow) return ownWorkflow(cfg.typeById.get(t.dataset.ownFlow));
    if (!t || (t.dataset.newType === undefined && !t.dataset.editType)) return;
    const ty = cfg.typeById.get(t.dataset.editType);
    const res = await formDialog({ title: ty ? `Work type: ${esc(ty.name)}` : 'New work type', submit: 'Save', wide: true,
      body: `${ty?.kind_id ? '<p class="alert alert-info">On the whole team\'s list: its name, icon and color are changed in <a href="#/projects/kinds">Kinds of work</a> (leads), for every project at once.</p>' : ''}<div class="form-grid"><div class="field span-2"><label for="ty-name">Name</label><input id="ty-name" name="name" type="text" maxlength="40" required value="${esc(ty?.name || '')}" placeholder="Design Review" ${ty?.kind_id ? 'readonly' : ''}></div>
          <div class="field"><label for="ty-icon">Icon (a symbol or emoji)</label><input id="ty-icon" name="icon" type="text" maxlength="4" value="${esc(ty?.icon || '')}" placeholder="☑" ${ty?.kind_id ? 'readonly' : ''}></div>
          <div class="field"><label for="ty-color">Color</label><select id="ty-color" name="color" ${ty?.kind_id ? 'disabled' : ''}>${TONES.map((c) => opt(c, c, (ty?.color || 'blue') === c)).join('')}</select></div>
          <div class="field span-4"><label for="ty-desc">What it's for</label><input id="ty-desc" name="description" type="text" maxlength="500" value="${esc(ty?.description || '')}"></div>
          <div class="field"><label for="ty-level">Level</label><select id="ty-level" name="level">${[[0, '0 · top (epic)'], [1, '1 · ordinary work'], [2, '2 · under level 1'], [3, '3'], [4, '4']].map(([n, l]) => opt(n, l, (ty?.level ?? 1) === n)).join('')}</select></div>
          <div class="field span-3"><label for="ty-flow">Workflow</label><select id="ty-flow" name="workflow">${flows.map((w) => opt(w.id, w.name, w.id === ty?.workflow_id)).join('')}</select></div></div>
        <fieldset class="pm-section"><legend>Can only go under these types (leave empty for "any higher level")</legend><div class="pm-checks">${cfg.types.filter((x) => !x.archived_at).map((x) => `<label class="pm-check"><input type="checkbox" name="parent" value="${esc(x.id)}" ${ty?.parent_type_ids.includes(x.id) ? 'checked' : ''}> ${esc(x.name)}</label>`).join('')}</div></fieldset>
        <fieldset class="pm-section"><legend>New items of this type start with</legend><div class="form-grid">
          <div class="field"><label for="ty-prio">Priority</label><select id="ty-prio" name="priority">${PRIORITIES.map(([k, l]) => opt(k, l, (ty?.defaults?.priority || 'medium') === k)).join('')}</select></div>
          <div class="field"><label for="ty-est">Estimate (hours)</label><input id="ty-est" name="estimate" type="number" min="0" step="any" value="${esc(ty?.defaults?.estimate_hours ?? '')}"></div>
          <div class="field span-4"><label for="ty-body">Description (a starting outline)</label><textarea id="ty-body" name="body" rows="2">${esc(ty?.defaults?.description || '')}</textarea></div>
          <div class="field span-4"><label for="ty-acc">What "done" means</label><textarea id="ty-acc" name="acceptance" rows="2">${esc(ty?.defaults?.acceptance || '')}</textarea></div></div></fieldset>
        <label class="pm-check"><input type="checkbox" name="milestone" ${ty?.is_milestone ? 'checked' : ''}> A milestone (a date, not a stretch of work)</label>
        ${ty ? `<label class="pm-check"><input type="checkbox" name="archived" ${ty.archived_at ? 'checked' : ''}> ${ty.kind_id ? 'Hidden in this project (existing items stay; no new ones here)' : 'Archived (existing items stay; no new ones)'}</label>` : ''}
        <div data-mapping></div>`,
      async onSubmit(f) {
        const x = f.elements;
        const p = { name: x.name.value.trim(), icon: x.icon.value.trim(), color: x.color.value, description: x.description.value, level: Number(x.level.value), workflow_id: x.workflow.value,
          parent_type_ids: [...f.querySelectorAll('[name=parent]:checked')].map((n) => n.value), is_milestone: x.milestone.checked,
          defaults: { priority: x.priority.value, ...(x.estimate.value ? { estimate_hours: Number(x.estimate.value) } : {}), ...(x.body.value.trim() ? { description: x.body.value } : {}), ...(x.acceptance.value.trim() ? { acceptance: x.acceptance.value } : {}) },
          ...(ty ? { archived: x.archived.checked } : {}),
          mapping: Object.fromEntries([...f.querySelectorAll('[data-map]')].map((n) => [n.dataset.map, n.value])) };
        try {
          return await pm.saveType(project.id, ty?.id || null, p);
        } catch (err) {
          if (!err.needs?.length || typeof err.needs[0] !== 'object') throw err;
          // moving to another workflow: say what each status in use becomes there
          const targets = cfg.statuses.filter((s) => s.workflow_id === x.workflow.value);
          f.querySelector('[data-mapping]').innerHTML = `<fieldset class="pm-section"><legend>${esc(ty.name)} items are in statuses the new workflow doesn't have</legend>${err.needs.map((s) => `<div class="field"><label>${esc(s.name)} (${s.items} item${s.items === 1 ? '' : 's'}) becomes</label>
            <select data-map="${esc(s.id)}" required><option value="">Pick a status</option>${targets.map((q) => opt(q.id, q.name, q.id === s.to)).join('')}</select></div>`).join('')}</fieldset>`;
          throw Object.assign(new Error('map'), { stay: true });
        }
      } });
    if (res) reload();
  });

  /** A copy of the type's shared workflow that only this type uses, so its statuses and moves can change on their own. Its items keep their status (the copy of it). */
  async function ownWorkflow(ty) {
    const wf = cfg.workflows.find((w) => w.id === ty.workflow_id);
    const ok = await formDialog({ title: `Give ${esc(ty.name)} its own workflow?`, submit: 'Make a copy for it',
      body: `<p>${esc(ty.name)} shares "${esc(wf.name)}" with ${sharing(ty) - 1} other type${sharing(ty) === 2 ? '' : 's'}. This makes a copy named "${esc(ty.name)} workflow" that only ${esc(ty.name)} uses, so you can change it without touching the others.</p>
        <p class="hint">Its items stay in the same status (in the copy). An approval that's waiting on one of them is cancelled and can be asked for again.</p>`,
      onSubmit: async () => {
        const ids = new Map(cfg.statuses.filter((q) => q.workflow_id === wf.id).map((q) => [q.id, newId()]));
        const copy = await pm.saveWorkflow(project.id, null, { name: `${ty.name} workflow`.slice(0, 80), description: `Made from "${wf.name}" for ${ty.name}.`,
          statuses: cfg.statuses.filter((q) => q.workflow_id === wf.id).sort((x, y) => x.sort - y.sort).map(({ id, name, category, color, sort, x, y }) => ({ id: ids.get(id), name, category, color, sort, x, y })),
          transitions: cfg.transitions.filter((q) => q.workflow_id === wf.id).map((q, n) => ({ id: newId(), name: q.name, from_status: q.from_status ? ids.get(q.from_status) : null, to_status: ids.get(q.to_status),
            description: q.description || '', role_ids: q.role_ids || [], require_fields: q.require_fields || [], require_comment: !!q.require_comment, require_approval: !!q.require_approval,
            no_self_approval: !!q.no_self_approval, conditions: q.conditions || null, actions: q.actions || [], sort: (n + 1) * 10 })) });
        await pm.saveType(project.id, ty.id, { workflow_id: copy.id, mapping: Object.fromEntries(ids) });
        return copy;
      } });
    if (!ok) return;
    toast(`${ty.name} has its own workflow now.`);
    await reload();
  }
}

// ---- Fields --------------------------------------------------------------------------------------------
async function fields(el, { project, cfg, reload }) {
  const typeName = (t) => FIELD_TYPES.find(([k]) => k === t)?.[1] || t;
  const list = [...cfg.fields].sort((x, y) => !!x.archived_at - !!y.archived_at || x.sort - y.sort);
  el.innerHTML = `<section class="card" id="pm-all-fields"><h2>All fields ${infoTip('Every field can also be a list column, a filter and a board swimlane.')}</h2><p class="muted">Extra information kept on items. Put them on a type's <a href="${projectHref(project.key, 'settings/forms')}">form</a>.</p>
    ${list.length ? `<div class="table-wrap"><table class="pm-table"><thead><tr><th>Field</th><th>Kind</th><th>On</th><th></th></tr></thead><tbody>${list.map((f) => `<tr class="${f.archived_at ? 'is-done' : ''}">
      <td><strong>${esc(f.name)}</strong> <code class="muted small">${esc(f.key)}</code>${f.archived_at ? ' <span class="chip-tone tone-gray">Archived</span>' : ''}<div class="muted small">${esc(f.description)}</div></td>
      <td>${esc(typeName(f.type))}${f.options.length ? `<div class="muted small">${esc(f.options.slice(0, 6).join(', '))}${f.options.length > 6 ? '…' : ''}</div>` : ''}${f.type === 'formula' ? `<div class="muted small"><code>${esc(f.formula)}</code></div>` : ''}</td>
      <td>${f.type_ids.length ? f.type_ids.map((id) => esc(cfg.typeById.get(id)?.name || '')).join(', ') : '<span class="muted">Every type</span>'}</td>
      <td><button type="button" class="btn btn-sm" data-edit-field="${esc(f.id)}">Edit</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No custom fields yet.</p>'}
    <p><button type="button" class="btn btn-primary" data-new-field>+ Field</button></p></section>`;
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t || (t.dataset.newField === undefined && !t.dataset.editField)) return;
    const res = await fieldDialog(project, cfg, cfg.fields.find((x) => x.id === t.dataset.editField));
    if (res) reload();
  });
}

/** A custom field's dialog (new when fd is empty). Resolves with the saved field, or null. Fields and Forms (V5) use it. */
function fieldDialog(project, cfg, fd, preset = {}) {
    const keyFrom = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+|_+$/g, '').slice(0, 40);
    return formDialog({ title: fd ? `Field: ${esc(fd.name)}` : 'New field', submit: 'Save', wide: true,
      body: `<div class="form-grid"><div class="field span-2"><label for="fd-name">Name</label><input id="fd-name" name="name" type="text" maxlength="60" required value="${esc(fd?.name || preset.name || '')}" placeholder="Test date"></div>
          <div class="field"><label for="fd-key">Key</label><input id="fd-key" name="key" type="text" maxlength="40" pattern="[a-z][a-z0-9_]*" required value="${esc(fd?.key || '')}" ${fd ? 'readonly' : ''}><div class="hint">Used in formulas and filters. Can't change later.</div></div>
          <div class="field"><label for="fd-type">Kind</label><select id="fd-type" name="type" ${fd ? 'disabled' : ''}>${FIELD_TYPES.map(([k, l]) => opt(k, l, (fd?.type || 'text') === k)).join('')}</select>${fd ? '<div class="hint">Can\'t change once it exists.</div>' : ''}</div>
          <div class="field span-4"><label for="fd-desc">Help text shown under it</label><input id="fd-desc" name="description" type="text" maxlength="500" value="${esc(fd?.description || '')}"></div>
          <div class="field span-4" data-for="select multiselect"><label for="fd-options">Choices (one per line)</label><textarea id="fd-options" name="options" rows="4">${esc((fd?.options || []).join('\n'))}</textarea>
            <div class="hint">Give choices a color to show them as colored tags on cards, lists and items (optional).</div><div class="pm-tone-rows" data-tones></div></div>
          <div class="field" data-for="integer decimal currency duration"><label for="fd-min">At least</label><input id="fd-min" name="min" type="number" step="any" value="${esc(fd?.validation?.min ?? '')}"></div>
          <div class="field" data-for="integer decimal currency duration"><label for="fd-max">At most</label><input id="fd-max" name="max" type="number" step="any" value="${esc(fd?.validation?.max ?? '')}"></div>
          <div class="field" data-for="text longtext richtext"><label for="fd-maxlen">Longest (characters)</label><input id="fd-maxlen" name="maxlen" type="number" min="1" value="${esc(fd?.validation?.maxlen ?? '')}"></div>
          <div class="field span-2" data-for="text"><label for="fd-pattern">Must look like (a pattern, optional)</label><input id="fd-pattern" name="pattern" type="text" maxlength="200" value="${esc(fd?.validation?.pattern ?? '')}" placeholder="^DWG-[0-9]{4}$"></div>
          <div class="field span-4" data-for="formula"><label for="fd-formula">Formula</label><input id="fd-formula" name="formula" type="text" maxlength="500" value="${esc(fd?.formula || '')}" placeholder="round(spent / budget * 100, 1)">
            <div class="hint">Field keys: ${cfg.fields.filter((x) => x.type !== 'formula').map((x) => `<code>${esc(x.key)}</code>`).join(' ') || 'none yet'} ${FORMULA_BUILTINS.map((x) => `<code>${x}</code>`).join(' ')}. Functions: ${FORMULA_FUNCTIONS.map((x) => `<code>${x}()</code>`).join(' ')}. + - * / and comparisons.</div>
            <div data-formula-check class="small" aria-live="polite"></div></div>
          <div class="field span-2" data-for="text integer decimal currency duration select date url"><label for="fd-default">Starts as (optional)</label><input id="fd-default" name="default" type="text" value="${esc(fd?.default_value ?? '')}"></div></div>
        <fieldset class="pm-section"><legend>Only on these work types (none ticked: all of them)</legend><div class="pm-checks">${cfg.types.filter((x) => !x.archived_at).map((x) => `<label class="pm-check"><input type="checkbox" name="types" value="${esc(x.id)}" ${(fd ? fd.type_ids.includes(x.id) : preset.type_id === x.id) ? 'checked' : ''}> ${esc(x.name)}</label>`).join('')}</div></fieldset>
        ${fd ? `<label class="pm-check"><input type="checkbox" name="archived" ${fd.archived_at ? 'checked' : ''}> Archived (its values are kept; it leaves forms and filters)</label>` : ''}`,
      onOpen(f) {
        const show = () => f.querySelectorAll('[data-for]').forEach((n) => (n.hidden = !n.dataset.for.split(' ').includes(f.elements.type.value)));
        show();
        f.elements.type.onchange = show;
        // 069: a color per choice, kept while the choices are edited
        const tones = { ...(fd?.option_tones || {}) };
        const toneBox = f.querySelector('[data-tones]');
        const drawTones = () => {
          const opts = [...new Set(f.elements.options.value.split('\n').map((x) => x.trim()).filter(Boolean))].slice(0, 200);
          toneBox.innerHTML = opts.map((o) => `<label class="pm-tone-row"><span class="chip-tone tone-${esc(tones[o] || 'gray')}">${esc(o)}</span>
            <select data-tone-for="${esc(o)}" aria-label="Color for ${esc(o)}"><option value="">No color</option>${TONES.map((t) => `<option value="${t}" ${tones[o] === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`).join('');
        };
        drawTones();
        f.elements.options.addEventListener('input', drawTones);
        toneBox.addEventListener('change', (e) => {
          const o = e.target.dataset.toneFor;
          if (o === undefined) return;
          if (e.target.value) tones[o] = e.target.value; else delete tones[o];
          drawTones();
        });
        f.readTones = () => Object.fromEntries([...toneBox.querySelectorAll('[data-tone-for]')].filter((s) => s.value).map((s) => [s.dataset.toneFor, s.value]));
        let typedKey = !!fd;
        f.elements.key.oninput = () => (typedKey = true);
        f.elements.name.oninput = () => !typedKey && (f.elements.key.value = keyFrom(f.elements.name.value));
        f.elements.formula.oninput = () => {
          const bad = checkFormula(f.elements.formula.value, cfg.fields.map((x) => x.key));
          f.querySelector('[data-formula-check]').innerHTML = f.elements.formula.value ? (bad ? `<span class="is-late">${esc(bad)}</span>` : '<span style="color:var(--green)">✓ Reads fine</span>') : '';
        };
      },
      onSubmit(f) {
        const x = f.elements;
        const type = fd?.type || x.type.value;
        if (type === 'formula') {
          const bad = checkFormula(x.formula.value, cfg.fields.map((q) => q.key));
          if (bad) throw new Error(bad);
        }
        const num = (v) => (v === '' ? undefined : Number(v));
        const validation = Object.fromEntries(Object.entries({ min: num(x.min.value), max: num(x.max.value), maxlen: num(x.maxlen.value), pattern: x.pattern.value || undefined }).filter(([, v]) => v !== undefined));
        return pm.saveField(project.id, fd?.id || null, { key: x.key.value, name: x.name.value.trim(), type, description: x.description.value,
          options: x.options.value.split('\n').map((s) => s.trim()).filter(Boolean), option_tones: f.readTones ? f.readTones() : {}, validation, formula: x.formula.value.trim(),
          default_value: x.default.value.trim() === '' ? null : x.default.value.trim(), type_ids: [...f.querySelectorAll('[name=types]:checked')].map((n) => n.value), ...(fd ? { archived: x.archived.checked } : {}) });
      } });
}

// ---- Forms ---------------------------------------------------------------------------------------------
const formState = { type: '', kind: 'create', transition: '', draft: null };
async function forms(el, { b, project, cfg, reload }) {
  const st = formState;
  if (st.type && !cfg.typeById.has(st.type)) st.type = '';
  const moves = cfg.transitions.filter((t) => !st.type || t.workflow_id === cfg.typeById.get(st.type).workflow_id);
  if (st.kind === 'transition' && !moves.some((t) => t.id === st.transition)) st.transition = moves[0]?.id || '';
  const trId = st.kind === 'transition' ? st.transition || null : null;
  const own = cfg.layouts.find((l) => l.kind === st.kind && (l.type_id || '') === st.type && (l.transition_id || null) === trId);
  const typeId = st.type || cfg.types.find((t) => !t.archived_at)?.id;
  // V5: an unsaved form survives making a new field (which reloads the page)
  const draftKey = `${st.type}|${st.kind}|${trId || ''}`;
  if (st.draft && st.draft.key !== draftKey) st.draft = null;
  let sections = JSON.parse(JSON.stringify(st.draft ? st.draft.sections : own ? own.sections : layoutFor(cfg, typeId, st.kind, trId)));
  if (!sections.length) sections = [{ title: '', fields: [] }];
  let dirty = !!st.draft;
  const keep = () => (st.draft = { key: draftKey, sections });
  const available = () => {
    const used = new Set(sections.flatMap((s) => s.fields.map((f) => f.key)));
    return [...BUILTIN_FIELDS.map(([k]) => k), ...cfg.fields.filter((f) => !f.archived_at && (!st.type || !f.type_ids.length || f.type_ids.includes(st.type))).map((f) => `cf.${f.key}`)].filter((k) => !used.has(k));
  };
  const draw = () => {
    el.querySelector('[data-builder]').innerHTML = `${sections.map((s, si) => `<fieldset class="pm-section pm-form-sec" data-si="${si}">
        <div class="pm-col-head"><input type="text" data-sec-title maxlength="80" value="${esc(s.title || '')}" placeholder="Section title (optional)" aria-label="Section title">
          <button type="button" class="btn btn-sm btn-ghost" data-sec-up ${si ? '' : 'disabled'} aria-label="Move section up">↑</button><button type="button" class="btn btn-sm btn-ghost" data-sec-down ${si < sections.length - 1 ? '' : 'disabled'} aria-label="Move section down">↓</button>
          <button type="button" class="btn btn-sm btn-ghost" data-sec-del>Remove section</button></div>
        <ul class="pm-form-fields">${s.fields.map((f, fi) => `<li data-fi="${fi}"><span>${esc(fieldLabel(f.key, cfg.fields))}</span>
          ${st.kind === 'view' ? '' : `<label class="pm-check"><input type="checkbox" data-req ${f.required ? 'checked' : ''} ${['blocked', 'progress', 'priority', 'collaborators'].includes(f.key) || cfg.fields.find((q) => `cf.${q.key}` === f.key)?.type === 'formula' ? 'disabled' : ''}> Required</label>`}
          <span><button type="button" class="btn btn-sm btn-ghost" data-f-up ${fi ? '' : 'disabled'} aria-label="Move up">↑</button><button type="button" class="btn btn-sm btn-ghost" data-f-down ${fi < s.fields.length - 1 ? '' : 'disabled'} aria-label="Move down">↓</button>
            <button type="button" class="btn btn-sm btn-ghost" data-f-del aria-label="Take off the form">✕</button></span></li>`).join('') || '<li class="muted">No fields in this section.</li>'}</ul>
        <select data-add-field aria-label="Add a field to this section"><option value="">+ Add a field…</option>${available().map((k) => opt(k, fieldLabel(k, cfg.fields))).join('')}</select></fieldset>`).join('')}
      <p><button type="button" class="btn btn-sm" data-sec-add>+ Section</button></p>`;
    // V5: every field not on the form yet; click one to add it to the last section
    el.querySelector('[data-palette]').innerHTML = available().map((k) => `<button type="button" class="pm-pal-item" data-pal="${esc(k)}">+ ${esc(fieldLabel(k, cfg.fields))}</button>`).join('')
      || '<p class="muted small">Every field is on this form.</p>';
    el.querySelector('[data-preview]').innerHTML = `<div class="field"><label>Title <span class="pm-req">*</span></label><input type="text" disabled placeholder="(always first)"></div>${formSections(sections, { b, cfg, item: {}, parents: [], collaborators: [] })}`;
    el.querySelector('[data-preview]').querySelectorAll('input, select, textarea').forEach((n) => (n.disabled = true));
    el.querySelector('[data-save-form]').classList.toggle('btn-primary', dirty);
  };
  const KINDS = [['create', 'When creating an item'], ['edit', 'When editing an item'], ['view', 'On the item\'s page'], ['transition', 'When making a move']];
  el.innerHTML = `<section class="card"><h2>Forms ${infoTip("A work type without its own form uses the project's; without that, the standard form.")}</h2><p class="muted">Which fields each form shows, in what order, and which are required.</p>
      <div class="pm-filters"><label class="inline-field">For <select data-form-type>${opt('', 'Every type (the project\'s form)', !st.type)}${cfg.types.filter((t) => !t.archived_at).map((t) => opt(t.id, t.name, t.id === st.type)).join('')}</select></label>
        <label class="inline-field">Form <select data-form-kind>${KINDS.map(([k, l]) => opt(k, l, k === st.kind)).join('')}</select></label>
        ${st.kind === 'transition' ? `<label class="inline-field">Move <select data-form-move>${moves.map((t) => opt(t.id, `${t.name} → ${cfg.statusById.get(t.to_status)?.name}`, t.id === st.transition)).join('') || '<option value="">No moves</option>'}</select></label>` : ''}
        <span class="chip-tone tone-${own ? 'blue' : 'gray'}">${own ? 'Has its own form' : 'Using the default'}</span></div>
      <div class="pm-form-build"><div><h3>Build</h3><div data-builder></div></div>
        <div><h3>Fields</h3><p class="hint" style="margin-top:0">Click one to add it to the last section.</p><div class="pm-palette" data-palette></div>
          <p><button type="button" class="btn btn-sm" data-new-field-here>New field</button></p>
          <h3>Preview</h3><div class="pm-form-preview" data-preview></div></div></div>
      <div class="form-actions">${own ? '<button type="button" class="btn btn-ghost" data-reset-form>Back to the default form</button>' : ''}<button type="button" class="btn" data-save-form>Save this form</button></div></section>`;
  draw();
  const touch = () => ((dirty = true), keep(), draw());
  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-form-type]')) ((st.type = t.value), (st.draft = null), reload());
    else if (t.matches('[data-form-kind]')) ((st.kind = t.value), (st.draft = null), reload());
    else if (t.matches('[data-form-move]')) ((st.transition = t.value), (st.draft = null), reload());
    else if (t.matches('[data-add-field]') && t.value) (sections[Number(t.closest('[data-si]').dataset.si)].fields.push({ key: t.value }), touch());
    else if (t.matches('[data-req]')) ((sections[Number(t.closest('[data-si]').dataset.si)].fields[Number(t.closest('[data-fi]').dataset.fi)].required = t.checked), touch());
  });
  el.addEventListener('input', (e) => e.target.matches('[data-sec-title]') && ((sections[Number(e.target.closest('[data-si]').dataset.si)].title = e.target.value), (dirty = true), keep()));
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const si = Number(t.closest('[data-si]')?.dataset.si);
    const fi = Number(t.closest('[data-fi]')?.dataset.fi);
    const d = t.dataset;
    if (d.pal) {
      if (!sections.length) sections.push({ title: '', fields: [] });
      sections[sections.length - 1].fields.push({ key: d.pal });
    } else if (d.newFieldHere !== undefined) {
      // V5: make a field here; it goes onto this form (not saved until "Save this form")
      const made = await fieldDialog(project, cfg, null, { type_id: st.type });
      if (!made) return;
      if (!sections.length) sections.push({ title: '', fields: [] });
      sections[sections.length - 1].fields.push({ key: `cf.${made.key}` });
      keep();
      toast(`"${made.name}" is on the form. Save the form to keep it there.`);
      return void reload();
    } else if (d.secAdd !== undefined) sections.push({ title: 'New section', fields: [] });
    else if (d.secDel !== undefined) sections.splice(si, 1);
    else if (d.secUp !== undefined) sections.splice(si - 1, 0, sections.splice(si, 1)[0]);
    else if (d.secDown !== undefined) sections.splice(si + 1, 0, sections.splice(si, 1)[0]);
    else if (d.fDel !== undefined) sections[si].fields.splice(fi, 1);
    else if (d.fUp !== undefined) sections[si].fields.splice(fi - 1, 0, sections[si].fields.splice(fi, 1)[0]);
    else if (d.fDown !== undefined) sections[si].fields.splice(fi + 1, 0, sections[si].fields.splice(fi, 1)[0]);
    else if (d.saveForm !== undefined || d.resetForm !== undefined) {
      const body = d.resetForm !== undefined ? [] : sections.filter((s) => s.fields.length).map((s) => ({ title: s.title || '', fields: s.fields.map((f) => ({ key: f.key, ...(f.required ? { required: true } : {}) })) }));
      if (d.saveForm !== undefined && !body.length) return toast('Add at least one field, or use "Back to the default form".', 'bad');
      if (await attempt(() => pm.saveLayout(project.id, { type_id: st.type || null, kind: st.kind, transition_id: trId, sections: body }), d.resetForm !== undefined ? 'Back to the default form.' : 'Form saved.')) ((st.draft = null), reload());
      return;
    } else return;
    touch();
  });
}

// ---- Rules (automation) ----------------------------------------------------------------------------------
async function rules(el, { b, project, cfg, reload }) {
  const runs = await pm.automationRuns(project.id).catch(() => []);
  const starters = starterRules(cfg);   // 069
  const trigger = (r) => {
    const tc = r.trigger_config || {};
    const base = TRIGGERS.find(([k]) => k === r.trigger)?.[1] || r.trigger;
    if (r.trigger === 'status') return `${base}${tc.from ? ` from "${cfg.statusById.get(tc.from)?.name || '?'}"` : ''}${tc.to ? ` to "${cfg.statusById.get(tc.to)?.name || '?'}"` : ''}`;
    if (r.trigger === 'updated' && tc.field) return `${fieldLabel(tc.field.replace(/_id$/, ''), cfg.fields)} is changed`;
    if (r.trigger === 'due_soon') return `An item is due within ${tc.days ?? 2} day(s)`;
    if (r.trigger === 'schedule') return tc.every === 'day' ? 'Every day' : tc.every === 'month' ? `Every month on day ${tc.day ?? 1}` : `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][tc.weekday ?? 1]}`;
    return base;
  };
  el.innerHTML = `<section class="card"><h2>Rules ${infoTip('Rules are built from lists, not code. Each run is logged below; a rule that fails never stops what the person was doing. Timed rules (due soon, overdue, on a schedule) are checked when someone opens Workbench, at most every half hour, or by the scheduled job if an Admin set it up. Rules can set each other off at most three deep, and a rule that runs 60 times in a minute is paused.')}</h2><p class="muted">"When this happens, if these things are true, do that."</p>
      ${cfg.automations.length ? `<div class="table-wrap"><table class="pm-table"><thead><tr><th>Rule</th><th>When</th><th>Then</th><th>On</th><th></th></tr></thead><tbody>${cfg.automations.map((r) => `<tr class="${r.enabled ? '' : 'is-done'}">
        <td><strong>${esc(r.name)}</strong><div class="muted small">${r.last_run_at ? `Last ran ${esc(fmtDateTime(r.last_run_at))}` : 'Hasn\'t run yet'}</div></td>
        <td>${esc(trigger(r))}${r.conditions ? `<div class="muted small">if ${esc(filterText(r.conditions))}</div>` : ''}</td><td>${r.actions.length} action${r.actions.length === 1 ? '' : 's'}</td>
        <td><input type="checkbox" data-toggle-rule="${esc(r.id)}" ${r.enabled ? 'checked' : ''} aria-label="${esc(r.name)} is on"></td>
        <td><button type="button" class="btn btn-sm" data-edit-rule="${esc(r.id)}">Edit</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No rules yet.</p>'}
      <p><button type="button" class="btn btn-primary" data-new-rule>+ Rule</button></p>
      ${starters.length ? `<p class="muted small">Or start from a common one (you can change it before saving):</p><p>${starters.map((x) => `<button type="button" class="btn btn-sm" data-rule-template="${esc(x.key)}">${esc(x.label)}</button>`).join(' ')}</p>` : ''}
    </section>
    <section class="card"><h2>Run log</h2>${runs.length ? `<div class="table-wrap"><table class="pm-table"><thead><tr><th>When</th><th>Rule</th><th>Result</th></tr></thead><tbody>${runs.map((r) => `<tr>
      <td>${esc(fmtDateTime(r.created_at))}</td><td>${esc(cfg.automations.find((a) => a.id === r.rule_id)?.name || 'A deleted rule')}</td>
      <td><span class="chip-tone tone-${r.status === 'ok' ? 'green' : r.status === 'error' ? 'red' : 'amber'}">${r.status === 'ok' ? 'Ran' : r.status === 'error' ? 'Failed' : 'Skipped'}</span> ${esc(r.detail)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing has run yet.</p>'}</section>`;
  el.addEventListener('change', async (e) => {
    if (e.target.dataset.toggleRule) (await attempt(() => pm.saveAutomation(project.id, e.target.dataset.toggleRule, { enabled: e.target.checked }), e.target.checked ? 'Rule is on.' : 'Rule is off.')) && reload();
  });
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t || (t.dataset.newRule === undefined && !t.dataset.editRule && !t.dataset.ruleTemplate)) return;
    const r = cfg.automations.find((x) => x.id === t.dataset.editRule);
    const seed = r || starters.find((x) => x.key === t.dataset.ruleTemplate)?.rule;   // 069: a starter rule fills in a new one
    let conditions = seed?.conditions || null;
    const acts = actionsEditor(b, cfg, seed?.actions || [{ type: 'notify', to: 'owner', message: '' }]);
    const tc = seed?.trigger_config || {};
    const read = (f) => {
      const x = f.elements;
      const trig = x.trigger.value;
      return { name: x.name.value.trim(), enabled: x.enabled.checked, trigger: trig, conditions, actions: acts.read(),
        trigger_config: trig === 'status' ? { from: x.from.value, to: x.to.value } : trig === 'updated' ? { field: x.field.value } : trig === 'due_soon' ? { days: Number(x.days.value) || 2 }
          : trig === 'schedule' ? { every: x.every.value, weekday: Number(x.weekday.value), day: Number(x.day.value) || 1 } : {} };
    };
    const changeable = [['', 'Anything'], ...['title', 'description', 'priority', 'owner_id', 'due_date', 'start_date', 'estimate_hours', 'progress', 'blocked', 'labels', 'subsystem_id', 'sprint_id', 'parent_id'].map((k) => [k, fieldLabel(k.replace(/_id$/, ''))]),
      ...cfg.fields.filter((f) => !f.archived_at && f.type !== 'formula').map((f) => [`cf.${f.key}`, f.name])];
    const res = await formDialog({ title: r ? `Rule: ${esc(r.name)}` : 'New rule', submit: 'Save', wide: true,
      body: `<div class="field"><label for="ru-name">Name</label><input id="ru-name" name="name" type="text" maxlength="80" required value="${esc(seed?.name || '')}" placeholder="Review requested → tell the lead"></div>
        <fieldset class="pm-section"><legend>When</legend><div class="pm-cond-row"><select name="trigger" aria-label="When">${TRIGGERS.map(([k, l]) => opt(k, l, (seed?.trigger || 'status') === k)).join('')}</select>
          <span data-for="status">from <select name="from" aria-label="From status">${opt('', 'any status', !tc.from)}${cfg.statuses.map((s) => opt(s.id, s.name, tc.from === s.id)).join('')}</select> to <select name="to" aria-label="To status">${opt('', 'any status', !tc.to)}${cfg.statuses.map((s) => opt(s.id, s.name, tc.to === s.id)).join('')}</select></span>
          <span data-for="updated">what changed: <select name="field" aria-label="Field">${changeable.map(([k, l]) => opt(k, l, (tc.field || '') === k)).join('')}</select></span>
          <span data-for="due_soon">within <input name="days" type="number" min="0" max="60" value="${esc(tc.days ?? 2)}" style="width:80px" aria-label="Days"> days</span>
          <span data-for="schedule"><select name="every" aria-label="How often">${[['day', 'every day'], ['week', 'every week on'], ['month', 'every month on day']].map(([k, l]) => opt(k, l, (tc.every || 'week') === k)).join('')}</select>
            <select name="weekday" aria-label="Weekday">${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, n) => opt(n, d, (tc.weekday ?? 1) === n)).join('')}</select>
            <input name="day" type="number" min="1" max="28" value="${esc(tc.day ?? 1)}" style="width:80px" aria-label="Day of the month"></span></div></fieldset>
        <fieldset class="pm-section"><legend>If</legend><p><span data-cond-text class="muted">${esc(filterText(conditions) || 'always')}</span> <button type="button" class="btn btn-sm" data-cond>Set conditions</button></p></fieldset>
        <fieldset class="pm-section"><legend>Then</legend>${acts.html()}</fieldset>
        <label class="pm-check"><input type="checkbox" name="enabled" ${seed?.enabled === false ? '' : 'checked'}> On</label>
        <p><button type="button" class="btn btn-sm" data-try>Try it (changes nothing)</button> <span data-try-out class="muted" aria-live="polite"></span></p>
        ${r ? '<label class="pm-check"><input type="checkbox" name="delete"> Delete this rule</label>' : ''}`,
      onOpen(f) {
        acts.bind(f);
        const show = () => f.querySelectorAll('[data-for]').forEach((n) => (n.hidden = n.dataset.for !== f.elements.trigger.value));
        show();
        f.elements.trigger.onchange = show;
        f.querySelector('[data-cond]').onclick = async () => {
          const next = await conditionDialog(b, conditions, { fields: cfg.fields, statuses: cfg.statuses, sprints: cfg.sprints }, 'Only for items where…');
          if (next !== undefined) ((conditions = next), (f.querySelector('[data-cond-text]').textContent = filterText(conditions) || 'always'));
        };
        f.querySelector('[data-try]').onclick = async () => {
          const out = f.querySelector('[data-try-out]');
          try {
            const res2 = await pm.testAutomation(project.id, read(f));
            out.textContent = `${res2.matches} item${res2.matches === 1 ? '' : 's'} match the conditions right now${res2.sample.length ? `: ${res2.sample.slice(0, 5).map((s) => s.key).join(', ')}${res2.matches > 5 ? '…' : ''}` : ''}. The rule would act on such an item when its trigger happens.`;
          } catch (err) {
            out.textContent = err.message;
          }
        };
      },
      onSubmit: (f) => (f.elements.delete?.checked ? pm.deleteAutomation(r.id).then(() => true) : pm.saveAutomation(project.id, r?.id || null, { ...read(f), ...(r ? { version: r.version } : {}) })) });
    if (res) reload();
  });
}

// ---- Templates -----------------------------------------------------------------------------------------
async function templates(el, { b, project, reload }) {
  const [list] = await Promise.all([pm.templates()]);
  const others = b.projects.filter((p) => p.id !== project.id && !p.archived_at);
  el.innerHTML = `<section class="card"><h2>Reuse this project's set-up</h2>
      <p>Save how this project works (roles, workflows, work types, fields, forms, shared boards, rules and settings) as a template for new projects, or download it as a file.</p>
      <div class="card-actions"><button type="button" class="btn btn-primary" data-save-template>Save as a template…</button><button type="button" class="btn" data-export>Download the configuration</button></div></section>
    <section class="card"><h2>Bring a set-up into this project</h2>
      <p>From a template or another project. You choose the parts and see exactly what would change first. It only adds and updates: nothing is removed and no item is touched.</p>
      <div class="pm-filters"><select data-from aria-label="Take it from"><optgroup label="Templates">${list.map((t) => opt(`t:${t.id}`, t.name)).join('')}</optgroup>
        ${others.length ? `<optgroup label="Other projects">${others.map((p) => opt(`p:${p.id}`, p.name)).join('')}</optgroup>` : ''}</select>
        <button type="button" class="btn" data-apply>Choose parts and preview…</button></div>
      <p class="hint"><a href="#/projects/templates">All templates</a></p></section>`;
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.saveTemplate !== undefined) {
      const res = await formDialog({ title: 'Save as a template', submit: 'Save template',
        body: `<div class="field"><label for="st-name">Template name</label><input id="st-name" name="name" type="text" maxlength="80" required value="${esc(project.name)} set-up"></div>
          <div class="field"><label for="st-desc">What it's for</label><textarea id="st-desc" name="description" rows="2"></textarea></div>
          <label class="pm-check"><input type="checkbox" name="items"> Include this project's items as starter items</label>`,
        onSubmit: (f) => pm.saveTemplate(null, { name: f.elements.name.value.trim(), description: f.elements.description.value, from_project: project.id, include_items: f.elements.items.checked }) });
      if (res) toast('Template saved. New projects can start from it.');
    } else if (t.dataset.export !== undefined) {
      const cfg2 = await attempt(() => pm.exportConfig(project.id, false));
      if (cfg2) download(`${project.key.toLowerCase()}.onesolar-project.json`, { onesolar: 'project-template', name: `${project.name} set-up`, description: '', config: cfg2 });
    } else if (t.dataset.apply !== undefined) {
      const v = el.querySelector('[data-from]').value;
      const name = el.querySelector('[data-from]').selectedOptions[0].textContent;
      if (await applyConfigDialog(b, [project], v.startsWith('t:') ? { template_id: v.slice(2) } : { from_project: v.slice(2) }, `"${name}"`)) reload();
    }
  });
}
