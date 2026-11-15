/**
 * Projects: saved views (lists, boards, timelines, calendars, dashboards). One picker on every page that has
 * them: yours alone, shared with a project, shared with the whole team, or shared with people you pick.
 * Whatever a shared view's filter says, each person still only gets items of projects they can see.
 */
import { auth } from '../../auth.js';
import { esc } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { can, canCreateProjects, formDialog, attempt, toast } from './kit.js';

let cache = null;
export const loadViews = async ({ fresh = false } = {}) => (cache && !fresh ? cache : (cache = pm.views().catch((e) => ((cache = null), Promise.reject(e)))));
/** The views of one kind for one place (a project, or null for the cross-project pages). */
export const viewsFor = (all, kind, projectId) => all.filter((v) => v.kind === kind && (v.project_id || null) === (projectId || null));
/** Which view a page opens on: the one asked for, else my own default, else the shared default. */
export const pickView = (views, wanted, me) =>
  views.find((v) => v.id === wanted) || (wanted === 'none' ? null : views.find((v) => v.is_default && v.owner_id === me) || views.find((v) => v.is_default && v.sharing !== 'private') || null);

const SHARING = { private: 'Just me', project: 'Everyone in this project', team: 'The whole team', people: 'People I pick' };
const mayChange = (b, v) => v.owner_id === b.me || (v.sharing === 'project' && can(b, v.project_id, 'boards')) || auth.can('projects.manage');

export function viewPicker(b, views, current, { noun = 'view', dirty = false } = {}) {
  const mine = views.filter((v) => v.owner_id === b.me && v.sharing === 'private');
  const shared = views.filter((v) => !(v.owner_id === b.me && v.sharing === 'private'));
  const o = (v) => `<option value="${esc(v.id)}" ${current?.id === v.id ? 'selected' : ''}>${esc(v.name)}${v.is_default ? ' ★' : ''}</option>`;
  return `<div class="pm-views" data-views>
    <select data-view-pick aria-label="Saved ${esc(noun)}s"><option value="none">Standard ${esc(noun)}</option>
      ${mine.length ? `<optgroup label="Mine">${mine.map(o).join('')}</optgroup>` : ''}${shared.length ? `<optgroup label="Shared">${shared.map(o).join('')}</optgroup>` : ''}</select>
    ${current && mayChange(b, current) ? `<button type="button" class="btn btn-sm${dirty ? ' btn-primary' : ''}" data-view-save title="Save the changes to &quot;${esc(current.name)}&quot;">Save</button>` : ''}
    <button type="button" class="btn btn-sm" data-view-new>Save as…</button>
    ${current && mayChange(b, current) ? `<button type="button" class="btn btn-sm btn-ghost" data-view-delete aria-label="Delete this ${esc(noun)}">Delete</button>` : ''}
    ${current ? `<span class="muted small">${esc(SHARING[current.sharing])}${current.owner_id && current.owner_id !== b.me ? ` · by ${esc(b.personById.get(current.owner_id)?.full_name || 'someone')}` : ''}</span>` : ''}
  </div>`;
}

/**
 * Wire a picker. opts: { b, kind, projectId, views, current, getConfig() → what to save, onPick(view | null) }.
 */
export function bindViewPicker(root, { b, kind, projectId = null, views, current, getConfig, onPick, noun = 'view' }) {
  const box = root.querySelector('[data-views]');
  if (!box) return;
  box.querySelector('[data-view-pick]').onchange = (e) => onPick(views.find((v) => v.id === e.target.value) || null, e.target.value);
  box.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.viewSave !== undefined) {
      const saved = await attempt(() => pm.saveView(current.id, { config: getConfig(), version: current.version }), `Saved "${current.name}".`);
      if (saved) onPick(await refreshed(saved.id), saved.id);
    } else if (t.dataset.viewDelete !== undefined) {
      if (!confirm(`Delete the ${noun} "${current.name}"${current.sharing === 'private' ? '' : ' for everyone it\'s shared with'}?`)) return;
      if (await attempt(() => pm.deleteView(current.id), 'Deleted.')) {
        await loadViews({ fresh: true });
        onPick(null, 'none');
      }
    } else if (t.dataset.viewNew !== undefined) {
      const saved = await saveAsDialog(b, { kind, projectId, config: getConfig(), noun });
      if (saved) onPick(await refreshed(saved.id), saved.id);
    }
  });
}
const refreshed = async (id) => (await loadViews({ fresh: true })).find((v) => v.id === id) || null;

/** Name it and say who sees it. */
export function saveAsDialog(b, { kind, projectId, config, noun = 'view' }) {
  const options = [['private', 'Just me'],
    ...(projectId && can(b, projectId, 'boards') ? [['project', 'Everyone in this project']] : []),
    ...(!projectId && canCreateProjects() ? [['team', 'The whole team']] : []),
    ['people', 'People I pick']];
  return formDialog({
    title: `Save this ${esc(noun)}`, submit: 'Save',
    body: `<div class="field"><label for="pm-view-name">Name</label><input id="pm-view-name" name="name" type="text" maxlength="80" required></div>
      <fieldset class="pm-section"><legend>Who sees it</legend>${options.map(([v, l], i) => `<label class="pm-check"><input type="radio" name="sharing" value="${v}" ${i === 0 ? 'checked' : ''}> ${esc(l)}</label>`).join('')}
        <div class="pm-checks" data-people hidden>${b.people.filter((p) => p.id !== b.me).map((p) => `<label class="pm-check"><input type="checkbox" name="who" value="${esc(p.id)}"> ${esc(p.full_name || p.email)}</label>`).join('')}</div>
        <p class="hint">People only ever see items of projects they're allowed into, whatever a shared ${esc(noun)} asks for.</p></fieldset>
      <label class="pm-check"><input type="checkbox" name="is_default"> Open this one first</label>`,
    onOpen(form) {
      form.addEventListener('change', () => (form.querySelector('[data-people]').hidden = form.elements.sharing.value !== 'people'));
    },
    onSubmit: (form) => pm.saveView(null, {
      project_id: projectId, kind, name: form.elements.name.value.trim(), sharing: form.elements.sharing.value, config,
      shared_with: [...form.querySelectorAll('[name=who]:checked')].map((n) => n.value), is_default: form.elements.is_default.checked,
    }).then((v) => (toast(`Saved "${v.name}".`), v)),
  });
}
