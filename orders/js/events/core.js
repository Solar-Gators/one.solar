/**
 * Events (064): small pure helpers shared by the pages and the stats. No DOM, no database: tested in
 * tests/eventsModules.test.mjs.
 */

/** An event with no end time counts as six hours long. */
export const endOf = (e) => new Date(e.ends_at || new Date(new Date(e.starts_at).getTime() + 6 * 3600e3));
export const isOver = (e, now = new Date()) => endOf(e) < now;
export const hasStarted = (e, now = new Date()) => new Date(e.starts_at) <= now;
/** Upcoming, happening now, over or cancelled. */
export function phase(e, now = new Date()) {
  if (e.cancelled_at) return 'cancelled';
  if (isOver(e, now)) return 'over';
  if (hasStarted(e, now)) return 'now';
  return 'upcoming';
}

/** "Spring 2027", "Summer 2027", "Fall 2026" (January–April, May–July, August–December). */
export function semesterOf(iso) {
  const d = new Date(iso);
  const m = d.getMonth();
  return `${m <= 3 ? 'Spring' : m <= 6 ? 'Summer' : 'Fall'} ${d.getFullYear()}`;
}
/** Semesters, newest first, with a sortable key. */
export function semestersIn(events) {
  const key = (s) => {
    const [name, year] = s.split(' ');
    return Number(year) * 10 + { Spring: 1, Summer: 2, Fall: 3 }[name];
  };
  return [...new Set(events.map((e) => semesterOf(e.starts_at)))].sort((a, z) => key(z) - key(a));
}

/** "Tue, Nov 24 · 6:00 – 8:00 PM" (in this browser's time zone). */
export function whenText(e, { year = false } = {}) {
  const s = new Date(e.starts_at);
  const day = s.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });
  const t = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (!e.ends_at) return `${day} · ${t(s)}`;
  const f = new Date(e.ends_at);
  if (f.toDateString() !== s.toDateString()) return `${day} · ${t(s)} – ${f.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${t(f)}`;
  return `${day} · ${t(s)} – ${t(f)}`;
}

/** A datetime-local input's value ("2026-11-24T18:00") for an ISO time, in this browser's time zone, and back. */
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fromLocalInput = (v) => (v ? new Date(v).toISOString() : '');

/**
 * Who's invited, in words: "Everyone", or "Electrical, Battery, Chief Engineers and 2 people".
 * names: { division: id → name, subsystem: id → name, role: key → label, person: id → name }.
 */
export function inviteText(invite = {}, names = {}) {
  if (!invite || invite.all) return 'Everyone on the team';
  const look = (map, id) => (map instanceof Map ? map.get(id) : map?.[id]) || '';
  const parts = [
    ...(invite.divisions || []).map((id) => look(names.division, id) || 'a division'),
    ...(invite.subsystems || []).map((id) => look(names.subsystem, id) || 'a subsystem'),
    ...(invite.roles || []).map((k) => look(names.role, k) || k),
  ];
  const people = invite.people || [];
  if (people.length && people.length <= 2) parts.push(...people.map((id) => look(names.person, id) || 'someone'));
  else if (people.length) parts.push(`${people.length} people`);
  if (!parts.length) return 'Nobody yet';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Where one person stands for one event. rec: { invited, excused, rsvp: {answer}, att: {late, walk_in} }.
 * 'came' | 'late' | 'excused' | 'missed' | 'invited' (not over yet) | 'cancelled' | ''.
 * noIsExcused: "can't make it" RSVPs count as excused.
 */
export function standing(e, rec = {}, { now = new Date(), noIsExcused = true } = {}) {
  if (rec.att) return rec.att.late ? 'late' : 'came';
  if (!rec.invited) return '';
  if (e.cancelled_at) return 'cancelled';
  if (rec.excused || (noIsExcused && rec.rsvp?.answer === 'no')) return 'excused';
  return hasStarted(e, now) && isOver(e, now) ? 'missed' : 'invited';
}
export const STANDING_LABELS = { came: 'Came', late: 'Came late', excused: 'Excused', missed: 'Missed', invited: 'Invited', cancelled: 'Cancelled', '': '' };
export const STANDING_TONES = { came: 'green', late: 'amber', excused: 'blue', missed: 'red', invited: 'gray', cancelled: 'gray', '': 'gray' };

/** An answer to a sign-in question, as text. */
export function answerText(q, v) {
  if (v === undefined || v === null || v === '') return '';
  if (q?.type === 'check') return v === true || v === 'true' ? 'Yes' : 'No';
  return String(v);
}

/** A CSV file's text (header row first). Values with , " or line breaks are quoted; formulas are defused. */
export function toCsv(rows) {
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

/** A new sign-in question's id. */
export const newQuestionId = () => Math.random().toString(36).slice(2, 10);

/** The link in the QR code: this app's check-in page for the event, with the code. */
export const checkinLink = (base, eventId, code) => `${base}#/events/checkin/${encodeURIComponent(eventId)}?c=${encodeURIComponent(code)}`;
