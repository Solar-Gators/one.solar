/**
 * one.solar: the app switcher (⊞ next to the logo in every app's top bar, or Ctrl/⌘ + K).
 * Opens a small grid of the apps you can use, with a search box, so you can jump between apps
 * without going back to the home screen.
 *
 *   import { mountAppSwitcher } from '../shared/app-switcher.js';
 *   mountAppSwitcher();                 // puts the button after the top bar's .brand
 *   mountAppSwitcher({ after: el });    // or after another element
 *
 * The list is the cards the home screen last showed you (it saves them in this browser,
 * localStorage "onesolar:apps"), so admins' links, names and order show up here too. Before
 * you've opened the home screen it falls back to the public apps in hub/apps.js.
 * Styles are built in (GatorWire doesn't load shared/onesolar.css); they follow data-theme.
 */
import { appUrl, ROOT } from './onesolar.js';

const KEY = 'onesolar:apps';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Links admins add: a full https:// address, or a folder of this site (my-app/, orders/#/new). Anything else → null. */
export function safeHref(href) {
  const h = String(href ?? '').trim();
  if (/^https?:\/\/[^\s"'<>]+$/i.test(h)) return h;
  if (/^[a-z0-9][\w.~/-]*(#[\w.~/?=&%-]*)?$/i.test(h) && !h.includes('..')) return h;
  return null;
}

/** Called by the home screen with the cards it shows (and your favourites, which go first). */
export function rememberApps(cards, favs = []) {
  const list = cards
    .filter((c) => c.href)
    .map(({ id, name, icon, href }) => ({ id, name, icon, href }))
    .sort((a, b) => (favs.includes(b.id) - favs.includes(a.id)) || (favs.indexOf(a.id) - favs.indexOf(b.id)));
  try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), apps: list, favs })); } catch {}
}

async function apps() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved?.apps?.length) return saved.apps.filter((a) => safeHref(a.href));
  } catch {}
  const { APPS } = await import('../hub/apps.js');
  return APPS.filter((a) => a.access === 'public' || a.access === 'signedIn');
}

