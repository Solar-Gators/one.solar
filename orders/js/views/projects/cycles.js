/**
 * Projects → car cycles (063). A car cycle is a program with dates; one of them is the current car. The switcher
 * at the top of Projects, the team timeline, Boards, Calendar, All work and Dashboards shows this car, another car,
 * both (this and the next), or everything. Projects not in any car cycle count as the current car's (they were
 * made before there were cycles). The choice is remembered in this browser.
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
/** Is this project in the car cycles shown? (Not in any cycle: it's the current car's.) */
export function inView(b, project) {
  const ids = cyclesInView(b);
  if (!ids) return true;
  const own = project.program_id && b.programs.some((g) => g.id === project.program_id && !g.archived_at) ? project.program_id : currentCycle(b)?.id;
  return ids.includes(own);
}
/** The car cycle a project counts as (its own, or the current car). */
export const cycleOfProject = (b, project) => b.programs.find((g) => g.id === project.program_id && !g.archived_at) || currentCycle(b);
/** Where a new project goes: the one car in view, else the current car. */
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

/** A key for a project copied into another car: BAT → BAT8 (the new car's number), made unique. */
export function copyKey(key, cycleName, taken) {
  const digits = ((cycleName.match(/\d+/g) || []).pop() || '2').slice(0, 4);
  const stem = key.replace(/\d+$/, '') || key;   // BAT7 → BAT
  const make = (suffix) => `${stem.slice(0, 10 - suffix.length)}${suffix}`;
  let k = make(digits);
  for (let n = 0; taken.has(k) && n < 26; n++) k = make(`${digits}${String.fromCharCode(65 + n)}`);   // BAT8A, BAT8B…
  return k;
}

/**
 * "Start a new car cycle": the cycle, and (optional) last car's projects copied into it: the same set-up (kinds,
 * workflows, fields, boards, rules), division, subsystem, manager and visibility, with no items. Resolves with
 * { cycle, copied: [projects], failed: [[key, message]] } or null.
 */
export function newCycleDialog(b) {
  const from = currentCycle(b);
  const fromProjects = from ? b.projects.filter((p) => !p.archived_at && cycleOfProject(b, p)?.id === from.id) : [];
  return formDialog({
    title: 'Start a new car cycle', submit: 'Start it', wide: true,
    body: `<p class="muted">Plan the next car while this one is still being built. The switcher at the top of Workbench shows this car, the next one or both.</p>
      <div class="form-grid">
        <div class="field span-2"><label for="nc-name">Name</label><input id="nc-name" name="name" type="text" maxlength="80" required placeholder="Car 8"></div>
        <div class="field span-2"><label for="nc-vehicle">Vehicle (optional)</label><input id="nc-vehicle" name="vehicle" type="text" maxlength="80"></div>
        <div class="field span-2"><label for="nc-start">Starts</label><input id="nc-start" name="start" type="date"></div>
        <div class="field span-2"><label for="nc-end">Ends</label><input id="nc-end" name="end" type="date"></div></div>
      <label class="pm-check"><input type="checkbox" name="current"> Make it the current car now</label>
      ${fromProjects.length ? `<fieldset class="pm-copy"><legend>Start from ${esc(from.name)}'s spaces</legend>
        <p class="hint">Each one ticked is copied with its set-up, division, subsystem and manager, but no items. You can add or remove spaces later.</p>
        <label class="pm-check"><input type="checkbox" data-copy-all checked> All of them</label>
        <div class="pm-copy-list">${fromProjects.map((p) => `<label class="pm-copy-row"><input type="checkbox" name="copy" value="${esc(p.id)}" checked>
          <span>${esc(p.name)} <span class="pm-key">${esc(p.key)}</span></span> → <input type="text" class="pm-copy-key" data-key-for="${esc(p.id)}" maxlength="10" aria-label="New key for ${esc(p.name)}" value=""></label>`).join('')}</div></fieldset>` : ''}`,
    onOpen(form) {
      const taken = new Set(b.projects.map((p) => p.key));
      const keys = () => {
        const used = new Set(taken);
        form.querySelectorAll('[data-key-for]').forEach((i) => {
          if (i.dataset.typed) return used.add(i.value);
          const p = b.projectById.get(i.dataset.keyFor);
          i.value = copyKey(p.key, form.elements.name.value || '', used);
          used.add(i.value);
        });
      };
      keys();
      form.elements.name.addEventListener('input', keys);
      form.querySelectorAll('[data-key-for]').forEach((i) => i.addEventListener('input', () => (i.dataset.typed = '1')));
      const all = form.querySelector('[data-copy-all]');
      all?.addEventListener('change', () => form.querySelectorAll('[name=copy]').forEach((c) => (c.checked = all.checked)));
      form.querySelectorAll('[name=copy]').forEach((c) => c.addEventListener('change', () => (all.checked = [...form.querySelectorAll('[name=copy]')].every((x) => x.checked))));
    },
    async onSubmit(form) {
      const e = form.elements;
      const picked = [...form.querySelectorAll('[name=copy]:checked')].map((c) => b.projectById.get(c.value));
      for (const p of picked) {
        const k = form.querySelector(`[data-key-for="${p.id}"]`).value.trim().toUpperCase();
        if (!/^[A-Z][A-Z0-9]{1,9}$/.test(k)) throw new Error(`The key for ${p.name} is 2 to 10 capital letters or numbers, starting with a letter.`);
      }
      const cycle = await pm.saveProgram(null, { name: e.name.value, vehicle: e.vehicle.value, start_date: e.start.value, end_date: e.end.value, current: e.current.checked });
      const copied = [];
      const failed = [];
      for (const p of picked) {
        const key = form.querySelector(`[data-key-for="${p.id}"]`).value.trim().toUpperCase();
        try {
          const config = await pm.exportConfig(p.id, false);
          const made = await pm.saveProject(null, { name: p.name, key, config, include_items: false, start_date: e.start.value || undefined });
          copied.push(await pm.saveProject(made.id, { program_id: cycle.id, description: p.description, lead_id: p.lead_id, division_id: p.division_id,
            subsystem_id: p.subsystem_id, visibility: p.visibility }));
        } catch (err) {
          failed.push([p.key, err.message]);
        }
      }
      invalidate();
      setCycleChoice(e.current.checked ? '' : cycle.id);
      return { cycle, copied, failed };
    },
  });
}
