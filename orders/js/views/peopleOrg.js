/**
 * Who is in which CE division and subsystem (migration 056). One editor, used in three places:
 *   * Admin → Divisions & people: everyone (people managers change anyone; people who can "Change people's
 *     subsystems (own divisions)" change the divisions they're in themselves);
 *   * My account: your own;
 *   * Admin → Users shows it under each name.
 * The database (set_person_org) decides who may change what; this page only offers what it would allow.
 */
import { supabase } from '../supabase.js';
import { auth } from '../auth.js';
import { esc, errorBox } from '../ui.js';

const ok = ({ data, error }) => {
  if (error) throw error;
  return data;
};

/** The divisions, subsystems and everyone's places. */
export async function loadOrg() {
  const [divs, subs, rows] = await Promise.all([
    supabase.from('org_divisions').select('id, name, sort, archived_at').order('sort').order('name').then(ok),
    supabase.from('org_subsystems').select('id, division_id, name, sort, archived_at').order('sort').order('name').then(ok),
    supabase.from('person_org').select('user_id, division_id, subsystem_id, main').then(ok),
  ]);
  const org = { divs, subs, byUser: new Map(), divById: new Map(divs.map((d) => [d.id, d])), subById: new Map(subs.map((s) => [s.id, s])) };
  for (const r of rows) org.byUser.set(r.user_id, [...(org.byUser.get(r.user_id) || []), r]);
  for (const list of org.byUser.values()) sortPlaces(org, list);
  return org;
}

