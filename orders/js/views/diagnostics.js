/**
 * Admin → one.solar → Diagnostics (046): what went wrong in people's browsers, problem reports, and
 * whether the website and the database match. Needs "Change workflow & notifications".
 */
import { api } from '../api.js';
import { esc, errorBox, fmtDateTime } from '../ui.js';
import { adminHeader, about } from './admin.js';
import { VERSION, SCHEMA_VERSION } from '../../../shared/version.js';
import { groupErrors } from '../errorGroups.js';

export async function renderDiagnostics(el, { config, rerender }) {
  await api.purgeOldDiagnostics().catch(() => 0);
  const [rows, failed, migrations] = await Promise.all([api.listClientErrors(), api.countFailedNotifications(), api.listRecentMigrations()]);
  const reports = rows.filter((r) => r.kind === 'report');
  const errors = groupErrors(rows.filter((r) => r.kind !== 'report'));
  const open = reports.filter((r) => r.status === 'new');
  const db = Number(config.schemaVersion) || 0;
  const short = (sha) => (sha && sha !== 'dev' ? sha.slice(0, 7) : sha || '—');

  el.innerHTML = `
    ${adminHeader('diagnostics', 'What went wrong in people\'s browsers, and problems people reported. Kept 90 days.')}
    <div id="diag-errors"></div>
    <section class="card">
      <h2>Website and database</h2>
      <dl class="diag-facts">
        <dt>This page's version</dt><dd><code>${esc(short(VERSION))}</code>${VERSION === 'dev' ? ' <span class="muted small">(not a deployed build)</span>' : ''}</dd>
        <dt>Database version</dt><dd>${db}${db === SCHEMA_VERSION ? ' <span class="muted small">(matches)</span>'
          : db < SCHEMA_VERSION ? ` <strong>· the website expects ${SCHEMA_VERSION}: run the missing migrations</strong>` : ` <strong>· newer than this page (${SCHEMA_VERSION}): reload</strong>`}</dd>
        <dt>Latest database updates</dt><dd>${migrations.length ? migrations.map((m) => `<code>${esc(m.name)}</code> ${m.applied_at ? `<span class="muted small">${esc(fmtDateTime(m.applied_at))}</span>` : ''}`).join('<br>') : '<span class="muted">—</span>'}</dd>
        <dt>Notifications that failed</dt><dd>${failed === null ? '<span class="muted">—</span>' : `${failed}${failed ? ' · <a href="#/admin/notifications">see the log</a>' : ''}`}</dd>
      </dl>
    </section>

    <section class="card">
      <h2>Problem reports ${open.length ? `<span class="nav-count">${open.length}</span>` : ''}</h2>
      ${about('People send these from <strong>Report a problem</strong> in their account menu. Mark one resolved once it\'s dealt with.')}
      ${reports.length ? `<div class="table-wrap flat"><table class="table stack-mobile">
        <thead><tr><th>When</th><th>Who</th><th>Where</th><th>What they said</th><th></th></tr></thead>
        <tbody>${reports.map((r) => `<tr class="${r.status === 'resolved' ? 'muted' : ''}">
          <td class="nowrap" data-label="When">${esc(fmtDateTime(r.at))}</td>
          <td data-label="Who">${esc(r.who || 'Signed out')}</td>
          <td data-label="Where"><code class="small">${esc(r.app)} ${esc(r.path)}</code></td>
          <td data-label="What they said" class="pre-wrap">${esc(r.detail || r.message)}</td>
          <td data-label=""><button type="button" class="btn btn-sm" data-status="${r.id}" data-to="${r.status === 'new' ? 'resolved' : 'new'}">${r.status === 'new' ? 'Resolved' : 'Reopen'}</button></td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="muted">No problem reports.</p>'}
    </section>

    <section class="card">
      <h2>Errors</h2>
      ${about('Errors pages hit, the same message and version grouped together. A spike right after a release usually means that release broke something: check <a href="https://github.com/Solar-Gators/one.solar/actions" target="_blank" rel="noopener">Actions</a> and roll back if needed (docs/RELEASING.md).')}
      ${errors.length ? `<div class="table-wrap flat"><table class="table stack-mobile">
        <thead><tr><th>Error</th><th class="num">Times</th><th>People</th><th>Version</th><th>First seen</th><th>Last seen</th></tr></thead>
        <tbody>${errors.map((g) => `<tr>
          <td class="cell-primary" data-label=""><details><summary>${esc(g.message || '(no message)')}</summary>
            <div class="small muted">${esc([...g.apps].join(', '))} · <code>${esc(g.sample.path)}</code></div>
            ${g.sample.detail ? `<pre class="diag-stack">${esc(g.sample.detail)}</pre>` : ''}
            <div class="small muted">${esc(g.sample.ua)}</div></details></td>
          <td class="num" data-label="Times">${g.count}</td>
          <td class="num" data-label="People">${g.people.size}</td>
          <td data-label="Version"><code>${esc(short(g.version))}</code></td>
          <td class="nowrap" data-label="First seen">${esc(fmtDateTime(g.first))}</td>
          <td class="nowrap" data-label="Last seen">${esc(fmtDateTime(g.last))}</td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="muted">No errors in the last 90 days.</p>'}
    </section>`;

  el.querySelectorAll('[data-status]').forEach((button) =>
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api.setClientErrorStatus(Number(button.dataset.status), button.dataset.to);
        await rerender();
      } catch (err) {
        el.querySelector('#diag-errors').innerHTML = errorBox(err);
        button.disabled = false;
      }
    })
  );
}
