/**
 * Inventory's data access (migration 050). Reads come straight from the tables (row-level security lets anyone
 * with an inventory permission read them); every change is a database function that checks permissions and
 * keeps stock and history together. Stock changes take an operation id (core.js newOpId) so a retry is harmless.
 */
import { supabase } from '../supabase.js';
import { allPages } from '../api.js';

function toError(e) {
  const err = new Error(e.message || 'Something went wrong.');
  err.details = e.details ? String(e.details).split('\n').filter(Boolean) : [];
  err.code = e.code || '';
  err.conflict = e.code === 'OS409'; // the stock changed since the page looked
  err.short = e.code === 'OS422'; // not that much there (or still to come)
  err.duplicate = e.code === 'OS412'; // looks like an item already in the catalog
  err.repeat = e.code === 'OS410'; // this file was imported before
  return err;
}
function unwrap({ data, error }) {
  if (error) throw toError(error);
  return data;
}
const rows = async (build) => unwrap(await allPages(build));

export const inv = {
  // ---- reading ----
  async overview() {
    return unwrap(await supabase.rpc('inventory_overview'));
  },
  async units() {
    return rows(() => supabase.from('inventory_units').select('*').order('sort').order('code'));
  },
  async locations() {
    return rows(() => supabase.from('inventory_locations').select('*').order('code').order('id'));
  },
  async categories() {
    return rows(() => supabase.from('inventory_categories').select('*').order('name').order('id'));
  },
  async divisions() {
    return rows(() => supabase.from('org_divisions').select('*').order('sort').order('name').order('id'));
  },
  async subsystems() {
    return rows(() => supabase.from('org_subsystems').select('*').order('sort').order('name').order('id'));
  },
  async item(id) {
    return unwrap(await supabase.from('inventory_items').select('*').eq('id', id).maybeSingle());
  },
  async stock({ itemId, locationIds } = {}) {
    return rows(() => {
      let q = supabase.from('inventory_stock').select('*');
      if (itemId) q = q.eq('item_id', itemId);
      if (locationIds) q = q.in('location_id', locationIds);
      return q.order('id');
    });
  },
  async lots(itemId) {
    return rows(() => supabase.from('inventory_lots').select('*').eq('item_id', itemId).order('created_at').order('id'));
  },
  async allLots() {
    return rows(() => supabase.from('inventory_lots').select('*').order('id'));
  },
  async supplierParts(itemId) {
    return rows(() => {
      let q = supabase.from('inventory_supplier_parts').select('*');
      if (itemId) q = q.eq('item_id', itemId);
      return q.order('created_at').order('id');
    });
  },
  /** Movements, newest first. filters: { itemId, locationId, kind, from, to } (dates). Up to `limit`. */
  async movements({ itemId, locationId, kind, from, to, opIds } = {}, limit = 200) {
    let q = supabase.from('inventory_movements').select('*');
    if (itemId) q = q.eq('item_id', itemId);
    if (locationId) q = q.eq('location_id', locationId);
    if (kind) q = q.eq('kind', kind);
    if (from) q = q.gte('occurred_on', from);
    if (to) q = q.lte('occurred_on', to);
    if (opIds) q = q.in('op_id', opIds);
    return unwrap(await q.order('id', { ascending: false }).limit(limit));
  },
  /** Every movement in a date range (for the history download), oldest first. */
  async allMovements({ from, to } = {}) {
    return rows(() => {
      let q = supabase.from('inventory_movements').select('*');
      if (from) q = q.gte('occurred_on', from);
      if (to) q = q.lte('occurred_on', to);
      return q.order('id');
    });
  },
  async ops(ids) {
    if (!ids.length) return [];
    return unwrap(await supabase.from('inventory_ops').select('*').in('id', ids));
  },
  /** 061: what open Projects items have reserved: { [item id]: { total, items: [{ qty, key, title, project, start, due }] } }. */
  async reserved(ids) {
    if (!ids.length) return {};
    const res = await supabase.rpc('inventory_reserved', { p_items: ids });
    return res.error ? {} : res.data || {};
  },
  async receipts({ requestId, itemId } = {}) {
    let q = supabase.from('inventory_receipts').select('*');
    if (requestId) q = q.eq('request_id', requestId);
    if (itemId) q = q.eq('item_id', itemId);
    return unwrap(await q.order('created_at', { ascending: false }).limit(200));
  },
  async audit(recordId) {
    return unwrap(await supabase.from('inventory_audit').select('*').eq('record_id', recordId).order('id', { ascending: false }).limit(100));
  },
  async myPrefs() {
    return unwrap(await supabase.from('inventory_prefs').select('*').maybeSingle());
  },
  async counts() {
    return unwrap(await supabase.from('inventory_counts').select('*').order('started_at', { ascending: false }).limit(100));
  },
  async count(id) {
    return unwrap(await supabase.from('inventory_counts').select('*').eq('id', id).maybeSingle());
  },
  async countLines(id) {
    return rows(() => supabase.from('inventory_count_lines').select('*').eq('count_id', id).order('id'));
  },
  async importBatches() {
    return unwrap(await supabase.from('inventory_import_batches').select('*').order('created_at', { ascending: false }).limit(50));
  },
  async orderLines(requestId = null, openOnly = true) {
    return unwrap(await supabase.rpc('inventory_order_lines', { p_request: requestId, p_open_only: openOnly }));
  },
  async usage(from = null, to = null) {
    return unwrap(await supabase.rpc('inventory_usage', { p_from: from || null, p_to: to || null }));
  },
  /** A request by its number (RSG-0042), for /inventory/receive/<number>. */
  async requestByNumber(number) {
    return unwrap(await supabase.from('requests').select('id, request_number, title, status').eq('request_number', number).maybeSingle());
  },
  async findMatches(p) {
    return unwrap(await supabase.rpc('inventory_find_matches', { p }));
  },

  // ---- stock operations (each with an operation id) ----
  receive: async (op, p) => unwrap(await supabase.rpc('inventory_receive', { p_op: op, p })),
  consume: async (op, p) => unwrap(await supabase.rpc('inventory_consume', { p_op: op, p })),
  putBack: async (op, p) => unwrap(await supabase.rpc('inventory_return', { p_op: op, p })),
  transfer: async (op, p) => unwrap(await supabase.rpc('inventory_transfer', { p_op: op, p })),
  adjust: async (op, p) => unwrap(await supabase.rpc('inventory_adjust', { p_op: op, p })),
  quarantine: async (op, p) => unwrap(await supabase.rpc('inventory_quarantine', { p_op: op, p })),
  reverse: async (op, target, reason) => unwrap(await supabase.rpc('inventory_reverse', { p_op: op, p_target: target, p_reason: reason })),
  receiveOrder: async (op, p) => unwrap(await supabase.rpc('inventory_receive_order', { p_op: op, p })),
  linkOrderLine: async (lineId, itemId, unitsPer) =>
    unwrap(await supabase.rpc('inventory_link_order_line', { p_line: lineId, p_item: itemId, p_units_per: unitsPer })),
  importRows: async (op, p) => unwrap(await supabase.rpc('inventory_import', { p_op: op, p })),

  // ---- counts ----
  startCount: async (p) => unwrap(await supabase.rpc('inventory_count_start', { p })),
  addCountLine: async (countId, p) => unwrap(await supabase.rpc('inventory_count_add_line', { p_count: countId, p })),
  recordCount: async (lineId, qty, note) => unwrap(await supabase.rpc('inventory_count_record', { p_line: lineId, p_qty: qty, p_note: note })),
  recount: async (lineId) => unwrap(await supabase.rpc('inventory_count_recount', { p_line: lineId })),
  submitCount: async (countId) => unwrap(await supabase.rpc('inventory_count_submit', { p_count: countId })),
  reconcileCount: async (op, countId) => unwrap(await supabase.rpc('inventory_count_reconcile', { p_op: op, p_count: countId })),
  cancelCount: async (countId) => unwrap(await supabase.rpc('inventory_count_cancel', { p_count: countId })),

  // ---- catalog and setup ----
  saveItem: async (id, p) => unwrap(await supabase.rpc('inventory_save_item', { p_id: id, p })),
  setCountClasses: async (p) => unwrap(await supabase.rpc('inventory_set_count_classes', { p })),
  saveSupplierPart: async (id, itemId, p) => unwrap(await supabase.rpc('inventory_save_supplier_part', { p_id: id, p_item: itemId, p })),
  deleteSupplierPart: async (id) => unwrap(await supabase.rpc('inventory_delete_supplier_part', { p_id: id })),
  saveLot: async (id, p) => unwrap(await supabase.rpc('inventory_save_lot', { p_id: id, p })),
  saveLocation: async (id, p) => unwrap(await supabase.rpc('inventory_save_location', { p_id: id, p })),
  archiveLocation: async (id, archived) => unwrap(await supabase.rpc('inventory_archive_location', { p_id: id, p_archived: archived })),
  saveCategory: async (id, name, parent) => unwrap(await supabase.rpc('inventory_save_category', { p_id: id, p_name: name, p_parent: parent })),
  archiveCategory: async (id, archived) => unwrap(await supabase.rpc('inventory_archive_category', { p_id: id, p_archived: archived })),
  saveSettings: async (p) => unwrap(await supabase.rpc('inventory_save_settings', { p })),
  saveDivision: async (id, name, sort = null) => unwrap(await supabase.rpc('org_save_division', { p_id: id, p_name: name, p_sort: sort })),
  archiveDivision: async (id, archived) => unwrap(await supabase.rpc('org_archive_division', { p_id: id, p_archived: archived })),
  saveSubsystem: async (id, divisionId, name, sort = null) =>
    unwrap(await supabase.rpc('org_save_subsystem', { p_id: id, p_division: divisionId, p_name: name, p_sort: sort })),
  archiveSubsystem: async (id, archived) => unwrap(await supabase.rpc('org_archive_subsystem', { p_id: id, p_archived: archived })),
  reorderOrg: async (kind, ids) => unwrap(await supabase.rpc('org_reorder', { p_kind: kind, p_ids: ids })),
  copyDivisionsFromEvals: async () => unwrap(await supabase.rpc('org_copy_from_evals')),
  addSubsystems: async (divisionId, names) => unwrap(await supabase.rpc('org_add_subsystems', { p_division: divisionId, p_names: names })),
};
