/**
 * Workbench → Spaces: every space I can see, by CE division (one space per subsystem, 072), with how each is doing.
 * Spaces last across car cycles (074): the car cycles are listed here to edit or start a new one, and the switcher
 * on each space and across Workbench picks which car's work shows. "New space" starts from a template (the whole
 * configuration: types, workflow, fields, forms, boards, rules, starter items).
 */
import { esc, fmtDate, setFlash, takeFlash } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { progressOf, attention } from '../../projects/core.js';
import { todayISO } from '../../projects/schedule.js';
import { needsDatabase, loadBase, invalidate, header, projectHref, personName, canCreateProjects, formDialog, peopleField, bindOrgPickers, attempt } from './kit.js';
import { cyclesOf, currentCycle, cycleDialog, newCycleDialog } from './cycles.js';

const view = { archived: false, q: '' };

/** A bar of to do / in progress / done, with the numbers in its label. */
export const progressBar = (p) => (p.total
  ? `<div class="pm-bar" role="img" aria-label="${p.done} done, ${p.doing} in progress, ${p.todo} to do">
      <span class="is-done" style="flex:${p.done}"></span><span class="is-doing" style="flex:${p.doing}"></span><span class="is-todo" style="flex:${p.todo}"></span></div>`
  : '<div class="pm-bar is-empty" role="img" aria-label="No items yet"></div>');

export async function renderProjects(el, { config, rerender }) {
  const missing = needsDatabase(config);
  if (missing) return void (el.innerHTML = missing);
  const [b, rollup] = await Promise.all([loadBase(), pm.rollup()]);
  const byProject = new Map();
  for (const g of rollup.groups) (byProject.get(g.project_id) || byProject.set(g.project_id, []).get(g.project_id)).push(g);
  const q = view.q.trim().toLowerCase();
  const shown = b.projects.filter((p) => !!p.archived_at === view.archived && (!q || `${p.name} ${p.key} ${p.description}`.toLowerCase().includes(q)));
  // one section per CE division (a subsystem's space is in its division); spaces with none last
  const cycles = cyclesOf(b);
  const divs = b.divisions.filter((d) => !d.archived_at).sort((a, z) => (a.sort ?? 0) - (z.sort ?? 0) || a.name.localeCompare(z.name));
  const sections = [...divs.map((d) => ({ id: d.id, name: d.name })), { id: null, name: divs.length ? 'Other spaces' : '' }];
  const divOf = (p) => p.division_id || b.subsystemById.get(p.subsystem_id)?.division_id || null;
  const now = currentCycle(b);
  const dates = (g) => [g.start_date && fmtDate(g.start_date), g.end_date && fmtDate(g.end_date)].filter(Boolean).join(' – ');

  const card = (p) => {
    const pr = progressOf(byProject.get(p.id) || []);
    const why = attention(pr);
    const org = b.subsystemById.get(p.subsystem_id)?.name || b.divisionById.get(p.division_id)?.name || '';
    return `<a class="card pm-project${why.length ? ' needs-attention' : ''}" href="${projectHref(p.key)}" data-project="${esc(p.key)}">
      <div class="pm-project-top"><h3>${esc(p.name)}</h3><span class="pm-key">${esc(p.key)}</span></div>
      <div class="muted small">${[org, p.lead_id ? `Manager: ${personName(b, p.lead_id)}` : '', p.visibility === 'private' ? 'Private' : ''].filter(Boolean).map(esc).join(' · ')}</div>
      ${progressBar(pr)}
      <div class="pm-project-nums"><span>${pr.total - pr.done} open</span>${pr.overdue ? `<span class="is-late">${pr.overdue} overdue</span>` : ''}${pr.blocked ? `<span class="is-late">${pr.blocked} blocked</span>` : ''}
        ${pr.nextMs ? `<span title="Next milestone">⚑ ${esc(fmtDate(pr.nextMs))}${pr.nextMs < todayISO() ? ' (late)' : ''}</span>` : ''}</div>
      ${why.length ? `<div class="pm-attention" title="Why this space may need someone to step in">⚠ ${esc(why.join('; '))}</div>` : ''}</a>`;
  };

  el.innerHTML = `${takeFlash()}${header('Spaces', 'Every space you can see. What you can change in each one depends on your role in it.',
    `${canCreateProjects() ? `<button type="button" class="btn" id="new-program">${cycles.length ? 'Start a new car cycle' : 'Add car cycles'}</button><button type="button" class="btn btn-primary" id="new-project">New space</button>` : ''}`)}
    ${cycles.length ? `<div class="pm-cycle-list"><span class="muted small">Car cycles</span>${cycles.map((g) => `<span class="pm-cycle-chip${g.id === now?.id ? ' is-now' : ''}" title="${esc(dates(g))}">${esc(g.name)}${g.id === now?.id ? ' <span class="pm-cycle-now">now</span>' : ''}
        ${canCreateProjects() ? `<button type="button" class="link-btn" data-edit-program="${esc(g.id)}" aria-label="Edit ${esc(g.name)}">Edit</button>` : ''}</span>`).join('')}
      <span class="hint">Spaces last across cars; pick a car at the top of a space to see its work.</span></div>` : ''}
    <div class="pm-filters"><input type="search" id="proj-q" placeholder="Find a space" aria-label="Find a space" value="${esc(view.q)}">
      <label class="pm-check"><input type="checkbox" id="proj-archived" ${view.archived ? 'checked' : ''}> Archived</label></div>
    ${sections.map((g) => {
      const list = shown.filter((p) => (divs.some((d) => d.id === divOf(p)) ? divOf(p) : null) === g.id);
      if (!list.length) return '';
      return `<section class="pm-program">${g.name ? `<h2>${esc(g.name)}</h2>` : ''}
        <div class="pm-project-grid">${list.map(card).join('')}</div></section>`;
    }).join('')}
    ${shown.length ? '' : `<div class="empty"><p><strong>${view.archived ? 'No archived spaces.' : q ? 'No space matches.' : 'No spaces yet.'}</strong></p>
      ${!view.archived && !q ? `<p>${canCreateProjects() ? 'Start one from a template: it comes with work types, a workflow and a board you can change later.' : 'A Chief Engineer or an Admin can start one.'}</p>` : ''}</div>`}`;

  el.querySelector('#proj-q').oninput = (e) => {
    view.q = e.target.value;
    clearTimeout(view.t);
    view.t = setTimeout(rerender, 250);
  };
  el.querySelector('#proj-archived').onchange = (e) => {
    view.archived = e.target.checked;
    rerender();
  };
  el.querySelector('#new-project')?.addEventListener('click', async () => {
    const p = await createProjectDialog(b);
    if (p) {
      invalidate();
      setFlash(`${p.name} is ready. You're its Project Administrator: set it up in Settings, or just start adding items.`);
      location.hash = projectHref(p.key);
    }
  });
  el.querySelector('#new-program')?.addEventListener('click', async () => {
    if (!cycles.length) return void ((await cycleDialog(b)) && rerender());
    const r = await newCycleDialog(b);
    if (!r) return;
    setFlash(`${r.cycle.name} is ready. Every space carries on; pick ${r.cycle.name} at the top of a space to add its work.`);
    rerender();
  });
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-edit-program]');
    if (t && (await cycleDialog(b, b.programs.find((g) => g.id === t.dataset.editProgram)))) rerender();
  });
}

