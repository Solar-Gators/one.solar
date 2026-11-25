/**
 * Projects: one project's pages (Summary, List, Board, Backlog, Timeline, Calendar, Documents, Settings) and the
 * same List / Board / Timeline / Calendar across every project I can see. Each page gets a "scope":
 *   { b, project, cfg, cfgOf(item), statuses, types, fields, projectIds, rerender, params, base }
 * so one view works for one project or for all of them.
 */
import { esc, fmtDate, fmtDateTime, takeFlash, fmtMoney, askText } from '../../ui.js';
import { todayISO } from '../../projects/schedule.js';
import { appUrl } from '../../../../shared/onesolar.js';
import { pm } from '../../projects/api.js';
import { progressOf, attention } from '../../projects/core.js';
import { needsDatabase, loadBase, loadConfig, shapesFor, header, projectTop, projectHref, itemHref, personName, avatar, can, rich, createItemDialog, statusChip, dueChip, attempt, invalidate, infoTip } from './kit.js';
import { progressBar } from './projects.js';
import { renderList } from './list.js';
import { alumniShareCard, bindAlumniShare } from './alumni.js';
import { renderBoard } from './board.js';
import { cycleSwitch, bindCycleSwitch, inView, cyclesInView } from './cycles.js';
import { bindPeekLinks, openPeek } from '../../peek.js';

/**
 * W1: on the views that list work, an item opens in a panel over the view instead of a new page (Esc closes it).
 * The address gets ?item=KEY while it's open, so the link can be sent; opening that link opens the panel again.
 */
const PEEK_TABS = ['list', 'board', 'backlog', 'timeline', 'calendar', 'boards'];
function peekItems(body, ctx, base) {
  const share = (href) => {
    const key = href ? decodeURIComponent(href.split('/').pop()) : '';
    const q = new URLSearchParams(ctx.params.query || '');
    if (key) q.set('item', key);
    else q.delete('item');
    return `${base}${q.toString() ? `?${q}` : ''}`;
  };
  const opts = { ctx: { config: ctx.config, rerender: ctx.rerender }, share };
  bindPeekLinks(body, opts);
  const key = ctx.params.query?.get('item');
  if (key) openPeek(body, itemHref(key), opts);
}

const lazy = {
  backlog: () => import('./backlog.js').then((m) => m.renderBacklog),
  timeline: () => import('./timeline.js').then((m) => m.renderTimeline),
  calendar: () => import('./calendar.js').then((m) => m.renderCalendar),
  docs: () => import('./docs.js').then((m) => m.renderDocs),
  settings: () => import('./settings.js').then((m) => m.renderSettings),
};

export async function renderProject(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return void (el.innerHTML = missing);
  const [key, tab = '', sub = '', sub2 = ''] = ctx.params.parts;
  const b = await loadBase();
  const project = b.projectByKey.get(key.toUpperCase());
  if (!project) {
    el.innerHTML = `<section class="card no-access"><h1>No project "${esc(key)}"</h1><p>It doesn't exist, or it's private and you haven't been added to it.</p>
      <div class="form-actions"><a class="btn btn-primary" href="#/projects/all">All projects</a></div></section>`;
    return;
  }
  const cfg = await loadConfig(b, project.id);
  const scope = { b, project, cfg, cfgOf: () => cfg, statuses: cfg.statuses, types: cfg.types, fields: cfg.fields, projectIds: [project.id],
    rerender: ctx.rerender, params: { ...ctx.params, sub, sub2 }, base: projectHref(project.key, tab) };
  const newBtn = can(b, project.id, 'create') && !project.archived_at ? '<button type="button" class="btn btn-primary" data-new-item>New item</button>' : '';
  el.innerHTML = `${takeFlash()}${projectTop(b, project, tab, newBtn)}<div data-body></div>`;
  el.querySelector('[data-new-item]')?.addEventListener('click', async () => {
    const item = await createItemDialog(b, cfg);
    if (item) ctx.rerender();
  });
  const body = el.querySelector('[data-body]');
  if (PEEK_TABS.includes(tab)) peekItems(body, ctx, scope.base);
  if (tab === '') return summary(body, scope);
  if (tab === 'list') return renderList(body, scope);
  if (tab === 'board') return renderBoard(body, scope);
  if (lazy[tab]) return (await lazy[tab]())(body, scope);
  location.hash = projectHref(project.key);
}

