/**
 * Inventory → Settings (inventory managers): locations, categories, CE divisions & subsystems (also in Admin, since
 * other apps can use them), settings (count frequency, when a count needs approval, expiry warnings, blind counts)
 * and importing an existing spreadsheet: pick the file, match its columns, see every problem before anything is
 * saved, then import all or nothing (and undo the whole import later if needed).
 */
import { esc, fmtDateTime, takeFlash, setFlash, about } from '../../ui.js';
import { loadExcelJS } from '../../excel.js';
import { cellText } from '../../sheetImport.js';
import { inv } from '../../inventory/api.js';
import { locationTree } from '../../inventory/core.js';
import { IMPORT_FIELDS, parseCsv, tableToSheet, detectMapping, checkRows, fileHash, toCsv } from '../../inventory/importer.js';
import { suggestClasses } from '../../inventory/reports.js';
import { loadBase, invalidate, header, needsDatabase, can, locHref, formDialog, newOpId } from './kit.js';
import { setLabelSelection } from './labels.js';
import { adminHeader } from '../admin.js';

const TABS = [['locations', 'Locations'], ['categories', 'Categories'], ['org', 'CE divisions & subsystems'], ['settings', 'Settings'], ['import', 'Import a spreadsheet']];
const KINDS = ['shop', 'room', 'cabinet', 'shelf', 'bin', 'other'];

export async function renderInvSetup(el, ctx) {
  const missing = needsDatabase(ctx.config);
  if (missing) return (el.innerHTML = missing);
  const tab = TABS.some(([k]) => k === ctx.params.id) ? ctx.params.id : 'locations';
  const editable = tab === 'org' ? can.org() : can.manage();
  el.innerHTML = `${takeFlash()}${header('Settings', 'How the shop is laid out and how Inventory behaves.')}
    <nav class="tabs" aria-label="Settings">${TABS.map(([k, l]) => `<a href="#/inventory/setup/${k}" ${k === tab ? 'class="active" aria-current="page"' : ''}>${esc(l)}</a>`).join('')}</nav>
    ${editable ? '' : '<p class="alert alert-info">You can look; changing these needs "Manage inventory".</p>'}
    <div data-tab></div>`;
  const box = el.querySelector('[data-tab]');
  const b = await loadBase();
  await { locations: locationsTab, categories: categoriesTab, org: (x, y, z) => renderOrgEditor(x, y, z), settings: settingsTab, import: importTab }[tab](box, ctx, b);
}

const reload = (ctx, msg) => {
  invalidate();
  if (msg) setFlash(msg);
  ctx.rerender();
};
/** Run an action from a button; errors show in an alert at the top of the tab. */
const guard = (box) => async (fn) => {
  try {
    return await fn();
  } catch (err) {
    box.querySelector('[data-err]')?.remove();
    box.insertAdjacentHTML('afterbegin', `<div class="alert alert-error" role="alert" data-err>${esc(err.message)}</div>`);
    box.scrollIntoView({ block: 'start' });
    return null;
  }
};

// ---- Locations --------------------------------------------------------------------------------------