const external = (href) => /^https?:/i.test(href);
const urlOf = (href) => (external(href) ? href : appUrl(href));
/** The app this page belongs to: its folder under the site root. */
function currentId(list) {
  const here = location.pathname.slice(new URL(ROOT).pathname.length).split('/')[0];
  return list.find((a) => !external(a.href) && a.href.split(/[/#]/)[0] === here)?.id;
}

const CSS = `
.os-switch{position:relative;display:inline-flex;align-items:center;flex:none}
.os-switch-btn{display:inline-grid;place-items:center;width:36px;height:36px;border-radius:8px;border:1px solid transparent;background:transparent;color:#5d6d7e;font:20px/1 system-ui,sans-serif;cursor:pointer;padding:0}
.os-switch-btn:hover,.os-switch-btn[aria-expanded=true]{background:#f8fafc;border-color:#dde3ea;color:#f26b1d}
.os-switch-btn:focus-visible,.os-switch-pop :focus-visible{outline:3px solid #f26b1d55;outline-offset:1px}
.os-switch-pop{position:absolute;top:calc(100% + 8px);left:0;z-index:1000;width:340px;max-width:calc(100vw - 24px);padding:10px;border-radius:12px;background:#fff;color:#1c2733;border:1px solid #dde3ea;box-shadow:0 12px 32px rgba(11,37,69,.18);font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:left}
.os-switch-pop[hidden]{display:none}
.os-switch-pop input{box-sizing:border-box;width:100%;margin:0 0 8px;padding:7px 10px;border-radius:8px;border:1px solid #c8d1dc;background:#fff;color:inherit;font:inherit}
.os-switch-pop input:focus{outline:none;border-color:#f26b1d;box-shadow:0 0 0 3px #f26b1d55}
.os-switch-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;max-height:min(60vh,360px);overflow:auto}
.os-switch-grid a{display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 4px;border-radius:8px;color:inherit;text-decoration:none;text-align:center;font-size:12.5px;font-weight:600;line-height:1.25;min-width:0}
.os-switch-grid a span:last-child{overflow-wrap:anywhere}
.os-switch-grid a:hover,.os-switch-grid a:focus-visible{background:#f8fafc}
.os-switch-grid a.on{background:#fff4ec;color:#d85a10}
.os-switch-icon{font-size:24px;line-height:1}
.os-switch-none{grid-column:1/-1;margin:8px;color:#5d6d7e;text-align:center}
.os-switch-foot{display:flex;justify-content:space-between;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid #dde3ea;font-size:12px;color:#5d6d7e}
.os-switch-foot a{color:#d85a10;font-weight:600;text-decoration:none}
.os-switch-foot a:hover{text-decoration:underline}
.os-switch + .account-menu{margin-left:auto}
[data-theme=dark] .os-switch-btn{color:#a8b8ce}
[data-theme=dark] .os-switch-btn:hover,[data-theme=dark] .os-switch-btn[aria-expanded=true]{background:#0d2b50;border-color:#23486f;color:#fa4616}
[data-theme=dark] .os-switch-pop{background:#081f3d;color:#f7f9ff;border-color:#23486f;box-shadow:0 12px 32px #000a}
[data-theme=dark] .os-switch-pop input{background:#061a35;border-color:#31577f}
[data-theme=dark] .os-switch-grid a:hover,[data-theme=dark] .os-switch-grid a:focus-visible{background:#0d2b50}
[data-theme=dark] .os-switch-grid a.on{background:#2a1a12;color:#ff9a6b}
[data-theme=dark] .os-switch-foot{border-color:#23486f;color:#a8b8ce}
[data-theme=dark] .os-switch-foot a{color:#ff9a6b}
@media(max-width:960px){.topbar .os-switch{order:1}}
.os-nav-apps{display:none!important}
@media(max-width:420px){.topbar-inner:has(.menu-btn) > .os-switch{display:contents}.topbar-inner:has(.menu-btn) .os-switch-btn{display:none}.topbar-inner:has(.menu-btn) .os-nav-apps{display:flex!important}}
@media(max-width:640px){.os-switch-pop{position:fixed;top:64px;left:12px;right:12px;width:auto}.os-switch-foot span{display:none}}
`;

let mounted = false;

export function mountAppSwitcher({ after = document.querySelector('.topbar .brand, .os-brand, .brand') } = {}) {
  if (mounted || !after) return;
  mounted = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  const wrap = document.createElement('div');
  wrap.className = 'os-switch';
  wrap.innerHTML = `<button type="button" class="os-switch-btn" aria-haspopup="true" aria-expanded="false" aria-controls="os-switch-pop"
      title="All apps (Ctrl + K)" aria-label="Switch app">⊞</button>
    <div class="os-switch-pop" id="os-switch-pop" role="dialog" aria-label="Switch app" hidden>
      <input type="search" placeholder="Find an app…" aria-label="Find an app" autocomplete="off" spellcheck="false">
      <div class="os-switch-grid"></div>
      <div class="os-switch-foot"><a href="${esc(appUrl(''))}">All apps · one.solar home</a><span>Ctrl + K</span></div>
    </div>`;
  after.after(wrap);
  // Narrow phones with a folding Menu (Orders, Finances, Sponsors, Admin): no room for ⊞ next to the
  // logo, so the switcher is the last item in that Menu instead.
  const nav = after.closest('.topbar-inner')?.querySelector('.menu-btn') && after.closest('.topbar-inner').querySelector('.nav');
  if (nav) {
    const item = document.createElement('a');
    item.className = 'os-nav-apps';
    item.href = '#';
    item.textContent = '⊞ All one.solar apps';
    item.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation(); // keep the page's "click elsewhere closes the menu" from running too
      if (document.body.classList.contains('nav-open')) after.closest('.topbar-inner').querySelector('.menu-btn').click(); // the app closes its Menu
      open(true);
    };
    nav.append(item);
  }
  const btn = wrap.querySelector('.os-switch-btn');
  const pop = wrap.querySelector('.os-switch-pop');
  const box = pop.querySelector('input');
  const grid = pop.querySelector('.os-switch-grid');
  if (/Mac|iPhone|iPad/.test(navigator.platform)) {
    btn.title = 'All apps (⌘ K)';
    pop.querySelector('.os-switch-foot span').textContent = '⌘ K';
  }
  let list = [];

  const draw = () => {
    const q = box.value.trim().toLowerCase();
    const on = currentId(list);
    const shown = list.filter((a) => !q || a.name.toLowerCase().includes(q));
    grid.innerHTML = shown.length
      ? shown.map((a) => `<a href="${esc(urlOf(a.href))}"${external(a.href) ? ' target="_blank" rel="noopener"' : ''}${a.id === on ? ' class="on" aria-current="page"' : ''}>
          <span class="os-switch-icon" aria-hidden="true">${esc(a.icon)}</span><span>${esc(a.name)}${external(a.href) ? ' ↗' : ''}</span></a>`).join('')
      : '<p class="os-switch-none">No app by that name.</p>';
  };
  const open = async (yes) => {
    if (yes) {
      list = await apps();
      box.value = '';
      draw();
    }
    pop.hidden = !yes;
    btn.setAttribute('aria-expanded', String(yes));
    if (yes) box.focus();
  };

  btn.onclick = () => open(pop.hidden);
  box.oninput = draw;
  box.onkeydown = (e) => {
    if (e.key === 'Enter') grid.querySelector('a')?.click();
    if (e.key === 'ArrowDown') (e.preventDefault(), grid.querySelector('a')?.focus());
  };
  // Arrow keys move around the grid (3 across).
  grid.addEventListener('keydown', (e) => {
    const links = [...grid.querySelectorAll('a')];
    const i = links.indexOf(document.activeElement);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 3, ArrowUp: -3 }[e.key];
    if (i < 0 || !step) return;
    e.preventDefault();
    const j = i + step;
    if (j < 0) box.focus();
    else links[Math.min(j, links.length - 1)].focus();
  });
  document.addEventListener('click', (e) => {
    if (!pop.hidden && !e.composedPath().includes(wrap)) open(false);
    if (e.target.closest?.('.os-switch-grid a')) open(false);
  });
  addEventListener('hashchange', () => open(false)); // moving to another page of the same app
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      open(pop.hidden);
    } else if (e.key === 'Escape' && !pop.hidden) {
      open(false);
      btn.focus();
    }
  });
}
