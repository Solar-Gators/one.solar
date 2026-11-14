/**
 * Inventory → Reports: what was used, by CE division and subsystem (each use counted once: in its subsystem,
 * as whole-division use, or as General shop), by item, person, project and month, for a date range. Costs are
 * estimates (the item's unit cost when it was used); uses with no known cost are flagged.
 */
import { esc, fmtMoney } from '../../ui.js';
import { inv } from '../../inventory/api.js';
import { fmtNum } from '../../inventory/core.js';
import { rollup, byItem, groupTotals, byMonth } from '../../inventory/reports.js';
import { header, needsDatabase, itemHref } from './kit.js';
import { downloadWorkbook, usageSheets, fileDate } from './exporting.js';

const iso = (d) => d.toISOString().slice(0, 10);
const PRESETS = () => {
  const now = new Date();
  const y = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1; // the season runs from August
  return [
    ['Last 30 days', iso(new Date(now - 30 * 864e5)), iso(now)],
    ['This season', `${y}-08-01`, iso(now)],
    ['Last season', `${y - 1}-08-01`, `${y}-07-31`],
    ['All time', '', ''],
  ];
};

export async function renderInvReports(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  const query = ctx.params.query || new URLSearchParams();
  const presets = PRESETS();
  const from = query.has('from') ? query.get('from') : presets[1][1];
  const to = query.has('to') ? query.get('to') : presets[1][2];
  const rows = await inv.usage(from || null, to || null);
  const tree = rollup(rows);
  const total = rows.reduce((s, r) => s + (Number(r.cost) || 0), 0);
  const unknown = rows.filter((r) => !r.cost_known).length;
  const items = byItem(rows);
  const people = groupTotals(rows, (r) => r.used_by || 'Not recorded');
  const projects = groupTotals(rows.filter((r) => r.project), (r) => r.project);
  const months = byMonth(rows);
  const maxMonth = Math.max(1, ...months.map((m) => m.cost));

  const table = (head, body) => `<div class="table-wrap"><table class="table" data-fit><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  el.innerHTML = `${header('Reports', 'What the shop used, and who for. Costs are estimates from each item\'s unit cost.',
    '<button type="button" class="btn" data-download>Download Excel</button>')}
    <form class="toolbar inv-filters" data-range>
      ${presets.map(([l, f, t]) => `<a class="chip ${f === from && t === to ? 'is-active' : ''}" href="#/inventory/reports?from=${f}&to=${t}">${esc(l)}</a>`).join('')}
      <label class="inline-field">From <input type="date" name="from" value="${esc(from)}"></label>
      <label class="inline-field">To <input type="date" name="to" value="${esc(to)}"></label>
      <button class="btn" type="submit">Show</button>
    </form>
    <div class="fin-tiles">
      <div class="fin-tile"><span class="fin-tile-label">Used</span><strong>${fmtMoney(total)}</strong><span class="muted small">${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}${unknown ? `, ${unknown} without a cost` : ''}</span></div>
      <div class="fin-tile"><span class="fin-tile-label">Items</span><strong>${items.length}</strong></div>
      <div class="fin-tile"><span class="fin-tile-label">Divisions</span><strong>${tree.filter((d) => d.id !== 'general').length}</strong></div>
    </div>
    ${rows.length ? `
    <section class="card"><div class="card-head"><h2>By CE division and subsystem</h2></div>
      ${tree.map((d) => `<details class="inv-roll" ${tree.length <= 3 ? 'open' : ''}><summary><strong>${esc(d.name)}</strong> <span class="inv-roll-cost">${fmtMoney(d.cost)}</span>
          <span class="muted small">${d.lines} entr${d.lines === 1 ? 'y' : 'ies'}${d.costUnknown ? ' · some without a cost' : ''}</span></summary>
        ${table('<th>Subsystem</th><th>Item</th><th class="num">Used</th><th class="num">Cost</th>',
          [...d.subsystems.flatMap((s) => s.items.map((it, n) => [n === 0 ? `<strong>${esc(s.name)}</strong> <span class="muted small">${fmtMoney(s.cost)}</span>` : '', it])),
            ...d.whole.items.map((it, n) => [n === 0 ? `<em>${d.id === 'general' ? 'General shop' : 'Whole division'}</em> <span class="muted small">${fmtMoney(d.whole.cost)}</span>` : '', it])]
            .map(([s, it]) => `<tr><td data-label="Subsystem">${s}</td><td data-label="Item">${it.item_id ? `<a href="${itemHref(it.item_id)}">${esc(it.name)}</a>` : esc(it.name)}</td>
              <td class="num" data-label="Used">${esc(fmtNum(it.qty))} ${esc(it.unit)}</td><td class="num" data-label="Cost">${fmtMoney(it.cost)}</td></tr>`).join(''))}
      </details>`).join('')}</section>
    <div class="two-col">
      <section class="card"><div class="card-head"><h2>Most used</h2></div>
        ${table('<th>Item</th><th class="num">Used</th><th class="num">Cost</th>', items.slice(0, 15).map((it) => `<tr><td data-label="Item">${it.item_id ? `<a href="${itemHref(it.item_id)}">${esc(it.name)}</a>` : esc(it.name)}</td><td class="num" data-label="Used">${esc(fmtNum(it.qty))} ${esc(it.unit)}</td><td class="num" data-label="Cost">${fmtMoney(it.cost)}</td></tr>`).join(''))}</section>
      <section class="card"><div class="card-head"><h2>By month</h2></div>
        <ul class="plain-list inv-bars">${months.map((m) => `<li><span class="inv-bar-label">${esc(m.month)}</span><span class="inv-bar" style="--w:${(m.cost / maxMonth) * 100}%"></span><span class="num">${fmtMoney(m.cost)}</span></li>`).join('')}</ul></section>
    </div>
    <div class="two-col">
      <section class="card"><div class="card-head"><h2>By person</h2></div>
        ${table('<th>Who</th><th class="num">Entries</th><th class="num">Cost</th>', people.map((p) => `<tr><td data-label="Who">${esc(p.key)}</td><td class="num" data-label="Entries">${p.lines}</td><td class="num" data-label="Cost">${fmtMoney(p.cost)}</td></tr>`).join(''))}</section>
      <section class="card"><div class="card-head"><h2>By project</h2></div>
        ${projects.length ? table('<th>Project</th><th class="num">Entries</th><th class="num">Cost</th>', projects.map((p) => `<tr><td data-label="Project">${esc(p.key)}</td><td class="num" data-label="Entries">${p.lines}</td><td class="num" data-label="Cost">${fmtMoney(p.cost)}</td></tr>`).join('')) : '<p class="empty">No projects were named.</p>'}</section>
    </div>` : '<p class="empty">Nothing was used in this period.</p>'}`;

  el.querySelector('[data-range]').addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = `#/inventory/reports?from=${e.target.from.value}&to=${e.target.to.value}`;
  });
  el.querySelector('[data-download]').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await downloadWorkbook(`inventory-usage-${fileDate()}.xlsx`, usageSheets(rows));
    } finally {
      e.target.disabled = false;
    }
  });
}
