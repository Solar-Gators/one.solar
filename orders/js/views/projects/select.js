/**
 * Projects: one way to pick several items, everywhere (List, Board, Backlog, Timeline, My work). Tick the box on
 * a row or card (Shift picks everything between; X ticks the one under the mouse; Escape clears), and the same bar
 * appears at the bottom: status, owner, due date, priority, more, archive. Changes go through the same rules as
 * one at a time; anything that can't change is listed, not skipped silently. A change to 5 or more items shows
 * what will change first (each item, now and after), and only happens after "Change them".
 */
import { esc, fmtDate } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { moveTo, moveNeeds, PRIORITIES } from '../../projects/core.js';
import { toast, friendly, formDialog, personName } from './kit.js';

const REVIEW_AT = 5;
/**
 * Before a change to many items: what changes, item by item. rows: [{ i, now, after, skip }] (skip: why that one
 * won't change). Resolves true to go ahead. Fewer than REVIEW_AT items go ahead without asking.
 */
export function reviewBulk(change, rows) {
  if (rows.length < REVIEW_AT) return Promise.resolve(true);
  const go = rows.filter((r) => !r.skip);
  if (!go.length) return toast(`None of them can change: ${rows[0].skip}.`, 'bad'), Promise.resolve(false);
  return formDialog({ title: `Change ${go.length} item${go.length === 1 ? '' : 's'}?`, submit: `Change ${go.length}`, wide: true,
    body: `<p><strong>${esc(change)}</strong></p>
      <div class="pm-review"><table class="pm-table"><thead><tr><th>Item</th><th>Now</th><th>After</th></tr></thead><tbody>${rows.map((r) => `<tr class="${r.skip ? 'is-skip' : ''}">
        <td><span class="pm-key">${esc(r.i.key)}</span> ${esc(r.i.title)}</td><td>${esc(r.now ?? '')}</td><td>${r.skip ? `<span class="muted">Won't change: ${esc(r.skip)}</span>` : `<strong>${esc(r.after ?? '')}</strong>`}</td></tr>`).join('')}</tbody></table></div>
      <p class="hint">Nothing has changed yet. Each item is changed with the same rules as one at a time, and Undo isn't available for a change to many items.</p>`,
    onSubmit: () => true }).then((ok) => ok === true);
}
import { pickPerson, pickDate, pickPriority, openPicker } from './pick.js';

/** A tick box for an item (rows and cards). */
export const pickBox = (i) => `<input type="checkbox" class="pm-pickbox" data-select="${esc(i.id)}" aria-label="Select ${esc(i.key)}">`;

/**
 * Make the tick boxes in `root` work and show the bar while anything is ticked. items(): the items on the page;
 * cfgOf(item): its project's configuration; done(): after a change (redraw).
 */
// What's ticked on this page survives the page redrawing itself (after a save, an Undo, a refresh behind it).
// One set per page, shared by every redraw of it; `kept.sync` redraws the live page's boxes and bar.
let kept = { page: '', ids: new Set(), sync: null };

