/**
 * Projects: small pure helpers shared by the pages (tested in Node: tests/projectsModules.test.mjs).
 * Nothing here talks to the database; the rules that matter are enforced there (migration 051).
 */

/** What a project role can be allowed to do (pm_roles.caps), with the words the pages use. */
export const CAPS = [
  ['view', 'See the project', 'Open the project and read everything in it.'],
  ['comment', 'Comment', 'Write comments and mention people.'],
  ['create', 'Create items', 'Add work items, link documents, and edit items that are theirs.'],
  ['edit', 'Edit items', 'Change any item in the project.'],
  ['assign', 'Assign people', 'Make someone else the owner of an item.'],
  ['transition', 'Move items between statuses', 'Make the moves the workflow allows (each move can still be limited to some roles).'],
  ['approve', 'Approve', 'Approve moves that need approval, and formally accept finished work.'],
  ['delete', 'Archive items', 'Archive and restore items, and remove other people\'s comments.'],
  ['plan', 'Plan and schedule', 'Dependencies, sprints, baselines, rescheduling and calendar events.'],
  ['boards', 'Shared boards and views', 'Save boards, views and dashboards that everyone in the project sees.'],
  ['automations', 'Automation rules', 'Create and change the project\'s rules.'],
  ['configure', 'Project settings, types and fields', 'Project details, work-item types, custom fields and form layouts.'],
  ['workflows', 'Workflows', 'Statuses and the moves between them.'],
  ['members', 'Members and roles', 'Add people, change their role, and edit roles.'],
];

