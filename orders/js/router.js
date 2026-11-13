/**
 * Minimal hash router: "#/path" -> view function.
 * Each view is `async (el, ctx) => void` where
 *   ctx = { config, params, rerender, reloadConfig }.
 *
 * Signed-out users always get the sign-in page. Routes with `perm` are only
 * shown to users whose role has at least one of those permissions. Leads (CE
 * and Treasurer) can view both workflow queues, but each page only offers the
 * actions their role allows; the database enforces the same rules.
 */
import { auth } from './auth.js';
import { renderLogin } from './views/login.js';
import { renderAccount, renderResetPassword } from './views/account.js';
import { renderUsers, renderRoles, renderDropdowns, renderSeason, renderFormFields, renderImportOrders, ADMIN_TABS } from './views/admin.js';
import { renderAppearance, renderBrand, renderHistory } from './views/adminSetup.js';
import { renderDisplay, renderTextBanner, renderIntros } from './views/adminPages.js';
import { renderHomeScreen, renderOtherApps } from './views/adminApps.js';
import { renderWorkflow, renderNotifications } from './views/adminWorkflow.js';
import { renderHelp } from './views/help.js';
import { renderHome } from './views/home.js';
import { renderRequestForm } from './views/requestForm.js';
import { renderRequestList } from './views/requestList.js';
import { renderRequestDetail } from './views/requestDetail.js';
import { renderApprovals } from './views/approvals.js';
import { renderTreasurer } from './views/treasurer.js';
import { renderFinances } from './views/finances.js';
import { renderSponsors, renderSponsorCard } from './views/sponsors.js';
import { renderExport } from './views/exportPage.js';
import { renderArchive } from './views/archive.js';
import { errorBox, esc } from './ui.js';
import { confirmLeave } from './leaveGuard.js';
import { APP, APPS, appOf, homePath } from './appMode.js';
import { appUrl } from '../../shared/onesolar.js';

// Either workflow permission lets you view both queues (actions are still limited by role).
const LEADS = ['request.review', 'request.order'];

const tabPerms = (name) => ADMIN_TABS.find(([key]) => key === name)[2];

/** A page your role can't open: say who to ask, and give a way out. */
const WHO_TO_ASK = { finances: 'the Treasurer or an Admin', sponsors: 'the Business Coordinator or an Admin', admin: 'an Admin', orders: 'a Chief Engineer or an Admin' };
function noAccess() {
  const name = APPS[APP].name;
  return `<section class="card no-access">
    <h1>You don't have access to ${APP === 'orders' ? 'this page' : esc(name)}</h1>
    <p class="muted">Your role (${esc(auth.roleLabel)}) can't open it. If you need it, ask ${WHO_TO_ASK[APP]} to give you a role that can.</p>
    <div class="form-actions">
      <a class="btn btn-primary" href="${esc(appUrl(''))}">one.solar home</a>
      ${APP !== 'orders' ? `<a class="btn" href="${esc(appUrl('orders/'))}">Orders</a>` : '<a class="btn" href="#/home">Orders home</a>'}
    </div>
  </section>`;
}

/** 040: a Guest (signed up, not accepted yet) sees this instead of the team's pages. */
function waitingPage() {
  const name = auth.displayName;
  return `<section class="card no-access">
    <h1>You're signed up${name ? `, ${esc(name.split(' ')[0])}` : ''}. Almost in!</h1>
    <p>Someone on the team needs to accept you before you can see orders, evals and the rest of one.solar.
      Anyone on the team can: ask your Chief Engineer, a lead or anyone on the e-board to accept you on the one.solar home screen.</p>
    <p class="muted">Until then you can use the public tools on the home screen. This page updates once you're in.</p>
    <div class="form-actions">
      <a class="btn btn-primary" href="${esc(appUrl(''))}">one.solar home</a>
      <button type="button" class="btn" id="guest-check">Check again</button>
      <a class="btn btn-ghost" href="#/account">My account</a>
    </div>
  </section>`;
}
const GUEST_OK = /^\/(account|reset-password|help)$/;

