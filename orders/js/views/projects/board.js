/**
 * Projects → Board: a kanban of one project, or of every project I can see. Columns are a saved mapping of
 * statuses (several statuses can share a column; each column can have a work-in-progress limit); swimlanes group
 * the cards. Moving a card (dragging it, or the "Move" menu on the card for phones and keyboards) makes a
 * workflow move through the same rules as anywhere else: a move that needs fields, a comment or an approval
 * opens its dialog, and a move the workflow doesn't have is refused.
 * Cards show their parent (V8b, click it to see only that parent's items), have a menu on right-click or "⋯"
 * (V8c: move, assign, change parent, flag as blocked, copy link, relate, archive), and "Stand-up" walks the board one
 * person at a time (V9).
 */
import { esc, askText } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { boardColumns, moveTo, movesFor, rankBetween, PRIORITIES } from '../../projects/core.js';
import { bindKanbanDnd } from '../../kanbanDnd.js';
import { filterBar, bindFilterBar, filterOf, can, formDialog, toast, runMove, itemHref, typeBadge, personName, ie, mayEditItem, avatar, openMenu, attempt, loadParents, choiceChips, moreMenu, peopleField } from './kit.js';
import { refDialog } from './item.js';
import { loadViews, viewsFor, pickView, viewPicker, bindViewPicker } from './saved.js';
import { bindInline } from './inline.js';
import { bindSelection, pickBox } from './select.js';
import { quickAdd, bindQuickAdd } from './quick.js';

const states = new Map();
const stateOf = (key) => states.get(key) || states.set(key, { f: { q: '', owner: '', category: '', priority: '', type: '', more: null }, view: undefined, config: {}, dirty: false, closed: new Set() }).get(key);
const LANES = [['', 'No swimlanes'], ['owner', 'Owner'], ['subsystem', 'Subsystem'], ['priority', 'Priority'], ['parent', 'Parent (epic)'], ['type', 'Kind'], ['project', 'Project']];
const CARD_EXTRAS = [['estimate_hours', 'Estimate'], ['labels', 'Labels'], ['subsystem', 'Subsystem'], ['progress', 'Progress']];
const SU_SECONDS = 120;   // V9: the stand-up's optional timer
let standupKeys = null;   // V9: Esc / arrows while a stand-up runs (one listener for the page)

