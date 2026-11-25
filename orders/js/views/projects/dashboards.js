/**
 * Projects → Dashboards: a board of widgets (add, remove, reorder, save as mine or share), the team's workload,
 * and a weekly review. Everything here is worked out from what the reader is allowed to see: the roll-up and
 * every list go through the same row-level security as the rest of Projects, so a shared dashboard shows each
 * person only their projects. Progress is shown three ways, and each number says how it was worked out.
 */
import { esc, fmtDate, fmtDateTime, about } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { progressOf, attention, workload, PRIORITIES, relDay } from '../../projects/core.js';
import { schedule, todayISO } from '../../projects/schedule.js';
import { needsDatabase, loadBase, shapesFor, header, itemHref, projectHref, personName, avatar, formDialog, toast, dueChip, statusChip, filterOf } from './kit.js';
import { progressBar } from './projects.js';
import { loadViews, viewsFor, pickView, viewPicker, bindViewPicker } from './saved.js';
import { cycleSwitch, bindCycleSwitch, carFilter, cyclesOf } from './cycles.js';

const WIDGETS = {
  numbers: 'Open, overdue, blocked, unassigned', projects: 'Spaces: progress and who needs help', subsystems: 'Progress by CE division and subsystem', status: 'Items by status',
  priority: 'Open items by priority', milestones: 'Upcoming milestones', overdue: 'Overdue items', blocked: 'Blocked items and cross-subsystem blockers', schedule: 'Schedule slippage and critical path',
  workload: 'Workload by member', trend: 'Finished per week', risks: 'Open risks', activity: 'Recent activity', filter: 'Results of a saved list view',
};
const DEFAULT = ['numbers', 'projects', 'subsystems', 'milestones', 'overdue', 'blocked', 'schedule', 'trend', 'workload', 'activity'].map((type) => ({ type }));
const st = { tab: 'board', view: undefined, config: { scope: {}, widgets: DEFAULT }, dirty: false, edit: false, days: 7 };

