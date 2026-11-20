/**
 * Events → check-in.
 *   The screen (hosts): a QR code for the room that changes every 30 seconds, the same code to type, and how many
 *   are in. Check-in only works while it's open, and an old code stops working after about a minute, so a photo
 *   of the screen sent to a friend doesn't check them in later.
 *   The phone page (everyone): scanning opens it (after signing in if needed); answer the event's questions and
 *   tap "I'm here". Without a fresh code it asks for the one on the screen.
 */
import { auth } from '../../auth.js';
import { esc, fmtDateTime } from '../../ui.js';
import { appUrl } from '../../../../shared/onesolar.js';
import { qrSvg } from '../../inventory/qr.js';
import { ev } from '../../events/api.js';
import { whenText, checkinLink } from '../../events/core.js';
import { loadBase, needsDatabase, runs, eventHref, personName, attempt, friendly } from './kit.js';

export async function renderCheckinScreen(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  const id = ctx.params.id;
  const [b, e] = await Promise.all([loadBase(), ev.event(id)]);
  if (!e || !runs(e)) {
    el.innerHTML = `<section class="card no-access"><h1>${e ? 'Only the hosts can show the check-in screen' : 'Event not found'}</h1>
      <a class="btn" href="${e ? eventHref(id) : '#/events'}">Back</a></section>`;
    return;
  }
  if (!e.checkin_open) {
    el.innerHTML = `<section class="card ev-screen-closed"><h1>${esc(e.title)}</h1><p>Check-in is closed. Open it to show the code; close it when everyone's in.</p>
      ${e.cancelled_at ? '<p class="muted">This event was cancelled.</p>' : '<button type="button" class="btn btn-primary btn-lg" data-open>Open check-in</button>'}
      <a class="btn btn-ghost" href="${eventHref(id)}">Back to the event</a></section>`;
    el.querySelector('[data-open]')?.addEventListener('click', async () => {
      if (await attempt(() => ev.setCheckin(id, true))) ctx.rerender();
    });
    return;
  }

  const base = appUrl('events/');
  el.innerHTML = `<section class="ev-screen" data-screen-live>
    <div class="ev-screen-head"><h1>${esc(e.title)}</h1><p>${esc(whenText(e))}${e.location ? ` · ${esc(e.location)}` : ''}</p></div>
    <div class="ev-screen-body">
      <div class="ev-qr" data-qr aria-live="off"></div>
      <div class="ev-screen-side">
        <p class="ev-screen-step">Scan with your phone's camera, sign in, tap <strong>I'm here</strong>.</p>
        <p class="ev-screen-or">Or in one.solar → Events → <em>I'm here</em>, type</p>
        <p class="ev-code" data-code>······</p>
        <div class="ev-timer"><span data-timer></span></div>
        <p class="ev-count"><strong data-count>0</strong> checked in</p>
        <ul class="ev-recent" data-recent></ul>
      </div>
    </div>
    <div class="ev-screen-actions">
      <button type="button" class="btn" data-full>Full screen</button>
      <a class="btn" href="${eventHref(id)}">Attendance list</a>
      <button type="button" class="btn btn-danger" data-close>Close check-in</button>
    </div>
    <p class="ev-screen-error" data-error role="alert"></p>
  </section>`;

  const live = el.querySelector('[data-screen-live]');
  let changesAt = 0;
  let skew = 0;
  let lastCode = '';
  let ticks = 0;
  const alive = () => document.body.contains(live);
  const recent = async () => {
    const att = await ev.attendance(id).catch(() => null);
    if (!att) return;
    el.querySelector('[data-count]').textContent = att.length;
    el.querySelector('[data-recent]').innerHTML = att.sort((a, z) => (a.checked_in_at < z.checked_in_at ? 1 : -1)).slice(0, 6)
      .map((a) => `<li>${esc(personName(b, a.user_id))}${a.late ? ' <span class="muted">(late)</span>' : ''}</li>`).join('');
  };
  const fetchCode = async () => {
    try {
      const r = await ev.code(id);
      skew = new Date(r.now).getTime() - Date.now();
      changesAt = new Date(r.changes_at).getTime();
      el.querySelector('[data-count]').textContent = r.count;
      el.querySelector('[data-error]').textContent = '';
      if (r.code !== lastCode) {
        lastCode = r.code;
        el.querySelector('[data-code]').textContent = r.code;
        el.querySelector('[data-qr]').innerHTML = qrSvg(checkinLink(base, id, r.code), { margin: 2, title: `Check in to ${e.title}` });
        recent();
      }
    } catch (err) {
      el.querySelector('[data-error]').textContent = `${friendly(err)} Trying again…`;
      changesAt = Date.now() + skew + 5000;
      if (/closed/i.test(err.message)) return ctx.rerender();
    }
  };
  const tick = async () => {
    if (!alive()) return;
    const left = Math.max(0, Math.ceil((changesAt - (Date.now() + skew)) / 1000));
    el.querySelector('[data-timer]').style.width = `${Math.min(100, (left / 30) * 100)}%`;
    if (left <= 0) await fetchCode();
    if (++ticks % 10 === 0) recent();
    setTimeout(tick, 1000);
  };
  await fetchCode();
  recent();
  setTimeout(tick, 1000);

  el.querySelector('[data-full]').addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : live.requestFullscreen?.()).catch?.(() => {}));
  el.querySelector('[data-close]').addEventListener('click', async () => {
    if (!confirm('Close check-in? Nobody else can scan in, but you can still check people in by hand.')) return;
    if (await attempt(() => ev.setCheckin(id, false), 'Check-in closed')) {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      location.hash = eventHref(id);
    }
  });
}

