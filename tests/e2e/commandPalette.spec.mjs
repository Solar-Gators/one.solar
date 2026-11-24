/**
 * The Ctrl/⌘ + K command palette (shared/command-palette.js) in every app: pages, actions for what you may do,
 * other apps, and requests / parts / sponsors found in the database (search_everything, 066), which only
 * shows what you could open anyway. Projects keeps its own Ctrl+K bar, which hands off to the palette.
 */
import { test, expect } from '@playwright/test';
import { watch, open, signUp, sql } from './helpers.mjs';

const LEAD = { name: 'Kai Palette', email: 'kai-palette@ufl.edu', password: 'fake-only-palette-pass-1' };
const pal = (page) => page.locator('.os-pal');
const shot = (page, name) => (process.env.PM_SHOTS ? page.screenshot({ path: `test-results/pm-shots/${name}.png` }) : null);

test('Ctrl+K finds a request by number and opens it; actions follow permissions; Esc closes', async ({ page }) => {
  const problems = await watch(page);
  await signUp(page, LEAD, ['admin', 'treasurer']);
  const season = `(select value ->> 'season' from app_settings where key = 'general')`;
  await sql(page, `insert into requests (request_number, title, status, season, requester)
    values ('SG27-777', 'Nickel strip for the pack', 'Submitted', ${season}, 'Kai Palette')`);
  await sql(page, `insert into sponsor_cards (name, stage, season) values ('Acme Nickel Supply', 'prospect', ${season})`);

  await open(page, '/orders/', '.home-hero');
  await page.keyboard.press('Control+k');
  await expect(pal(page)).toBeVisible();
  await expect(pal(page).locator('input')).toBeFocused();
  // nothing typed: this app's pages and the actions this person may use
  await expect(pal(page).locator('.os-pal-row', { hasText: 'New request' })).toBeVisible();
  await expect(pal(page).locator('.os-pal-group', { hasText: 'Go to' })).toBeVisible();

  // a request number finds the request; a word finds requests and sponsors
  await pal(page).locator('input').fill('nickel');
  await expect(pal(page).locator('.os-pal-row', { hasText: 'SG27-777 · Nickel strip for the pack' })).toBeVisible();
  await expect(pal(page).locator('.os-pal-row', { hasText: 'Acme Nickel Supply' })).toBeVisible();
  await shot(page, 'palette-search');
  await pal(page).locator('input').fill('SG27-777');
  const row = pal(page).locator('.os-pal-row', { hasText: 'SG27-777' });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(/#\/requests\/SG27-777$/);
  await expect(page.locator('h1')).toContainText('Nickel strip for the pack');
  await expect(pal(page)).toBeHidden();

  // the arrow keys and Enter run an action; Esc closes without doing anything
  await page.keyboard.press('Control+k');
  await pal(page).locator('input').fill('admin users');
  await expect(pal(page).locator('.os-pal-row[aria-selected="true"]')).toContainText('Admin: Users');
  await page.keyboard.press('Escape');
  await expect(pal(page)).toBeHidden();
  await page.keyboard.press('Control+k');
  await pal(page).locator('input').fill('admin users');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/admin\/#\/admin\/users/);
  expect(problems).toEqual([]);
});

test('someone without Sponsors access finds requests but not sponsors', async ({ page }) => {
  await signUp(page, { name: 'Mo Member', email: 'mo-member@ufl.edu', password: 'fake-only-palette-pass-2' }, ['member']);
  const season = `(select value ->> 'season' from app_settings where key = 'general')`;
  await sql(page, `insert into sponsor_cards (name, stage, season) values ('Zephyr Sponsor Co', 'prospect', ${season})`);
  await open(page, '/orders/', '.home-hero');
  await page.keyboard.press('Control+k');
  await pal(page).locator('input').fill('zephyr');
  await expect(pal(page).locator('.os-pal-none')).toContainText('Nothing matches');
  await expect(pal(page).locator('.os-pal-row', { hasText: 'Admin:' })).toHaveCount(0);
});

test('the same keys in every app: J / K pick a row and Enter opens it, C starts something new, / searches, ? lists them', async ({ page }) => {
  const problems = await watch(page);
  await signUp(page, { name: 'Jo Keys', email: 'jo-keys@ufl.edu', password: 'fake-only-palette-pass-3' }, ['admin']);
  const season = `(select value ->> 'season' from app_settings where key = 'general')`;
  for (const [n, t] of [['SG27-801', 'Torque wrench'], ['SG27-802', 'Heat shrink kit']]) {
    await sql(page, `insert into requests (request_number, title, status, season, requester) values ($1, $2, 'Submitted', ${season}, 'Jo Keys')`, [n, t]);
  }
  await open(page, '/orders/#/requests', 'tr[data-href]');
  await page.keyboard.press('j');
  await expect(page.locator('tr.kbd-at')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/requests\/SG27-80[12]$/);
  await page.keyboard.press('?');
  await expect(page.locator('.kbd-help')).toContainText('Keyboard shortcuts');
  await page.keyboard.press('Escape');
  await expect(page.locator('.kbd-help')).toHaveCount(0);
  await page.keyboard.press('c');
  await expect(page).toHaveURL(/#\/new$/);
  // Sponsors: C is "+ New sponsor"
  await open(page, '/sponsors/', '#new-card');
  await page.keyboard.press('c');
  await expect(page.locator('dialog[open]')).toContainText('New sponsor');
  expect(problems).toEqual([]);
});