export async function renderBoard(el, scope) {
  const { b, project, cfg } = scope;
  const st = stateOf(project?.id || '');
  const views = viewsFor(await loadViews(), 'board', project?.id);
  if (st.view === undefined) applyView(st, pickView(views, null, b.me));
  const current = views.find((v) => v.id === st.view) || null;
  const columns = boardColumns(st.config, scope.statuses);
  const lane = st.config.swimlane || '';

  // Open work, plus what was finished in the last 30 days (so "Done" doesn't grow for ever).
  const recent = { any: [{ f: 'category', op: 'ne', v: 'done' }, { f: 'completed', op: 'last', v: 30 }] };
  const user = filterOf(st.f);
  const { items: found, total } = await pm.searchAll({ project: project?.id, projects: scope.only, filter: { all: [recent, ...(user ? [user] : []), ...(st.config.filter ? [st.config.filter] : [])] }, q: st.f.q, sort: 'rank' }, 2000);
  const byId = new Map(found.map((i) => [i.id, i]));
  const topLevel = (i) => scope.cfgOf(i)?.typeById.get(i.type_id)?.level === 0;
  const items = st.config.show_top ? found : found.filter((i) => !topLevel(i));
  const hiddenTop = found.length - items.length;
  // V8b: each card's parent, also when the parent isn't on this board
  const showParent = !st.config.hide_parent && lane !== 'parent';
  const away = showParent ? [...new Set(items.map((i) => i.parent_id).filter((id) => id && !byId.has(id)))] : [];
  const parentById = new Map([...found, ...(away.length ? await pm.itemsByIds(away).catch(() => []) : [])].map((p) => [p.id, p]));
  // V9: stand-up, one person at a time
  if (st.tick) clearInterval(st.tick);
  const su = st.su;
  const suWho = su ? su.order[su.n] : null;
  const colOf = (i) => columns.findIndex((c) => c.status_ids.includes(i.status_id));

  const laneKey = (i) => (lane === 'owner' ? i.owner_id || '' : lane === 'subsystem' ? i.subsystem_id || i.division_id || '' : lane === 'priority' ? i.priority
    : lane === 'parent' ? i.parent_id || '' : lane === 'type' ? scope.cfgOf(i)?.typeById.get(i.type_id)?.name || '' : lane === 'project' ? i.project_id
    : lane.startsWith('cf.') ? String([].concat(i.custom?.[lane.slice(3)] ?? '')[0] ?? '') : '');
  const laneName = (k) => (lane === 'owner' ? personName(b, k) || 'No owner' : lane === 'subsystem' ? b.subsystemById.get(k)?.name || b.divisionById.get(k)?.name || 'No subsystem'
    : lane === 'priority' ? PRIORITIES.find(([p]) => p === k)?.[1] || k : lane === 'parent' ? (byId.get(k) ? `${byId.get(k).key} · ${byId.get(k).title}` : k ? 'Another item' : 'No parent')
    : lane === 'project' ? b.projectById.get(k)?.name || '' : k || 'None');
  const lanes = lane ? [...new Set(items.map(laneKey))].sort((x, y) => (lane === 'priority' ? PRIORITIES.findIndex(([p]) => p === x) - PRIORITIES.findIndex(([p]) => p === y) : laneName(x).localeCompare(laneName(y)))) : [''];

  const extras = st.config.card_fields || [];
  const card = (i) => {
    const c = scope.cfgOf(i);
    const drag = c && can(b, i.project_id, 'transition');
    const extra = extras.map((k) => {
      if (k === 'estimate_hours') return i.estimate_hours === null ? '' : `<span class="chip">${Number(i.estimate_hours)} h</span>`;
      if (k === 'labels') return (i.labels || []).map((l) => `<span class="chip">${esc(l)}</span>`).join('');
      if (k === 'subsystem') return b.subsystemById.get(i.subsystem_id) ? `<span class="chip">${esc(b.subsystemById.get(i.subsystem_id).name)}</span>` : '';
      if (k === 'progress') return Number(i.progress) ? `<span class="chip">${Number(i.progress)}%</span>` : '';
      const v = i.custom?.[k.slice(3)];
      const toned = v === undefined || v === '' ? null : choiceChips(c?.fields.find((f) => f.key === k.slice(3)), v);
      if (toned) return toned;
      return v === undefined || v === '' ? '' : `<span class="chip" title="${esc(c?.fields.find((f) => f.key === k.slice(3))?.name || k)}">${esc(Array.isArray(v) ? v.join(', ') : v === true ? '✓' : v)}</span>`;
    }).join('');
    const edit = mayEditItem(b, i);
    const parent = showParent && i.parent_id ? parentById.get(i.parent_id) : null;
    const dim = su && (i.owner_id || '') !== suWho;
    const facts = `${i.due_date ? ie(b, c, i, 'due', 'short') : ''}${i.blocked ? `<span class="chip-tone tone-red" title="${esc(i.blocked_reason || 'Blocked')}">⛔ Blocked</span>` : ''}
        ${Number(i.open_deps) ? `<span class="chip-tone tone-amber" title="Waiting on ${i.open_deps} other item(s)">⏳ ${i.open_deps}</span>` : ''}
        ${Number(i.children) ? `<span class="chip" title="Items under it that are done">☑ ${i.children_done}/${i.children}</span>` : ''}${extra}
        ${parent ? `<button type="button" class="chip pm-parent-chip" data-parent-filter="${esc(parent.id)}" title="${esc(`Under ${parent.key} ${parent.title}. Click to see only the items under it.`)}">${esc(parent.title)}</button>` : ''}`;
    return `<article class="kcard pm-card tone-edge-${esc(c?.typeById.get(i.type_id)?.color || 'gray')}${dim ? ' is-dim' : ''}" data-card="${esc(i.id)}" ${drag ? 'draggable="true"' : ''} tabindex="-1">
      <div class="kcard-head"><a class="kcard-name" href="${itemHref(i.key)}">${esc(i.title)}</a>
        <button type="button" class="btn btn-sm btn-ghost pm-card-menu" data-card-menu="${esc(i.id)}" aria-label="More for ${esc(i.key)}">⋯</button></div>
      ${facts.trim() ? `<div class="kcard-tags">${facts}</div>` : ''}
      <div class="kcard-meta pm-card-foot"><span>${pickBox(i)}${typeBadge(c?.typeById.get(i.type_id))} <a class="pm-keylink" href="${itemHref(i.key)}">${esc(i.key)}</a></span>
        <span class="pm-card-end">${i.priority !== 'medium' ? ie(b, c, i, 'priority', 'quiet') : ''}<span class="pm-card-owner${i.owner_id ? '' : ' is-empty'}">${ie(b, c, i, 'owner', 'avatar')}</span></span></div>
    </article>`;
  };
  const column = (c, ci, laneId) => {
    const list = items.filter((i) => colOf(i) === ci && (!lane || laneKey(i) === laneId));
    const all = items.filter((i) => colOf(i) === ci).length;
    const over = c.wip && all > c.wip;
    const kind = c.status_ids.map((id) => scope.statuses.find((s) => s.id === id)?.category).every((x) => x === 'done') ? 'done' : 'open';
    const addable = project && can(b, project.id, 'create') && !project.archived_at && kind !== 'done';
    return `<section class="kanban-col kind-${kind}${list.length ? '' : ' is-empty'}${over ? ' is-over-wip' : ''}" aria-label="${esc(c.name)}">
      ${laneId === lanes[0] ? `<header><h2>${esc(c.name)}</h2><span class="muted small" title="${c.wip ? `Limit: ${c.wip} at a time` : 'Cards in this column'}">${all}${c.wip ? ` / ${c.wip}` : ''}</span></header>
        ${over ? `<p class="pm-wip-warn" role="status">Over the limit of ${c.wip}: finish something before starting more.</p>` : ''}` : ''}
      <div class="kanban-cards" data-drop="${ci}|${esc(laneId)}">${list.map(card).join('') || '<p class="kanban-empty muted small">Nothing here.</p>'}</div>
      ${addable ? quickAdd(b, { project_id: project.id, status_ids: c.status_ids, ...(lane === 'owner' && laneId ? { owner_id: laneId } : {}), ...(lane === 'priority' && laneId ? { priority: laneId } : {}), ...(lane === 'parent' && laneId ? { parent_id: laneId } : {}) },
        { placeholder: '+ Add an item', label: `Add an item to ${c.name}`, cls: 'kanban-add' }) : ''}</section>`;
  };
  const stray = items.filter((i) => colOf(i) < 0);

  el.innerHTML = `<div class="pm-toolbar pm-tbar">${viewPicker(b, views, current, { noun: 'board', dirty: st.dirty })}${filterBar(b, st.f, { types: scope.types })}
      <div class="card-actions"><label class="inline-field">Lanes <select data-lane>${[...LANES.filter(([k]) => k !== 'project' || !project),
        ...(cfg?.fields || []).filter((f) => !f.archived_at && ['select', 'user', 'checkbox'].includes(f.type)).map((f) => [`cf.${f.key}`, f.name])]
        .map(([k, l]) => `<option value="${esc(k)}" ${lane === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <button type="button" class="btn btn-sm" data-standup aria-pressed="${!!su}">${su ? 'End stand-up' : 'Stand-up'}</button>
        ${moreMenu([['data-board-settings', 'Columns &amp; cards…']])}</div></div>
    ${su ? `<div class="pm-standup" role="region" aria-label="Stand-up" aria-live="polite">
      <span class="pm-standup-who">${su.order.map((u, n) => `<span class="${n === su.n ? 'is-on' : ''}">${avatar(b, u || null)}</span>`).join('')}</span>
      <strong>${esc(suWho ? personName(b, suWho) : 'No owner')}</strong>
      <span class="muted">${su.n + 1} of ${su.order.length} · ${items.filter((i) => (i.owner_id || '') === suWho).length} card${items.filter((i) => (i.owner_id || '') === suWho).length === 1 ? '' : 's'}</span>
      <span class="muted" data-su-clock></span>
      <label class="pm-check"><input type="checkbox" data-su-timer ${su.timer ? 'checked' : ''}> 2-minute timer</label>
      <span class="card-actions"><button type="button" class="btn btn-sm" data-su-step="-1" ${su.n ? '' : 'disabled'}>Back</button>
        <button type="button" class="btn btn-sm btn-primary" data-su-step="1">${su.n === su.order.length - 1 ? 'Finish' : 'Next'}</button></span></div>` : ''}
    ${hiddenTop ? `<p class="muted small pm-top-note">${hiddenTop} top-level item${hiddenTop === 1 ? ' (an epic) isn\'t' : 's (epics) aren\'t'} shown as cards: they're the name on each card under them. <button type="button" class="btn btn-sm btn-ghost" data-show-top>Show them</button></p>` : ''}
    ${total > found.length ? `<p class="alert alert-info">Showing the first ${found.length} of ${total} items. Narrow the filter to see the rest.</p>` : ''}
    ${lanes.map((l) => `${lane ? `<details class="pm-lane" ${st.closed.has(l) ? '' : 'open'} data-lane-id="${esc(l)}"><summary>${esc(laneName(l))} <span class="muted">${items.filter((i) => laneKey(i) === l).length}</span></summary>` : ''}
      <div class="kanban pm-kanban">${columns.map((c, ci) => column(c, ci, l)).join('')}</div>${lane ? '</details>' : ''}`).join('')}
    ${stray.length ? `<details class="card"><summary>${stray.length} item${stray.length === 1 ? ' is' : 's are'} in a status that no column shows</summary>
      <ul class="pm-mini">${stray.map((i) => `<li><a href="${itemHref(i.key)}">${esc(i.key)} · ${esc(i.title)}</a> <span class="muted">${esc(scope.statuses.find((s) => s.id === i.status_id)?.name || '')}</span></li>`).join('')}</ul>
      <p class="hint">Add the status to a column in "Columns &amp; cards".</p></details>` : ''}
    ${items.length ? '' : `<div class="empty"><p><strong>No items on this board.</strong></p><p>${project ? 'Type a title under a column and press Enter to add one there.' : 'Items show here once they\'re added to a project.'}${Object.values(st.f).some(Boolean) ? ' Or change the filter.' : ''}</p></div>`}`;

  const changed = () => ((st.dirty = true), scope.rerender());
  // V9: the stand-up's clock, and Esc / arrow keys while it runs
  const suStep = (n) => {
    if (!st.su) return;
    const next = st.su.n + n;
    if (next >= st.su.order.length) return ((st.su = null), toast('Stand-up done.'), scope.rerender());
    st.su = { ...st.su, n: Math.max(0, next), at: Date.now() };
    scope.rerender();
  };
  if (su) {
    const clock = el.querySelector('[data-su-clock]');
    const tickNow = () => {
      if (!el.isConnected || st.su !== su) return clearInterval(st.tick);
      const s = Math.floor((Date.now() - su.at) / 1000);
      const left = SU_SECONDS - s;
      const mmss = (v) => `${Math.floor(Math.abs(v) / 60)}:${String(Math.abs(v) % 60).padStart(2, '0')}`;
      clock.textContent = su.timer ? (left >= 0 ? `${mmss(left)} left` : `Time's up (${mmss(left)} over)`) : mmss(s);
      clock.classList.toggle('is-over', su.timer && left < 0);
    };
    tickNow();
    st.tick = setInterval(tickNow, 1000);
  }
  if (standupKeys) document.removeEventListener('keydown', standupKeys);
  standupKeys = su ? (e) => {
    if (!el.isConnected || e.target.closest?.('input, textarea, select, dialog, [contenteditable]')) return;
    if (e.key === 'Escape') ((st.su = null), scope.rerender());
    else if (e.key === 'ArrowRight') suStep(1);
    else if (e.key === 'ArrowLeft') suStep(-1);
  } : null;
  if (standupKeys) document.addEventListener('keydown', standupKeys);

  bindFilterBar(el, b, st.f, changed, { fields: cfg?.fields, statuses: scope.statuses, sprints: cfg?.sprints });
  bindViewPicker(el, { b, kind: 'board', projectId: project?.id, views, current, noun: 'board', getConfig: () => ({ ...st.config, columns, filter_state: st.f }),
    onPick: (v, id) => (applyView(st, v, id), scope.rerender()) });
  el.querySelector('[data-lane]').onchange = (e) => ((st.config = { ...st.config, swimlane: e.target.value }), changed());
  el.querySelectorAll('.pm-lane').forEach((d) => d.addEventListener('toggle', () => st.closed[d.open ? 'delete' : 'add'](d.dataset.laneId)));

  /** Put a card in a column (and lane): the workflow move if its status changes, then its place in the column. */
  const move = async (id, dropKey, beforeId) => {
    const item = byId.get(id);
    const [ci, laneId] = [Number(dropKey.split('|')[0]), dropKey.split('|').slice(1).join('|')];
    const c = scope.cfgOf(item);
    const col = columns[ci];
    if (!item || !c || !col) return;
    if (!col.status_ids.includes(item.status_id)) {
      const tr = col.status_ids.map((sid) => moveTo(c, item, sid, c.who)).find(Boolean);
      if (!tr) {
        const from = c.statusById.get(item.status_id)?.name;
        const own = col.status_ids.map((sid) => c.statusById.get(sid)).filter(Boolean);
        return toast(own.length ? `${item.key}: the workflow has no move from "${from}" to "${own.map((s) => s.name).join('" or "')}" that your role can make.`
          : `"${col.name}" has no status that ${c.typeById.get(item.type_id)?.name || 'this kind of'} items use.`, 'bad');
      }
      const res = await runMove(b, c, item, tr);
      if (!res) return;
      if (res.pending) return scope.rerender();
    }
    // its place among the cards it was dropped between, and the lane's value when the lane is something that can be set
    const peers = items.filter((i) => colOf(i) === ci && i.id !== id && (!lane || laneKey(i) === laneId));
    const at = beforeId ? peers.findIndex((i) => i.id === beforeId) : peers.length;
    const patch = { rank: rankBetween(peers[at - 1]?.rank, peers[at]?.rank) };
    if (lane && laneKey(item) !== laneId) {
      if (lane === 'owner') patch.owner_id = laneId || null;
      else if (lane === 'priority') patch.priority = laneId;
      else if (lane === 'parent') patch.parent_id = laneId || null;
    }
    await pm.updateItem(id, null, patch).catch((err) => Object.keys(patch).length > 1 && toast(err.message, 'bad'));
    scope.rerender();
  };
  bindKanbanDnd(el, { onDrop: move });
  // change in place (a status change moves the card to its new column), several at once, add with a title
  bindInline(el, { b, itemOf: (id) => byId.get(id), cfgOf: scope.cfgOf, after: (i, keys) => keys.includes('status_id') && scope.rerender() });
  bindSelection(el, { b, items: () => items, cfgOf: scope.cfgOf, done: () => scope.rerender(), sprints: cfg?.sprints || [] });
  bindQuickAdd(el, { b, done: () => scope.rerender() });
  // V8c: a card's menu: the moves its workflow allows, assign, copy its link, relate another item, archive
  const cardMenu = (id, x, y) => {
    const i = byId.get(id);
    const c = i && scope.cfgOf(i);
    if (!c) return;
    const entries = [];
    if (can(b, i.project_id, 'transition')) {
      for (const tr of movesFor(c, i, c.who)) {
        entries.push({ label: `Move to ${c.statusById.get(tr.to_status)?.name || tr.name}`, run: async () => (await runMove(b, c, i, tr)) && scope.rerender() });
      }
    }
    if (mayEditItem(b, i)) {
      if (i.owner_id !== b.me) entries.push({ label: 'Assign to me', run: async () => (await attempt(() => pm.updateItem(i.id, null, { owner_id: b.me }), `${i.key} is yours.`)) && scope.rerender() });
      entries.push({ label: 'Assign…', run: async () => {
        const who = await formDialog({ title: `Assign ${esc(i.key)}`, submit: 'Assign',
          body: `<div class="field"><label for="as-who">Owner</label>${peopleField('who', 'as-who', b, i.owner_id, { blank: 'No owner' })}</div>`,
          onSubmit: (f) => pm.updateItem(i.id, null, { owner_id: f.elements.who.value || null }).then(() => true) });
        if (who) scope.rerender();
      } });
    }
    entries.push({ label: 'Copy link', run: async () => {
      const url = new URL(itemHref(i.key), location.href).href;
      try {
        await navigator.clipboard.writeText(url);
        toast(`Copied the link to ${i.key}.`);
      } catch {
        toast(url);
      }
    } });
    if (mayEditItem(b, i)) {
      entries.push({ label: 'Change parent…', run: async () => (await parentDialog(b, c, i)) && scope.rerender() });
      entries.push(i.blocked
        ? { label: 'Clear the blocked flag', run: async () => (await attempt(() => pm.updateItem(i.id, null, { blocked: false, blocked_reason: '' }), `${i.key} isn't blocked now.`)) && scope.rerender() }
        : { label: 'Flag as blocked…', run: async () => {
          const why = await askText({ title: `Flag ${i.key} as blocked`, label: 'What\'s holding it up? (optional)', ok: 'Flag it', required: false, multiline: true });
          if (why === null) return;
          (await attempt(() => pm.updateItem(i.id, null, { blocked: true, blocked_reason: why.trim() }), `${i.key} is flagged as blocked.`)) && scope.rerender();
        } });
      entries.push({ label: 'Add a related item', run: async () => (await refDialog(i, 'item')) && toast(`Related to ${i.key}.`) });
    }
    if (can(b, i.project_id, 'delete')) {
      entries.push({ label: 'Archive', run: async () => confirm(`Archive ${i.key} and everything under it? It can be restored.`)
        && (await attempt(() => pm.archiveItem(i.id, true), `${i.key} is archived.`)) && scope.rerender() });
    }
    openMenu(x, y, entries, `${i.key} actions`);
  };
  el.addEventListener('contextmenu', (e) => {
    const cardEl = e.target.closest('[data-card]');
    if (!cardEl || e.target.closest('input, textarea, select')) return;
    e.preventDefault();
    cardMenu(cardEl.dataset.card, e.clientX, e.clientY);
  });
  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-su-timer]') && st.su) ((st.su = { ...st.su, timer: e.target.checked, at: Date.now() }), scope.rerender());
  });
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (e.target.closest('[data-board-settings]')) {
      const next = await boardSettings(scope, columns, st.config);
      if (next) ((st.config = next), changed());
    } else if (t?.dataset.showTop !== undefined) {
      st.config = { ...st.config, show_top: true };
      changed();
    } else if (t?.dataset.cardMenu) {
      const r = t.getBoundingClientRect();
      cardMenu(t.dataset.cardMenu, r.left, r.bottom + 4);
    } else if (t?.dataset.parentFilter) {
      // V8b: only the items under that parent (in "More filters", so it can be changed or cleared there)
      st.f.more = { f: 'parent', op: 'eq', v: t.dataset.parentFilter };
      changed();
    } else if (t?.dataset.standup !== undefined) {
      if (st.su) st.su = null;
      else {
        // everyone with an open card, in a random order; cards with no owner come last
        const people = [...new Set(items.filter((i) => i.category !== 'done' && i.owner_id).map((i) => i.owner_id))];
        for (let k = people.length - 1; k > 0; k--) {
          const j = Math.floor(Math.random() * (k + 1));
          [people[k], people[j]] = [people[j], people[k]];
        }
        if (items.some((i) => i.category !== 'done' && !i.owner_id)) people.push('');
        if (!people.length) return toast('No open cards to go through.');
        st.su = { order: people, n: 0, timer: false, at: Date.now() };
      }
      scope.rerender();
    } else if (t?.dataset.suStep) suStep(Number(t.dataset.suStep));
  });
}

