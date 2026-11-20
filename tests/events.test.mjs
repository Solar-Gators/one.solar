/**
 * Events (migration 064): who can create and see events, invitations worked out from divisions / subsystems /
 * positions / people, RSVPs, the rotating check-in code, sign-in questions, host check-in, undo, excused, the log.
 * Against PGlite with every migration loaded.
 *
 *   node tests/events.test.mjs
 */
import assert from 'node:assert/strict';
import { freshDb } from './support/supabase-stub.mjs';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${String(err.message).split('\n').join('\n    ')}`);
    process.exitCode = 1;
  }
}

let n = 0;
async function person(db, email, name, roles) {
  const id = `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`;
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, email, { full_name: name }]);
  await db.query(`delete from profile_roles where user_id = $1`, [id]);
  for (const r of roles) await db.query(`insert into profile_roles (user_id, role) values ($1, $2)`, [id, r]);
  return id;
}
async function as(db, uid, fn) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
  await db.exec('set role authenticated');
  try { return await fn(); } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}
const by = (db, uid, fn, ...args) => as(db, uid, async () =>
  (await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r);
const rowsAs = (db, uid, sql, params = []) => as(db, uid, async () => (await db.query(sql, params)).rows);
async function rejects(promise, pattern, code) {
  try { await promise; } catch (err) {
    assert.match(err.message, pattern);
    if (code) assert.equal(err.code, code);
    return;
  }
  throw new Error(`expected an error matching ${pattern}`);
}

console.log('Events (064)');

const db = await freshDb();
const admin = await person(db, 'admin@ufl.edu', 'Ada Admin', ['admin']);
const lead = await person(db, 'lead@ufl.edu', 'Lee Lead', ['subsystem_lead']);
const ce = await person(db, 'ce@ufl.edu', 'Cara Chief', ['ce']);
const mia = await person(db, 'mia@ufl.edu', 'Mia Member', ['member']);
const max = await person(db, 'max@ufl.edu', 'Max Member', ['member']);
const zoe = await person(db, 'zoe@ufl.edu', 'Zoe Member', ['member']);
const guest = await person(db, 'guest@ufl.edu', 'Gus Guest', ['guest']);

// Divisions and subsystems: Mia in Electrical / Battery, Max in Electrical (whole division), Zoe in Mechanical.
const div = async (name) => (await db.query(`insert into org_divisions (name) values ($1) returning id`, [name])).rows[0].id;
const elec = await div('Electrical');
const mech = await div('Mechanical');
const battery = (await db.query(`insert into org_subsystems (division_id, name) values ($1, 'Battery') returning id`, [elec])).rows[0].id;
await db.query(`insert into person_org (user_id, division_id, subsystem_id, main) values ($1, $2, $3, true), ($4, $2, null, true), ($5, $6, null, true)`,
  [mia, elec, battery, max, zoe, mech]);

const soon = (mins) => new Date(Date.now() + mins * 60000).toISOString();
const invitees = async (ev) => (await db.query(`select user_id from ev_invitees where event_id = $1 order by user_id`, [ev])).rows.map((r) => r.user_id);
const codeNow = async (ev, back = 0) => (await db.query(`select evx_code($1, floor(extract(epoch from now()) / 30)::bigint - $2) c`, [ev, back])).rows[0].c;

await test('leads (Subsystem Lead, Chief Engineer, E-board) and Admins get both permissions; members and titles don\'t', async () => {
  const has = async (r, p) => (await db.query(`select 1 from role_permissions where role = $1 and permission = $2`, [r, p])).rows.length;
  for (const p of ['events.create', 'events.attendance']) {
    for (const r of ['subsystem_lead', 'ce', 'eboard', 'admin']) assert.equal(await has(r, p), 1, `${r} ${p}`);
    for (const r of ['member', 'president', 'vp']) assert.equal(await has(r, p), 0, `${r} ${p}`);
  }
  await rejects(by(db, mia, 'ev_save_event', null, { title: 'Party', starts_at: soon(60) }), /Create events/, '42501');
  await rejects(by(db, guest, 'ev_save_event', null, { title: 'Party', starts_at: soon(60) }), /Only team members/, '42501');
});

let townHall;
await test('"everyone" invites every member (not guests); the creator hosts', async () => {
  townHall = await by(db, lead, 'ev_save_event', null, { title: 'Town hall', starts_at: soon(60), invite: { all: true } });
  assert.equal(townHall.host_id, lead);
  const ids = await invitees(townHall.id);
  for (const p of [admin, lead, ce, mia, max, zoe]) assert.ok(ids.includes(p), p);
  assert.ok(!ids.includes(guest));
});

let testDay;
await test('a division, a subsystem, a position or people: each invites just them', async () => {
  testDay = await by(db, lead, 'ev_save_event', null, { title: 'Battery test day', starts_at: soon(30), invite: { subsystems: [battery] } });
  assert.deepEqual(await invitees(testDay.id), [mia]);
  await by(db, lead, 'ev_save_event', testDay.id, { invite: { divisions: [elec] } });
  assert.deepEqual(await invitees(testDay.id), [mia, max]);
  await by(db, lead, 'ev_save_event', testDay.id, { invite: { roles: ['ce'], people: [zoe] } });
  assert.deepEqual((await invitees(testDay.id)).sort(), [ce, zoe].sort(), 'people who never answered drop off');
  await by(db, lead, 'ev_save_event', testDay.id, { invite: { divisions: [elec], people: [zoe] } });
  await rejects(by(db, lead, 'ev_save_event', testDay.id, { invite: {} }), /Choose who/);
});

await test('members see only events they\'re invited to; leads with "See attendance" see every event', async () => {
  const seen = async (u) => (await rowsAs(db, u, `select title from ev_events order by title`)).map((r) => r.title);
  assert.deepEqual(await seen(mia), ['Battery test day', 'Town hall']);
  assert.deepEqual(await seen(ce), ['Battery test day', 'Town hall']);
  const other = await by(db, ce, 'ev_save_event', null, { title: 'Aero social', starts_at: soon(90), invite: { divisions: [mech] } });
  assert.deepEqual(await seen(mia), ['Battery test day', 'Town hall']);
  assert.deepEqual(await seen(lead), ['Aero social', 'Battery test day', 'Town hall'], 'a lead sees every event');
  assert.deepEqual(await seen(guest), []);
  await by(db, ce, 'ev_delete_event', other.id);
});

await test('only the host, co-hosts or an Admin change an event; anyone else with "Create events" can\'t', async () => {
  await rejects(by(db, ce, 'ev_save_event', testDay.id, { title: 'Mine now' }), /host, its co-hosts or an Admin/, '42501');
  await by(db, lead, 'ev_save_event', testDay.id, { cohosts: [ce] });
  await by(db, ce, 'ev_save_event', testDay.id, { location: 'Shop' });
  await by(db, admin, 'ev_save_event', testDay.id, { notes: 'Bring gloves' });
  const e = (await db.query(`select location, notes from ev_events where id = $1`, [testDay.id])).rows[0];
  assert.deepEqual(e, { location: 'Shop', notes: 'Bring gloves' });
});

await test('RSVP: yes, maybe or no with a reason; members see only their own; not once cancelled', async () => {
  await by(db, mia, 'ev_rsvp', testDay.id, 'no', 'Exam that day');
  await by(db, max, 'ev_rsvp', testDay.id, 'yes', '');
  assert.equal((await rowsAs(db, mia, `select * from ev_rsvps`)).length, 1);
  assert.equal((await rowsAs(db, lead, `select * from ev_rsvps where event_id = $1`, [testDay.id])).length, 2);
  await rejects(by(db, guest, 'ev_rsvp', testDay.id, 'yes', ''), /Only team members/);
  await rejects(by(db, mia, 'ev_rsvp', testDay.id, 'perhaps', ''), /yes, maybe or no/);
});

await test('sign-in questions are cleaned up: ids, types, choices', async () => {
  const e = await by(db, lead, 'ev_save_event', testDay.id, { questions: [
    { id: 'role', label: 'What did you work on?', type: 'select', options: ['Cells', 'BMS', ' '], required: true },
    { label: 'Hours', type: 'number' },
    { label: 'Wore PPE', type: 'check', required: true },
    { label: '  ' },
  ] });
  assert.equal(e.questions.length, 3);
  assert.deepEqual(e.questions[0].options.sort(), ['BMS', 'Cells']);
  assert.ok(e.questions[1].id && e.questions[2].id);
  await rejects(by(db, lead, 'ev_save_event', testDay.id, { questions: [{ label: 'Pick', type: 'select', options: [] }] }), /needs at least one choice/);
  await rejects(by(db, lead, 'ev_save_event', testDay.id, { questions: [{ label: 'X', type: 'colour' }] }), /unknown type/);
});

await test('check-in: closed until the host opens it; the code is checked; the screen\'s code only for hosts', async () => {
  await rejects(by(db, mia, 'ev_check_in', testDay.id, 'ABCDEF', {}), /isn't open/);
  await rejects(by(db, mia, 'ev_set_checkin', testDay.id, true), /host/, '42501');
  await by(db, lead, 'ev_set_checkin', testDay.id, true);
  await rejects(by(db, mia, 'ev_checkin_code', testDay.id), /host/, '42501');
  const shown = await by(db, ce, 'ev_checkin_code', testDay.id);
  assert.match(shown.code, /^[0-9A-F]{6}$/);
  assert.equal(shown.code, await codeNow(testDay.id));
  await rejects(by(db, mia, 'ev_check_in', testDay.id, 'ZZZZZZ', {}), /didn't work/, 'OS403');
  await rejects(by(db, mia, 'ev_check_in', testDay.id, await codeNow(testDay.id, 5), {}), /didn't work/, 'OS403');
  // the members can't read the secret
  await rejects(rowsAs(db, mia, `select * from ev_secrets`), /permission denied/);
});

await test('required answers are needed; answers are kept; checking in twice just says so', async () => {
  const qs = (await db.query(`select questions from ev_events where id = $1`, [testDay.id])).rows[0].questions;
  const [role, hours, ppe] = qs.map((q) => q.id);
  await rejects(by(db, mia, 'ev_check_in', testDay.id, await codeNow(testDay.id), {}), /Please answer "What did you work on\?"/);
  await rejects(by(db, mia, 'ev_check_in', testDay.id, await codeNow(testDay.id), { [role]: 'Cells', [ppe]: false }), /Please tick "Wore PPE"/);
  await rejects(by(db, mia, 'ev_check_in', testDay.id, await codeNow(testDay.id), { [role]: 'Wheels', [ppe]: true }), /Pick one of the choices/);
  await rejects(by(db, mia, 'ev_check_in', testDay.id, await codeNow(testDay.id), { [role]: 'Cells', [ppe]: true, [hours]: 'lots' }), /needs a number/);
  const r = await by(db, mia, 'ev_check_in', testDay.id, (await codeNow(testDay.id, 1)).toLowerCase(), { [role]: 'Cells', [ppe]: true, [hours]: '3', extra: 'x' });
  assert.equal(r.status, 'in');
  assert.equal(r.late, false);
  const a = (await db.query(`select * from ev_attendance where event_id = $1 and user_id = $2`, [testDay.id, mia])).rows[0];
  assert.deepEqual(a.answers, { [role]: 'Cells', [hours]: 3, [ppe]: true });
  assert.equal(a.how, 'code');
  assert.equal(a.walk_in, false);
  assert.equal((await by(db, mia, 'ev_check_in', testDay.id, 'nope', {})).status, 'already');
});

await test('walk-ins: members not invited may check in (marked) unless the host turned that off', async () => {
  const qs = (await db.query(`select questions from ev_events where id = $1`, [testDay.id])).rows[0].questions;
  const ans = { [qs[0].id]: 'BMS', [qs[2].id]: true };
  // Lee (the host) isn't invited to his own test day: a walk-in
  await by(db, admin, 'ev_save_event', testDay.id, { allow_walkins: false });
  await rejects(by(db, lead, 'ev_check_in', testDay.id, await codeNow(testDay.id), ans), /aren't invited/);
  await by(db, admin, 'ev_save_event', testDay.id, { allow_walkins: true });
  const r = await by(db, lead, 'ev_check_in', testDay.id, await codeNow(testDay.id), ans);
  assert.equal(r.status, 'in');
  assert.equal((await db.query(`select walk_in from ev_attendance where event_id = $1 and user_id = $2`, [testDay.id, lead])).rows[0].walk_in, true);
  const info = await by(db, zoe, 'ev_checkin_info', testDay.id);
  assert.equal(info.open, true);
  assert.equal(info.invited, true);
  assert.equal(info.checked_in_at, null);
});

await test('late: after the event\'s "late after" minutes', async () => {
  const late = await by(db, lead, 'ev_save_event', null, { title: 'Workday', starts_at: soon(-20), late_after_min: 10, invite: { people: [max, zoe] } });
  await by(db, lead, 'ev_set_checkin', late.id, true);
  assert.equal((await by(db, max, 'ev_check_in', late.id, await codeNow(late.id), {})).late, true);
  await by(db, lead, 'ev_set_late', late.id, max, false);
  assert.equal((await db.query(`select late from ev_attendance where event_id = $1 and user_id = $2`, [late.id, max])).rows[0].late, false);
  await by(db, lead, 'ev_save_event', late.id, { late_after_min: 60 });
  await by(db, lead, 'ev_host_check_in', late.id, zoe, null, {});
  assert.equal((await db.query(`select late, how, by_name from ev_attendance where event_id = $1 and user_id = $2`, [late.id, zoe])).rows[0].late, false);
});

await test('the host checks people in by hand, undoes it, and puts it back; every change is logged with who', async () => {
  await by(db, ce, 'ev_host_check_in', testDay.id, max, null, {});
  await rejects(by(db, ce, 'ev_host_check_in', testDay.id, max, null, {}), /already checked in/, 'OS409');
  await rejects(by(db, mia, 'ev_host_check_in', testDay.id, zoe, null, {}), /host/, '42501');
  await rejects(by(db, ce, 'ev_host_check_in', testDay.id, guest, null, {}), /Only team members/);
  const a = (await db.query(`select how, by_name from ev_attendance where event_id = $1 and user_id = $2`, [testDay.id, max])).rows[0];
  assert.deepEqual(a, { how: 'host', by_name: 'Cara Chief' });
  const was = await by(db, ce, 'ev_remove_attendance', testDay.id, max);
  assert.equal((await db.query(`select 1 from ev_attendance where event_id = $1 and user_id = $2`, [testDay.id, max])).rows.length, 0);
  await by(db, ce, 'ev_restore_attendance', testDay.id, max, was);
  assert.equal((await db.query(`select how from ev_attendance where event_id = $1 and user_id = $2`, [testDay.id, max])).rows[0].how, 'host');
  const log = (await rowsAs(db, lead, `select action, actor_name from ev_log where event_id = $1 and user_id = $2 order by id`, [testDay.id, max]));
  assert.deepEqual(log.map((l) => l.action), ['checked_in', 'check_in_undone', 'check_in_restored']);
  assert.ok(log.every((l) => l.actor_name === 'Cara Chief'));
  assert.equal((await rowsAs(db, mia, `select * from ev_log`)).length, 0, 'members don\'t see the log');
});

await test('excused: invited people only, with a note; by hosts or anyone who sees attendance', async () => {
  await by(db, ce, 'ev_set_excused', townHall.id, zoe, true, 'Sick');
  const i = (await db.query(`select excused, excused_note, excused_by from ev_invitees where event_id = $1 and user_id = $2`, [townHall.id, zoe])).rows[0];
  assert.deepEqual(i, { excused: true, excused_note: 'Sick', excused_by: 'Cara Chief' });
  await rejects(by(db, mia, 'ev_set_excused', townHall.id, zoe, false, ''), /hosts or people who can see attendance/);
  await rejects(by(db, ce, 'ev_set_excused', townHall.id, guest, true, ''), /Only people who were invited/);
  // an excused person stays invited when the invite changes
  await by(db, lead, 'ev_save_event', townHall.id, { invite: { people: [mia] } });
  assert.ok((await invitees(townHall.id)).includes(zoe));
  await by(db, lead, 'ev_save_event', townHall.id, { invite: { all: true } });
});

await test('attendance: members see their own; hosts and leads see the event\'s', async () => {
  assert.deepEqual((await rowsAs(db, mia, `select user_id from ev_attendance`)).map((r) => r.user_id), [mia]);
  assert.ok((await rowsAs(db, lead, `select user_id from ev_attendance where event_id = $1`, [testDay.id])).length >= 3);
});

await test('new members join upcoming events\' invite lists; past events stay as they were', async () => {
  const past = await by(db, lead, 'ev_save_event', null, { title: 'Last month', starts_at: soon(-60 * 24 * 30), invite: { all: true } });
  const before = (await invitees(past.id)).length;
  const newbie = await person(db, 'new@ufl.edu', 'Nia New', ['member']);
  await by(db, newbie, 'ev_sync');
  assert.ok((await invitees(townHall.id)).includes(newbie));
  assert.equal((await invitees(past.id)).length, before, 'last month\'s list is kept as it was');
  assert.equal(before, 0, 'an event saved after it ended doesn\'t invite anyone');
});

await test('cancelling closes check-in and stops RSVPs; un-cancelling brings it back', async () => {
  const e = await by(db, lead, 'ev_save_event', townHall.id, { cancelled: true, cancel_note: 'Weather' });
  assert.ok(e.cancelled_at);
  await rejects(by(db, mia, 'ev_rsvp', townHall.id, 'yes', ''), /cancelled/);
  await rejects(by(db, lead, 'ev_set_checkin', townHall.id, true), /cancelled/);
  const back = await by(db, lead, 'ev_save_event', townHall.id, { cancelled: false });
  assert.equal(back.cancelled_at, null);
  assert.ok((await rowsAs(db, lead, `select action from ev_log where event_id = $1`, [townHall.id])).some((l) => l.action === 'cancelled'));
});

await test('categories and question sets: "Create events" holders edit them; members can\'t', async () => {
  const cats = (await rowsAs(db, mia, `select name from ev_categories where archived_at is null order by sort`)).map((r) => r.name);
  assert.deepEqual(cats, ['Town hall', 'Testing day', 'Workday', 'Outreach', 'Social', 'Other']);
  const c = await by(db, lead, 'ev_save_category', null, { name: 'Competition prep', color: 'red' });
  await rejects(by(db, lead, 'ev_save_category', null, { name: ' competition PREP ' }), /already a category/, 'OS412');
  await rejects(by(db, mia, 'ev_save_category', null, { name: 'Mine' }), /Create events/);
  await by(db, lead, 'ev_save_category', c.id, { archived: true });
  const t = await by(db, ce, 'ev_save_template', null, { name: 'Shop day', questions: [{ label: 'Hours', type: 'number' }] });
  assert.equal(t.questions[0].type, 'number');
  assert.equal((await rowsAs(db, mia, `select * from ev_templates`)).length, 0);
  assert.equal((await rowsAs(db, lead, `select * from ev_templates`)).length, 1);
});

await test('invitation emails go to the people newly invited, only when asked and notifications are on', async () => {
  await db.query(`insert into app_settings (key, value) values ('notifications', '{"enabled": true, "events": {}}') on conflict (key) do update set value = excluded.value`);
  const count = async () => (await db.query(`select count(*)::int c from notification_outbox where event = 'event_invite'`)).rows[0].c;
  const e = await by(db, lead, 'ev_save_event', null, { title: 'Outreach fair', starts_at: soon(600), location: 'Reitz', invite: { people: [mia] } });
  assert.equal(await count(), 0, 'not asked');
  await by(db, lead, 'ev_save_event', e.id, { invite: { people: [mia, max] }, notify: true });
  const rows = (await db.query(`select email, payload from notification_outbox where event = 'event_invite'`)).rows;
  assert.deepEqual(rows.map((r) => r.email), ['max@ufl.edu'], 'only the newly invited');
  assert.match(rows[0].payload.details, /Lee Lead invited you to Outreach fair on .* at Reitz/);
  assert.equal(rows[0].payload.app_path, `events/#/events/e/${e.id}`);
});

console.log(`\n${passed} passed`);