export async function renderCheckin(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  const id = ctx.params.id;
  let code = (ctx.params.query.get('c') || '').trim();
  let info;
  try {
    info = await ev.checkinInfo(id);
  } catch (err) {
    el.innerHTML = `<section class="card no-access ev-phone"><h1>Can't check in</h1><p>${esc(friendly(err))}</p><a class="btn" href="#/events">My events</a></section>`;
    return;
  }
  const done = (at, late) => `<section class="card ev-phone ev-done" data-checked-in>
    <div class="ev-done-mark" aria-hidden="true">✓</div>
    <h1>You're checked in</h1><p><strong>${esc(info.title)}</strong></p>
    <p class="muted">${esc(fmtDateTime(at))}${late ? ' (late)' : ''}, as ${esc(auth.displayName || '')}</p>
    <a class="btn" href="${eventHref(id)}">See the event</a></section>`;
  if (info.checked_in_at) return void (el.innerHTML = done(info.checked_in_at, false));
  if (info.cancelled || !info.open) {
    el.innerHTML = `<section class="card ev-phone"><h1>${esc(info.title)}</h1><p>${info.cancelled ? 'This event was cancelled.' : 'Check-in for this event isn\'t open right now. Ask the host.'}</p>
      <a class="btn" href="${eventHref(id)}">See the event</a> <button type="button" class="btn btn-ghost" data-again>Try again</button></section>`;
    el.querySelector('[data-again]')?.addEventListener('click', () => ctx.rerender());
    return;
  }
  const qs = info.questions || [];
  const field = (q) => {
    const name = `q_${q.id}`;
    const req = q.required ? 'required' : '';
    const label = `${esc(q.label)}${q.required ? '' : ' <span class="muted">(optional)</span>'}`;
    if (q.type === 'check') return `<label class="pm-check ev-q-check"><input type="checkbox" name="${name}" ${req}> ${label}</label>`;
    if (q.type === 'select') {
      return `<div class="field"><label for="${name}">${label}</label><select id="${name}" name="${name}" ${req}><option value="">Pick one…</option>
        ${q.options.map((o) => `<option>${esc(o)}</option>`).join('')}</select></div>`;
    }
    return `<div class="field"><label for="${name}">${label}</label><input id="${name}" name="${name}" ${q.type === 'number' ? 'type="number" inputmode="decimal" step="any"' : 'type="text" maxlength="1000"'} ${req}></div>`;
  };
  el.innerHTML = `<section class="card ev-phone">
    <h1>${esc(info.title)}</h1>
    <p class="muted">${esc(whenText(info))}${info.location ? ` · ${esc(info.location)}` : ''}</p>
    ${!info.invited ? '<p class="hint">You weren\'t on the invite list; you\'ll be checked in as a walk-in.</p>' : ''}
    <form novalidate data-checkin-form>
      <div class="pm-dialog-error" aria-live="polite"></div>
      ${qs.map(field).join('')}
      <div class="field ev-code-field" ${code ? 'hidden' : ''}><label for="ev-code">Code on the screen</label>
        <input id="ev-code" name="code" type="text" inputmode="text" autocomplete="off" autocapitalize="characters" maxlength="8" placeholder="e.g. 3FA9C1" value="${esc(code)}"></div>
      <button type="submit" class="btn btn-primary btn-lg ev-here">I'm here</button>
    </form></section>`;
  const form = el.querySelector('form');
  const err = form.querySelector('.pm-dialog-error');
  form.addEventListener('submit', async (x) => {
    x.preventDefault();
    if (!form.checkValidity()) return form.reportValidity();
    const answers = {};
    for (const q of qs) {
      const input = form.elements[`q_${q.id}`];
      answers[q.id] = q.type === 'check' ? input.checked : input.value.trim();
    }
    code = form.elements.code.value.trim() || code;
    if (!code) {
      form.querySelector('.ev-code-field').hidden = false;
      form.elements.code.focus();
      err.innerHTML = '<div class="alert alert-error"><strong>Type the code shown on the screen.</strong></div>';
      return;
    }
    const btn = form.querySelector('.ev-here');
    btn.disabled = true;
    err.innerHTML = '';
    try {
      const r = await ev.checkIn(id, code, answers);
      el.innerHTML = done(r.checked_in_at, r.late);
    } catch (e2) {
      btn.disabled = false;
      if (e2.badCode) {
        // An old code (it changes every 30 seconds): ask for the one on the screen now.
        code = '';
        form.elements.code.value = '';
        form.querySelector('.ev-code-field').hidden = false;
        form.elements.code.focus();
      }
      err.innerHTML = `<div class="alert alert-error"><strong>${esc(friendly(e2))}</strong></div>`;
    }
  });
}
