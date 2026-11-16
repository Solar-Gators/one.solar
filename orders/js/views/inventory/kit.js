/**
 * Inventory pages: what they share. The base data (items with totals, locations, units, categories, CE divisions
 * and subsystems) is loaded once and kept until something changes; the quick-action dialogs (Use, Put back,
 * Receive, Move, Set aside, Release, Correct) are the same everywhere: item page, location page, scan, dashboard.
 */
import { auth } from '../../auth.js';
import { esc, errorBox } from '../../ui.js';
import { inv } from '../../inventory/api.js';
import { newOpId, fmtQty, stockState, unitsFor, locationTree, useForLabel, lotLabel, lotProblem, firstExpiringFirst, HAZARDS } from '../../inventory/core.js';

export const INV_PERMS = ['inventory.view', 'inventory.use', 'inventory.receive', 'inventory.count', 'inventory.manage'];
export const can = {
  use: () => auth.can('inventory.use') || auth.can('inventory.manage'),
  receive: () => auth.can('inventory.receive') || auth.can('inventory.manage'),
  count: () => auth.can('inventory.count') || auth.can('inventory.manage'),
  manage: () => auth.can('inventory.manage'),
  org: () => auth.can('inventory.manage') || auth.can('settings.edit'),
  setAside: () => auth.can('inventory.receive') || auth.can('inventory.count') || auth.can('inventory.manage'),
};

/** The database has Inventory (050)? Otherwise pages say so instead of failing. */
export function needsDatabase(config) {
  if (Number(config.schemaVersion) >= 50) return '';
  return `<section class="card no-access"><h1>Inventory isn't set up yet</h1>
    <p>The database needs the update <code>supabase/migrations/050_inventory.sql</code>. ${auth.can('settings.edit') ? 'See the yellow banner above.' : 'Ask an Admin.'}</p></section>`;
}

let base = null;
/** Everything most pages need, loaded together and kept until a change (invalidate()). */
export async function loadBase({ fresh = false } = {}) {
  if (!base || fresh) {
    base = Promise.all([inv.overview(), inv.locations(), inv.units(), inv.categories(), inv.divisions(), inv.subsystems()])
      .then(([overview, locations, units, categories, divisions, subsystems]) => ({
        overview, items: overview.items, locations, units, categories, divisions, subsystems, settings: overview.settings || {},
        itemById: new Map(overview.items.map((i) => [i.id, i])), locById: new Map(locations.map((l) => [l.id, l])),
        tree: locationTree(locations),
      }))
      .catch((e) => {
        base = null;
        throw e;
      });
  }
  return base;
}
export const invalidate = () => (base = null);

export const qty = (n, item) => fmtQty(n, item?.unit || '', item?.decimals ?? 4);
export const locCode = (b, id) => b.locById.get(id)?.code || '—';
export const locLabel = (b, id) => {
  const l = b.locById.get(id);
  return l ? `${l.code}${l.name && l.name !== l.code ? ` · ${l.name}` : ''}` : '—';
};
export const itemHref = (id) => `#/inventory/items/${encodeURIComponent(id)}`;
export const locHref = (id) => `#/inventory/locations/${encodeURIComponent(id)}`;

/** A small coloured state chip: In stock / Low / Out / Low, more on order. */
export function stateChip(item) {
  const s = stockState(item);
  const tone = { ok: 'green', covered: 'blue', low: 'amber', out: 'red' }[s.key];
  return `<span class="chip chip-tone tone-${tone} inv-state" data-state="${s.key}">${esc(s.label)}</span>`;
}

export const hazardChips = (classes = []) =>
  classes.map((c) => `<span class="chip chip-tone tone-red inv-hazard" title="Hazard">⚠ ${esc(HAZARDS[c] || c)}</span>`).join(' ');

/** The Inventory pages' top: title, subtitle and buttons. */
export const header = (title, subtitle = '', actions = '') => `<div class="page-header inv-head">
  <div><h1>${title}</h1>${subtitle ? `<p class="subtitle">${subtitle}</p>` : ''}</div>
  ${actions ? `<div class="card-actions">${actions}</div>` : ''}</div>`;

/** <option>s of locations, indented like a tree. */
export function locationOptions(b, selected = '', { blank = 'Pick a location', only = null } = {}) {
  return `${blank ? `<option value="">${esc(blank)}</option>` : ''}${b.tree
    .filter((l) => !only || only.has(l.id))
    .map((l) => `<option value="${esc(l.id)}" ${l.id === selected ? 'selected' : ''}>${' '.repeat(l.depth)}${esc(l.code)}${l.name && l.name !== l.code ? ` · ${esc(l.name)}` : ''}</option>`)
    .join('')}`;
}

