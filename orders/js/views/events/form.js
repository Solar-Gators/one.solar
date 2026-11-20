/**
 * Events → New event / Edit event / Duplicate. Who's invited (everyone, divisions, subsystems, positions or
 * people), the host and co-hosts, RSVP / walk-in / late options, and the sign-in questions (with saved sets).
 */
import { auth } from '../../auth.js';
import { esc, setFlash, errorBox, askText } from '../../ui.js';
import { ev } from '../../events/api.js';
import { toLocalInput, fromLocalInput, newQuestionId } from '../../events/core.js';
import { guardLeaving, releaseGuard } from '../../leaveGuard.js';
import { loadBase, needsDatabase, header, mayCreate, runs, eventHref, invalidate, toast, attempt } from './kit.js';

const TYPES = [['text', 'Text'], ['check', 'Yes / no (tick box)'], ['select', 'Pick one'], ['number', 'Number']];
const opt = (v, label, on) => `<option value="${esc(v)}" ${on ? 'selected' : ''}>${esc(label)}</option>`;
const check = (name, v, label, on, extra = '') => `<label class="pm-check"><input type="checkbox" name="${name}" value="${esc(v)}" ${on ? 'checked' : ''} ${extra}> ${esc(label)}</label>`;

/** A searchable list of people with tick boxes. */
export function peoplePicker(b, name, picked = [], { label = 'Find someone' } = {}) {
  const on = new Set(picked);
  return `<div class="ev-people" data-people="${name}">
    <input type="search" class="ev-people-find" placeholder="${esc(label)}…" aria-label="${esc(label)}">
    <div class="ev-people-list">${b.people.map((p) => `<label class="pm-check" data-name="${esc((p.full_name || p.email).toLowerCase())}">
      <input type="checkbox" name="${name}" value="${esc(p.id)}" ${on.has(p.id) ? 'checked' : ''}> ${esc(p.full_name || p.email)}</label>`).join('')}</div>
    <p class="hint" data-people-count></p></div>`;
}
export function bindPeoplePicker(root) {
  root.querySelectorAll('[data-people]').forEach((box) => {
    const count = () => {
      const n = box.querySelectorAll('input[type=checkbox]:checked').length;
      box.querySelector('[data-people-count]').textContent = n ? `${n} picked` : '';
    };
    box.querySelector('.ev-people-find').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      box.querySelectorAll('[data-name]').forEach((l) => (l.hidden = !!q && !l.dataset.name.includes(q) && !l.querySelector('input').checked));
    });
    box.addEventListener('change', count);
    count();
  });
}

/** One sign-in question's row. */
const questionRow = (q) => `<li class="ev-q" data-q="${esc(q.id || newQuestionId())}">
  <input type="text" class="ev-q-label" maxlength="200" placeholder="Question, e.g. What did you work on?" value="${esc(q.label || '')}" aria-label="Question">
  <select class="ev-q-type" aria-label="Kind of answer">${TYPES.map(([v, l]) => opt(v, l, (q.type || 'text') === v)).join('')}</select>
  <label class="pm-check"><input type="checkbox" class="ev-q-req" ${q.required ? 'checked' : ''}> Required</label>
  <button type="button" class="btn btn-ghost btn-sm" data-q-up title="Move up" aria-label="Move up">↑</button>
  <button type="button" class="btn btn-ghost btn-sm" data-q-remove title="Remove" aria-label="Remove question">✕</button>
  <input type="text" class="ev-q-options" placeholder="Choices, separated by commas" value="${esc((q.options || []).join(', '))}" aria-label="Choices" ${(q.type || 'text') === 'select' ? '' : 'hidden'}>
</li>`;
export const questionsEditor = (questions = []) => `<ol class="ev-questions" data-questions>${questions.map(questionRow).join('')}</ol>
  <button type="button" class="btn btn-sm" data-q-add>+ Add a question</button>`;
