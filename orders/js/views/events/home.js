/**
 * Events → My events: what I'm invited to (with RSVP), anything I can check in to right now, the events I host,
 * and my own attendance. Leads also get "New event".
 */
import { auth } from '../../auth.js';
import { esc, askText, takeFlash } from '../../ui.js';
import { ev } from '../../events/api.js';
import { phase, whenText, standing, semesterOf } from '../../events/core.js';
import { loadBase, needsDatabase, header, eventHref, categoryChip, phaseChip, standingChip, inviteWords, attempt } from './kit.js';

const RSVP = [['yes', 'Going'], ['maybe', 'Maybe'], ['no', 'Can\'t make it']];

/** Going / Maybe / Can't make it, with mine pressed. */
export function rsvpButtons(e, mine) {
  return `<div class="ev-rsvp" role="group" aria-label="Are you going to ${esc(e.title)}?">${RSVP.map(([k, label]) =>
    `<button type="button" class="btn btn-sm${mine?.answer === k ? ' is-on' : ''}" data-rsvp="${k}" data-id="${esc(e.id)}" aria-pressed="${mine?.answer === k}">${label}</button>`).join('')}
    ${mine?.answer === 'no' && mine.note ? `<span class="muted small">(${esc(mine.note)})</span>` : ''}</div>`;
}
/** Wire the RSVP buttons: "Can't make it" asks why (optional). */
export function bindRsvp(el, mineOf, after) {
  el.querySelectorAll('[data-rsvp]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.id;
    const answer = b.dataset.rsvp;
    const mine = mineOf(id);
    let note = '';
    if (mine?.answer === answer && answer !== 'no') {
      if (await attempt(() => ev.rsvp(id, null), 'Answer taken back')) after();
      return;
    }
    if (answer === 'no') {
      note = await askText({ title: 'Can\'t make it', label: 'Why? (optional, shown to the hosts)', required: false, ok: 'Send', value: mine?.note || '' });
      if (note === null) return;
    }
    if (await attempt(() => ev.rsvp(id, answer, note || ''), answer === 'yes' ? 'See you there' : 'Thanks for letting them know')) after();
  }));
}

/** mine: my RSVP (null: none yet); leave it out for no RSVP buttons. */
function eventCard(b, e, { mine = undefined, rec = null, actions = '' } = {}) {
  return `<article class="ev-card" data-event="${esc(e.id)}">
    <div class="ev-card-top">${categoryChip(b, e.category_id)} ${phaseChip(e)}</div>
    <h3><a href="${eventHref(e.id)}">${esc(e.title)}</a></h3>
    <p class="ev-when">${esc(whenText(e))}${e.location ? ` · ${esc(e.location)}` : ''}</p>
    ${rec ? `<p class="muted small">${standingChip(rec)}</p>` : ''}
    ${e.cancelled_at ? `<p class="muted small">Cancelled${e.cancel_note ? `: ${esc(e.cancel_note)}` : ''}</p>` : ''}
    ${!e.cancelled_at && e.ask_rsvp && mine !== undefined && phase(e) !== 'over' ? rsvpButtons(e, mine) : ''}
    ${actions}
  </article>`;
}

