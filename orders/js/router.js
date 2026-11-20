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
import { emailLink } from './emailLink.js';
import { renderAccount, renderResetPassword } from './views/account.js';
import { renderUsers, renderDivisionsPeople, renderRoles, renderDropdowns, renderSeason, renderFormFields, renderImportOrders, ADMIN_TABS } from './views/admin.js';
import { renderAppearance, renderBrand, renderHistory } from './views/adminSetup.js';
import { renderDisplay, renderTextBanner, renderIntros } from './views/adminPages.js';
import { renderHomeScreen, renderOtherApps } from './views/adminApps.js';
import { renderWorkflow, renderNotifications } from './views/adminWorkflow.js';
import { renderDiagnostics } from './views/diagnostics.js';
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
import { renderInvDashboard } from './views/inventory/dashboard.js';
import { renderInvItems } from './views/inventory/items.js';
import { renderInvItem } from './views/inventory/item.js';
import { renderInvItemForm } from './views/inventory/itemForm.js';
import { renderInvLocation } from './views/inventory/location.js';
import { renderInvReceive } from './views/inventory/receive.js';
import { renderInvActivity } from './views/inventory/activity.js';
import { renderInvCounts, renderInvCount } from './views/inventory/counts.js';
import { renderInvReports } from './views/inventory/reports.js';
import { renderInvSetup, renderAdminOrg } from './views/inventory/setup.js';
import { renderInvLabels } from './views/inventory/labels.js';
import { renderInvScan } from './views/inventory/scan.js';
import { INV_PERMS } from './views/inventory/kit.js';
import { PM_PERMS } from './views/projects/kit.js';
import { renderMyWork } from './views/projects/myWork.js';
import { renderProjects } from './views/projects/projects.js';
import { renderProject, renderAcross } from './views/projects/project.js';
import { renderItem } from './views/projects/item.js';
import { renderDashboards } from './views/projects/dashboards.js';
import { renderTemplates } from './views/projects/templates.js';
import { renderInbox } from './views/projects/inbox.js';
import { renderKinds } from './views/projects/kinds.js';
import { errorBox, esc } from './ui.js';
import { api } from './api.js';
import { needsText, rolesWith } from './messages.js';
import { confirmLeave } from './leaveGuard.js';
import { APP, APPS, appOf, homePath } from './appMode.js';
import { appUrl } from '../../shared/onesolar.js';

// Either workflow permission lets you view both queues (actions are still limited by role).
const LEADS = ['request.review', 'request.order'];

const tabPerms = (name) => ADMIN_TABS.find(([key]) => key === name)[2];

/** A page your role can't open: say who to ask, and give a way out. */
const WHO_TO_ASK = { finances: 'the Treasurer or an Admin', sponsors: 'the Business Coordinator or an Admin', admin: 'an Admin', orders: 'a Chief Engineer or an Admin', inventory: 'an inventory manager or an Admin', projects: 'an Admin' };
async function noAccess(perms) {
  const name = APPS[APP].name;
  // U-2: name the permission and the roles that have it (both readable by everyone signed in).
  const needs = await Promise.all([api.listPermissions(), api.listRolePermissions()])
    .then(([permissions, rolePermissions]) => needsText(perms, { permissions, rolePermissions, roles: auth.roles }))
    .catch(() => '');
  return `<section class="card no-access">
    <h1>You don't have access to ${APP === 'orders' ? 'this page' : esc(name)}</h1>
    ${needs ? `<p data-needs>${esc(needs)}</p>` : ''}
    <p class="muted">Your role (${esc(auth.roleLabel)}) can't open it. If you need it, ask ${WHO_TO_ASK[APP]} to give you a role that can.</p>
    <div class="form-actions">
      <a class="btn btn-primary" href="${esc(appUrl(''))}">one.solar home</a>
      ${APP !== 'orders' ? `<a class="btn" href="${esc(appUrl('orders/'))}">Orders</a>` : '<a class="btn" href="#/home">Orders home</a>'}
    </div>
  </section>`;
}