export const PRIORITIES = [['urgent', 'Urgent', 'red-strong'], ['high', 'High', 'orange'], ['medium', 'Medium', 'blue'], ['low', 'Low', 'gray']];
export const CATEGORIES = [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']];
export const TONES = ['gray', 'blue', 'green', 'teal', 'amber', 'orange', 'red', 'pink', 'purple', 'navy'];
export const DEP_KINDS = { FS: 'Finish → start', SS: 'Start → start', FF: 'Finish → finish', SF: 'Start → finish' };
export const DOC_CATEGORIES = ['CAD', 'Drawings', 'Analysis', 'Manufacturing', 'Test Report', 'Design Review', 'Requirements', 'General Documentation'];

export const FIELD_TYPES = [
  ['text', 'Short text'], ['longtext', 'Long text'], ['richtext', 'Formatted text'], ['integer', 'Whole number'], ['decimal', 'Number'],
  ['date', 'Date'], ['datetime', 'Date and time'], ['checkbox', 'Checkbox'], ['select', 'Dropdown (one choice)'], ['multiselect', 'Dropdown (several choices)'],
  ['user', 'Person'], ['multiuser', 'People'], ['url', 'Link'], ['tags', 'Tags'], ['duration', 'Duration (hours)'], ['currency', 'Money'], ['formula', 'Calculated'],
];

/** The built-in fields a form layout can hold (the title is always there), with their labels. */
export const BUILTIN_FIELDS = [
  ['description', 'Description'], ['priority', 'Priority'], ['owner', 'Owner'], ['collaborators', 'Collaborators'], ['division', 'CE division'],
  ['subsystem', 'Subsystem'], ['vehicle', 'Vehicle'], ['start_date', 'Start date'], ['due_date', 'Due date'], ['estimate_hours', 'Estimate (hours)'],
  ['progress', 'Progress'], ['parent', 'Parent'], ['sprint', 'Sprint'], ['labels', 'Labels'], ['acceptance', 'What "done" means'], ['blocked', 'Blocked'],
];
/** Built-in fields a workflow move can require. */
export const REQUIRABLE = ['owner', 'description', 'due_date', 'start_date', 'estimate_hours', 'division', 'subsystem', 'parent', 'sprint', 'acceptance', 'labels', 'vehicle'];

export function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** "cf.test_date" or "due_date" → its label in this project. */
export function fieldLabel(key, fields = []) {
  if (key === 'comment') return 'A comment';
  if (key.startsWith('cf.')) return fields.find((f) => f.key === key.slice(3))?.name || key.slice(3);
  return BUILTIN_FIELDS.find(([k]) => k === key)?.[1] || key;
}

/**
 * The form for a kind of item: the type's own layout, else the project's, else the standard one (every built-in
 * field, then every custom field that applies to the type). → [{ title, fields: [{ key, required }] }]
 */
export function layoutFor(cfg, typeId, kind, transitionId = null) {
  const own = (cfg.layouts || []).filter((l) => l.kind === kind && (l.transition_id || null) === transitionId);
  const hit = own.find((l) => l.type_id === typeId) || own.find((l) => !l.type_id);
  if (hit) return hit.sections;
  if (kind === 'transition') return [];
  const custom = (cfg.fields || []).filter((f) => !f.archived_at && (!f.type_ids?.length || f.type_ids.includes(typeId)));
  const basic = kind === 'create'
    ? ['description', 'owner', 'priority', 'due_date', 'parent']
    : ['description', 'owner', 'collaborators', 'priority', 'start_date', 'due_date', 'estimate_hours', 'progress', 'division', 'subsystem', 'parent', 'sprint', 'labels', 'acceptance', 'blocked'];
  return [
    { title: 'Details', fields: basic.map((key) => ({ key })) },
    ...(custom.length ? [{ title: 'More', fields: custom.map((f) => ({ key: `cf.${f.key}` })) }] : []),
  ];
}

/** The moves someone can pick for an item: the workflow's transitions out of its status (not ones their role is shut out of). */
export function movesFor(cfg, item, { roleIds = [], manage = false } = {}) {
  const type = cfg.types.find((t) => t.id === item.type_id);
  if (!type) return [];
  return cfg.transitions
    .filter((t) => t.workflow_id === type.workflow_id && (t.from_status === item.status_id || !t.from_status) && t.to_status !== item.status_id)
    .filter((t) => manage || !t.role_ids?.length || t.role_ids.some((r) => roleIds.includes(r)))
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

/** The move that takes an item to a status (a specific "from" beats "from any"), or null. */
export const moveTo = (cfg, item, statusId, who) => {
  const list = movesFor(cfg, item, who).filter((t) => t.to_status === statusId);
  return list.find((t) => t.from_status) || list[0] || null;
};

/** What a move asks for before it happens: the fields to fill and whether a comment is needed. */
export function moveNeeds(cfg, item, tr) {
  const layout = layoutFor(cfg, item.type_id, 'transition', tr.id);
  const keys = [...new Set([...(tr.require_fields || []), ...layout.flatMap((s) => s.fields.map((f) => f.key))])];
  const required = new Set([...(tr.require_fields || []), ...layout.flatMap((s) => s.fields.filter((f) => f.required).map((f) => f.key))]);
  return { keys, required, comment: !!tr.require_comment, approval: !!tr.require_approval };
}

/** A board's columns: the saved ones (without statuses that no longer exist), or one per status of the workflows in play. */
export function boardColumns(config, statuses) {
  const known = new Map(statuses.map((s) => [s.id, s]));
  const saved = (config?.columns || [])
    .map((c) => ({ name: c.name, wip: Number(c.wip) || null, status_ids: (c.status_ids || []).filter((id) => known.has(id)) }))
    .filter((c) => c.name);
  if (saved.length) return saved;
  // No saved columns: statuses with the same name share a column (handy across projects).
  const byName = new Map();
  for (const s of [...statuses].sort((a, b) => ['todo', 'doing', 'done'].indexOf(a.category) - ['todo', 'doing', 'done'].indexOf(b.category) || a.sort - b.sort)) {
    const k = s.name.trim().toLowerCase();
    if (!byName.has(k)) byName.set(k, { name: s.name, wip: null, status_ids: [] });
    byName.get(k).status_ids.push(s.id);
  }
  return [...byName.values()];
}

/** A rank between two neighbours (either may be missing). */
export function rankBetween(before, after) {
  const a = before === null || before === undefined ? null : Number(before);
  const b = after === null || after === undefined ? null : Number(after);
  if (a === null && b === null) return 1000;
  if (a === null) return b - 1000;
  if (b === null) return a + 1000;
  return (a + b) / 2;
}

/**
 * Progress three ways, each labelled with how it's worked out (a count of closed items alone says little).
 * rows: pm_rollup groups (or sums of them).
 */
export function progressOf(rows) {
  const sum = (k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);
  const total = sum('total');
  const estTotal = sum('est_total');
  const ms = sum('ms_total');
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
  return {
    total, done: sum('done'), doing: sum('doing'), todo: sum('todo'), overdue: sum('overdue'), blocked: sum('blocked'), unassigned: sum('unassigned'),
    byCount: { value: pct(sum('done'), total), how: 'Items finished ÷ all items' },
    byEffort: { value: pct(sum('est_done'), estTotal), how: `Estimated hours finished ÷ all estimated hours${sum('est_missing') ? ` (${sum('est_missing')} item${sum('est_missing') === 1 ? ' has' : 's have'} no estimate and aren't counted)` : ''}` },
    byMilestones: { value: pct(sum('ms_done'), ms), how: `Milestones reached ÷ all milestones (${sum('ms_done')} of ${ms})` },
    msLate: sum('ms_late'),
    nextMs: rows.map((r) => r.next_ms).filter(Boolean).sort()[0] || null,
  };
}

/** Does a project need someone to step in? → the reasons (empty: it's fine). */
export function attention(p) {
  const why = [];
  if (p.msLate) why.push(`${p.msLate} milestone${p.msLate === 1 ? '' : 's'} late`);
  if (p.total && p.overdue / p.total >= 0.2) why.push(`${p.overdue} of ${p.total} items overdue`);
  if (p.blocked >= 3) why.push(`${p.blocked} items blocked`);
  const open = p.total - p.done;
  if (open >= 5 && p.unassigned / open >= 0.4) why.push(`${p.unassigned} open items have no owner`);
  return why;
}

/** Hours of open work per person per week (by due date; undated work in "No date"). → { weeks: [iso], rows: [{ id, total, byWeek, hours }] } */
export function workload(items, people, prefs = [], { weeks = 6, today = new Date() } = {}) {
  const monday = (d) => {
    const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
    return x;
  };
  const start = monday(today);
  const labels = Array.from({ length: weeks }, (_, i) => new Date(start.getTime() + i * 7 * 86400000).toISOString().slice(0, 10));
  const cap = new Map(prefs.map((p) => [p.user_id, p.hours_per_week === null || p.hours_per_week === undefined ? null : Number(p.hours_per_week)]));
  const rows = new Map();
  const row = (id) => rows.get(id) || rows.set(id, { id, total: 0, items: 0, unestimated: 0, byWeek: Object.fromEntries(labels.map((w) => [w, 0])), undated: 0, late: 0, hours: cap.get(id) ?? null }).get(id);
  for (const it of items) {
    if (it.category === 'done') continue;
    const r = row(it.owner_id || '');
    const h = Number(it.estimate_hours) || 0;
    r.items++;
    if (!h) r.unestimated++;
    r.total += h;
    if (!it.due_date) r.undated += h;
    else {
      const w = monday(new Date(`${it.due_date}T12:00:00`)).toISOString().slice(0, 10);
      if (w < labels[0]) r.late += h;
      else if (w in r.byWeek) r.byWeek[w] += h;
    }
  }
  for (const p of people) row(p.id);
  return { weeks: labels, rows: [...rows.values()].sort((a, b) => b.total - a.total) };
}

/** "3 days ago", "in 2 days", "today". */
export function relDay(iso, today = new Date()) {
  if (!iso) return '';
  const d = Math.round((Date.parse(`${String(iso).slice(0, 10)}T00:00:00`) - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86400000);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  return d > 0 ? `in ${d} days` : `${-d} days ago`;
}

/** People mentioned in a comment as @First Last (longest names first, so "@Ana Li" isn't read as "@Ana"). */
export function findMentions(text, people) {
  const found = [];
  const lower = String(text || '').toLowerCase();
  for (const p of [...people].sort((a, b) => (b.full_name || '').length - (a.full_name || '').length)) {
    const name = (p.full_name || '').trim().toLowerCase();
    if (name && lower.includes(`@${name}`)) found.push(p.id);
  }
  return found;
}

/** A filter (pmx_where's model) in words, for chips and previews. `names` resolves ids: { status: Map, … }. */
export function filterText(c, names = {}) {
  if (!c || typeof c !== 'object' || !Object.keys(c).length) return '';
  if (c.all || c.any) {
    const parts = (c.all || c.any).map((x) => filterText(x, names)).filter(Boolean);
    return parts.length > 1 ? `(${parts.join(c.all ? ' and ' : ' or ')})` : parts[0] || '';
  }
  if (c.not) return `not ${filterText(c.not, names)}`;
  const label = { mine: 'mine', overdue: 'overdue', blocked: 'blocked', open_deps: 'waiting on something', milestone: 'milestones', awaiting: 'awaiting approval',
    unassigned: 'no owner', watching: 'watching', accepted: 'accepted' }[c.f];
  if (label) return c.v === false || c.op === 'ne' ? `not ${label}` : label;
  const val = (v) => (v === 'me' ? 'me' : names[c.f]?.get?.(v) || String(v));
  const v = Array.isArray(c.v) ? c.v.map(val).join(' or ') : val(c.v ?? '');
  const op = { eq: 'is', ne: 'is not', in: 'is', nin: 'is not', lt: '<', lte: '≤', gt: '>', gte: '≥', contains: 'has', empty: 'is empty', notempty: 'is set',
    within: 'in the next', past: 'more than', last: 'in the last' }[c.op || 'eq'];
  const unit = ['within', 'past', 'last'].includes(c.op) ? (c.op === 'past' ? ' days ago' : ' days') : '';
  return `${String(c.f).replace(/^cf\./, '').replace(/_/g, ' ')} ${op}${['empty', 'notempty'].includes(c.op) ? '' : ` ${v}${unit}`}`;
}
