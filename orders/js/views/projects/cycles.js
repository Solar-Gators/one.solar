/**
 * Workbench → car cycles (063, 074). A car cycle is a program with dates; one of them is the current car. Spaces
 * last across cars; each item has its car (074). The switcher at the top of a Space, the team timeline, Boards,
 * Calendar, All work and Dashboards shows the work of this car, another car, both (this and the next), or
 * everything. Items with no car count as the current car's. The choice is remembered in this browser.
 */
import { esc, fmtDate } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { formDialog, invalidate } from './kit.js';

const KEY = 'pm.cycle';
const read = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
const write = (v) => { try { localStorage.setItem(KEY, v); } catch { /* not kept: fine */ } };

/** Car cycles that aren't archived, oldest first (by start date, then the order they were set in). */
export const cyclesOf = (b) => b.programs.filter((g) => !g.archived_at)
  .sort((a, z) => ((a.start_date || '9999') < (z.start_date || '9999') ? -1 : (a.start_date || '9999') > (z.start_date || '9999') ? 1 : (a.sort - z.sort) || a.name.localeCompare(z.name)));
export const currentCycle = (b) => cyclesOf(b).find((g) => g.is_current) || cyclesOf(b)[0] || null;
/** The car after the current one. */
export const nextCycle = (b) => {
  const all = cyclesOf(b);
  const at = all.indexOf(currentCycle(b));
  return at >= 0 ? all[at + 1] || null : null;
};

/** What's chosen: 'now' (the current car), 'both', 'all' or a car cycle's id. */
export function cycleChoice(b) {
  const v = read();
  if (v === 'both' && nextCycle(b)) return 'both';
  if (v === 'all') return 'all';
  if (v && cyclesOf(b).some((g) => g.id === v)) return v;
  return 'now';
}
export const setCycleChoice = (v) => write(v);

/** The car cycle ids in view, or null for everything. */
export function cyclesInView(b) {
  const all = cyclesOf(b);
  if (!all.length) return null;
  const c = cycleChoice(b);
  if (c === 'all') return null;
  if (c === 'both') return [currentCycle(b).id, nextCycle(b).id];
  if (c === 'now') return [currentCycle(b).id];
  return [c];
}
/**
 * 074: the switcher's choice as a search filter on the item's car, or null for everything. Items with no car count
 * as the current car's.
 */
export function carFilter(b) {
  const ids = cyclesInView(b);
  if (!ids) return null;
  const inCars = { f: 'program', op: 'in', v: ids.length ? ids : ['00000000-0000-0000-0000-000000000000'] };
  return ids.includes(currentCycle(b)?.id) ? { any: [inCars, { f: 'program', op: 'empty' }] } : inCars;
}
/** Is this item in the car cycles shown? (No car: it's the current car's.) */
export function itemInView(b, item) {
  const ids = cyclesInView(b);
  return !ids || ids.includes(item.program_id || currentCycle(b)?.id);
}
/** The car an item counts as. */
export const cycleOfItem = (b, item) => b.programs.find((g) => g.id === item.program_id && !g.archived_at) || currentCycle(b);

/** Is this project in the car cycles shown? (Not in any cycle: it's the current car's.) Spaces (074) have none. */
export function inView(b, project) {
  const ids = cyclesInView(b);
  if (!ids) return true;
  const own = project.program_id && b.programs.some((g) => g.id === project.program_id && !g.archived_at) ? project.program_id : currentCycle(b)?.id;
  return ids.includes(own);
}
/** The car cycle a project counts as (its own, or the current car). */
export const cycleOfProject = (b, project) => b.programs.find((g) => g.id === project.program_id && !g.archived_at) || currentCycle(b);
/** Where new work goes: the one car in view, else the current car. */
export function cycleForNew(b) {
  const ids = cyclesInView(b);
  return ids?.length === 1 ? ids[0] : currentCycle(b)?.id || '';
}

