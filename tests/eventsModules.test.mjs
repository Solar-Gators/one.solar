/**
 * Events (064): the pure helpers (orders/js/events/core.js) and the attendance stats (stats.js).
 *
 *   node tests/eventsModules.test.mjs
 */
import assert from 'node:assert/strict';
import { phase, semesterOf, semestersIn, inviteText, standing, toCsv, answerText, toLocalInput, fromLocalInput, checkinLink } from '../orders/js/events/core.js';
import { peopleStats, eventStats, groupStats, countedEvents, personHistory, eventsTable, pct } from '../orders/js/events/stats.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${String(err.message).split('\n').join('\n    ')}`);
    process.exitCode = 1;
  }
}

console.log('Events modules (064)');
const now = new Date('2026-11-20T12:00:00Z');

test('phase: upcoming, now, over, cancelled (no end time: six hours)', () => {
  assert.equal(phase({ starts_at: '2026-11-21T00:00:00Z' }, now), 'upcoming');
  assert.equal(phase({ starts_at: '2026-11-20T08:00:00Z' }, now), 'now');
  assert.equal(phase({ starts_at: '2026-11-20T05:00:00Z' }, now), 'over');
  assert.equal(phase({ starts_at: '2026-11-20T05:00:00Z', ends_at: '2026-11-20T13:00:00Z' }, now), 'now');
  assert.equal(phase({ starts_at: '2026-11-21T00:00:00Z', cancelled_at: 'x' }, now), 'cancelled');
});

test('semesters: Spring (Jan–Apr), Summer (May–Jul), Fall (Aug–Dec), newest first', () => {
  assert.equal(semesterOf('2027-02-01T15:00:00'), 'Spring 2027');
  assert.equal(semesterOf('2027-06-01T15:00:00'), 'Summer 2027');
  assert.equal(semesterOf('2026-09-01T15:00:00'), 'Fall 2026');
  assert.deepEqual(semestersIn([{ starts_at: '2026-09-01T15:00:00' }, { starts_at: '2027-02-01T15:00:00' }, { starts_at: '2026-10-01T15:00:00' }]), ['Spring 2027', 'Fall 2026']);
});

test('who\'s invited, in words', () => {
  const names = { division: { d1: 'Electrical' }, subsystem: new Map([['s1', 'Battery']]), role: { ce: 'Chief Engineers' }, person: { p1: 'Mia', p2: 'Max' } };
  assert.equal(inviteText({ all: true }, names), 'Everyone on the team');
  assert.equal(inviteText({ divisions: ['d1'] }, names), 'Electrical');
  assert.equal(inviteText({ divisions: ['d1'], subsystems: ['s1'], roles: ['ce'], people: ['p1', 'p2'] }, names), 'Electrical, Battery, Chief Engineers, Mia and Max');
  assert.equal(inviteText({ people: ['p1', 'p2', 'p3'] }, names), '3 people');
});

test('standing: came, late, excused (also "can\'t make it", unless turned off), missed, still invited', () => {
  const past = { starts_at: '2026-11-01T18:00:00Z' };
  const future = { starts_at: '2026-12-01T18:00:00Z' };
  assert.equal(standing(past, { invited: true, att: { late: false } }, { now }), 'came');
  assert.equal(standing(past, { invited: false, att: { late: true } }, { now }), 'late');
  assert.equal(standing(past, { invited: true, excused: true }, { now }), 'excused');
  assert.equal(standing(past, { invited: true, rsvp: { answer: 'no' } }, { now }), 'excused');
  assert.equal(standing(past, { invited: true, rsvp: { answer: 'no' } }, { now, noIsExcused: false }), 'missed');
  assert.equal(standing(past, { invited: true }, { now }), 'missed');
  assert.equal(standing(future, { invited: true }, { now }), 'invited');
  assert.equal(standing(past, {}, { now }), '');
});

test('CSV: quotes what needs it and defuses formulas; answers as text', () => {
  assert.equal(toCsv([['Name', 'Note'], ['Mia, M', 'said "hi"'], ['=1+1', '-3']]), 'Name,Note\r\n"Mia, M","said ""hi"""\r\n\'=1+1,-3');
  assert.equal(answerText({ type: 'check' }, true), 'Yes');
  assert.equal(answerText({ type: 'check' }, false), 'No');
  assert.equal(answerText({ type: 'number' }, 3), '3');
  assert.equal(answerText({ type: 'text' }, null), '');
});

test('local date-time inputs round-trip; the check-in link carries the event and code', () => {
  const iso = '2026-11-24T23:00:00.000Z';
  assert.equal(fromLocalInput(toLocalInput(iso)), iso);
  assert.equal(checkinLink('https://x.org/one.solar/events/', 'e1', 'AB12CD'), 'https://x.org/one.solar/events/#/events/checkin/e1?c=AB12CD');
});

