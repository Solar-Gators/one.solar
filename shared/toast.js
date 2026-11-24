/**
 * one.solar: a short notice at the bottom of the screen ("Saved", "Sponsor deleted · Undo"), the same in every app.
 *
 *   import { toast } from '../shared/toast.js';
 *   toast('Saved');
 *   toast('Couldn't save: …', 'bad');
 *   toast('Acme Volts deleted', 'ok', { undo: () => restore() });   // Undo runs undo() once
 *
 * It stays long enough to read (longer for long messages and with Undo), closes with ×, and is announced to screen
 * readers (role="status", or "alert" for errors). One at a time: a new one replaces the last. Styles are in
 * shared/onesolar.css (.os-toast). The element also carries the older .pm-toast names Projects' pages and tests use.
 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function toast(message, kind = 'ok', { undo = null, undoLabel = 'Undo' } = {}) {
  document.querySelector('.os-toast')?.remove();
  const el = document.createElement('div');
  el.className = `os-toast pm-toast is-${kind}${undo ? ' has-undo' : ''}`;
  el.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
  el.innerHTML = `<span class="os-toast-text">${esc(message)}</span>${undo ? `<button type="button" class="os-toast-undo pm-toast-undo">${esc(undoLabel)}</button>` : ''}<button type="button" class="os-toast-x pm-toast-x" aria-label="Close">×</button>`;
  document.body.append(el);
  const long = Math.min(12000, 2600 + String(message).length * 45);
  const timer = setTimeout(() => el.remove(), undo ? Math.max(9000, long) : kind === 'ok' ? long : Math.max(8000, long));
  el.querySelector('.os-toast-x').onclick = () => (clearTimeout(timer), el.remove());
  el.querySelector('.os-toast-undo')?.addEventListener('click', () => {
    clearTimeout(timer);
    el.remove();
    undo();
  }, { once: true });
  return el;
}
