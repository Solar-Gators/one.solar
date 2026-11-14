/**
 * Workflow tests (T-1b): the everyday paths, clicked through like a person would, on the fake backend.
 *   - Orders: submit a request → a CE approves it → the Treasurer marks it ordered → it's on Finances.
 *   - Finances: add a purchase by hand; it's still there after a reload.
 *   - Sponsors: add a sponsor, comment on its card.
 *   - Solar Evals: start an evaluation; it's saved as a draft.
 *
 * One account holds CE + Treasurer + Admin, so a single browser can do every step. The account exists only
 * in this browser's fake database.
 */
import { test, expect } from '@playwright/test';
import { watch, open, signUp, sql } from './helpers.mjs';

const LEAD = { name: 'Flow Lead', email: 'flow-lead@ufl.edu', password: 'fake-only-flow-pass-1' };

test.describe('workflows', () => {
  test.describe.configure({ mode: 'serial' });
  /** @type {import('@playwright/test').Page} */
  let page;
  let problems;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    problems = await watch(page);
    await signUp(page, LEAD, ['admin', 'ce', 'treasurer']);
  });
  test.afterAll(async () => page?.close());
  test.afterEach(() => {
    const found = problems.splice(0);
    expect(found).toEqual([]);
  });

  test('Orders: submit, approve, mark ordered; it shows on Finances (self-approved)', async () => {
    await open(page, '/orders/#/new', '#f-title');
    await page.fill('#f-title', 'Flow test cells');
    await page.selectOption('#f-subsystem', { index: 1 });
    await page.fill('#f-needed_by', '2030-01-15');
    await page.fill('#f-justification', 'Spare cells for the pack.');
    await page.fill('#f-vendor', 'Acme Batteries');
    const item = page.locator('tr[data-index="0"]');
    await item.locator('[data-ifield="item_name"]').fill('18650 cell');
    await item.locator('[data-ifield="product_link"]').fill('https://example.com/cell');
    await item.locator('[data-ifield="quantity"]').fill('4');
    await item.locator('[data-ifield="unit_price"]').fill('5');
    await page.getByRole('button', { name: 'Submit Request' }).click();

    await expect(page.locator('.alert-success')).toContainText('submitted for approval');
    const number = (page.url().match(/#\/requests\/([^/?]+)/) || [])[1];
    expect(number).toBeTruthy();
    await expect(page.locator('#app')).toContainText('$20.00');

    // A double submit (the same form sent twice) made one request, not two (045).
    expect((await sql(page, `select count(*)::int n from requests where title = 'Flow test cells'`))[0].n).toBe(1);

    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.locator('.alert-success')).toContainText('approved');
    await expect(page.locator('.subtitle .self-approved')).toBeVisible(); // the maker approved it (B11)

    await page.fill('#o-number', 'T-4242');
    await page.getByRole('button', { name: 'Mark as Ordered' }).click();
    await expect(page.locator('.alert-success')).toContainText('marked as ordered');
    await expect(page.locator('#app')).toContainText('T-4242');

    await open(page, '/finances/', '#ledger-add');
    const line = page.locator('tr', { hasText: 'Flow test cells' });
    await expect(line).toContainText('$20.00');
    await expect(line.locator('.self-approved')).toBeVisible();

    await open(page, '/orders/#/requests', '#app table');
    await expect(page.locator('#app tr', { hasText: 'Flow test cells' })).toContainText('Ordered');
  });

  test('Finances: a purchase added by hand is saved', async () => {
    await open(page, '/finances/', '#ledger-add');
    await page.locator('#ledger-add').click();
    const row = page.locator('tr[data-line^="p:"]').filter({ has: page.locator('[data-f="description"]') }).first();
    await row.locator('[data-f="description"]').fill('Zip ties (hardware store)');
    await row.locator('[data-f="description"]').press('Tab');
    await row.locator('[data-f="amount"]').fill('12.5');
    await row.locator('[data-f="amount"]').press('Tab');
    await expect.poll(() => sql(page, `select amount::float a from finance_purchases where description = 'Zip ties (hardware store)'`))
      .toEqual([{ a: 12.5 }]);

    await page.reload();
    await expect(page.locator('[data-f="description"][value="Zip ties (hardware store)"]')).toHaveCount(1);
  });

  test('Sponsors: add a sponsor and comment on its card', async () => {
    await open(page, '/sponsors/', '#new-card');
    await page.locator('#new-card').click();
    const ask = page.locator('dialog[open]');
    await ask.locator('#ask-text').fill('Flow Test Energy');
    await ask.getByRole('button', { name: 'Add sponsor' }).click();
    await expect(page).toHaveURL(/#\/sponsors\/[0-9a-f-]{36}/);
    await expect(page.locator('#app h1, #app h2').first()).toContainText('Flow Test Energy');

    await page.fill('#comment', 'Emailed their outreach team.');
    await page.locator('#comment-form').getByRole('button', { name: 'Add note' }).click();
    await expect(page.locator('#app')).toContainText('Emailed their outreach team.');

    await open(page, '/sponsors/', '#new-card');
    await expect(page.locator('#app')).toContainText('Flow Test Energy');
  });

  test('deleted by mistake: a sponsor card and a purchase come back from Recently deleted (047)', async () => {
    const [{ id }] = await sql(page, `select id from sponsor_cards where name = 'Flow Test Energy'`);
    await open(page, `/sponsors/#/sponsors/${id}`, '#delete-card');
    page.once('dialog', (d) => d.accept());
    await page.locator('#delete-card').click();
    await expect(page).toHaveURL(/#\/sponsors$|\/sponsors\/$/);
    await expect(page.locator('#sp-body')).not.toContainText('Flow Test Energy');
    const box = page.locator('#sp-deleted .recently-deleted');
    await box.locator('summary').click();
    await box.locator('tr', { hasText: 'Flow Test Energy' }).getByRole('button', { name: 'Restore' }).click();
    await expect(page).toHaveURL(/#\/sponsors\/[0-9a-f-]{36}/);
    await expect(page.locator('#app')).toContainText('Emailed their outreach team.'); // its history came back too
    await expect(page.locator('#app')).toContainText(/Restored \(deleted by Flow Lead/);

    await open(page, '/finances/', '#ledger-add');
    const line = page.locator('tr', { has: page.locator('[data-f="description"][value="Zip ties (hardware store)"]') });
    page.once('dialog', (d) => d.accept());
    await line.locator('[data-delete]').click();
    await expect(page.locator('[data-f="description"][value="Zip ties (hardware store)"]')).toHaveCount(0);
    const fin = page.locator('#fin-deleted .recently-deleted');
    await fin.locator('summary').click();
    await fin.locator('tr', { hasText: 'Zip ties' }).getByRole('button', { name: 'Restore' }).click();
    await expect(page.locator('[data-f="description"][value="Zip ties (hardware store)"]')).toHaveCount(1);
  });

  test('Solar Evals: starting an evaluation saves it as a draft', async () => {
    await open(page, '/evals/?fake', '#tabs');
    await page.locator('[data-act="newEval"]').first().click();
    const dlg = page.locator('#dNew');
    await expect(dlg).toBeVisible();
    if (await dlg.locator('#nSubject').isVisible()) await dlg.locator('#nSubject').selectOption({ index: 0 });
    if (await dlg.locator('#nName').isVisible()) await dlg.locator('#nName').fill('Flow Member');
    await dlg.locator('#nSem').fill('Fall 2026');
    await dlg.getByRole('button', { name: 'Start' }).click();
    await expect(page).toHaveURL(/#\/evals\/[0-9a-f-]{36}/);

    const rows = await sql(page, `select status from evals where member_name = 'Flow Member' or semester = 'Fall 2026'`);
    expect(rows.map((r) => r.status)).toEqual(['draft']);
  });
});