/** The switcher: [Car 7 · now] [Car 8] [Both] [Everything]. Nothing when there's at most one car cycle. */
export function cycleSwitch(b) {
  const all = cyclesOf(b);
  if (all.length < 2) return '';
  const c = cycleChoice(b);
  const cur = currentCycle(b);
  const next = nextCycle(b);
  const btn = (v, label, title) => `<button type="button" data-cycle="${esc(v)}" class="${c === v || (v === cur.id && c === 'now') ? 'is-on' : ''}" aria-pressed="${c === v || (v === cur.id && c === 'now')}" title="${esc(title)}">${label}</button>`;
  const dates = (g) => [g.start_date && fmtDate(g.start_date), g.end_date && fmtDate(g.end_date)].filter(Boolean).join(' – ');
  return `<div class="pm-cycles"><span class="pm-cycles-label">Car</span><div class="pm-seg" role="group" aria-label="Which car cycle">
    ${all.map((g) => btn(g.id, `${esc(g.name)}${g.id === cur.id ? ' <span class="pm-cycle-now">now</span>' : ''}`, `${g.name}${dates(g) ? `: ${dates(g)}` : ''}${g.id === cur.id ? ' (the current car)' : ''}`)).join('')}
    ${next ? btn('both', 'Both', `${cur.name} and ${next.name} together, on one time axis`) : ''}
    ${all.length > 2 ? btn('all', 'Everything', 'Every car cycle') : ''}</div></div>`;
}
export function bindCycleSwitch(el, b, rerender) {
  el.querySelectorAll('[data-cycle]').forEach((x) => x.addEventListener('click', () => {
    const v = x.dataset.cycle;
    setCycleChoice(v === currentCycle(b)?.id ? '' : v);
    rerender();
  }));
}

/** Add or change a car cycle: name, vehicle, dates, whether it's the current car. Resolves with it or null. */
export function cycleDialog(b, g = null) {
  return formDialog({
    title: g ? `Edit ${g.name}` : 'New car cycle', submit: 'Save',
    body: `<div class="form-grid">
        <div class="field span-2"><label for="cy-name">Name</label><input id="cy-name" name="name" type="text" maxlength="80" required value="${esc(g?.name || '')}" placeholder="Car 8"></div>
        <div class="field span-2"><label for="cy-vehicle">Vehicle (optional)</label><input id="cy-vehicle" name="vehicle" type="text" maxlength="80" value="${esc(g?.vehicle || '')}"></div>
        <div class="field span-2"><label for="cy-start">Starts</label><input id="cy-start" name="start" type="date" value="${esc(g?.start_date || '')}"></div>
        <div class="field span-2"><label for="cy-end">Ends</label><input id="cy-end" name="end" type="date" value="${esc(g?.end_date || '')}"></div>
        <div class="field span-4"><label for="cy-desc">Notes</label><textarea id="cy-desc" name="description" rows="2">${esc(g?.description || '')}</textarea></div></div>
      <label class="pm-check"><input type="checkbox" name="current" ${g ? (g.is_current ? 'checked' : '') : (cyclesOf(b).length ? '' : 'checked')}> This is the current car (Workbench opens on it)</label>
      ${g ? '<label class="pm-check"><input type="checkbox" name="archived"> Archive this car cycle (its spaces stay)</label>' : ''}`,
    onSubmit: async (f) => {
      const e = f.elements;
      const r = await pm.saveProgram(g?.id || null, { name: e.name.value, vehicle: e.vehicle.value, description: e.description.value, start_date: e.start.value, end_date: e.end.value,
        current: e.current.checked, ...(g ? { archived: e.archived.checked } : {}) });
      invalidate();
      return r;
    },
  });
}

/**
 * "Start a new car cycle": its name, dates and whether it's the current car now. Spaces carry on (074); new work
 * for the new car is added in each Space with the car switcher set to it. Resolves with { cycle } or null.
 */
export function newCycleDialog(b) {
  return formDialog({
    title: 'Start a new car cycle', submit: 'Start it',
    body: `<p class="muted">Plan the next car while this one is still being built. Every space carries on; switch to the new car at the top of Workbench to add its work.</p>
      <div class="form-grid">
        <div class="field span-2"><label for="nc-name">Name</label><input id="nc-name" name="name" type="text" maxlength="80" required placeholder="Car 8"></div>
        <div class="field span-2"><label for="nc-vehicle">Vehicle (optional)</label><input id="nc-vehicle" name="vehicle" type="text" maxlength="80"></div>
        <div class="field span-2"><label for="nc-start">Starts</label><input id="nc-start" name="start" type="date"></div>
        <div class="field span-2"><label for="nc-end">Ends</label><input id="nc-end" name="end" type="date"></div></div>
      <label class="pm-check"><input type="checkbox" name="current" ${cyclesOf(b).length ? '' : 'checked'}> Make it the current car now</label>`,
    async onSubmit(form) {
      const e = form.elements;
      const cycle = await pm.saveProgram(null, { name: e.name.value, vehicle: e.vehicle.value, start_date: e.start.value, end_date: e.end.value, current: e.current.checked });
      invalidate();
      setCycleChoice(e.current.checked ? '' : cycle.id);
      return { cycle };
    },
  });
}
