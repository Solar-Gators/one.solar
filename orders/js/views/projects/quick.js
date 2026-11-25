/**
 * Projects: add an item with just its title, from wherever you are. "+ Add…" at the bottom of a list, a board
 * column, a timeline, a sprint or My work: type, Enter, done. Where you typed it decides the rest (that column's
 * status, that sprint, that parent, you as owner, your subsystem); Shift+Enter or "More…" opens the full form with
 * the title already in it. Undo takes it away again (it's archived).
 */
import { esc } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { newId } from '../../projects/core.js';
import { loadConfig, smartDefaults, createItemDialog, toast, friendly, can, itemHref } from './kit.js';

/**
 * The one-line form. ctx: what the new item gets from where it's added ({ project_id, status_id, parent_id,
 * sprint_id, owner_id, type_id… }). Without project_id, a project picker shows (My work).
 */
export function quickAdd(b, ctx = {}, { placeholder = '+ Add an item', label = 'Add an item', cls = '' } = {}) {
  const projects = ctx.project_id ? [] : b.projects.filter((p) => !p.archived_at && can(b, p.id, 'create'));
  if (!ctx.project_id && !projects.length) return '';
  let last = '';
  try {
    last = localStorage.getItem('pm.qa.project') || '';
  } catch { /* no memory */ }
  return `<form class="pm-qa ${cls}" data-qa="${esc(JSON.stringify(ctx))}">
    ${projects.length ? `<select data-qa-project aria-label="Project">${projects.map((p) => `<option value="${esc(p.id)}" ${p.id === last ? 'selected' : ''}>${esc(p.key)}</option>`).join('')}</select>` : ''}
    <input type="text" maxlength="200" placeholder="${esc(placeholder)}" aria-label="${esc(label)}" enterkeyhint="done">
    <button type="button" class="btn btn-sm btn-ghost pm-qa-more" data-qa-more title="The full form (Shift+Enter)">More…</button></form>`;
}

const bound = new WeakSet();
/** Make every quick-add line in `root` work. done(item): after one is added (redraw). */
export function bindQuickAdd(root, { b, done }) {
  if (bound.has(root)) return;
  bound.add(root);
  const add = async (form, full) => {
    const input = form.querySelector('input[type=text]');
    const title = input.value.trim();
    const ctx = JSON.parse(form.dataset.qa || '{}');
    const projectId = ctx.project_id || form.querySelector('[data-qa-project]')?.value;
    if (!projectId) return;
    try {
      localStorage.setItem('pm.qa.project', projectId);
    } catch { /* fine */ }
    const project = b.projectById.get(projectId);
    const cfg = await loadConfig(b, projectId);
    const given = { ...ctx, project_id: undefined, status_ids: undefined, parent_type_id: undefined };
    if (full || !title) {
      const made = await createItemDialog(b, cfg, { ...given, title });
      if (made) (input.value = '', done(made));
      return;
    }
    // under a parent: the first kind allowed there (its settings, or any lower level)
    const parentType = cfg.typeById.get(ctx.parent_type_id);
    const types = cfg.types.filter((t) => !t.archived_at && (!parentType || (t.parent_type_ids?.length ? t.parent_type_ids.includes(parentType.id) : t.level > parentType.level)))
      .sort((x, y) => x.level - y.level || x.sort - y.sort);
    const type = types.find((t) => t.id === ctx.type_id) || (parentType ? types[0] : types.find((t) => t.level === 1)) || types[0];
    if (!type && parentType) return toast(`Nothing can go under a ${parentType.name} in this space (Settings → Work types).`, 'bad');
    if (!type) return toast('This space has no kinds of work yet. Add one in Settings → Work types.', 'bad');
    // a board column's status only if this kind of item's workflow has it
    const status = ctx.status_ids?.find((sid) => cfg.statusById.get(sid)?.workflow_id === type.workflow_id) || (cfg.statusById.get(ctx.status_id)?.workflow_id === type.workflow_id ? ctx.status_id : undefined);
    const p = { ...smartDefaults(b, project, given), project_id: projectId, type_id: type.id, title, ...(status ? { status_id: status } : {}) };
    input.disabled = true;
    form.classList.add('is-saving');
    try {
      const made = await pm.createItem(newId(), p);
      input.value = '';
      toast(`Added ${made.key}: ${made.title}`, 'ok', { undo: async () => {
        try {
          await pm.archiveItem(made.id, true);
          toast(`${made.key} removed (archived).`);
          done(null);
        } catch (err) {
          toast(friendly(err, made), 'bad');
        }
      } });
      done(made);
    } catch (err) {
      // a required field this kind of item needs: the full form, with what was typed
      if (err.needs?.length) {
        const made = await createItemDialog(b, cfg, { ...given, title });
        if (made) (input.value = '', done(made));
      } else toast(friendly(err), 'bad');
    } finally {
      input.disabled = false;
      form.classList.remove('is-saving');
      if (input.isConnected) input.focus();
    }
  };
  root.addEventListener('submit', (e) => {
    const form = e.target.closest('.pm-qa');
    if (!form) return;
    e.preventDefault();
    add(form, false);
  });
  root.addEventListener('keydown', (e) => {
    const form = e.target.closest?.('.pm-qa');
    if (form && e.key === 'Enter' && e.shiftKey) (e.preventDefault(), add(form, true));
    if (form && e.key === 'Escape') ((e.target.value = ''), e.target.blur());
  });
  root.addEventListener('click', (e) => {
    const more = e.target.closest('[data-qa-more]');
    if (more) add(more.closest('.pm-qa'), true);
  });
}

