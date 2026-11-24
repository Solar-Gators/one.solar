/**
 * Events → All events: every event I can see (leads with "See attendance": all of them; hosts: theirs), with
 * how many were invited and came. Upcoming / past / everything, by category, by name.
 */
import { esc, takeFlash } from '../../ui.js';
import { listBar, bindListBar, rememberedFilters, setListCount } from '../../listBar.js';
import { ev } from '../../events/api.js';
import { phase, whenText } from '../../events/core.js';
import { eventStats, pct } from '../../events/stats.js';
import { loadBase, needsDatabase, header, eventHref, categoryChip, phaseChip, personName, remember } from './kit.js';

export async function renderEventList(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  const [b, events, invitees, rsvps, attendance] = await Promise.all([loadBase(), ev.events(), ev.invitees(), ev.rsvps(), ev.attendance()]);
  const data = { events, invitees, rsvps, attendance, org: b.org, divisions: b.divisions, subsystems: b.subsystems };
  const filters = [{ key: 'category', label: 'Category', all: 'Every category', options: b.categories.filter((c) => !c.archived_at).map((c) => [c.id, c.name]) }];
  const values = rememberedFilters('events', filters);
  const state = { when: remember.get('listWhen', 'upcoming'), q: '' };
  const seg = `<div class="pm-seg" role="group" aria-label="When">${[['upcoming', 'Upcoming'], ['past', 'Past'], ['all', 'Everything']]
    .map(([k, l]) => `<button type="button" data-when="${k}" class="${state.when === k ? 'is-on' : ''}" aria-pressed="${state.when === k}">${l}</button>`).join('')}</div>`;

  el.innerHTML = `${takeFlash()}${header('All events', 'Every event you can see, with who came.')}
    ${listBar({ placeholder: 'Find an event…', filters, values, extra: seg })}
    <section class="card" data-list></section>`;

  const draw = () => {
    const now = new Date();
    const list = events.filter((e) => {
      const p = phase(e, now);
      if (state.when === 'upcoming' && !(p === 'upcoming' || p === 'now' || (p === 'cancelled' && new Date(e.starts_at) > now))) return false;
      if (state.when === 'past' && (p === 'upcoming' || p === 'now' || (p === 'cancelled' && new Date(e.starts_at) > now))) return false;
      if (values.category && e.category_id !== values.category) return false;
      return !state.q || e.title.toLowerCase().includes(state.q);
    });
    setListCount(el, list.length, events.length, 'events');
    list.sort((a, z) => (state.when === 'upcoming' ? (a.starts_at < z.starts_at ? -1 : 1) : (a.starts_at < z.starts_at ? 1 : -1)));
    el.querySelector('[data-list]').innerHTML = list.length ? `<div class="table-wrap"><table class="table" data-fit><thead><tr>
      <th>When</th><th>Event</th><th>Category</th><th>Host</th><th class="num">Invited</th><th class="num">Came</th><th class="num">Turnout</th><th>Status</th></tr></thead><tbody>
      ${list.map((e) => {
        const s = eventStats(data, e);
        return `<tr data-href="${eventHref(e.id)}"><td data-label="When">${esc(whenText(e, { year: true }))}</td>
          <td data-label="Event"><a href="${eventHref(e.id)}">${esc(e.title)}</a>${e.location ? `<div class="muted small">${esc(e.location)}</div>` : ''}</td>
          <td data-label="Category">${categoryChip(b, e.category_id)}</td><td data-label="Host">${esc(e.host_id ? personName(b, e.host_id) : '')}</td>
          <td data-label="Invited" class="num">${s.invited}</td><td data-label="Came" class="num">${s.came}</td>
          <td data-label="Turnout" class="num">${phase(e) === 'upcoming' ? '<span class="muted">—</span>' : pct(s.turnout)}</td><td data-label="Status">${phaseChip(e)}</td></tr>`;
      }).join('')}</tbody></table></div>`
      : `<p class="empty">${state.when === 'upcoming' ? 'Nothing coming up.' : 'No events here.'}</p>`;
  };
  el.addEventListener('click', (x) => {
    const w = x.target.closest('[data-when]');
    if (w) {
      state.when = w.dataset.when;
      remember.set('listWhen', state.when);
      el.querySelectorAll('[data-when]').forEach((y) => {
        y.classList.toggle('is-on', y === w);
        y.setAttribute('aria-pressed', String(y === w));
      });
      return draw();
    }
    const row = x.target.closest('tr[data-href]');
    if (row && !x.target.closest('a, button')) location.hash = row.dataset.href;
  });
  el.querySelector('[data-list-q]').addEventListener('input', (x) => ((state.q = x.target.value.trim().toLowerCase()), draw()));
  bindListBar(el, { id: 'events', filters, values, onChange: draw });
  draw();
}
