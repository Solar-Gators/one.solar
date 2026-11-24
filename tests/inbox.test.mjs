/**
 * The home screen's "Waiting on you" (migration 067, my_inbox) and the Ctrl/⌘ + K search (066, search_everything):
 * each person sees only their own to-dos and only the queues their role works, and search finds only what row-level
 * security lets them read. Run as real users against PGlite with every migration loaded.
 *
 *   node tests/inbox.test.mjs
 */
import assert from 'node:assert/strict';
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
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}
const call = async (fn, ...args) =>
  (await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r;
const by = (uid, fn, ...args) => as(uid, () => call(fn, ...args));

let n = 0;
async function person(email, name, roles) {
  const id = `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`;
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, email, { full_name: name }]);
  await db.query(`delete from profile_roles where user_id = $1`, [id]);
  for (const r of roles) await db.query(`insert into profile_roles (user_id, role) values ($1, $2)`, [id, r]);
  return id;
}
const member = await person('mem@ufl.edu', 'Mel Member', ['member']);
const ce = await person('ce@ufl.edu', 'Cy Engineer', ['member', 'ce']);
const treasurer = await person('tres@ufl.edu', 'Tia Treasurer', ['member', 'treasurer']);
const coord = await person('coord@ufl.edu', 'Cory Coordinator', ['member', 'eboard', 'coordinator']);

const season = (await db.query(`select value ->> 'season' as s from app_settings where key = 'general'`)).rows[0].s;
const request = (num, title, status, owner) => db.query(
  `insert into requests (request_number, title, status, season, requester, created_by) values ($1, $2, $3, $4, 'x', $5)`, [num, title, status, season, owner]);
await request('SG27-901', 'Battery spot welder tips', 'Changes Requested', member);
await request('SG27-902', 'Spare fuses', 'Draft', member);
await request('SG27-903', 'Aero tape', 'Submitted', ce);
await request('SG27-904', 'Motor bearings', 'Approved', ce);
await db.query(`insert into sponsor_cards (name, stage, season, owner_id, follow_up) values
  ('Acme Volts', 'contacted', $1, $2, current_date - 2), ('Done Deal Co', 'thanked', $1, $2, current_date - 2), ('Later Inc', 'prospect', $1, $2, current_date + 9)`, [season, coord]);

const titles = (rows) => rows.map((r) => r.title);

await test('my own requests: sent back first (urgent), then drafts; nobody else sees them', async () => {
  const mine = await by(member, 'my_inbox');
  const req = mine.filter((r) => r.app === 'orders');
  assert.deepEqual(titles(req), ['Battery spot welder tips', 'Spare fuses']);
  assert.equal(req[0].urgent, true);
  assert.equal(req[0].href, 'orders/#/requests/SG27-901');
  assert.ok(!titles(await by(ce, 'my_inbox')).includes('Spare fuses'));
});

await test('queues go to whoever works them: approvals to a Chief Engineer, ordering to the Treasurer', async () => {
  const ceRows = (await by(ce, 'my_inbox')).filter((r) => r.kind === 'queue');
  assert.deepEqual(titles(ceRows), ['1 request to approve']);
  const tRows = (await by(treasurer, 'my_inbox')).filter((r) => r.kind === 'queue');
  assert.ok(titles(tRows).includes('1 approved request to order'));
  assert.equal((await by(member, 'my_inbox')).filter((r) => r.kind === 'queue').length, 0);
});

await test('sponsor follow-ups: due ones on open cards I lead; not closed cards, not future dates, not other people', async () => {
  const rows = (await by(coord, 'my_inbox')).filter((r) => r.app === 'sponsors');
  assert.deepEqual(titles(rows), ['Follow up with Acme Volts']);
  assert.equal(rows[0].urgent, true);
  assert.equal((await by(member, 'my_inbox')).filter((r) => r.app === 'sponsors').length, 0);
});

await test('signed out: nothing', async () => {
  assert.deepEqual(await by(null, 'my_inbox').catch(() => []), []);
});

await test('search finds requests by number or words, and sponsors only for people who can see Sponsors', async () => {
  const hit = await by(member, 'search_everything', 'sg27-903', 5);
  assert.deepEqual(hit.map((r) => [r.kind, r.id]), [['request', 'SG27-903']]);
  assert.ok((await by(coord, 'search_everything', 'acme', 5)).some((r) => r.kind === 'sponsor' && r.title === 'Acme Volts'));
  assert.equal((await by(member, 'search_everything', 'acme', 5)).filter((r) => r.kind === 'sponsor').length, 0);
  assert.deepEqual(await by(member, 'search_everything', 'a', 5), []);   // too short
});

console.log(`\n${passed} passed`);