export function bindQuestions(root, changed = () => {}) {
  const list = root.querySelector('[data-questions]');
  root.querySelector('[data-q-add]').addEventListener('click', () => {
    list.insertAdjacentHTML('beforeend', questionRow({}));
    list.lastElementChild.querySelector('.ev-q-label').focus();
    changed();
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.ev-q');
    if (e.target.closest('[data-q-remove]')) row.remove();
    if (e.target.closest('[data-q-up]') && row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
    changed();
  });
  list.addEventListener('change', (e) => {
    if (e.target.matches('.ev-q-type')) e.target.closest('.ev-q').querySelector('.ev-q-options').hidden = e.target.value !== 'select';
  });
}
export const readQuestions = (root) => [...root.querySelectorAll('.ev-q')].map((r) => ({
  id: r.dataset.q, label: r.querySelector('.ev-q-label').value.trim(), type: r.querySelector('.ev-q-type').value,
  required: r.querySelector('.ev-q-req').checked, options: r.querySelector('.ev-q-options').value.split(',').map((s) => s.trim()).filter(Boolean),
})).filter((q) => q.label);

export async function renderEventForm(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  const editing = ctx.params.id;
  const copyOf = ctx.params.query.get('copy');
  const [b, templates, source] = await Promise.all([loadBase(), ev.templates().catch(() => []), editing || copyOf ? ev.event(editing || copyOf) : null]);
  if ((editing || copyOf) && !source) {
    el.innerHTML = '<section class="card no-access"><h1>Event not found</h1><p>It may have been deleted, or you aren\'t invited to it.</p><a class="btn" href="#/events">My events</a></section>';
    return;
  }
  if (editing ? !runs(source) : !mayCreate()) {
    el.innerHTML = `<section class="card no-access"><h1>You can't ${editing ? 'edit this event' : 'create events'}</h1>
      <p>${editing ? 'Only its host, its co-hosts or an Admin can.' : 'Your role needs "Create events". Leads and up have it; ask an Admin.'}</p><a class="btn" href="#/events">My events</a></section>`;
    return;
  }
  // Duplicate: the same event a week later.
  const week = (iso) => (iso ? new Date(new Date(iso).getTime() + 7 * 864e5).toISOString() : '');
  const e = source ? { ...source, ...(copyOf ? { title: source.title, starts_at: week(source.starts_at), ends_at: week(source.ends_at), host_id: auth.user?.id, cohosts: source.cohosts } : {}) }
    : { title: '', invite: { all: true }, ask_rsvp: true, allow_walkins: true, questions: [], host_id: auth.user?.id, cohosts: [] };
  const inv = e.invite || {};
  const everyone = !!inv.all;
  const cats = b.categories.filter((c) => !c.archived_at || c.id === e.category_id);
  const divs = b.divisions.filter((d) => !d.archived_at);

  el.innerHTML = `${header(editing ? `Edit ${esc(source.title)}` : copyOf ? `Duplicate ${esc(source.title)}` : 'New event',
    copyOf ? 'Same set-up, a week later. Change anything before saving.' : '')}
    <form class="card ev-form" novalidate>
      <div class="pm-dialog-error" aria-live="polite"></div>
      <fieldset><legend>What and when</legend>
      <div class="form-grid">
        <div class="field span-4"><label for="ev-title">Title</label><input id="ev-title" name="title" maxlength="120" required value="${esc(e.title)}" placeholder="e.g. Fall town hall"></div>
        <div class="field span-2"><label for="ev-cat">Category</label><select id="ev-cat" name="category">${opt('', 'None', !e.category_id)}${cats.map((c) => opt(c.id, c.name, c.id === e.category_id)).join('')}</select></div>
        <div class="field span-2"><label for="ev-loc">Where</label><input id="ev-loc" name="location" maxlength="200" value="${esc(e.location || '')}" placeholder="e.g. NEB 100"></div>
        <div class="field span-2"><label for="ev-start">Starts</label><input id="ev-start" name="starts" type="datetime-local" required value="${esc(toLocalInput(e.starts_at))}"></div>
        <div class="field span-2"><label for="ev-end">Ends <span class="muted">(optional)</span></label><input id="ev-end" name="ends" type="datetime-local" value="${esc(toLocalInput(e.ends_at))}"></div>
        <div class="field span-4"><label for="ev-notes">Notes <span class="muted">(what to bring, the agenda…)</span></label><textarea id="ev-notes" name="notes" rows="3" maxlength="5000">${esc(e.notes || '')}</textarea></div>
      </div></fieldset>

      <fieldset><legend>Who's invited</legend>
        <div class="ev-invite-mode">
          <label class="pm-check"><input type="radio" name="mode" value="all" ${everyone ? 'checked' : ''}> Everyone on the team</label>
          <label class="pm-check"><input type="radio" name="mode" value="some" ${everyone ? '' : 'checked'}> Choose divisions, subsystems, positions or people</label>
        </div>
        <div class="ev-invite-some" ${everyone ? 'hidden' : ''}>
          ${divs.length ? `<div class="field"><span class="label">Divisions and subsystems <span class="muted">(everyone in them)</span></span>
            <div class="ev-org">${divs.map((d) => `<div class="ev-org-div">${check('division', d.id, d.name, (inv.divisions || []).includes(d.id))}
              <div class="ev-org-subs">${b.subsystems.filter((s) => s.division_id === d.id && !s.archived_at).map((s) => check('subsystem', s.id, s.name, (inv.subsystems || []).includes(s.id))).join('')}</div></div>`).join('')}</div></div>`
            : '<p class="hint">No divisions yet (Admin → CE divisions &amp; subsystems).</p>'}
          <div class="field"><span class="label">Positions</span><div class="pm-checks">${b.positions.map((r) => check('role', r.key, r.label, (inv.roles || []).includes(r.key))).join('')}</div></div>
          <div class="field"><span class="label">People</span>${peoplePicker(b, 'person', inv.people || [])}</div>
        </div>
        <label class="pm-check"><input type="checkbox" name="notify"> Email the people invited${editing ? ' (only those newly invited by this change)' : ''}</label>
        <p class="hint">Invitations always show in their Events. The email needs notifications on (Admin → Notifications → Event invitations).</p>
      </fieldset>

      <fieldset><legend>Hosts</legend>
      <div class="form-grid">
        <div class="field span-2"><label for="ev-host">Host</label><select id="ev-host" name="host">${b.people.map((p) => opt(p.id, p.full_name || p.email, p.id === e.host_id)).join('')}</select></div>
        <div class="field span-4"><span class="label">Co-hosts <span class="muted">(they can edit it and run check-in too)</span></span>${peoplePicker(b, 'cohost', e.cohosts || [], { label: 'Find a co-host' })}</div>
      </div></fieldset>

      <fieldset><legend>Options</legend>
        <label class="pm-check"><input type="checkbox" name="ask_rsvp" ${e.ask_rsvp ? 'checked' : ''}> Ask people if they're coming (RSVP)</label>
        <label class="pm-check"><input type="checkbox" name="walkins" ${e.allow_walkins ? 'checked' : ''}> Members who weren't invited may check in (shown as walk-ins)</label>
        <div class="field ev-late"><label for="ev-late">Count as late after</label>
          <input id="ev-late" name="late" type="number" min="0" max="600" step="1" value="${e.late_after_min ?? ''}" placeholder="never"> <span class="muted">minutes from the start</span></div>
      </fieldset>

      <fieldset><legend>Sign-in questions</legend>
        <p class="hint">Asked when someone checks in. Leave empty to just tap "I'm here".</p>
        ${templates.length ? `<div class="field ev-template"><label for="ev-tpl">Add a saved set</label><select id="ev-tpl">${opt('', 'Pick a set…', true)}${templates.map((t) => opt(t.id, `${t.name} (${t.questions.length})`, false)).join('')}</select></div>` : ''}
        ${questionsEditor(e.questions || [])}
        ${mayCreate() ? '<button type="button" class="btn btn-ghost btn-sm" data-save-set>Save these questions as a set</button>' : ''}
      </fieldset>

      <div class="form-actions">
        <a class="btn btn-ghost" href="${editing ? eventHref(editing) : '#/events'}">Cancel</a>
        <button type="submit" class="btn btn-primary" data-submit>${editing ? 'Save changes' : 'Create event'}</button>
      </div>
    </form>`;

  const form = el.querySelector('form');
  bindPeoplePicker(form);
  let dirty = false;
  guardLeaving(el, () => dirty);
  bindQuestions(form, () => (dirty = true));
  form.addEventListener('input', () => (dirty = true));
  form.addEventListener('change', () => (dirty = true));
  form.querySelectorAll('[name=mode]').forEach((r) => r.addEventListener('change', () => (form.querySelector('.ev-invite-some').hidden = form.elements.mode.value === 'all')));
  form.querySelector('#ev-tpl')?.addEventListener('change', (x) => {
    const t = templates.find((y) => y.id === x.target.value);
    if (!t) return;
    const list = form.querySelector('[data-questions]');
    list.insertAdjacentHTML('beforeend', t.questions.map((q) => questionRow({ ...q, id: newQuestionId() })).join(''));
    x.target.value = '';
    toast(`Added ${t.questions.length} question${t.questions.length === 1 ? '' : 's'} from "${t.name}"`);
  });
  form.querySelector('[data-save-set]')?.addEventListener('click', async () => {
    const questions = readQuestions(form);
    if (!questions.length) return toast('Add a question first.', 'bad');
    const name = await askText({ title: 'Save as a set', label: 'Name', placeholder: 'e.g. Testing day sign-in', ok: 'Save' });
    if (name) await attempt(() => ev.saveTemplate(null, { name, questions }), `Saved "${name}"`);
  });

  const picked = (name) => [...form.querySelectorAll(`[name=${name}]:checked`)].map((i) => i.value);
  form.addEventListener('submit', async (x) => {
    x.preventDefault();
    const btn = form.querySelector('[data-submit]');
    const err = form.querySelector('.pm-dialog-error');
    if (!form.checkValidity()) return form.reportValidity();
    const f = form.elements;
    const invite = f.mode.value === 'all' ? { all: true } : { divisions: picked('division'), subsystems: picked('subsystem'), roles: picked('role'), people: picked('person') };
    if (f.ends.value && f.ends.value < f.starts.value) {
      err.innerHTML = errorBox(new Error('The end is before the start.'));
      return;
    }
    const p = {
      title: f.title.value.trim(), category_id: f.category.value, location: f.location.value.trim(), notes: f.notes.value,
      starts_at: fromLocalInput(f.starts.value), ends_at: fromLocalInput(f.ends.value), invite, host_id: f.host.value, cohosts: picked('cohost'),
      ask_rsvp: f.ask_rsvp.checked, allow_walkins: f.walkins.checked, late_after_min: f.late.value === '' ? '' : String(Math.round(Number(f.late.value))),
      questions: readQuestions(form), notify: f.notify.checked,
    };
    btn.disabled = true;
    err.innerHTML = '';
    try {
      const saved = await ev.save(editing || null, p);
      invalidate();
      releaseGuard();
      setFlash(editing ? 'Saved.' : `Created "${saved.title}".`);
      location.hash = eventHref(saved.id);
    } catch (e2) {
      btn.disabled = false;
      err.innerHTML = errorBox(e2);
      err.scrollIntoView({ block: 'center' });
    }
  });
}
