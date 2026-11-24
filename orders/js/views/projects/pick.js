/**
 * Projects: the one set of pickers every page uses (status, owner, dates, priority, kind…). A small pop-up next to
 * what was clicked: type to filter, arrow keys and Enter, Escape or a click elsewhere to close. Choosing saves
 * straight away in whatever opened it; nothing here talks to the database.
 */
import { esc, fmtDate } from '../../ui.js';
import { PRIORITIES } from '../../projects/core.js';
import { todayISO } from '../../projects/schedule.js';

let open = null;   // the picker that's showing (only one at a time)

/** Close whatever picker is open (as if Escape was pressed). */
export function closePicker() {
  open?.close(undefined);
}

/**
 * A list to pick one thing from. options: [{ value, label, html?, hint?, group? }]. Resolves with the picked
 * value, or undefined if closed without picking. `extra(body, done)` can add something below the list (a date box).
 */
export function openPicker(anchor, { label = 'Pick', options = [], value, search = options.length > 7, placeholder = 'Type to filter', extra = null, width = 260 } = {}) {
  closePicker();
  return new Promise((resolve) => {
    const pop = document.createElement('div');
    pop.className = 'pm-pick';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', label);
    pop.style.width = `${width}px`;
    pop.innerHTML = `${search ? `<input type="search" class="pm-pick-q" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" autocomplete="off">` : ''}
      <div class="pm-pick-list" role="listbox" aria-label="${esc(label)}"></div><div class="pm-pick-extra"></div>`;
    (anchor.closest('dialog[open]') || document.body).append(pop);   // inside a pop-up, so it's above it and can be clicked
    const list = pop.querySelector('.pm-pick-list');
    const q = pop.querySelector('.pm-pick-q');
    let shown = options;
    let at = Math.max(0, options.findIndex((o) => o.value === value));
    const draw = () => {
      const needle = (q?.value || '').trim().toLowerCase();
      shown = needle ? options.filter((o) => `${o.label} ${o.hint || ''}`.toLowerCase().includes(needle)) : options;
      at = Math.min(at, Math.max(shown.length - 1, 0));
      let group = null;
      list.innerHTML = shown.map((o, n) => {
        const head = o.group && o.group !== group ? `<div class="pm-pick-group">${esc((group = o.group))}</div>` : '';
        return `${head}<button type="button" role="option" class="pm-pick-opt${n === at ? ' is-at' : ''}${o.value === value ? ' is-current' : ''}" data-n="${n}" aria-selected="${o.value === value}">
          ${o.html || esc(o.label)}${o.hint ? `<span class="pm-pick-hint">${esc(o.hint)}</span>` : ''}${o.value === value ? '<span class="pm-pick-tick" aria-hidden="true">✓</span>' : ''}</button>`;
      }).join('') || '<div class="pm-pick-none">Nothing matches.</div>';
      list.querySelector('.is-at')?.scrollIntoView({ block: 'nearest' });
    };
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const h = pop.offsetHeight;
      const below = window.innerHeight - r.bottom;
      pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) + window.scrollX}px`;
      pop.style.top = `${(below < h + 12 && r.top > h + 12 ? r.top - h - 4 : r.bottom + 4) + window.scrollY}px`;
    };
    const state = {
      close(v) {
        if (open !== state) return;
        open = null;
        pop.remove();
        document.removeEventListener('pointerdown', outside, true);
        window.removeEventListener('resize', place);
        anchor.setAttribute?.('aria-expanded', 'false');
        if (v === undefined) anchor.focus?.({ preventScroll: true });
        resolve(v);
      },
    };
    const outside = (e) => !pop.contains(e.target) && !anchor.contains(e.target) && state.close(undefined);
    open = state;
    anchor.setAttribute?.('aria-expanded', 'true');
    draw();
    extra?.(pop.querySelector('.pm-pick-extra'), (v) => state.close(v));
    place();
    window.addEventListener('resize', place);
    setTimeout(() => document.addEventListener('pointerdown', outside, true));
    q?.addEventListener('input', () => ((at = 0), draw()));
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-n]');
      if (b) state.close(shown[Number(b.dataset.n)].value);
    });
    pop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), state.close(undefined));
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        at = (at + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(shown.length, 1);
        draw();
        if (!q) list.querySelector('.is-at')?.focus();
      } else if (e.key === 'Enter' && e.target.matches('.pm-pick-q') && shown[at]) (e.preventDefault(), state.close(shown[at].value));
    });
    (q || list.querySelector('.is-at') || list.querySelector('button'))?.focus();
  });
}

// ---- the pickers ---------------------------------------------------------------------------------------
const RECENT = 'pm.recentPeople';
const recentPeople = () => {
  try {
    return JSON.parse(localStorage.getItem(RECENT) || '[]');
  } catch {
    return [];
  }
};
export const notePerson = (id) => {
  if (!id) return;
  try {
    localStorage.setItem(RECENT, JSON.stringify([id, ...recentPeople().filter((x) => x !== id)].slice(0, 5)));
  } catch { /* private window: no memory, no problem */ }
};