async function locationsTab(box, ctx, b) {
  const all = locationTree(b.locations, { includeArchived: true });
  const run = guard(box);
  box.innerHTML = `<section class="card"><div class="card-head"><h2>Locations</h2>
      ${can.manage() ? '<button type="button" class="btn btn-primary btn-sm" data-add>Add a location</button>' : ''}
      <button type="button" class="btn btn-sm" data-labels>Print all labels</button></div>
    <p class="muted small">Shop → room → cabinet → shelf → bin, as deep as you like. Codes go on labels (CAB-A, CAB-A-S2), so keep them short; they can't be reused.</p>
    ${all.length ? `<ul class="plain-list inv-tree">${all.map((l) => `<li style="--depth:${l.depth}" class="${l.archived_at ? 'is-archived' : ''}">
      <a href="${locHref(l.id)}" class="mono">${esc(l.code)}</a> ${esc(l.name)} <span class="muted small">${esc(l.kind)}${l.restrictions ? ` · only: ${esc(l.restrictions)}` : ''}${l.archived_at ? ' · archived' : ''}</span>
      ${can.manage() ? `<button type="button" class="link-btn" data-edit="${esc(l.id)}">edit</button> <button type="button" class="link-btn" data-archive="${esc(l.id)}" data-on="${l.archived_at ? '' : '1'}">${l.archived_at ? 'restore' : 'archive'}</button>` : ''}</li>`).join('')}</ul>`
      : '<p class="empty">No locations yet. Add the shop first, then what\'s in it.</p>'}</section>`;

  const edit = (loc = {}) => formDialog({
    title: loc.id ? `Edit ${esc(loc.code)}` : 'Add a location',
    body: `<div class="form-grid">
      <div class="field span-2"><label for="l-code">Code</label><input id="l-code" name="code" required maxlength="24" class="mono" value="${esc(loc.code || '')}" placeholder="CAB-A" autocapitalize="characters"><div class="hint">Letters, digits, - . _</div></div>
      <div class="field span-2"><label for="l-name">Name</label><input id="l-name" name="name" required maxlength="80" value="${esc(loc.name || '')}" placeholder="Cabinet A"></div>
      <div class="field span-2"><label for="l-parent">Inside</label><select id="l-parent" name="parent"><option value="">Nothing (top level)</option>${b.tree.filter((l) => l.id !== loc.id).map((l) => `<option value="${esc(l.id)}" ${l.id === loc.parent_id ? 'selected' : ''}>${' '.repeat(l.depth)}${esc(l.code)} · ${esc(l.name)}</option>`).join('')}</select></div>
      <div class="field span-2"><label for="l-kind">Kind</label><select id="l-kind" name="kind">${KINDS.map((k) => `<option ${k === (loc.kind || 'cabinet') ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
      <div class="field span-4"><label for="l-desc">Description</label><input id="l-desc" name="description" maxlength="500" value="${esc(loc.description || '')}"></div>
      <div class="field span-4"><label for="l-res">Only for <span class="muted">(optional)</span></label><input id="l-res" name="restrictions" maxlength="300" value="${esc(loc.restrictions || '')}" placeholder="e.g. flammables only"></div>
    </div>`,
    onSubmit: (f) => inv.saveLocation(loc.id || null, { code: f.code.value.trim().toUpperCase(), name: f.name.value, parent_id: f.parent.value || null, kind: f.kind.value,
      description: f.description.value, restrictions: f.restrictions.value }),
  });
  box.addEventListener('click', async (e) => {
    if (e.target.closest('[data-add]')) (await edit()) && reload(ctx, 'Location added.');
    else if (e.target.closest('[data-edit]')) (await edit(b.locations.find((l) => l.id === e.target.closest('[data-edit]').dataset.edit))) && reload(ctx, 'Location saved.');
    else if (e.target.closest('[data-archive]')) {
      const btn = e.target.closest('[data-archive]');
      (await run(() => inv.archiveLocation(btn.dataset.archive, !!btn.dataset.on))) !== null && reload(ctx, btn.dataset.on ? 'Archived.' : 'Restored.');
    } else if (e.target.closest('[data-labels]')) {
      setLabelSelection({ locations: b.tree.map((l) => l.id) });
      location.hash = '#/inventory/labels';
    }
  });
}

// ---- Categories -------------------------------------------------------------------------------------

async function categoriesTab(box, ctx, b) {
  const run = guard(box);
  const cats = [...b.categories].sort((a, c) => a.name.localeCompare(c.name));
  const used = new Map();
  for (const i of b.items) used.set(i.category_id, (used.get(i.category_id) || 0) + 1);
  box.innerHTML = `<section class="card"><div class="card-head"><h2>Categories</h2>${can.manage() ? '<button type="button" class="btn btn-primary btn-sm" data-add>Add a category</button>' : ''}</div>
    ${cats.length ? `<ul class="plain-list">${cats.map((c) => `<li class="${c.archived_at ? 'is-archived' : ''}">${c.parent_id ? `<span class="muted">${esc(cats.find((p) => p.id === c.parent_id)?.name || '')} › </span>` : ''}<strong>${esc(c.name)}</strong>
      <span class="muted small">${used.get(c.id) || 0} item${used.get(c.id) === 1 ? '' : 's'}${c.archived_at ? ' · archived' : ''}</span>
      ${can.manage() ? `<button type="button" class="link-btn" data-edit="${esc(c.id)}">rename</button> <button type="button" class="link-btn" data-archive="${esc(c.id)}" data-on="${c.archived_at ? '' : '1'}">${c.archived_at ? 'restore' : 'archive'}</button>` : ''}</li>`).join('')}</ul>`
      : '<p class="empty">No categories yet: e.g. Fasteners, Electrical, Composites, Chemicals, Tools.</p>'}</section>`;
  const edit = (c = {}) => formDialog({
    title: c.id ? 'Rename category' : 'Add a category',
    body: `<div class="field"><label for="c-name">Name</label><input id="c-name" name="name" required maxlength="60" value="${esc(c.name || '')}"></div>
      <div class="field"><label for="c-parent">Under <span class="muted">(optional)</span></label><select id="c-parent" name="parent"><option value="">Nothing</option>${cats.filter((x) => x.id !== c.id && !x.archived_at).map((x) => `<option value="${esc(x.id)}" ${x.id === c.parent_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>`,
    onSubmit: (f) => inv.saveCategory(c.id || null, f.name.value.trim(), f.parent.value || null),
  });
  box.addEventListener('click', async (e) => {
    if (e.target.closest('[data-add]')) (await edit()) && reload(ctx, 'Category added.');
    else if (e.target.closest('[data-edit]')) (await edit(cats.find((c) => c.id === e.target.closest('[data-edit]').dataset.edit))) && reload(ctx, 'Saved.');
    else if (e.target.closest('[data-archive]')) {
      const btn = e.target.closest('[data-archive]');
      (await run(() => inv.archiveCategory(btn.dataset.archive, !!btn.dataset.on))) !== null && reload(ctx, btn.dataset.on ? 'Archived.' : 'Restored.');
    }
  });
}

// ---- CE divisions & subsystems (also Admin → CE divisions & subsystems) -------------------------------

/**
 * The CE division → subsystem list that Inventory (and later other apps) attribute use to. Renaming keeps
 * history right (history keeps the name it had then); archiving hides it from new choices. A subsystem can move
 * to another division; earlier use stays with the division it was recorded under.
 */
export async function renderOrgEditor(box, ctx, b = null) {
  // Admin's copy loads just the lists (an Admin may have no Inventory permission).
  if (!b) {
    const [divisions, subsystems] = await Promise.all([inv.divisions(), inv.subsystems()]);
    b = { divisions, subsystems };
  }
  const run = guard(box);
  const edit = can.org();
  const divisions = b.divisions;
  const subsOf = (id) => b.subsystems.filter((s) => s.division_id === id);
  box.innerHTML = `<section class="card"><div class="card-head"><h2>CE divisions & subsystems</h2>
      ${edit ? `<button type="button" class="btn btn-primary btn-sm" data-add-div>Add a division</button>${divisions.length ? '' : '<button type="button" class="btn btn-sm" data-copy>Copy from Solar Evals</button>'}` : ''}</div>
    <p class="muted small">What parts are used for: each Chief Engineer's division and its subsystems.</p>
    ${about('<p>Inventory asks for one when parts are taken out. Renaming keeps the history right; archiving hides it from new choices but keeps its history.</p>', 'How this works', 'inventory-divisions')}
    ${divisions.length ? divisions.map((d, i) => `<div class="inv-org ${d.archived_at ? 'is-archived' : ''}">
      <div class="inv-org-head"><strong>${esc(d.name)}</strong>${d.archived_at ? ' <span class="chip chip-tone tone-gray">archived</span>' : ''}
        ${edit ? `<span class="inv-org-tools"><button type="button" class="link-btn" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button type="button" class="link-btn" data-rename-div="${esc(d.id)}">rename</button>
          <button type="button" class="link-btn" data-archive-div="${esc(d.id)}" data-on="${d.archived_at ? '' : '1'}">${d.archived_at ? 'restore' : 'archive'}</button>
          <button type="button" class="link-btn" data-add-sub="${esc(d.id)}">add subsystems</button></span>` : ''}</div>
      <ul class="plain-list inv-org-subs">${subsOf(d.id).map((s) => `<li class="${s.archived_at ? 'is-archived' : ''}">${esc(s.name)}${s.archived_at ? ' <span class="muted small">archived</span>' : ''}
        ${edit ? `<button type="button" class="link-btn small" data-edit-sub="${esc(s.id)}">edit</button> <button type="button" class="link-btn small" data-archive-sub="${esc(s.id)}" data-on="${s.archived_at ? '' : '1'}">${s.archived_at ? 'restore' : 'archive'}</button>` : ''}</li>`).join('') || '<li class="muted small">No subsystems yet.</li>'}</ul>
    </div>`).join('') : '<p class="empty">No divisions yet. Add them, or copy the CE tracks from Solar Evals.</p>'}</section>`;
  if (!edit) return;

  const done = (m) => {
    invalidate();
    setFlash(m);
    ctx.rerender();
  };
  box.addEventListener('click', async (e) => {
    const t = e.target;
    const nameDialog = (title, value = '') => formDialog({ title, body: `<div class="field"><label for="o-name">Name</label><input id="o-name" name="name" required maxlength="80" value="${esc(value)}"></div>`, onSubmit: (f) => f.name.value.trim() });
    if (t.closest('[data-add-div]')) {
      const name = await nameDialog('Add a CE division');
      if (name && (await run(() => inv.saveDivision(null, name))) !== null) done('Division added.');
    } else if (t.closest('[data-copy]')) {
      const n = await run(() => inv.copyDivisionsFromEvals());
      if (n !== null) done(`Copied ${n} division${n === 1 ? '' : 's'} from Solar Evals.`);
    } else if (t.closest('[data-rename-div]')) {
      const d = divisions.find((x) => x.id === t.closest('[data-rename-div]').dataset.renameDiv);
      const name = await nameDialog('Rename division', d.name);
      if (name && (await run(() => inv.saveDivision(d.id, name, d.sort))) !== null) done('Renamed.');
    } else if (t.closest('[data-archive-div]')) {
      const btn = t.closest('[data-archive-div]');
      if ((await run(() => inv.archiveDivision(btn.dataset.archiveDiv, !!btn.dataset.on))) !== null) done(btn.dataset.on ? 'Archived.' : 'Restored.');
    } else if (t.closest('[data-up]')) {
      const i = Number(t.closest('[data-up]').dataset.up);
      const ids = divisions.map((d) => d.id);
      [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
      if ((await run(() => inv.reorderOrg('division', ids))) !== null) done('Moved.');
    } else if (t.closest('[data-add-sub]')) {
      const id = t.closest('[data-add-sub]').dataset.addSub;
      const names = await formDialog({
        title: `Subsystems of ${esc(divisions.find((d) => d.id === id).name)}`,
        body: '<div class="field"><label for="o-names">One per line</label><textarea id="o-names" name="names" rows="6" required placeholder="Battery&#10;Motor controller&#10;Wiring harness"></textarea></div>',
        onSubmit: (f) => f.names.value.split('\n').map((s) => s.trim()).filter(Boolean),
      });
      if (names?.length && (await run(() => inv.addSubsystems(id, names))) !== null) done('Subsystems added.');
    } else if (t.closest('[data-edit-sub]')) {
      const s = b.subsystems.find((x) => x.id === t.closest('[data-edit-sub]').dataset.editSub);
      const saved = await formDialog({
        title: 'Edit subsystem',
        body: `<div class="field"><label for="o-sname">Name</label><input id="o-sname" name="name" required maxlength="80" value="${esc(s.name)}"></div>
          <div class="field"><label for="o-div">Division</label><select id="o-div" name="division">${divisions.filter((d) => !d.archived_at || d.id === s.division_id).map((d) => `<option value="${esc(d.id)}" ${d.id === s.division_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
            <div class="hint">Moving it keeps earlier use with the division it was recorded under.</div></div>`,
        onSubmit: (f) => inv.saveSubsystem(s.id, f.division.value, f.name.value.trim(), s.sort),
      });
      if (saved) done('Saved.');
    } else if (t.closest('[data-archive-sub]')) {
      const btn = t.closest('[data-archive-sub]');
      if ((await run(() => inv.archiveSubsystem(btn.dataset.archiveSub, !!btn.dataset.on))) !== null) done(btn.dataset.on ? 'Archived.' : 'Restored.');
    }
  });
}

/** Admin → CE divisions & subsystems: the same editor, for Admins without Inventory. */
export async function renderAdminOrg(el, ctx) {
  if (Number(ctx.config.schemaVersion) < 50) {
    el.innerHTML = `${adminHeader('org')}<p class="alert alert-warning">This needs the database update 050_inventory.sql.</p>`;
    return;
  }
  el.innerHTML = `${adminHeader('org', 'What parts and work are for: the CE divisions and their subsystems. Inventory uses them now; other apps can later.')}<div data-org></div>`;
  await renderOrgEditor(el.querySelector('[data-org]'), ctx);
}

// ---- Settings ----------------------------------------------------------------------------------------

async function settingsTab(box, ctx, b) {
  const s = { countDays: { A: 30, B: 90, C: 180 }, approvalValue: 50, approvalPct: 10, expiryWarnDays: 30, blindCounts: false, ...b.settings };
  const dis = can.manage() ? '' : 'disabled';
  const suggestion = suggestClasses(b.items.filter((i) => i.status !== 'archived'));
  const changes = Object.entries(suggestion).filter(([id, c]) => b.itemById.get(id)?.count_class !== c);
  box.innerHTML = `<form class="card" data-settings><h2>Counts</h2>
      <div class="form-grid">${['A', 'B', 'C'].map((k) => `<div class="field"><label for="s-${k}">Count class ${k} every</label><div class="inv-amount-row"><input id="s-${k}" name="d${k}" type="number" min="1" max="730" required value="${esc(s.countDays[k])}" ${dis}><span>days</span></div></div>`).join('')}</div>
      <p class="hint">A: the valuable or critical things; C: cheap bulk. "Suggest classes" below sorts them by value.</p>
      <div class="form-grid">
        <div class="field span-2"><label for="s-val">A count needs a manager's approval when a difference is worth more than</label><div class="inv-amount-row"><span>$</span><input id="s-val" name="approvalValue" type="number" min="0" step="any" required value="${esc(s.approvalValue)}" ${dis}></div></div>
        <div class="field span-2"><label for="s-pct">or is more than</label><div class="inv-amount-row"><input id="s-pct" name="approvalPct" type="number" min="0" max="100" step="any" required value="${esc(s.approvalPct)}" ${dis}><span>% of what was expected</span></div><div class="hint">Differences on class A items always need approval.</div></div>
      </div>
      <label class="inline-check"><input type="checkbox" name="blind" ${s.blindCounts ? 'checked' : ''} ${dis}> Blind counts (counters don't see the expected quantity)</label>
      <h2>Lots</h2>
      <div class="field"><label for="s-exp">Warn about lots expiring within</label><div class="inv-amount-row"><input id="s-exp" name="expiry" type="number" min="0" max="999" required value="${esc(s.expiryWarnDays)}" ${dis}><span>days</span></div></div>
      ${can.manage() ? '<div class="form-actions"><button class="btn btn-primary" type="submit">Save settings</button></div>' : ''}
    </form>
    <section class="card"><div class="card-head"><h2>Suggest count classes</h2>${can.manage() && changes.length ? `<button type="button" class="btn btn-sm" data-classes>Apply ${changes.length} change${changes.length === 1 ? '' : 's'}</button>` : ''}</div>
      <p class="muted small">By value on hand (quantity × unit cost): the items making up the first 80% of the value are A, the next 15% B, the rest C. Items without a cost are C.</p>
      ${changes.length ? `<ul class="plain-list small">${changes.slice(0, 40).map(([id, c]) => `<li>${esc(b.itemById.get(id).name)}: ${esc(b.itemById.get(id).count_class)} → <strong>${c}</strong></li>`).join('')}${changes.length > 40 ? `<li class="muted">and ${changes.length - 40} more</li>` : ''}</ul>` : '<p class="empty">Every item already has its suggested class.</p>'}</section>`;
  const run = guard(box);
  box.querySelector('[data-settings]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const p = { countDays: { A: Number(f.dA.value), B: Number(f.dB.value), C: Number(f.dC.value) }, approvalValue: Number(f.approvalValue.value), approvalPct: Number(f.approvalPct.value),
      expiryWarnDays: Number(f.expiry.value), blindCounts: f.blind.checked };
    if ((await run(() => inv.saveSettings(p))) !== null) reload(ctx, 'Settings saved.');
  });
  box.querySelector('[data-classes]')?.addEventListener('click', async () => {
    const n = await run(() => inv.setCountClasses(Object.fromEntries(changes)));
    if (n !== null) reload(ctx, `${n} item${n === 1 ? '' : 's'} updated.`);
  });
}

// ---- Import ------------------------------------------------------------------------------------------

async function readFile(file) {
  if (/\.csv$|\.txt$/i.test(file.name)) return parseCsv(await file.text());
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets.filter((w) => w.state !== 'hidden' && w.state !== 'veryHidden').sort((a, c) => c.rowCount - a.rowCount)[0];
  if (!ws) return { columns: [], rows: [] };
  const grid = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells = [];
    for (let c = 1; c <= ws.columnCount; c++) cells.push(cellText(row.getCell(c).value));
    grid.push(cells);
  }
  return tableToSheet(grid);
}

async function importTab(box, ctx, b) {
  if (!can.manage()) {
    box.innerHTML = '<p class="empty">Importing needs "Manage inventory".</p>';
    return;
  }
  const [batches, parts] = await Promise.all([inv.importBatches(), inv.supplierParts()]);
  const state = { file: null, sheet: null, hash: '', mapping: {}, checked: null };
  const template = toCsv([IMPORT_FIELDS.map((f) => f.label), ['M3-8-SHCS', 'M3×8 socket head cap screw', '', 'Fasteners', '200', 'ea', 'CAB-A', '', '', 'McMaster-Carr', '91292A112', '', '0.09', '50', '200', '', '', 'C']]);

  box.innerHTML = `<section class="card"><h2>Import a spreadsheet</h2>
      <ol class="inv-steps"><li>Pick the file (Excel or CSV). The sheet with the most rows is read; the first row with titles is the header.</li>
        <li>Check which column is which.</li><li>Fix anything flagged; nothing is saved until every row is fine.</li>
        <li>Import. It all goes in, or none of it. Rows with a SKU already in the catalog add stock to that item.</li></ol>
      <p><a class="btn btn-sm btn-ghost" download="inventory-template.csv" href="data:text/csv;charset=utf-8,${encodeURIComponent(template)}">Download a template</a></p>
      <div class="field"><label for="im-file">File</label><input id="im-file" type="file" accept=".xlsx,.csv,.txt" data-file></div>
      <div data-map></div><div data-check></div></section>
    <section class="card"><h2>Earlier imports</h2>${batches.length ? `<ul class="plain-list">${batches.map((x) => `<li><strong>${esc(x.file_name || 'Import')}</strong>
      <span class="muted small">${esc(fmtDateTime(x.created_at))} · ${esc(x.created_by_name)} · ${x.row_count} rows: ${x.items_created} new items, ${x.items_matched} matched, ${x.stock_lines} with stock</span>
      <button type="button" class="link-btn" data-undo-import="${esc(x.op_id)}">undo</button></li>`).join('')}</ul>` : '<p class="empty">None yet.</p>'}</section>`;

  const mapBox = box.querySelector('[data-map]');
  const checkBox = box.querySelector('[data-check]');
  const run = guard(box);

  const drawMap = () => {
    const cols = state.sheet.columns;
    mapBox.innerHTML = `<p class="muted small">${state.sheet.rows.length} row${state.sheet.rows.length === 1 ? '' : 's'} in <strong>${esc(state.file.name)}</strong>.</p>
      <div class="form-grid inv-mapping">${IMPORT_FIELDS.map((f) => `<div class="field span-2"><label for="m-${f.key}">${esc(f.label)}${f.required ? ' *' : ''}</label>
        <select id="m-${f.key}" data-field="${f.key}"><option value="">Not in the file</option>${cols.map((c) => `<option ${state.mapping[f.key] === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>`).join('')}</div>
      <label class="inline-check"><input type="checkbox" data-mklocs> Add locations the file mentions that don't exist yet</label>
      <label class="inline-check"><input type="checkbox" data-mkcats> Add categories the file mentions that don't exist yet</label>
      <div class="form-actions"><button type="button" class="btn btn-primary" data-run-check>Check the rows</button></div>`;
  };
  const drawCheck = () => {
    const rows = state.checked;
    const bad = rows.filter((r) => r.errors.length);
    const warn = rows.filter((r) => !r.errors.length && r.warnings.length);
    const fresh = rows.filter((r) => r.match.kind === 'new').length;
    checkBox.innerHTML = `<div class="alert ${bad.length ? 'alert-error' : 'alert-success'}">${rows.length} rows: ${fresh} new item${fresh === 1 ? '' : 's'}, ${rows.length - fresh} matched by SKU.
        ${bad.length ? `<strong>${bad.length} row${bad.length === 1 ? ' has' : 's have'} problems</strong>: fix the file and pick it again.` : 'Everything checks out.'}${warn.length ? ` ${warn.length} with warnings.` : ''}</div>
      <div class="table-wrap"><table class="table" data-fit><thead><tr><th>Row</th><th>Item</th><th class="num">Qty</th><th>Location</th><th>Notes</th></tr></thead><tbody>
      ${[...bad, ...warn, ...rows.filter((r) => !r.errors.length && !r.warnings.length)].slice(0, 300).map((r) => `<tr class="${r.errors.length ? 'is-bad' : ''}"><td data-label="Row">${r.row}</td>
        <td data-label="Item">${esc(r.match.item?.name || r.out.name)} ${r.match.kind === 'sku' ? '<span class="chip chip-tone tone-blue">existing</span>' : '<span class="chip chip-tone tone-green">new</span>'}</td>
        <td class="num" data-label="Qty">${esc(r.out.qty)}</td><td data-label="Location" class="mono">${esc(r.out.location)}</td>
        <td data-label="Notes">${r.errors.map((x) => `<div class="text-danger">${esc(x)}</div>`).join('')}${r.warnings.map((x) => `<div class="muted small">${esc(x)}</div>`).join('')}</td></tr>`).join('')}
      </tbody></table></div>${rows.length > 300 ? '<p class="muted small">Showing the first 300 (problems first).</p>' : ''}
      ${bad.length ? '' : `<div class="form-actions"><button type="button" class="btn btn-primary" data-import>Import ${rows.length} rows</button></div>`}`;
  };

  box.querySelector('[data-file]').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    checkBox.innerHTML = '';
    if (!file) return;
    const sheet = await run(() => readFile(file));
    if (!sheet) return;
    if (!sheet.rows.length) return (mapBox.innerHTML = '<p class="alert alert-warning">No rows found under a header row.</p>');
    Object.assign(state, { file, sheet, hash: await fileHash(await file.arrayBuffer()), mapping: detectMapping(sheet.columns), checked: null });
    drawMap();
  });
  box.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-field]');
    if (!sel) return;
    state.mapping[sel.dataset.field] = sel.value;
    state.checked = null;
    checkBox.innerHTML = '';
  });
  box.addEventListener('click', async (e) => {
    if (e.target.closest('[data-run-check]')) {
      if (!state.mapping.name && !state.mapping.sku) return run(() => Promise.reject(new Error('Pick the column with the item names (or SKUs).')));
      state.checked = checkRows(state.sheet, state.mapping, { items: b.items, supplierParts: parts, locations: b.locations, units: b.units, categories: b.categories,
        createLocations: box.querySelector('[data-mklocs]').checked, createCategories: box.querySelector('[data-mkcats]').checked });
      drawCheck();
    } else if (e.target.closest('[data-import]')) {
      const btn = e.target.closest('[data-import]');
      btn.disabled = true;
      const op = newOpId();
      const send = (allowRepeat) => inv.importRows(op, { rows: state.checked.map((r) => r.out), file_name: state.file.name, file_hash: state.hash,
        create_locations: box.querySelector('[data-mklocs]').checked, create_categories: box.querySelector('[data-mkcats]').checked, allow_repeat: allowRepeat });
      try {
        const res = await send(false);
        reload(ctx, `Imported: ${res.items_created} new item${res.items_created === 1 ? '' : 's'}, ${res.items_matched} matched, ${res.stock_lines} stock line${res.stock_lines === 1 ? '' : 's'}.`);
      } catch (err) {
        btn.disabled = false;
        if (err.repeat) {
          const again = await formDialog({ title: 'Import this file again?', body: `<p>${esc(err.message)}</p><p>Importing again adds its stock a second time.</p>`, submit: 'Import again', danger: true, onSubmit: (f, op2) => inv.importRows(op2, { rows: state.checked.map((r) => r.out), file_name: state.file.name, file_hash: state.hash,
            create_locations: box.querySelector('[data-mklocs]').checked, create_categories: box.querySelector('[data-mkcats]').checked, allow_repeat: true }) });
          if (again) reload(ctx, 'Imported.');
          return;
        }
        checkBox.insertAdjacentHTML('afterbegin', `<div class="alert alert-error" role="alert">${esc(err.message)}${err.details?.length ? `<ul>${err.details.slice(0, 30).map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}</div>`);
      }
    } else if (e.target.closest('[data-undo-import]')) {
      const id = e.target.closest('[data-undo-import]').dataset.undoImport;
      const done = await formDialog({
        title: 'Undo this import?',
        body: '<p>Takes its stock back out (it stays in the history, with the undo). Items it added stay in the catalog; archive them if they\'re not wanted.</p><div class="field"><label for="ui-r">Why?</label><input id="ui-r" name="reason" required minlength="3" maxlength="300"></div>',
        submit: 'Undo the import',
        danger: true,
        onSubmit: (f, op) => inv.reverse(op, id, f.reason.value.trim()),
      });
      if (done) reload(ctx, 'Import undone.');
    }
  });
}