/** For a link in a notice: the item's page. */
export const openHref = (item) => itemHref(item.key);

/**
 * V8a: a "+" on a row that adds an item under it, right there (the parent is set). Shown only when this person can
 * add items to the project and the project's levels allow something under that kind of item.
 */
export function addUnderButton(b, cfg, i) {
  if (!cfg || i.category === 'done' || i.archived_at || !can(b, i.project_id, 'create')) return '';
  const parentType = cfg.typeById.get(i.type_id);
  if (!parentType || !cfg.types.some((t) => !t.archived_at && (t.parent_type_ids?.length ? t.parent_type_ids.includes(parentType.id) : t.level > parentType.level))) return '';
  return `<button type="button" class="pm-add-under" data-add-under="${esc(i.id)}" data-key="${esc(i.key)}" data-project="${esc(i.project_id)}" data-type="${esc(i.type_id)}" title="Add an item under ${esc(i.key)}" aria-label="Add an item under ${esc(i.key)}">+</button>`;
}

const underBound = new WeakSet();
/** V8a: open (or close) the one-line form under a row whose "+" was clicked. Rows are <tr> or <li>. */
export function bindAddUnder(root, { b, done }) {
  bindQuickAdd(root, { b, done });
  if (underBound.has(root)) return;
  underBound.add(root);
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-add-under]');
    if (!btn || !root.contains(btn)) return;
    const row = btn.closest('tr, li');
    const next = row?.nextElementSibling;
    if (next?.matches('.pm-add-under-row')) return void next.remove();
    root.querySelectorAll('.pm-add-under-row').forEach((x) => x.remove());
    const form = quickAdd(b, { project_id: btn.dataset.project, parent_id: btn.dataset.addUnder, parent_type_id: btn.dataset.type },
      { placeholder: `+ Add an item under ${btn.dataset.key} (Enter to add, Esc to close)`, label: `Add an item under ${btn.dataset.key}` });
    const holder = document.createElement(row.tagName === 'TR' ? 'tr' : 'li');
    holder.className = 'pm-add-under-row';
    holder.innerHTML = row.tagName === 'TR' ? `<td colspan="${row.children.length}">${form}</td>` : form;
    row.after(holder);
    const input = holder.querySelector('input[type=text]');
    input.addEventListener('keydown', (k) => k.key === 'Escape' && (holder.remove(), btn.focus()));
    input.focus();
  });
}
