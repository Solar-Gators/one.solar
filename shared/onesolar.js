/**
 * one.solar: what every app shares in code.
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

/**
 * The team's logo and accent color (Admin → one.solar → Logo & accent, settings "appearance").
 * Any app that reads the settings (Orders, Finances, Sponsors, Admin, the home screen) calls
 * rememberBrand(appearance); every app then shows them: theme.js applies the accent before the
 * page draws, and the top bar's logo (account-menu.js, syncLogo) uses the logo.
 */
const BRAND_KEY = 'onesolar:brand';
const isHex = (c) => /^#[0-9a-f]{6}$/i.test(c || '');

export function getBrand() {
  try {
    const b = JSON.parse(localStorage.getItem(BRAND_KEY)) || {};
    return { logo: typeof b.logo === 'string' && /^data:image\/|^https?:/.test(b.logo) ? b.logo : '', accent: isHex(b.accent) ? b.accent : '' };
  } catch {
    return { logo: '', accent: '' };
  }
}

export function rememberBrand(appearance = {}) {
  const b = { logo: appearance.logo || '', accent: isHex(appearance.accent) ? appearance.accent : '' };
  try {
    if (b.logo || b.accent) localStorage.setItem(BRAND_KEY, JSON.stringify(b));
    else localStorage.removeItem(BRAND_KEY);
  } catch {}
  applyAccent(b.accent);
}

/** The accent color on this page ('' = the standard UF orange). Also GatorWire's --uf-orange. */
export function applyAccent(accent) {
  const root = document.documentElement.style;
  if (isHex(accent)) {
    const darker = `#${[1, 3, 5].map((i) => Math.round(parseInt(accent.slice(i, i + 2), 16) * 0.85).toString(16).padStart(2, '0')).join('')}`;
    root.setProperty('--orange', accent);
    root.setProperty('--orange-dark', darker);
    root.setProperty('--focus', `${accent}55`);
    root.setProperty('--uf-orange', accent);
  } else {
    ['--orange', '--orange-dark', '--focus', '--uf-orange'].forEach((v) => root.removeProperty(v));
  }
}
