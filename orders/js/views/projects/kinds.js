/**
 * Projects → Kinds of work (063): the team's one list of kinds of work (Design Task, Calc, Design Review…), the
 * same name, icon and color in every project. Everyone sees it; leads ("Edit kinds of work": Subsystem Leads,
 * Chief Engineers, the E-board) and Admins add, rename, recolor and retire them. A new kind goes into every project
 * at once, on that project's main workflow; a project can still hide one it doesn't use (its Settings).
 */
import { esc } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { TONES } from '../../projects/core.js';
import { needsDatabase, loadBase, invalidate, header, formDialog, canEditKinds, toast } from './kit.js';

const LEVELS = [[0, 'Top: big pieces of work (like an epic)'], [1, 'Ordinary work'], [2, 'Under ordinary work (a step)'], [3, 'Deeper'], [4, 'Deeper still']];
const TONE_HEX = { gray: '#8b93a3', blue: '#3c6fe0', green: '#2f9e5b', teal: '#25a59a', amber: '#d9a21b', orange: '#f26b3a', red: '#d9372b', pink: '#d6468f', purple: '#7c5ce0', navy: '#2c4a7a' };
const swatch = (c) => `<span class="pm-kind-dot" style="--c:${TONE_HEX[c] || TONE_HEX.blue}" aria-hidden="true"></span>`;

/** Add (k null) or change a team kind of work. Resolves with it, or null. */
export function kindDialog(b, k = null, { name = '' } = {}) {
  const used = new Set((b.kinds || []).filter((x) => !x.archived_at && x.id !== k?.id).map((x) => x.color));
  const color = k?.color || TONES.find((c) => c !== 'gray' && !used.has(c)) || 'blue';
  return formDialog({
    title: k ? `Kind of work: ${esc(k.name)}` : 'New kind of work', submit: k ? 'Save for every project' : 'Add to every project',
    body: `<p class="muted">${k ? 'A change shows in every project at once.' : 'It\'s added to every project at once (each uses its main workflow for it). A project that doesn\'t need it can hide it in its Settings.'}</p>
      <div class="form-grid">
        <div class="field span-2"><label for="kd-name">Name</label><input id="kd-name" name="name" type="text" maxlength="40" required value="${esc(k?.name || name)}" placeholder="Calc"></div>
        <div class="field"><label for="kd-icon">Icon (optional)</label><input id="kd-icon" name="icon" type="text" maxlength="4" value="${esc(k?.icon || '')}" placeholder="∑"></div>
        <div class="field"><label for="kd-level">Where it sits</label><select id="kd-level" name="level">${LEVELS.map(([n, l]) => `<option value="${n}" ${(k?.level ?? 1) === n ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
        <div class="field span-4"><span class="label">Color</span><div class="pm-kind-colors" role="radiogroup" aria-label="Color">${TONES.map((c) => `<label class="pm-kind-color" title="${esc(c)}${used.has(c) ? ' (another kind has it)' : ''}">
          <input type="radio" name="color" value="${c}" ${c === color ? 'checked' : ''}>${swatch(c)}<span class="sr-only">${esc(c)}</span></label>`).join('')}</div></div>
        <div class="field span-4"><label for="kd-desc">What it's for (optional)</label><input id="kd-desc" name="description" type="text" maxlength="500" value="${esc(k?.description || '')}" placeholder="Hand or spreadsheet calculations that back a design decision"></div></div>
      <label class="pm-check"><input type="checkbox" name="milestone" ${k?.is_milestone ? 'checked' : ''}> A milestone (a date, not a stretch of work)</label>
      ${k ? `<label class="pm-check"><input type="checkbox" name="archived" ${k.archived_at ? 'checked' : ''}> Retired (hidden in every project; existing items keep it)</label>` : ''}`,
    async onSubmit(f) {
      const x = f.elements;
      const r = await pm.saveKind(k?.id || null, { name: x.name.value.trim(), icon: x.icon.value.trim(), color: x.color.value, level: Number(x.level.value),
        description: x.description.value, is_milestone: x.milestone.checked, ...(k ? { archived: x.archived.checked } : {}) });
      invalidate();
      return r;
    },
  });
}

export async function renderKinds(el, { config, rerender }) {
  const missing = needsDatabase(config);
  if (missing) return void (el.innerHTML = missing);
  if (Number(config.schemaVersion) < 63) return void (el.innerHTML = `${header('Kinds of work', '')}<p class="alert alert-info">This needs the database update 063.</p>`);
  const [b, usage] = await Promise.all([loadBase(), pm.kindUsage().catch(() => ({}))]);
  const mayEdit = canEditKinds();
  const kinds = [...(b.kinds || [])].sort((a, z) => !!a.archived_at - !!z.archived_at || a.level - z.level || a.sort - z.sort || a.name.localeCompare(z.name));
  const row = (k) => {
    const u = usage[k.id] || { projects: 0, items: 0 };
    return `<tr class="${k.archived_at ? 'is-done' : ''}" data-kind-row="${esc(k.id)}">
      <td>${swatch(k.color)} ${k.icon ? `<span aria-hidden="true">${esc(k.icon)}</span> ` : ''}<strong>${esc(k.name)}</strong>${k.is_milestone ? ' <span class="chip">Milestone</span>' : ''}${k.archived_at ? ' <span class="chip-tone tone-gray">Retired</span>' : ''}
        ${k.description ? `<div class="muted small">${esc(k.description)}</div>` : ''}</td>
      <td>${esc(LEVELS.find(([n]) => n === k.level)?.[1] || String(k.level))}</td>
      <td>${u.projects} project${u.projects === 1 ? '' : 's'}</td><td>${u.items} item${u.items === 1 ? '' : 's'}</td>
      <td>${mayEdit ? `<button type="button" class="btn btn-sm" data-edit-kind="${esc(k.id)}" aria-label="Change ${esc(k.name)}">Change</button>` : ''}</td></tr>`;
  };
  el.innerHTML = `${header('Kinds of work', 'One list for the whole team: the same name, icon and color in every project, so the timelines read the same everywhere.',
    mayEdit ? '<button type="button" class="btn btn-primary" data-new-kind>+ New kind of work</button>' : '')}
    <section class="card">
      ${kinds.length ? `<div class="table-wrap"><table class="pm-table pm-kinds"><thead><tr><th>Kind</th><th>Where it sits</th><th>Shown in</th><th>Used by</th><th></th></tr></thead>
        <tbody>${kinds.map(row).join('')}</tbody></table></div>` : '<p class="muted">No kinds of work yet.</p>'}
      <p class="hint">${mayEdit ? 'A new kind goes into every project at once. A project that doesn\'t use one can hide it (project Settings → Work types); each project also picks the kind\'s workflow there.'
        : 'Subsystem Leads, Chief Engineers, the E-board and Admins change this list. Ask one if your subsystem needs a new kind of work.'}</p>
    </section>`;
  el.querySelector('[data-new-kind]')?.addEventListener('click', async () => {
    const k = await kindDialog(b);
    if (k) (toast(`${k.name} is now in every project.`), rerender());
  });
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-edit-kind]');
    if (!t) return;
    const k = await kindDialog(b, b.kinds.find((x) => x.id === t.dataset.editKind));
    if (k) (toast(k.archived_at ? `${k.name} is retired.` : `${k.name} is saved in every project.`), rerender());
  });
}
