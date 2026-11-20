/**
 * Events (064), clicked through like a person would, on the fake backend:
 *   a Subsystem Lead makes a testing day for the Electrical division with two sign-in questions; a member sees it
 *   in My events and says they're going; the lead opens the check-in screen (QR code + typed code); the member
 *   follows the QR code's link, answers and taps "I'm here" (an old code asks for the one on the screen); the
 *   lead sees them in the attendance list with their answers, checks someone in by hand, undoes it with Undo,
 *   downloads the list, and finds it all in the stats. A member can't open the stats or create events.
 *
 * The accounts exist only in this browser's fake database.
 */
import { test, expect } from '@playwright/test';
import { watch, open, signUp, sql, signOut } from './helpers.mjs';

const TEST_PASS = ['ev', 'fake', 'mode', 'only', '2208'].join('-');
const LEAD = { name: 'Eve Lead', email: 'ev-lead@ufl.edu', password: TEST_PASS };
const MIA = { name: 'Mia Member', email: 'ev-mia@ufl.edu', password: TEST_PASS };
const MAX = { name: 'Max Member', email: 'ev-max@ufl.edu', password: TEST_PASS };
const ZOE = { name: 'Zoe Mech', email: 'ev-zoe@ufl.edu', password: TEST_PASS };

async function signIn(page, who) {
  await signOut(page);
  await page.fill('#l-email', who.email);
  await page.fill('#l-pass', who.password);
  await page.locator('#auth-form [type="submit"]').click();
  await expect(page.locator('#auth-form')).toHaveCount(0);
}
/** "2026-11-20T09:50" for a time this many minutes from now, in the browser's time zone. */
const localInput = (page, minutes) => page.evaluate((m) => {
  const d = new Date(Date.now() + m * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}, minutes);

test.describe('events', () => {
  test.describe.configure({ mode: 'serial' });
  /** @type {import('@playwright/test').Page} */
  let page;
  let problems;
  let eventUrl;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    problems = await watch(page);
    for (const [who, role] of [[MIA, 'member'], [MAX, 'member'], [ZOE, 'member']]) {
      await signUp(page, who, [role]);
      await signOut(page);
    }
    await signUp(page, LEAD, ['subsystem_lead']);
    // Divisions: Mia (Battery) and Max in Electrical, Zoe in Mechanical.
    await sql(page, `insert into org_divisions (name) values ('Electrical'), ('Mechanical')`);
    await sql(page, `insert into org_subsystems (division_id, name) select id, 'Battery' from org_divisions where name = 'Electrical'`);
    await sql(page, `insert into person_org (user_id, division_id, subsystem_id, main)
      select p.id, d.id, case when p.email = $1 then (select id from org_subsystems where name = 'Battery') end, true
      from profiles p join org_divisions d on d.name = case when p.email = $3 then 'Mechanical' else 'Electrical' end
      where p.email in ($1, $2, $3)`, [MIA.email, MAX.email, ZOE.email]);
  });
  test.afterAll(async () => page?.close());

  test('a lead creates a testing day for a division, with sign-in questions', async () => {
    await open(page, '/events/#/events', '.ev-head');
    await expect(page.locator('[data-nav="ev-stats"]')).toBeVisible();
    await page.click('[data-nav="ev-new"]');
    await expect(page.locator('.ev-form')).toBeVisible();
    await page.fill('#ev-title', 'Battery testing day');
    await page.selectOption('#ev-cat', { label: 'Testing day' });
    await page.fill('#ev-loc', 'Shop');
    await page.fill('#ev-start', await localInput(page, -15));
    await page.check('[name=mode][value=some]');
    await page.locator('.ev-org-div').filter({ hasText: 'Electrical' }).locator('[name=division]').check();
    await page.fill('#ev-late', '10');
    await page.click('[data-q-add]');
    await page.click('[data-q-add]');
    const q = page.locator('.ev-q');
    await q.nth(0).locator('.ev-q-label').fill('What did you work on?');
    await q.nth(0).locator('.ev-q-type').selectOption('select');
    await q.nth(0).locator('.ev-q-options').fill('Cells, BMS');
    await q.nth(0).locator('.ev-q-req').check();
    await q.nth(1).locator('.ev-q-label').fill('Hours');
    await q.nth(1).locator('.ev-q-type').selectOption('number');
    await page.click('[data-submit]');
    await expect(page.locator('.ev-head h1')).toHaveText('Battery testing day');
    eventUrl = page.url().replace(/^https?:\/\/[^/]+/, '');
    await expect(page.locator('.ev-facts')).toContainText('Electrical');
    await expect(page.locator('[data-tiles] .ev-tile').first()).toContainText('2'); // Mia and Max (Zoe isn't in Electrical)
  });

  test('a member sees it, says they\'re going, and can\'t see the stats or make events', async () => {
    await signIn(page, MIA);
    await open(page, '/events/#/events', '.ev-head');
    const card = page.locator('.ev-card').filter({ hasText: 'Battery testing day' });
    await expect(card).toBeVisible();
    await card.locator('[data-rsvp="yes"]').click();
    await expect(card.locator('[data-rsvp="yes"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-nav="ev-stats"]')).toBeHidden();
    await expect(page.locator('[data-nav="ev-new"]')).toBeHidden();
    await open(page, '/events/#/events/stats', '#app .no-access');
    // Zoe (Mechanical) isn't invited: she doesn't see it at all
    await signIn(page, ZOE);
    await open(page, '/events/#/events', '.ev-head');
    await expect(page.locator('.ev-card')).toHaveCount(0);
  });

  let code;
  test('the lead opens the check-in screen: a QR code and the same code to type', async () => {
    await signIn(page, LEAD);
    await open(page, eventUrl, '.ev-head');
    await page.click('[data-screen]');
    await page.click('[data-open]');
    await expect(page.locator('[data-qr] svg')).toBeVisible();
    code = (await page.locator('[data-code]').textContent()).trim();
    expect(code).toMatch(/^[0-9A-F]{6}$/);
    const link = await page.locator('[data-qr] title').textContent();
    expect(link).toContain('Battery testing day');
  });

  test('the member scans in: answers the questions and taps "I\'m here"', async () => {
    const id = eventUrl.match(/\/e\/([^/?#]+)/)[1];
    await signIn(page, MIA);
    await open(page, `/events/#/events/checkin/${id}?c=${code}`, '[data-checkin-form]');
    await page.click('.ev-here');   // the required question isn't answered
    await expect(page.locator('[data-checked-in]')).toHaveCount(0);
    await page.selectOption('[data-checkin-form] select', 'BMS');
    await page.fill('[data-checkin-form] input[type=number]', '3');
    await page.click('.ev-here');
    await expect(page.locator('[data-checked-in]')).toContainText('You\'re checked in');
    await expect(page.locator('[data-checked-in]')).toContainText('(late)');   // 15 minutes in, late after 10
    // My events shows it as done
    await open(page, `/events/#/events/e/${id}`, '.ev-head');
    await expect(page.locator('[data-me-in]')).toBeVisible();
  });

  test('an old code asks for the one on the screen', async () => {
    const id = eventUrl.match(/\/e\/([^/?#]+)/)[1];
    await signIn(page, MAX);
    await open(page, `/events/#/events/checkin/${id}?c=000000`, '[data-checkin-form]');
    await page.selectOption('[data-checkin-form] select', 'Cells');
    await page.click('.ev-here');
    await expect(page.locator('.ev-code-field')).toBeVisible();
    await expect(page.locator('[data-checkin-form] .alert-error')).toContainText('didn\'t work');
  });

  test('the lead sees who came with their answers, checks someone in by hand and undoes it, and downloads the list', async () => {
    await signIn(page, LEAD);
    const id = eventUrl.match(/\/e\/([^/?#]+)/)[1];
    await open(page, `/events/#/events/e/${id}`, '[data-table]');
    const row = (name) => page.locator('[data-row]').filter({ hasText: name });
    await expect(row('Mia Member')).toContainText('Came late');
    await page.click('.ev-cols summary');
    await page.locator('[data-col^="q:"]').first().check();
    await page.click('.ev-cols summary');
    await expect(row('Mia Member')).toContainText('BMS');
    // Max by hand (a walk-in? no: he's invited)
    await page.selectOption('#ev-add-person', { label: 'Max Member' });
    await page.click('[data-add] button');
    await expect(row('Max Member')).toContainText('Came');
    await row('Max Member').locator('[data-act=undo]').click();
    await expect(row('Max Member')).toContainText('Invited');
    await page.click('.pm-toast-undo');
    await expect(row('Max Member')).toContainText('Came');
    // Not here: nobody; Came: both
    await page.click('[data-filter=not]');
    await expect(page.locator('[data-row]')).toHaveCount(0);
    await page.click('[data-filter=here]');
    await expect(page.locator('[data-row]')).toHaveCount(2);
    const download = page.waitForEvent('download');
    await page.click('[data-csv]');
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^Battery-testing-day-\d{4}-\d{2}-\d{2}-attendance\.csv$/);
    // the log has each change, with who did it
    await page.click('.page-tabs a:has-text("Log")');
    await expect(page.locator('.ev-log')).toContainText('Eve Lead undid the check-in of Max Member');
  });

  test('the stats: people, events and divisions', async () => {
    await open(page, '/events/#/events/stats', '[data-out] table');
    const person = (name) => page.locator('[data-out] tbody tr').filter({ hasText: name });
    await expect(person('Mia Member')).toContainText('100%');
    await page.click('.page-tabs a:has-text("Events")');
    await expect(page.locator('[data-out] tbody tr').filter({ hasText: 'Battery testing day' })).toContainText('100%');
    await page.click('.page-tabs a:has-text("Divisions")');
    await expect(page.locator('[data-out] tbody tr').filter({ hasText: 'Electrical' })).toContainText('100%');
    await page.click('.page-tabs a:has-text("People")');
    await person('Mia Member').locator('a').click();
    await expect(page.locator('.ev-head h1')).toHaveText('Mia Member');
    await expect(page.locator('main')).toContainText('Came late');
    expect(problems).toEqual([]);
  });
});