// ---- What it's for: CE division → subsystem (or General shop) --------------------------------------

/**
 * The "What's it for?" fields. The subsystem list only shows the chosen division's subsystems. `pick` is the
 * last choice ({ use_for, division_id, subsystem_id }, remembered per person) so the usual answer is already set.
 */
export function attributionFields(b, pick = {}, { prefix = 'att' } = {}) {
  const divisions = b.divisions.filter((d) => !d.archived_at);
  const generalOn = pick.use_for === 'general';
  const division = generalOn ? '' : pick.division_id || '';
  return `<div class="inv-attr" data-attr="${prefix}">
    <div class="field"><label for="${prefix}-division">CE division</label>
      <select id="${prefix}-division" data-att-division required>
        <option value="">Pick a division</option>
        ${divisions.map((d) => `<option value="${esc(d.id)}" ${d.id === division ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
        <option value="general" ${generalOn ? 'selected' : ''}>General shop (not for one subsystem)</option>
      </select></div>
    <div class="field"><label for="${prefix}-subsystem">Subsystem</label>
      <select id="${prefix}-subsystem" data-att-subsystem></select>
      <div class="hint">${divisions.length ? '' : 'No CE divisions yet: an inventory manager adds them in Setup. Until then pick General shop.'}</div></div>
  </div>`;
}

/** Fill the subsystem list for the chosen division; returns a reader for the choice. */
export function bindAttribution(root, b, pick = {}, { prefix = 'att' } = {}) {
  const box = root.querySelector(`[data-attr="${prefix}"]`);
  const div = box.querySelector('[data-att-division]');
  const sub = box.querySelector('[data-att-subsystem]');
  const fill = (selected) => {
    const general = div.value === 'general';
    const list = b.subsystems.filter((s) => s.division_id === div.value && !s.archived_at);
    sub.disabled = general || !div.value;
    sub.innerHTML = general
      ? '<option value="">—</option>'
      : `<option value="">${div.value ? 'Whole division (no one subsystem)' : 'Pick a division first'}</option>${list
          .map((s) => `<option value="${esc(s.id)}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}`;
  };
  fill(pick.use_for === 'subsystem' ? pick.subsystem_id : '');
  div.addEventListener('change', () => fill(''));
  return () => {
    if (div.value === 'general') return { use_for: 'general', division_id: null, subsystem_id: null };
    if (!div.value) return { use_for: '', division_id: null, subsystem_id: null };
    return sub.value ? { use_for: 'subsystem', division_id: div.value, subsystem_id: sub.value } : { use_for: 'division', division_id: div.value, subsystem_id: null };
  };
}

// ---- Dialogs -------------------------------------------------------------------------------------

/**
 * A one.solar dialog with a form. onSubmit(form, opId) does the work; its errors show in the dialog and the
 * same operation id is used if they try again (so a lost reply can't make it happen twice). Resolves with what
 * onSubmit returned, or null if cancelled.
 */
export function formDialog({ title, body, submit = 'Save', onSubmit, onOpen, wide = false, danger = false }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = `card sheet-dialog inv-dialog${wide ? ' inv-dialog-wide' : ''}`;
    dialog.innerHTML = `<form novalidate>
      <h2>${title}</h2>
      <div class="inv-dialog-error" aria-live="polite"></div>
      ${body}
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
        <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-submit>${esc(submit)}</button></div>
    </form>`;
    document.body.append(dialog);
    const form = dialog.querySelector('form');
    const opId = newOpId();
    let result = null;
    dialog.addEventListener('close', () => (dialog.remove(), resolve(result)));
    dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[data-submit]');
      if (btn.disabled) return;
      if (!form.checkValidity()) return form.reportValidity();
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = 'Saving…';
      form.querySelector('.inv-dialog-error').innerHTML = '';
      try {
        result = (await onSubmit(form, opId)) ?? true;
        dialog.close();
      } catch (err) {
        form.querySelector('.inv-dialog-error').innerHTML = errorBox(err);
        btn.disabled = false;
        btn.textContent = label;
      }
    };
    dialog.showModal();
    onOpen?.(form);
    form.querySelector('input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea')?.focus();
  });
}

