/**
 * Projects: saved views (lists, boards, timelines, calendars, dashboards). One picker on every page that has
 * them: yours alone, shared with a project, shared with the whole team, or shared with people you pick.
 * Whatever a shared view's filter says, each person still only gets items of projects they can see.
 */
import { auth } from '../../auth.js';
import { esc } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { can, canCreateProjects, formDialog, attempt, toast, peopleField } from './kit.js';

let cache = null;
export const loadViews = async ({ fresh = false } = {}) => (cache && !fresh ? cache : (cache = pm.views().catch((e) => ((cache = null), Promise.reject(e)))));
/** The views of one kind for one place (a project, or null for the cross-project pages). */
export const viewsFor = (all, kind, projectId) => all.filter((v) => v.kind === kind && (v.project_id || null) === (projectId || null));
/** Which view a page opens on: the one asked for, else my own default, else the shared default. */
export const pickView = (views, wanted, me) =>
  views.find((v) => v.id === wanted) || (wanted === 'none' ? null : views.find((v) => v.is_default && v.owner_id === me) || views.find((v) => v.is_default && v.sharing !== 'private') || null);

const SHARING = { private: 'Just me', project: 'Everyone in this project', team: 'The whole team', people: 'People I pick', ready: 'Ready-made' };
const mayChange = (b, v) => !v.ready && (v.owner_id === b.me || (v.sharing === 'project' && can(b, v.project_id, 'boards')) || auth.can('projects.manage'));

/**
 * Ready-made searches for the List (the common ones, like Jira's default filters). Built in: they can't be changed or
 * deleted, but "Save as…" keeps a copy to change. recentKeys: the items opened lately on this device.
 */
export function readySearches(recentKeys = []) {
  const r = (id, name, f, sort = 'updated', dir = 'desc') => ({ id: `ready:${id}`, name, ready: true, sharing: 'ready',
    config: { filter_state: { q: '', owner: '', category: '', priority: '', type: '', more: null, ...f }, sort, dir } });
  return [
    r('mine', 'My open items', { owner: 'me', category: 'open' }, 'due', 'asc'),
    r('reported', 'Reported by me', { more: { f: 'reporter', v: 'me' } }),
    r('open', 'Everything open', { category: 'open' }, 'rank', 'asc'),
    r('done', 'Done', { category: 'done' }),
    r('updated', 'Changed in the last 7 days', { more: { f: 'updated', op: 'last', v: 7 } }),
    r('finished', 'Finished in the last 14 days', { category: 'done', more: { f: 'completed', op: 'last', v: 14 } }),
    r('worked', 'Worked on by me (last 30 days)', { more: { f: 'worked_on' } }),
    r('viewed', 'Recently viewed', { more: { f: 'key', op: 'in', v: recentKeys.length ? recentKeys : ['-'] } }),
  ];
}

export function viewPicker(b, views, current, { noun = 'view', dirty = false } = {}) {
  const ready = views.filter((v) => v.ready);
  const mine = views.filter((v) => !v.ready && v.owner_id === b.me && v.sharing === 'private');
  const shared = views.filter((v) => !v.ready && !(v.owner_id === b.me && v.sharing === 'private'));
  const o = (v) => `<option value="${esc(v.id)}" ${current?.id === v.id ? 'selected' : ''}>${esc(v.name)}${v.is_default ? ' ★' : ''}</option>`;
  const who = current ? `${SHARING[current.sharing]}${current.owner_id && current.owner_id !== b.me ? ` · by ${b.personById.get(current.owner_id)?.full_name || 'someone'}` : ''}` : '';
  const may = current && mayChange(b, current);
  return `<div class="pm-views" data-views>
    <select data-view-pick aria-label="Saved ${esc(noun)}s" title="${esc(who)}"><option value="none">Standard ${esc(noun)}</option>
      ${ready.length ? `<optgroup label="Ready-made">${ready.map(o).join('')}</optgroup>` : ''}
      ${mine.length ? `<optgroup label="Mine">${mine.map(o).join('')}</optgroup>` : ''}${shared.length ? `<optgroup label="Shared">${shared.map(o).join('')}</optgroup>` : ''}</select>
    ${may && dirty ? `<button type="button" class="btn btn-sm btn-primary" data-view-save title="Save the changes to &quot;${esc(current.name)}&quot;">Save</button>` : ''}
    <details class="pm-pop pm-dots"><summary class="btn btn-sm" aria-label="Saved ${esc(noun)} options" title="Save or share this ${esc(noun)}">${!current && dirty ? 'Save…' : '▾'}</summary><div class="pm-more-pop">
      ${current ? `<p class="muted small pm-pop-note">${esc(who)}</p>` : ''}
      ${may ? `<button type="button" data-view-save>Save changes to "${esc(current.name)}"</button>` : ''}
      <button type="button" data-view-new>Save as a new ${esc(noun)}…</button>
      ${may ? `<button type="button" data-view-delete>Delete "${esc(current.name)}"</button>` : ''}</div></details>
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
        <div data-share-people hidden>${peopleField('who', 'pm-view-who', b, [], { multi: true, among: b.people.filter((p) => p.id !== b.me).map((p) => p.id) })}</div>
        <p class="hint">People only ever see items of projects they're allowed into, whatever a shared ${esc(noun)} asks for.</p></fieldset>
      <label class="pm-check"><input type="checkbox" name="is_default"> Open this one first</label>`,
    onOpen(form) {
      form.addEventListener('change', () => (form.querySelector('[data-share-people]').hidden = form.elements.sharing.value !== 'people'));
    },
    onSubmit: (form) => pm.saveView(null, {
      project_id: projectId, kind, name: form.elements.name.value.trim(), sharing: form.elements.sharing.value, config,
      shared_with: [...form.querySelectorAll('[name=who]:checked')].map((n) => n.value), is_default: form.elements.is_default.checked,
    }).then((v) => (toast(`Saved "${v.name}".`), v)),
  });
}
