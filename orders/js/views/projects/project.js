/**
 * Projects: one project's pages (Summary, List, Board, Backlog, Timeline, Calendar, Documents, Settings) and the
 * same List / Board / Timeline / Calendar across every project I can see. Each page gets a "scope":
 *   { b, project, cfg, cfgOf(item), statuses, types, fields, projectIds, rerender, params, base }
 * so one view works for one project or for all of them.
 */
import { esc, fmtDateTime, takeFlash } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { progressOf, attention } from '../../projects/core.js';
import { needsDatabase, loadBase, loadConfig, shapesFor, header, projectTop, projectHref, itemHref, personName, avatar, can, rich, createItemDialog, statusChip, dueChip } from './kit.js';
import { progressBar } from './projects.js';
import { renderList } from './list.js';
import { renderBoard } from './board.js';

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
  const projectIds = b.projects.filter((p) => !p.archived_at).map((p) => p.id);
  const shapes = await shapesFor(b, projectIds);
  const scope = { b, project: null, cfg: null, cfgOf: shapes.cfgOf, statuses: shapes.all.statuses, types: shapes.all.types, fields: [], projectIds,
    rerender: ctx.rerender, params: ctx.params, base: `#/projects/${which}` };
  const titles = { boards: ['Boards', 'Boards across projects: columns hold every status with the same name.'], timeline: ['Timeline', 'Every project on one timeline, with the dependencies between them.'],
    calendar: ['Calendar', 'Deadlines, milestones and project events.'], list: ['All work', 'Search every item you can see.'] };
  el.innerHTML = `${takeFlash()}${header(titles[which][0], titles[which][1])}<div data-body></div>`;
  const body = el.querySelector('[data-body]');
  if (!projectIds.length) return void (body.innerHTML = '<div class="empty"><p><strong>No projects yet.</strong></p><p><a class="btn btn-primary" href="#/projects/all">Projects</a></p></div>');
  if (which === 'list') return renderList(body, scope);
  if (which === 'boards') return renderBoard(body, scope);
  return (await lazy[which]())(body, scope);
}

