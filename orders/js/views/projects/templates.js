/**
 * Projects → Templates: a whole project configuration (roles, workflows, work types, fields, form layouts,
 * shared boards, rules, settings and, if wanted, starter items) kept as one checked document. Make a project
 * from one, save a project's set-up as one, bring one into a project that's already running (after a preview
 * of exactly what would change; it only ever adds or updates), and export / import them as files.
 */
import { esc, fmtDate, takeFlash, setFlash } from '../../ui.js';
import { auth } from '../../auth.js';
import { pm } from '../../projects/api.js';
import { needsDatabase, loadBase, invalidate, can, header, formDialog, attempt, toast, personName, projectHref } from './kit.js';
import { createProjectDialog } from './projects.js';

export const PARTS = [['roles', 'Project roles'], ['workflows', 'Workflows (statuses and moves)'], ['types', 'Work-item types'], ['fields', 'Custom fields'], ['layouts', 'Form layouts'],
  ['views', 'Shared boards and views'], ['automations', 'Automation rules'], ['settings', 'Working days and other settings']];

export async function renderTemplates(el, { config, rerender }) {
  const missing = needsDatabase(config);
  if (missing) return void (el.innerHTML = missing);
  const [b, templates] = await Promise.all([loadBase(), pm.templates()]);
  const mine = (t) => t.created_by === b.me || auth.can('projects.manage');
  const configurable = b.projects.filter((p) => !p.archived_at && can(b, p.id, 'configure'));

  el.innerHTML = `${takeFlash()}${header('Templates', 'Reusable project set-ups. A new project starts from one; a running project can take parts of one.',
    `<label class="btn">Import a file<input type="file" id="tpl-import" accept=".json,application/json" hidden></label>
     ${configurable.length ? '<button type="button" class="btn btn-primary" id="tpl-new">Save a project as a template</button>' : ''}`)}
    <div class="pm-project-grid">${templates.map((t) => `<section class="card pm-template" data-template="${esc(t.id)}">
      <h3>${esc(t.name)}</h3><p>${esc(t.description || 'No description.')}</p>
      <p class="muted small">Version ${t.version}${t.created_by ? ` · by ${esc(personName(b, t.created_by))}` : ' · built in'} · changed ${esc(fmtDate(t.updated_at))}</p>
      <div class="card-actions"><button type="button" class="btn btn-sm btn-primary" data-use>New project</button>
        ${configurable.length ? '<button type="button" class="btn btn-sm" data-apply>Apply to a project…</button>' : ''}
        <button type="button" class="btn btn-sm" data-export>Export</button>
        ${mine(t) ? '<button type="button" class="btn btn-sm btn-ghost" data-edit>Edit</button>' : ''}</div></section>`).join('')}</div>
    <p class="hint">A template is a checked document, not code: importing one can't run anything, and a broken one is refused before it's saved.</p>`;

  const byId = (node) => templates.find((t) => t.id === node.closest('[data-template]').dataset.template);
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'tpl-new') {
      const saved = await formDialog({ title: 'Save a project as a template', submit: 'Save template',
        body: `<div class="field"><label for="tn-project">Project</label><select id="tn-project" name="project">${configurable.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></div>
          <div class="field"><label for="tn-name">Template name</label><input id="tn-name" name="name" type="text" maxlength="80" required></div>
          <div class="field"><label for="tn-desc">What it's for</label><textarea id="tn-desc" name="description" rows="2"></textarea></div>
          <label class="pm-check"><input type="checkbox" name="items"> Include its items as starter items (their dates are kept as days from the project's start)</label>`,
        onSubmit: (f) => pm.saveTemplate(null, { name: f.elements.name.value.trim(), description: f.elements.description.value, from_project: f.elements.project.value, include_items: f.elements.items.checked }) });
      if (saved) (toast('Template saved.'), rerender());
      return;
    }
    if (!t.closest('[data-template]')) return;
    const tpl = byId(t);
    if (t.dataset.use !== undefined) {
      const p = await createProjectDialog(b, tpl.id);
      if (p) {
        invalidate();
        setFlash(`${p.name} is ready, set up from "${tpl.name}".`);
        location.hash = projectHref(p.key);
      }
    } else if (t.dataset.export !== undefined) {
      const full = await attempt(() => pm.template(tpl.id));
      if (full) download(`${tpl.name.replace(/[^\w-]+/g, '-').toLowerCase()}.onesolar-project.json`, { onesolar: 'project-template', name: full.name, description: full.description, config: full.config });
    } else if (t.dataset.apply !== undefined) {
      const done = await applyConfigDialog(b, configurable, { template_id: tpl.id }, `the template "${tpl.name}"`);
      if (done) invalidate();
    } else if (t.dataset.edit !== undefined) {
      const saved = await formDialog({ title: 'Edit template', submit: 'Save',
        body: `<div class="field"><label for="te-name">Name</label><input id="te-name" name="name" type="text" maxlength="80" required value="${esc(tpl.name)}"></div>
          <div class="field"><label for="te-desc">What it's for</label><textarea id="te-desc" name="description" rows="2">${esc(tpl.description)}</textarea></div>
          ${configurable.length ? `<div class="field"><label for="te-from">Replace its contents with a project's current set-up</label><select id="te-from" name="from"><option value="">Keep as it is</option>${configurable.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>
            <div class="hint">Projects already made from this template don't change. To bring the update into one, use "Apply to a project…".</div></div>` : ''}
          <label class="pm-check"><input type="checkbox" name="archived"> Archive this template (projects made from it are untouched)</label>`,
        onSubmit: (f) => pm.saveTemplate(tpl.id, { name: f.elements.name.value.trim(), description: f.elements.description.value, version: tpl.version,
          ...(f.elements.from?.value ? { from_project: f.elements.from.value } : {}), ...(f.elements.archived.checked ? { archived: true } : {}) }) });
      if (saved) (toast('Saved.'), rerender());
    }
  });
  el.querySelector('#tpl-import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2_000_000) return toast('That file is too big to be a project template.', 'bad');
    let doc;
    try {
      doc = JSON.parse(await file.text());
    } catch {
      return toast('That file isn\'t a one.solar project template (it isn\'t JSON).', 'bad');
    }
    const cfg = doc?.onesolar === 'project-template' ? doc.config : doc;
    const saved = await formDialog({ title: 'Import a template', submit: 'Import',
      body: `<div class="field"><label for="ti-name">Name</label><input id="ti-name" name="name" type="text" maxlength="80" required value="${esc(doc?.name || file.name.replace(/\.[^.]+$/, ''))}"></div>
        <div class="field"><label for="ti-desc">What it's for</label><textarea id="ti-desc" name="description" rows="2">${esc(doc?.description || '')}</textarea></div>
        <p class="hint">The file is checked by trying it on a scratch project that's thrown away. If any part of it is wrong, nothing is imported.</p>`,
      onSubmit: (f) => pm.saveTemplate(null, { name: f.elements.name.value.trim(), description: f.elements.description.value, config: cfg }) });
    e.target.value = '';
    if (saved) (toast('Imported.'), rerender());
  };
}

