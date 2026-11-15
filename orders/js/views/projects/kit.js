/**
 * Projects pages: what they share. The base data (projects, people, CE divisions, what I may do where) and each
 * project's configuration are loaded once and kept until something changes. The form fields, the "move" (workflow
 * transition) dialog, the create dialog and the filter bar are the same on every page, and every one of them is
 * built from the project's configuration, never from a list in the code.
 */
import { auth } from '../../auth.js';
import { api } from '../../api.js';
import { esc, errorBox, fmtDate, renderRichText } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { PRIORITIES, CATEGORIES, newId, fieldLabel, layoutFor, movesFor, moveNeeds, relDay } from '../../projects/core.js';
import { evalFormula } from '../../projects/formula.js';
import { todayISO } from '../../projects/schedule.js';

export const PM_PERMS = ['projects.view', 'projects.create', 'projects.manage'];
export const canCreateProjects = () => auth.can('projects.create') || auth.can('projects.manage');

/** The database has Projects (051)? Otherwise pages say so instead of failing. */
export function needsDatabase(config) {
  if (Number(config.schemaVersion) >= 51) return '';
  return `<section class="card no-access"><h1>Projects isn't set up yet</h1>
    <p>The database needs the update <code>supabase/migrations/051_projects.sql</code>. ${auth.can('settings.edit') ? 'See the yellow banner above.' : 'Ask an Admin.'}</p></section>`;
}

// ---- data ------------------------------------------------------------------------------------------
let base = null;
const configs = new Map();
let ranScheduled = false;
let unreadAt = 0;

/** The unread count on the Inbox button (checked at most every 30 seconds). */
export function refreshUnread(now = false) {
  const badge = document.getElementById('pm-unread');
  if (!badge || (!now && Date.now() - unreadAt < 30000)) return;
  unreadAt = Date.now();
  pm.unread().then((n) => {
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
  }, () => {});
}

/** Projects, programs, people, CE divisions and what I may do in each project. Kept until invalidate(). */
export async function loadBase({ fresh = false } = {}) {
  refreshUnread();
  if (!base || fresh) {
    base = Promise.all([pm.projects(), pm.programs(), api.listProfiles(), pm.divisions().catch(() => []), pm.subsystems().catch(() => []), pm.myCaps(), pm.myRoles(auth.user?.id)])
      .then(([projects, programs, profiles, divisions, subsystems, caps, myRoles]) => {
        const people = profiles.filter((p) => (p.roles || []).some((r) => r !== 'guest' && r !== 'alumni'));
        return {
          projects, programs, people, divisions, subsystems, caps, me: auth.user?.id,
          myRoles: new Map(myRoles.map((m) => [m.project_id, m.role_id])),
          projectById: new Map(projects.map((p) => [p.id, p])),
          projectByKey: new Map(projects.map((p) => [p.key, p])),
          personById: new Map(profiles.map((p) => [p.id, p])),
          divisionById: new Map(divisions.map((d) => [d.id, d])),
          subsystemById: new Map(subsystems.map((s) => [s.id, s])),
        };
      })
      .catch((e) => {
        base = null;
        throw e;
      });
    // Timed rules and reminders: a nudge when someone opens Projects (the database does them at most every 30 minutes).
    if (!ranScheduled) {
      ranScheduled = true;
      pm.runScheduled().catch(() => {});
    }
  }
  return base;
}
/** A project's configuration with lookups. */
export async function loadConfig(b, projectId, { fresh = false } = {}) {
  if (!configs.has(projectId) || fresh) {
    configs.set(projectId, pm.config(projectId).then((c) => withLookups(b, b.projectById.get(projectId), c)).catch((e) => {
      configs.delete(projectId);
      throw e;
    }));
  }
  return configs.get(projectId);
}
export function withLookups(b, project, c) {
  const myRole = b.myRoles.get(project?.id);
  return {
    ...c, project,
    statusById: new Map(c.statuses.map((s) => [s.id, s])),
    typeById: new Map(c.types.map((t) => [t.id, t])),
    who: { roleIds: [myRole, project?.visibility === 'team' ? project.team_role_id : null].filter(Boolean), manage: auth.can('projects.manage') },
  };
}
export const invalidate = (projectId = null) => {
  if (projectId) configs.delete(projectId);
  else {
    base = null;
    configs.clear();
  }
};
export const can = (b, projectId, cap) => !!b.caps[projectId]?.includes(cap);

// ---- small pieces ----------------------------------------------------------------------------------
export const itemHref = (key) => `#/projects/item/${encodeURIComponent(key)}`;
export const projectHref = (key, tab = '') => `#/projects/p/${encodeURIComponent(key)}${tab ? `/${tab}` : ''}`;
export const personName = (b, id) => {
  const p = b.personById.get(id);
  return p ? p.full_name || p.email : id ? 'Someone' : '';
};
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
export const avatar = (b, id) => (id
  ? `<span class="pm-avatar" title="${esc(personName(b, id))}" aria-label="${esc(personName(b, id))}">${esc(initials(personName(b, id)))}</span>`
  : '<span class="pm-avatar is-none" title="No owner" aria-label="No owner">–</span>');
export const statusChip = (s) => (s ? `<span class="chip-tone tone-${esc(s.color)} pm-status" data-category="${esc(s.category)}">${esc(s.name)}</span>` : '');
export const typeBadge = (t, withName = false) => (t
  ? `<span class="pm-type tone-${esc(t.color)}" title="${esc(t.name)}">${esc(t.icon || t.name[0])}</span>${withName ? ` ${esc(t.name)}` : ''}` : '');