// A small team: Mia and Max in Electrical (Mia in Battery), Zoe in Mechanical, Nia nowhere.
const data = {
  divisions: [{ id: 'elec', name: 'Electrical' }, { id: 'mech', name: 'Mechanical' }],
  subsystems: [{ id: 'bat', name: 'Battery', division_id: 'elec' }],
  people: [{ id: 'mia', full_name: 'Mia', roles: ['member'] }, { id: 'max', full_name: 'Max', roles: ['member'] },
    { id: 'zoe', full_name: 'Zoe', roles: ['ce'] }, { id: 'nia', full_name: 'Nia', roles: ['member'] }],
  org: [{ user_id: 'mia', division_id: 'elec', subsystem_id: 'bat' }, { user_id: 'max', division_id: 'elec', subsystem_id: null },
    { user_id: 'zoe', division_id: 'mech', subsystem_id: null }],
  events: [
    { id: 'th', category_id: 'town', starts_at: '2026-10-01T18:00:00Z' },
    { id: 'td', category_id: 'test', starts_at: '2026-11-01T14:00:00Z' },
    { id: 'old', category_id: 'town', starts_at: '2026-03-01T18:00:00Z' },
    { id: 'cx', category_id: 'town', starts_at: '2026-11-05T18:00:00Z', cancelled_at: 'x' },
    { id: 'next', category_id: 'town', starts_at: '2026-12-01T18:00:00Z' },
  ],
  invitees: [
    ...['mia', 'max', 'zoe', 'nia'].map((u) => ({ event_id: 'th', user_id: u })),
    { event_id: 'td', user_id: 'mia' }, { event_id: 'td', user_id: 'max', excused: true },
    { event_id: 'old', user_id: 'mia' }, { event_id: 'cx', user_id: 'mia' }, { event_id: 'next', user_id: 'mia' },
  ],
  rsvps: [{ event_id: 'th', user_id: 'nia', answer: 'no' }, { event_id: 'th', user_id: 'mia', answer: 'yes' }],
  attendance: [
    { event_id: 'th', user_id: 'mia', late: false }, { event_id: 'th', user_id: 'zoe', late: true },
    { event_id: 'td', user_id: 'mia', late: false }, { event_id: 'td', user_id: 'zoe', late: false, walk_in: true },
  ],
};

test('counted events: started, not cancelled, in the filters', () => {
  assert.deepEqual(countedEvents(data, { now }).map((e) => e.id), ['old', 'th', 'td']);
  assert.deepEqual(countedEvents(data, { now, semester: 'Fall 2026' }).map((e) => e.id), ['th', 'td']);
  assert.deepEqual(countedEvents(data, { now, categories: ['test'] }).map((e) => e.id), ['td']);
  assert.deepEqual(countedEvents(data, { now, from: '2026-10-15', to: '2026-12-31' }).map((e) => e.id), ['td']);
});

test('people: came, walk-ins, late, excused, missed and the rate (excused don\'t count against it)', () => {
  const rows = Object.fromEntries(peopleStats(data, { now, semester: 'Fall 2026' }).map((r) => [r.person.id, r]));
  assert.deepEqual([rows.mia.invited, rows.mia.came, rows.mia.missed, pct(rows.mia.rate)], [2, 2, 0, '100%']);
  assert.deepEqual([rows.max.invited, rows.max.came, rows.max.excused, rows.max.missed, pct(rows.max.rate)], [2, 0, 1, 1, '0%']);
  assert.deepEqual([rows.zoe.invited, rows.zoe.came, rows.zoe.walkIns, rows.zoe.late, pct(rows.zoe.rate)], [1, 2, 1, 1, '100%']);
  assert.deepEqual([rows.nia.excused, pct(rows.nia.rate)], [1, '—']);
  assert.equal(rows.mia.lastCame, '2026-11-01T14:00:00Z');
  assert.deepEqual(rows.mia.byCategory, { town: 1, test: 1 });
  assert.equal(peopleStats(data, { now, semester: 'Fall 2026', noIsExcused: false }).find((r) => r.person.id === 'nia').missed, 1);
});

test('people filters: division, subsystem, position', () => {
  assert.deepEqual(peopleStats(data, { now, division: 'elec' }).map((r) => r.person.id), ['mia', 'max']);
  assert.deepEqual(peopleStats(data, { now, subsystem: 'bat' }).map((r) => r.person.id), ['mia']);
  assert.deepEqual(peopleStats(data, { now, role: 'ce' }).map((r) => r.person.id), ['zoe']);
});

test('one event: invited, RSVPs, came, walk-ins, turnout, by division and subsystem', () => {
  const s = eventStats(data, data.events[1], { now });
  assert.deepEqual([s.invited, s.came, s.cameInvited, s.walkIns, s.excused, s.missed, pct(s.turnout)], [2, 2, 1, 1, 1, 0, '50%']);
  const th = eventStats(data, data.events[0], { now });
  assert.deepEqual([th.invited, th.yes, th.no, th.noAnswer, th.late], [4, 1, 1, 2, 1]);
  const elec = th.groups.find((g) => g.kind === 'division' && g.id === 'elec');
  assert.deepEqual([elec.invited, elec.came], [2, 1]);
  assert.deepEqual(th.groups.map((g) => g.name), ['Electrical', 'Mechanical', 'No division', 'Battery']);
  assert.deepEqual(eventsTable(data, { now }).map((r) => r.event.id), ['td', 'th', 'old']);
});

test('groups: average rate and how many are above or below the threshold', () => {
  const g = Object.fromEntries(groupStats(data, { now, semester: 'Fall 2026' }, 'division', 0.5).map((x) => [x.id, x]));
  assert.deepEqual([g.elec.people, pct(g.elec.avgRate), g.elec.above, g.elec.below], [2, '50%', 1, 1]);
  assert.deepEqual([g.mech.people, g.mech.above], [1, 1]);
  assert.equal(g[''].name, 'Not in a division');
  const s = groupStats(data, { now }, 'subsystem', 0.9);
  assert.deepEqual(s.map((x) => x.name), ['Battery', 'Not in a subsystem']);
});

test('a person\'s history: every event they were invited to or came to, newest first', () => {
  assert.deepEqual(personHistory(data, 'mia', { now }).map((h) => [h.event.id, h.standing]),
    [['next', 'invited'], ['cx', 'cancelled'], ['td', 'came'], ['th', 'came'], ['old', 'missed']]);
});

console.log(`\n${passed} passed`);