/** List, Boards, Timeline and Calendar over every project I can see. */
export async function renderAcross(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return void (el.innerHTML = missing);
  const which = ctx.params.parts[0];
  const b = await loadBase();
  // 063: the car cycles chosen at the top (this car, the next, both, everything)
  const projectIds = b.projects.filter((p) => !p.archived_at && inView(b, p)).map((p) => p.id);
  const shapes = await shapesFor(b, projectIds);
  const scope = { b, project: null, cfg: null, cfgOf: shapes.cfgOf, statuses: shapes.all.statuses, types: shapes.all.types, fields: [], projectIds,
    rerender: ctx.rerender, params: ctx.params, base: `#/projects/${which}`, only: cyclesInView(b) ? projectIds : null };
  const titles = { boards: ['Boards', 'Boards across projects: statuses with the same name share a column.'], timeline: ['Timeline', 'Every project on one timeline, with the dependencies between them.'],
    calendar: ['Calendar', 'Deadlines, milestones and project events.'], list: ['All work', 'Search every item you can see.'] };
  el.innerHTML = `${takeFlash()}${header(titles[which][0], titles[which][1])}${cycleSwitch(b)}<div data-body></div>`;
  bindCycleSwitch(el, b, ctx.rerender);
  const body = el.querySelector('[data-body]');
  if (!projectIds.length) return void (body.innerHTML = `<div class="empty"><p><strong>${cyclesInView(b) ? 'No projects in this car cycle yet.' : 'No projects yet.'}</strong></p><p><a class="btn btn-primary" href="#/projects/all">Projects</a></p></div>`);
  if (PEEK_TABS.includes(which)) peekItems(body, ctx, `#/projects/${which}`);
  if (which === 'list') return renderList(body, scope);
  if (which === 'boards') return renderBoard(body, scope);
  return (await lazy[which]())(body, scope);
}