/** 040: a Guest (signed up, not accepted yet) sees this instead of the team's pages. */
async function waitingPage() {
  const name = auth.displayName;
  // 052: alumni (and people who signed up to join as one) belong on SGAA, the alumni hub.
  const alum = await api.myAlumStatus(auth.user?.id);
  const sgaa = esc(appUrl('sgaa/'));
  if (alum === 'alum') {
    return `<section class="card no-access">
    <h1>Welcome back${name ? `, ${esc(name.split(' ')[0])}` : ''}!</h1>
    <p>As a Solar Gators alum, your part of one.solar is the alumni hub: what the team needs, how to help, updates,
      events, and other alumni.</p>
    <div class="form-actions">
      <a class="btn btn-primary" href="${sgaa}">Go to the alumni hub</a>
      <a class="btn" href="#/account">My account</a>
    </div>
  </section>`;
  }
  if (alum === 'pending') {
    // Signed up on "Join as an alum" (052): approved in SGAA, not here. The join page asks for anything missing.
    return `<section class="card no-access">
    <h1>Your alumni account is waiting for approval</h1>
    <p>Someone on the team will check it soon. If you haven't yet, tell them when you graduated and what you did on the
      team on the alumni hub. Until then you can look around there.</p>
    <div class="form-actions">
      <a class="btn btn-primary" href="${sgaa}#/join">Go to the alumni hub</a>
    </div>
  </section>`;
  }
  if (auth.isFormer) {
    return `<section class="card no-access">
    <h1>Your one.solar access has ended</h1>
    <p>Your account was moved to former members, so the team's orders, evals and other apps aren't available to you any more.
      Everything you did is still there, with your name on it.</p>
    <p class="muted">If this is a mistake, ask an Admin to reactivate you.</p>
    <div class="form-actions">
      <a class="btn btn-primary" href="${esc(appUrl(''))}">one.solar home</a>
      <button type="button" class="btn" id="guest-check">Check again</button>
    </div>
  </section>`;
  }
  // U-1: where they stand. Email confirmed (043 needs it), and which positions can accept them.
  const accepters = await api.listRolePermissions()
    .then((rp) => rolesWith(['people.accept'], rp, auth.roles).filter((r) => r !== 'Member'))
    .catch(() => []);
  const confirmed = auth.emailConfirmed;
  return `<section class="card no-access">
    <h1>You're signed up${name ? `, ${esc(name.split(' ')[0])}` : ''}. Almost in!</h1>
    <p>Someone on the team needs to accept you before you can see orders, evals and the rest of one.solar.
      Ask ${accepters.length ? `your ${esc(accepters.join(', ').replace(/, ([^,]*)$/, ' or $1'))}` : 'your Chief Engineer or anyone on the e-board'} to accept you on the one.solar home screen.</p>
    <ul class="waiting-steps">
      <li class="${confirmed ? 'done' : 'todo'}" data-email-confirmed="${confirmed}">${confirmed
        ? '✓ Email address confirmed'
        : '✗ Email address not confirmed yet. Click the link in the email we sent you; nobody can accept you until you do.'}</li>
      <li class="todo">… Waiting for someone to accept you</li>
    </ul>
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
  // Inventory (050). Anyone with an Inventory permission can look; each page offers only what their role can do.
  { pattern: /^\/inventory$/, nav: 'inv-home', view: renderInvDashboard, perm: INV_PERMS },
  { pattern: /^\/inventory\/items$/, nav: 'inv-items', view: renderInvItems, perm: INV_PERMS },
  { pattern: /^\/inventory\/items\/new$/, nav: 'inv-items', view: renderInvItemForm, perm: INV_PERMS },
  { pattern: /^\/inventory\/items\/([^/]+)\/edit$/, nav: 'inv-items', view: renderInvItemForm, perm: INV_PERMS },
  { pattern: /^\/inventory\/items\/([^/]+)$/, nav: 'inv-items', view: renderInvItem, perm: INV_PERMS },
  { pattern: /^\/inventory\/locations\/([^/]+)$/, nav: 'inv-items', view: renderInvLocation, perm: INV_PERMS },
  { pattern: /^\/inventory\/receive(?:\/([^/]+))?$/, nav: 'inv-receive', view: renderInvReceive, perm: INV_PERMS },
  { pattern: /^\/inventory\/activity$/, nav: 'inv-activity', view: renderInvActivity, perm: INV_PERMS },
  { pattern: /^\/inventory\/counts$/, nav: 'inv-counts', view: renderInvCounts, perm: INV_PERMS },
  { pattern: /^\/inventory\/counts\/([^/]+)$/, nav: 'inv-counts', view: renderInvCount, perm: INV_PERMS },
  { pattern: /^\/inventory\/reports$/, nav: 'inv-reports', view: renderInvReports, perm: INV_PERMS },
  { pattern: /^\/inventory\/setup(?:\/(\w+))?$/, nav: 'inv-setup', view: renderInvSetup, perm: [...INV_PERMS, 'settings.edit'] },
  { pattern: /^\/inventory\/labels$/, nav: 'inv-items', view: renderInvLabels, perm: INV_PERMS },
  { pattern: /^\/inventory\/scan$/, nav: 'inv-scan', view: renderInvScan, perm: INV_PERMS },
  // Projects (051). Anyone who can open Projects gets the pages; what they can do in a project is their role in it.
  { pattern: /^\/projects$/, nav: 'pm-mine', view: renderMyWork, perm: PM_PERMS },
  { pattern: /^\/projects\/all$/, nav: 'pm-projects', view: renderProjects, perm: PM_PERMS },
  { pattern: /^\/projects\/item\/([^/]+)$/, nav: 'pm-projects', view: renderItem, perm: PM_PERMS },
  { pattern: /^\/projects\/p\/([^/]+)(?:\/([\w-]+))?(?:\/([\w-]+))?(?:\/([\w-]+))?$/, nav: 'pm-projects', view: renderProject, perm: PM_PERMS },
  { pattern: /^\/projects\/(boards)$/, nav: 'pm-boards', view: renderAcross, perm: PM_PERMS },
  { pattern: /^\/projects\/(timeline)$/, nav: 'pm-timeline', view: renderAcross, perm: PM_PERMS },
  { pattern: /^\/projects\/(calendar)$/, nav: 'pm-calendar', view: renderAcross, perm: PM_PERMS },
  { pattern: /^\/projects\/(list)$/, nav: 'pm-projects', view: renderAcross, perm: PM_PERMS },
  { pattern: /^\/projects\/dashboards(?:\/([\w-]+))?$/, nav: 'pm-dash', view: renderDashboards, perm: PM_PERMS },
  { pattern: /^\/projects\/templates$/, nav: 'pm-templates', view: renderTemplates, perm: ['projects.create', 'projects.manage'] },
  { pattern: /^\/projects\/inbox$/, nav: 'pm-inbox', view: renderInbox, perm: PM_PERMS },
  { pattern: /^\/projects\/kinds$/, nav: 'pm-kinds', view: renderKinds, perm: PM_PERMS },
  { pattern: /^\/export$/, nav: 'requests', view: renderExport },
  { pattern: /^\/admin\/users$/, nav: 'admin', view: renderUsers, perm: tabPerms('users') },
  { pattern: /^\/admin\/people$/, nav: 'admin', view: renderDivisionsPeople, perm: tabPerms('people') },
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
  { pattern: /^\/admin\/org$/, nav: 'admin', view: renderAdminOrg, perm: tabPerms('org') },
  { pattern: /^\/admin\/apps$/, nav: 'admin', view: renderOtherApps, perm: tabPerms('apps') },
  { pattern: /^\/admin\/text$/, nav: 'admin', view: renderTextBanner, perm: tabPerms('text') },
  { pattern: /^\/admin\/workflow$/, nav: 'admin', view: renderWorkflow, perm: tabPerms('workflow') },
  { pattern: /^\/admin\/notifications$/, nav: 'admin', view: renderNotifications, perm: tabPerms('notifications') },
  { pattern: /^\/admin\/diagnostics$/, nav: 'admin', view: renderDiagnostics, perm: tabPerms('diagnostics') },
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
    // A page that takes more than a moment shows a thin bar at the top (apps that style body.is-loading).
    const slow = setTimeout(() => token === renderToken && document.body.classList.add('is-loading'), 250);
    try {
      await renderPage(token);
    } finally {
      clearTimeout(slow);
      if (token === renderToken) document.body.classList.remove('is-loading');
    }
  };
  const renderPage = async (token) => {
    // No address (the app was just opened): the app's own first page (Orders' Home, the Sponsors board…).
    // "#/inventory/items?q=bolt": the page, then its filters (kept in the address, so a link or Back keeps them).
    const [path, search = ''] = (location.hash.replace(/^#/, '') || homePath()).split('?');
    // A page of another one.solar app (e.g. an old orders/#/sponsors/… link): open it there.
    const owner = appOf(path);
    if (owner && owner !== APP) {
      location.replace(`${appUrl(`${owner}/`)}${location.search}#${path}${search ? `?${search}` : ''}`);
      return;
    }
    let route = ROUTES.find((r) => r.pattern.test(path));

    // An unused email link (password reset / confirm email) gets its button page, even if someone is signed in here.
    if (emailLink.tokenHash && !emailLink.used) route = { view: renderLogin, bare: true };
    else if (auth.signedIn && auth.recovering) route = { view: renderResetPassword };
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
    const params = { id: match?.[1] ? decodeURIComponent(match[1]) : null, copy: !!route.copy, query: new URLSearchParams(search), parts: (match || []).slice(1).map((x) => (x ? decodeURIComponent(x) : '')) };

    // Render into a detached element so a slow, stale view can't overwrite a newer one.
    const el = document.createElement('div');
    try {
      if (guest) {
        el.innerHTML = await waitingPage();
        el.querySelector('#guest-check')?.addEventListener('click', async () => {
          await auth.refresh();
          if (auth.isGuest) el.querySelector('.muted').textContent = auth.isFormer ? 'Still a former member. Ask an Admin to reactivate you.' : 'Not yet. Ask someone on the team to accept you, then check again.';
          else render();
        });
      } else if (route.perm && !route.perm.some((p) => auth.can(p))) {
        el.innerHTML = await noAccess(route.perm);
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