export async function renderDashboards(el, { config, params, rerender }) {
  const missing = needsDatabase(config);
  if (missing) return void (el.innerHTML = missing);
  const tab = ['workload', 'review'].includes(params.id) ? params.id : 'board';
  const b = await loadBase();
  const views = viewsFor(await loadViews(), 'dashboard', null);
  if (st.view === undefined) applyView(pickView(views, null, b.me));
  const current = views.find((v) => v.id === st.view) || null;
  const sc = st.config.scope || {};

  // what's in scope: space and CE division; the work by car cycle (a dashboard's own, else the switcher at the top; 074)
  const projects = b.projects.filter((p) => !p.archived_at && (!sc.project || p.id === sc.project));
  const cars = sc.program ? { f: 'program', op: 'in', v: [sc.program] } : carFilter(b);
  const projectIds = projects.map((p) => p.id);
  const inScope = (x) => projectIds.includes(x.project_id) && (!sc.division || x.division_id === sc.division);
  const scopeFilter = { all: [{ f: 'project', op: 'in', v: projectIds.length ? projectIds : ['00000000-0000-0000-0000-000000000000'] }, ...(sc.division ? [{ f: 'division', v: sc.division }] : []), ...(cars ? [cars] : [])] };
  const [rollup, open, shapes, prefs] = await Promise.all([pm.rollup(), pm.searchAll({ filter: { all: [scopeFilter, { f: 'category', op: 'ne', v: 'done' }] }, sort: 'due' }, 3000), shapesFor(b, projectIds), pm.prefs().catch(() => [])]);
  const groups = rollup.groups.filter(inScope);
  const items = open.items;
  const today = todayISO();
  const isMs = (i) => !!shapes.cfgOf(i)?.typeById.get(i.type_id)?.is_milestone;
  const li = (i, extra = '') => `<li><a href="${itemHref(i.key)}">${esc(i.key)} · ${esc(i.title)}</a> ${dueChip(i)} ${avatar(b, i.owner_id)} ${extra}</li>`;
  const none = (text) => `<p class="muted">${esc(text)}</p>`;
  const scopeBar = `<div class="pm-filters"><select data-scope="program" aria-label="Car cycle"><option value="">${cyclesOf(b).length > 1 ? 'The car chosen above' : 'Every car cycle'}</option>${cyclesOf(b).map((g) => `<option value="${esc(g.id)}" ${sc.program === g.id ? 'selected' : ''}>${esc(g.name)}${g.vehicle ? ` (${esc(g.vehicle)})` : ''}</option>`).join('')}</select>
    <select data-scope="project" aria-label="Project"><option value="">Every space</option>${b.projects.filter((p) => !p.archived_at).map((p) => `<option value="${esc(p.id)}" ${sc.project === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    <select data-scope="division" aria-label="CE division"><option value="">Every CE division</option>${b.divisions.filter((d) => !d.archived_at).map((d) => `<option value="${esc(d.id)}" ${sc.division === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div>`;
  const tabs = `<nav class="pm-tabs" aria-label="Dashboards">${[['', 'Dashboard'], ['workload', 'Workload'], ['review', 'Weekly review']].map(([k, l]) => `<a href="#/projects/dashboards${k ? `/${k}` : ''}" ${(k || 'board') === tab ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>`;
  const bindScope = () => (bindCycleSwitch(el, b, rerender), el.querySelectorAll('[data-scope]')).forEach((n) => (n.onchange = () => ((st.config = { ...st.config, scope: { ...sc, [n.dataset.scope]: n.value || undefined } }), (st.dirty = true), rerender())));

  if (tab === 'workload') {
    const w = workload(items, b.people.filter((p) => items.some((i) => i.owner_id === p.id)), prefs);
    const cell = (r, wk) => {
      const h = r.byWeek[wk];
      return `<td class="${r.hours !== null && h > r.hours ? 'is-over' : ''}" title="${r.hours !== null ? `${h} h planned, ${r.hours} h available` : ''}">${h ? `${Math.round(h * 10) / 10} h` : ''}</td>`;
    };
    const bySub = new Map();
    for (const i of items) bySub.set(i.subsystem_id || i.division_id || '', (bySub.get(i.subsystem_id || i.division_id || '') || 0) + (Number(i.estimate_hours) || 0));
    const most = Math.max(1, ...bySub.values());
    el.innerHTML = `${header('Dashboards', 'How the work is spread across people. Nobody has to track time: this uses the estimates on open items and their due dates.')}${cycleSwitch(b)}${tabs}${scopeBar}
      <section class="card"><h2>Open work by person and week due</h2>
        <div class="table-wrap"><table class="pm-table pm-load"><thead><tr><th>Person</th><th>Items</th><th>Overdue</th>${w.weeks.map((x) => `<th>Week of ${esc(fmtDate(x))}</th>`).join('')}<th>No date</th><th>Total</th><th>Has (h/week)</th></tr></thead><tbody>
          ${w.rows.filter((r) => r.items).map((r) => `<tr class="${r.id ? '' : 'pm-unassigned'}"><td>${r.id ? `${avatar(b, r.id)} ${esc(personName(b, r.id))}` : '<strong>No owner</strong>'}</td><td><a href="#/projects/list">${r.items}</a>${r.unestimated ? ` <span class="muted small">(${r.unestimated} not estimated)</span>` : ''}</td>
            <td class="${r.late ? 'is-late' : ''}">${r.late ? `${r.late} h` : ''}</td>${w.weeks.map((wk) => cell(r, wk)).join('')}<td>${r.undated ? `${r.undated} h` : ''}</td><td><strong>${Math.round(r.total * 10) / 10} h</strong></td><td>${r.hours ?? '<span class="muted">—</span>'}</td></tr>`).join('')
            || '<tr><td colspan="12" class="muted">No open items in scope.</td></tr>'}</tbody></table></div>
        <p class="hint">A red week means more estimated hours are due that week than the person says they have.</p>
        ${about('<p>Each person sets their hours a week in Inbox → "What I get notified about". Items without an estimate count as 0 hours and are listed as "not estimated".</p>', 'How this works', 'projects-workload')}</section>
      <section class="card"><h2>Estimated open work by subsystem</h2>${bySub.size ? `<ul class="pm-hbars">${[...bySub].sort((x, y) => y[1] - x[1]).map(([id, h]) => `<li><span>${esc(b.subsystemById.get(id)?.name || b.divisionById.get(id)?.name || 'No subsystem')}</span>
        <span class="pm-hbar" style="--w:${Math.round((h / most) * 100)}%"></span><span>${Math.round(h)} h</span></li>`).join('')}</ul>` : none('Nothing open.')}</section>`;
    return bindScope();
  }

  if (tab === 'review') {
    const since = new Date(Date.now() - st.days * 864e5).toISOString();
    const [doneMs, events, deps, approvals] = await Promise.all([
      pm.searchAll({ filter: { all: [scopeFilter, { f: 'category', v: 'done' }, { f: 'completed', op: 'last', v: st.days }] }, sort: 'updated', dir: 'desc' }, 500),
      projectIds.length ? pm.events({ projectIds, since, kinds: ['updated'], limit: 500 }) : [], pm.deps(projectIds), pm.approvals(),
    ]);
    const byId = new Map(items.map((i) => [i.id, i]));
    const soon = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    const newlyBlocked = [...new Set(events.filter((e) => e.data?.changes?.blocked?.[1] === true).map((e) => e.item_id))].map((id) => byId.get(id)).filter((i) => i?.blocked);
    const moved = events.filter((e) => e.data?.changes?.due_date && byId.has(e.item_id)).map((e) => ({ item: byId.get(e.item_id), from: e.data.changes.due_date[0], to: e.data.changes.due_date[1], who: e.actor_name }));
    const cross = deps.filter((d) => byId.has(d.to_item) && byId.has(d.from_item) && (byId.get(d.from_item).subsystem_id || byId.get(d.from_item).project_id) !== (byId.get(d.to_item).subsystem_id || byId.get(d.to_item).project_id));
    const waiting = approvals.filter((a) => byId.has(a.item_id));
    const sub = (i) => b.subsystemById.get(i.subsystem_id)?.name || b.projectById.get(i.project_id)?.name || '';
    const parts = [
      ['Milestones reached', doneMs.items.filter(isMs).map((i) => li(i, `<span class="muted small">finished ${esc(fmtDate(i.completed_at))}</span>`)), 'No milestone was reached.'],
      ['Finished', doneMs.items.filter((i) => !isMs(i)).slice(0, 30).map((i) => li(i)), 'Nothing was finished.'],
      ['Coming up in the next two weeks', items.filter((i) => i.due_date && i.due_date >= today && i.due_date <= soon).map((i) => li(i, isMs(i) ? '<span class="chip">Milestone</span>' : '')), 'No deadlines in the next two weeks.'],
      ['Overdue', items.filter((i) => i.due_date && i.due_date < today).map((i) => li(i)), 'Nothing is overdue.'],
      ['Newly blocked', newlyBlocked.map((i) => li(i, `<span class="is-late">${esc(i.blocked_reason || 'no reason given')}</span>`)), 'Nothing became blocked.'],
      ['Dates that moved', moved.slice(0, 30).map((m) => li(m.item, `<span class="muted small">${esc(m.from ? fmtDate(m.from) : 'no date')} → ${esc(m.to ? fmtDate(m.to) : 'no date')} by ${esc(m.who)}</span>`)), 'No due dates changed.'],
      ['Waiting on another subsystem', cross.map((d) => `<li><a href="${itemHref(byId.get(d.to_item).key)}">${esc(byId.get(d.to_item).key)}</a> <span class="muted">(${esc(sub(byId.get(d.to_item)))})</span> waits on
        <a href="${itemHref(byId.get(d.from_item).key)}">${esc(byId.get(d.from_item).key)} · ${esc(byId.get(d.from_item).title)}</a> <span class="muted">(${esc(sub(byId.get(d.from_item)))})</span> ${dueChip(byId.get(d.from_item))}</li>`), 'No open dependencies between subsystems.'],
      ['Decisions needed', [...waiting.map((a) => li(byId.get(a.item_id), `<span class="chip-tone tone-amber">Waiting for approval since ${esc(relDay(a.requested_at))}</span>`)),
        ...items.filter((i) => (i.labels || []).includes('decision')).map((i) => li(i, '<span class="chip">decision</span>'))], 'Nothing is waiting on an approval, and nothing is labeled "decision".'],
    ];
    el.innerHTML = `${header('Dashboards', 'A summary to walk through at the weekly program review.', '<button type="button" class="btn" data-copy>Copy as text</button>')}${cycleSwitch(b)}${tabs}${scopeBar}
      <div class="pm-filters"><label class="inline-field">Looking back <select data-days>${[7, 14, 30].map((n) => `<option value="${n}" ${st.days === n ? 'selected' : ''}>${n} days</option>`).join('')}</select></label></div>
      <div class="pm-review">${parts.map(([title, rows, empty]) => `<section class="card"><h2>${esc(title)} <span class="muted">${rows.length}</span></h2>${rows.length ? `<ul class="pm-mini">${rows.join('')}</ul>` : none(empty)}</section>`).join('')}</div>
      <p class="hint">Label an item <code>decision</code> to bring it to this list. Only spaces you can see are included.</p>`;
    bindScope();
    el.querySelector('[data-days]').onchange = (e) => ((st.days = Number(e.target.value)), rerender());
    el.querySelector('[data-copy]').onclick = () => {
      const text = [...el.querySelectorAll('.pm-review section')].map((s) => `${s.querySelector('h2').textContent.trim()}\n${[...s.querySelectorAll('li')].map((x) => `- ${x.textContent.replace(/\s+/g, ' ').trim()}`).join('\n') || `  ${s.querySelector('p')?.textContent || ''}`}`).join('\n\n');
      navigator.clipboard.writeText(text).then(() => toast('Copied.'), () => toast('Couldn\'t copy.', 'bad'));
    };
    return;
  }

  // ---- the widget board ----
  const total = progressOf(groups);
  const widgets = st.config.widgets?.length ? st.config.widgets : DEFAULT;
  const need = (t) => widgets.some((w) => w.type === t);
  const [events, deps, allItems, allViews] = await Promise.all([
    need('activity') && projectIds.length ? pm.events({ projectIds, limit: 15 }) : [], need('blocked') || need('schedule') ? pm.deps(projectIds) : [],
    need('schedule') ? pm.searchAll({ filter: scopeFilter, sort: 'rank' }, 3000).then((r) => r.items) : [], need('filter') ? loadViews() : [],
  ]);
  const evItems = new Map((await pm.itemsByIds([...new Set(events.map((e) => e.item_id).filter(Boolean))])).map((i) => [i.id, i]));
  const byId = new Map(items.map((i) => [i.id, i]));
  const filterResults = new Map();
  for (const w of widgets.filter((x) => x.type === 'filter' && x.view_id)) {
    const v = allViews.find((x) => x.id === w.view_id);
    if (v) filterResults.set(w.view_id, await pm.search({ project: v.project_id, limit: 10, sort: v.config.sort, dir: v.config.dir, q: v.config.filter_state?.q,
      filter: filterOf(v.config.filter_state || {}) }).then((r) => ({ view: v, ...r }), () => null));
  }
  const body = (w) => {
    switch (w.type) {
      case 'numbers': return `<div class="pm-nums pm-big"><span><strong>${total.total - total.done}</strong> open</span><span><strong>${total.doing}</strong> in progress</span>
        <span class="${total.overdue ? 'is-late' : ''}"><strong>${total.overdue}</strong> overdue</span><span class="${total.blocked ? 'is-late' : ''}"><strong>${total.blocked}</strong> blocked</span><span><strong>${total.unassigned}</strong> without an owner</span>
        <span><strong>${total.done}</strong> done</span></div>${progressBar(total)}
        <div class="pm-metrics">${[['by items', total.byCount], ['by effort', total.byEffort], ['by milestones', total.byMilestones]].map(([l, m]) => `<div class="pm-metric" title="${esc(m.how)}"><strong>${m.value === null ? '—' : `${m.value}%`}</strong><span>${l}</span><small>${esc(m.how)}</small></div>`).join('')}</div>`;
      case 'projects': return projects.length ? `<div class="table-wrap"><table class="pm-table"><thead><tr><th>Space</th><th>Progress</th><th title="Items finished ÷ all items">Items</th><th title="Estimated hours finished ÷ all estimated hours">Effort</th><th title="Milestones reached ÷ all milestones">Milestones</th><th>Next milestone</th><th>Needs attention</th></tr></thead><tbody>${projects.map((p) => {
        const pr = progressOf(groups.filter((g) => g.project_id === p.id));
        const why = attention(pr);
        const pct = (m) => (m.value === null ? '<span class="muted">—</span>' : `${m.value}%`);
        return `<tr><td><a href="${projectHref(p.key)}"><strong>${esc(p.name)}</strong></a></td><td class="pm-bar-cell">${progressBar(pr)}</td><td>${pct(pr.byCount)}</td><td>${pct(pr.byEffort)}</td><td>${pct(pr.byMilestones)}</td>
          <td>${pr.nextMs ? `<span class="${pr.nextMs < today ? 'is-late' : ''}">${esc(fmtDate(pr.nextMs))}</span>` : '<span class="muted">—</span>'}</td><td>${why.length ? `<span class="is-late">⚠ ${esc(why.join('; '))}</span>` : '<span class="muted">No</span>'}</td></tr>`;
      }).join('')}</tbody></table></div>` : none('No spaces in scope.');
      case 'subsystems': {
        const keys = [...new Set(groups.map((g) => `${g.division_id || ''}|${g.subsystem_id || ''}`))];
        return keys.length ? `<div class="table-wrap"><table class="pm-table"><thead><tr><th>CE division</th><th>Subsystem</th><th>Progress</th><th>Open</th><th>Overdue</th><th>Blocked</th></tr></thead><tbody>${keys.sort().map((k) => {
          const [d, s] = k.split('|');
          const pr = progressOf(groups.filter((g) => (g.division_id || '') === d && (g.subsystem_id || '') === s));
          return `<tr><td>${esc(b.divisionById.get(d)?.name || '—')}</td><td>${esc(b.subsystemById.get(s)?.name || (d ? 'Whole division' : 'Not set'))}</td><td class="pm-bar-cell">${progressBar(pr)}</td><td>${pr.total - pr.done}</td>
            <td class="${pr.overdue ? 'is-late' : ''}">${pr.overdue}</td><td class="${pr.blocked ? 'is-late' : ''}">${pr.blocked}</td></tr>`;
        }).join('')}</tbody></table></div>` : none('No items in scope.');
      }
      case 'status': {
        const counts = new Map();
        for (const i of items) counts.set(shapes.cfgOf(i)?.statusById.get(i.status_id)?.name || '?', (counts.get(shapes.cfgOf(i)?.statusById.get(i.status_id)?.name || '?') || 0) + 1);
        const most = Math.max(1, ...counts.values());
        return counts.size ? `<ul class="pm-hbars">${[...counts].sort((x, y) => y[1] - x[1]).map(([n, c]) => `<li><span>${esc(n)}</span><span class="pm-hbar" style="--w:${Math.round((c / most) * 100)}%"></span><span>${c}</span></li>`).join('')}
          <li><span>Done</span><span class="pm-hbar is-done" style="--w:${Math.round((total.done / Math.max(most, total.done, 1)) * 100)}%"></span><span>${total.done}</span></li></ul>` : none('No open items.');
      }
      case 'priority': {
        const most = Math.max(1, ...PRIORITIES.map(([k]) => items.filter((i) => i.priority === k).length));
        return `<ul class="pm-hbars">${PRIORITIES.map(([k, l]) => `<li><span>${l}</span><span class="pm-hbar" style="--w:${Math.round((items.filter((i) => i.priority === k).length / most) * 100)}%"></span><span>${items.filter((i) => i.priority === k).length}</span></li>`).join('')}</ul>`;
      }
      case 'milestones': {
        const ms = items.filter(isMs).sort((x, y) => (x.due_date || '9') < (y.due_date || '9') ? -1 : 1).slice(0, 12);
        return ms.length ? `<ul class="pm-mini">${ms.map((i) => li(i, `<span class="muted small">${esc(b.projectById.get(i.project_id)?.name || '')}</span>`)).join('')}</ul>` : none('No open milestones.');
      }
      case 'overdue': {
        const late = items.filter((i) => i.due_date && i.due_date < today);
        return late.length ? `<ul class="pm-mini">${late.slice(0, 12).map((i) => li(i)).join('')}</ul>${late.length > 12 ? `<p class="muted small">and ${late.length - 12} more</p>` : ''}` : none('Nothing is overdue.');
      }
      case 'blocked': {
        const blocked = items.filter((i) => i.blocked);
        const cross = deps.filter((d) => byId.has(d.to_item) && byId.has(d.from_item) && (byId.get(d.from_item).subsystem_id || byId.get(d.from_item).project_id) !== (byId.get(d.to_item).subsystem_id || byId.get(d.to_item).project_id));
        return `${blocked.length ? `<ul class="pm-mini">${blocked.slice(0, 8).map((i) => li(i, `<span class="is-late">${esc(i.blocked_reason || '')}</span>`)).join('')}</ul>` : none('Nothing is marked blocked.')}
          <h3>Waiting on another subsystem or space</h3>${cross.length ? `<ul class="pm-mini">${cross.slice(0, 8).map((d) => `<li><a href="${itemHref(byId.get(d.to_item).key)}">${esc(byId.get(d.to_item).key)}</a> waits on <a href="${itemHref(byId.get(d.from_item).key)}">${esc(byId.get(d.from_item).key)} · ${esc(byId.get(d.from_item).title)}</a>
            <span class="muted small">${esc(b.subsystemById.get(byId.get(d.from_item).subsystem_id)?.name || b.projectById.get(byId.get(d.from_item).project_id)?.name || '')}</span> ${dueChip(byId.get(d.from_item))}</li>`).join('')}</ul>` : none('None.')}`;
      }
      case 'schedule': {
        const rows = projects.map((p) => {
          const its = allItems.filter((i) => i.project_id === p.id).map((i) => ({ ...i, is_milestone: isMs(i) }));
          const plan = schedule(its, deps, p.settings, { today });
          const late = plan.warnings.filter((x) => x.kind === 'late');
          const worst = late.sort((x, y) => y.days - x.days)[0];
          return { p, plan, late, worst, its };
        }).filter((r) => r.its.length);
        return rows.length ? `<div class="table-wrap"><table class="pm-table"><thead><tr><th>Space</th><th>Forecast finish</th><th>Forecast to finish late</th><th>Worst slip</th><th>Critical path</th></tr></thead><tbody>${rows.map((r) => `<tr>
          <td><a href="${projectHref(r.p.key, 'timeline')}">${esc(r.p.name)}</a></td><td>${esc(fmtDate(r.plan.finish))}</td><td class="${r.late.length ? 'is-late' : ''}">${r.late.length} item${r.late.length === 1 ? '' : 's'}</td>
          <td>${r.worst ? `<a href="${itemHref(r.its.find((i) => i.id === r.worst.id).key)}">${esc(r.its.find((i) => i.id === r.worst.id).key)}</a> ${r.worst.days} working day${r.worst.days === 1 ? '' : 's'}` : '<span class="muted">—</span>'}</td>
          <td>${r.plan.critical.length ? r.plan.critical.slice(0, 5).map((id) => `<a href="${itemHref(r.its.find((i) => i.id === id).key)}">${esc(r.its.find((i) => i.id === id).key)}</a>`).join(' → ') + (r.plan.critical.length > 5 ? ' …' : '') : '<span class="muted">No chain yet</span>'}</td></tr>`).join('')}</tbody></table></div>
          <p class="hint">Forecast from dependencies, working days and actual progress; target dates aren't changed by it.</p>` : none('No items in scope.');
      }
      case 'workload': {
        const w2 = workload(items, [], prefs, { weeks: 2 });
        const most = Math.max(1, ...w2.rows.map((r) => r.total));
        return w2.rows.length ? `<ul class="pm-hbars">${w2.rows.slice(0, 12).map((r) => `<li><span>${r.id ? esc(personName(b, r.id)) : '<strong>No owner</strong>'}</span><span class="pm-hbar${r.hours !== null && r.byWeek[w2.weeks[0]] > r.hours ? ' is-over' : ''}" style="--w:${Math.round((r.total / most) * 100)}%"></span>
          <span>${Math.round(r.total)} h · ${r.items}</span></li>`).join('')}</ul><p class="hint">Estimated hours of open work and number of items. <a href="#/projects/dashboards/workload">By week</a></p>` : none('No open items.');
      }
      case 'trend': {
        const weeks = new Map();
        for (const t of rollup.trend.filter((x) => projectIds.includes(x.project_id))) weeks.set(t.week, (weeks.get(t.week) || 0) + Number(t.done));
        const most = Math.max(1, ...weeks.values());
        return weeks.size ? `<div class="pm-vbars">${[...weeks].sort().map(([wk, n]) => `<div title="Week of ${esc(fmtDate(wk))}: ${n} finished"><span style="height:${Math.round((n / most) * 100)}%"></span><small>${esc(fmtDate(wk).replace(/,? \d{4}$/, ''))}</small><b>${n}</b></div>`).join('')}</div>
          <p class="hint">Items finished each week over the last 12 weeks${sc.division ? ' (all divisions of the spaces in scope)' : ''}.</p>` : none('Nothing finished in the last 12 weeks.');
      }
      case 'risks': {
        const risks = items.filter((i) => /risk/i.test(shapes.cfgOf(i)?.typeById.get(i.type_id)?.name || ''));
        return risks.length ? `<ul class="pm-mini">${risks.slice(0, 12).map((i) => li(i, statusChip(shapes.cfgOf(i)?.statusById.get(i.status_id)))).join('')}</ul>` : none('No open items of a "Risk" type. Add a work type called Risk to a space to track them here.');
      }
      case 'activity': return events.length ? `<ul class="pm-activity">${events.map((e) => `<li><span class="muted small">${esc(fmtDateTime(e.created_at))}</span> <strong>${esc(e.actor_name)}</strong> ${esc(e.summary)}
        ${evItems.get(e.item_id) ? `<a href="${itemHref(evItems.get(e.item_id).key)}">${esc(evItems.get(e.item_id).key)}</a>` : ''}</li>`).join('')}</ul>` : none('Nothing yet.');
      case 'filter': {
        const r = filterResults.get(w.view_id);
        return r ? `<p class="muted small">${r.total} item${r.total === 1 ? '' : 's'} in "${esc(r.view.name)}"</p><ul class="pm-mini">${r.items.map((i) => li(i)).join('')}</ul>` : none('Pick a saved list view for this widget ("Edit widgets").');
      }
      default: return '';
    }
  };
  const wide = new Set(['numbers', 'projects', 'subsystems', 'schedule']);
  el.innerHTML = `${header('Dashboards', 'Progress across the spaces you can see. Hover a number to see how it was worked out.')}${cycleSwitch(b)}${tabs}
    <div class="pm-toolbar">${viewPicker(b, views, current, { noun: 'dashboard', dirty: st.dirty })}<div class="card-actions"><button type="button" class="btn btn-sm${st.edit ? ' is-on' : ''}" data-edit-widgets>${st.edit ? 'Done editing' : 'Edit widgets'}</button></div></div>
    ${scopeBar}
    <div class="pm-dash">${widgets.map((w, n) => `<section class="card pm-widget${wide.has(w.type) ? ' pm-wide' : ''}" data-widget="${n}"><div class="pm-widget-head"><h2>${esc(w.title || WIDGETS[w.type] || w.type)}</h2>
      ${st.edit ? `<span><button type="button" class="btn btn-sm btn-ghost" data-w-up ${n ? '' : 'disabled'} aria-label="Move earlier">↑</button><button type="button" class="btn btn-sm btn-ghost" data-w-down ${n < widgets.length - 1 ? '' : 'disabled'} aria-label="Move later">↓</button>
        <button type="button" class="btn btn-sm btn-ghost" data-w-edit>Rename</button><button type="button" class="btn btn-sm btn-ghost" data-w-del>Remove</button></span>` : ''}</div>${body(w)}</section>`).join('')}</div>
    ${st.edit ? `<div class="pm-filters"><select data-add-widget aria-label="Add a widget"><option value="">+ Add a widget…</option>${Object.entries(WIDGETS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
      <span class="muted small">Then "Save" or "Save as…" to keep this dashboard, for yourself or shared with the team.</span></div>` : ''}`;
  bindScope();
  const set = (list) => ((st.config = { ...st.config, widgets: list }), (st.dirty = true), rerender());
  bindViewPicker(el, { b, kind: 'dashboard', views, current, noun: 'dashboard', getConfig: () => ({ scope: sc, widgets }), onPick: (v, id) => (applyView(v, id), rerender()) });
  el.querySelector('[data-edit-widgets]').onclick = () => ((st.edit = !st.edit), rerender());
  el.querySelector('[data-add-widget]')?.addEventListener('change', async (e) => {
    const type = e.target.value;
    if (!type) return;
    if (type !== 'filter') return set([...widgets, { type }]);
    const lists = (await loadViews()).filter((v) => v.kind === 'list');
    if (!lists.length) return toast('Save a list view first (a space\'s List → "Save as…"), then add it here.', 'bad');
    const pick = await formDialog({ title: 'Which saved list?', submit: 'Add', body: `<div class="field"><label for="wf-view">Saved list view</label><select id="wf-view" name="view">${lists.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select></div>`,
      onSubmit: (f) => ({ id: f.elements.view.value, name: f.elements.view.selectedOptions[0].textContent }) });
    if (pick) set([...widgets, { type, view_id: pick.id, title: pick.name }]);
  });
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    const n = Number(t?.closest('[data-widget]')?.dataset.widget);
    if (!t || Number.isNaN(n)) return;
    const list = [...widgets];
    if (t.dataset.wDel !== undefined) list.splice(n, 1);
    else if (t.dataset.wUp !== undefined) list.splice(n - 1, 0, list.splice(n, 1)[0]);
    else if (t.dataset.wDown !== undefined) list.splice(n + 1, 0, list.splice(n, 1)[0]);
    else if (t.dataset.wEdit !== undefined) {
      const title = await formDialog({ title: 'Widget title', submit: 'OK', body: `<div class="field"><label for="wt">Title</label><input id="wt" name="t" type="text" maxlength="80" value="${esc(list[n].title || WIDGETS[list[n].type])}"></div>`, onSubmit: (f) => f.elements.t.value.trim() || ' ' });
      if (!title) return;
      list[n] = { ...list[n], title: title.trim() || undefined };
    } else return;
    set(list);
  });
}

function applyView(v, id = null) {
  st.view = v?.id || id || 'none';
  st.dirty = false;
  st.config = v ? { scope: v.config.scope || {}, widgets: v.config.widgets?.length ? v.config.widgets : DEFAULT } : { scope: {}, widgets: DEFAULT };
}
