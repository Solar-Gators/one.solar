/**
 * Projects: change a field right where it shows (a list cell, a card, the item page, the timeline's panel).
 * Click it (or press its letter: S status, A owner, D due date, P priority, E estimate), pick, and it's saved:
 * the page shows the new value at once, the save happens behind it, and a notice offers Undo. If the save is
 * refused, the old value comes back and the notice says why. The buttons come from kit.js → ie().
 */
import { pm } from '../../projects/api.js';
import { movesFor } from '../../projects/core.js';
import { ieInner, can, runMove, toast, friendly, personName } from './kit.js';
import { pickPerson, pickDate, pickPriority, pickKind, pickMove, pickNumber } from './pick.js';

const NAMES = { owner_id: 'owner', due_date: 'due date', start_date: 'start date', priority: 'priority', type_id: 'kind', estimate_hours: 'estimate', progress: 'progress' };
const COLUMN = { owner: 'owner_id', due: 'due_date', start: 'start_date', priority: 'priority', type: 'type_id', estimate: 'estimate_hours', progress: 'progress' };
const bound = new WeakSet();

/**
 * Make [data-ie] buttons inside `root` work. itemOf(id) gives the item object (kept up to date here); cfgOf(item)
 * its project's configuration. after(item, field) runs once a change is saved (e.g. to re-sort quietly).
 */
export function bindInline(root, { b, itemOf, cfgOf, after = null }) {
  if (bound.has(root)) return;
  bound.add(root);
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ie]');
    if (!btn || !root.contains(btn) || btn.classList.contains('is-saving')) return;
    e.preventDefault();
    e.stopPropagation();
    const item = itemOf(btn.dataset.ieId);
    if (item) editField(btn, { b, item, cfg: cfgOf(item), root, after });
  });
}

/** Redraw every inline value of an item inside root (after it changed). */
export function redrawItem(root, b, cfg, item) {
  root.querySelectorAll(`[data-ie-id="${CSS.escape(item.id)}"]`).forEach((n) => (n.innerHTML = ieInner(b, cfg, item, n.dataset.ie, n.dataset.ieLook)));
}

/** Open the picker for one field and save what's picked. */
export async function editField(btn, { b, item, cfg, root = document, after = null }) {
  const field = btn.dataset.ie;
  if (field === 'status') return changeStatus(btn, { b, item, cfg, root, after });
  const col = COLUMN[field];
  let v;
  if (field === 'owner') v = await pickPerson(btn, b, item.owner_id, { onlyMe: !can(b, item.project_id, 'assign') });
  else if (field === 'due' || field === 'start') v = await pickDate(btn, item[col], { label: field === 'due' ? 'Due date' : 'Start date', blank: field === 'due' ? 'No due date' : 'No start date' });
  else if (field === 'priority') v = await pickPriority(btn, item.priority);
  else if (field === 'type') v = await pickKind(btn, cfg, item.type_id);
  else if (field === 'estimate') v = await pickNumber(btn, item.estimate_hours, { label: 'Estimate (hours)', choices: [1, 2, 4, 8, 16, 40], unit: ' h' });
  else if (field === 'progress') v = await pickNumber(btn, item.progress, { label: 'Progress (%)', choices: [0, 25, 50, 75, 100], unit: '%', max: 100, step: 5, blank: '' });
  if (v === undefined) return;
  const value = v === '' ? (field === 'progress' ? 0 : null) : v;
  if (String(value ?? '') === String(item[col] ?? '')) return;
  return saveField({ b, item, cfg, root, after }, { [col]: value });
}

/**
 * Save a change to an item now: show it straight away, then save; Undo puts it back. Returns the saved item, or
 * null if it was refused (and the old value is back on the page).
 */
export async function saveField({ b, item, cfg, root = document, after = null, undo = true }, patch) {
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, item[k] ?? null]));
  Object.assign(item, patch);
  const nodes = [...root.querySelectorAll(`[data-ie-id="${CSS.escape(item.id)}"]`)];
  nodes.forEach((n) => n.classList.add('is-saving'));
  redrawItem(root, b, cfg, item);
  try {
    const saved = await pm.updateItem(item.id, null, patch);
    Object.assign(item, saved || {});
    redrawItem(root, b, cfg, item);
    if (undo) {
      const what = Object.keys(patch).map((k) => NAMES[k] || k).join(', ');
      const shown = patch.owner_id !== undefined ? (patch.owner_id ? personName(b, patch.owner_id) : 'nobody') : '';
      toast(`${item.key}: ${what} changed${shown ? ` to ${shown}` : ''}.`, 'ok', { undo: async () => {
        const back = await saveField({ b, item, cfg, root, after, undo: false }, before);
        if (back) toast(`${item.key}: put back.`);
      } });
    }
    after?.(item, Object.keys(patch));
    return item;
  } catch (err) {
    Object.assign(item, before);
    redrawItem(root, b, cfg, item);
    toast(friendly(err, item), 'bad');
    return null;
  } finally {
    nodes.forEach((n) => n.classList.remove('is-saving'));
  }
}

/** Status is a workflow move: pick where it goes; a move that needs more (fields, a comment, approval) asks first. */
async function changeStatus(btn, { b, item, cfg, root, after }) {
  const moves = movesFor(cfg, item, cfg.who);
  if (!moves.length) return toast(`${item.key} can't move from "${cfg.statusById.get(item.status_id)?.name || 'here'}" with your role.`, 'bad');
  const id = await pickMove(btn, cfg, moves);
  if (!id) return;
  const tr = moves.find((t) => t.id === id);
  const before = { status_id: item.status_id, category: item.category };
  const to = cfg.statusById.get(tr.to_status);
  Object.assign(item, { status_id: to.id, category: to.category });
  redrawItem(root, b, cfg, item);
  btn.classList.add('is-saving');
  const res = await runMove(b, cfg, { ...item, ...before }, tr);
  btn.classList.remove('is-saving');
  if (!res || res.pending) Object.assign(item, before);
  else if (res.id) Object.assign(item, res);
  redrawItem(root, b, cfg, item);
  if (res && !res.pending) after?.(item, ['status_id']);
}
