/**
 * SGAA page helpers (sgaa/lib.js): safe formatting, money, dates, events.
 *
 *   node tests/sgaaLib.test.mjs
 */
import assert from 'node:assert/strict';
import { esc, formatText, money, ago, splitEvents, spotsLeft, fileSlug, toLocalInput, fromLocalInput, isSchoolEmail, joinProblems } from '../sgaa/lib.js';
import { isSafeNext } from '../shared/safe-next.js';

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

console.log('SGAA helpers');

test('formatText: paragraphs, bullets, headings, bold, italic and https links', () => {
  const html = formatText('## Why\nWe need **cells** and *help*.\nSecond line\n\n- one\n- two\n\nSee [our site](https://ufsolargators.org).');
  assert.equal(html, '<h3>Why</h3><p>We need <strong>cells</strong> and <em>help</em>.<br>Second line</p><ul><li>one</li><li>two</li></ul>'
    + '<p>See <a href="https://ufsolargators.org" target="_blank" rel="noopener noreferrer">our site</a>.</p>');
});

test('formatText lets no HTML or script links through', () => {
  const html = formatText('<img src=x onerror=alert(1)> [x](javascript:alert(1)) [y](http://plain.example) "quotes"');
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('href="javascript'));
  assert.ok(!html.includes('href="http://'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('&quot;quotes&quot;'));
  assert.equal(formatText(''), '');
  assert.equal(formatText(null), '');
});

test('esc escapes the five HTML characters', () => {
  assert.equal(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(esc(undefined), '');
});

test('money: whole dollars without cents, cents when there are some, blank when unknown', () => {
  assert.equal(money(4800), '$4,800');
  assert.equal(money('12.5'), '$12.50');
  assert.equal(money(null), '');
  assert.equal(money(''), '');
  assert.equal(money('lots'), '');
  assert.equal(money(0), '$0');
});

test('ago: today, yesterday, days, then a date', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  assert.equal(ago('2026-11-17T08:00:00Z', now), 'today');
  assert.equal(ago('2026-11-16T08:00:00Z', now), 'yesterday');
  assert.equal(ago('2026-11-10T08:00:00Z', now), '7 days ago');
  assert.match(ago('2026-08-01T08:00:00Z', now), /Aug 1, 2026/);
});

test('events split into upcoming (soonest first) and past (latest first); an event in progress is upcoming', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const ev = [
    { id: 'past', startsAt: '2026-10-01T18:00:00Z' },
    { id: 'later', startsAt: '2026-12-20T18:00:00Z' },
    { id: 'now', startsAt: '2026-11-17T10:00:00Z', endsAt: '2026-11-17T14:00:00Z' },
    { id: 'older', startsAt: '2026-09-01T18:00:00Z' },
  ];
  const { upcoming, past } = splitEvents(ev, now);
  assert.deepEqual(upcoming.map((e) => e.id), ['now', 'later']);
  assert.deepEqual(past.map((e) => e.id), ['past', 'older']);
});

test('spots left: blank without a limit, never below zero', () => {
  assert.equal(spotsLeft({ capacity: null, going: 3 }), '');
  assert.equal(spotsLeft({ capacity: 10, going: 3 }), 7);
  assert.equal(spotsLeft({ capacity: 2, going: 5 }), 0);
});

test('file names for Storage match what the database accepts', () => {
  const ok = (n) => /^[A-Za-z0-9._-]{1,120}$/.test(n);
  for (const [name, want] of [['My Photo (1).JPG', 'my-photo-1.jpg'], ['ünïcödé.png', 'unicode.png'], ['', 'photo.jpg'], ['.png', 'photo.png']]) {
    const got = fileSlug(name.normalize('NFKD').replace(/[̀-ͯ]/g, ''));
    assert.equal(got, want);
    assert.ok(ok(got));
  }
  assert.ok(ok(fileSlug('x'.repeat(300) + '.jpeg')));
});

test('datetime-local round trip', () => {
  const iso = new Date(2026, 10, 27, 18, 30).toISOString();
  assert.equal(toLocalInput(iso), '2026-11-27T18:30');
  assert.equal(fromLocalInput('2026-11-27T18:30'), iso);
  assert.equal(toLocalInput(null), '');
  assert.equal(fromLocalInput(''), '');
});

test('UF addresses (which UF turns off after graduation) are spotted, others aren\'t', () => {
  for (const e of ['gator@ufl.edu', 'A.B@UFL.EDU', 'x@eng.ufl.edu', ' x@ufl.edu ']) assert.ok(isSchoolEmail(e), e);
  for (const e of ['x@gmail.com', 'x@ufl.edu.evil.com', 'x@notufl.edu', '', null]) assert.ok(!isSchoolEmail(e), String(e));
});

test('the join form asks for a graduation year (and, signing up, a name, an email and a password)', () => {
  const now = new Date(2026, 10, 17);
  assert.deepEqual(joinProblems({ gradYear: '2019' }, { now }), []);
  assert.deepEqual(joinProblems({ gradYear: '' }, { now }), ['What year did you graduate (or leave the team)?']);
  assert.deepEqual(joinProblems({ gradYear: '19' }, { now }), ['Graduation year has to be a year, like 2024.']);
  assert.deepEqual(joinProblems({ gradYear: '2028' }, { now }), ['Graduation year has to be a year, like 2024.']);
  assert.deepEqual(joinProblems({ gradYear: '2027' }, { now }), []); // graduating this coming year
  assert.equal(joinProblems({ gradYear: '2019' }, { signUp: true, now }).length, 3);
  assert.deepEqual(joinProblems({ fullName: 'A', email: 'a@gmail.com', password: '12345678', gradYear: '2019' }, { signUp: true, now }), []);
  // A UF address is allowed (they're asked to switch later), not refused.
  assert.deepEqual(joinProblems({ fullName: 'A', email: 'a@ufl.edu', password: '12345678', gradYear: '2019' }, { signUp: true, now }), []);
});

test('after signing in, only pages on this site (with an app page after #) are gone back to', () => {
  for (const ok of ['/', '/sgaa/', '/one.solar/sgaa/', '/sgaa/#/join', '/sgaa/#/contact?to=1f2e&need=9a', '/sgaa/#/events']) assert.ok(isSafeNext(ok), ok);
  for (const bad of ['//evil.example', 'https://evil.example/', '/\\evil.example', 'javascript:alert(1)', '/sgaa/#/x"onload', '/a b', '', null, '/sgaa/?x=1']) {
    assert.ok(!isSafeNext(bad), String(bad));
  }
});

console.log(`\n${passed} passed`);
