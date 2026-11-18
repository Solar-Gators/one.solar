/**
 * SGAA database tests (migration 052): the alumni hub's rules, run as real users (and signed out) against
 * PGlite with every migration loaded, the way tests/inventory.test.mjs does.
 *
 *   node tests/sgaa.test.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb } from './support/supabase-stub.mjs';

const db = await freshDb();

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

async function as(uid, fn) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid || '']);
  await db.exec(uid ? 'set role authenticated' : 'set role anon');
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
  }
}
async function rejects(promise, pattern) {
  try {
    await promise;
  } catch (err) {
    if (pattern) assert.match(`${err.message} ${err.detail || ''}`, pattern);
    return err;
  }
  throw new Error(`expected an error matching ${pattern}`);
}
const call = async (fn, ...args) =>
  (await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r;
const by = (uid, fn, ...args) => as(uid, () => call(fn, ...args));
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;
const rowsAs = (uid, sql, params = []) => as(uid, () => all(sql, params));

let n = 0;
async function person(email, name, roles = ['member'], confirmed = true) {
  const id = `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`;
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, email, { full_name: name, ...(email.endsWith('@ufl.edu') ? {} : { sgaa: 'alum' }) }]);
  if (!confirmed) await db.query(`update auth.users set email_confirmed_at = null where id = $1`, [id]);
  if (roles.length) {
    await db.query(`delete from profile_roles where user_id = $1`, [id]);
    for (const r of roles) await db.query(`insert into profile_roles (user_id, role) values ($1, $2)`, [id, r]);
  }
  return id;
}

const admin = await person('sg-admin@ufl.edu', 'Ada Admin', ['admin']);
const coord = await person('sg-coord@ufl.edu', 'Cory Coordinator', ['coordinator']);
const ce = await person('sg-ce@ufl.edu', 'Cara Chief', ['ce']);
const member = await person('sg-member@ufl.edu', 'Mia Member');
const senior = await person('sam.senior@gmail.com', 'Sam Senior');
const leaver = await person('sg-leaver@ufl.edu', 'Lee Leaver');
const oldAlum = await person('old.alum@gmail.com', 'Olivia Oldtimer', []); // signed up as a Guest
const unconfirmed = await person('new.alum@gmail.com', 'Nate New', [], false);
const stranger = await person('someone@gmail.com', 'Stan Stranger', []);
const student = await person('new.student@ufl.edu', 'Nia Newstudent', []); // an ordinary sign-up: a Guest waiting for the team

const hub = (uid) => by(uid, 'sgaa_hub');
/** Change some settings, as an Admin does on the site (update_settings saves the whole object). */
const setSettings = async (key, patch) =>
  by(admin, 'update_settings', key, { ...(await one(`select value from app_settings where key = $1`, [key])).value, ...patch });

// ---- permissions ---------------------------------------------------------------------------------
console.log('Permissions');

await test('defaults: CEs edit and approve alumni; E-board, Business Coordinator and Admin also read every message', async () => {
  const perms = async (role) => (await all(`select permission from role_permissions where role = $1 and permission like 'sgaa.%' order by 1`, [role])).map((r) => r.permission);
  assert.deepEqual(await perms('ce'), ['sgaa.alumni', 'sgaa.edit']);
  for (const r of ['eboard', 'coordinator', 'admin']) assert.deepEqual(await perms(r), ['sgaa.alumni', 'sgaa.edit', 'sgaa.messages'], r);
  for (const r of ['member', 'treasurer', 'guest', 'alumni']) assert.deepEqual(await perms(r), [], r);
  assert.equal((await one(`select count(*)::int n from permissions where key like 'sgaa.%'`)).n, 3);
});

await test('the hub works signed out, says who is looking, and offers editing only to editors', async () => {
  const pub = await hub(null);
  assert.equal(pub.viewer, 'anon');
  assert.equal(pub.canEdit, false);
  assert.match(pub.settings.howToHelp, /ways to help/);
  assert.equal((await hub(member)).viewer, 'team');
  assert.equal((await hub(member)).canEdit, false);
  assert.equal((await hub(coord)).canEdit, true);
  assert.equal((await hub(student)).viewer, 'guest');
  assert.equal((await hub(stranger)).viewer, 'pending', 'signing up on "Join as an alum" starts a request');
});

