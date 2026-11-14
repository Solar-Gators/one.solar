/**
 * Tell people when the page they have open is out of date, or the database is mid-update.
 *
 *   import { startVersionCheck } from '../shared/version-check.js';
 *   startVersionCheck(supabaseClient);
 *
 * On load and whenever the window comes back into focus (at most once a minute):
 *   - version.json (written by the deploy) names a different commit than this page → "one.solar was updated. Reload."
 *   - the database is newer than this page expects → the same (an old page may save things wrongly);
 *   - the database is older than this page expects → "one.solar is being updated; some things may not work
 *     for a few minutes" (a deploy went out before its migration was run).
 * In the repo (VERSION 'dev': local and fake mode) version.json isn't checked.
 */
import { VERSION, SCHEMA_VERSION } from './version.js';

const MIN_GAP_MS = 60_000;
let client = null;
let lastCheck = 0;
let shown = '';

/** What the check found: '' (all fine), 'reload' or 'updating'. Exported for tests. */
export function verdict({ liveSha, schemaVersion }, { version = VERSION, expected = SCHEMA_VERSION } = {}) {
  if (version !== 'dev' && liveSha && liveSha !== version) return 'reload';
  const db = Number(schemaVersion);
  if (!Number.isFinite(db) || db <= 0) return '';
  if (db > expected) return 'reload';
  if (db < expected) return 'updating';
  return '';
}

async function liveSha() {
  if (VERSION === 'dev') return '';
  try {
    const res = await fetch(new URL('../version.json', import.meta.url), { cache: 'no-store' });
    return res.ok ? (await res.json()).sha || '' : '';
  } catch {
    return ''; // offline: say nothing
  }
}

async function schemaVersion() {
  try {
    const { data } = await client.from('app_settings').select('value').eq('key', 'general').maybeSingle();
    return data?.value?.schemaVersion ?? null;
  } catch {
    return null;
  }
}

function show(kind) {
  if (kind === shown) return;
  shown = kind;
  document.getElementById('os-version-banner')?.remove();
  if (!kind) return;
  const bar = document.createElement('div');
  bar.id = 'os-version-banner';
  bar.className = `os-version-banner ${kind}`;
  bar.setAttribute('role', 'status');
  bar.innerHTML = kind === 'reload'
    ? `<span><strong>one.solar was updated.</strong> Reload to get the new version (save what you're typing first).</span>
       <button type="button" class="btn btn-sm btn-primary" data-version-reload>Reload</button>`
    : `<span><strong>one.solar is being updated.</strong> Some things may not save for a few minutes.</span>`;
  bar.insertAdjacentHTML('beforeend', '<button type="button" class="os-version-close" aria-label="Hide this message" data-version-close>×</button>');
  bar.addEventListener('click', (e) => {
    if (e.target.closest('[data-version-reload]')) location.reload();
    if (e.target.closest('[data-version-close]')) bar.remove(); // until the next check finds something new
  });
  document.body.prepend(bar);
}

async function check() {
  if (Date.now() - lastCheck < MIN_GAP_MS) return;
  lastCheck = Date.now();
  const [sha, schema] = await Promise.all([liveSha(), schemaVersion()]);
  show(verdict({ liveSha: sha, schemaVersion: schema }));
}

export function startVersionCheck(supabaseClient) {
  if (client) return; // once per page
  client = supabaseClient;
  check();
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
}
