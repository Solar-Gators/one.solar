/**
 * Two Admin pages that point to settings kept somewhere else:
 *   #/admin/home  — OneSolar → Home screen: what's customized there, and a button to edit it on the home
 *                   screen itself (✎ Edit home screen, hub/home.js; settings "onesolar", migration 029)
 *   #/admin/apps  — Other apps → where Sponsors, Finances and Solar Evals keep their own settings
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { esc } from '../ui.js';
import { appUrl } from '../../../shared/onesolar.js';
import { APPS as CARDS, SECTIONS } from '../../../hub/apps.js';
import { adminHeader } from './admin.js';

// ---- Home screen -------------------------------------------------------------------------------

const SHOW_WORDS = { everyone: 'everyone', signedIn: 'anyone signed in', roles: 'some positions', hidden: 'nobody (hidden)' };

export async function renderHomeScreen(el) {
  const settings = await api.getSettings();
  const s = settings.onesolar || {};
  const cards = s.cards || {};
  const nameOf = (id) => cards[id]?.name || CARDS.find((c) => c.id === id)?.name || (s.links || []).find((l) => l.id === id)?.name || id;
  const links = (s.links || []).filter((l) => l?.id);
  const changed = Object.entries(cards).filter(([id, c]) => c.show && !links.some((l) => l.id === id));
  const renamed = Object.entries(cards).filter(([id, c]) => c.name && CARDS.some((x) => x.id === id));
  const sections = s.sections?.length ? s.sections : SECTIONS;
  const list = (items) => (items.length ? `<ul class="plain-list">${items.join('')}</ul>` : '<p class="muted small">None.</p>');

  el.innerHTML = `
    ${adminHeader('home', 'The OneSolar home screen: the app cards everyone sees, in which order, and links to other sites.')}
    <div class="two-col">
      <section class="card">
        <h2>Edit it on the home screen</h2>
        <p>The home screen is edited right where people see it: open it and click <strong>✎ Edit home screen</strong>.</p>
        <ul class="plain-list bullets">
          <li><strong>+ Add a link</strong> to any other site, a shared drive folder, or a new app.</li>
          <li>Drag cards to reorder them, or move them between sections.</li>
          <li>Add, rename and reorder sections.</li>
          <li>✎ Edit a card: its name, description, icon, and who sees it.</li>
        </ul>
        <a class="btn btn-primary" href="${esc(appUrl('?edit'))}">Open the home screen editor</a>
        <p class="muted small">Who sees a card only tidies the home screen; each app's own permissions decide what people can do in it.
          Everyone can also ☆ favourite cards and search them; that's kept in their own browser.</p>
      </section>
      <section class="card">
        <h2>What's customized now</h2>
        <h3 class="sub-heading">Sections, in order</h3>
        <p>${sections.map((x) => esc(x.name)).join(' · ')}</p>
        <h3 class="sub-heading">Links added (${links.length})</h3>
        ${list(links.map((l) => `<li>${esc(l.icon || '🔗')} ${esc(l.name)} <span class="muted small">${esc(l.href)}</span></li>`))}
        <h3 class="sub-heading">Who sees what (${changed.length} changed)</h3>
        ${list(changed.map(([id, c]) => `<li>${esc(nameOf(id))}: <span class="muted">${esc(SHOW_WORDS[c.show] || c.show)}</span></li>`))}
        ${renamed.length ? `<h3 class="sub-heading">Renamed</h3>${list(renamed.map(([id, c]) => `<li>${esc(CARDS.find((x) => x.id === id).name)} → ${esc(c.name)}</li>`))}` : ''}
      </section>
    </div>`;
}

// ---- Other apps ----------------------------------------------------------------------------------

/** Where each app keeps its own settings. `perm`: who can change them (shown so admins know who to ask). */
const OTHER_APPS = [
  {
    icon: '🤝', name: 'Sponsors', perm: 'sponsors.edit', who: 'Edit sponsors',
    items: [
      ['Board settings', 'The board\'s stages, sponsor types, and which Finances funding line received money goes to.', 'sponsors/'],
      ['Tags', 'Rename or merge the tags used on sponsor cards (it spots lookalikes such as "In-kind" and "inkind").', 'sponsors/'],
    ],
    where: 'On the Sponsors board: the <strong>Board settings</strong> and <strong>Tags</strong> buttons.',
  },
  {
    icon: '💵', name: 'Finances', perm: 'finances.edit', who: 'Edit Finances',
    items: [
      ['Purchasing steps', 'The department\'s steps a purchase goes through (To submit → Request sent → … → Paid): rename, recolor, hide or add.', 'finances/'],
      ['Budgets', 'Each budget category and its amount for the season.', 'finances/'],
      ['Custom sheets', 'Extra spreadsheets the Treasurer keeps alongside the ledger.', 'finances/'],
    ],
    where: 'On the Finances page: <strong>Edit steps…</strong> on Purchases, and the <strong>Budget</strong> and <strong>Custom sheets</strong> tabs.',
  },
  {
    icon: '📝', name: 'Solar Evals', perm: 'evals.write', who: 'Write evaluations (Chief Engineers)',
    items: [
      ['Rubrics', 'Each division\'s evaluation rubric and its versions.', 'evals/#/rubrics'],
      ['Questions', 'The self-eval questions each Chief Engineer asks their members.', 'evals/#/questions'],
    ],
    where: 'In Solar Evals: the <strong>Rubrics</strong> and <strong>Questions</strong> tabs.',
  },
  {
    icon: '🗺️', name: 'CE Scope Map', who: 'Anyone with the file',
    items: [['The map', 'Edited on the page (✎ Edit), then saved as a file to commit to GitHub.', 'scope-map/']],
    where: 'On the page: <strong>✎ Edit</strong>, then <strong>Save file</strong>.',
  },
  {
    icon: '☀️', name: 'I–V Analyzer', who: 'Each person, in their own browser',
    items: [['Screening settings', 'Correction coefficients, uncertainty and the Ne3 limits. Saved in each browser; share them as a file.', 'iv-analyzer/']],
    where: 'In the I–V Analyzer: the <strong>Guide &amp; settings</strong> tab, then <strong>Export settings</strong> / <strong>Import settings</strong>.',
  },
  {
    icon: '🔌', name: 'GatorWire', who: 'Anyone with a GitHub token for the shared file',
    items: [['Shared project', 'Which wiring file the team works on, shared through GitHub.', 'gatorwire/']],
    where: 'In GatorWire: the <strong>Share</strong> button at the top right.',
  },
];

export function renderOtherApps(el) {
  el.innerHTML = `
    ${adminHeader('apps', 'Settings that belong to one app are kept in that app, next to what they change. Here is where to find them.')}
    <div class="app-settings-grid">${OTHER_APPS.map((a) => `
      <section class="card app-settings">
        <div class="card-head"><h2><span aria-hidden="true">${a.icon}</span> ${esc(a.name)}</h2>
          <a class="btn btn-sm" href="${esc(appUrl(a.items[0][2]))}">Open ${esc(a.name)}</a></div>
        <dl class="app-settings-list">${a.items.map(([label, what, href]) => `
          <div><dt><a href="${esc(appUrl(href))}">${esc(label)}</a></dt><dd>${esc(what)}</dd></div>`).join('')}</dl>
        <p class="muted small">${a.where} Who can change them: ${esc(a.who)}${a.perm && auth.can(a.perm) ? ' (you can)' : ''}.</p>
      </section>`).join('')}
    </div>
    <p class="muted small">Who can use each app is set in <a href="#/admin/roles">Roles &amp; permissions</a>; which cards people see on the home screen is in <a href="#/admin/home">Home screen</a>.</p>`;
}