export function bindSelection(root, { b, items, cfgOf, done, sprints = [] }) {
  const here = location.hash;
  const onPage = new Set(items().map((i) => i.id));
  if (kept.page !== here) kept = { page: here, ids: new Set(), sync: null };
  const picked = kept.ids;
  [...picked].forEach((id) => !onPage.has(id) && picked.delete(id));
  let last = null;
  const bar = document.createElement('div');
  bar.className = 'pm-bulkbar';
  bar.hidden = true;
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Change the selected items');
  bar.innerHTML = `<strong data-count></strong>
    <button type="button" class="btn btn-sm" data-b="status">Status</button>
    <button type="button" class="btn btn-sm" data-b="owner">Owner</button>
    <button type="button" class="btn btn-sm" data-b="due">Due date</button>
    <button type="button" class="btn btn-sm" data-b="priority">Priority</button>
    <button type="button" class="btn btn-sm" data-b="more">More…</button>
    <button type="button" class="btn btn-sm btn-ghost" data-b="archive">Archive</button>
    <button type="button" class="pm-bulkbar-x" data-b="clear" aria-label="Clear the selection" title="Clear (Esc)">×</button>`;
  document.querySelector('.pm-bulkbar')?.remove();
  document.body.append(bar);
  // the bar belongs to this page: gone when the page is replaced
  const gone = new MutationObserver(() => {
    if (root.isConnected) return;
    bar.remove();
    gone.disconnect();
    document.removeEventListener('keydown', keys);
    if (location.hash !== here && kept.page === here) kept = { page: '', ids: new Set(), sync: null };   // left the page: nothing stays ticked
  });
  gone.observe(document.getElementById('app') || document.body, { childList: true });

  const boxes = () => [...root.querySelectorAll('[data-select]')];
  const sync = () => {
    boxes().forEach((n) => {
      n.checked = picked.has(n.dataset.select);
      n.closest('[data-item], [data-card], .pm-g-label')?.classList.toggle('is-picked', n.checked);
    });
    const all = root.querySelector('[data-select-all]');
    if (all) all.checked = boxes().length > 0 && boxes().every((n) => n.checked);
    root.classList.toggle('has-picked', picked.size > 0);
    bar.hidden = !picked.size;
    bar.querySelector('[data-count]').textContent = `${picked.size} selected`;
  };
  kept.sync = sync;
  const clear = () => (picked.clear(), sync(), kept.sync !== sync && kept.sync?.());   // a newer redraw of this page shows it too
  root.addEventListener('click', (e) => {
    const box = e.target.closest('[data-select]');
    if (!box) return;
    const ids = boxes().map((n) => n.dataset.select);
    if (e.shiftKey && last && ids.includes(last)) {
      const [a, z] = [ids.indexOf(last), ids.indexOf(box.dataset.select)].sort((x, y) => x - y);
      ids.slice(a, z + 1).forEach((id) => (box.checked ? picked.add(id) : picked.delete(id)));
    } else box.checked ? picked.add(box.dataset.select) : picked.delete(box.dataset.select);
    last = box.dataset.select;
    sync();
  });
  root.addEventListener('change', (e) => {
    if (!e.target.matches('[data-select-all]')) return;
    boxes().forEach((n) => (e.target.checked ? picked.add(n.dataset.select) : picked.delete(n.dataset.select)));
    sync();
  });
  const keys = (e) => {
    if (e.key === 'Escape' && picked.size && !document.querySelector('dialog[open], .pm-pick')) clear();
  };
  document.addEventListener('keydown', keys);
  if (picked.size) sync();

  const chosen = () => items().filter((i) => picked.has(i.id));
  const report = (n, failed) => {
    toast(`Changed ${n} item${n === 1 ? '' : 's'}.${failed.length ? ` ${failed.length} couldn't be changed: ${failed.slice(0, 3).map((f) => `${f.key || 'an item'} (${f.error})`).join('; ')}${failed.length > 3 ? '…' : ''}` : ''}`, failed.length ? 'bad' : 'ok');
    clear();
    done();
  };
  const prio = (k) => PRIORITIES.find(([x]) => x === k)?.[1] || k || '';
  const bulk = async (patch) => {
    const list = chosen();
    const [change, now, after] = patch.owner_id !== undefined ? ['Owner', (i) => personName(b, i.owner_id) || 'No owner', () => personName(b, patch.owner_id) || 'No owner']
      : patch.archived ? ['Archive them (and what\'s under them)', () => 'Open', () => 'Archived']
        : patch.priority ? ['Priority', (i) => prio(i.priority), () => prio(patch.priority)]
          : patch.due_date && Object.keys(patch).length === 1 ? ['Due date', (i) => (i.due_date ? fmtDate(i.due_date) : 'No date'), () => fmtDate(patch.due_date)]
            : ['Several fields', () => '', () => [patch.start_date && `start ${fmtDate(patch.start_date)}`, patch.due_date && `due ${fmtDate(patch.due_date)}`,
              patch.add_labels && `+ ${patch.add_labels.join(', ')}`, patch.sprint_id !== undefined && (patch.sprint_id ? 'new sprint' : 'backlog')].filter(Boolean).join(', ')];
    if (!(await reviewBulk(change, list.map((i) => ({ i, now: now(i), after: after(i) }))))) return;
    try {
      const res = await pm.bulkUpdate([...picked], patch);
      report(res.changed, res.failed);
    } catch (err) {
      toast(friendly(err), 'bad');
    }
  };

  bar.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-b]');
    if (!t) return;
    const list = chosen();
    const what = t.dataset.b;
    if (what === 'clear') return clear();
    if (what === 'owner') {
      const v = await pickPerson(t, b, null, { blank: 'No owner' });
      if (v !== undefined) bulk({ owner_id: v || null });
    } else if (what === 'due') {
      const v = await pickDate(t, null, { label: 'Due date', blank: '' });
      if (v) bulk({ due_date: v });
    } else if (what === 'priority') {
      const v = await pickPriority(t, null);
      if (v) bulk({ priority: v });
    } else if (what === 'archive') {
      if (confirm(`Archive ${list.length} item${list.length === 1 ? '' : 's'} and everything under them? They can be restored.`)) bulk({ archived: true });
    } else if (what === 'status') {
      // statuses by name, across the projects the items are in
      const names = new Map();
      for (const i of list) {
        const c = cfgOf(i);
        for (const s of c?.statuses || []) if (s.id !== i.status_id) names.set(s.name.toLowerCase(), s);
      }
      const v = await openPicker(t, { label: 'Status', search: names.size > 7, width: 240,
        options: [...names.values()].map((s) => ({ value: s.name.toLowerCase(), label: s.name, html: `<span class="chip-tone tone-${esc(s.color)} pm-status">${esc(s.name)}</span>` })) });
      if (!v) return;
      // work out every move first, so the review shows which can't happen
      const plan = list.map((i) => {
        const c = cfgOf(i);
        const target = c?.statuses.find((s) => s.name.toLowerCase() === v && s.workflow_id === c.typeById.get(i.type_id)?.workflow_id);
        const tr = target && moveTo(c, i, target.id, c.who);
        const need = tr && moveNeeds(c, i, tr);
        return { i, tr, now: c?.statusById.get(i.status_id)?.name || '', after: target?.name || names.get(v)?.name,
          skip: !tr ? (target && target.id === i.status_id ? 'already there' : 'no such move') : need.comment || need.keys.length ? 'needs details: open it' : '' };
      });
      if (!(await reviewBulk(`Status → ${names.get(v)?.name || v}`, plan))) return;
      let n = 0;
      const failed = [];
      t.disabled = true;
      for (const { i, tr, skip } of plan) {
        if (skip) {
          failed.push({ key: i.key, error: skip });
          continue;
        }
        try {
          await pm.transition(i.id, tr.id, { version: i.version });
          n += 1;
        } catch (err) {
          failed.push({ key: i.key, error: err.needs ? 'needs details: open it' : friendly(err, i) });
        }
      }
      t.disabled = false;
      report(n, failed);
    } else if (what === 'more') {
      const open = sprints.filter((s) => s.status !== 'closed');
      const p = await formDialog({ title: `Change ${list.length} items`, submit: 'Change them',
        body: `<p class="muted">Only what you fill in is changed.</p><div class="form-grid">
          <div class="field"><label for="bk-start">Start date</label><input id="bk-start" name="start_date" type="date"></div>
          <div class="field"><label for="bk-due">Due date</label><input id="bk-due" name="due_date" type="date"></div>
          <div class="field span-2"><label for="bk-labels">Add labels</label><input id="bk-labels" name="labels" type="text" placeholder="Separate with commas"></div>
          ${open.length ? `<div class="field span-2"><label for="bk-sprint">Sprint</label><select id="bk-sprint" name="sprint"><option value="">Leave as is</option><option value="none">Backlog (no sprint)</option>${open.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></div>` : ''}
        </div>`,
        onSubmit: (f) => ({ ...(f.elements.start_date.value ? { start_date: f.elements.start_date.value } : {}), ...(f.elements.due_date.value ? { due_date: f.elements.due_date.value } : {}),
          ...(f.elements.labels.value.trim() ? { add_labels: f.elements.labels.value.split(',').map((x) => x.trim()).filter(Boolean) } : {}),
          ...(f.elements.sprint?.value ? { sprint_id: f.elements.sprint.value === 'none' ? null : f.elements.sprint.value } : {}) }) });
      if (p && typeof p === 'object' && Object.keys(p).length) bulk(p);
    }
  });
  return { picked, clear, toggle: (id) => (picked.has(id) ? picked.delete(id) : picked.add(id), (last = id), sync()) };
}
