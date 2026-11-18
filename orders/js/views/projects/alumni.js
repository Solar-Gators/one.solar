/**
 * Projects → the alumni hub (SGAA, migration 052). A project or a work item can be shared with alumni: that puts
 * it on the hub's "What we need" list, where alumni see it and can contact the team about it. People who can
 * edit it in Projects share it as a draft for the hub's editors to check; people with "Edit the alumni hub"
 * make it public right away. A shared work item that's finished shows as met on the hub (052 sgaa_item_changed).
 */
import { auth } from '../../auth.js';
import { esc } from '../../ui.js';
import { pm } from '../../projects/api.js';
import { appUrl } from '../../../../shared/onesolar.js';
import { attempt } from './kit.js';

const STATUS = { draft: 'a draft (not public yet)', open: 'public', met: 'met' };

/**
 * The "Share with alumni" card, or '' when this person can't share it (or the database doesn't have 052 yet).
 * `mayEdit`: they can edit it in Projects.
 */
export async function alumniShareCard({ projectId, itemId = null, mayEdit, what = 'this', heading = 'h3' }) {
  const editor = auth.can('sgaa.edit');
  if (!mayEdit && !editor) return '';
  let shared;
  try {
    shared = await pm.sharedWithAlumni(projectId, itemId);
  } catch {
    return '';   // before 052
  }
  const hubLink = shared && appUrl(editor ? `sgaa/#/manage/needs/${shared.id}` : `sgaa/#/need/${shared.id}`);
  const body = shared
    ? `<p>${esc(what[0].toUpperCase() + what.slice(1))} is on the alumni hub's “What we need” list, ${esc(STATUS[shared.status] || shared.status)}.</p>
       ${shared.status === 'draft' && !editor ? '<p class="muted small">Someone with “Edit the alumni hub” checks it and makes it public.</p>' : ''}
       ${editor || shared.status !== 'draft' ? `<p><a href="${esc(hubLink)}">${editor ? 'Edit it on the alumni hub' : 'See it on the alumni hub'}</a></p>` : ''}
       <p><button type="button" class="btn btn-sm" data-alumni-share="0">Stop sharing</button></p>`
    : `<p class="muted small">Alumni can't see Projects. Sharing puts ${esc(what)} on the alumni hub's “What we need” list, so alumni can offer
        parts, money or know-how and contact the team about it. ${editor ? '' : 'It starts as a draft that someone with “Edit the alumni hub” makes public.'}</p>
       <p><button type="button" class="btn btn-sm" data-alumni-share="1">Share with alumni</button></p>`;
  return `<section class="card pm-alumni" data-alumni-card><${heading}>Share with alumni</${heading}>${body}</section>`;
}

/** Wire the card's button; `done()` re-renders the page. */
export function bindAlumniShare(root, { projectId, itemId = null, done }) {
  root.querySelector('[data-alumni-card]')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-alumni-share]');
    if (!btn) return;
    const on = btn.dataset.alumniShare === '1';
    if (!on && !confirm('Stop sharing with alumni? It comes off the alumni hub (a draft is deleted; a public need is archived).')) return;
    btn.disabled = true;
    const ok = await attempt(() => pm.shareWithAlumni(projectId, itemId, on), on ? 'Shared with alumni.' : 'No longer shared with alumni.');
    btn.disabled = false;
    if (ok) done();
  });
}