await test('alumni sign-ups wait in SGAA, not in the team\'s "waiting to join" list (until declined as an alum)', async () => {
  const waiting = async () => (await rowsAs(ce, `select full_name from waiting_people() order by full_name`)).map((r) => r.full_name);
  assert.deepEqual(await waiting(), ['Nia Newstudent']);
  const queue = (await rowsAs(ce, `select full_name, grad_year from sgaa_alumni_queue() order by full_name`)).map((r) => [r.full_name, r.grad_year]);
  assert.deepEqual(queue, [['Nate New', null], ['Olivia Oldtimer', null], ['Stan Stranger', null]], 'details come later, from the join page');
  const guestNow = randomUUID();
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'decline.me@gmail.com', '{"full_name": "Dee Clined", "sgaa": "alum"}')`, [guestNow]);
  await by(ce, 'sgaa_review_alum', guestNow, false, 'Not on our rosters');
  assert.deepEqual(await waiting(), ['Dee Clined', 'Nia Newstudent'], 'declined as an alum: back in the team\'s list');
  await db.query(`delete from auth.users where id = $1`, [guestNow]);
});

await test('nobody can write the SGAA tables directly, signed in or not', async () => {
  for (const uid of [null, admin]) {
    await as(uid, () => rejects(db.query(`insert into sgaa_needs (title) values ('x')`), /permission denied/));
    await as(uid, () => rejects(db.query(`update sgaa_alumni set status = 'alum'`), /permission denied/));
    await as(uid, () => rejects(db.query(`insert into sgaa_messages (from_name, from_email, to_name, subject, body) values ('a','b','c','d','e')`), /permission denied/));
  }
});

// ---- needs -----------------------------------------------------------------------------------------
console.log('Needs');

let contact, cells, carbon;
await test('editors add contacts (team members only) and needs; members can\'t', async () => {
  contact = await by(coord, 'sgaa_save_contact', null, { userId: coord, title: 'Business Coordinator', blurb: 'Sponsorships and giving', topics: ['giving', ' ', 'sponsors'] });
  assert.deepEqual((await one(`select topics from sgaa_contacts where id = $1`, [contact])).topics, ['giving', 'sponsors']);
  await as(coord, () => rejects(call('sgaa_save_contact', null, { userId: stranger, title: 'Nope' }), /have to be on the team/));
  await as(member, () => rejects(call('sgaa_save_contact', null, { userId: member, title: 'Me' }), /needs "Edit the alumni hub"/));

  cells = await by(ce, 'sgaa_save_need', null, { title: 'Battery cells', summary: 'For the new pack', cost: '4800', quantity: 'about 400 cells',
    subsystem: 'Battery', urgency: 'high', contactId: contact, status: 'open' });
  carbon = await by(ce, 'sgaa_save_need', null, { title: 'Carbon fiber', status: 'draft' });
  await as(member, () => rejects(call('sgaa_save_need', null, { title: 'x' }), /needs "Edit the alumni hub"/));
  await as(ce, () => rejects(call('sgaa_save_need', null, { title: 'x', cost: 'lots' }), /rough cost has to be a number/));
  await as(ce, () => rejects(call('sgaa_save_need', null, { title: '   ' }), /title/));
  const row = await one(`select * from sgaa_needs where id = $1`, [cells]);
  assert.equal(Number(row.cost_estimate), 4800);
  assert.ok(row.published_at, 'publishing an open need stamps it');
});

await test('the public sees open needs (and recently met ones), never drafts; editors see drafts', async () => {
  const titles = (h) => h.needs.map((x) => x.title);
  assert.deepEqual(titles(await hub(null)), ['Battery cells']);
  assert.deepEqual((await rowsAs(null, `select title from sgaa_needs`)).map((r) => r.title), ['Battery cells']);
  assert.deepEqual((await rowsAs(member, `select title from sgaa_needs`)).map((r) => r.title), ['Battery cells']);
  assert.equal((await rowsAs(ce, `select title from sgaa_needs`)).length, 2);

  await by(ce, 'sgaa_save_need', cells, { status: 'met', metNote: 'Thanks to a 2019 alum' });
  const met = (await hub(null)).needs.find((x) => x.title === 'Battery cells');
  assert.equal(met.status, 'met');
  assert.ok(met.metAt);
  await by(ce, 'sgaa_save_need', cells, { status: 'open' });
  assert.equal((await one(`select met_at from sgaa_needs where id = $1`, [cells])).met_at, null, 'reopening clears met');
});

await test('contacts on the public page: titles for everyone, names only for alumni and the team, never an email', async () => {
  const pub = (await hub(null)).contacts[0];
  assert.equal(pub.title, 'Business Coordinator');
  assert.equal(pub.name, null);
  assert.equal((await hub(member)).contacts[0].name, 'Cory Coordinator');
  assert.ok(!JSON.stringify(await hub(member)).includes('sg-coord@ufl.edu'));
  assert.equal((await rowsAs(member, `select * from sgaa_contacts`)).length, 0, 'the table itself is for editors');
});

await test('deleting a draft removes it; deleting a published need archives it', async () => {
  await by(ce, 'sgaa_delete_need', carbon);
  assert.equal(await one(`select 1 from sgaa_needs where id = $1`, [carbon]), undefined);
  const temp = await by(ce, 'sgaa_save_need', null, { title: 'Temp', status: 'open' });
  await by(ce, 'sgaa_delete_need', temp);
  assert.equal((await one(`select status from sgaa_needs where id = $1`, [temp])).status, 'archived');
  assert.ok(!(await hub(null)).needs.some((x) => x.title === 'Temp'));
});

// ---- updates, events, settings --------------------------------------------------------------------
console.log('Updates, events and the hub\'s words');

let post, meetup;
await test('updates: drafts stay with editors; photos must be SGAA uploads; published ones are public', async () => {
  const img = `updates/${randomUUID()}/pack.jpg`;
  post = await by(coord, 'sgaa_save_update', null, { title: 'Pack is built', body: 'Thanks **everyone**', needId: cells, images: [{ path: img, caption: 'The pack' }] });
  assert.equal((await hub(null)).updates.length, 0);
  assert.equal((await rowsAs(null, `select * from sgaa_update_images`)).length, 0);
  await by(coord, 'sgaa_save_update', post, { published: true });
  const u = (await hub(null)).updates[0];
  assert.equal(u.author, 'Cory Coordinator');
  assert.deepEqual(u.images, [{ path: img, caption: 'The pack' }]);
  assert.equal((await rowsAs(null, `select * from sgaa_update_images`)).length, 1);
  await as(coord, () => rejects(call('sgaa_save_update', post, { images: [{ path: 'https://evil.example/x.jpg' }] }), /wasn't uploaded to SGAA/));
});

await test('events: publish, RSVP with guests up to capacity, and no deleting once people RSVP', async () => {
  const start = new Date(Date.now() + 7 * 864e5).toISOString();
  meetup = await by(coord, 'sgaa_save_event', null, { title: 'Alumni BBQ', startsAt: start, capacity: '4', published: true });
  await as(coord, () => rejects(call('sgaa_save_event', null, { title: 'No date' }), /When does it start/));
  await as(coord, () => rejects(call('sgaa_save_event', meetup, { endsAt: new Date(Date.now()).toISOString() }), /can't end before it starts/));
  await as(null, () => rejects(call('sgaa_rsvp', meetup, true, 0, ''), /permission denied|Sign in/));
  await as(student, () => rejects(call('sgaa_rsvp', meetup, true, 0, ''), /for Solar Gators alumni and the team/));
  assert.equal(await by(member, 'sgaa_rsvp', meetup, true, 2, 'Bringing family'), 3);
  await as(ce, () => rejects(call('sgaa_rsvp', meetup, true, 1, ''), /it's full \(3 of 4/));
  assert.equal(await by(ce, 'sgaa_rsvp', meetup, true, 0, ''), 4);
  assert.equal(await by(member, 'sgaa_rsvp', meetup, true, 0, ''), 2, 'changing guests updates the RSVP');
  const ev = (await hub(member)).events[0];
  assert.equal(ev.going, 2);
  assert.deepEqual(ev.mine, { guests: 0, note: '' });
  assert.equal((await hub(null)).events[0].mine, null);
  assert.equal((await rowsAs(member, `select * from sgaa_rsvps`)).length, 1, 'members see only their own RSVP');
  const list = await rowsAs(coord, `select full_name, guests, note, alum from sgaa_event_rsvps($1) order by full_name`, [meetup]);
  assert.deepEqual(list.map((r) => [r.full_name, r.guests, r.alum]), [['Cara Chief', 0, false], ['Mia Member', 0, false]]);
  await as(member, () => rejects(call('sgaa_event_rsvps', meetup), /Edit the alumni hub/));
  await as(coord, () => rejects(call('sgaa_delete_event', meetup), /Cancel the event instead/));
  await by(coord, 'sgaa_save_event', meetup, { cancelled: true });
  await as(ce, () => rejects(call('sgaa_rsvp', meetup, false, 0, '').then(() => call('sgaa_rsvp', meetup, true, 0, '')), /was cancelled/));
});

await test('the hub\'s words: editors save them; the giving link must be https', async () => {
  await by(coord, 'sgaa_save_settings', { intro: 'Hello alumni', giveUrl: 'https://give.ufl.edu/solar' });
  const s = (await hub(null)).settings;
  assert.equal(s.intro, 'Hello alumni');
  assert.equal(s.giveUrl, 'https://give.ufl.edu/solar');
  assert.match(s.howToHelp, /ways to help/, 'fields not sent are kept');
  await as(coord, () => rejects(call('sgaa_save_settings', { giveUrl: 'javascript:alert(1)' }), /https:\/\//));
  await as(member, () => rejects(call('sgaa_save_settings', { intro: 'x' }), /Edit the alumni hub/));
});

// ---- becoming an alum ------------------------------------------------------------------------------
console.log('Alumni');

await test('graduating: deactivated as a former member, but marked as an alum and still allowed to sign in', async () => {
  await as(member, () => rejects(call('graduate_person', senior, ''), /does not allow this action \(users\.manage\)/));
  await by(admin, 'graduate_person', senior, 'Graduated Spring 2026');
  assert.deepEqual((await all(`select role from profile_roles where user_id = $1`, [senior])).map((r) => r.role), ['alumni']);
  assert.equal((await one(`select banned_until from auth.users where id = $1`, [senior])).banned_until, null);
  assert.equal((await hub(senior)).viewer, 'alum');
  // Still none of the team's data.
  assert.equal((await rowsAs(senior, `select * from requests`)).length, 0);
  assert.equal((await one(`select via, note from role_changes where target_id = $1 order by changed_at desc limit 1`, [senior])).note, 'Graduated Spring 2026');
});

await test('deactivating for another reason still blocks sign-in and gives no SGAA access', async () => {
  await by(admin, 'deactivate_person', leaver, 'Left the team');
  assert.ok((await one(`select banned_until from auth.users where id = $1`, [leaver])).banned_until);
  assert.equal((await hub(leaver)).viewer, 'former');
  await as(leaver, () => rejects(call('sgaa_send_message', contact, null, 'Hi', 'Hello'), /for Solar Gators alumni and the team/));
  // Later marked as an alum (someone deactivated before SGAA existed), then taken back.
  await by(admin, 'sgaa_set_alum', leaver, true);
  assert.equal((await one(`select banned_until from auth.users where id = $1`, [leaver])).banned_until, null);
  assert.equal((await hub(leaver)).viewer, 'alum');
  await by(admin, 'sgaa_set_alum', leaver, false);
  assert.ok((await one(`select banned_until from auth.users where id = $1`, [leaver])).banned_until);
  await as(admin, () => rejects(call('sgaa_set_alum', member, true), /Only former members/));
  await as(member, () => rejects(call('sgaa_set_alum', leaver, true), /does not allow this action \(users\.manage\)/));
});

await test('sign-ups: a personal email only from SGAA (and only while Admins allow it); email changes reach the profile', async () => {
  const ins = (id, email, meta) => db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, email, meta]);
  await rejects(ins(randomUUID(), 'x@yahoo.com', { full_name: 'X' }), /Sign-ups are limited to @ufl.edu/);
  await setSettings('general', { alumniCanSignUp: false });
  await rejects(ins(randomUUID(), 'y@yahoo.com', { full_name: 'Y', sgaa: 'alum' }), /Sign-ups are limited/);
  const general = (await one(`select value from app_settings where key = 'general'`)).value;
  await as(ce, () => rejects(call('update_settings', 'general', { ...general, alumniCanSignUp: true }), /Only an Admin can change whether alumni/));
  await setSettings('general', { alumniCanSignUp: true });
  // A graduate moves off their UF address: notices follow.
  await db.query(`update auth.users set email = 'sam.senior@gmail.com' where id = $1`, [senior]);
  assert.equal((await one(`select email from profiles where id = $1`, [senior])).email, 'sam.senior@gmail.com');
});

await test('an alum who never had an account asks; an approver says yes; they become an alum, not a team member', async () => {
  await as(oldAlum, () => rejects(call('sgaa_request_alum', { note: 'Battery lead 2012' }), /What year/));
  await by(oldAlum, 'sgaa_request_alum', { gradYear: '2013', note: 'Battery lead 2012', teamRoles: 'Battery lead', employer: 'Tesla' });
  assert.equal((await hub(oldAlum)).viewer, 'pending');
  await as(oldAlum, () => rejects(call('sgaa_directory'), /waiting to be approved/));
  await as(member, () => rejects(call('sgaa_request_alum', { gradYear: '2026' }), /on the team already/));

  const queue = await rowsAs(coord, `select * from sgaa_alumni_queue() order by full_name`);
  assert.deepEqual(queue.map((q) => [q.full_name, q.grad_year, q.note]), [['Nate New', null, ''], ['Olivia Oldtimer', 2013, 'Battery lead 2012'], ['Stan Stranger', null, '']]);
  await as(member, () => rejects(call('sgaa_alumni_queue'), /Approve alumni/));
  assert.equal((await rowsAs(member, `select * from sgaa_alumni`)).length, 0);

  await by(coord, 'sgaa_review_alum', oldAlum, true, '');
  assert.deepEqual((await all(`select role from profile_roles where user_id = $1`, [oldAlum])).map((r) => r.role), ['alumni']);
  assert.equal((await hub(oldAlum)).viewer, 'alum');
  assert.equal((await rowsAs(oldAlum, `select * from requests`)).length, 0);
  await by(coord, 'sgaa_review_alum', oldAlum, true, ''); // twice is fine
});

await test('approvers can decline; unconfirmed emails can\'t be approved', async () => {
  await by(unconfirmed, 'sgaa_request_alum', { gradYear: 2020 });
  await as(coord, () => rejects(call('sgaa_review_alum', unconfirmed, true, ''), /confirmed their email/));
  await by(stranger, 'sgaa_request_alum', { gradYear: 2015 });
  await by(coord, 'sgaa_review_alum', stranger, false, 'We couldn\'t find you on old rosters');
  assert.equal((await hub(stranger)).viewer, 'guest');
  assert.equal((await by(stranger, 'sgaa_my_profile')).reviewNote, 'We couldn\'t find you on old rosters');
});

await test('reactivating an alum puts them back on the team and out of the alumni list', async () => {
  await by(admin, 'reactivate_person', senior, []);
  assert.equal((await hub(senior)).viewer, 'team');
  assert.equal((await one(`select status from sgaa_alumni where user_id = $1`, [senior])).status, null);
  await by(admin, 'graduate_person', senior, ''); // and graduate again for the next tests
  assert.equal((await hub(senior)).viewer, 'alum');
});

// ---- directory -------------------------------------------------------------------------------------
console.log('Directory');

await test('each field follows its owner\'s setting: all, team only, or hidden; email is hidden by default', async () => {
  await by(senior, 'sgaa_save_profile', { gradYear: 2026, employer: 'SpaceX', city: 'Austin', linkedin: 'https://www.linkedin.com/in/sam',
    visibility: { city: 'team', employer: 'all', linkedin: 'hidden', nonsense: 'all' } });
  await as(senior, () => rejects(call('sgaa_save_profile', { linkedin: 'https://evil.example' }), /linkedin\.com/));
  await as(senior, () => rejects(call('sgaa_save_profile', { visibility: { city: 'world' } }), /Unknown privacy/));
  const find = (rows) => rows.find((r) => r.full_name === 'Sam Senior');
  const byAlum = find(await rowsAs(oldAlum, `select * from sgaa_directory()`));
  assert.deepEqual([byAlum.employer, byAlum.city, byAlum.linkedin, byAlum.email], ['SpaceX', '', '', '']);
  const byTeam = find(await rowsAs(member, `select * from sgaa_directory()`));
  assert.deepEqual([byTeam.employer, byTeam.city, byTeam.linkedin], ['SpaceX', 'Austin', '']);
  const self = find(await rowsAs(senior, `select * from sgaa_directory()`));
  assert.deepEqual([self.city, self.linkedin, self.email, self.me], ['Austin', 'https://www.linkedin.com/in/sam', 'sam.senior@gmail.com', true]);
  await as(null, () => rejects(call('sgaa_directory'), /permission denied|Sign in/));
  await as(stranger, () => rejects(call('sgaa_directory'), /for Solar Gators alumni/));
});

await test('only alums are listed (not pending, declined, or team members who filled in a card early), and unlisting hides you', async () => {
  await by(member, 'sgaa_save_profile', { gradYear: 2027, employer: 'Intern at NASA' });
  const names = async () => (await rowsAs(member, `select full_name from sgaa_directory()`)).map((r) => r.full_name).sort();
  assert.deepEqual(await names(), ['Olivia Oldtimer', 'Sam Senior']);
  await by(oldAlum, 'sgaa_save_profile', { listed: false });
  assert.deepEqual(await names(), ['Sam Senior']);
});

// ---- messages --------------------------------------------------------------------------------------
console.log('Messages');

await test('an alum messages a contact: logged, emailed with reply-to the alum, and visible only to the right people', async () => {
  await setSettings('notifications', { enabled: true });
  await as(null, () => rejects(call('sgaa_send_message', contact, null, 'Hi', 'Hello'), /permission denied|Sign in/));
  await as(senior, () => rejects(call('sgaa_send_message', contact, null, 'Hi', '   '), /Write a message/));
  const id = await by(senior, 'sgaa_send_message', null, cells, '', 'I can get cells at cost.');
  const msg = await one(`select * from sgaa_messages where id = $1`, [id]);
  assert.deepEqual([msg.to_id, msg.need_title, msg.subject, msg.emailed], [coord, 'Battery cells', 'About: Battery cells', true],
    'with no contact chosen, it goes to the need\'s contact');
  const out = await one(`select * from notification_outbox where event = 'sgaa_message' order by id desc limit 1`);
  assert.equal(out.email, 'sg-coord@ufl.edu');
  assert.equal(out.payload.reply_to, 'sam.senior@gmail.com');
  assert.equal(out.payload.from_kind, 'an alum');

  assert.equal((await rowsAs(senior, `select * from sgaa_messages`)).length, 1, 'the sender');
  assert.equal((await rowsAs(coord, `select * from sgaa_messages`)).length, 1, 'the recipient');
  assert.equal((await rowsAs(ce, `select * from sgaa_messages`)).length, 0, 'an editor without "See alumni messages"');
  assert.equal((await rowsAs(admin, `select * from sgaa_messages`)).length, 1, 'with "See alumni messages"');
  assert.equal((await rowsAs(oldAlum, `select * from sgaa_messages`)).length, 0, 'another alum');
});

await test('messages are rate limited, and a contact who left the team can\'t be messaged', async () => {
  for (let i = 0; i < 4; i++) await by(senior, 'sgaa_send_message', contact, null, `Hi ${i}`, 'Hello');
  await as(senior, () => rejects(call('sgaa_send_message', contact, null, 'Again', 'Hello'), /wait a little/));
  const ce2 = await by(coord, 'sgaa_save_contact', null, { userId: ce, title: 'Chief Engineer' });
  await by(admin, 'deactivate_person', ce, 'Left');
  await as(oldAlum, () => rejects(call('sgaa_send_message', ce2, null, 'Hi', 'Hello'), /isn't a contact anymore/));
  assert.ok(!(await hub(oldAlum)).contacts.some((c) => c.id === ce2), 'and they drop off the public list');
  await by(admin, 'reactivate_person', ce, ['ce']);
});

await test('with email off, the message is still logged (not emailed)', async () => {
  await setSettings('notifications', { enabled: false });
  const id = await by(oldAlum, 'sgaa_send_message', contact, null, 'Mentoring', 'Happy to help with BMS.');
  assert.equal((await one(`select emailed from sgaa_messages where id = $1`, [id])).emailed, false);
});

// ---- Projects --------------------------------------------------------------------------------------
console.log('Projects');

await test('sharing a work item makes a linked need: open for editors, a draft for anyone else who can edit it', async () => {
  const proj = await by(admin, 'pm_save_project', null, { key: 'ARR', name: 'Array' });
  const type = (await one(`select id from pm_types where project_id = $1 order by sort limit 1`, [proj.id])).id;
  const item = await by(admin, 'pm_create_item', randomUUID(), { project_id: proj.id, type_id: type, title: 'Encapsulation film', description: 'We need   about 20 m' });
  await as(member, () => rejects(call('sgaa_share_from_projects', proj.id, item.id, true), /can't share this/));
  await as(senior, () => rejects(call('sgaa_share_from_projects', proj.id, item.id, true), /can't share this/));

  const need = await by(ce, 'sgaa_share_from_projects', null, item.id, true);
  const row = await one(`select * from sgaa_needs where id = $1`, [need]);
  assert.deepEqual([row.title, row.summary, row.status, row.pm_project_id], ['Encapsulation film', 'We need about 20 m', 'open', proj.id]);
  assert.equal(await by(ce, 'sgaa_share_from_projects', null, item.id, true), need, 'sharing again is the same need');
  assert.deepEqual(await by(ce, 'sgaa_shared_from_projects', proj.id, item.id), { id: need, status: 'open' });
  assert.equal(await by(senior, 'sgaa_shared_from_projects', proj.id, item.id), null, 'alumni don\'t see Projects');
  assert.equal((await hub(null)).needs.find((x) => x.id === need).project, 'Array');

  // Done in Projects → met in SGAA; reopened → open.
  await db.query(`update pm_items set category = 'done' where id = $1`, [item.id]);
  assert.equal((await one(`select status from sgaa_needs where id = $1`, [need])).status, 'met');
  await db.query(`update pm_items set category = 'doing' where id = $1`, [item.id]);
  assert.equal((await one(`select status from sgaa_needs where id = $1`, [need])).status, 'open');

  // Turned off: archived (it was public).
  assert.equal(await by(ce, 'sgaa_share_from_projects', null, item.id, false), null);
  assert.equal((await one(`select status from sgaa_needs where id = $1`, [need])).status, 'archived');
  assert.equal(await by(ce, 'sgaa_shared_from_projects', proj.id, item.id), null);
});

// ---- the website ----------------------------------------------------------------------------------
console.log('What the website may call');

await test('signed out, only sgaa_hub() (no other SGAA function) can be called', async () => {
  const anon = (await all(`select p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public' and p.proname like 'sgaa%' and has_function_privilege('anon', p.oid, 'execute') order by 1`)).map((r) => r.proname);
  assert.deepEqual(anon, ['sgaa_hub']);
  const internal = ['sgaa_text', 'sgaa_require', 'sgaa_require_insider', 'sgaa_make_alum', 'sgaa_shows', 'sgaa_alum_rejoined', 'sgaa_item_changed'];
  const exposed = (await all(`select p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public' and p.proname = any($1) and has_function_privilege('authenticated', p.oid, 'execute')`, [internal])).map((r) => r.proname);
  assert.deepEqual(exposed, []);
});

console.log(`\n${passed} passed`);
await db.close();