/** A person: me first, then the people picked lately, then everyone. `onlyMe` when I may only take it myself. */
export function pickPerson(anchor, b, current, { blank = 'No owner', onlyMe = false, label = 'Owner', among = null } = {}) {
  const name = (p) => p.full_name || p.email;
  const people = among ? b.people.filter((p) => among.includes(p.id)) : b.people;   // e.g. only people not in the project yet
  const me = people.find((p) => p.id === b.me);
  const recent = recentPeople().filter((id) => id !== b.me && people.some((p) => p.id === id));
  const options = [
    ...(blank ? [{ value: '', label: blank, html: `<span class="pm-avatar is-none">–</span> ${esc(blank)}` }] : []),
    ...(me ? [{ value: me.id, label: `${name(me)} (me)`, html: `${initialsHtml(name(me))} ${esc(name(me))} <span class="muted">(me)</span>` }] : []),
    ...(onlyMe ? [] : [
      ...recent.map((id) => b.personById.get(id)).filter(Boolean).map((p) => ({ value: p.id, label: name(p), html: `${initialsHtml(name(p))} ${esc(name(p))}`, group: 'Recent' })),
      ...people.filter((p) => p.id !== b.me && !recent.includes(p.id)).map((p) => ({ value: p.id, label: name(p), html: `${initialsHtml(name(p))} ${esc(name(p))}`, group: recent.length ? 'Everyone' : '' })),
    ]),
  ];
  if (onlyMe && current && current !== b.me && b.personById.get(current)) options.push({ value: current, label: name(b.personById.get(current)) });
  return openPicker(anchor, { label, options, value: current || '', search: !onlyMe, placeholder: 'Find a person' }).then((v) => (v === undefined ? v : (notePerson(v), v)));
}
const initialsHtml = (n) => `<span class="pm-avatar" aria-hidden="true">${esc(n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?')}</span>`;

/** A date: the common ones in one click, or any day. Resolves with 'YYYY-MM-DD', '' (no date) or undefined. */
export function pickDate(anchor, current, { label = 'Date', blank = 'No date' } = {}) {
  const t = todayISO();
  const add = (n) => new Date(Date.parse(`${t}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  const dow = new Date(`${t}T00:00:00Z`).getUTCDay();
  const nextMon = add(((8 - dow) % 7) || 7);
  const friday = add(((5 - dow) + 7) % 7 || 7);
  const opts = [['Today', t], ['Tomorrow', add(1)], [dow >= 5 || dow === 0 ? 'Next Friday' : 'This Friday', friday], ['Next Monday', nextMon], ['In a week', add(7)], ['In two weeks', add(14)]];
  const options = [...opts.map(([l, v]) => ({ value: v, label: l, hint: fmtDate(v) })), ...(blank && current ? [{ value: '', label: blank }] : [])];
  return openPicker(anchor, {
    label, options, value: current || null, search: false, width: 240,
    extra: (box, done) => {
      box.innerHTML = `<label class="pm-pick-date">Pick a day <input type="date" value="${esc(current || '')}" aria-label="${esc(label)}"></label>`;
      const input = box.querySelector('input');
      input.addEventListener('change', () => input.value && done(input.value));
      input.addEventListener('keydown', (e) => e.key === 'Enter' && input.value && (e.preventDefault(), done(input.value)));
    },
  });
}

export const pickPriority = (anchor, current) => openPicker(anchor, {
  label: 'Priority', search: false, width: 200, value: current || 'medium',
  options: PRIORITIES.map(([k, l, tone]) => ({ value: k, label: l, html: `<span class="chip-tone tone-${esc(tone)}">${esc(l)}</span>` })),
});

/** A kind of work from the project's list (archived ones left out). */
export const pickKind = (anchor, cfg, current) => openPicker(anchor, {
  label: 'Kind', value: current, width: 240,
  options: cfg.types.filter((t) => !t.archived_at || t.id === current).map((t) => ({ value: t.id, label: t.name, html: `<span class="pm-type tone-${esc(t.color)}">${esc(t.icon || t.name[0])}</span> ${esc(t.name)}` })),
});

/** Where an item can go next: its workflow's moves for my role. Resolves with a transition id. */
export function pickMove(anchor, cfg, moves) {
  return openPicker(anchor, {
    label: 'Status', search: moves.length > 7, width: 270,
    options: moves.map((t) => {
      const s = cfg.statusById.get(t.to_status);
      // what the move asks for, so nobody is surprised by a dialog
      const asks = [t.require_approval && 'needs approval', t.require_comment && 'asks for a comment', t.require_fields?.length && `asks for ${t.require_fields.length} field${t.require_fields.length === 1 ? '' : 's'}`].filter(Boolean).join(', ');
      const hint = [t.name !== s?.name && !/^(Move to|Back to) /.test(t.name) ? t.name : /^Back to /.test(t.name) ? 'back' : '', asks].filter(Boolean).join(' · ');
      return { value: t.id, label: `${s?.name || ''} ${t.name}`, html: `<span class="chip-tone tone-${esc(s?.color || 'gray')} pm-status">${esc(s?.name || '')}</span>`, hint };
    }),
  });
}

/** A number (estimate, progress): a few common values and a box for any other. */
export function pickNumber(anchor, current, { label, choices = [], unit = '', min = 0, max = null, step = 'any', blank = 'None' } = {}) {
  return openPicker(anchor, {
    label, search: false, width: 210, value: current ?? '',
    options: [...choices.map((n) => ({ value: n, label: `${n}${unit}` })), ...(blank && current !== null && current !== undefined && current !== '' ? [{ value: '', label: blank }] : [])],
    extra: (box, done) => {
      box.innerHTML = `<form class="pm-pick-num"><input type="number" min="${min}" ${max !== null ? `max="${max}"` : ''} step="${step}" value="${esc(current ?? '')}" aria-label="${esc(label)}"><button type="submit" class="btn btn-sm">Set</button></form>`;
      box.querySelector('form').onsubmit = (e) => {
        e.preventDefault();
        const v = e.target.querySelector('input').value;
        done(v === '' ? '' : Number(v));
      };
    },
  });
}
