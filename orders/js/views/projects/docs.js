/**
 * Projects → Documents: a project's linked documents (Smart Links). A document is linked by pasting its address
 * from Teams / SharePoint / OneDrive (or GitHub, a CAD system, another one.solar app). The file stays where it
 * is and that system keeps deciding who can open it: one.solar stores the address, a title and a category, and
 * opens the original when clicked. It never downloads, previews or checks the file.
 */
import { esc, fmtDate } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { DOC_CATEGORIES } from '../../projects/core.js';
import { recognise, resourceIcon, fileTypeLabel, guessCategory, PROVIDERS } from '../../projects/links.js';
import { can, formDialog, itemHref, personName } from './kit.js';

export const docCategories = (project) => (project?.settings?.doc_categories?.length ? project.settings.doc_categories : DOC_CATEGORIES);

/** One linked document as a row: icon, title (opens the original in a new tab), where it lives. */
export const docLink = (r) => `<a class="pm-doc" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer" title="Opens in ${esc(PROVIDERS[r.provider] || 'a new tab')}">
  <span class="pm-doc-icon" aria-hidden="true">${resourceIcon(r)}</span><span>${esc(r.title)}</span></a>
  <span class="muted small">${esc([PROVIDERS[r.provider] || 'Link', r.kind === 'folder' ? 'folder' : fileTypeLabel(r.file_type), r.category].filter(Boolean).join(' · '))}</span>`;

/**
 * "Link a document": paste the address; the title, kind and category are filled in from it and can be changed.
 * target: { projectId, itemId?, subsystemId? }. Resolves with the saved document or null.
 */