function sortPlaces(org, list) {
  const order = (r) => [r.main ? 0 : 1, org.divById.get(r.division_id)?.sort ?? 0, org.divById.get(r.division_id)?.name || '', r.subsystem_id ? org.subById.get(r.subsystem_id)?.sort ?? 0 : -1, org.subById.get(r.subsystem_id)?.name || ''];
  list.sort((a, b) => {
    const x = order(a), y = order(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  });
  return list;
}

/** "Electrical · BMS", or "Electrical (whole division)". */
export function placeLabel(org, r) {
  const d = org.divById.get(r.division_id)?.name || 'A removed division';
  return r.subsystem_id ? `${d} · ${org.subById.get(r.subsystem_id)?.name || 'a removed subsystem'}` : `${d} (whole division)`;
}

/** One line for lists: "Electrical · BMS, Mechanical · Suspension", main first. */
export const orgText = (org, uid) => (org?.byUser.get(uid) || []).map((r) => placeLabel(org, r)).join(', ');

/** Which divisions the signed-in person may change for this person: 'all', or a Set of division ids. */
export function editableFor(org, uid) {
  if (uid === auth.user?.id || auth.can('users.manage')) return 'all';
  if (!auth.can('people.subsystems')) return new Set();
  return new Set((org.byUser.get(auth.user?.id) || []).map((r) => r.division_id));
}
const mayEdit = (scope, divisionId) => scope === 'all' || scope.has(divisionId);

/** The chips and the "Add…" picker for one person. */
export function orgEditorHTML(org, uid, { compact = false } = {}) {
  const scope = editableFor(org, uid);
  const mine = org.byUser.get(uid) || [];
  const chips = mine.map((r, i) => {
    const can = mayEdit(scope, r.division_id);
    return `<span class="org-chip${r.main ? ' is-main' : ''}" title="${r.main ? 'Main subsystem' : ''}">${r.main ? '<span aria-hidden="true">★</span> ' : ''}${esc(placeLabel(org, r))}
      ${can && !r.main && mine.length > 1 ? `<button type="button" class="org-x" data-org-main="${i}" title="Make this their main one" aria-label="Make ${esc(placeLabel(org, r))} the main one">☆</button>` : ''}
      ${can ? `<button type="button" class="org-x" data-org-remove="${i}" title="Remove" aria-label="Remove ${esc(placeLabel(org, r))}">×</button>` : ''}</span>`;
  }).join('');
  const has = (d, s) => mine.some((r) => r.division_id === d && (r.subsystem_id || null) === (s || null));
  const groups = org.divs.filter((d) => !d.archived_at && mayEdit(scope, d.id)).map((d) => {
    const opts = [!has(d.id, null) ? `<option value="d:${esc(d.id)}">${esc(d.name)} (whole division)</option>` : '']
      .concat(org.subs.filter((s) => s.division_id === d.id && !s.archived_at && !has(d.id, s.id)).map((s) => `<option value="s:${esc(s.id)}">${esc(s.name)}</option>`))
      .join('');
    return opts ? `<optgroup label="${esc(d.name)}">${opts}</optgroup>` : '';
  }).join('');
  const add = groups ? `<select class="org-add" data-org-add aria-label="Add a division or subsystem"><option value="">${compact ? 'Add…' : 'Add a subsystem…'}</option>${groups}</select>` : '';
  const empty = !mine.length ? `<span class="muted small">${scope === 'all' || (scope.size) ? 'None yet.' : 'None.'}</span>` : '';
  return `<div class="org-editor" data-org-editor="${esc(uid)}">${chips}${empty}${add}<span class="org-err" data-org-err></span></div>`;
}

/** Wire every editor in `root`. `onChange(uid)` runs after a save (e.g. to update a count). */
export function bindOrgEditors(root, org, onChange = () => {}) {
  const save = async (box, list) => {
    const uid = box.dataset.orgEditor;
    const err = box.querySelector('[data-org-err]');
    box.querySelectorAll('button, select').forEach((b) => (b.disabled = true));
    try {
      ok(await supabase.rpc('set_person_org', { p_user: uid, p_items: list.map((r) => (r.subsystem_id ? { subsystem_id: r.subsystem_id, main: !!r.main } : { division_id: r.division_id, main: !!r.main })) }));
      const fresh = ok(await supabase.from('person_org').select('user_id, division_id, subsystem_id, main').eq('user_id', uid));
      if (fresh.length) org.byUser.set(uid, sortPlaces(org, fresh)); else org.byUser.delete(uid);
      box.outerHTML = orgEditorHTML(org, uid, { compact: box.closest('[data-org-compact]') != null });
      onChange(uid);
    } catch (e) {
      box.querySelectorAll('button, select').forEach((b) => (b.disabled = false));
      if (err) err.innerHTML = errorBox(e);
    }
  };
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-org-remove], [data-org-main]');
    const box = btn?.closest('[data-org-editor]');
    if (!box) return;
    const list = (org.byUser.get(box.dataset.orgEditor) || []).map((r) => ({ ...r }));
    if (btn.dataset.orgRemove != null) list.splice(Number(btn.dataset.orgRemove), 1);
    else list.forEach((r, i) => (r.main = i === Number(btn.dataset.orgMain)));
    save(box, list);
  });
  root.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-org-add]');
    const box = sel?.closest('[data-org-editor]');
    if (!box || !sel.value) return;
    const [kind, id] = sel.value.split(':');
    const list = (org.byUser.get(box.dataset.orgEditor) || []).map((r) => ({ ...r }));
    list.push(kind === 's' ? { division_id: org.subById.get(id).division_id, subsystem_id: id, main: !list.length } : { division_id: id, subsystem_id: null, main: !list.length });
    save(box, list);
  });
}

/** My account: your own divisions and subsystems. */
export async function accountOrgSection(el, config) {
  const box = el.querySelector('#org-card');
  if (!box) return;
  if (Number(config?.schemaVersion) < 56 || auth.isGuest || auth.isFormer) { box.remove(); return; }
  try {
    const org = await loadOrg();
    if (!org.divs.some((d) => !d.archived_at)) {
      box.innerHTML = '<h2>Division & subsystems</h2><p class="muted small">Your team hasn\'t listed its divisions and subsystems yet (Admin → CE divisions & subsystems).</p>';
      return;
    }
    box.innerHTML = `<h2>Division & subsystems</h2>
      <p class="muted small">Which CE division and subsystems you work in. You can be in several; ★ is your main one. Solar Evals fills these in for you, and your CE and the team leads see them.</p>
      ${orgEditorHTML(org, auth.user.id)}`;
    bindOrgEditors(box, org);
  } catch (e) {
    box.innerHTML = `<h2>Division & subsystems</h2>${errorBox(e)}`;
  }
}

