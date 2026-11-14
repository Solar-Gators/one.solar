/**
 * Inventory history: what happened, grouped by operation (a move is two lines, one operation), with Undo where
 * this person may undo it. Used by the item page, the location page and Activity.
 */
import { auth } from '../../auth.js';
import { esc, fmtDateTime, fmtDate } from '../../ui.js';
import { inv } from '../../inventory/api.js';
import { OP_LABELS, KIND_LABELS } from '../../inventory/core.js';
import { formDialog, invalidate, locCode, qty, itemHref, locHref, movementWhat, can } from './kit.js';

/** Movements (newest first) → operations with their lines. */
export function groupOps(movements, ops) {
  const opById = new Map(ops.map((o) => [o.id, o]));
  const groups = new Map();
  for (const m of movements) {
    if (!groups.has(m.op_id)) groups.set(m.op_id, { op: opById.get(m.op_id) || { id: m.op_id, kind: m.kind }, lines: [] });
    groups.get(m.op_id).lines.push(m);
  }
  return [...groups.values()];
}

/** Load movements with their operations. */
export async function loadHistory(filters, limit = 200) {
  const movements = await inv.movements(filters, limit);
  const ops = await inv.ops([...new Set(movements.map((m) => m.op_id))]);
  return { movements, ops, groups: groupOps(movements, ops) };
}

const mayUndo = (op) => {
  if (!op || op.kind === 'reverse' || op.reversed_by) return false;
  if (can.manage()) return true;
  return op.actor_id === auth.user?.id && Date.now() - new Date(op.created_at).getTime() < 23.5 * 3600e3
    && ['consume', 'return', 'transfer', 'receive', 'quarantine', 'order_receipt'].includes(op.kind);
};

/** One line in words: "−20 ea at CAB-A for Battery (Powertrain)". */
function lineText(m, b, { showItem }) {
  const item = b.itemById.get(m.item_id) || { name: 'Item', unit: '' };
  const sign = m.qty > 0 ? '+' : '−';
  const where = m.location_id ? ` at <a href="${locHref(m.location_id)}">${esc(locCode(b, m.location_id))}</a>${m.status === 'quarantine' ? ' (set aside)' : ''}` : ' (straight from the delivery)';
  const what = ['consume', 'return', 'direct_use'].includes(m.kind) ? movementWhat(m, b) : '';
  return `<span class="inv-qty ${m.qty > 0 ? 'is-in' : 'is-out'}">${sign}${esc(qty(Math.abs(m.qty), item))}</span>${showItem ? ` <a href="${itemHref(m.item_id)}">${esc(item.name)}</a>` : ''}${where}${what ? ` · ${what}` : ''}${m.reason && !['consume'].includes(m.kind) ? ` <span class="muted">· ${esc(m.reason)}</span>` : ''}`;
}

/** The history list. */
export function historyList(groups, b, { showItem = false, empty = 'Nothing has happened here yet.' } = {}) {
  if (!groups.length) return `<p class="empty">${esc(empty)}</p>`;
  return `<ul class="inv-history">${groups.map(({ op, lines }) => {
    const label = OP_LABELS[op.kind] || KIND_LABELS[lines[0]?.kind] || op.kind;
    const undone = op.reversed_by ? '<span class="chip chip-tone tone-gray">Undone</span>' : '';
    const isUndo = op.kind === 'reverse';
    return `<li class="inv-op${op.reversed_by ? ' is-undone' : ''}${isUndo ? ' is-undo' : ''}" data-op="${esc(op.id)}">
      <div class="inv-op-head"><strong>${esc(label)}</strong> ${undone}
        <span class="muted small">${esc(op.actor_name || lines[0]?.actor_name || '')} · ${esc(fmtDateTime(op.created_at || lines[0]?.created_at))}${lines[0]?.occurred_on && fmtDate(lines[0].occurred_on) !== fmtDate(op.created_at) ? ` (for ${esc(fmtDate(lines[0].occurred_on))})` : ''}</span>
        ${mayUndo(op) ? `<button type="button" class="btn btn-sm btn-ghost" data-undo="${esc(op.id)}">Undo</button>` : ''}</div>
      <ul class="inv-op-lines">${lines.map((m) => `<li>${lineText(m, b, { showItem })}</li>`).join('')}</ul>
      ${op.note ? `<div class="small muted">${esc(op.note)}</div>` : ''}
    </li>`;
  }).join('')}</ul>`;
}

/** Undo buttons inside `el`; `after` re-renders. */
export function bindUndo(el, after) {
  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-undo]');
    if (!btn) return;
    const done = await formDialog({
      title: 'Undo this?',
      body: `<p>It stays in the history, with an undo next to it that puts the stock back the way it was.</p>
        <div class="field"><label for="u-reason">Why?</label><input id="u-reason" name="reason" required minlength="3" maxlength="300" placeholder="e.g. typed the wrong amount"></div>`,
      submit: 'Undo it',
      danger: true,
      onSubmit: (f, op) => inv.reverse(op, btn.dataset.undo, f.reason.value.trim()),
    });
    if (done) {
      invalidate();
      after();
    }
  });
}
