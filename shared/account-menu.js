/**
 * OneSolar: the account area at the right of the top bar, the same in every app.
 *
 *   renderAccount(document.querySelector('#account'), {
 *     user,                 // the Supabase user, or null when signed out
 *     name, role,           // shown on the button ("Riley Tester", "Chief Engineer")
 *     onSignOut,            // async () => …
 *     links: [{ label, href }],  // extra menu items (optional)
 *     signIn: true,         // show "Sign in" when signed out (false for apps without accounts)
 *   });
 *
 * Signed in: a button with your name and position that opens a menu (My account, the app's own
 * links, Appearance: Auto / Light / Dark, Sign out). Signed out: a light/dark switch and Sign in.
 * Looks come from shared/onesolar.css (.account-menu, .account-pop, .theme-pick).
 */
import { appUrl, signInUrl, getTheme, setTheme, applyTheme, getBrand } from './onesolar.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The top bar's logo: the team's own (Admin → Logo & accent), or the Solar Gators logo, which has a light and a dark version. */
export function syncLogo() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const own = getBrand().logo;
  for (const img of document.querySelectorAll('img.brand-logo[data-auto-logo]')) {
    img.src = own || appUrl(`shared/assets/solar-gators-logo${dark ? '-dark' : ''}.png`);
  }
}
new MutationObserver(syncLogo).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
syncLogo();

const themeButtons = () => {
  const t = getTheme();
  return ['auto', 'light', 'dark']
    .map((m) => `<button type="button" data-theme-set="${m}" aria-pressed="${t === m}"${m === 'auto' ? ' title="Follow this device\'s setting"' : ''}>${m[0].toUpperCase() + m.slice(1)}</button>`)
    .join('');
};

export function renderAccount(host, { user, name = '', role = '', onSignOut, links = [], signIn = true } = {}) {
  if (!user) {
    const dark = document.documentElement.dataset.theme === 'dark';
    host.innerHTML = `<button type="button" class="btn btn-ghost btn-sm theme-flip" title="Switch to ${dark ? 'light' : 'dark'}" aria-label="Switch to ${dark ? 'light' : 'dark'}">${dark ? '☀️' : '🌙'}</button>
      ${signIn ? `<a class="btn btn-primary btn-sm" href="${esc(signInUrl())}">Sign in</a>` : ''}`;
    host.querySelector('.theme-flip').onclick = () => {
      setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
      renderAccount(host, { user, name, role, onSignOut, links, signIn });
    };
    return;
  }
  host.innerHTML = `<div class="account-menu">
      <button type="button" class="account-link" aria-expanded="false" aria-haspopup="true" title="${esc(user.email || '')}">
        <span class="account-name">${esc(name || user.email || '')}</span>
        ${role ? `<span class="account-role">${esc(role)}</span>` : ''}
      </button>
      <div class="account-pop" hidden>
        <a href="${esc(appUrl('orders/#/account'))}">My account &amp; notifications</a>
        ${links.map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>`).join('')}
        <div class="theme-pick" role="group" aria-label="Appearance">
          <span>Appearance</span>
          <div class="theme-options">${themeButtons()}</div>
        </div>
        <button type="button" data-sign-out>Sign out</button>
      </div>
    </div>`;
  const btn = host.querySelector('.account-link');
  const pop = host.querySelector('.account-pop');
  const open = (on) => {
    pop.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    open(pop.hidden);
  };
  pop.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-theme-set]');
    if (t) {
      setTheme(t.dataset.themeSet);
      pop.querySelector('.theme-options').innerHTML = themeButtons();
      return;
    }
    if (e.target.closest('[data-sign-out]')) {
      open(false);
      await onSignOut?.();
    }
  });
  if (!bound.has(host)) {
    bound.add(host);
    const close = () => {
      const p = host.querySelector('.account-pop');
      if (p && !p.hidden) {
        p.hidden = true;
        host.querySelector('.account-link')?.setAttribute('aria-expanded', 'false');
        return true;
      }
    };
    // composedPath, not contains(): the theme buttons are redrawn while the click is still going.
    document.addEventListener('click', (e) => !e.composedPath().includes(host) && close());
    document.addEventListener('keydown', (e) => e.key === 'Escape' && close() && host.querySelector('.account-link')?.focus());
  }
}
const bound = new WeakSet();

export { applyTheme };