/** Amount + unit (the item's own, or another of the same kind). */
function amountField(b, item, { label = 'How many', value = '', max = null } = {}) {
  const units = unitsFor(item, b.units);
  const step = item.decimals > 0 ? `0.${'0'.repeat(item.decimals - 1)}1` : '1';
  return `<div class="field inv-amount"><label for="a-qty">${esc(label)}</label>
    <div class="inv-amount-row">
      <input id="a-qty" name="qty" type="number" inputmode="decimal" min="0" step="any" required value="${esc(value)}" data-step="${step}" ${max !== null ? `data-max="${esc(max)}"` : ''}>
      ${units.length > 1
        ? `<select name="unit" aria-label="Unit">${units.map((u) => `<option value="${esc(u.code)}">${esc(u.label)}</option>`).join('')}</select>`
        : `<span class="inv-unit">${esc(units[0]?.label || item.unit)}</span><input type="hidden" name="unit" value="${esc(item.unit)}">`}
    </div>${max !== null ? `<div class="hint">${esc(qty(max, item))} there.</div>` : ''}</div>`;
}

/** The buckets of an item (with quantities) as <option>s: location / lot / set aside. */
function bucketOptions(b, stock, lots, item, { status = 'available', selected = '', showEmpty = false } = {}) {
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const list = stock.filter((s) => s.status === status && (showEmpty || Number(s.qty) > 0));
  const order = firstExpiringFirst(list.map((s) => ({ ...s, ...(lotById.get(s.lot_id) || {}), id: s.id, lot_id: s.lot_id })));
  return order.map((s) => {
    const lot = lotById.get(s.lot_id);
    const problem = lotProblem(lot);
    const key = `${s.location_id}|${s.lot_id || ''}`;
    return `<option value="${esc(key)}" data-qty="${esc(s.qty)}" ${key === selected ? 'selected' : ''} ${problem && status === 'available' ? 'data-problem' : ''}>${esc(locLabel(b, s.location_id))}${lot ? ` · lot ${esc(lotLabel(lot))}${lot.expires_on ? ` (exp. ${esc(lot.expires_on)})` : ''}` : ''} — ${esc(qty(s.qty, item))}${problem ? ` · ${esc(problem)}` : ''}</option>`;
  }).join('');
}
const splitBucket = (v) => {
  const [location_id, lot_id] = String(v || '').split('|');
  return { location_id: location_id || null, lot_id: lot_id || null };
};

/**
 * The quick actions. kind: use | return | receive | move | setaside | release | correct. ctx: { item, stock, lots,
 * locationId, lotId, prefs, returnsOp }. Resolves with the database's result (totals) or null.
 */