/** Name, key, template and who it's for. Resolves with the new project or null. */
export async function createProjectDialog(b, templateId = null) {
  const templates = await attempt(() => pm.templates());
  if (!templates) return null;
  const keyFrom = (name) => (name.toUpperCase().match(/[A-Z0-9]+/g) || []).map((w, i, all) => (all.length === 1 ? w.slice(0, 4) : w[0])).join('').replace(/^[0-9]+/, '').slice(0, 6);
  return formDialog({
    title: 'New space', submit: 'Create space', wide: true,
    body: `<div class="form-grid">
        <div class="field span-3"><label for="np-name">Name</label><input id="np-name" name="name" type="text" maxlength="120" required placeholder="Battery Pack Development"></div>
        <div class="field"><label for="np-key">Key</label><input id="np-key" name="key" type="text" maxlength="10" required pattern="[A-Za-z][A-Za-z0-9]{1,9}" placeholder="BAT">
          <div class="hint">Starts every item's name (BAT-24). It can't change later.</div></div>
        <div class="field span-4"><label for="np-template">Start from</label><select id="np-template" name="template">${templates.map((t) => `<option value="${esc(t.id)}" ${t.id === templateId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
          <div class="hint" data-template-about></div></div>
        <div class="field span-2"><label for="np-lead">Project manager</label>${peopleField('lead', 'np-lead', b, b.me, { blank: 'Nobody yet' })}</div>
        <div class="field span-2"><label for="np-div">CE division</label><select id="np-div" name="division" data-division><option value="">—</option>${b.divisions.filter((d) => !d.archived_at).map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select></div>
        <div class="field span-2"><label for="np-sub">Subsystem</label><select id="np-sub" name="subsystem" data-subsystem><option value="">—</option>${b.subsystems.filter((s) => !s.archived_at).map((s) => `<option value="${esc(s.id)}" data-div="${esc(s.division_id)}">${esc(s.name)}</option>`).join('')}</select></div>
        <div class="field span-2"><label for="np-vis">Who can see it</label><select id="np-vis" name="visibility"><option value="team">The whole team (read-only unless they're added)</option><option value="private">Only people added to it</option></select></div>
        <div class="field span-2"><label for="np-start">Start date</label><input id="np-start" name="start" type="date" value="${esc(todayISO())}"><div class="hint">A template's starter items get their dates from this day.</div></div>
      </div>`,
    onOpen(form) {
      bindOrgPickers(form);
      const about = () => (form.querySelector('[data-template-about]').textContent = templates.find((t) => t.id === form.elements.template.value)?.description || '');
      about();
      form.elements.template.onchange = about;
      let typedKey = false;
      form.elements.key.oninput = () => (typedKey = true);
      form.elements.name.oninput = () => !typedKey && (form.elements.key.value = keyFrom(form.elements.name.value));
    },
    async onSubmit(form) {
      const f = form.elements;
      const p = await pm.saveProject(null, { name: f.name.value.trim(), key: f.key.value.trim().toUpperCase(), template_id: f.template.value, start_date: f.start.value });
      return pm.saveProject(p.id, { lead_id: f.lead.value || null, division_id: f.division.value || null, subsystem_id: f.subsystem.value || null, visibility: f.visibility.value });
    },
  });
}
