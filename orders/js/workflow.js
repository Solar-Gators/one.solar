/**
 * Approval rules and budgets (Admin → Workflow), shared by the pages that show
 * who needs to approve and how much budget is left. The database enforces the
 * same rules (migration 010); this module only explains them.
 */
import { auth } from './auth.js';
import { STATUS } from './ui.js';

export const RULE_TYPES = [
  { key: 'any', label: 'Any Chief Engineer', hint: 'Anyone with "Approve requests".' },
  { key: 'people', label: 'Specific people', hint: 'Only the people you pick (Admins can step in).' },
  { key: 'auto', label: 'Approve automatically', hint: 'Skips review. Budgets that block still apply.' },
];

/** Notification events (grouped by the app they're about), who gets them, and the placeholders their templates can use. */
export const EVENTS = [
  { key: 'submitted', label: 'Submitted', who: 'Whoever needs to approve it' },
  { key: 'approved', label: 'Approved', who: 'The requester' },
  { key: 'ready_to_order', label: 'Ready to order', who: 'Everyone with "Order & receive"' },
  { key: 'changes_requested', label: 'Changes requested', who: 'The requester' },
  { key: 'rejected', label: 'Rejected', who: 'The requester' },
  { key: 'cancelled', label: 'Cancelled', who: 'The requester (says why)' },
  { key: 'ordered', label: 'Ordered', who: 'The requester' },
  { key: 'received', label: 'Received', who: 'The requester' },
  { key: 'purchase_step', label: 'Purchasing step changed', who: 'The requester and watchers, when the Treasurer moves an approved request to another step (e.g. "Request sent"). Only if Finances → Edit steps shows steps to requesters' },
  { key: 'items_changed', label: 'Items changed', who: 'The requester, when the Treasurer changes the items on an approved / ordered request' },
  { key: 'request_update', label: 'Watched request changed', who: 'People watching the request (not the requester)' },
  { key: 'sponsor_update', app: 'Sponsors', label: 'Sponsor card updated', who: 'People watching the card (Sponsors board)' },
  { key: 'project_update', app: 'Workbench', label: 'Space updates', who: "Whoever is given an item, mentioned, asked to approve or reminded of a deadline, plus (if they chose it in Workbench → Inbox) people on an item that changes. Workbench's own inbox always works" },
  { key: 'eval_update', app: 'Solar Evals', label: 'Evaluation updates', who: 'The CE when a member submits a self-eval; the member when their meeting is scheduled and when their eval is shared' },
  { key: 'event_invite', app: 'Events', label: 'Event invitations', emailOnly: true, emailOnlyWhy: 'Email only: invitations also show in Events', schema: 64,
    who: 'The people invited to an event, when its host ticks "Email the people invited" while saving it' },
  { key: 'sgaa_message', app: 'Alumni hub (SGAA)', label: 'Message from an alum', emailOnly: true, emailOnlyWhy: 'Email only: replies go to the alum', schema: 52,
    who: 'The contact an alum (or teammate) writes to on the alumni hub. Replying answers the alum directly. Every message is also kept on the hub (Messages)' },
];
export const PLACEHOLDERS = [
  ['request_number', 'e.g. SG26-014'],
  ['title', 'Request title'],
  ['requester', 'Who asked for it'],
  ['first_name', "Recipient's first name"],
  ['total', 'Total with shipping'],
  ['vendor', 'Vendor'],
  ['approver', 'Who approved / reviewed'],
  ['comment', "Reviewer's comment, or why it was cancelled"],
  ['ticket', 'Order / ticket number'],
  ['where', 'Received: where it is, or where it was picked up'],
  ['received_by', 'Received: who marked it'],
  ['status', 'New status'],
  ['changes', 'Items changed: what changed, one per line'],
  ['step', 'Purchasing step changed: the new step, e.g. Request sent'],
  ['rule', 'Approval rule used'],
  ['link', 'Link to the request (or sponsor card)'],
  ['sponsor', 'Sponsors board: the sponsor\'s name'],
  ['stage', 'Sponsors board: the card\'s stage'],
  ['what', 'Sponsors board / Solar Evals: what happened, e.g. "moved from In talks to Committed"'],
  ['actor', 'Sponsors board / Solar Evals: who did it'],
  ['details', 'Solar Evals: the full sentence, e.g. "Elle CE scheduled your eval meeting for …"'],
  ['member', 'Solar Evals: the member being evaluated'],
  ['semester', 'Solar Evals: the semester'],
  ['from_name', 'Alumni hub: who wrote the message'],
  ['from_kind', 'Alumni hub: "an alum" or "the team"'],
  ['need', 'Alumni hub: the need it\'s about (if any)'],
];

export const workflowSettings = (config) => ({
  rules: Array.isArray(config.workflow?.rules) ? config.workflow.rules : [],
  // Budgets follow Subsystem until the Treasurer picks another dropdown (or none) on Finances.
  budgets: { field: 'subsystem', amounts: {}, block: false, ...(config.workflow?.budgets || {}) },
});

/**
 * Where a Submitted request stands:
 *   { type, rule, people, needAll, approvedBy: [ids], waitingOn: [ids] | null (= any CE) }
 */