export async function stockDialog(kind, b, ctx) {
  const { item, stock = [], lots = [] } = ctx;
  const here = ctx.locationId ? `${ctx.locationId}|${ctx.lotId || ''}` : '';
  const lotHint = item.track_lots ? '<div class="hint">Soonest expiry first. Expired lots can\'t be used: set them aside.</div>' : '';
  const note = '<div class="field"><label for="a-note">Note <span class="muted">(optional)</span></label><input id="a-note" name="note" maxlength="500"></div>';
  const pickFrom = (status, label) => {
    const opts = bucketOptions(b, stock, lots, item, { status, selected: here });
    return opts
      ? `<div class="field"><label for="a-from">${label}</label><select id="a-from" name="from" required>${opts}</select>${lotHint}</div>`
      : `<p class="alert alert-warning">There's none of "${esc(item.name)}" ${status === 'quarantine' ? 'set aside' : 'in stock'} right now.</p>`;
  };
  const dateField = '<div class="field"><label for="a-date">Date</label><input id="a-date" name="date" type="date"></div>';
  const lotFields = item.track_lots
    ? `<fieldset class="inv-lot-fields"><legend>Lot</legend>
        <div class="field"><label for="a-lotpick">Lot</label><select id="a-lotpick" name="lot_id"><option value="">A new lot…</option>${firstExpiringFirst(lots).map((l) => `<option value="${esc(l.id)}">${esc(lotLabel(l))}${l.expires_on ? ` (exp. ${esc(l.expires_on)})` : ''}</option>`).join('')}</select></div>
        <div class="form-grid" data-newlot>
          <div class="field span-2"><label for="a-lotcode">Lot / batch number</label><input id="a-lotcode" name="lot_code" maxlength="60"></div>
          <div class="field span-2"><label for="a-container">Container <span class="muted">(optional)</span></label><input id="a-container" name="container" maxlength="60" placeholder="e.g. can 2"></div>
          <div class="field span-2"><label for="a-exp">Expires</label><input id="a-exp" name="expires_on" type="date"></div>
          <div class="field span-2"><label for="a-retest">Retest by <span class="muted">(optional)</span></label><input id="a-retest" name="retest_on" type="date"></div>
        </div></fieldset>`
    : '';
  const lotPayload = (f) => (item.track_lots
    ? f.lot_id.value
      ? { lot_id: f.lot_id.value }
      : { lot: { lot_code: f.lot_code.value.trim(), container: f.container.value.trim(), expires_on: f.expires_on.value, retest_on: f.retest_on.value } }
    : {});
  const toggleNewLot = (f) => {
    const box = f.querySelector('[data-newlot]');
    if (!box) return;
    const sync = () => (box.hidden = !!f.lot_id.value);
    f.lot_id.addEventListener('change', sync);
    sync();
  };
  const fromOf = (f) => splitBucket(f.from?.value);
  const amount = (f) => ({ qty: f.qty.value, unit: f.unit.value });
  let readAttr = null;

  const specs = {
    use: {
      title: `Use ${esc(item.name)}`,
      submit: 'Take it out',
      body: () => `${pickFrom('available', 'From')}${amountField(b, item, { label: 'How many are you taking?' })}
        <p class="sub-label">What's it for?</p>${attributionFields(b, ctx.prefs || {})}
        <div class="field"><label for="a-project">Project, car or purpose <span class="muted">(optional)</span></label><input id="a-project" name="project" maxlength="120" value="${esc(ctx.prefs?.project || '')}"></div>${note}`,
      open: (f) => (readAttr = bindAttribution(f, b, ctx.prefs || {})),
      run: async (f, op) => {
        const att = readAttr();
        if (!att.use_for) throw new Error('Pick the CE division it\'s for (or General shop).');
        return inv.consume(op, { item_id: item.id, ...fromOf(f), ...amount(f), ...att, project: f.project.value.trim(), note: f.note.value.trim() });
      },
    },
    return: {
      title: `Put back ${esc(item.name)}`,
      submit: 'Put it back',
      body: () => `<div class="field"><label for="a-to">Into</label><select id="a-to" name="to" required>${locationOptions(b, ctx.locationId || item.default_location_id || '')}</select></div>
        ${item.track_lots ? `<div class="field"><label for="a-lot">Lot</label><select id="a-lot" name="lot" required><option value="">Pick the lot</option>${lots.map((l) => `<option value="${esc(l.id)}" ${l.id === ctx.lotId ? 'selected' : ''}>${esc(lotLabel(l))}</option>`).join('')}</select></div>` : ''}
        ${amountField(b, item, { label: 'How many are going back?' })}
        ${ctx.returnsOp ? '<p class="hint">It\'s credited back to whatever it was taken for.</p>' : `<p class="sub-label">What was it taken for?</p>${attributionFields(b, ctx.prefs || {})}`}${note}`,
      open: (f) => !ctx.returnsOp && (readAttr = bindAttribution(f, b, ctx.prefs || {})),
      run: async (f, op) => {
        const att = ctx.returnsOp ? { returns_op: ctx.returnsOp } : readAttr();
        if (!ctx.returnsOp && !att.use_for) throw new Error('Pick the CE division it was taken for (or General shop).');
        return inv.putBack(op, { item_id: item.id, location_id: f.to.value, lot_id: f.lot?.value || null, ...amount(f), ...att, note: f.note.value.trim() });
      },
    },
    receive: {
      title: `Receive ${esc(item.name)}`,
      submit: 'Add to stock',
      body: () => `<div class="field"><label for="a-to">Into</label><select id="a-to" name="to" required>${locationOptions(b, ctx.locationId || item.default_location_id || '')}</select></div>
        ${amountField(b, item, { label: 'How many arrived?' })}${lotFields}
        <div class="form-grid">
          <div class="field span-2"><label for="a-source">Where it came from</label><input id="a-source" name="source" maxlength="200" placeholder="e.g. donation, leftover from the old car"></div>
          <div class="field span-2"><label for="a-cost">Cost per ${esc(item.unit)} <span class="muted">(optional)</span></label><input id="a-cost" name="unit_cost" type="number" min="0" step="any" inputmode="decimal"></div>
        </div>
        <p class="hint">Bought through Orders? Receive it from the order instead (Receive → From Orders), so Orders knows it arrived.</p>
        <label class="inline-check"><input type="checkbox" name="quarantine"> Set it aside on arrival (to be checked before anyone uses it)</label>
        ${dateField}${note}`,
      open: toggleNewLot,
      run: async (f, op) => inv.receive(op, { item_id: item.id, location_id: f.to.value, ...amount(f), ...lotPayload(f), source: f.source.value.trim(),
        unit_cost: f.unit_cost.value || null, quarantine: f.quarantine.checked, date: f.date.value || null, note: f.note.value.trim() }),
    },
    move: {
      title: `Move ${esc(item.name)}`,
      submit: 'Move it',
      body: () => `${pickFrom(ctx.status || 'available', 'From')}
        <div class="field"><label for="a-to">To</label><select id="a-to" name="to" required>${locationOptions(b, '')}</select></div>
        ${amountField(b, item, { label: 'How many?' })}${note}`,
      run: async (f, op) => {
        const from = fromOf(f);
        return inv.transfer(op, { item_id: item.id, from_id: from.location_id, to_id: f.to.value, lot_id: from.lot_id, status: ctx.status || 'available', ...amount(f), note: f.note.value.trim() });
      },
    },
    setaside: {
      title: `Set aside ${esc(item.name)}`,
      submit: 'Set aside',
      body: () => `<p class="hint">Damaged, expired or questionable stock stays counted but can't be used until an inventory manager releases it.</p>
        ${pickFrom('available', 'From')}${amountField(b, item, { label: 'How many?' })}
        <div class="field"><label for="a-reason">Why?</label><input id="a-reason" name="reason" required minlength="3" maxlength="300" placeholder="e.g. damaged in shipping, expired"></div>`,
      run: async (f, op) => inv.quarantine(op, { item_id: item.id, ...fromOf(f), ...amount(f), reason: f.reason.value.trim() }),
    },
    release: {
      title: `Release ${esc(item.name)}`,
      submit: 'Release for use',
      body: () => `${pickFrom('quarantine', 'Set-aside stock')}${amountField(b, item, { label: 'How many are fine to use?' })}
        <div class="field"><label for="a-reason">Why is it OK now?</label><input id="a-reason" name="reason" maxlength="300" placeholder="e.g. inspected, fine"></div>
        <p class="hint">Expired lots can't be released: update the lot's dates (or condition) first.</p>`,
      run: async (f, op) => inv.quarantine(op, { item_id: item.id, ...fromOf(f), ...amount(f), reason: f.reason.value.trim(), release: true }),
    },
    correct: {
      title: `Correct ${esc(item.name)}`,
      submit: 'Correct the stock',
      danger: true,
      body: () => `<p class="hint">For a mistake that can't be undone, or stock found or lost outside a count. It's recorded with your reason.</p>
        <div class="field"><label for="a-from">Where</label><select id="a-from" name="from" required>${bucketOptions(b, stock, lots, item, { status: ctx.status || 'available', selected: here, showEmpty: true }) || `<option value="">—</option>`}${
          `<optgroup label="Somewhere with none recorded">${b.tree.map((l) => `<option value="${esc(l.id)}|" data-qty="0">${' '.repeat(l.depth)}${esc(l.code)}</option>`).join('')}</optgroup>`}</select></div>
        <div class="field"><label for="a-set">The right quantity (${esc(item.unit)})</label><input id="a-set" name="set_to" type="number" min="0" step="any" required inputmode="decimal"><div class="hint" data-now></div></div>
        <div class="field"><label for="a-reason">Why?</label><input id="a-reason" name="reason" required minlength="3" maxlength="300"></div>`,
      open: (f) => {
        const show = () => {
          const opt = f.from.selectedOptions[0];
          f.querySelector('[data-now]').textContent = opt ? `The system says ${qty(opt.dataset.qty || 0, item)} there.` : '';
          f.dataset.expected = opt?.dataset.qty || '0';
        };
        f.from.addEventListener('change', show);
        show();
      },
      run: async (f, op) => inv.adjust(op, { item_id: item.id, ...fromOf(f), status: ctx.status || 'available', set_to: f.set_to.value, expected: f.dataset.expected, reason: f.reason.value.trim() }),
    },
  };
  const spec = specs[kind];
  const result = await formDialog({ title: spec.title, body: spec.body(), submit: spec.submit, danger: spec.danger, onOpen: spec.open, onSubmit: spec.run });
  if (result) invalidate();
  return result;
}

/** Which quick actions this person has, for an item: [[kind, label]]. */
export function actionsFor(item) {
  const a = [];
  if (can.use()) a.push(['use', 'Use'], ['return', 'Put back']);
  if (can.receive() && item.status !== 'archived') a.push(['receive', 'Receive']);
  if (can.receive()) a.push(['move', 'Move']);
  if (can.setAside()) a.push(['setaside', 'Set aside']);
  if (can.manage()) a.push(['release', 'Release'], ['correct', 'Correct']);
  return a;
}

/** "Taken out by Mia for Battery (Powertrain)" etc., for a movement. */
export function movementWhat(m, b) {
  const who = useForLabel(m, b);
  return who ? `${esc(who)}${m.project ? ` · ${esc(m.project)}` : ''}` : '';
}

export { fmtQty, stockState, lotLabel, lotProblem, firstExpiringFirst, useForLabel, newOpId };
