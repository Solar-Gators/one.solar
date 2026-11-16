/**
 * Cycle counts. Start one for a location (and what's inside it), a category, a count class or just what's due;
 * walk the shelves typing what's there (a phone works); add anything found that wasn't on the list; submit; then
 * apply it, which corrects stock by (counted − what the system had when that line was counted), so parts taken
 * out during the count aren't lost. Big differences, or class A items, need an inventory manager to apply.
 */
import { esc, fmtDateTime, takeFlash, setFlash } from '../../ui.js';
import { inv } from '../../inventory/api.js';
import { fmtNum } from '../../inventory/core.js';
import { loadBase, invalidate, header, needsDatabase, can, qty, itemHref, locHref, locCode, locationOptions, formDialog, lotLabel } from './kit.js';
import { downloadWorkbook, countSheet, fileDate } from './exporting.js';
import { matches } from './items.js';

const STATUS = { open: ['Counting', 'blue'], review: ['Submitted', 'amber'], closed: ['Applied', 'green'], cancelled: ['Cancelled', 'gray'] };
const statusChip = (s) => `<span class="chip chip-tone tone-${STATUS[s]?.[1] || 'gray'}">${esc(STATUS[s]?.[0] || s)}</span>`;

export async function renderInvCounts(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  const [b, counts] = await Promise.all([loadBase(), inv.counts()]);
  const due = b.items.filter((i) => i.count_due && Number(i.on_hand) > 0 && i.status !== 'archived');

  el.innerHTML = `${takeFlash()}${header('Counts', 'Count one shelf at a time; stock is corrected to match what you find.',
    can.count() ? '<button type="button" class="btn btn-primary" data-start>Start a count</button>' : '')}
    ${due.length ? `<section class="card"><div class="card-head"><h2>Due for a count (${due.length})</h2>${can.count() ? '<button type="button" class="btn btn-sm" data-start-due>Count these</button>' : ''}</div>
      <p class="muted small">By count class: A every ${esc(b.settings.countDays?.A ?? 30)} days, B every ${esc(b.settings.countDays?.B ?? 90)}, C every ${esc(b.settings.countDays?.C ?? 180)}.</p>
      <ul class="plain-list inv-due">${due.slice(0, 30).map((i) => `<li><a href="${itemHref(i.id)}">${esc(i.name)}</a> <span class="muted small">class ${esc(i.count_class)} · last counted ${esc(i.last_counted ? String(i.last_counted).slice(0, 10) : 'never')}</span></li>`).join('')}
      ${due.length > 30 ? `<li class="muted">and ${due.length - 30} more</li>` : ''}</ul></section>` : ''}
    <section class="card"><div class="card-head"><h2>Counts</h2></div>
      ${counts.length ? `<div class="table-wrap"><table class="table" data-fit><thead><tr><th>Count</th><th>Status</th><th>Started</th><th>By</th></tr></thead><tbody>
        ${counts.map((c) => `<tr data-href="#/inventory/counts/${esc(c.id)}"><td data-label="Count"><a href="#/inventory/counts/${esc(c.id)}">${esc(c.name)}</a>${c.needs_approval && c.status === 'review' ? ' <span class="chip chip-tone tone-red">needs approval</span>' : ''}</td>
          <td data-label="Status">${statusChip(c.status)}</td><td data-label="Started">${esc(fmtDateTime(c.started_at))}</td><td data-label="By">${esc(c.started_by_name)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="empty">No counts yet.</p>'}</section>`;

  el.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-href]');
    if (row && !e.target.closest('a, button')) location.hash = row.dataset.href;
  });
  const start = async (preset = {}) => {
    const id = await formDialog({
      title: 'Start a count',
      body: `<div class="field"><label for="c-name">Name</label><input id="c-name" name="name" maxlength="120" placeholder="e.g. Cabinet A, ${new Date().toLocaleDateString()}"></div>
        <div class="field"><label for="c-loc">Location <span class="muted">(and what's inside it)</span></label><select id="c-loc" name="location">${locationOptions(b, '', { blank: 'Everywhere' })}</select></div>
        <div class="field"><label for="c-cat">Category</label><select id="c-cat" name="category"><option value="">All</option>${b.categories.filter((c) => !c.archived_at).map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="c-class">Count class</label><select id="c-class" name="cls"><option value="">All</option><option>A</option><option>B</option><option>C</option></select></div>
        <label class="inline-check"><input type="checkbox" name="due" ${preset.due ? 'checked' : ''}> Only what's due</label>
        ${b.settings.blindCounts ? '<p class="hint">Blind counts are on: counters won\'t see what the system expects.</p>' : ''}`,
      submit: 'Start',
      onSubmit: (f) => inv.startCount({ name: f.name.value.trim(), location_ids: f.location.value ? [f.location.value] : [], category_id: f.category.value, count_class: f.cls.value, due_only: f.due.checked }),
    });
    if (id) location.hash = `#/inventory/counts/${id}`;
  };
  el.querySelector('[data-start]')?.addEventListener('click', () => start());
  el.querySelector('[data-start-due]')?.addEventListener('click', () => start({ due: true }));
}

