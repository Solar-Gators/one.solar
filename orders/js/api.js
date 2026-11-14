/**
 * Data access. Reads query tables directly (row-level security allows reads
 * for signed-in users); every write calls a database function (supabase.rpc)
 * that checks permissions and workflow rules — see supabase/schema.sql.
 *
 * Views only use this module, so they don't know or care about Supabase.
 */
import { supabase } from './supabase.js';
import { itemTotal, round2 } from './ui.js';

const BASE_SELECT = '*, request_items(*), approvals(*), order_information(*)';
// cost_changes arrives with migration 004. Until a database has it, fall back to
// the base select so the site keeps working (leads see the "update needed" banner).
let withCostChanges = true;
let hasSeasons = true; // requests.season arrives with migration 006
const requestSelect = () => (withCostChanges ? `${BASE_SELECT}, cost_changes(*)` : BASE_SELECT);

/**
 * Supabase returns at most "Max rows" per request (API settings; 1,000 by default), silently. Lists that
 * can grow past that are fetched a page at a time. `build()` returns a fresh, ordered query each time; the
 * order must be stable (end with a unique column) so pages don't overlap or skip rows.
 *
 * The cap isn't known here, so the first page's size is taken as the cap: after that, a shorter page is
 * the last one. (A short first page costs one more, empty, request to be sure.)
 */
export const PAGE_SIZE = 1000;
export async function allPages(build, pageSize = PAGE_SIZE) {
  const rows = [];
  let cap = 0;
  for (;;) {
    const res = await build().range(rows.length, rows.length + pageSize - 1);
    if (res.error) return res;
    const page = res.data || [];
    rows.push(...page);
    if (page.length === 0 || (cap && page.length < cap)) return { data: rows, error: null };
    cap ||= page.length;
  }
}

/**
 * 045: what this page last read (a row's updated_at, a Finances row's cells), so a save can say what it saw.
 * If someone else saved in between, the database refuses with OS409 and says who and when, instead of one
 * person's change silently replacing the other's. Pages don't need to do anything: the list/get functions
 * below remember, and the save functions send it.
 */
const seen = new Map();
let checkedSaves = true; // false on a database from before 045 (the checked functions don't exist there)
const remember = (kind, rows) => {
  for (const r of [].concat(rows || [])) if (r && r.id && r.updated_at) seen.set(`${kind}:${r.id}`, r.updated_at);
  return rows;
};
const missingFunction = (e) => e && (e.code === 'PGRST202' || e.code === '42883');
/** Try the checked function; on a database without it, fall back to the plain one (once, then always). */
async function checkedRpc(fn, args, plainFn, plainArgs) {
  if (checkedSaves) {
    const res = await supabase.rpc(fn, args);
    if (!missingFunction(res.error)) return { ...res, checked: true };
    checkedSaves = false;
  }
  return { ...(await supabase.rpc(plainFn, plainArgs)), checked: false };
}

/** Run a requests query; if the database doesn't have cost_changes yet, retry without it. */
async function selectRequests(build) {
  let res = await build(requestSelect());
  if (res.error && withCostChanges && /cost_changes/.test(res.error.message || '')) {
    withCostChanges = false;
    res = await build(requestSelect());
  }
  return res;
}

/** Turn a Supabase/PostgREST error into an Error with a `details` list. */
function toError(e) {
  const err = new Error(e.message || 'Something went wrong.');
  err.details = e.details ? String(e.details).split('\n').filter(Boolean) : [];
  err.code = e.code || '';
  err.conflict = e.code === 'OS409'; // 045: someone else saved this after the page read it
  err.repeat = e.code === 'OS410'; // 048: this file was imported before
  return err;
}

function unwrap({ data, error }) {
  if (error) throw toError(error);
  return data;
}