export function addDocDialog(b, project, target, { siteUrl = '' } = {}) {
  let last = null;
  return formDialog({
    title: 'Link a document', submit: 'Link it',
    body: `<div class="field"><label for="doc-url">Link</label><input id="doc-url" name="url" type="url" required placeholder="https://…" autocomplete="off">
        <div class="hint">In Teams or SharePoint: open the file or folder → <strong>Copy link</strong> → paste it here. The file stays where it is.</div></div>
      <div class="pm-doc-read" data-read aria-live="polite"></div>
      <div class="field"><label for="doc-title">Title</label><input id="doc-title" name="title" type="text" maxlength="200" required></div>
      <div class="field"><label for="doc-cat">Category</label><select id="doc-cat" name="category"><option value="">None</option>${docCategories(project).map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
      ${target.itemId ? '' : `<div class="field"><label for="doc-sub">For a subsystem (optional)</label><select id="doc-sub" name="subsystem"><option value="">The whole project</option>${b.subsystems.filter((s) => !s.archived_at).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>
        <div class="hint">Handy for a subsystem's folder in Teams.</div></div>`}
      <p class="hint">one.solar only keeps the link. Who can open the file is still decided in Teams / SharePoint, so link it with "People with existing access" rather than "Anyone with the link".</p>`,
    onOpen(form) {
      let typedTitle = false;
      form.elements.title.oninput = () => (typedTitle = true);
      form.elements.url.oninput = () => {
        last = recognise(form.elements.url.value, { siteUrl });
        const box = form.querySelector('[data-read]');
        if (!form.elements.url.value.trim()) return void (box.innerHTML = '');
        if (!last.ok) return void (box.innerHTML = `<div class="alert alert-error">${esc(last.error)}</div>`);
        box.innerHTML = `<p>${resourceIcon(last)} <strong>${esc(PROVIDERS[last.provider])}</strong> ${esc(last.kind === 'folder' ? 'folder' : fileTypeLabel(last.file_type) || last.kind)}</p>
          ${last.note ? `<div class="alert alert-info">${esc(last.note)}</div>` : ''}`;
        if (!typedTitle) form.elements.title.value = last.title;
        if (!form.elements.category.value) form.elements.category.value = guessCategory(last);
      };
    },
    onSubmit(form) {
      const r = last?.ok ? last : recognise(form.elements.url.value, { siteUrl });
      if (!r.ok) throw new Error(r.error);
      return pm.addResource({ project_id: target.projectId, item_id: target.itemId || null, subsystem_id: form.elements.subsystem?.value || null, url: r.url,
        title: form.elements.title.value.trim(), category: form.elements.category.value, provider: r.provider, kind: r.kind, file_type: r.file_type });
    },
  });
}

const view = { q: '', category: '', where: '' };

export async function renderDocs(el, scope) {
  const { b, project } = scope;
  const [resources, links] = await Promise.all([pm.resources(project.id), pm.resourceLinks(project.id)]);
  const items = await pm.itemsByIds([...new Set(links.map((l) => l.item_id).filter(Boolean))]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const linksOf = (r) => links.filter((l) => l.resource_id === r.id);
  const q = view.q.trim().toLowerCase();
  const shown = resources.filter((r) => (!q || `${r.title} ${r.url} ${r.category}`.toLowerCase().includes(q)) && (!view.category || r.category === view.category)
    && (!view.where || (view.where === 'project' ? linksOf(r).some((l) => !l.item_id) : view.where === 'items' ? linksOf(r).some((l) => l.item_id) : linksOf(r).some((l) => l.subsystem_id === view.where))));
  const canAdd = (can(b, project.id, 'create') || can(b, project.id, 'edit')) && !project.archived_at;
  const cats = [...new Set([...docCategories(project), ...resources.map((r) => r.category).filter(Boolean)])];
  const subs = [...new Set(links.map((l) => l.subsystem_id).filter(Boolean))];

  el.innerHTML = `<div class="pm-toolbar"><div class="pm-filters">
      <input type="search" data-q placeholder="Find a document" aria-label="Find a document" value="${esc(view.q)}">
      <select data-cat aria-label="Category"><option value="">Any category</option>${cats.map((c) => `<option ${view.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select data-where aria-label="Linked to"><option value="">Linked anywhere</option><option value="project" ${view.where === 'project' ? 'selected' : ''}>The project itself</option>
        <option value="items" ${view.where === 'items' ? 'selected' : ''}>Items</option>${subs.map((s) => `<option value="${esc(s)}" ${view.where === s ? 'selected' : ''}>${esc(b.subsystemById.get(s)?.name || 'Subsystem')}</option>`).join('')}</select></div>
      ${canAdd ? '<div class="card-actions"><button type="button" class="btn btn-primary" data-add-doc>Link a document</button></div>' : ''}</div>
    ${shown.length ? `<div class="table-wrap"><table class="pm-table"><thead><tr><th>Document</th><th>Category</th><th>Linked to</th><th>Added</th><th></th></tr></thead><tbody>${shown.map((r) => `<tr>
        <td data-label="Document">${docLink(r)}</td><td data-label="Category">${esc(r.category || '—')}</td>
        <td data-label="Linked to">${linksOf(r).map((l) => (l.item_id ? (itemById.get(l.item_id) ? `<a href="${itemHref(itemById.get(l.item_id).key)}">${esc(itemById.get(l.item_id).key)}</a>` : '')
          : esc(l.subsystem_id ? b.subsystemById.get(l.subsystem_id)?.name || 'A subsystem' : 'The project'))).filter(Boolean).join(', ')}</td>
        <td data-label="Added">${esc(fmtDate(r.created_at))}<div class="muted small">${esc(personName(b, r.created_by))}</div></td>
        <td>${canAdd ? `<button type="button" class="btn btn-sm btn-ghost" data-edit-doc="${esc(r.id)}">Edit</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty"><p><strong>${resources.length ? 'No document matches.' : 'No documents linked yet.'}</strong></p>
        ${resources.length ? '' : '<p>Link the project\'s folder in Teams, its CAD, drawings, analyses and test reports here, so nobody has to ask where things are.</p>'}</div>`}
    <p class="hint">Links open the original file in Microsoft 365 (or wherever it lives). one.solar doesn't copy files and can't tell whether a link still works or who may open it.</p>`;

  el.querySelector('[data-q]').oninput = (e) => {
    view.q = e.target.value;
    clearTimeout(view.t);
    view.t = setTimeout(scope.rerender, 250);
  };
  el.querySelector('[data-cat]').onchange = (e) => ((view.category = e.target.value), scope.rerender());
  el.querySelector('[data-where]').onchange = (e) => ((view.where = e.target.value), scope.rerender());
  el.querySelector('[data-add-doc]')?.addEventListener('click', async () => (await addDocDialog(b, project, { projectId: project.id })) && scope.rerender());
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-edit-doc]');
    if (!t) return;
    const r = resources.find((x) => x.id === t.dataset.editDoc);
    const res = await formDialog({ title: 'Edit document', submit: 'Save',
      body: `<div class="field"><label for="ed-title">Title</label><input id="ed-title" name="title" type="text" maxlength="200" required value="${esc(r.title)}"></div>
        <div class="field"><label for="ed-cat">Category</label><select id="ed-cat" name="category"><option value="">None</option>${cats.map((c) => `<option ${r.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
        <p class="muted small" style="overflow-wrap:anywhere">${esc(r.url)}</p>
        <label class="pm-check"><input type="checkbox" name="remove"> Remove it from this project (and from every item it's linked to). The file itself isn't touched.</label>`,
      onSubmit: (f) => (f.elements.remove.checked ? pm.saveResource(r.id, null) : pm.saveResource(r.id, { title: f.elements.title.value.trim(), category: f.elements.category.value })) });
    if (res) scope.rerender();
  });
}