export function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Bring a configuration into a running project: choose the project and the parts, see exactly what would be
 * added or updated, then apply. source: { template_id } | { from_project } | { config }. Never removes anything.
 */
export function applyConfigDialog(b, projects, source, sourceName) {
  let previewed = '';
  const picked = (f) => [...f.querySelectorAll('[name=part]:checked')].map((n) => n.value);
  return formDialog({
    title: `Apply ${esc(sourceName)}`, submit: 'Preview', wide: true,
    body: `<div class="field" ${projects.length === 1 ? 'hidden' : ''}><label for="ac-project">To the project</label><select id="ac-project" name="project">${projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></div>
      <fieldset class="pm-section"><legend>Bring in</legend><div class="pm-checks" style="flex-direction:column">${PARTS.map(([k, l]) => `<label class="pm-check"><input type="checkbox" name="part" value="${k}" ${['fields', 'types', 'workflows'].includes(k) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div></fieldset>
      <p class="hint">Things are matched by name (roles and fields by key): what the project already has is updated, the rest is added. Nothing is removed, and existing items aren't touched.
        Work types bring their workflow with them; a type that already has items keeps its current workflow.</p>
      <div data-preview aria-live="polite"></div>`,
    onOpen(form) {
      form.addEventListener('change', () => {
        previewed = '';
        form.querySelector('[data-preview]').innerHTML = '';
        form.querySelector('[data-submit]').textContent = 'Preview';
      });
    },
    async onSubmit(form) {
      const parts = picked(form);
      if (!parts.length) throw new Error('Pick at least one part.');
      const key = `${form.elements.project.value}|${parts.join(',')}`;
      if (previewed !== key) {
        const res = await pm.applyConfig(form.elements.project.value, { ...source, parts, dry_run: true });
        const words = { add: 'Add', update: 'Update', same: 'No change' };
        form.querySelector('[data-preview]').innerHTML = `<h3>What would change</h3>${res.changes.length ? `<div class="table-wrap"><table class="pm-table"><tbody>${res.changes
          .map((c) => `<tr><td>${esc(words[c.action] || c.action)}</td><td>${esc(c.part)}</td><td>${esc(c.name)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing.</p>'}`;
        previewed = key;
        form.querySelector('[data-submit]').textContent = 'Apply these changes';
        throw Object.assign(new Error('preview'), { stay: true });
      }
      const res = await pm.applyConfig(form.elements.project.value, { ...source, parts });
      toast(`Applied: ${res.changes.filter((c) => c.action !== 'same').length} change(s).`);
      return res;
    },
  });
}
