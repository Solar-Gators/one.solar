/**
 * Projects → My work: what's on my plate, without needing to know how any project is set up. Overdue and due
 * soon first, what's blocked and why, what's waiting for my approval, and a quick way to move each item along.
 */
import { esc, fmtDate } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { relDay } from '../../projects/core.js';
import { todayISO } from '../../projects/schedule.js';
import { needsDatabase, loadBase, shapesFor, header, itemHref, projectHref, typeBadge, ie, can, toast, attempt, personName } from './kit.js';
import { askText } from '../../ui.js';
import { bindInline } from './inline.js';
import { bindSelection, pickBox } from './select.js';
import { quickAdd, bindQuickAdd } from './quick.js';

const view = { group: 'when', show: 'open' };

export async function renderMyWork(el, { config, rerender }) {
  const missing = needsDatabase(config);
  if (missing) return void (el.innerHTML = missing);
  const b = await loadBase();
  const [{ items: mine }, { items: watching }, approvals] = await Promise.all([
    pm.search({ filter: { f: 'mine' }, limit: 500, sort: 'due' }),
    pm.search({ filter: { all: [{ f: 'watching' }, { not: { f: 'mine' } }, { f: 'category', op: 'ne', v: 'done' }] }, limit: 50, sort: 'updated', dir: 'desc' }),
    pm.approvals(),
  ]);
  const projectIds = [...new Set([...mine, ...watching].map((i) => i.project_id).concat(approvals.map((a) => a.project_id)))];
  const { cfgOf, per } = await shapesFor(b, projectIds);
  const toApprove = approvals.filter((a) => can(b, a.project_id, 'approve') && a.requested_by !== b.me);
  const asked = approvals.filter((a) => a.requested_by === b.me);
  const approvalItems = await pm.itemsByIds([...new Set([...toApprove, ...asked].map((a) => a.item_id))]);
  const itemById = new Map(approvalItems.map((i) => [i.id, i]));

  const today = todayISO();
  const soon = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const recent = new Date(Date.now() - 14 * 864e5).toISOString();
  const open = mine.filter((i) => i.category !== 'done');
  const done = mine.filter((i) => i.category === 'done' && (i.completed_at || '') >= recent).sort((a, c) => (a.completed_at < c.completed_at ? 1 : -1));
  const sections = view.group === 'project'
    ? [...new Set(open.map((i) => i.project_id))].map((id) => [b.projectById.get(id)?.name || 'Project', open.filter((i) => i.project_id === id), ''])
    : view.group === 'status'
      ? [['In progress', open.filter((i) => i.category === 'doing'), ''], ['Not started', open.filter((i) => i.category === 'todo'), '']]
      : [
          ['Overdue', open.filter((i) => i.due_date && i.due_date < today), 'is-bad'],
          ['Blocked', open.filter((i) => i.blocked || Number(i.open_deps) > 0), 'is-warn'],
          ['Due in the next 7 days', open.filter((i) => i.due_date && i.due_date >= today && i.due_date <= soon), ''],
          ['In progress', open.filter((i) => i.category === 'doing' && !(i.due_date && i.due_date <= soon)), ''],
          ['Up next', open.filter((i) => i.category === 'todo' && !(i.due_date && i.due_date <= soon)), ''],
        ];

  const row = (i) => {
    const c = cfgOf(i);
    const p = b.projectById.get(i.project_id);
    return `<li class="pm-work" data-item="${esc(i.id)}" tabindex="-1">${pickBox(i)}
      <div class="pm-work-main">${typeBadge(c?.typeById.get(i.type_id))} <a href="${itemHref(i.key)}"><strong>${esc(i.title)}</strong></a>
        <div class="pm-work-meta"><a href="${itemHref(i.key)}" class="pm-keylink">${esc(i.key)}</a> · <a href="${projectHref(p?.key || '')}">${esc(p?.name || '')}</a>
          ${ie(b, c, i, 'priority', 'quiet')} ${ie(b, c, i, 'due')}
          ${i.owner_id && i.owner_id !== b.me ? `<span class="muted small">Owner: ${esc(personName(b, i.owner_id))}</span>` : ''}</div>
        ${i.blocked ? `<div class="pm-work-why">⛔ Blocked${i.blocked_reason ? `: ${esc(i.blocked_reason)}` : ''}</div>` : ''}
        ${Number(i.open_deps) ? `<div class="pm-work-why">⏳ Waiting on ${i.open_deps} other item${Number(i.open_deps) === 1 ? '' : 's'} to finish</div>` : ''}</div>
      <div class="pm-work-act">${ie(b, c, i, 'status')}</div></li>`;
  };
  const block = ([title, list, tone]) => (list.length ? `<section class="card pm-work-group ${tone}"><h2>${esc(title)} <span class="muted">${list.length}</span></h2><ul class="pm-work-list">${list.map(row).join('')}</ul></section>` : '');
  const approvalRow = (a, mineToDecide) => {
    const it = itemById.get(a.item_id);
    if (!it) return '';
    const tr = per.get(a.project_id)?.transitions.find((t) => t.id === a.transition_id);
    return `<li class="pm-work"><div class="pm-work-main"><a href="${itemHref(it.key)}"><strong>${esc(it.title)}</strong></a>
      <div class="pm-work-meta"><a href="${itemHref(it.key)}" class="pm-keylink">${esc(it.key)}</a> · ${esc(tr?.name || 'A move')} · asked ${esc(relDay(a.requested_at))} by ${esc(personName(b, a.requested_by))}</div>
      ${a.payload?.comment ? `<div class="pm-work-why">“${esc(a.payload.comment)}”</div>` : ''}</div>
      <div class="pm-work-act">${mineToDecide ? `<button type="button" class="btn btn-sm btn-primary" data-approve="${esc(a.id)}">Approve</button><button type="button" class="btn btn-sm" data-reject="${esc(a.id)}">Send back</button>` : '<span class="chip-tone tone-amber">Waiting for approval</span>'}</div></li>`;
  };

  el.innerHTML = `${header('My work', `${open.length} open item${open.length === 1 ? '' : 's'} where you're the owner or a collaborator.`,
    `<a class="btn" href="#/projects/all">All projects</a>`)}
    <div class="pm-filters">
      <label class="inline-field">Group by <select id="mw-group"><option value="when" ${view.group === 'when' ? 'selected' : ''}>What needs you first</option>
        <option value="project" ${view.group === 'project' ? 'selected' : ''}>Project</option><option value="status" ${view.group === 'status' ? 'selected' : ''}>Status</option></select></label>
      <a class="btn btn-sm" href="#/projects/list">Search all work</a>
      ${done.length ? '<button type="button" class="btn btn-sm" id="mw-summary" title="A plain list of what you finished, to paste into a self-evaluation or a report">Copy what I finished</button>' : ''}
    </div>
    ${quickAdd(b, {}, { placeholder: '+ Add something to do (it\'s yours; Enter to add)', label: 'Add an item for yourself', cls: 'pm-qa-mine' })}
    ${toApprove.length ? `<section class="card pm-work-group is-warn"><h2>Waiting for your approval <span class="muted">${toApprove.length}</span></h2><ul class="pm-work-list">${toApprove.map((a) => approvalRow(a, true)).join('')}</ul></section>` : ''}
    ${sections.map(block).join('') || (open.length ? '' : emptyState(b))}
    ${asked.length ? `<section class="card pm-work-group"><h2>You asked for approval <span class="muted">${asked.length}</span></h2><ul class="pm-work-list">${asked.map((a) => approvalRow(a, false)).join('')}</ul></section>` : ''}
    ${watching.length ? `<details class="card pm-work-group"><summary><h2>Watching <span class="muted">${watching.length}</span></h2></summary><ul class="pm-work-list">${watching.map(row).join('')}</ul></details>` : ''}
    ${done.length ? `<details class="card pm-work-group"><summary><h2>Finished in the last two weeks <span class="muted">${done.length}</span></h2></summary><ul class="pm-work-list">${done.map(row).join('')}</ul></details>` : ''}`;

  el.querySelector('#mw-group').onchange = (e) => {
    view.group = e.target.value;
    rerender();
  };
  el.querySelector('#mw-summary')?.addEventListener('click', async () => {
    // For a self-evaluation: what was done, in words. Never a score, and nothing is sent to Solar Evals.
    const text = done.map((i) => `- ${i.title} (${i.key}, ${b.projectById.get(i.project_id)?.name || ''}), finished ${fmtDate(i.completed_at)}`).join('\n');
    await navigator.clipboard.writeText(text).then(() => toast('Copied. Paste it wherever you describe your work.'), () => toast('Couldn\'t copy.', 'bad'));
  });
  // change in place; a finished item stays where it is until the page is opened again (so it doesn't jump away)
  const all = [...mine, ...watching];
  bindInline(el, { b, itemOf: (id) => all.find((i) => i.id === id), cfgOf });
  bindSelection(el, { b, items: () => all, cfgOf, done: rerender });
  bindQuickAdd(el, { b, done: rerender });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-shortcuts]')) return void import('./command.js').then((m) => m.helpDialog());
    const t = e.target.closest('[data-approve], [data-reject]');
    if (!t) return;
    const approve = t.dataset.approve !== undefined;
    const note = approve ? '' : await askText({ title: 'Send it back', label: 'Why isn\'t it approved?', ok: 'Send back', multiline: true });
    if (!approve && !note) return;
    if (await attempt(() => pm.decideApproval(t.dataset.approve || t.dataset.reject, approve, note), approve ? 'Approved.' : 'Sent back.')) rerender();
  });
}

/** Nothing of mine yet: my subsystem's projects (or every project), and how to start. */
function emptyState(b) {
  const sub = b.myOrg?.subsystem_id;
  const div = b.myOrg?.division_id;
  const near = b.projects.filter((p) => !p.archived_at && ((sub && p.subsystem_id === sub) || (!sub && div && p.division_id === div)));
  const where = sub ? b.subsystemById.get(sub)?.name : div ? b.divisionById.get(div)?.name : '';
  return `<div class="empty"><p><strong>Nothing assigned to you right now.</strong></p>
    <p>When someone makes you the owner of an item, or adds you as a collaborator, it shows here. You can also add something for yourself above.</p>
    ${near.length ? `<p>${esc(where)}'s projects:</p><p class="pm-empty-links">${near.map((p) => `<a class="btn btn-sm" href="${projectHref(p.key)}">${esc(p.name)}</a>`).join(' ')}</p>` : ''}
    <p><a class="btn btn-primary" href="#/projects/all">Look at the projects</a> <button type="button" class="btn btn-ghost" data-shortcuts>Keyboard shortcuts</button></p></div>`;
}