function applyView(st, v, id = null) {
  st.view = v?.id || id || 'none';
  st.dirty = false;
  st.config = v ? { ...v.config } : {};
  Object.assign(st.f, { q: '', owner: '', category: '', priority: '', type: '', more: null }, v?.config.filter_state || {});
}

/** Columns (name, which statuses, limit), in order, and what the cards show. Returns the new board config or null. */
function boardSettings(scope, columns, config) {
  const model = columns.map((c) => ({ ...c, status_ids: [...c.status_ids] }));
  // statuses are offered by name: across projects, every status with that name goes with it
  const names = [...new Map(scope.statuses.map((s) => [s.name.trim().toLowerCase(), s.name])).entries()];
  const idsOf = (key) => scope.statuses.filter((s) => s.name.trim().toLowerCase() === key).map((s) => s.id);
  const draw = (form) => {
    const used = (key, ci) => model.some((c, i) => i !== ci && idsOf(key).some((id) => c.status_ids.includes(id)));
    form.querySelector('[data-cols]').innerHTML = model.map((c, ci) => `<fieldset class="pm-section pm-col-edit" data-ci="${ci}">
      <div class="pm-col-head"><input type="text" data-col-name value="${esc(c.name)}" maxlength="40" aria-label="Column name" required>
        <label class="inline-field">Limit <input type="number" data-col-wip min="0" value="${esc(c.wip || '')}" placeholder="none" aria-label="Work-in-progress limit"></label>
        <button type="button" class="btn btn-sm btn-ghost" data-up ${ci ? '' : 'disabled'} aria-label="Move left">←</button><button type="button" class="btn btn-sm btn-ghost" data-down ${ci < model.length - 1 ? '' : 'disabled'} aria-label="Move right">→</button>
        <button type="button" class="btn btn-sm btn-ghost" data-remove aria-label="Remove column">Remove</button></div>
      <div class="pm-checks">${names.map(([key, name]) => `<label class="pm-check${used(key, ci) ? ' is-used' : ''}"><input type="checkbox" data-col-status="${esc(key)}" ${idsOf(key).some((id) => c.status_ids.includes(id)) ? 'checked' : ''}> ${esc(name)}</label>`).join('')}</div></fieldset>`).join('');
    const missing = names.filter(([key]) => !model.some((c) => idsOf(key).some((id) => c.status_ids.includes(id)))).map(([, n]) => n);
    form.querySelector('[data-missing]').textContent = missing.length ? `Not on the board: ${missing.join(', ')}. Items in these statuses won't show in a column.` : '';
  };
  const extras = [...CARD_EXTRAS, ...scope.fields.filter((f) => !f.archived_at && f.type !== 'formula' && f.type !== 'longtext' && f.type !== 'richtext').map((f) => [`cf.${f.key}`, f.name])];
  return formDialog({
    title: 'Columns and cards', submit: 'Apply', wide: true,
    body: `<p class="muted">A column can hold several statuses. A limit warns when a column has too much in it at once. Apply, then "Save" or "Save as…" to keep it.</p>
      <div data-cols></div><p class="hint" data-missing></p><p><button type="button" class="btn btn-sm" data-add-col>+ Column</button></p>
      <fieldset class="pm-section"><legend>Also show on each card</legend><div class="pm-checks"><label class="pm-check"><input type="checkbox" name="show_parent" ${config.hide_parent ? '' : 'checked'}> Parent</label><label class="pm-check"><input type="checkbox" name="show_top" ${config.show_top ? 'checked' : ''}> Top-level items (epics) as cards of their own</label>${extras.map(([k, l]) => `<label class="pm-check"><input type="checkbox" name="extra" value="${esc(k)}" ${(config.card_fields || []).includes(k) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div></fieldset>`,
    onOpen(form) {
      draw(form);
      form.addEventListener('input', (e) => {
        const ci = Number(e.target.closest('[data-ci]')?.dataset.ci);
        if (e.target.matches('[data-col-name]')) model[ci].name = e.target.value;
        if (e.target.matches('[data-col-wip]')) model[ci].wip = Number(e.target.value) || null;
      });
      form.addEventListener('change', (e) => {
        if (!e.target.matches('[data-col-status]')) return;
        const ci = Number(e.target.closest('[data-ci]').dataset.ci);
        const ids = idsOf(e.target.dataset.colStatus);
        model.forEach((c, i) => (c.status_ids = c.status_ids.filter((id) => !ids.includes(id) || (i === ci && e.target.checked))));
        if (e.target.checked) model[ci].status_ids.push(...ids.filter((id) => !model[ci].status_ids.includes(id)));
        draw(form);
      });
      form.addEventListener('click', (e) => {
        const t = e.target.closest('button');
        const ci = Number(t?.closest('[data-ci]')?.dataset.ci);
        if (!t) return;
        if (t.dataset.addCol !== undefined) model.push({ name: 'New column', wip: null, status_ids: [] });
        else if (t.dataset.remove !== undefined) model.splice(ci, 1);
        else if (t.dataset.up !== undefined) model.splice(ci - 1, 0, model.splice(ci, 1)[0]);
        else if (t.dataset.down !== undefined) model.splice(ci + 1, 0, model.splice(ci, 1)[0]);
        else return;
        draw(form);
      });
    },
    onSubmit(form) {
      if (!model.length) throw new Error('A board needs at least one column.');
      return { ...config, columns: model.map((c) => ({ name: c.name.trim() || 'Column', wip: c.wip, status_ids: c.status_ids })), card_fields: [...form.querySelectorAll('[name=extra]:checked')].map((n) => n.value), hide_parent: !form.elements.show_parent.checked, show_top: form.elements.show_top.checked };
    },
  });
}

/** Pick a new parent for an item: open items its kind can go under (the project's levels), or none. */
async function parentDialog(b, cfg, item) {
  const type = cfg.typeById.get(item.type_id);
  const parents = (await loadParents(item.project_id).catch(() => [])).filter((p) => {
    const pt = cfg.typeById.get(p.type_id);
    return p.id !== item.id && pt && (type?.parent_type_ids?.length ? type.parent_type_ids.includes(pt.id) : pt.level < (type?.level ?? 0));
  });
  if (!parents.length && !item.parent_id) return toast(`There's nothing open that ${item.key} can go under.`, 'bad'), null;
  return formDialog({ title: `Change the parent of ${esc(item.key)}`, submit: 'Save',
    body: `<div class="field"><label for="cp-parent">Goes under</label><select id="cp-parent" name="parent"><option value="">Nothing (top level)</option>
      ${parents.map((p) => `<option value="${esc(p.id)}" ${p.id === item.parent_id ? 'selected' : ''}>${esc(p.key)} · ${esc(p.title)}</option>`).join('')}</select>
      <div class="hint">Only open items of a kind it can go under are listed.</div></div>`,
    onSubmit: (f) => pm.updateItem(item.id, null, { parent_id: f.elements.parent.value || null }).then(() => (toast(`Saved. ${item.key} ${f.elements.parent.value ? 'has a new parent' : 'is at the top level'}.`), true)) });
}