export const priorityChip = (p) => {
  const hit = PRIORITIES.find(([k]) => k === p);
  return hit && p !== 'medium' ? `<span class="chip-tone tone-${hit[2]} pm-priority">${hit[1]}</span>` : '';
};
export function dueChip(item) {
  if (!item.due_date) return '';
  const late = item.category !== 'done' && item.due_date < todayISO();
  return `<span class="pm-due${late ? ' is-late' : ''}" title="Due ${esc(fmtDate(item.due_date))}">${late ? '⚠ ' : ''}${esc(fmtDate(item.due_date))}${late ? ` (${esc(relDay(item.due_date))})` : ''}</span>`;
}
export const header = (title, subtitle = '', actions = '') => `<div class="page-header pm-head">
  <div><h1>${title}</h1>${subtitle ? `<p class="subtitle">${subtitle}</p>` : ''}</div>
  ${actions ? `<div class="card-actions">${actions}</div>` : ''}</div>`;

const PROJECT_TABS = [['', 'Summary'], ['list', 'List'], ['board', 'Board'], ['backlog', 'Backlog'], ['timeline', 'Timeline'], ['calendar', 'Calendar'], ['docs', 'Documents'], ['settings', 'Settings']];
/** A project's top: name, key, and its tabs. Settings shows only to people who can change something there. */
export function projectTop(b, project, active, actions = '') {
  const settings = ['configure', 'workflows', 'members', 'automations'].some((c) => can(b, project.id, c));
  return `${header(`${esc(project.name)} <span class="pm-key">${esc(project.key)}</span>`,
    `${project.archived_at ? '<span class="chip-tone tone-gray">Archived</span> ' : ''}${project.visibility === 'private' ? '<span class="chip-tone tone-purple" title="Only its members can see this project">Private</span> ' : ''}${esc(project.description.split('\n')[0] || '')}`, actions)}
  <nav class="pm-tabs" aria-label="${esc(project.name)}">${PROJECT_TABS.filter(([k]) => k !== 'settings' || settings)
    .map(([k, label]) => `<a href="${projectHref(project.key, k)}" ${k === active ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
}

/** Safe formatting for descriptions and comments (everything escaped first), with @mentions marked. */
export const rich = (text) => renderRichText(text).replace(/(^|[\s>(])@([A-Z][\w'.-]*(?: [A-Z][\w'.-]*)?)/g, '$1<span class="pm-mention">@$2</span>');

/** A short notice at the bottom of the screen ("Saved", "Moved to In Review"). */
export function toast(message, kind = 'ok') {
  document.querySelector('.pm-toast')?.remove();
  const el = Object.assign(document.createElement('div'), { className: `pm-toast is-${kind}`, textContent: message });
  el.setAttribute('role', 'status');
  document.body.append(el);
  setTimeout(() => el.remove(), kind === 'ok' ? 3200 : 7000);
}
/** Run something that changes data; a failure shows as a notice instead of breaking the page. Returns its result or undefined. */
export async function attempt(fn, done = '') {
  try {
    const r = await fn();
    if (done) toast(done);
    return r || true;   // a function with no result still counts as done
  } catch (err) {
    toast(err.message, 'bad');
    return undefined;
  }
}

/** A one.solar dialog with a form. onSubmit(form) does the work; its errors show in the dialog. Resolves with its result, or null. */
export function formDialog({ title, body, submit = 'Save', onSubmit, onOpen, wide = false, danger = false }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = `card sheet-dialog pm-dialog${wide ? ' pm-dialog-wide' : ''}`;
    dialog.innerHTML = `<form novalidate>
      <h2>${title}</h2>
      <div class="pm-dialog-error" aria-live="polite"></div>
      ${body}
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
        ${submit ? `<button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-submit>${esc(submit)}</button>` : ''}</div>
    </form>`;
    document.body.append(dialog);
    const form = dialog.querySelector('form');
    let result = null;
    dialog.addEventListener('close', () => (dialog.remove(), resolve(result)));
    dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[data-submit]');
      if (!btn || btn.disabled) return;
      if (!form.checkValidity()) return form.reportValidity();
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = 'Saving…';
      form.querySelector('.pm-dialog-error').innerHTML = '';
      try {
        result = (await onSubmit(form, dialog)) || true;
        dialog.close();
      } catch (err) {
        btn.disabled = false;
        if (err?.stay) return void (btn.textContent === 'Saving…' && (btn.textContent = label));   // the dialog showed something (a preview) and waits for a second press
        form.querySelector('.pm-dialog-error').innerHTML = errorBox(err);
        btn.textContent = label;
      }
    };
    dialog.showModal();
    onOpen?.(form, dialog);
    form.querySelector('input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea')?.focus();
  });
}