/** A project's front page: how it's doing (three ways, each explained), what's coming, who's in it, what just happened. */
async function summary(el, { b, project, cfg, rerender }) {
  const [rollup, upcoming, events, docs, alumniCard, spend, late] = await Promise.all([
    pm.rollup(), pm.search({ project: project.id, filter: { all: [{ f: 'category', op: 'ne', v: 'done' }, { any: [{ f: 'milestone' }, { f: 'due', op: 'within', v: 14 }, { f: 'overdue' }] }] }, sort: 'due', limit: 12 }),
    pm.events({ projectIds: [project.id], limit: 15 }), pm.resources(project.id).catch(() => []),
    project.archived_at ? '' : alumniShareCard({ projectId: project.id, mayEdit: can(b, project.id, 'edit'), what: 'this project', heading: 'h2', compact: true }),
    pm.projectSpend(project.id).catch(() => null),   // 060
    pm.orderWarnings(project.id).catch(() => []),   // 061
  ]);
  const [week, tops] = await Promise.all([weekNumbers(project), topProgress(project, cfg)]);
  const keyOf = new Map((await pm.itemsByIds([...new Set(events.map((e) => e.item_id).filter(Boolean))])).map((i) => [i.id, i.key]));
  const groups = rollup.groups.filter((g) => g.project_id === project.id);
  const p = progressOf(groups);
  const why = attention(p);
  const metric = (label, m) => `<div class="pm-metric" title="${esc(m.how)}"><strong>${m.value === null ? '—' : `${m.value}%`}</strong><span>${esc(label)}</span></div>`;
  // W6: four 7-day numbers at the top, each opening the List with those items (like Jira's summary)
  const tile = (n, label, when, show) => `<a class="pm-tile" href="${projectHref(project.key, 'list')}?show=${show}"><strong>${n ?? '—'}</strong><span>${label}</span><small>${when}</small></a>`;
  const bySub = [...new Map(groups.map((g) => [g.subsystem_id || g.division_id || '', null])).keys()].map((id) => {
    const rows = groups.filter((g) => (g.subsystem_id || g.division_id || '') === id);
    return [b.subsystemById.get(id)?.name || b.divisionById.get(id)?.name || 'No subsystem', progressOf(rows)];
  });
  const roleName = (m) => cfg.roles.find((r) => r.id === m.role_id)?.name || '';
  el.innerHTML = `<div class="pm-summary">
    <div class="pm-tiles pm-wide" role="list">${tile(week.finished, 'finished', 'in the last 7 days', 'finished')}${tile(week.changed, 'changed', 'in the last 7 days', 'changed')}${tile(week.created, 'added', 'in the last 7 days', 'added')}${tile(week.due.total, 'due soon', 'in the next 7 days', 'due')}</div>
    <section class="card"><h2>How it's going ${infoTip('Three ways of measuring the same project. They rarely agree: finishing many small items moves the first, finishing the big ones moves the second, and only reaching milestones moves the third. By items: items finished ÷ all items. By effort: estimated hours finished ÷ all estimated hours. By milestones: milestones reached ÷ all milestones. Point at a number to see its figures.')}</h2>
      ${why.length ? `<div class="alert alert-info pm-attention-box">⚠ May need someone to step in: ${esc(why.join('; '))}.</div>` : ''}
      ${progressBar(p)}
      <div class="pm-nums"><a href="${projectHref(project.key, 'list')}"><strong>${p.total - p.done}</strong> open</a><span><strong>${p.doing}</strong> in progress</span><span><strong>${p.done}</strong> done</span>
        <span class="${p.overdue ? 'is-late' : ''}"><strong>${p.overdue}</strong> overdue</span><span class="${p.blocked ? 'is-late' : ''}"><strong>${p.blocked}</strong> blocked</span><span><strong>${p.unassigned}</strong> without an owner</span></div>
      <div class="pm-metrics">${metric('by items', p.byCount)}${metric('by effort', p.byEffort)}${metric('by milestones', p.byMilestones)}</div>
      <p class="muted small pm-docs-line">${docs.length ? `${docs.length} linked document${docs.length === 1 ? '' : 's'}` : 'No documents linked yet'} · <a href="${projectHref(project.key, 'docs')}">Document library</a></p>
    </section>
    <section class="card"><h2>Coming up</h2>
      ${upcoming.items.length ? `<ul class="pm-mini">${upcoming.items.map((i) => `<li><a href="${itemHref(i.key)}">${esc(i.title)}</a> ${statusChip(cfg.statusById.get(i.status_id))} ${dueChip(i)} ${avatar(b, i.owner_id)}</li>`).join('')}</ul>`
        : '<p class="muted">No milestones or deadlines in the next two weeks, and nothing overdue.</p>'}
      <p><a href="${projectHref(project.key, 'timeline')}">Timeline</a> · <a href="${projectHref(project.key, 'calendar')}">Calendar</a></p>
    </section>
    ${progressCard(tops, bySub)}
    ${project.description ? `<section class="card"><h2>About</h2><div class="pm-rich">${rich(project.description)}</div></section>` : ''}
    <section class="card"><h2>People</h2>
      <p class="muted small">${project.lead_id ? `Project manager: ${esc(personName(b, project.lead_id))}. ` : ''}${project.visibility === 'team'
        ? `Everyone on the team can see this project${project.team_role_id ? ` as ${esc(cfg.roles.find((r) => r.id === project.team_role_id)?.name || 'a viewer')}` : ''}.` : 'Only these people can see this project.'}</p>
      <ul class="pm-mini">${cfg.members.map((m) => `<li>${avatar(b, m.user_id)} ${esc(personName(b, m.user_id))} <span class="muted">${esc(roleName(m))}</span></li>`).join('')}</ul>
      ${can(b, project.id, 'members') ? `<p><a href="${projectHref(project.key, 'settings/people')}">Add people or change roles</a></p>` : ''}
    </section>
    ${spendCard(b, project, spend, late)}
    ${alumniCard}
    <section class="card pm-wide"><h2>Latest</h2>
      ${events.length ? `<ul class="pm-activity">${events.map((e) => `<li><span class="muted small">${esc(fmtDateTime(e.created_at))}</span> <strong>${esc(e.actor_name || 'one.solar')}</strong> ${esc(e.summary)}${keyOf.get(e.item_id) && !e.summary.includes(keyOf.get(e.item_id)) ? ` <a href="${itemHref(keyOf.get(e.item_id))}">${esc(keyOf.get(e.item_id))}</a>` : ''}</li>`).join('')}</ul>` : '<p class="muted">Nothing has happened yet.</p>'}
    </section></div>`;
  bindAlumniShare(el, { projectId: project.id, done: () => rerender() });
  // C6: one Progress card, by epic or by subsystem
  el.querySelectorAll('[data-prog-tab]').forEach((t) => (t.onclick = () => {
    progressTab = t.dataset.progTab;
    el.querySelectorAll('[data-prog-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    el.querySelectorAll('[data-prog-pane]').forEach((p) => (p.hidden = p.dataset.progPane !== progressTab));
  }));
  el.querySelector('[data-project-budget]')?.addEventListener('click', async () => {
    const v = await askText({ title: 'Project budget', label: 'Budget ($)', placeholder: '1500', required: false, ok: 'Save', value: project.settings?.budget ?? '',
      hint: 'What this project may spend on Orders. Leave it empty for none. Shown next to what its linked requests cost.' });
    if (v === null) return;
    const n = v.trim() === '' ? null : Number(v.replace(/[$,\s]/g, ''));
    if (n !== null && !(n >= 0)) return alert('Enter a dollar amount, or leave it empty.');
    if (await attempt(() => pm.saveProject(project.id, { settings: { budget: n } }), 'Budget saved.')) (invalidate(), rerender());
  });
  el.querySelector('[data-order-lead]')?.addEventListener('click', async () => {
    const v = await askText({ title: 'Warn about orders', label: 'Days before an item starts', placeholder: '7', required: false, ok: 'Save', value: project.settings?.order_lead_days ?? 7,
      hint: "An item linked to an Orders request that isn't ordered yet is a warning this many days before it starts, and its owner and the project manager are told." });
    if (v === null) return;
    const n = v.trim() === '' ? 7 : Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 365) return alert('Enter a whole number of days, 0 to 365.');
    if (await attempt(() => pm.saveProject(project.id, { settings: { order_lead_days: n } }), 'Saved.')) (invalidate(), rerender());
  });
}

