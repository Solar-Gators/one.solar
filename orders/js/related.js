/**
 * Links between one.solar apps (migration 068, the link registry). Any page can use this; nothing here knows
 * about a particular app. Each kind of record is a row in os_link_types; its app says, through two database
 * functions, what matches a search and what each record is now (code, title, status, tone, detail, path).
 * Every read uses the person's own access, and each app decides what they may see. See docs/integrations.md.
 */
import { supabase } from './supabase.js';
import { auth } from './auth.js';
import { esc } from './ui.js';
import { appUrl } from '../../shared/onesolar.js';
export { linkFromUrl, exactFirst } from './linkParse.js';

function unwrap({ data, error }) {
  if (error) {
    const err = new Error(error.message || 'Something went wrong.');
    err.code = error.code || '';
    throw err;
  }
  return data;
}

let typesCache = null;
/** The kinds of record that can be linked, in order: [{ key, app, label, noun, add_label, search_hint, note_hint }]. */
export async function linkTypes() {
  typesCache ||= supabase.from('os_link_types').select('key, app, label, noun, add_label, search_hint, note_hint, sort')
    .eq('active', true).order('sort').then(unwrap).catch((e) => ((typesCache = null), Promise.reject(e)));
  return typesCache;
}

/** Records of one kind matching what was typed (at most 12). Throws if the person can't use that kind. */
export const searchLinks = async (kind, q) => unwrap(await supabase.rpc('os_link_search', { p_kind: kind, p_q: q }));

/** Records by id, as they are now, for several kinds at once: Map(kind → Map(id → row)). Unknown or hidden ones are left out. */
export async function describeLinks(refs) {
  const byKind = new Map();
  for (const r of refs) (byKind.get(r.kind) || byKind.set(r.kind, new Set()).get(r.kind)).add(r.ref_id);
  const out = new Map();
  await Promise.all([...byKind].map(async ([kind, ids]) => {
    const rows = await supabase.rpc('os_link_describe', { p_kind: kind, p_ids: [...ids] }).then(unwrap).catch(() => []);
    out.set(kind, new Map((rows || []).map((x) => [x.id, x])));
  }));
  return out;
}

/** How a matching record reads in a picker: "SG27-900 · Nickel strip (Ordered)". */
export const linkOption = (r) => `${r.code ? `${r.code} · ` : ''}${r.title}${r.status ? ` (${r.status})` : ''}`;

/** The other side: the Projects items linked to a record that this person can see: [{ id, key, title }]. */
export async function linkedProjectItems(kind, refId) {
  // two plain reads (no embedded select), each limited by Projects' own row security
  const ids = [...new Set((unwrap(await supabase.from('pm_refs').select('item_id').eq('kind', kind).eq('ref_id', refId)) || []).map((x) => x.item_id))];
  if (!ids.length) return [];
  return unwrap(await supabase.from('pm_items').select('id, key, title').in('id', ids).order('key')) || [];
}

const PM_PERMS = ['projects.view', 'projects.create', 'projects.manage'];
/**
 * V2: a "Projects" card on another app's record page (an event, a sponsor): the Projects items linked to it, with
 * their status now. Only for people who can open Projects, and only items they can see; nothing shows otherwise.
 * Filled in after the page shows.
 */
export async function projectsCard(box, kind, refId) {
  if (!box || !PM_PERMS.some((p) => auth.can(p))) return;
  const items = await linkedProjectItems(kind, refId).catch(() => []);
  if (!items.length || !box.isConnected) return;
  const live = (await describeLinks(items.map((i) => ({ kind: 'item', ref_id: i.id })))).get('item') || new Map();
  if (!box.isConnected) return;
  box.innerHTML = `<section class="card"><h2>Projects</h2><ul class="plain-list">${items.map((i) => {
    const d = live.get(i.id);
    return `<li><a href="${esc(appUrl(`projects/#/projects/item/${encodeURIComponent(i.key)}`))}">${esc(i.key)}</a> ${esc(i.title)}${d?.status ? ` <span class="chip-tone tone-${esc(d.tone || 'gray')}">${esc(d.status)}</span>` : ''}</li>`;
  }).join('')}</ul><p class="hint">Project work linked to this ${kind === 'event' ? 'event' : 'sponsor'}.</p></section>`;
}