/** A project's front page: how it's doing (three ways, each explained), what's coming, who's in it, what just happened. */
async function summary(el, { b, project, cfg }) {
  const [rollup, upcoming, events, docs] = await Promise.all([
    pm.rollup(), pm.search({ project: project.id, filter: { all: [{ f: 'category', op: 'ne', v: 'done' }, { any: [{ f: 'milestone' }, { f: 'due', op: 'within', v: 14 }, { f: 'overdue' }] }] }, sort: 'due', limit: 12 }),
    pm.events({ projectIds: [project.id], limit: 15 }), pm.resources(project.id).catch(() => []),
  ]);
  const keyOf = new Map((await pm.itemsByIds([...new Set(events.map((e) => e.item_id).filter(Boolean))])).map((i) => [i.id, i.key]));
  const groups = rollup.groups.filter((g) => g.project_id === project.id);
  const p = progressOf(groups);
  const why = attention(p);
  const metric = (label, m) => `<div class="pm-metric" title="${esc(m.how)}"><strong>${m.value === null ? '—' : `${m.value}%`}</strong><span>${esc(label)}</span><small>${esc(m.how)}</small></div>`;
  const bySub = [...new Map(groups.map((g) => [g.subsystem_id || g.division_id || '', null])).keys()].map((id) => {
    const rows = groups.filter((g) => (g.subsystem_id || g.division_id || '') === id);
    return [b.subsystemById.get(id)?.name || b.divisionById.get(id)?.name || 'No subsystem', progressOf(rows)];
  });
  const roleName = (m) => cfg.roles.find((r) => r.id === m.role_id)?.name || '';
  el.innerHTML = `<div class="pm-summary">
    <section class="card"><h2>How it's going</h2>
      ${why.length ? `<div class="alert alert-info pm-attention-box">⚠ May need someone to step in: ${esc(why.join('; '))}.</div>` : ''}
      ${progressBar(p)}
      <div class="pm-nums"><a href="${projectHref(project.key, 'list')}"><strong>${p.total - p.done}</strong> open</a><span><strong>${p.doing}</strong> in progress</span><span><strong>${p.done}</strong> done</span>
        <span class="${p.overdue ? 'is-late' : ''}"><strong>${p.overdue}</strong> overdue</span><span class="${p.blocked ? 'is-late' : ''}"><strong>${p.blocked}</strong> blocked</span><span><strong>${p.unassigned}</strong> without an owner</span></div>
      <div class="pm-metrics">${metric('by items', p.byCount)}${metric('by effort', p.byEffort)}${metric('by milestones', p.byMilestones)}</div>
      <p class="hint">Three ways of measuring the same project. They rarely agree: finishing many small items moves the first, finishing the big ones moves the second, and only reaching milestones moves the third.</p>
    </section>
    <section class="card"><h2>Coming up</h2>
      ${upcoming.items.length ? `<ul class="pm-mini">${upcoming.items.map((i) => `<li><a href="${itemHref(i.key)}">${esc(i.title)}</a> ${statusChip(cfg.statusById.get(i.status_id))} ${dueChip(i)} ${avatar(b, i.owner_id)}</li>`).join('')}</ul>`
        : '<p class="muted">No milestones or deadlines in the next two weeks, and nothing overdue.</p>'}
      <p><a href="${projectHref(project.key, 'timeline')}">Timeline</a> · <a href="${projectHref(project.key, 'calendar')}">Calendar</a></p>
    </section>
    ${project.description ? `<section class="card"><h2>About</h2><div class="pm-rich">${rich(project.description)}</div></section>` : ''}
    ${bySub.length > 1 ? `<section class="card"><h2>By subsystem</h2><table class="pm-table"><tbody>${bySub.map(([name, s]) => `<tr><td>${esc(name)}</td><td class="pm-bar-cell">${progressBar(s)}</td><td>${s.total - s.done} open${s.overdue ? `, <span class="is-late">${s.overdue} overdue</span>` : ''}</td></tr>`).join('')}</tbody></table></section>` : ''}
    <section class="card"><h2>People</h2>
      <p class="muted small">${project.lead_id ? `Project manager: ${esc(personName(b, project.lead_id))}. ` : ''}${project.visibility === 'team'
        ? `Everyone on the team can see this project${project.team_role_id ? ` as ${esc(cfg.roles.find((r) => r.id === project.team_role_id)?.name || 'a viewer')}` : ''}.` : 'Only these people can see this project.'}</p>
      <ul class="pm-mini">${cfg.members.map((m) => `<li>${avatar(b, m.user_id)} ${esc(personName(b, m.user_id))} <span class="muted">${esc(roleName(m))}</span></li>`).join('')}</ul>
      ${can(b, project.id, 'members') ? `<p><a href="${projectHref(project.key, 'settings/people')}">Add people or change roles</a></p>` : ''}
    </section>
    <section class="card"><h2>Documents</h2>
      <p>${docs.length ? `${docs.length} linked document${docs.length === 1 ? '' : 's'}.` : 'No documents linked yet.'} <a href="${projectHref(project.key, 'docs')}">Open the document library</a></p></section>
    <section class="card pm-wide"><h2>Latest</h2>
      ${events.length ? `<ul class="pm-activity">${events.map((e) => `<li><span class="muted small">${esc(fmtDateTime(e.created_at))}</span> <strong>${esc(e.actor_name || 'one.solar')}</strong> ${esc(e.summary)}${keyOf.get(e.item_id) && !e.summary.includes(keyOf.get(e.item_id)) ? ` <a href="${itemHref(keyOf.get(e.item_id))}">${esc(keyOf.get(e.item_id))}</a>` : ''}</li>`).join('')}</ul>` : '<p class="muted">Nothing has happened yet.</p>'}
    </section></div>`;
}
