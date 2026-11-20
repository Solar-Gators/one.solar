/**
 * Events' data access (migration 064). Reads come straight from the ev_ tables (row-level security shows members
 * their own invitations and check-ins, hosts their events, and leads with "See attendance" everything); every
 * change is a database function that checks who's asking.
 */
import { supabase } from '../supabase.js';
import { allPages } from '../api.js';

function toError(e) {
  const err = new Error(e.message || 'Something went wrong.');
  err.code = e.code || '';
  err.conflict = e.code === 'OS409';
  err.duplicate = e.code === 'OS412';
  err.badCode = e.code === 'OS403';
  return err;
}
function unwrap({ data, error }) {
  if (error) throw toError(error);
  return data;
}
const rows = async (build) => unwrap(await allPages(build));
const call = async (fn, args) => unwrap(await supabase.rpc(fn, args));
const forEvent = (table, eventId, order = 'user_id') => rows(() => {
  let q = supabase.from(table).select('*');
  if (eventId) q = q.eq('event_id', eventId);
  return q.order('event_id').order(order);
});

export const ev = {
  // ---- reading ----
  events: () => rows(() => supabase.from('ev_events').select('*').order('starts_at', { ascending: false }).order('id')),
  event: async (id) => unwrap(await supabase.from('ev_events').select('*').eq('id', id).maybeSingle()),
  categories: () => rows(() => supabase.from('ev_categories').select('*').order('sort').order('name').order('id')),
  templates: () => rows(() => supabase.from('ev_templates').select('*').is('archived_at', null).order('name').order('id')),
  /** Everyone's (for leads), or one event's. */
  invitees: (eventId = null) => forEvent('ev_invitees', eventId),
  rsvps: (eventId = null) => forEvent('ev_rsvps', eventId),
  attendance: (eventId = null) => forEvent('ev_attendance', eventId),
  /** Mine only: { invitees, rsvps, attendance }. */
  async mine(userId) {
    const of = (table) => rows(() => supabase.from(table).select('*').eq('user_id', userId).order('event_id'));
    const [invitees, rsvps, attendance] = await Promise.all([of('ev_invitees'), of('ev_rsvps'), of('ev_attendance')]);
    return { invitees, rsvps, attendance };
  },
  log: (eventId) => rows(() => supabase.from('ev_log').select('*').eq('event_id', eventId).order('id', { ascending: false })),
  divisions: () => rows(() => supabase.from('org_divisions').select('*').order('sort').order('name').order('id')),
  subsystems: () => rows(() => supabase.from('org_subsystems').select('*').order('sort').order('name').order('id')),
  personOrg: () => rows(() => supabase.from('person_org').select('user_id, division_id, subsystem_id, main').order('user_id').order('division_id')),

  // ---- changing ----
  sync: () => call('ev_sync'),
  save: (id, p) => call('ev_save_event', { p_id: id, p }),
  remove: (id) => call('ev_delete_event', { p_id: id }),
  rsvp: (eventId, answer, note = '') => call('ev_rsvp', { p_event: eventId, p_answer: answer, p_note: note }),
  setCheckin: (eventId, open) => call('ev_set_checkin', { p_event: eventId, p_open: open }),
  code: (eventId) => call('ev_checkin_code', { p_event: eventId }),
  checkinInfo: (eventId) => call('ev_checkin_info', { p_event: eventId }),
  checkIn: (eventId, code, answers = {}) => call('ev_check_in', { p_event: eventId, p_code: code, p_answers: answers }),
  hostCheckIn: (eventId, userId, late = null) => call('ev_host_check_in', { p_event: eventId, p_user: userId, p_late: late, p_answers: {} }),
  setLate: (eventId, userId, late) => call('ev_set_late', { p_event: eventId, p_user: userId, p_late: late }),
  undoCheckIn: (eventId, userId) => call('ev_remove_attendance', { p_event: eventId, p_user: userId }),
  restoreCheckIn: (eventId, userId, was) => call('ev_restore_attendance', { p_event: eventId, p_user: userId, p_was: was }),
  excuse: (eventId, userId, excused, note = '') => call('ev_set_excused', { p_event: eventId, p_user: userId, p_excused: excused, p_note: note }),
  saveCategory: (id, p) => call('ev_save_category', { p_id: id, p }),
  saveTemplate: (id, p) => call('ev_save_template', { p_id: id, p }),
};