export async function renderInvCount(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  const id = ctx.params.id;
  const [b, count, lines] = await Promise.all([loadBase(), inv.count(id), inv.countLines(id)]);
  if (!count) {
    el.innerHTML = '<section class="card no-access"><h1>Count not found</h1><a class="btn" href="#/inventory/counts">All counts</a></section>';
    return;
  }
  const lotIds = new Set(lines.map((l) => l.lot_id).filter(Boolean));
  const lotById = new Map(lotIds.size ? (await inv.allLots()).filter((l) => lotIds.has(l.id)).map((l) => [l.id, l]) : []);
  const open = count.status === 'open';
  const review = count.status === 'review';
  const blind = count.blind && open && !can.manage();
  const counted = lines.filter((l) => l.counted !== null);
  const diffs = counted.filter((l) => Number(l.counted) !== Number(l.system_qty));
  const value = diffs.reduce((s, l) => s + (Number(l.counted) - Number(l.system_qty)) * (Number(b.itemById.get(l.item_id)?.unit_cost) || 0), 0);
  const byLoc = new Map();
  for (const l of lines) {
    const k = l.location_id;
    if (!byLoc.has(k)) byLoc.set(k, []);
    byLoc.get(k).push(l);
  }
  const locs = [...byLoc.keys()].sort((a, c) => locCode(b, a).localeCompare(locCode(b, c)));

  el.innerHTML = `${takeFlash()}<div data-msg></div>${header(esc(count.name), `${statusChip(count.status)} · started by ${esc(count.started_by_name)} ${esc(fmtDateTime(count.started_at))} · ${counted.length} of ${lines.length} counted`,
    `<button type="button" class="btn" data-download>Download Excel</button>
     ${open && can.count() ? '<button type="button" class="btn" data-add>Add something found</button><button type="button" class="btn btn-primary" data-submit>Submit</button>' : ''}
     ${review && (can.manage() || (can.count() && !count.needs_approval)) ? '<button type="button" class="btn btn-primary" data-apply>Apply the corrections</button>' : ''}
     ${(open || review) && can.count() ? '<button type="button" class="btn btn-ghost" data-cancel>Cancel the count</button>' : ''}`)}
    ${review ? `<div class="alert ${count.needs_approval ? 'alert-warning' : 'alert-info'}">${diffs.length} difference${diffs.length === 1 ? '' : 's'}${value ? `, about ${esc(value < 0 ? '−' : '+')}$${esc(Math.abs(value).toFixed(2))}` : ''}.
      ${count.needs_approval ? 'Some are large or on class A items, so an inventory manager has to apply it.' : 'Applying corrects stock to what was counted.'} A line can still be recounted.</div>` : ''}
    ${blind ? '<p class="hint">Blind count: type what you find; the expected quantity is hidden.</p>' : ''}
    ${locs.map((loc) => `<section class="card inv-count-loc"><div class="card-head"><h2><a href="${locHref(loc)}">${esc(locCode(b, loc))}</a> <span class="muted">${esc(b.locById.get(loc)?.name || '')}</span></h2></div>
      <div class="table-wrap"><table class="table" data-fit><thead><tr><th>Item</th>${blind ? '' : '<th class="num">Expected</th>'}<th class="num">Counted</th>${blind ? '' : '<th class="num">Difference</th>'}<th></th></tr></thead><tbody>
      ${byLoc.get(loc).sort((x, y) => (b.itemById.get(x.item_id)?.name || '').localeCompare(b.itemById.get(y.item_id)?.name || '')).map((l) => {
        const item = b.itemById.get(l.item_id) || { name: 'Item', unit: '' };
        const lot = lotById.get(l.lot_id);
        const diff = l.counted === null ? null : Number(l.counted) - Number(l.system_qty);
        return `<tr data-line="${esc(l.id)}" class="${l.recount ? 'is-recount' : ''}">
          <td data-label="Item"><a href="${itemHref(l.item_id)}">${esc(item.name)}</a> <span class="mono small muted">${esc(item.sku)}</span>${lot ? `<div class="small">lot ${esc(lotLabel(lot))}</div>` : ''}
            ${l.added ? ' <span class="chip chip-tone tone-blue">found</span>' : ''}${l.recount ? ' <span class="chip chip-tone tone-amber">recount</span>' : ''}
            ${l.first_count !== null ? `<div class="muted small">first count ${esc(fmtNum(l.first_count))}</div>` : ''}</td>
          ${blind ? '' : `<td class="num" data-label="Expected">${esc(qty(l.system_qty ?? l.expected, item))}${l.system_qty !== null && Number(l.system_qty) !== Number(l.expected) ? `<div class="muted small">${esc(fmtNum(l.expected))} at the start</div>` : ''}</td>`}
          <td class="num" data-label="Counted">${open && can.count()
            ? `<input class="inv-count-input" type="number" min="0" step="any" inputmode="decimal" data-count="${esc(l.id)}" value="${esc(l.counted ?? '')}" aria-label="Counted ${esc(item.name)}"> <span class="muted small">${esc(item.unit)}</span>`
            : l.counted === null ? '—' : esc(qty(l.counted, item))}
            ${l.counted_by_name ? `<div class="muted small">${esc(l.counted_by_name)}</div>` : ''}</td>
          ${blind ? '' : `<td class="num" data-label="Difference" data-diff>${diff === null ? '' : diff === 0 ? '<span class="muted">0</span>' : `<strong class="${diff > 0 ? 'is-in' : 'is-out'}">${diff > 0 ? '+' : '−'}${esc(fmtNum(Math.abs(diff)))}</strong>`}</td>`}
          <td>${review && can.count() && diff ? `<button type="button" class="btn btn-sm btn-ghost" data-recount="${esc(l.id)}">Recount</button>` : ''}</td></tr>`;
      }).join('')}</tbody></table></div></section>`).join('')}`;

  const msg = (html, tone = 'error') => (el.querySelector('[data-msg]').innerHTML = html ? `<div class="alert alert-${tone}" role="alert">${html}</div>` : '');
  const reload = (m) => {
    invalidate();
    if (m) setFlash(m);
    ctx.rerender();
  };

  // Typing a count saves it when they leave the box (or press Enter, which moves to the next one).
  el.addEventListener('change', async (e) => {
    const input = e.target.closest('[data-count]');
    if (!input || input.value === '') return;
    input.disabled = true;
    try {
      const r = await inv.recordCount(input.dataset.count, Number(input.value), '');
      input.classList.add('is-saved');
      const cell = input.closest('tr').querySelector('[data-diff]');
      if (cell) cell.innerHTML = r.difference === 0 ? '<span class="muted">0</span>' : `<strong class="${r.difference > 0 ? 'is-in' : 'is-out'}">${r.difference > 0 ? '+' : '−'}${esc(fmtNum(Math.abs(r.difference)))}</strong>`;
      msg('');
    } catch (err) {
      input.classList.remove('is-saved');
      msg(esc(err.message));
    } finally {
      input.disabled = false;
    }
  });
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches('[data-count]')) return;
    e.preventDefault();
    const all = [...el.querySelectorAll('[data-count]')];
    e.target.dispatchEvent(new Event('change', { bubbles: true }));
    all[all.indexOf(e.target) + 1]?.focus();
  });

  el.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-download]')) {
      await downloadWorkbook(`count-${fileDate()}.xlsx`, [countSheet(b, count, lines, lotById)]);
    } else if (t.closest('[data-recount]')) {
      try {
        await inv.recount(t.closest('[data-recount]').dataset.recount);
        reload('That line is open for a recount.');
      } catch (err) {
        msg(esc(err.message));
      }
    } else if (t.closest('[data-submit]')) {
      const saved = new Set([...el.querySelectorAll('[data-count].is-saved')].map((i) => i.dataset.count));
      const left = lines.filter((l) => l.counted === null && !saved.has(l.id)).length;
      const ok = await formDialog({
        title: 'Submit the count?',
        body: `<p>${left > 0 ? `${left} line${left === 1 ? ' isn\'t' : 's aren\'t'} counted: they'll be left as they are.` : 'Every line is counted.'} After submitting, the differences are reviewed and applied.</p>`,
        submit: 'Submit',
        onSubmit: () => inv.submitCount(id),
      });
      if (ok) reload(ok.needs_approval ? 'Submitted. An inventory manager needs to apply it.' : 'Submitted. Check the differences, then apply.');
    } else if (t.closest('[data-apply]')) {
      const ok = await formDialog({
        title: 'Apply the corrections?',
        body: `<p>Stock is corrected to what was counted (${diffs.length} change${diffs.length === 1 ? '' : 's'}). Each is in the history and can be undone by an inventory manager.</p>`,
        submit: 'Apply',
        onSubmit: (f, op) => inv.reconcileCount(op, id),
      });
      if (ok) reload(`Applied: ${ok.adjusted} correction${ok.adjusted === 1 ? '' : 's'}.`);
    } else if (t.closest('[data-cancel]')) {
      const ok = await formDialog({ title: 'Cancel this count?', body: '<p>Nothing changes in stock. The count stays in the list as cancelled.</p>', submit: 'Cancel the count', danger: true, onSubmit: () => inv.cancelCount(id) });
      if (ok) reload('Count cancelled.');
    } else if (t.closest('[data-add]')) {
      const items = b.items.filter((i) => i.status !== 'archived');
      const added = await formDialog({
        title: 'Add something found',
        body: `<p class="hint">Stock that's here but wasn't on the list.</p>
          <div class="field"><label for="f-q">Item</label><input id="f-q" type="search" data-q placeholder="Search" autocomplete="off"><select name="item" size="6" required data-items aria-label="Item"></select></div>
          <div class="field"><label for="f-loc">Where</label><select id="f-loc" name="location" required>${locationOptions(b, locs[0] || '')}</select></div>
          <div class="field" data-lotbox hidden><label for="f-lot">Lot</label><select id="f-lot" name="lot"></select></div>
          <div class="field"><label for="f-qty">Counted</label><input id="f-qty" name="qty" type="number" min="0" step="any" required></div>`,
        submit: 'Add',
        onOpen: (f) => {
          const sel = f.querySelector('[data-items]');
          const draw = () => (sel.innerHTML = items.filter((i) => matches(i, f.querySelector('[data-q]').value)).slice(0, 80).map((i) => `<option value="${esc(i.id)}">${esc(i.name)} · ${esc(i.sku)}</option>`).join(''));
          f.querySelector('[data-q]').addEventListener('input', draw);
          sel.addEventListener('change', async () => {
            const item = b.itemById.get(sel.value);
            const box = f.querySelector('[data-lotbox]');
            box.hidden = !item?.track_lots;
            if (item?.track_lots) f.lot.innerHTML = (await inv.lots(item.id)).map((l) => `<option value="${esc(l.id)}">${esc(lotLabel(l))}</option>`).join('');
          });
          draw();
        },
        onSubmit: async (f) => {
          if (!f.item.value) throw new Error('Pick the item.');
          const line = await inv.addCountLine(id, { item_id: f.item.value, location_id: f.location.value, lot_id: f.querySelector('[data-lotbox]').hidden ? null : f.lot.value });
          await inv.recordCount(line, Number(f.qty.value), '');
          return true;
        },
      });
      if (added) reload('Added.');
    }
  });
}
