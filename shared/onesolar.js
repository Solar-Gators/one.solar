/**
 * OneSolar: what every app shares in code.
 *
 *   import { ROOT, appUrl, signInUrl, isLocal, getTheme, setTheme } from '../shared/onesolar.js';
 *
 * Links between apps are worked out from where this file is served, so the same code works at
 * solar-gators.github.io/one.solar/, on a custom domain, and on localhost.
 */
export { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

/** The site root: the folder holding the home screen (index.html) and every app folder. */
export const ROOT = new URL('../', import.meta.url);

/** A link to another app: appUrl('orders/#/new'), appUrl('evals/'). */
export const appUrl = (path = '') => new URL(path, ROOT).href;

export const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

/**
 * The shared sign-in page (Orders' accounts), which comes back to `back` afterwards.
 * `back` is a path on this site; it defaults to the current page.
 */
export const signInUrl = (back = location.pathname) => `${appUrl('orders/')}?next=${encodeURIComponent(back)}`;

/** Light / dark: 'auto' follows the device. Same setting in every app (localStorage "theme"). */
export function getTheme() {
  try {
    const t = localStorage.getItem('theme');
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch {
    return 'auto';
  }
}

export function setTheme(mode) {
  try {
    if (mode === 'light' || mode === 'dark') localStorage.setItem('theme', mode);
    else localStorage.removeItem('theme');
  } catch {}
  applyTheme();
}

export function applyTheme() {
  const t = getTheme();
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

// Follow the device while on "auto", and other tabs/apps changing the setting.
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => getTheme() === 'auto' && applyTheme());
addEventListener('storage', (e) => e.key === 'theme' && applyTheme());
