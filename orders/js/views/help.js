/**
 * Help page: "Your first week" for each of your roles (built in, U-1), then the team's own instructions,
 * written in Admin → one.solar → Banner & messages. The Help tab only appears once the team has written
 * theirs; the page itself is always there (the hub's "You're in" card links to it).
 */
import { auth } from '../auth.js';
import { esc, renderRichText } from '../ui.js';
import { appUrl } from '../../../shared/onesolar.js';

/** Has the team written a Help page? (Decides whether the Help tab shows.) */
export const hasHelp = (config) => String(config.appearance?.helpText || '').trim() !== '';

/** What each built-in role does first. {path} becomes a one.solar link. */
export const FIRST_WEEK = {
  member: ['Member', [
    'Ask for parts with a <a href="{orders/#/new}">New request</a>: one vendor per request, a link and price for every item.',
    'Keep an eye on <a href="{orders/#/requests}">Requests</a>: you get a message when yours is approved, ordered or sent back.',
    'Fill out your self-eval in <a href="{evals/}">Solar Evals</a> when your Chief Engineer asks for it.',
  ]],
  ce: ['Chief Engineer', [
    'Approve or send back requests in the <a href="{orders/#/approvals}">Queue</a>. Requests whose maker also approved them are marked “Self-approved”.',
    'Accept new people waiting on the <a href="{}">one.solar home screen</a> (once they have confirmed their email).',
    'Start evaluations for your members in <a href="{evals/}">Solar Evals</a>.',
  ]],
  treasurer: ['Treasurer', [
    'Order approved requests from the <a href="{orders/#/treasurer}">Queue</a>, and mark each one ordered with its ticket number.',
    'Keep <a href="{finances/}">Finances</a> up to date: steps, budgets, and purchases made outside the site.',
  ]],
  coordinator: ['Business Coordinator', [
    'Work the <a href="{sponsors/}">Sponsors board</a>: claim a sponsor, log each contact, and move cards as talks go on.',
  ]],
  eboard: ['E-board', [
    'Accept new people waiting on the <a href="{}">one.solar home screen</a>.',
    'See where money and sponsors stand in <a href="{finances/}">Finances</a> and <a href="{sponsors/}">Sponsors</a>.',
  ]],
  admin: ['Admin', [
    'People, roles and deactivation are in <a href="{admin/#/admin/users}">Admin → Users</a>.',
    'Check <a href="{admin/#/admin/diagnostics}">Admin → Diagnostics</a> after each release for errors and problem reports.',
  ]],
};

/** "Your first week" for the given roles (Member's list is shown to everyone on the team). */
export function firstWeekHTML(roles, url = appUrl) {
  const keys = ['member', ...roles.filter((r) => r !== 'member' && FIRST_WEEK[r])];
  const link = (html) => html.replace(/\{([^}]*)\}/g, (_, path) => esc(url(path)));
  return keys.map((k) => {
    const [label, steps] = FIRST_WEEK[k];
    return `<h3>${esc(label)}</h3><ul>${steps.map((text) => `<li>${link(text)}</li>`).join('')}</ul>`;
  }).join('');
}

export async function renderHelp(el, { config }) {
  const own = String(config.appearance?.helpText || '').trim();
  el.innerHTML = `
    <div class="page-header"><div><h1>Help</h1></div></div>
    ${auth.isGuest ? '' : `<section class="card help-page first-week" id="first-week">
      <h2>Your first week</h2>
      ${firstWeekHTML(auth.user?.roles || [])}
      <p class="muted small">Something not working? Use <strong>Report a problem</strong> in your account menu.</p>
    </section>`}
    ${
      own
        ? `<section class="card help-page">${renderRichText(own)}</section>`
        : auth.can('site.customize')
          ? '<div class="empty">Add the team\'s own instructions in <a href="#/admin/text">Admin → one.solar → Banner &amp; messages</a>, and a Help tab appears for everyone.</div>'
          : ''
    }`;
}
