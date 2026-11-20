/**
 * Projects' data access (migration 051). Reads come straight from the pm_ tables (row-level security shows each
 * person only the projects they can see) or from pm_search; every change is a database function that checks
 * the person's project role and the project's own configuration.
 */
import { supabase } from '../supabase.js';
import { allPages } from '../api.js';

function toError(e) {
  const err = new Error(e.message || 'Something went wrong.');
  err.code = e.code || '';
  err.conflict = e.code === 'OS409';   // someone else changed it first
  err.duplicate = e.code === 'OS412';
  err.needs = null;                    // OS428: what's missing (field keys, or the statuses to map)
  if (e.code === 'OS428') {
    try {
      err.needs = JSON.parse(e.details);
    } catch {
      err.needs = [];
    }
  }
  err.details = [];
  return err;
}
function unwrap({ data, error }) {
  if (error) throw toError(error);
  return data;
}
const rows = async (build) => unwrap(await allPages(build));
const call = async (fn, args) => unwrap(await supabase.rpc(fn, args));
/** 063: { projects: [ids] } (the car cycles shown) as a filter on the project; one project (p.project) wins. */
const only = ({ projects, ...p }) => (!projects || p.project ? p
  : { ...p, filter: { all: [...(p.filter ? [p.filter] : []), { f: 'project', op: 'in', v: projects.length ? projects : ['00000000-0000-0000-0000-000000000000'] }] } });
const of = (table, projectId, order = 'id') => rows(() => supabase.from(table).select('*').eq('project_id', projectId).order(order).order('id'));