/**
 * 060: Orders & budget. The Orders requests linked to this project's items (on each item, "Parts & orders"),
 * added up: spent (ordered or received), committed (approved, not ordered yet) and waiting (submitted), next to
 * the project's own budget.
 */
function spendCard(b, project, spend, late = []) {
  if (!spend) return '';
  const sum = (sts) => spend.filter((r) => sts.includes(r.status)).reduce((s, r) => s + (Number(r.total) || 0), 0);
  const spent = sum(['Ordered', 'Received']);
  const committed = sum(['Approved']);
  const waiting = sum(['Submitted']);
  const budget = project.settings?.budget ?? null;
  const left = budget === null ? null : budget - spent - committed;
  const mayEdit = can(b, project.id, 'configure');
  if (!spend.length && budget === null && !mayEdit && !late.length) return '';
  if (!spend.length && budget === null && !late.length) {
    return `<section class="card pm-oneline"><h2>Orders &amp; budget</h2><span class="muted small">No Orders requests linked and no budget set.</span>
      <button type="button" class="btn btn-sm btn-ghost" data-project-budget>Set budget…</button></section>`;
  }
  return `<section class="card"><h2>Orders &amp; budget</h2>
    ${late.length ? `<div class="alert alert-warning"><strong>Not ordered in time:</strong><ul class="pm-mini">${late.map((w) => `<li><a href="${itemHref(w.key)}">${esc(w.key)}</a> ${esc(w.title)} ${w.start < todayISO() ? 'started' : 'starts'} ${esc(fmtDate(w.start))}; <a href="${esc(appUrl(`orders/#/requests/${encodeURIComponent(w.number)}`))}">${esc(w.number)}</a> is ${esc(w.status)}.</li>`).join('')}</ul></div>` : ''}
    <div class="pm-nums"><span><strong>${esc(fmtMoney(spent))}</strong> spent</span><span><strong>${esc(fmtMoney(committed))}</strong> committed</span><span><strong>${esc(fmtMoney(waiting))}</strong> waiting for approval</span></div>
    <p>${budget === null ? '<span class="muted">No project budget set.</span>'
      : `Budget <strong>${esc(fmtMoney(budget))}</strong> · <span class="${left < 0 ? 'is-late' : ''}">${left < 0 ? `${esc(fmtMoney(-left))} over` : `${esc(fmtMoney(left))} left`}</span>`}
      ${mayEdit ? ' <button type="button" class="btn btn-sm btn-ghost" data-project-budget>Set budget…</button>' : ''}</p>
    <p class="muted small">Orders not placed are flagged ${esc(String(project.settings?.order_lead_days ?? 7))} days before their item starts.${mayEdit ? ' <button type="button" class="btn btn-sm btn-ghost" data-order-lead>Change…</button>' : ''}</p>
    ${spend.length ? `<ul class="pm-mini">${spend.slice(0, 12).map((r) => `<li><a href="${esc(appUrl(`orders/#/requests/${encodeURIComponent(r.number)}`))}">${esc(r.number)}</a> ${esc(r.title)} <span class="muted small">${esc(r.status)} · ${esc(fmtMoney(r.total))} · ${r.items.map((k) => `<a href="${itemHref(k)}">${esc(k)}</a>`).join(', ')}</span></li>`).join('')}</ul>${spend.length > 12 ? `<p class="muted small">and ${spend.length - 12} more.</p>` : ''}`
      : '<p class="muted small">No Orders requests linked yet. Link them on an item, under "Parts &amp; orders".</p>'}
  </section>`;
}

/** The last and next 7 days, in numbers (like Jira's summary cards), shown at the top of "Coming up". */
async function weekNumbers(project) {
  const n = (filter) => pm.search({ project: project.id, filter, limit: 1 }).then((r) => r.total, () => null);
  const [finished, changed, created, due] = await Promise.all([
    n({ f: 'completed', op: 'last', v: 7 }), n({ f: 'updated', op: 'last', v: 7 }), n({ f: 'created', op: 'last', v: 7 }),
    pm.search({ project: project.id, filter: { all: [{ f: 'category', op: 'ne', v: 'done' }, { f: 'due', op: 'within', v: 7 }] }, sort: 'due', limit: 8 }).catch(() => ({ items: [], total: 0 })),
  ]);
  return { finished, changed, created, due };
}

/** The top-level items (epics, or whatever level 0 is called here) and how much of what's under each is done. */
async function topProgress(project, cfg) {
  const top = cfg.types.filter((t) => t.level === 0 && !t.archived_at);
  if (!top.length) return '';
  const parents = (await pm.search({ project: project.id, filter: { f: 'type', op: 'in', v: top.map((t) => t.id) }, sort: 'rank', limit: 30 }).catch(() => ({ items: [] }))).items;
  if (!parents.length) return '';
  const kids = (await pm.search({ project: project.id, filter: { f: 'parent', op: 'in', v: parents.map((p) => p.id) }, limit: 500 }).catch(() => ({ items: [] }))).items;
  const name = top.length === 1 ? top[0].name : 'Top-level item';
  const rows = parents.map((p) => {
    const under = kids.filter((k) => k.parent_id === p.id);
    const done = under.filter((k) => k.category === 'done').length;
    const pct = under.length ? Math.round((done / under.length) * 100) : null;
    return `<tr><td><a href="${itemHref(p.key)}">${esc(p.key)}</a> ${esc(p.title)}</td>
      <td class="pm-bar-cell">${pct === null ? '<span class="muted small">nothing under it yet</span>' : `<progress max="100" value="${pct}" aria-label="${pct}% done"></progress>`}</td>
      <td class="pm-nowrap">${under.length ? `${done}/${under.length} done` : ''}${p.category === 'done' ? ' <span class="chip-tone tone-green">Done</span>' : ''}</td></tr>`;
  });
  return { name, rows: rows.join('') };
}

/** C6: progress by top-level item (epic) and by subsystem in one card, with a switch when there are both. */
let progressTab = 'top';
function progressCard(tops, bySub) {
  const sub = bySub.length > 1 ? bySub.map(([name, s]) => `<tr><td>${esc(name)}</td><td class="pm-bar-cell">${progressBar(s)}</td><td>${s.total - s.done} open${s.overdue ? `, <span class="is-late">${s.overdue} overdue</span>` : ''}</td></tr>`).join('') : '';
  if (!tops && !sub) return '';
  const tab = !tops ? 'sub' : !sub ? 'top' : progressTab;
  const both = tops && sub;
  return `<section class="card"><h2>Progress ${infoTip(`${tops ? `By ${esc(tops.name.toLowerCase())}: how many of the items directly under each one are done. ` : ''}${sub ? 'By subsystem: done, in progress and open items in each subsystem.' : ''}`)}</h2>
    ${both ? `<span role="tablist" class="pm-seg pm-prog-tabs"><button type="button" role="tab" data-prog-tab="top" aria-selected="${tab === 'top'}">By ${esc(tops.name.toLowerCase())}</button><button type="button" role="tab" data-prog-tab="sub" aria-selected="${tab === 'sub'}">By subsystem</button></span>` : ''}
    ${tops ? `<table class="pm-table" data-prog-pane="top" ${tab === 'top' ? '' : 'hidden'}><tbody>${tops.rows}</tbody></table>` : ''}
    ${sub ? `<table class="pm-table" data-prog-pane="sub" ${tab === 'sub' ? '' : 'hidden'}><tbody>${sub}</tbody></table>` : ''}</section>`;
}