const ROUTES = [
  { pattern: /^\/home$/, nav: 'home', view: renderHome },
  { pattern: /^\/new$/, nav: 'new', view: renderRequestForm },
  { pattern: /^\/requests$/, nav: 'requests', view: renderRequestList },
  { pattern: /^\/requests\/([^/]+)\/edit$/, nav: 'requests', view: renderRequestForm },
  // "Order again": a new request pre-filled from this one.
  { pattern: /^\/requests\/([^/]+)\/again$/, nav: 'new', view: renderRequestForm, copy: true },
  { pattern: /^\/requests\/([^/]+)$/, nav: 'requests', view: renderRequestDetail },
  { pattern: /^\/approvals$/, nav: 'queue', view: renderApprovals, perm: LEADS },
  { pattern: /^\/treasurer$/, nav: 'queue', view: renderTreasurer, perm: LEADS },
  // Queue opens on what you do: ordering for the Treasurer, approving for everyone else.
  { pattern: /^\/queue$/, redirect: () => (auth.can('request.order') && !auth.can('request.review') ? '#/treasurer' : '#/approvals') },
  { pattern: /^\/finances$/, nav: 'finances', view: renderFinances, perm: ['finances.view', 'finances.edit'] },
  { pattern: /^\/sponsors$/, nav: 'sponsors', view: renderSponsors, perm: ['sponsors.view', 'sponsors.edit'] },
  { pattern: /^\/sponsors\/([^/]+)$/, nav: 'sponsors', view: renderSponsorCard, perm: ['sponsors.view', 'sponsors.edit'] },
  { pattern: /^\/archive$/, nav: 'requests', view: renderArchive },
  { pattern: /^\/export$/, nav: 'requests', view: renderExport },
  { pattern: /^\/admin\/users$/, nav: 'admin', view: renderUsers, perm: tabPerms('users') },
  { pattern: /^\/admin\/fields$/, nav: 'admin', view: renderFormFields, perm: tabPerms('fields') },
  { pattern: /^\/admin\/roles$/, nav: 'admin', view: renderRoles, perm: tabPerms('roles') },
  { pattern: /^\/admin\/dropdowns$/, nav: 'admin', view: renderDropdowns, perm: tabPerms('dropdowns') },
  { pattern: /^\/admin\/season$/, nav: 'admin', view: renderSeason, perm: tabPerms('season') },
  // The old Settings page is now Dropdowns & rules + Team & season.
  { pattern: /^\/admin\/settings$/, redirect: () => (auth.can('settings.edit') ? '#/admin/dropdowns' : '#/admin/season') },
  { pattern: /^\/admin\/display(?:\/(lists|page|exports))?$/, nav: 'admin', view: renderDisplay, perm: tabPerms('display') },
  // Old addresses of what are now sections of "Lists, layout & Excel".
  { pattern: /^\/admin\/(lists|page|exports)$/, redirect: () => `#/admin/display/${location.hash.split('/').pop()}` },
  { pattern: /^\/admin\/import$/, nav: 'admin', view: renderImportOrders, perm: tabPerms('import') },
  { pattern: /^\/admin\/appearance$/, nav: 'admin', view: renderAppearance, perm: tabPerms('appearance') },
  { pattern: /^\/admin\/brand$/, nav: 'admin', view: renderBrand, perm: tabPerms('brand') },
  { pattern: /^\/admin\/intros$/, nav: 'admin', view: renderIntros, perm: tabPerms('intros') },
  { pattern: /^\/admin\/home$/, nav: 'admin', view: renderHomeScreen, perm: tabPerms('home') },
  { pattern: /^\/admin\/apps$/, nav: 'admin', view: renderOtherApps, perm: tabPerms('apps') },
  { pattern: /^\/admin\/text$/, nav: 'admin', view: renderTextBanner, perm: tabPerms('text') },
  { pattern: /^\/admin\/workflow$/, nav: 'admin', view: renderWorkflow, perm: tabPerms('workflow') },
  { pattern: /^\/admin\/notifications$/, nav: 'admin', view: renderNotifications, perm: tabPerms('notifications') },
  { pattern: /^\/help$/, nav: 'help', view: renderHelp },
  { pattern: /^\/admin\/history(?:\/([\w,]+))?$/, nav: 'admin', view: renderHistory, perm: tabPerms('history') },
  // "Admin" opens the first tab this person can use.
  { pattern: /^\/admin$/, redirect: () => `#/admin/${(ADMIN_TABS.find(([, , perms, , hidden]) => !hidden && perms.some((p) => auth.can(p))) || ['users'])[0]}` },
  { pattern: /^\/account$/, nav: 'account', view: renderAccount },
  { pattern: /^\/reset-password$/, view: renderResetPassword },
];

let renderToken = 0;

export function startRouter(ctx, { onRender } = {}) {
  const render = async () => {
    const token = ++renderToken;
    // No address (the app was just opened): the app's own first page (Orders' Home, the Sponsors board…).
    const path = location.hash.replace(/^#/, '') || homePath();
    // A page of another one.solar app (e.g. an old orders/#/sponsors/… link): open it there.
    const owner = appOf(path);
    if (owner && owner !== APP) {
      location.replace(`${appUrl(`${owner}/`)}${location.search}#${path}`);
      return;
    }
    let route = ROUTES.find((r) => r.pattern.test(path));

    if (auth.signedIn && auth.recovering) route = { view: renderResetPassword };
    else if (!auth.signedIn) route = { view: renderLogin, bare: true };
    else if (!route) {
      location.hash = `#${homePath()}`;
      return;
    } else if (route.redirect) {
      location.hash = route.redirect();
      return;
    }
    const guest = auth.signedIn && !auth.recovering && auth.isGuest && !GUEST_OK.test(path);

    document.body.classList.toggle('signed-out', !auth.signedIn);
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === route.nav));

    const match = route.pattern ? path.match(route.pattern) : [];
    const params = { id: match?.[1] ? decodeURIComponent(match[1]) : null, copy: !!route.copy };

    // Render into a detached element so a slow, stale view can't overwrite a newer one.
    const el = document.createElement('div');
    try {
      if (guest) {
        el.innerHTML = waitingPage();
        el.querySelector('#guest-check').addEventListener('click', async () => {
          await auth.refresh();
          if (auth.isGuest) el.querySelector('.muted').textContent = 'Not yet. Ask someone on the team to accept you, then check again.';
          else render();
        });
      } else if (route.perm && !route.perm.some((p) => auth.can(p))) {
        el.innerHTML = noAccess();
      } else {
        await route.view(el, { ...ctx, params, rerender: render });
      }
    } catch (err) {
      el.innerHTML = errorBox(err);
    }
    if (token !== renderToken) return;
    document.getElementById('app').replaceChildren(el);
    onRender?.();
  };

  // Leaving a page with unsaved changes asks first; "Stay" puts the address back.
  let currentHash = location.hash;
  let reverting = false;
  window.addEventListener('hashchange', () => {
    if (reverting) {
      reverting = false;
      return;
    }
    if (!confirmLeave()) {
      reverting = true;
      location.hash = currentHash;
      return;
    }
    currentHash = location.hash;
    render();
    window.scrollTo(0, 0);
  });
  render();
  return render;
}