export const pm = {
  // ---- reading ----
  projects: () => rows(() => supabase.from('pm_projects').select('*').order('name').order('id')),
  programs: () => rows(() => supabase.from('pm_programs').select('*').order('sort').order('name').order('id')),
  myCaps: () => call('pm_my_caps'),
  /** My project role in each project I've been added to. */
  myRoles: async (userId) => (userId ? unwrap(await supabase.from('pm_members').select('project_id, role_id').eq('user_id', userId).order('project_id')) : []),
  /** Where I am on the team (056): my divisions and subsystems, my main one first. Empty before 056 or for guests. */
  myOrg: async (userId) => (userId ? unwrap(await supabase.from('person_org').select('division_id, subsystem_id, main').eq('user_id', userId).order('main', { ascending: false })) : []),
  prefs: () => rows(() => supabase.from('pm_prefs').select('*').order('user_id')),
  templates: async () => unwrap(await supabase.from('pm_templates').select('id, name, description, version, created_by, updated_at, archived_at').is('archived_at', null).order('name')),
  template: async (id) => unwrap(await supabase.from('pm_templates').select('*').eq('id', id).maybeSingle()),
  divisions: () => rows(() => supabase.from('org_divisions').select('*').order('sort').order('name').order('id')),
  subsystems: () => rows(() => supabase.from('org_subsystems').select('*').order('sort').order('name').order('id')),

  /** Everything that says how a project works. */
  async config(projectId) {
    const [roles, members, workflows, statuses, transitions, types, fields, layouts, sprints, views, automations] = await Promise.all([
      of('pm_roles', projectId, 'sort'), rows(() => supabase.from('pm_members').select('*').eq('project_id', projectId).order('user_id')),
      of('pm_workflows', projectId, 'created_at'), of('pm_statuses', projectId, 'sort'), of('pm_transitions', projectId, 'sort'), of('pm_types', projectId, 'sort'),
      of('pm_fields', projectId, 'sort'), of('pm_layouts', projectId), of('pm_sprints', projectId, 'created_at'), of('pm_views', projectId, 'name'),
      of('pm_automations', projectId, 'created_at'),
    ]);
    return { roles, members, workflows, statuses, transitions, types, fields, layouts, sprints, views, automations };
  },
  /** Statuses and types of several projects at once (cross-project boards and timelines). */
  async shapes(projectIds) {
    if (!projectIds.length) return { statuses: [], types: [], transitions: [], fields: [], layouts: [] };
    const get = (t) => rows(() => supabase.from(t).select('*').in('project_id', projectIds).order('id'));
    const [statuses, types, transitions, fields, layouts] = await Promise.all([get('pm_statuses'), get('pm_types'), get('pm_transitions'), get('pm_fields'), get('pm_layouts')]);
    return { statuses, types, transitions, fields, layouts };
  },
  search: (p) => call('pm_search', { p: only(p) }),
  /** Every item matching a filter, a page at a time, up to `max` (boards, timelines, calendars). */
  async searchAll(p, max = 3000) {
    const items = [];
    let total = 0;
    for (let offset = 0; offset < max; offset += 1000) {
      const page = await call('pm_search', { p: { ...only(p), limit: 1000, offset } });
      total = page.total;
      items.push(...page.items);
      if (items.length >= total || !page.items.length) break;
    }
    return { items, total };
  },
  /** An item by its name (BAT-24), also by a name it had before it moved projects. */
  async itemByKey(key) {
    const hit = unwrap(await supabase.from('pm_items').select('*').eq('key', key).maybeSingle());
    if (hit) return hit;
    const alias = unwrap(await supabase.from('pm_item_aliases').select('item_id').eq('key', key).maybeSingle());
    return alias ? unwrap(await supabase.from('pm_items').select('*').eq('id', alias.item_id).maybeSingle()) : null;
  },
  itemsByIds: async (ids) => (ids.length ? unwrap(await supabase.from('pm_items').select('id, key, title, project_id, status_id, category, owner_id, start_date, due_date, type_id, completed_at, actual_start, estimate_hours').in('id', ids)) : []),
  /** Everything shown on an item's page. */
  async itemExtras(id) {
    const by = (t, order = 'id', asc = true) => supabase.from(t).select('*').eq('item_id', id).order(order, { ascending: asc });
    const [people, checklist, comments, events, depsIn, depsOut, approvals, links, refs, children] = await Promise.all([
      by('pm_people', 'user_id'), by('pm_checklist', 'sort'), by('pm_comments', 'created_at'), by('pm_events', 'id', false).limit(200),
      supabase.from('pm_deps').select('*').eq('to_item', id).order('created_at'), supabase.from('pm_deps').select('*').eq('from_item', id).order('created_at'),
      by('pm_approvals', 'requested_at', false).limit(20), by('pm_resource_links', 'added_at'), by('pm_refs', 'created_at'),
      supabase.from('pm_items').select('id, key, title, status_id, category, owner_id, type_id, due_date').eq('parent_id', id).is('archived_at', null).order('rank'),
    ].map(async (q) => unwrap(await q)));
    const resources = links.length ? unwrap(await supabase.from('pm_resources').select('*').in('id', links.map((l) => l.resource_id))) : [];
    return { people, checklist, comments, events, depsIn, depsOut, approvals, links, resources, refs, children };
  },
  /** Dependencies with either end in these projects. */
  async deps(projectIds) {
    if (!projectIds.length) return [];
    const [a, b] = await Promise.all(['from_project', 'to_project'].map((col) => rows(() => supabase.from('pm_deps').select('*').in(col, projectIds).order('id'))));
    return [...new Map([...a, ...b].map((d) => [d.id, d])).values()];
  },
  events: async ({ projectIds, since, kinds, limit = 300 }) => {
    let q = supabase.from('pm_events').select('*');
    if (projectIds) q = q.in('project_id', projectIds);
    if (since) q = q.gte('created_at', since);
    if (kinds) q = q.in('kind', kinds);
    return unwrap(await q.order('id', { ascending: false }).limit(limit));
  },
  approvals: async () => unwrap(await supabase.from('pm_approvals').select('*').eq('status', 'pending').order('requested_at')),
  resources: (projectId) => of('pm_resources', projectId, 'title'),
  resourceLinks: (projectId) => of('pm_resource_links', projectId, 'added_at'),
  baselines: (projectId) => of('pm_baselines', projectId, 'created_at'),
  scenarios: (projectId) => of('pm_scenarios', projectId, 'created_at'),
  calendarEvents: async (projectIds) => (projectIds.length ? rows(() => supabase.from('pm_calendar_events').select('*').in('project_id', projectIds).order('starts_on').order('id')) : []),
  views: async () => unwrap(await supabase.from('pm_views').select('*').order('name').limit(500)),
  workflowVersions: async (workflowId) => unwrap(await supabase.from('pm_workflow_versions').select('*').eq('workflow_id', workflowId).order('version', { ascending: false }).limit(30)),
  automationRuns: async (projectId) => unwrap(await supabase.from('pm_automation_runs').select('*').eq('project_id', projectId).order('id', { ascending: false }).limit(100)),
  notifications: async () => unwrap(await supabase.from('pm_notifications').select('*').order('id', { ascending: false }).limit(100)),
  unread: async () => {
    const { count, error } = await supabase.from('pm_notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
    return error ? 0 : count || 0;
  },
  rollup: () => call('pm_rollup'),
  /** 060: the Orders requests linked to this project's items, with totals. */
  projectSpend: (projectId) => call('pm_project_spend', { p_project: projectId }),
  /** 060: the project items an Orders request is linked to (the ones I can see). */
  itemsForRequest: async (requestId) => unwrap(await supabase.from('pm_refs').select('item_id, pm_items(key, title, project_id)').eq('kind', 'order').eq('ref_id', requestId)),
  // other one.solar apps, read with the person's own access (Projects never changes them)
  requestsByIds: async (ids) => (ids.length ? unwrap(await supabase.from('requests').select('id, request_number, title, status').in('id', ids)) : []),
  findRequests: async (q) => {
    const recent = unwrap(await supabase.from('requests').select('id, request_number, title, status').order('created_at', { ascending: false }).limit(1000));
    const s = q.toLowerCase();
    return recent.filter((r) => `${r.request_number} ${r.title}`.toLowerCase().includes(s)).slice(0, 12);
  },
  inventoryByIds: async (ids) => {
    if (!ids.length) return [];
    const res = await supabase.rpc('inventory_overview');
    return res.error ? [] : (res.data.items || []).filter((i) => ids.includes(i.id));
  },
  findInventory: async (q) => {
    const res = await supabase.rpc('inventory_overview');
    if (res.error) throw toError(res.error);
    const s = q.toLowerCase();
    return (res.data.items || []).filter((i) => `${i.sku} ${i.name}`.toLowerCase().includes(s)).slice(0, 12);
  },

  // ---- projects and their configuration ----
  saveProgram: (id, p) => call('pm_save_program', { p_id: id, p }),
  /** 063: the team's kinds of work (one list for every project), how much each is used, and changing it (leads). */
  kinds: () => rows(() => supabase.from('pm_kinds').select('*').order('level').order('sort').order('name')),
  kindUsage: () => call('pm_kind_usage', {}),
  saveKind: (id, p) => call('pm_save_kind', { p_id: id, p }),
  saveProject: (id, p) => call('pm_save_project', { p_id: id, p }),
  saveRole: (projectId, id, p) => call('pm_save_role', { p_project: projectId, p_id: id, p }),
  deleteRole: (id) => call('pm_delete_role', { p_id: id }),
  setMember: (projectId, userId, roleId) => call('pm_set_member', { p_project: projectId, p_user: userId, p_role: roleId }),
  saveType: (projectId, id, p) => call('pm_save_type', { p_project: projectId, p_id: id, p }),
  saveWorkflow: (projectId, id, p) => call('pm_save_workflow', { p_project: projectId, p_id: id, p }),
  saveField: (projectId, id, p) => call('pm_save_field', { p_project: projectId, p_id: id, p }),
  saveLayout: (projectId, p) => call('pm_save_layout', { p_project: projectId, p }),
  saveTemplate: (id, p) => call('pm_save_template', { p_id: id, p }),
  exportConfig: (projectId, items = false) => call('pm_export_config', { p_project: projectId, p_items: items }),
  applyConfig: (projectId, p) => call('pm_apply_config', { p_project: projectId, p }),
  saveAutomation: (projectId, id, p) => call('pm_save_automation', { p_project: projectId, p_id: id, p }),
  deleteAutomation: (id) => call('pm_delete_automation', { p_id: id }),
  testAutomation: (projectId, p) => call('pm_test_automation', { p_project: projectId, p }),
  runScheduled: () => call('pm_run_scheduled'),

  // ---- items ----
  createItem: (op, p) => call('pm_create_item', { p_op: op, p }),
  updateItem: (id, version, p) => call('pm_update_item', { p_id: id, p_version: version, p }),
  bulkUpdate: (ids, p) => call('pm_bulk_update', { p_ids: ids, p }),
  archiveItem: (id, archived) => call('pm_archive_item', { p_id: id, p_archived: archived }),
  moveItem: (id, p) => call('pm_move_item', { p_id: id, p }),
  transition: (id, transitionId, p = {}) => call('pm_transition', { p_id: id, p_transition: transitionId, p }),
  decideApproval: (id, approve, note) => call('pm_decide_approval', { p_id: id, p_approve: approve, p_note: note }),
  accept: (id, accepted) => call('pm_accept', { p_id: id, p_accepted: accepted }),
  comment: (itemId, body, mentions) => call('pm_comment', { p_item: itemId, p_body: body, p_mentions: mentions }),
  editComment: (id, body) => call('pm_edit_comment', { p_id: id, p_body: body }),
  saveChecklist: (itemId, items) => call('pm_save_checklist', { p_item: itemId, p_items: items }),
  watch: (itemId, on) => call('pm_watch', { p_item: itemId, p_on: on }),
  link: (p) => call('pm_link', { p }),
  unlink: (id) => call('pm_unlink', { p_id: id }),
  addResource: (p) => call('pm_add_resource', { p }),
  saveResource: (id, p) => call('pm_save_resource', { p_id: id, p }),
  removeResourceLink: (id) => call('pm_remove_resource_link', { p_id: id }),
  addRef: (itemId, kind, refId, note) => call('pm_add_ref', { p_item: itemId, p_kind: kind, p_ref: refId, p_note: note }),
  removeRef: (id) => call('pm_remove_ref', { p_id: id }),
  /** 061: how many of a linked Inventory part the item needs (null: none reserved). */
  setRefQty: (id, qty) => call('pm_set_ref_qty', { p_ref: id, p_qty: qty }),
  /** 061: { [inventory item id]: { total, items: [{ qty, key, title, project, start, due }] } } reserved by open project items. */
  inventoryReserved: (ids) => (ids.length ? call('inventory_reserved', { p_items: ids }) : Promise.resolve({})),
  /** 061: open items whose linked order isn't placed and that start soon (or already did). */
  orderWarnings: (projectId) => call('pm_order_warnings', { p_project: projectId }),
  /** 062: an item's description (search results leave it out), for the timeline's side panel. */
  itemDescription: async (id) => (unwrap(await supabase.from('pm_items').select('description').eq('id', id).maybeSingle()) || {}).description || '',
  /** 061: the team's dates (competitions, reviews…), drawn on every timeline. */
  keyDates: async () => unwrap(await supabase.from('pm_key_dates').select('*').order('day')),
  saveKeyDate: (id, p) => call('pm_save_key_date', { p_id: id, p }),
  deleteKeyDate: (id) => call('pm_delete_key_date', { p_id: id }),

  // ---- planning, views, inbox ----
  saveSprint: (projectId, id, p) => call('pm_save_sprint', { p_project: projectId, p_id: id, p }),
  saveBaseline: (projectId, name) => call('pm_save_baseline', { p_project: projectId, p_name: name }),
  deleteBaseline: (id) => call('pm_delete_baseline', { p_id: id }),
  saveScenario: (projectId, id, p) => call('pm_save_scenario', { p_project: projectId, p_id: id, p }),
  reschedule: (projectId, changes, note, scenarioId = null) => call('pm_reschedule', { p_project: projectId, p_changes: changes, p_note: note, p_scenario: scenarioId }),
  saveEvent: (projectId, id, p) => call('pm_save_event', { p_project: projectId, p_id: id, p }),
  saveView: (id, p) => call('pm_save_view', { p_id: id, p }),
  deleteView: (id) => call('pm_delete_view', { p_id: id }),
  markRead: (ids = null) => call('pm_mark_read', { p_ids: ids }),
  savePrefs: (p) => call('pm_save_prefs', { p }),

  // ---- the alumni hub (SGAA, migration 052) ----
  /** { id, status } of the need this project / item is shared as, or null. */
  sharedWithAlumni: (projectId, itemId = null) => call('sgaa_shared_from_projects', { p_project: projectId, p_item: itemId }),
  shareWithAlumni: (projectId, itemId, on) => call('sgaa_share_from_projects', { p_project: projectId, p_item: itemId, p_on: on }),
};
