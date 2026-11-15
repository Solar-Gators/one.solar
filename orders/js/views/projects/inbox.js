/**
 * Projects → Inbox: what happened on items I own, collaborate on or watch, and what I've been asked to do.
 * Also where I choose which kinds of notice I get (here, and by email when an Admin has turned email on).
 */
import { esc, fmtDateTime } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { needsDatabase, loadBase, header, itemHref, attempt, refreshUnread } from './kit.js';

const KINDS = [['assigned', 'Something is assigned to me', true], ['mentioned', 'Someone mentions me', true], ['review', 'An approval is asked of me, or decided', true],
  ['due', 'Something of mine is due tomorrow, today, or overdue', true], ['dependency', 'What I was waiting on is finished', true], ['automation', 'A project rule sends me a message', true],
  ['comment', 'A comment on something I\'m on', false], ['status', 'A status change on something I\'m on', false], ['updated', 'Dates, priority or owner change on something I\'m on', false]];
const ICON = { assigned: '👤', mentioned: '@', review: '☑', due: '⏰', dependency: '🔓', automation: '⚙', comment: '💬', status: '➜', updated: '✎' };

export async function renderInbox(el, { config, rerender }) {
  const missing = needsDatabase(config);
  if (missing) return void (el.innerHTML = missing);
  const b = await loadBase();
  const [list, prefs, items] = await Promise.all([pm.notifications(), pm.prefs(), pm.search({ filter: { any: [{ f: 'mine' }, { f: 'watching' }] }, limit: 1000 })]);
  const keyOf = new Map(items.items.map((i) => [i.id, i.key]));
  const missingKeys = [...new Set(list.map((n) => n.item_id).filter((id) => id && !keyOf.has(id)))];
  (await pm.itemsByIds(missingKeys)).forEach((i) => keyOf.set(i.id, i.key));
  const mine = prefs.find((p) => p.user_id === b.me) || { notify: {}, hours_per_week: null };
  const unread = list.filter((n) => !n.read_at);
  const emailOn = config.notifications?.enabled && (config.notifications?.events?.project_update?.email || config.notifications?.events?.project_update?.teams);

  el.innerHTML = `${header('Inbox', `${unread.length ? `${unread.length} unread` : 'Nothing new'}. The last 100 notices are kept here.`,
    unread.length ? '<button type="button" class="btn" id="read-all">Mark all as read</button>' : '')}
    ${list.length ? `<ul class="pm-inbox">${list.map((n) => `<li class="${n.read_at ? '' : 'is-unread'}"><span class="pm-inbox-icon" aria-hidden="true">${ICON[n.kind] || '•'}</span>
      <div><a href="${keyOf.get(n.item_id) ? itemHref(keyOf.get(n.item_id)) : '#/projects'}" data-open="${n.id}"><strong>${esc(n.title)}</strong></a>
        ${n.body ? `<div class="muted">${esc(n.body)}</div>` : ''}<div class="muted small">${esc(keyOf.get(n.item_id) || '')} · ${esc(fmtDateTime(n.created_at))}</div></div></li>`).join('')}</ul>`
      : '<div class="empty"><p><strong>No notices yet.</strong></p><p>You\'ll hear here when something is assigned to you, when you\'re mentioned, and when items you\'re on change.</p></div>'}
    <details class="card" id="prefs"><summary><h2 style="display:inline;font-size:16px">What I'm told about</h2></summary>
      <form id="prefs-form"><div class="table-wrap"><table class="pm-table"><thead><tr><th>When…</th><th>In this inbox</th><th>By email / Teams</th></tr></thead><tbody>${KINDS.map(([k, label, emailDefault]) => `<tr>
        <td>${esc(label)}</td><td><input type="checkbox" name="inapp:${k}" aria-label="In the inbox: ${esc(label)}" ${mine.notify?.[k]?.inapp === false ? '' : 'checked'}></td>
        <td><input type="checkbox" name="email:${k}" aria-label="By email: ${esc(label)}" ${(mine.notify?.[k]?.email ?? emailDefault) ? 'checked' : ''}></td></tr>`).join('')}</tbody></table></div>
        <p class="hint">${emailOn ? 'Email and Teams messages also follow your choices in My account & notifications.' : 'Email and Teams messages from Projects are turned off for the team right now (an Admin can turn "Project updates" on in Admin → Notifications). The inbox always works.'}
          You're never told about your own changes, and bulk edits don't send email.</p>
        <div class="field" style="max-width:260px"><label for="pf-hours">Hours a week I have for the team (optional)</label>
          <input id="pf-hours" name="hours" type="number" min="0" max="168" step="1" value="${esc(mine.hours_per_week ?? '')}"><div class="hint">Only used to show when someone has more planned than they have time for.</div></div>
        <div class="form-actions"><button type="submit" class="btn btn-primary">Save</button></div></form></details>`;

  el.querySelector('#read-all')?.addEventListener('click', async () => (await attempt(() => pm.markRead(null))) && (refreshUnread(true), rerender()));
  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-open]');
    if (a) pm.markRead([Number(a.dataset.open)]).then(() => refreshUnread(true), () => {});
  });
  el.querySelector('#prefs-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const notify = Object.fromEntries(KINDS.map(([k]) => [k, { inapp: f[`inapp:${k}`].checked, email: f[`email:${k}`].checked }]));
    await attempt(() => pm.savePrefs({ notify, hours_per_week: f.hours.value === '' ? null : Number(f.hours.value) }), 'Saved.');
  };
}
