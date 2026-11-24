/**
 * The same list toolbar and "peek" panel in every list (orders/js/listBar.js, orders/js/peek.js), on
 * Orders → Requests and Inventory → Items: one Filter ▾ menu, the filters in use as chips (× takes one off),
 * filters remembered in this browser; a click on a row opens it beside the list, ↓ / ↑ move, Esc closes.
 */
import { test, expect } from '@playwright/test';
import { watch, open, signUp, sql } from './helpers.mjs';

const LEAD = { name: 'Lee Lists', email: 'lee-lists@ufl.edu', password: 'fake-only-lists-pass-1' };

test('Requests: Filter menu, chips, remembered filters, and peek with ↓ / Esc', async ({ page }) => {
  const problems = await watch(page);
  await signUp(page, LEAD, ['admin', 'treasurer']);
  const season = `(select value ->> 'season' from app_settings where key = 'general')`;
  for (const [n, t, s] of [['SG27-901', 'Peek cells', 'Submitted'], ['SG27-902', 'Peek wire', 'Submitted'], ['SG27-903', 'Peek bolts', 'Ordered']]) {
    await sql(page, `insert into requests (request_number, title, status, season, requester) values ($1, $2, $3, ${season}, 'Lee Lists')`, [n, t, s]);
  }
  await open(page, '/orders/#/requests', 'tr[data-href]');
  const bar = page.locator('.list-bar');
  await expect(bar.locator('[data-list-count]')).toContainText('3');

  // Filter ▾ → Status: Submitted shows a chip and narrows the list
  await bar.locator('.list-filter > summary').click();
  await bar.locator('select[data-filter="status"]').selectOption('Submitted');
  await expect(bar.locator('.list-chip')).toContainText('Submitted');
  await expect(bar.locator('.list-filter > summary')).toContainText('Filter · 1');
  await expect(page.locator('#results tr[data-href]')).toHaveCount(2);
  // picking a filter closes the menu; open again, a click elsewhere closes it
  await expect(bar.locator('.list-filter')).not.toHaveAttribute('open', '');
  await bar.locator('.list-filter > summary').click();
  await expect(bar.locator('.list-filter')).toHaveAttribute('open', '');
  await page.locator('h1, h2').first().click();
  await expect(bar.locator('.list-filter')).not.toHaveAttribute('open', '');

  // remembered after a reload
  await page.reload();
  await expect(page.locator('.list-bar .list-chip')).toContainText('Submitted');
  await expect(page.locator('#results tr[data-href]')).toHaveCount(2);

  // peek: a click on a row opens it beside the list, without leaving the list
  await page.locator('#results tr[data-href]').first().click();
  const peek = page.locator('aside.peek');
  await expect(peek).toBeVisible();
  await expect(page).toHaveURL(/#\/requests$/);
  await expect(peek.locator('.peek-body')).toContainText(/Peek (cells|wire)/);
  const first = await peek.locator('.peek-body').innerText();
  await expect(page.locator('tr.is-peeked')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await expect(peek.locator('.peek-body')).not.toHaveText(first);
  await expect(peek.locator('.peek-body')).toContainText(/Peek (cells|wire)/);
  await page.keyboard.press('Escape');
  await expect(peek).toHaveCount(0);

  // × on the chip takes the filter off
  await page.locator('.list-chip button').click();
  await expect(page.locator('.list-chip')).toHaveCount(0);
  await expect(page.locator('#results tr[data-href]')).toHaveCount(3);

  // "Open full page" goes to the request
  await page.locator('#results tr[data-href]').first().click();
  await page.locator('aside.peek [data-peek-full]').click();
  await expect(page).toHaveURL(/#\/requests\/SG27-90\d$/);
  await expect(page.locator('aside.peek')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('Inventory items: Filter menu keeps its filters in the address, and a row peeks', async ({ page }) => {
  const problems = await watch(page);
  await signUp(page, { ...LEAD, name: 'Ivy Lists', email: 'ivy-lists@ufl.edu' }, ['admin']);
  await sql(page, `insert into inventory_items (sku, name, hazardous) values ('PEEK-1', 'Peek resistor', false), ('PEEK-2', 'Peek solvent', true)`);
  await open(page, '/inventory/#/inventory/items', 'tr[data-href]');
  await page.locator('.list-filter > summary').click();
  await page.locator('select[data-filter="show"]').selectOption('hazard');
  await expect(page).toHaveURL(/state=hazard/);
  await expect(page.locator('.list-chip')).toContainText('Hazardous');
  await expect(page.locator('[data-list] tr[data-href]')).toHaveCount(1);
  await page.locator('[data-list] tr[data-href]').first().click();
  await expect(page.locator('aside.peek .peek-body')).toContainText('Peek solvent');
  await expect(page).toHaveURL(/#\/inventory\/items\?state=hazard$/);
  await page.locator('aside.peek [data-peek-close]').click();
  await expect(page.locator('aside.peek')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('The same list toolbar on Finances purchases, Sponsors and Events', async ({ page }) => {
  const problems = await watch(page);
  await signUp(page, { name: 'Tia Toolbar', email: 'tia-toolbar@ufl.edu', password: 'fake-only-toolbar-pass-1' }, ['admin', 'treasurer']);

  // Finances → Purchases: search, Filter ▾ (Category), sort and "+ Add a purchase" in one bar
  await open(page, '/finances/', '#ledger-add');
  await expect(page.locator('.list-bar #ledger-q')).toBeVisible();
  await expect(page.locator('.list-bar #ledger-sort')).toBeVisible();
  await expect(page.locator('.list-bar [data-list-count]')).toContainText('$');

  // Sponsors: Whose sits in the Filter menu and shows as a chip
  await open(page, '/sponsors/', '.list-bar');
  const bar = page.locator('.list-bar');
  await bar.locator('.list-filter > summary').click();
  await bar.locator('select[data-filter="who"]').selectOption('mine');
  await expect(bar.locator('.list-chip')).toContainText("I'm leading");
  await bar.locator('.list-chip button').click();
  await expect(bar.locator('.list-chip')).toHaveCount(0);

  // Events → All events: Upcoming / Past / Everything stays in view next to the Filter menu
  await open(page, '/events/#/events/all', '.list-bar');
  await expect(page.locator('.list-bar .pm-seg [data-when="upcoming"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.list-bar [data-list-count]')).toContainText('events');
  expect(problems).toEqual([]);
});