/** Add items/approvals/order info and computed totals to a request row. */
function hydrate(row) {
  const items = [...(row.request_items || [])]
    .sort((a, b) => a.position - b.position)
    .map((i) => ({ ...i, item_total: itemTotal(i) }));
  const approvals = [...(row.approvals || [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const order = Array.isArray(row.order_information) ? row.order_information[0] || null : row.order_information || null;
  const costChanges = [...(row.cost_changes || [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const subtotal = round2(items.reduce((s, i) => s + i.item_total, 0));
  const shipping = round2(items.reduce((s, i) => s + (Number(i.shipping_cost) || 0), 0));
  const { request_items, order_information, cost_changes, ...rest } = row;
  return {
    ...rest,
    items,
    approvals,
    latest_approval: approvals[approvals.length - 1] || null,
    order,
    cost_changes: costChanges,
    subtotal, // items only (quantity × unit price)
    shipping,
    total: round2(subtotal + shipping),
    vendors: [...new Set(items.map((i) => i.vendor).filter(Boolean))],
  };
}

// Email / Teams: after each workflow step, ask the send-notifications Edge
// Function to deliver what the database queued. Only when turned on in
// Admin → Notifications (so nothing is called before the function exists).
let notificationsOn = false;
export function setNotificationsOn(on) {
  notificationsOn = !!on;
}
function deliver() {
  if (!notificationsOn || !supabase.functions) return;
  supabase.functions.invoke('send-notifications', { body: {} }).catch(() => {}); // failures are retried next time
}

export const api = {
  // ---- Settings -------------------------------------------------------------

  /** { general: {...}, form: {...} }. Only `general` is readable before sign-in. */
  async getSettings() {
    let res = await supabase.from('app_settings').select('key, value, updated_at');
    if (res.error) res = await supabase.from('app_settings').select('key, value');
    const rows = unwrap(res);
    for (const r of rows) if (r.updated_at) seen.set(`settings:${r.key}`, r.updated_at);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },

  /** Refused (OS409) if someone else saved these settings after this page loaded them (045). */
  async updateSettings(key, value) {
    const expected = seen.get(`settings:${key}`) || null;
    const res = await checkedRpc('update_settings_checked', { p_key: key, p_value: value, p_expected_updated_at: expected },
      'update_settings', { p_key: key, p_value: value });
    unwrap(res);
    if (res.checked && res.data) seen.set(`settings:${key}`, res.data);
  },

  // ---- Requests ---------------------------------------------------------------

  /**
   * Requests, newest first. `status`: a status or list of statuses.
   * `season`: only that season; `notSeason`: every season except that one (Archive).
   * All of them, however many (fetched a page at a time).
   */
  async listRequests(status, { season, notSeason } = {}) {
    const run = () =>
      selectRequests((select) =>
        allPages(() => {
          let q = supabase.from('requests').select(select).order('created_at', { ascending: false }).order('id', { ascending: false });
          if (Array.isArray(status)) q = q.in('status', status);
          else if (status) q = q.eq('status', status);
          if (hasSeasons && season) q = q.eq('season', season);
          if (hasSeasons && notSeason) q = q.neq('season', notSeason);
          return q;
        })
      );
    let res = await run();
    // Before migration 006 there is no season column: everything is "this season".
    if (res.error && hasSeasons && /season/.test(res.error.message || '')) {
      hasSeasons = false;
      if (notSeason) return [];
      res = await run();
    }
    return remember('request', unwrap(res)).map(hydrate);
  },

  /** Seasons that have requests, newest first. */
  async listSeasons() {
    const { data, error } = await allPages(() => supabase.from('requests').select('season').order('id'));
    if (error) return []; // before migration 006 there is no season column
    return [...new Set(data.map((r) => r.season).filter(Boolean))].sort().reverse();
  },

  /** Leads: switch to a new season (numbering restarts, e.g. SG27-001). Returns the new ID prefix. */
  async startNewSeason(season) {
    return unwrap(await supabase.rpc('start_new_season', { p_season: season }));
  },

  async countByStatus(status) {
    const { count, error } = await supabase.from('requests').select('id', { count: 'exact', head: true }).eq('status', status);
    if (error) throw toError(error);
    return count || 0;
  },

  /** Look up by request number, e.g. "SG-001". */
  async getRequest(requestNumber) {
    const row = unwrap(await selectRequests((select) => supabase.from('requests').select(select).eq('request_number', requestNumber).maybeSingle()));
    if (!row) throw new Error(`Request ${requestNumber} was not found.`);
    remember('request', row);
    const r = hydrate(row);
    // History entries (submitted, resubmitted, withdrawn, ordered, received), from migration 013.
    const ev = await supabase.from('request_events').select('*').eq('request_id', r.id).order('id');
    r.events = ev.error ? [] : ev.data;
    return r;
  },

  /** Your own requests that need you (drafts, sent back for changes), from any season. */
  async listMyUnfinished(userId) {
    const res = await selectRequests((select) =>
      supabase.from('requests').select(select).eq('created_by', userId).in('status', ['Changes Requested', 'Draft']).order('updated_at', { ascending: false })
    );
    return res.error ? [] : res.data.map(hydrate);
  },

  /** Your latest requests, any status or season (the Home page). */
  async listMyRecent(userId, limit = 5) {
    const res = await selectRequests((select) =>
      supabase.from('requests').select(select).eq('created_by', userId).order('created_at', { ascending: false }).limit(limit)
    );
    return res.error ? [] : res.data.map(hydrate);
  },

  /** How many of your requests were sent back for changes (for the Requests tab badge). */
  async countMyChangesRequested(userId) {
    const { count, error } = await supabase.from('requests').select('id', { count: 'exact', head: true }).eq('created_by', userId).eq('status', 'Changes Requested');
    return error ? 0 : count || 0;
  },

  /** The requester: delete a draft or a request sent back for changes. */
  async deleteRequest(id) {
    unwrap(await supabase.rpc('delete_request', { p_id: id }));
  },

  /** Treasurer: budgets { field, amounts: { option: dollars }, block }. */
  async setBudgets(budgets) {
    unwrap(await supabase.rpc('set_budgets', { p_budgets: budgets }));
  },
  /** Move every purchase in a category to another (combining them); returns how many moved. */
  async renameCategory(from, to, dropBudget = false) {
    return unwrap(await supabase.rpc('rename_category', { p_from: from, p_to: to, p_drop_budget: dropBudget }));
  },

  // ---- The Treasurer's ledger (migration 018) -----------------------------------------

  /** Every ledger row (purchases on their own, and the Treasurer's extras on requests), or null before 018. */
  async listPurchases() {
    const { data, error } = await supabase.from('finance_purchases').select('*').order('created_at');
    return error ? null : remember('purchase', data);
  },
  /** Create (id null; pass request_id to add the extras for a request) or update. Returns the id. */
  async savePurchase(id, fields) {
    const res = await checkedRpc('save_purchase_checked', { p_id: id, p_fields: fields, p_expected_updated_at: (id && seen.get(`purchase:${id}`)) || null },
      'save_purchase', { p_id: id, p_fields: fields });
    const out = unwrap(res);
    if (!res.checked) return out;
    seen.set(`purchase:${out.id}`, out.updated_at);
    return out.id;
  },
  async deletePurchase(id) {
    unwrap(await supabase.rpc('delete_purchase', { p_id: id }));
  },
  async listFunds(season) {
    const { data, error } = await supabase.from('finance_funds').select('*').eq('season', season).order('position');
    return error ? [] : remember('fund', data);
  },
  async saveFund(id, fields) {
    const res = await checkedRpc('save_fund_checked', { p_id: id, p_fields: fields, p_expected_updated_at: (id && seen.get(`fund:${id}`)) || null },
      'save_fund', { p_id: id, p_fields: fields });
    const out = unwrap(res);
    if (!res.checked) return out;
    seen.set(`fund:${out.id}`, out.updated_at);
    return out.id;
  },
  async deleteFund(id) {
    unwrap(await supabase.rpc('delete_fund', { p_id: id }));
  },
  /** { rainy_day, notes } for a season (empty if nothing saved yet). */
  async getFinanceSeason(season) {
    const { data } = await supabase.from('finance_seasons').select('*').eq('season', season).maybeSingle();
    return data || { season, rainy_day: null, notes: '' };
  },
  async saveFinanceSeason(season, fields) {
    unwrap(await supabase.rpc('save_finance_season', { p_season: season, p_fields: fields }));
  },

  // ---- Files & links (migration 017): kind is 'sponsor' | 'request' | 'finance' | 'purchase' --------

  /** Files and links of one sponsor card / request / Finances row, oldest first. Files get a 1-hour link (`href`). */
  async listAttachments(kind, ownerId) {
    const column = { sponsor: 'sponsor_card_id', request: 'request_id', finance: 'finance_row_id', purchase: 'finance_purchase_id' }[kind];
    const { data, error } = await supabase.from('attachments').select('*').eq(column, ownerId).order('created_at');
    if (error) return null; // before migration 017
    const paths = data.filter((a) => a.path).map((a) => a.path);
    if (paths.length) {
      const signed = await supabase.storage.from('attachments').createSignedUrls(paths, 3600);
      const byPath = new Map((signed.data || []).map((s) => [s.path, s.signedUrl]));
      for (const a of data) if (a.path) a.href = byPath.get(a.path) || '';
    }
    for (const a of data) if (a.url) a.href = a.url;
    return data;
  },
  /** { ownerId: number of files } for every sponsor card / request / Finances row that has some. */
  async attachmentCounts(kind) {
    const { data, error } = await supabase.rpc('attachment_counts', { p_kind: kind });
    return error ? {} : data || {};
  },
  async uploadAttachment(kind, ownerId, file, label = '') {
    const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80) || 'file';
    const path = `${kind}/${ownerId}/${crypto.randomUUID()}-${safe}`;
    const up = await supabase.storage.from('attachments').upload(path, file, { contentType: file.type || undefined, upsert: false });
    if (up.error) throw toError({ message: /mime|type/i.test(up.error.message) ? `"${file.name}" isn't a file type that can be attached.` : up.error.message });
    const res = await supabase.rpc('add_attachment', {
      p_kind: kind, p_owner: ownerId, p_path: path, p_url: null, p_file_name: file.name, p_size: file.size, p_mime: file.type || '', p_label: label,
    });
    if (res.error) {
      await supabase.storage.from('attachments').remove([path]); // don't leave an unlisted file behind
      throw toError(res.error);
    }
    return res.data;
  },
  async addAttachmentLink(kind, ownerId, url, label = '') {
    return unwrap(await supabase.rpc('add_attachment', {
      p_kind: kind, p_owner: ownerId, p_path: null, p_url: url, p_file_name: '', p_size: null, p_mime: '', p_label: label,
    }));
  },
  async deleteAttachment(id) {
    const path = unwrap(await supabase.rpc('delete_attachment', { p_id: id }));
    if (path) await supabase.storage.from('attachments').remove([path]); // the last link to this file
  },

  // ---- Request watchers (migration 016) ---------------------------------------------

  /** Who watches a request (user ids), or null before migration 016. */
  async listRequestWatchers(requestId) {
    const { data, error } = await supabase.from('request_watchers').select('user_id').eq('request_id', requestId);
    return error ? null : data.map((w) => w.user_id);
  },
  /** Ids of the requests you watch (for the "Requests I watch" filter). */
  async listMyWatchedRequestIds(userId) {
    const { data, error } = await supabase.from('request_watchers').select('request_id').eq('user_id', userId);
    return error ? [] : data.map((w) => w.request_id);
  },
  async setRequestWatch(requestId, userId, on) {
    unwrap(await supabase.rpc('set_request_watch', { p_request: requestId, p_user: userId, p_on: on }));
  },

  // ---- Sponsors board (migration 015) ---------------------------------------------

  async listSponsorCards() {
    const cards = unwrap(await supabase.from('sponsor_cards').select('*').order('position'));
    const watchers = unwrap(await supabase.from('sponsor_watchers').select('*'));
    for (const c of cards) c.watchers = watchers.filter((w) => w.card_id === c.id).map((w) => w.user_id);
    return remember('sponsor', cards);
  },
  /** One card with its watchers and history (newest first). */
  async getSponsorCard(id) {
    const card = unwrap(await supabase.from('sponsor_cards').select('*').eq('id', id).maybeSingle());
    if (!card) throw new Error('That sponsor card was not found. It may have been deleted.');
    remember('sponsor', card);
    card.watchers = unwrap(await supabase.from('sponsor_watchers').select('*').eq('card_id', id)).map((w) => w.user_id);
    card.activity = unwrap(await supabase.from('sponsor_activity').select('*').eq('card_id', id).order('id', { ascending: false }));
    return card;
  },
  /** Create (id null) or update a card; `fields` are only the ones to change. Returns its id. */
  async saveSponsorCard(id, fields) {
    const res = await checkedRpc('save_sponsor_card_checked', { p_id: id, p_fields: fields, p_expected_updated_at: (id && seen.get(`sponsor:${id}`)) || null },
      'save_sponsor_card', { p_id: id, p_fields: fields });
    const out = unwrap(res);
    if (!res.checked) return out;
    seen.set(`sponsor:${out.id}`, out.updated_at);
    return out.id;
  },
  async moveSponsorCard(id, stage, position) {
    unwrap(await supabase.rpc('move_sponsor_card', { p_id: id, p_stage: stage, p_position: position }));
  },
  async addSponsorComment(id, body) {
    unwrap(await supabase.rpc('add_sponsor_comment', { p_id: id, p_body: body }));
  },
  async setSponsorWatch(id, userId, on) {
    unwrap(await supabase.rpc('set_sponsor_watch', { p_id: id, p_user: userId, p_on: on }));
  },
  async renewSponsorCard(id, season) {
    return unwrap(await supabase.rpc('renew_sponsor_card', { p_id: id, p_season: season }));
  },
  async deleteSponsorCard(id) {
    unwrap(await supabase.rpc('delete_sponsor_card', { p_id: id }));
  },
  async saveSponsorSettings(value) {
    unwrap(await supabase.rpc('save_sponsor_settings', { p_value: value }));
  },
  /** Many cards at once from a spreadsheet (migration 026). Returns { added, skipped: [names] }. */
  async importSponsorCards(cards, source) {
    return unwrap(await supabase.rpc('import_sponsor_cards', { p_cards: cards, p_source: source }));
  },
  // ---- Sponsor outreach (migration 027) ----
  /** Copy past sponsors' cards onto a season's board for a car. Returns how many were added. */
  async askSponsorsAgain(ids, season, car) {
    return unwrap(await supabase.rpc('ask_sponsors_again', { p_ids: ids, p_season: season, p_car: car }));
  },
  /** Put cards in one sponsor group (key), or unlink one ('solo:<id>'). */
  async setSponsorKey(ids, key) {
    unwrap(await supabase.rpc('set_sponsor_key', { p_ids: ids, p_key: key }));
  },
  async claimSponsorCard(id, on) {
    unwrap(await supabase.rpc('claim_sponsor_card', { p_id: id, p_on: on }));
  },
  async logSponsorContact(id, date, note) {
    unwrap(await supabase.rpc('log_sponsor_contact', { p_id: id, p_date: date || null, p_note: note }));
  },
  /** Rename (or merge, or with '' remove) a tag on every card. Returns how many cards changed. */
  async renameSponsorTag(from, to) {
    return unwrap(await supabase.rpc('rename_sponsor_tag', { p_from: from, p_to: to }));
  },

  // ---- Finances (migration 014): the Treasurer's own sheets -----------------------

  async listFinanceSheets() {
    return unwrap(await supabase.from('finance_sheets').select('*').order('position'));
  },
  /** Every row of a sheet, in order (fetched 1,000 at a time, Supabase's page size). */
  async listFinanceRows(sheetId) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const page = unwrap(await supabase.from('finance_rows').select('*').eq('sheet_id', sheetId).order('position').range(from, from + 999));
      for (const r of page) seen.set(`cells:${r.id}`, { ...(r.data || {}) });
      rows.push(...page);
      if (page.length < 1000) return rows;
    }
  },
  /** Create (id null) or update a sheet. Returns its id. */
  async saveFinanceSheet(id, name, columns, position = null) {
    return unwrap(await supabase.rpc('save_finance_sheet', { p_id: id, p_name: name, p_columns: columns, p_position: position }));
  },
  async deleteFinanceSheet(id) {
    unwrap(await supabase.rpc('delete_finance_sheet', { p_id: id }));
  },
  /** rows: [{ data, request_id? }] → the new rows. */
  async addFinanceRows(sheetId, rows) {
    const added = unwrap(await supabase.rpc('add_finance_rows', { p_sheet: sheetId, p_rows: rows })) || [];
    for (const r of added) seen.set(`cells:${r.id}`, { ...(r.data || {}) });
    return added;
  },
  /** Refused (OS409) if someone else changed this cell from what the page showed (045). */
  async setFinanceCell(rowId, key, value) {
    const cells = seen.get(`cells:${rowId}`);
    const expected = cells ? String(cells[key] ?? '') : null;
    const res = await checkedRpc('set_finance_cell_checked', { p_row: rowId, p_key: key, p_value: value, p_expected: expected },
      'set_finance_cell', { p_row: rowId, p_key: key, p_value: value });
    if (res.error?.code === 'OS409' && String(value ?? '') !== '') {
      res.error = { ...res.error, message: `${res.error.message} You typed “${String(value).slice(0, 80)}”.` };
    }
    unwrap(res);
    if (cells) cells[key] = value ?? '';
  },
  async moveFinanceRow(rowId, position) {
    unwrap(await supabase.rpc('move_finance_row', { p_row: rowId, p_position: position }));
  },
  async deleteFinanceRows(ids) {
    unwrap(await supabase.rpc('delete_finance_rows', { p_ids: ids }));
  },
  /** 047: what was deleted in the last 90 days (of these kinds) and not restored yet. [] before 047. */
  async listDeletedRecords(kinds) {
    const since = new Date(Date.now() - 90 * 864e5).toISOString();
    const { data, error } = await supabase.from('deleted_records')
      .select('id, kind, record_id, label, season, deleted_by_name, deleted_at')
      .in('kind', kinds).is('restored_at', null).gte('deleted_at', since)
      .order('deleted_at', { ascending: false }).limit(100);
    return error ? [] : data;
  },
  async restoreDeletedRecord(id) {
    return unwrap(await supabase.rpc('restore_deleted_record', { p_id: id }));
  },

  /** The requester: pull a submitted request back to Draft. */
  async withdrawRequest(id) {
    unwrap(await supabase.rpc('withdraw_request', { p_id: id }));
  },

  /**
   * Create (id null) or update. action: 'draft' | 'submit'. Returns the request number.
   * clientToken (045): the same for every try of one new-request form, so a double click or a retry
   * after a dropped connection doesn't make a second request.
   */
  async saveRequest(id, { action, request, items, clientToken }) {
    const plain = { p_id: id || null, p_request: request, p_items: items, p_action: action };
    const res = !id && clientToken
      ? await checkedRpc('save_request_once', { p_client_token: clientToken, p_request: request, p_items: items, p_action: action }, 'save_request', plain)
      : await supabase.rpc('save_request', plain);
    const number = unwrap(res);
    if (action === 'submit') deliver();
    return number;
  },

  async review(id, decision, comment) {
    unwrap(await supabase.rpc('review_request', { p_id: id, p_decision: decision, p_comment: comment }));
    deliver();
  },

  async markOrdered(id, { order_date, department_order_number, treasurer_notes }) {
    unwrap(
      await supabase.rpc('mark_ordered', {
        p_id: id,
        p_order_date: order_date || null,
        p_order_number: department_order_number,
        p_notes: treasurer_notes,
      })
    );
    deliver();
  },

  /** Treasurer: change unit price / shipping after approval. items: [{ id, unit_price?, shipping_cost? }] */
  /** Leads: whose account a request belongs to (null = none). */
  async setRequestOwner(id, userId) {
    unwrap(await supabase.rpc('set_request_owner', { p_id: id, p_user_id: userId }));
  },

  /** The Treasurer changes the items on an Approved / Ordered request (034). Returns { changes, reapproval, total }. */
  async editRequestItems(id, items, reason) {
    const res = await checkedRpc('edit_request_items_checked',
      { p_id: id, p_items: items, p_reason: reason, p_expected_updated_at: seen.get(`request:${id}`) || null },
      'edit_request_items', { p_id: id, p_items: items, p_reason: reason });
    const result = unwrap(res);
    if (res.checked && result?.updated_at) seen.set(`request:${id}`, result.updated_at);
    deliver();
    return result;
  },

  async updateItemCosts(id, items, reason) {
    return unwrap(await supabase.rpc('update_item_costs', { p_request_id: id, p_items: items, p_reason: reason }));
  },

  /** Typos after submitting (019): request: { key: text }, items: [{ id, item_name, notes }]. Returns how many changed. */
  async fixRequestWording(id, request, items) {
    return unwrap(await supabase.rpc('fix_request_wording', { p_id: id, p_request: request, p_items: items }));
  },

  /** The Treasurer: an approved request isn't going to be ordered after all (migration 024). */
  async cancelRequest(id, reason) {
    unwrap(await supabase.rpc('cancel_request', { p_id: id, p_reason: reason }));
    deliver();
  },

  /** The Treasurer: undo a cancel. Returns where it went back to: 'Approved' or 'Ordered' (025). */
  async restoreRequest(id) {
    const to = unwrap(await supabase.rpc('restore_request', { p_id: id }));
    deliver();
    return to || 'Approved';
  },

  /** The Treasurer: delete a request entirely (a duplicate, a mistake). A copy is kept (025). */
  async purgeRequest(id, reason) {
    const paths = unwrap(await supabase.rpc('purge_request', { p_id: id, p_reason: reason })) || [];
    if (paths.length) await supabase.storage.from('attachments').remove(paths).catch(() => {}); // its files
  },

  /** Requests deleted entirely, newest first (Treasurer / admins), or null before 025. */
  async listDeletedRequests() {
    const { data, error } = await supabase.from('deleted_requests')
      .select('id, request_number, title, status, total, reason, deleted_by_name, deleted_at').order('deleted_at', { ascending: false }).limit(50);
    return error ? null : data;
  },

  /** Mark items arrived (or not). Returns how many haven't arrived yet (025). */
  async setItemsArrived(requestId, itemIds, arrived, { date = null, note = '' } = {}) {
    return unwrap(await supabase.rpc('set_items_arrived', { p_request: requestId, p_items: itemIds, p_arrived: arrived, p_date: date || null, p_note: note }));
  },

  /** A request's line on the Treasurer's ledger (step, M/E, notes), or null (finance viewers only). */
  async getRequestPurchase(requestId) {
    const { data, error } = await supabase.from('finance_purchases').select('*').eq('request_id', requestId).maybeSingle();
    return error ? null : remember('purchase', data);
  },

  async markReceived(id, { received_date, received_notes }) {
    unwrap(await supabase.rpc('mark_received', { p_id: id, p_received_date: received_date || null, p_notes: received_notes }));
    deliver();
  },

  /** Back to Ordered; items ticked off one by one stay arrived. Returns how many items went back to not arrived (033). */
  async undoReceived(id) {
    return unwrap(await supabase.rpc('undo_received', { p_id: id }));
  },

  // ---- Archive & import -----------------------------------------------------

  async listArchiveImports() {
    return unwrap(await supabase.from('archive_imports').select('*').order('season', { ascending: false }).order('imported_at'));
  },

  /** Every archived row (fetched 1000 at a time — the API's page size). */
  async listArchive() {
    const all = [];
    for (let from = 0; ; from += 1000) {
      const page = unwrap(
        await supabase
          .from('archive_orders')
          .select('*')
          .order('season', { ascending: false })
          .order('row_number')
          .range(from, from + 999)
      );
      all.push(...page);
      if (page.length < 1000) return all;
    }
  },

  /**
   * 048: the same rows twice are refused (err.repeat, with "…already imported on <date> by <name>.
   * Import again anyway?") unless allowRepeat. Before 048: the plain import, without the check.
   */
  async importArchive({ season, sourceFile, sheet, columns, rows, allowRepeat = false }) {
    const args = { p_season: season, p_source_file: sourceFile, p_sheet: sheet, p_columns: columns, p_rows: rows };
    let res = await supabase.rpc('import_archive_once', {
      p_season: season, p_source_file: sourceFile, p_sheet: sheet, p_columns: columns, p_rows: rows, p_allow_repeat: allowRepeat,
    });
    if (missingFunction(res.error)) res = await supabase.rpc('import_archive', args);
    return unwrap(res);
  },

  async deleteArchiveImport(id) {
    unwrap(await supabase.rpc('delete_archive_import', { p_id: id }));
  },

  /** Create requests from this season's sheet. Returns how many were created. */
  async importRequests(requests, { sourceFile = '', allowRepeat = false } = {}) {
    let res = await supabase.rpc('import_requests_once', { p_requests: requests, p_source_file: sourceFile, p_allow_repeat: allowRepeat });
    if (missingFunction(res.error)) res = await supabase.rpc('import_requests', { p_requests: requests });
    return unwrap(res);
  },

  // ---- People ---------------------------------------------------------------

  /** Everyone, each with `roles: [roleKey, ...]`. */
  async listProfiles() {
    const res = await supabase.from('profiles').select('*, profile_roles(role)').order('full_name');
    if (res.error && /profile_roles/.test(res.error.message || '')) {
      // Before migration 008: one role per person.
      return unwrap(await supabase.from('profiles').select('*').order('full_name')).map((p) => ({ ...p, roles: [p.role] }));
    }
    return unwrap(res).map(({ profile_roles, ...p }) => ({ ...p, roles: (profile_roles || []).map((r) => r.role) }));
  },

  /** The list of abilities, e.g. { key: "request.review", label: "Approve requests", description }. */
  async listPermissions() {
    return unwrap(await supabase.from('permissions').select('*').order('sort'));
  },

  async listRolePermissions() {
    return unwrap(await supabase.from('role_permissions').select('role, permission'));
  },

  /** Save what several roles can do in one step: { roleKey: [permissionKey, ...] }. */
  async setPermissionMatrix(matrix) {
    unwrap(await supabase.rpc('set_permission_matrix', { p_matrix: matrix }));
  },

  async setUserRole(userId, role) {
    unwrap(await supabase.rpc('set_user_role', { p_user_id: userId, p_role: role }));
  },

  /** Give someone exactly these roles (empty list = Member). */
  async setUserRoles(userId, roles) {
    unwrap(await supabase.rpc('set_user_roles', { p_user_id: userId, p_roles: roles }));
  },

  /** Custom roles. createRole returns the new role's key. */
  async createRole(label) {
    return unwrap(await supabase.rpc('create_role', { p_label: label }));
  },
  async renameRole(key, label) {
    unwrap(await supabase.rpc('rename_role', { p_key: key, p_label: label }));
  },
  async deleteRole(key) {
    unwrap(await supabase.rpc('delete_role', { p_key: key }));
  },

  /** Delete an account (035). From 044: Admins only, and only a former member or a guest. */
  async removePerson(userId, note) {
    unwrap(await supabase.rpc('remove_person', { p_user_id: userId, p_note: note || '' }));
  },
  /** Everyone removed so far, newest first (people managers only; [] before 035). */
  async listRemovedPeople() {
    const res = await supabase.from('removed_people').select('*').order('removed_at', { ascending: false });
    if (res.error && /removed_people/.test(res.error.message || '')) return [];
    return unwrap(res);
  },
  /** They signed up again and that's fine: stop flagging them. */
  async clearRemovedFlag(email) {
    unwrap(await supabase.rpc('clear_removed_flag', { p_email: email }));
  },

  /** 044: someone left the team: their roles go, everything they did stays, they lose access. */
  async deactivatePerson(userId, note) {
    unwrap(await supabase.rpc('deactivate_person', { p_user: userId, p_note: note || '' }));
  },
  /** 044: bring a former member back with these roles (empty = Member). */
  async reactivatePerson(userId, roles = []) {
    unwrap(await supabase.rpc('reactivate_person', { p_user: userId, p_roles: roles }));
  },

  /** 040: accept someone who signed up (a Guest) into the team as a Member. */
  async acceptMember(userId) {
    unwrap(await supabase.rpc('accept_member', { p_user: userId }));
  },

  /**
   * 042: for each role key, why the signed-in person can't give or take it ('' = they can). The
   * database enforces this either way; the page uses it to grey out boxes with the reason.
   */
  async roleChangeProblems(keys) {
    const answers = await Promise.all(keys.map(async (key) => [key, unwrap(await supabase.rpc('role_change_problem', { p_role: key })) || '']));
    return Object.fromEntries(answers);
  },
  /** 042: the record of role changes, newest first (people managers only; [] before 042). */
  async listRoleChanges(limit = 200) {
    const res = await supabase.from('role_changes').select('*').order('id', { ascending: false }).range(0, limit - 1);
    if (res.error && /role_changes/.test(res.error.message || '')) return [];
    return unwrap(res);
  },

  // ---- Diagnostics (046) -------------------------------------------------------

  /** Errors and problem reports, most recent first (Admins; [] before 046), each with `who`. */
  async listClientErrors() {
    const { data, error } = await supabase.from('client_errors').select('*').order('last_at', { ascending: false }).range(0, 999);
    if (error) return [];
    const ids = [...new Set(data.map((r) => r.user_id).filter(Boolean))];
    const people = ids.length ? (await supabase.from('profiles').select('id, full_name, email').in('id', ids)).data || [] : [];
    for (const r of data) {
      const p = people.find((x) => x.id === r.user_id);
      r.who = p ? p.full_name || p.email : r.user_id ? 'A deleted account' : '';
    }
    return data;
  },
  /** New problem reports and errors in the last 24 hours (the Diagnostics badge). */
  async countRecentDiagnostics() {
    const since = new Date(Date.now() - 864e5).toISOString();
    const { count, error } = await supabase.from('client_errors').select('id', { count: 'exact', head: true }).eq('status', 'new').gte('last_at', since);
    return error ? 0 : count || 0;
  },
  async setClientErrorStatus(id, status) {
    unwrap(await supabase.rpc('set_client_error_status', { p_id: id, p_status: status }));
  },
  async purgeOldDiagnostics() {
    return unwrap(await supabase.rpc('purge_old_diagnostics', {}));
  },
  /** Notifications that gave up (null if you can't see the log). */
  async countFailedNotifications() {
    const { count, error } = await supabase.from('notification_outbox').select('id', { count: 'exact', head: true }).eq('status', 'failed');
    return error ? null : count || 0;
  },
  /** The newest database updates (the 041 ledger), newest first. */
  async listRecentMigrations(limit = 3) {
    const { data, error } = await supabase.from('schema_migrations').select('version, name, applied_at').order('version', { ascending: false }).limit(limit);
    return error ? [] : data;
  },

  // ---- Settings history ------------------------------------------------------

  /** Saved versions of settings and permissions, newest first. */
  async listSettingsHistory(limit = 150) {
    return unwrap(await supabase.from('settings_history').select('*').order('id', { ascending: false }).range(0, limit - 1));
  },
  async restoreSettingsVersion(id) {
    unwrap(await supabase.rpc('restore_settings_version', { p_id: id }));
  },

  async updateMyProfile(fullName) {
    unwrap(await supabase.rpc('update_my_profile', { p_full_name: fullName }));
  },

  // ---- Notifications ---------------------------------------------------------

  async updateMyNotificationPrefs(email, teams) {
    unwrap(await supabase.rpc('update_my_notification_prefs', { p_email: email, p_teams: teams }));
  },
  /** Per-event choices: { event: { email: false, teams: false } } (missing = on). */
  async updateMyNotificationEvents(events) {
    unwrap(await supabase.rpc('update_my_notification_events', { p_events: events }));
  },
  /** Recent queued / sent messages (needs "Workflow, budgets & notifications"). */
  async listNotifications(limit = 100) {
    return unwrap(
      await supabase.from('notification_outbox').select('id, created_at, event, email, channel, status, attempts, sent_at, error, payload').order('id', { ascending: false }).range(0, limit - 1)
    );
  },
  async queueTestNotification(channel) {
    unwrap(await supabase.rpc('queue_test_notification', { p_channel: channel }));
  },
  async retryNotification(id) {
    unwrap(await supabase.rpc('retry_notification', { p_id: id }));
  },
  /** Run the sender now and wait for its answer: { sent, failed, errors }. */
  async sendNotificationsNow() {
    if (!supabase.functions) throw new Error('Sending is not available in local test mode.');
    const { data, error } = await supabase.functions.invoke('send-notifications', { body: {} });
    if (error) {
      let detail = '';
      try {
        detail = (await error.context?.json?.())?.error || '';
      } catch {}
      throw new Error(detail || `The send-notifications function didn't answer (${error.message}). Is it deployed? See docs/MAINTAINING.md.`);
    }
    const result = typeof data === 'string' ? JSON.parse(data || '{}') : data;
    if (typeof result?.sent !== 'number') {
      throw new Error(
        `The send-notifications function answered, but not with the order form's code (it said: ${JSON.stringify(result).slice(0, 120)}). ` +
          'In Supabase → Edge Functions → send-notifications → Code, replace everything with supabase/functions/send-notifications/index.ts and deploy again.'
      );
    }
    return result;
  },
};
