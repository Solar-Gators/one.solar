/**
 * Events → Categories & questions ("Create events"): the team's event categories (Town hall, Testing day…) and
 * the saved sets of sign-in questions.
 */
import { esc, COLOR_TONES } from '../../ui.js';
import { ev } from '../../events/api.js';
import { loadBase, needsDatabase, header, mayCreate, invalidate, attempt, formDialog } from './kit.js';
import { questionsEditor, bindQuestions, readQuestions } from './form.js';

const TONES = COLOR_TONES.filter((t) => !t.key.endsWith('-strong'));

export async function renderEventSetup(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  const [b, templates] = await Promise.all([loadBase({ fresh: true }), ev.templates()]);
  const may = mayCreate();
  const cats = [...b.categories].sort((a, z) => (!!a.archived_at - !!z.archived_at) || a.sort - z.sort);
  el.innerHTML = `${header('Categories & questions', 'The kinds of events the stats can be filtered by, and sign-in questions to reuse.')}
    <section class="card"><div class="card-head"><h2>Categories</h2>${may ? '<button type="button" class="btn btn-sm" data-add-cat>+ Add a category</button>' : ''}</div>
      <ul class="ev-setup-list">${cats.map((c) => `<li class="${c.archived_at ? 'is-archived' : ''}" data-cat="${esc(c.id)}">
        <span class="chip-tone tone-${esc(c.color)}">${esc(c.name)}</span>${c.archived_at ? ' <span class="muted small">(retired)</span>' : ''}
        ${may ? `<span class="ev-setup-actions"><button type="button" class="btn btn-ghost btn-sm" data-edit-cat>Edit</button>
          <button type="button" class="btn btn-ghost btn-sm" data-retire-cat>${c.archived_at ? 'Bring back' : 'Retire'}</button></span>` : ''}</li>`).join('')}</ul>
      <p class="hint">Retiring a category keeps it on past events; it just isn't offered for new ones.</p></section>
    <section class="card"><div class="card-head"><h2>Saved sign-in questions</h2>${may ? '<button type="button" class="btn btn-sm" data-add-set>+ New set</button>' : ''}</div>
      ${templates.length ? `<ul class="ev-setup-list">${templates.map((t) => `<li data-set="${esc(t.id)}"><strong>${esc(t.name)}</strong>
        <span class="muted small">${t.questions.map((q) => esc(q.label)).join(' · ')}</span>
        ${may ? `<span class="ev-setup-actions"><button type="button" class="btn btn-ghost btn-sm" data-edit-set>Edit</button><button type="button" class="btn btn-ghost btn-sm" data-delete-set>Delete</button></span>` : ''}</li>`).join('')}</ul>`
        : '<p class="empty">None yet. Save a set from an event\'s form ("Save these questions as a set"), or make one here.</p>'}</section>`;

  const catDialog = (c = null) => formDialog({
    title: c ? `Edit ${esc(c.name)}` : 'New category',
    body: `<div class="field"><label for="cat-name">Name</label><input id="cat-name" name="name" maxlength="40" required value="${esc(c?.name || '')}" placeholder="e.g. Competition prep"></div>
      <div class="field"><label for="cat-color">Color</label><select id="cat-color" name="color">${TONES.map((t) => `<option value="${t.key}" ${(c?.color || 'blue') === t.key ? 'selected' : ''}>${t.label}</option>`).join('')}</select></div>`,
    onSubmit: (f) => ev.saveCategory(c?.id || null, { name: f.elements.name.value.trim(), color: f.elements.color.value }),
  });
  const setDialog = (t = null) => formDialog({
    title: t ? `Edit ${esc(t.name)}` : 'New set of sign-in questions', wide: true,
    body: `<div class="field"><label for="set-name">Name</label><input id="set-name" name="name" maxlength="80" required value="${esc(t?.name || '')}" placeholder="e.g. Testing day sign-in"></div>
      ${questionsEditor(t?.questions || [{}])}`,
    onOpen: (f) => bindQuestions(f),
    onSubmit: (f) => {
      const questions = readQuestions(f);
      if (!questions.length) throw new Error('Add at least one question.');
      return ev.saveTemplate(t?.id || null, { name: f.elements.name.value.trim(), questions });
    },
  });
  const done = () => (invalidate(), ctx.rerender());
  el.querySelector('[data-add-cat]')?.addEventListener('click', async () => (await catDialog()) && done());
  el.querySelector('[data-add-set]')?.addEventListener('click', async () => (await setDialog()) && done());
  el.addEventListener('click', async (x) => {
    const cat = b.categoryById.get(x.target.closest('[data-cat]')?.dataset.cat);
    const set = templates.find((t) => t.id === x.target.closest('[data-set]')?.dataset.set);
    if (x.target.closest('[data-edit-cat]') && (await catDialog(cat))) done();
    if (x.target.closest('[data-retire-cat]') && (await attempt(() => ev.saveCategory(cat.id, { archived: !cat.archived_at }), cat.archived_at ? 'Brought back' : 'Retired'))) done();
    if (x.target.closest('[data-edit-set]') && (await setDialog(set))) done();
    if (x.target.closest('[data-delete-set]') && confirm(`Delete the set "${set.name}"? Events that used it keep their questions.`)
      && (await attempt(() => ev.saveTemplate(set.id, { archived: true }), 'Deleted'))) done();
  });
}