export function approvalState(request) {
  const plan = request.approval_plan || { type: 'any' };
  const since = plan.submitted_at || '';
  const approvedBy = [
    ...new Set(
      (request.approvals || []).filter((a) => a.decision === 'approve' && a.approver_id && (!since || a.created_at >= since)).map((a) => a.approver_id)
    ),
  ];
  const people = plan.type === 'people' ? plan.people || [] : [];
  return {
    type: plan.type || 'any',
    rule: plan.rule || '',
    people,
    needAll: !!plan.needAll,
    approvedBy,
    waitingOn: plan.type === 'people' ? (plan.needAll ? people.filter((p) => !approvedBy.includes(p)) : people) : null,
  };
}

/** Can the signed-in person approve / reject this request? (The database checks too.) */
export function canReview(request) {
  const s = approvalState(request);
  if (s.type === 'people') return s.people.includes(auth.user?.id) || auth.can('workflow.edit');
  return auth.can('request.review');
}

/** Is this Submitted request waiting on the signed-in person? */
export function waitingOnMe(request) {
  if (request.status !== STATUS.SUBMITTED) return false;
  const s = approvalState(request);
  if (s.type === 'people') return s.waitingOn.includes(auth.user?.id);
  return auth.can('request.review');
}

/** A request's answer to a field: built-in at the top level, custom in `data`. */
const answer = (r, key) => String(r?.[key] ?? r?.data?.[key] ?? '').trim();

/**
 * Budget use for the current season: one row per budgeted value,
 * { value, amount, used, pending, remaining, over }. `used` counts Approved,
 * Ordered and Received requests, plus purchases the Treasurer logged on their own
 * (Finances → Purchases; cancelled ones don't count); `pending` is what's waiting
 * for approval. Same rule as the database's over-budget check.
 */
export function budgetSummary(config, requests, purchases = []) {
  const { field, amounts } = workflowSettings(config).budgets;
  if (!field) return [];
  const spent = [STATUS.APPROVED, STATUS.ORDERED, STATUS.RECEIVED];
  const inSeason = requests.filter((r) => !r.season || !config.season || r.season === config.season);
  const tree = budgetParents(config);
  return Object.entries(amounts || {})
    .filter(([, amount]) => amount !== '' && Number.isFinite(Number(amount)))
    .map(([value, amount]) => {
      // 058: a category's use includes every category under it
      const names = new Set([value.trim().toLowerCase(), ...below(tree, value)]);
      const mine = inSeason.filter((r) => names.has(answer(r, field).trim().toLowerCase()));
      const sum = (rows) => rows.reduce((s, r) => s + (r.total || 0), 0);
      const own = (purchases || []).filter(
        (p) => !p.request_id && p.dept_status !== 'cancelled' && (!config.season || p.season === config.season)
          && names.has(String(p.category || '').trim().toLowerCase())
      );
      const used = sum(mine.filter((r) => spent.includes(r.status))) + own.reduce((s, p) => s + (Number(p.amount) || 0), 0);
      const pending = sum(mine.filter((r) => r.status === STATUS.SUBMITTED));
      return { value, amount: Number(amount), used, pending, remaining: Number(amount) - used, over: used > Number(amount) };
    });
}

/** Are any budgets set (so it's worth loading the season's requests to check them)? */
export const hasBudgets = (config) => {
  const { field, amounts } = workflowSettings(config).budgets;
  return !!field && Object.values(amounts || {}).some((a) => a !== '' && Number.isFinite(Number(a)));
};

/** 058: budgets.parents as lower-cased { child: parent } (empty before 058). */
const budgetParents = (config) => (Number(config?.schemaVersion) >= 58
  ? Object.fromEntries(Object.entries(workflowSettings(config).budgets.parents || {}).map(([c, p]) => [c.trim().toLowerCase(), String(p).trim().toLowerCase()]))
  : {});
/** Every category under `name` (lower-cased). */
function below(tree, name) {
  const out = new Set();
  const todo = [String(name).trim().toLowerCase()];
  while (todo.length && out.size < 500) {
    const p = todo.pop();
    for (const [c, q] of Object.entries(tree)) if (q === p && !out.has(c)) (out.add(c), todo.push(c));
  }
  out.delete(String(name).trim().toLowerCase());
  return [...out];
}

/**
 * The budget row this request counts against, or null: its own category's, else the nearest one above it
 * with a budget (058). If a budget further up is the one it would go over, that one is returned instead
 * (`over` set), so approvers see the budget that matters.
 */
export function budgetFor(config, request, summary) {
  const { field } = workflowSettings(config).budgets;
  if (!field) return null;
  const tree = budgetParents(config);
  const chain = [];
  for (let v = answer(request, field).trim().toLowerCase(), n = 0; v && n < 50 && !chain.includes(v); v = tree[v], n++) chain.push(v);
  const rows = chain.map((v) => summary.find((b) => b.value.trim().toLowerCase() === v)).filter(Boolean);
  const extra = (b) => b.used + (request.status === STATUS.SUBMITTED ? request.total || 0 : 0) > b.amount;
  return rows.find(extra) || rows[0] || null;
}
