/**
 * "Recently deleted" (047): what was deleted in the last 90 days, with a Restore button. Shown at the
 * bottom of Sponsors and Finances to people who can edit there (the database decides what they see).
 *
 *   mountRecentlyDeleted(el, ['purchase', 'fund', 'finance_sheet', 'finance_row'], { onRestored })
 */
import { api } from './api.js';
import { esc, fmtDateTime, errorBox, setFlash } from './ui.js';

const KIND_LABELS = { sponsor_card: 'Sponsor', finance_sheet: 'Sheet', finance_row: 'Sheet row', purchase: 'Purchase', fund: 'Funding source' };

export async function mountRecentlyDeleted(el, kinds, { onRestored } = {}) {
  if (!el) return;
  const rows = await api.listDeletedRecords(kinds).catch(() => []);
  if (!rows.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `<details class="card recently-deleted">
    <summary>Recently deleted <span class="muted small">${rows.length}</span></summary>
    <p class="muted small">Deleted in the last 90 days. Restoring puts it back as it was, with its history and files.</p>
    <div class="rd-errors"></div>
    <div class="table-wrap flat"><table class="table stack-mobile">
      <thead><tr><th>What</th><th>Deleted</th><th>By</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td data-label="What"><span class="field-tag">${esc(KIND_LABELS[r.kind] || r.kind)}</span> ${esc(r.label)}${r.season ? ` <span class="muted small">${esc(r.season)}</span>` : ''}</td>
        <td class="nowrap" data-label="Deleted">${esc(fmtDateTime(r.deleted_at))}</td>
        <td data-label="By">${esc(r.deleted_by_name || '—')}</td>
        <td data-label=""><button type="button" class="btn btn-sm" data-restore="${r.id}">Restore</button></td>
      </tr>`).join('')}</tbody></table></div>
  </details>`;
  el.querySelectorAll('[data-restore]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const out = await api.restoreDeletedRecord(Number(btn.dataset.restore));
        setFlash(`${out?.label || 'It'} is back.`);
        await onRestored?.(out);
      } catch (err) {
        el.querySelector('.rd-errors').innerHTML = errorBox(err);
        btn.disabled = false;
      }
    })
  );
}