export async function renderEventsHome(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  const me = auth.user?.id;
  const [b, events, mine] = await Promise.all([loadBase(), ev.events(), ev.mine(me)]);
  const invited = new Map(mine.invitees.map((i) => [i.event_id, i]));
  const rsvpOf = new Map(mine.rsvps.map((r) => [r.event_id, r]));
  const attOf = new Map(mine.attendance.map((a) => [a.event_id, a]));
  const recOf = (e) => ({ invited: invited.has(e.id), excused: invited.get(e.id)?.excused, rsvp: rsvpOf.get(e.id), att: attOf.get(e.id) });
  const minePlus = events.filter((e) => invited.has(e.id) || attOf.has(e.id));

  const now = new Date();
  const hostsIt = (e) => e.host_id === me || (e.cohosts || []).includes(me);
  // Open check-ins I can scan into (invited, or walk-ins allowed and I'm hosting), not yet checked in.
  const checkInNow = events.filter((e) => (invited.has(e.id) || hostsIt(e)) && e.checkin_open && !e.cancelled_at && !attOf.has(e.id));
  // Events I host are under "You're hosting" only.
  const coming = minePlus.filter((e) => !hostsIt(e) && (['upcoming', 'now'].includes(phase(e, now)) || (e.cancelled_at && new Date(e.starts_at) > now)))
    .sort((a, z) => (a.starts_at < z.starts_at ? -1 : 1));
  const hosting = events.filter((e) => hostsIt(e) && phase(e, now) !== 'over')
    .sort((a, z) => (a.starts_at < z.starts_at ? -1 : 1));
  const past = minePlus.filter((e) => phase(e, now) === 'over' || (e.cancelled_at && new Date(e.starts_at) <= now))
    .sort((a, z) => (a.starts_at < z.starts_at ? 1 : -1));
  const sem = semesterOf(now.toISOString());
  const thisSem = past.filter((e) => !e.cancelled_at && semesterOf(e.starts_at) === sem);
  const count = (s) => thisSem.filter((e) => standing(e, recOf(e)) === s).length;
  const came = count('came') + count('late');

  el.innerHTML = `${takeFlash()}${header('My events', 'Town halls, testing days and other team events you\'re invited to.')}
    ${checkInNow.length ? `<section class="card ev-now"><h2>Check in now</h2>
      <div class="ev-grid">${checkInNow.map((e) => eventCard(b, e, { actions: `<a class="btn btn-primary" href="#/events/checkin/${esc(e.id)}" data-check-in="${esc(e.id)}">I'm here</a>` })).join('')}</div></section>` : ''}
    <section class="card"><div class="card-head"><h2>Coming up</h2></div>
      ${coming.length ? `<div class="ev-grid">${coming.map((e) => eventCard(b, e, { mine: rsvpOf.get(e.id) || null })).join('')}</div>`
        : '<p class="empty">Nothing coming up. When you\'re invited to an event, it shows here.</p>'}</section>
    ${hosting.length ? `<section class="card"><div class="card-head"><h2>You're hosting</h2></div>
      <div class="ev-grid">${hosting.map((e) => eventCard(b, e, { actions: `<p class="muted small">Invited: ${esc(inviteWords(b, e))}</p>
        <div class="form-actions"><a class="btn btn-sm" href="${eventHref(e.id)}">Open</a>${!e.cancelled_at ? `<a class="btn btn-sm" href="${eventHref(e.id, 'screen')}">Check-in screen</a>` : ''}</div>` })).join('')}</div></section>` : ''}
    <section class="card"><div class="card-head"><h2>My attendance</h2>
      ${thisSem.length ? `<p class="ev-summary" data-my-summary>${sem}: you came to <strong>${came}</strong> of ${thisSem.length - count('excused')}${count('excused') ? ` (excused from ${count('excused')})` : ''}${count('late') ? `, ${count('late')} late` : ''}.</p>` : ''}</div>
      ${past.length ? `<div class="table-wrap"><table class="table" data-fit><thead><tr><th>Date</th><th>Event</th><th>Category</th><th>You</th></tr></thead><tbody>
        ${past.map((e) => `<tr><td data-label="Date">${esc(new Date(e.starts_at).toLocaleDateString())}</td><td data-label="Event"><a href="${eventHref(e.id)}">${esc(e.title)}</a></td>
          <td data-label="Category">${categoryChip(b, e.category_id)}</td><td data-label="You">${standingChip(standing(e, recOf(e))) || '<span class="muted">—</span>'}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="empty">No past events yet.</p>'}</section>`;

  bindRsvp(el, (id) => rsvpOf.get(id), () => ctx.rerender());
}