// ---- form fields, built from the project's configuration ---------------------------------------------
const opt = (value, label, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;
export const peopleOptions = (b, selected, blank = 'Nobody') =>
  `${blank ? opt('', blank, !selected) : ''}${b.people.map((p) => opt(p.id, p.full_name || p.email, p.id === selected)).join('')}`;
const checks = (name, list, picked = []) => `<div class="pm-checks">${list
  .map(([v, label]) => `<label class="pm-check"><input type="checkbox" name="${esc(name)}" value="${esc(v)}" ${picked.includes(v) ? 'checked' : ''}> ${esc(label)}</label>`).join('')}</div>`;

/**
 * One form field by its key ("due_date", "owner", "cf.test_date"…). ctx: { b, cfg, item, parents, collaborators }.
 * Field names are "f:<key>" so readFields() can collect exactly what the form showed.
 */
export function fieldInput(key, ctx, { required = false } = {}) {
  const { b, cfg, item = {} } = ctx;
  const name = `f:${key}`;
  const id = `pmf-${key.replace(/\W/g, '-')}`;
  const req = required ? 'required' : '';
  const label = `<label for="${id}">${esc(fieldLabel(key, cfg.fields))}${required ? ' <span class="pm-req" title="Required">*</span>' : ''}</label>`;
  const wrap = (input, hint = '', wide = false) => `<div class="field${wide ? ' span-4' : ''}" data-field="${esc(key)}">${label}${input}${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  if (key.startsWith('cf.')) {
    const f = cfg.fields.find((x) => x.key === key.slice(3));
    if (!f) return '';
    const v = item.custom?.[f.key] ?? (item.id ? undefined : f.default_value) ?? '';
    const hint = esc(f.description || '');
    switch (f.type) {
      case 'longtext': case 'richtext': return wrap(`<textarea id="${id}" name="${name}" rows="3" ${req}>${esc(v)}</textarea>`, hint, true);
      case 'integer': return wrap(`<input id="${id}" name="${name}" type="number" step="1" ${f.validation?.min !== undefined ? `min="${esc(f.validation.min)}"` : ''} ${f.validation?.max !== undefined ? `max="${esc(f.validation.max)}"` : ''} value="${esc(v)}" ${req}>`, hint);
      case 'decimal': case 'currency': case 'duration': return wrap(`<input id="${id}" name="${name}" type="number" step="any" value="${esc(v)}" ${req}>`, hint || (f.type === 'duration' ? 'Hours' : ''));
      case 'date': return wrap(`<input id="${id}" name="${name}" type="date" value="${esc(v)}" ${req}>`, hint);
      case 'datetime': return wrap(`<input id="${id}" name="${name}" type="datetime-local" value="${esc(String(v).slice(0, 16))}" ${req}>`, hint);
      case 'checkbox': return `<div class="field" data-field="${esc(key)}"><label class="pm-check"><input type="checkbox" name="${name}" value="true" ${v === true ? 'checked' : ''}> ${esc(f.name)}</label>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
      case 'select': return wrap(`<select id="${id}" name="${name}" ${req}>${opt('', '—', !v)}${f.options.map((o) => opt(o, o, o === v)).join('')}</select>`, hint);
      case 'multiselect': return wrap(checks(name, f.options.map((o) => [o, o]), Array.isArray(v) ? v : []), hint, true);
      case 'user': return wrap(`<select id="${id}" name="${name}" ${req}>${peopleOptions(b, v)}</select>`, hint);
      case 'multiuser': return wrap(`<details class="pm-multi"><summary>${(Array.isArray(v) ? v : []).length || 'No'} chosen</summary>${checks(name, b.people.map((p) => [p.id, p.full_name || p.email]), Array.isArray(v) ? v : [])}</details>`, hint);
      case 'url': return wrap(`<input id="${id}" name="${name}" type="url" placeholder="https://" value="${esc(v)}" ${req}>`, hint);
      case 'tags': return wrap(`<input id="${id}" name="${name}" type="text" value="${esc(Array.isArray(v) ? v.join(', ') : v)}" data-list ${req}>`, hint || 'Separate with commas');
      case 'formula': return `<div class="field" data-field="${esc(key)}"><label>${esc(f.name)}</label><output class="pm-formula">${esc(evalFormula(f.formula, item) ?? '—')}</output><div class="hint">Calculated: <code>${esc(f.formula)}</code></div></div>`;
      default: return wrap(`<input id="${id}" name="${name}" type="text" value="${esc(v)}" maxlength="${esc(f.validation?.maxlen || 500)}" ${req}>`, hint);
    }
  }
  switch (key) {
    case 'description': return wrap(`<textarea id="${id}" name="${name}" rows="5" ${req}>${esc(item.description || '')}</textarea>`, '**bold**, - lists, [text](https://link) and @Name work here.', true);
    case 'acceptance': return wrap(`<textarea id="${id}" name="${name}" rows="3" ${req}>${esc(item.acceptance || '')}</textarea>`, 'What has to be true for this to count as done.', true);
    case 'priority': return wrap(`<select id="${id}" name="${name}">${PRIORITIES.map(([k, l]) => opt(k, l, (item.priority || 'medium') === k)).join('')}</select>`);
    case 'owner': return wrap(`<select id="${id}" name="${name}" ${req}>${peopleOptions(b, item.owner_id, 'No owner yet')}</select>`, 'The one person accountable.');
    case 'collaborators': return wrap(`<details class="pm-multi"><summary>${(ctx.collaborators || []).length || 'No'} chosen</summary>${checks(name, b.people.map((p) => [p.id, p.full_name || p.email]), ctx.collaborators || [])}</details>`);
    case 'division': return wrap(`<select id="${id}" name="${name}" data-division ${req}>${opt('', '—', !item.division_id)}${b.divisions.filter((d) => !d.archived_at || d.id === item.division_id).map((d) => opt(d.id, d.name, d.id === item.division_id)).join('')}</select>`);
    case 'subsystem': return wrap(`<select id="${id}" name="${name}" data-subsystem ${req}>${opt('', '—', !item.subsystem_id)}${b.subsystems.filter((s) => !s.archived_at || s.id === item.subsystem_id)
      .map((s) => `<option value="${esc(s.id)}" data-div="${esc(s.division_id)}" ${s.id === item.subsystem_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`,
      b.subsystems.length ? '' : 'No subsystems yet: an Admin adds them in Admin → CE divisions & subsystems.');
    case 'vehicle': return wrap(`<input id="${id}" name="${name}" type="text" maxlength="80" value="${esc(item.vehicle || '')}" ${req}>`);
    case 'start_date': case 'due_date': return wrap(`<input id="${id}" name="${name}" type="date" value="${esc(item[key] || '')}" ${req}>`);
    case 'estimate_hours': return wrap(`<input id="${id}" name="${name}" type="number" min="0" step="any" value="${esc(item.estimate_hours ?? '')}" ${req}>`, 'Optional. Used for workload and effort-weighted progress.');
    case 'progress': return wrap(`<input id="${id}" name="${name}" type="number" min="0" max="100" step="5" value="${esc(item.progress ?? 0)}">`, 'Percent');
    case 'labels': return wrap(`<input id="${id}" name="${name}" type="text" value="${esc((item.labels || []).join(', '))}" data-list ${req}>`, 'Separate with commas');
    case 'sprint': return wrap(`<select id="${id}" name="${name}" ${req}>${opt('', 'Backlog (no sprint)', !item.sprint_id)}${cfg.sprints.filter((s) => s.status !== 'closed' || s.id === item.sprint_id).map((s) => opt(s.id, s.name, s.id === item.sprint_id)).join('')}</select>`);
    case 'parent': return wrap(`<select id="${id}" name="${name}" ${req}>${opt('', 'Nothing (top level)', !item.parent_id)}${(ctx.parents || []).filter((p) => p.id !== item.id).map((p) => opt(p.id, `${p.key} · ${p.title}`, p.id === item.parent_id)).join('')}</select>`);
    case 'blocked': return `<div class="field span-4" data-field="blocked"><label class="pm-check"><input type="checkbox" name="${name}" value="true" ${item.blocked ? 'checked' : ''}> Blocked</label>
      <input type="text" name="f:blocked_reason" placeholder="What's it waiting on?" maxlength="500" value="${esc(item.blocked_reason || '')}" aria-label="What is it waiting on"></div>`;
    default: return '';
  }
}

/** The sections of a form as HTML. */
export const formSections = (sections, ctx) => sections.map((s) => `<fieldset class="pm-section">${s.title ? `<legend>${esc(s.title)}</legend>` : ''}
  <div class="form-grid">${s.fields.map((f) => fieldInput(f.key, ctx, { required: !!f.required })).join('')}</div></fieldset>`).join('');

/** Keep the subsystem list to the chosen division (and pick the division when a subsystem is chosen). */
export function bindOrgPickers(root) {
  const div = root.querySelector('[data-division]');
  const sub = root.querySelector('[data-subsystem]');
  if (!div || !sub) return;
  const fit = () => [...sub.options].forEach((o) => (o.hidden = !!o.dataset.div && !!div.value && o.dataset.div !== div.value));
  div.addEventListener('change', () => {
    if (sub.selectedOptions[0]?.dataset.div && sub.selectedOptions[0].dataset.div !== div.value) sub.value = '';
    fit();
  });
  sub.addEventListener('change', () => {
    if (sub.selectedOptions[0]?.dataset.div) div.value = sub.selectedOptions[0].dataset.div;
    fit();
  });
  fit();
}

/** What a form holds, as pm_create_item / pm_update_item take it. Only the fields the form showed are included. */
export function readFields(form, cfg) {
  const out = {};
  const custom = {};
  const keys = new Set([...form.querySelectorAll('[data-field]')].map((n) => n.dataset.field));
  const val = (key) => form.querySelector(`[name="f:${CSS.escape(key)}"]`);
  const many = (key) => [...form.querySelectorAll(`[name="f:${CSS.escape(key)}"]:checked`)].map((n) => n.value);
  const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  for (const key of keys) {
    if (key.startsWith('cf.')) {
      const f = cfg.fields.find((x) => x.key === key.slice(3));
      if (!f || f.type === 'formula') continue;
      custom[f.key] = ['multiselect', 'multiuser'].includes(f.type) ? many(key) : f.type === 'checkbox' ? !!val(key)?.checked : f.type === 'tags' ? list(val(key).value)
        : f.type === 'datetime' && val(key).value ? new Date(val(key).value).toISOString() : val(key).value.trim();
    } else if (key === 'owner') out.owner_id = val(key).value || null;
    else if (key === 'division') out.division_id = val(key).value || null;
    else if (key === 'subsystem') out.subsystem_id = val(key).value || null;
    else if (key === 'sprint') out.sprint_id = val(key).value || null;
    else if (key === 'parent') out.parent_id = val(key).value || null;
    else if (key === 'collaborators') out.collaborators = many(key);
    else if (key === 'labels') out.labels = list(val(key).value);
    else if (key === 'blocked') {
      out.blocked = !!val(key).checked;
      out.blocked_reason = form.querySelector('[name="f:blocked_reason"]').value.trim();
    } else if (['estimate_hours', 'start_date', 'due_date'].includes(key)) out[key] = val(key).value || null;
    else if (key === 'progress') out.progress = Number(val(key).value) || 0;
    else out[key] = val(key).value;
  }
  if (Object.keys(custom).length) out.custom = custom;
  return out;
}

// ---- creating and moving items -----------------------------------------------------------------------
/** Possible parents for a new or edited item: the project's open items of a higher level (most recent first). */
export const loadParents = async (projectId) => (await pm.search({ project: projectId, filter: { f: 'category', op: 'ne', v: 'done' }, sort: 'updated', dir: 'desc', limit: 300 })).items;

/**
 * "New item" dialog: pick the type, and the form follows that type's "create" layout. defaults: fields already
 * decided by where it was opened (a board column's status, a parent, a sprint…). Resolves with the new item or null.
 */
export async function createItemDialog(b, cfg, defaults = {}) {
  const types = cfg.types.filter((t) => !t.archived_at);
  if (!types.length) return toast('This project has no work-item types yet. Add one in Settings → Work types.', 'bad');
  const parents = await loadParents(cfg.project.id).catch(() => []);
  const opId = newId();
  let typeId = defaults.type_id || (types.find((t) => t.level === 1) || types[0]).id;
  const fields = () => {
    const type = cfg.typeById.get(typeId);
    const allowed = parents.filter((p) => {
      const pt = cfg.typeById.get(p.type_id);
      return pt && (type.parent_type_ids?.length ? type.parent_type_ids.includes(pt.id) : pt.level < type.level);
    });
    return formSections(layoutFor(cfg, typeId, 'create'), { b, cfg, item: { ...type.defaults, ...defaults, custom: defaults.custom || {} }, parents: allowed, collaborators: [] });
  };
  return formDialog({
    title: `New item in ${esc(cfg.project.name)}`, submit: 'Create', wide: true,
    body: `<div class="form-grid">
        <div class="field"><label for="pm-new-type">Kind</label><select id="pm-new-type">${types.map((t) => opt(t.id, `${t.icon ? `${t.icon} ` : ''}${t.name}`, t.id === typeId)).join('')}</select></div>
        <div class="field span-3"><label for="pm-new-title">Title</label><input id="pm-new-title" name="title" type="text" maxlength="200" required value="${esc(defaults.title || '')}"></div>
      </div><div data-fields>${fields()}</div>`,
    onOpen(form) {
      bindOrgPickers(form);
      form.querySelector('#pm-new-type').onchange = (e) => {
        typeId = e.target.value;
        form.querySelector('[data-fields]').innerHTML = fields();
        bindOrgPickers(form);
      };
      form.querySelector('#pm-new-title').focus();
    },
    onSubmit: (form) => pm.createItem(opId, { ...defaults, ...readFields(form, cfg), project_id: cfg.project.id, type_id: typeId, title: form.elements.title.value.trim() }),
  });
}

/**
 * Make a workflow move. If the move needs fields or a comment (the project's configuration says so), a dialog
 * asks for them first; the database checks again either way. Returns the item, { pending: true } when it now
 * waits for approval, or null if cancelled or refused.
 */
export async function runMove(b, cfg, item, tr) {
  const needs = moveNeeds(cfg, item, tr);
  const to = cfg.statusById.get(tr.to_status);
  const send = (extra = {}) => pm.transition(item.id, tr.id, { version: item.version, ...extra });
  const finish = (res) => {
    if (res?.pending) toast(`Asked for approval to move ${item.key} to "${to.name}". It moves when someone approves.`);
    else toast(`${item.key} is now "${to.name}".`);
    return res;
  };
  // Nothing to ask: no form for this move, no comment needed, and what it requires is already filled in.
  const col = { owner: 'owner_id', division: 'division_id', subsystem: 'subsystem_id', parent: 'parent_id', sprint: 'sprint_id' };
  const empty = (k) => {
    const v = k.startsWith('cf.') ? item.custom?.[k.slice(3)] : item[col[k] || k];
    return v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
  };
  const hasForm = layoutFor(cfg, item.type_id, 'transition', tr.id).length > 0;
  if (!hasForm && !needs.comment && ![...needs.required].some(empty)) {
    try {
      return finish(await send());
    } catch (err) {
      if (!err.needs) return toast(err.message, 'bad'), null;
      needs.keys = err.needs.filter((k) => k !== 'comment');
      needs.required = new Set(needs.keys);
      needs.comment = err.needs.includes('comment');
    }
  }
  const parents = needs.keys.includes('parent') ? await loadParents(cfg.project.id).catch(() => []) : [];
  const res = await formDialog({
    title: `${esc(tr.name)}: ${esc(item.key)} → ${esc(to.name)}`, submit: needs.approval && !can(b, cfg.project.id, 'approve') ? 'Ask for approval' : tr.name,
    body: `${tr.description ? `<p class="muted">${esc(tr.description)}</p>` : ''}
      <div class="form-grid">${needs.keys.map((k) => fieldInput(k, { b, cfg, item, parents, collaborators: [] }, { required: needs.required.has(k) })).join('')}</div>
      <div class="field"><label for="pm-move-comment">Comment${needs.comment ? ' <span class="pm-req">*</span>' : ' (optional)'}</label>
        <textarea id="pm-move-comment" name="comment" rows="3" ${needs.comment ? 'required' : ''}></textarea></div>`,
    onOpen: bindOrgPickers,
    onSubmit: (form) => send({ fields: readFields(form, cfg), comment: form.elements.comment.value.trim() }),
  });
  return res ? finish(res) : null;
}

/** A small menu of the moves available for an item (the accessible alternative to dragging). */
export const moveSelect = (cfg, item, label = 'Move to…') => {
  const moves = movesFor(cfg, item, cfg.who);
  if (!moves.length) return '';
  return `<select class="pm-move" data-move="${esc(item.id)}" aria-label="Move ${esc(item.key)}"><option value="">${esc(label)}</option>${moves
    .map((t) => `<option value="${esc(t.id)}">${esc(t.name)} → ${esc(cfg.statusById.get(t.to_status)?.name || '')}</option>`).join('')}</select>`;
};

// ---- filters ---------------------------------------------------------------------------------------
/**
 * The filter bar every list, board, timeline and calendar has. state: { q, owner, category, priority, type,
 * more (an advanced condition) }. onChange() when anything changes.
 */
export function filterBar(b, state, { types = [] } = {}) {
  const typeNames = [...new Set(types.filter((t) => !t.archived_at).map((t) => t.name))].sort();
  return `<div class="pm-filters" data-filters>
    <input type="search" data-f="q" placeholder="Search title, key, description" aria-label="Search" value="${esc(state.q || '')}">
    <select data-f="owner" aria-label="Owner">${opt('', 'Anyone', !state.owner)}${opt('me', 'Me', state.owner === 'me')}${opt('none', 'No owner', state.owner === 'none')}${b.people.map((p) => opt(p.id, p.full_name || p.email, p.id === state.owner)).join('')}</select>
    <select data-f="category" aria-label="Status">${opt('', 'Any status', !state.category)}${opt('open', 'Not done', state.category === 'open')}${CATEGORIES.map(([k, l]) => opt(k, l, state.category === k)).join('')}</select>
    <select data-f="type" aria-label="Kind">${opt('', 'Any kind', !state.type)}${typeNames.map((n) => opt(n, n, state.type === n)).join('')}</select>
    <select data-f="priority" aria-label="Priority">${opt('', 'Any priority', !state.priority)}${PRIORITIES.map(([k, l]) => opt(k, l, state.priority === k)).join('')}</select>
    <button type="button" class="btn btn-sm${state.more ? ' is-on' : ''}" data-more-filters>${state.more ? 'More filters ●' : 'More filters'}</button>
    ${Object.values(state).some(Boolean) ? '<button type="button" class="btn btn-sm btn-ghost" data-clear-filters>Clear</button>' : ''}
  </div>`;
}
/** The filter bar's state as a condition for pm_search. */
export function filterOf(state) {
  const all = [];
  if (state.owner === 'none') all.push({ f: 'unassigned' });
  else if (state.owner) all.push({ f: 'owner', v: state.owner });
  if (state.category === 'open') all.push({ f: 'category', op: 'ne', v: 'done' });
  else if (state.category) all.push({ f: 'category', v: state.category });
  if (state.type) all.push({ f: 'type_name', v: state.type });
  if (state.priority) all.push({ f: 'priority', v: state.priority });
  if (state.more) all.push(state.more);
  return all.length ? { all } : null;
}
export function bindFilterBar(root, b, state, onChange, ctx = {}) {
  const bar = root.querySelector('[data-filters]');
  if (!bar) return;
  let timer;
  bar.addEventListener('input', (e) => {
    const k = e.target.dataset.f;
    if (!k) return;
    state[k] = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(onChange, k === 'q' ? 300 : 0);
  });
  bar.addEventListener('click', async (e) => {
    if (e.target.closest('[data-clear-filters]')) {
      Object.keys(state).forEach((k) => (state[k] = k === 'more' ? null : ''));
      onChange();
    } else if (e.target.closest('[data-more-filters]')) {
      const next = await conditionDialog(b, state.more, ctx);
      if (next !== undefined) {
        state.more = next;
        onChange();
      }
    }
  });
}

/** The fields a condition can test, with the kind of value each takes. */
function conditionFields(b, { fields = [], statuses = [], sprints = [] } = {}) {
  const uniq = (list) => [...new Map(list.map((x) => [x[0], x])).values()];
  return [
    ['owner', 'Owner', 'person'], ['reporter', 'Reporter', 'person'], ['priority', 'Priority', PRIORITIES.map(([k, l]) => [k, l])],
    ['category', 'Status category', CATEGORIES], ['status_name', 'Status', uniq(statuses.map((s) => [s.name, s.name]))],
    ['division', 'CE division', b.divisions.map((d) => [d.id, d.name])], ['subsystem', 'Subsystem', b.subsystems.map((s) => [s.id, s.name])],
    ['project', 'Project', b.projects.map((p) => [p.id, p.name])], ['program', 'Program', b.programs.map((p) => [p.id, p.name])],
    ...(sprints.length ? [['sprint', 'Sprint', sprints.map((s) => [s.id, s.name])]] : []),
    ['labels', 'Label', 'text'], ['title', 'Title', 'text'], ['vehicle', 'Vehicle', 'text'], ['due', 'Due date', 'date'], ['start', 'Start date', 'date'],
    ['created', 'Created', 'date'], ['updated', 'Last changed', 'date'], ['completed', 'Finished on', 'date'], ['estimate', 'Estimate (hours)', 'number'], ['progress', 'Progress %', 'number'],
    ['blocked', 'Is blocked', 'flag'], ['overdue', 'Is overdue', 'flag'], ['open_deps', 'Is waiting on another item', 'flag'], ['milestone', 'Is a milestone', 'flag'],
    ['awaiting', 'Is awaiting approval', 'flag'], ['unassigned', 'Has no owner', 'flag'], ['mine', 'Is mine (owner or collaborator)', 'flag'], ['watching', 'I\'m watching it', 'flag'],
    ['accepted', 'Was formally accepted', 'flag'],
    ...fields.filter((f) => !f.archived_at && f.type !== 'formula').map((f) => [`cf.${f.key}`, f.name,
      ['select', 'multiselect'].includes(f.type) ? f.options.map((o) => [o, o]) : ['user', 'multiuser'].includes(f.type) ? 'person'
        : ['integer', 'decimal', 'currency', 'duration'].includes(f.type) ? 'number' : ['date', 'datetime'].includes(f.type) ? 'date' : f.type === 'checkbox' ? 'cfflag' : 'text']),
  ];
}
const OPS = {
  list: [['eq', 'is'], ['ne', 'is not'], ['empty', 'is empty'], ['notempty', 'is set']],
  text: [['contains', 'contains'], ['eq', 'is exactly'], ['ne', 'is not'], ['empty', 'is empty'], ['notempty', 'is set']],
  number: [['eq', '='], ['gt', 'more than'], ['gte', 'at least'], ['lt', 'less than'], ['lte', 'at most'], ['empty', 'is empty'], ['notempty', 'is set']],
  date: [['within', 'in the next … days'], ['last', 'in the last … days'], ['past', 'more than … days ago'], ['lt', 'before'], ['gt', 'after'], ['eq', 'on'], ['empty', 'is empty'], ['notempty', 'is set']],
  flag: [['is', 'yes'], ['ne', 'no']],
  cfflag: [['notempty', 'yes'], ['empty', 'no']],
};

/**
 * Build a condition: rows joined by "all of" / "any of", with groups one level down. Used for "More filters",
 * automation rules and workflow conditions. Resolves with the condition, null (none), or undefined if cancelled.
 */
export function conditionDialog(b, current, ctx = {}, title = 'Filter') {
  const defs = conditionFields(b, ctx);
  const kindOf = (f) => {
    const d = defs.find((x) => x[0] === f);
    return !d ? 'text' : Array.isArray(d[2]) ? 'list' : d[2] === 'person' ? 'list' : d[2];
  };
  const leaf = (c = {}) => ({ f: c.f || 'owner', op: c.op || '', v: c.v ?? '' });
  const toGroups = (c) => {
    if (!c) return { join: 'all', rows: [leaf()] };
    const join = c.any ? 'any' : 'all';
    const list = c.all || c.any || [c];
    return { join, rows: list.map((x) => (x.all || x.any ? { join: x.any ? 'any' : 'all', rows: (x.all || x.any).map(leaf) } : leaf(x))) };
  };
  const model = toGroups(current);
  const valueInput = (row, path) => {
    const d = defs.find((x) => x[0] === row.f);
    const kind = kindOf(row.f);
    const ops = OPS[kind];
    if (!ops.some(([o]) => o === row.op)) row.op = ops[0][0];
    const opSel = `<select data-op="${path}" aria-label="How">${ops.map(([o, l]) => opt(o, l, o === row.op)).join('')}</select>`;
    if (['empty', 'notempty', 'is'].includes(row.op) || kind === 'flag' || kind === 'cfflag') return opSel;
    let input;
    if (kind === 'list') {
      const options = d[2] === 'person' ? [['me', 'Me'], ...b.people.map((p) => [p.id, p.full_name || p.email])] : d[2];
      input = `<select data-val="${path}" aria-label="Value">${options.map(([v, l]) => opt(v, l, String(row.v) === String(v))).join('')}</select>`;
      if (!options.some(([v]) => String(v) === String(row.v))) row.v = options[0]?.[0] ?? '';
    } else if (kind === 'date' && !['within', 'last', 'past'].includes(row.op)) input = `<input type="date" data-val="${path}" value="${esc(row.v)}" aria-label="Date">`;
    else if (kind === 'number' || kind === 'date') input = `<input type="number" data-val="${path}" value="${esc(row.v === '' ? (kind === 'date' ? 7 : '') : row.v)}" aria-label="Number">`;
    else input = `<input type="text" data-val="${path}" value="${esc(row.v)}" aria-label="Value">`;
    return opSel + input;
  };
  const rowHtml = (row, path) => (row.rows
    ? `<div class="pm-cond-group" data-path="${path}"><div class="pm-cond-join"><select data-join="${path}" aria-label="Match">${opt('all', 'All of these', row.join === 'all')}${opt('any', 'Any of these', row.join === 'any')}</select>
        <button type="button" class="btn btn-sm btn-ghost" data-del="${path}" aria-label="Remove group">Remove group</button></div>
        ${row.rows.map((r, i) => rowHtml(r, `${path}.${i}`)).join('')}<button type="button" class="btn btn-sm" data-add="${path}">+ Condition</button></div>`
    : `<div class="pm-cond-row"><select data-field-pick="${path}" aria-label="Field">${defs.map(([k, l]) => opt(k, l, k === row.f)).join('')}</select>${valueInput(row, path)}
        <button type="button" class="btn btn-sm btn-ghost" data-del="${path}" aria-label="Remove condition">✕</button></div>`);
  const at = (path) => path.split('.').filter(Boolean).reduce((node, i) => node.rows[Number(i)], model);
  const draw = (form) => {
    form.querySelector('[data-cond]').innerHTML = `<div class="pm-cond-join"><select data-join="" aria-label="Match">${opt('all', 'All of these', model.join === 'all')}${opt('any', 'Any of these', model.join === 'any')}</select></div>
      ${model.rows.map((r, i) => rowHtml(r, String(i))).join('')}
      <div class="card-actions"><button type="button" class="btn btn-sm" data-add="">+ Condition</button><button type="button" class="btn btn-sm" data-add-group>+ Group</button></div>`;
  };
  const toCond = (node) => {
    if (node.rows) {
      const parts = node.rows.map(toCond).filter(Boolean);
      return parts.length ? { [node.join]: parts } : null;
    }
    const kind = kindOf(node.f);
    if (kind === 'flag') return node.op === 'ne' ? { f: node.f, v: false } : { f: node.f };
    if (['empty', 'notempty'].includes(node.op)) return { f: node.f, op: node.op };
    if (node.v === '' || node.v === null) return null;
    return { f: node.f, op: node.op, v: ['number'].includes(kind) || ['within', 'last', 'past'].includes(node.op) ? Number(node.v) : node.v };
  };
  return new Promise((resolve) => {
    let settled = false;
    formDialog({
      title: esc(title), submit: 'Apply', wide: true,
      body: `<div data-cond class="pm-cond"></div><p><button type="button" class="btn btn-sm btn-ghost" data-none>Remove all conditions</button></p>`,
      onOpen(form, dialog) {
        draw(form);
        form.addEventListener('change', (e) => {
          const t = e.target;
          if (t.dataset.join !== undefined) at(t.dataset.join).join = t.value;
          else if (t.dataset.fieldPick !== undefined) Object.assign(at(t.dataset.fieldPick), { f: t.value, op: '', v: '' });
          else if (t.dataset.op !== undefined) at(t.dataset.op).op = t.value;
          else if (t.dataset.val !== undefined) return void (at(t.dataset.val).v = t.value);
          else return;
          draw(form);
        });
        form.addEventListener('input', (e) => {
          if (e.target.dataset.val !== undefined) at(e.target.dataset.val).v = e.target.value;
        });
        form.addEventListener('click', (e) => {
          const t = e.target.closest('button');
          if (!t) return;
          if (t.dataset.add !== undefined) at(t.dataset.add).rows.push(leaf());
          else if (t.dataset.addGroup !== undefined) model.rows.push({ join: 'any', rows: [leaf(), leaf()] });
          else if (t.dataset.del !== undefined) {
            const parts = t.dataset.del.split('.');
            const i = Number(parts.pop());
            at(parts.join('.')).rows.splice(i, 1);
          } else if (t.dataset.none !== undefined) {
            settled = true;
            resolve(null);
            return dialog.close();
          } else return;
          draw(form);
        });
      },
      onSubmit: () => {
        settled = true;
        resolve(toCond(model));
      },
    }).then(() => !settled && resolve(undefined));
  });
}

/** Rows of items as a table. columns: keys from COLS. `cfgOf(item)` gives the item's project configuration (or null). */
export function itemTable(b, items, cfgOf, { columns = ['key', 'title', 'status', 'owner', 'priority', 'due_date'], select = false, empty = 'Nothing here.' } = {}) {
  if (!items.length) return `<div class="empty">${esc(empty)}</div>`;
  const COLS = {
    key: ['Key', (i) => `<a href="${itemHref(i.key)}" class="pm-keylink">${esc(i.key)}</a>`],
    title: ['Title', (i, c) => `${typeBadge(c?.typeById.get(i.type_id))} <a href="${itemHref(i.key)}">${esc(i.title)}</a>${i.blocked ? ' <span class="chip-tone tone-red" title="Blocked">⛔ Blocked</span>' : ''}${Number(i.open_deps) ? ` <span class="chip-tone tone-amber" title="Waiting on ${i.open_deps} other item(s)">⏳ ${i.open_deps}</span>` : ''}${Number(i.children) ? ` <span class="muted small" title="Items under it done">${i.children_done}/${i.children}</span>` : ''}`],
    status: ['Status', (i, c) => statusChip(c?.statusById.get(i.status_id))],
    owner: ['Owner', (i) => (i.owner_id ? esc(personName(b, i.owner_id)) : '<span class="muted">—</span>')],
    priority: ['Priority', (i) => priorityChip(i.priority) || '<span class="muted">Medium</span>'],
    due_date: ['Due', (i) => dueChip(i) || '<span class="muted">—</span>'],
    start_date: ['Start', (i) => esc(i.start_date ? fmtDate(i.start_date) : '—')],
    project: ['Project', (i) => `<a href="${projectHref(b.projectById.get(i.project_id)?.key || '')}">${esc(b.projectById.get(i.project_id)?.name || '')}</a>`],
    subsystem: ['Subsystem', (i) => esc(b.subsystemById.get(i.subsystem_id)?.name || b.divisionById.get(i.division_id)?.name || '—')],
    estimate_hours: ['Estimate', (i) => (i.estimate_hours === null ? '—' : `${Number(i.estimate_hours)} h`)],
    progress: ['Progress', (i) => `<progress max="100" value="${Number(i.progress)}" title="${Number(i.progress)}%"></progress>`],
    labels: ['Labels', (i) => (i.labels || []).map((l) => `<span class="chip">${esc(l)}</span>`).join(' ')],
    updated: ['Changed', (i) => esc(fmtDate(i.updated_at))],
  };
  const custom = (key) => (i, c) => {
    const f = c?.fields.find((x) => x.key === key.slice(3));
    const v = f?.type === 'formula' ? evalFormula(f.formula, i) : i.custom?.[key.slice(3)];
    if (v === undefined || v === null || v === '') return '<span class="muted">—</span>';
    if (['user', 'multiuser'].includes(f?.type)) return esc([].concat(v).map((id) => personName(b, id)).join(', '));
    return f?.type === 'url' ? `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">Open</a>` : esc(Array.isArray(v) ? v.join(', ') : v === true ? 'Yes' : v);
  };
  const cols = columns.map((k) => (COLS[k] ? [k, ...COLS[k]] : k.startsWith('cf.') ? [k, k.slice(3).replace(/_/g, ' '), custom(k)] : null)).filter(Boolean);
  return `<div class="table-wrap"><table class="pm-table"><thead><tr>${select ? '<th><input type="checkbox" data-select-all aria-label="Select all"></th>' : ''}${cols
    .map(([k, label]) => `<th data-col="${esc(k)}">${esc(label)}</th>`).join('')}</tr></thead><tbody>${items.map((i) => {
    const c = cfgOf(i);
    return `<tr data-item="${esc(i.id)}" class="${i.category === 'done' ? 'is-done' : ''}">${select ? `<td><input type="checkbox" data-select="${esc(i.id)}" aria-label="Select ${esc(i.key)}"></td>` : ''}${cols
      .map(([k, label, fn]) => `<td data-label="${esc(label)}" data-col="${esc(k)}">${fn(i, c)}</td>`).join('')}</tr>`;
  }).join('')}</tbody></table></div>`;
}
export const TABLE_COLUMNS = [['key', 'Key'], ['title', 'Title'], ['status', 'Status'], ['owner', 'Owner'], ['priority', 'Priority'], ['due_date', 'Due'], ['start_date', 'Start'],
  ['project', 'Project'], ['subsystem', 'Subsystem'], ['estimate_hours', 'Estimate'], ['progress', 'Progress'], ['labels', 'Labels'], ['updated', 'Changed']];

/** A configuration for items of several projects at once (cross-project pages): each item finds its own project's parts. */
export async function shapesFor(b, projectIds) {
  const s = await pm.shapes(projectIds);
  const per = new Map(projectIds.map((id) => [id, withLookups(b, b.projectById.get(id), {
    statuses: s.statuses.filter((x) => x.project_id === id), types: s.types.filter((x) => x.project_id === id),
    transitions: s.transitions.filter((x) => x.project_id === id), fields: s.fields.filter((x) => x.project_id === id),
    layouts: s.layouts.filter((x) => x.project_id === id), sprints: [], members: [], roles: [], views: [],
  })]));
  return { all: s, cfgOf: (item) => per.get(item.project_id) || null, per };
}