/** Admin → Divisions & people. */
export async function renderPeopleOrg(el, { config }, { adminHeader, listProfiles }) {
  const intro = 'Who is in which CE division and subsystem. People set their own in My account; people managers change anyone, and whoever can “Change people\'s subsystems (own divisions)” (Chief Engineers by default) changes the divisions they\'re in.';
  if (Number(config?.schemaVersion) < 56) {
    el.innerHTML = `${adminHeader('people')}<p class="alert alert-warning">This needs the database update 056_people_subsystems.sql.</p>`;
    return;
  }
  const [people, org] = await Promise.all([listProfiles(), loadOrg()]);
  const team = people.filter((p) => (p.roles || []).some((r) => r !== 'guest' && r !== 'alumni'));
  const scope = auth.can('users.manage') ? null : editableFor(org, '');
  const view = { division: '', q: '' };
  el.innerHTML = `${adminHeader('people', intro)}
    ${scope && !scope.size ? '<p class="alert alert-info">Put yourself in your division first (My account): then you can move people within it.</p>' : ''}
    ${!org.divs.some((d) => !d.archived_at) ? '<p class="alert alert-warning">There are no divisions yet. Add them in Admin → CE divisions & subsystems.</p>' : ''}
    <div class="toolbar org-toolbar">
      <label>Division <select data-org-filter><option value="">Everyone</option><option value="none">Not in any yet</option>${org.divs.filter((d) => !d.archived_at).map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select></label>
      <label>Search <input type="search" data-org-q placeholder="Name or email"></label>
      <span class="muted small" data-org-count></span>
    </div>
    <div class="table-wrap" data-org-compact><table class="table stack-mobile org-table">
      <thead><tr><th>Name</th><th>Positions</th><th>Divisions & subsystems</th></tr></thead>
      <tbody data-org-rows></tbody></table></div>`;
  const roleLabel = (k) => auth.roles.find((r) => r.key === k)?.label || k;
  const draw = () => {
    const q = view.q.toLowerCase();
    const shown = team.filter((p) => {
      const mine = org.byUser.get(p.id) || [];
      if (view.division === 'none' && mine.length) return false;
      if (view.division && view.division !== 'none' && !mine.some((r) => r.division_id === view.division)) return false;
      return !q || `${p.full_name || ''} ${p.email || ''}`.toLowerCase().includes(q);
    });
    el.querySelector('[data-org-rows]').innerHTML = shown.map((p) => `<tr>
        <td class="cell-primary" data-label=""><strong>${esc(p.full_name || p.email)}</strong><div class="muted small">${esc(p.email)}</div></td>
        <td data-label="Positions">${esc((p.roles || []).filter((r) => r !== 'member').map(roleLabel).join(', ') || 'Member')}</td>
        <td data-label="Divisions & subsystems">${orgEditorHTML(org, p.id, { compact: true })}</td></tr>`).join('')
      || '<tr><td colspan="3" class="empty">Nobody matches.</td></tr>';
    const none = team.filter((p) => !(org.byUser.get(p.id) || []).length).length;
    el.querySelector('[data-org-count]').textContent = `${shown.length} of ${team.length} people · ${none} not in any division yet`;
  };
  el.querySelector('[data-org-filter]').addEventListener('change', (e) => { view.division = e.target.value; draw(); });
  el.querySelector('[data-org-q]').addEventListener('input', (e) => { view.q = e.target.value; draw(); });
  bindOrgEditors(el, org, () => {
    const none = team.filter((p) => !(org.byUser.get(p.id) || []).length).length;
    el.querySelector('[data-org-count]').textContent = el.querySelector('[data-org-count]').textContent.replace(/\d+ not in any/, `${none} not in any`);
  });
  draw();
}
