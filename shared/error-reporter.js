/**
 * Tell Admins when something breaks in someone's browser (Admin → one.solar → Diagnostics, 046).
 *
 *   import { startErrorReporter } from '../shared/error-reporter.js';
 *   startErrorReporter(supabaseClient, 'orders');
 *
 * Sends uncaught errors and rejected promises: the message, a short stack (file:line), the app, the build,
 * and the page (path and #route only). Never form contents, storage, cookies or tokens; anything that
 * looks like a token or an email address is blanked before sending (and again by the database).
 * At most 5 different reports per page load. Reporting never throws.
 *
 * reportProblem(text) sends a "Report a problem" message (the account menu offers it).
 */
import { VERSION } from './version.js';

const MAX_PER_PAGE = 5;
let client = null;
let app = '';
let sent = 0;
const seenMessages = new Set();

/** Blank out tokens and email addresses, and cut to `max` characters. Exported for tests. */
export function scrub(text, max) {
  return String(text ?? '')
    .replace(/eyJ[\w-]+\.[\w-]+(\.[\w-]+)?/g, '[token]')
    .replace(/[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
    .slice(0, max);
}

/** The page: path and #route only (no query string, nothing after the route). Exported for tests. */
export function pagePath(loc = location) {
  const route = (loc.hash || '').match(/^#[^?&=]*/)?.[0] || '';
  return (loc.pathname + route).slice(0, 200);
}

/** "at load (https://site/orders/js/api.js:12:5)" → "at load (orders/js/api.js:12)", first 8 lines. Exported for tests. */
export function shortStack(stack, origin = typeof location === 'undefined' ? '' : location.origin) {
  return String(stack || '')
    .split('\n')
    .slice(0, 8)
    .map((line) => line.trim().split(origin + '/').join('').replace(/\?[^:)\s]*/g, '').replace(/(\.m?js):(\d+):\d+/g, '$1:$2'))
    .join('\n');
}

function send(kind, message, detail) {
  if (!client) return Promise.resolve(false);
  const p = {
    kind, app, version: VERSION,
    message: scrub(message, 500), detail: scrub(detail, 2000),
    path: pagePath(), ua: navigator.userAgent.slice(0, 200),
  };
  return Promise.resolve(client.rpc('log_client_error', { p }))
    .then((res) => !res?.error)
    .catch(() => false);
}

function capture(kind, message, stack) {
  const key = `${kind}:${message}`;
  if (!message || seenMessages.has(key) || sent >= MAX_PER_PAGE) return;
  seenMessages.add(key);
  sent++;
  send(kind, message, shortStack(stack));
}

export function startErrorReporter(supabaseClient, appName) {
  if (client) return;
  client = supabaseClient;
  app = appName;
  window.addEventListener('error', (e) => {
    if (e.message) capture('error', e.message, e.error?.stack || `${e.filename || ''}:${e.lineno || ''}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    capture('rejection', r?.message || String(r ?? 'Unknown'), r?.stack || '');
  });
}

/** Can this page send a problem report? (Only once the reporter is started.) */
export const canReport = () => !!client;

/** "Report a problem": true if it was sent. */
export function reportProblem(text) {
  const body = String(text || '').trim();
  if (!body) return Promise.resolve(false);
  return send('report', body.slice(0, 200), body);
}

/** The "Report a problem" dialog (used by the account menus). */
export function openReportDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'os-report-dialog';
  dialog.innerHTML = `<form method="dialog" novalidate>
      <h2>Report a problem</h2>
      <label for="os-report-text">What went wrong? What were you trying to do?</label>
      <textarea id="os-report-text" rows="5" maxlength="2000" required></textarea>
      <p class="os-report-hint">The page you're on and the version of one.solar are added for you.
        Don't include passwords or bank details.</p>
      <p class="os-report-msg" role="status" hidden></p>
      <div class="os-report-actions">
        <button type="button" class="btn btn-ghost" data-report-cancel>Cancel</button>
        <button type="submit" class="btn btn-primary">Send</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const text = dialog.querySelector('textarea');
  const msg = dialog.querySelector('.os-report-msg');
  dialog.addEventListener('close', () => dialog.remove());
  dialog.querySelector('[data-report-cancel]').onclick = () => dialog.close();
  dialog.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    if (!text.value.trim()) return text.focus();
    const button = dialog.querySelector('[type="submit"]');
    button.disabled = true;
    const ok = await reportProblem(text.value);
    msg.hidden = false;
    msg.textContent = ok ? 'Thanks, an Admin will see this.' : "That didn't send. Check your connection and try again.";
    if (ok) {
      text.disabled = true;
      button.hidden = true;
      dialog.querySelector('[data-report-cancel]').textContent = 'Close';
    } else {
      button.disabled = false;
    }
  };
  dialog.showModal();
  text.focus();
}
