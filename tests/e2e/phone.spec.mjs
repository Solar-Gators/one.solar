/**
 * Phone width (390px): request cards, the alumni hub's tabs, Events → Stats filters, Admin role boxes.
 */
import { test, expect } from '@playwright/test';
import { watch, open, signUp, sql } from './helpers.mjs';

test.use({ viewport: { width: 390, height: 844 } });

test('on a phone: nothing covers a label, no tab hides off the edge, filters sit in one menu', async ({ page }) => {
  const problems = await watch(page);
  await signUp(page, { name: 'Pia Phone', email: 'pia-phone@ufl.edu', password: 'fake-only-phone-pass-1' }, ['admin', 'coordinator']);
  const season = `(select value ->> 'season' from app_settings where key = 'general')`;
  await sql(page, `insert into requests (request_number, title, status, season, requester) values ('SG27-951', 'Phone wire', 'Approved', ${season}, 'Pia Phone')`);

  // Orders → Requests: the status chips sit on their own line under the title, not over "Requester name"
  await open(page, '/orders/#/requests', 'tr[data-href]');
  const row = page.locator('tr[data-href]').first();
  const status = await row.locator('td[data-col="status"]').boundingBox();
  const title = await row.locator('td.cell-primary').boundingBox();
  const others = await row.locator('td:not(.cell-primary):not([data-col="status"])').evaluateAll((tds) => tds.map((t) => t.getBoundingClientRect().top));
  expect(status.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
  for (const top of others) expect(top).toBeGreaterThanOrEqual(status.y + status.height - 1);

  // Admin → Users: role boxes in an even grid
  await open(page, '/admin/#/admin/users', '.role-chips');
  expect(await page.locator('.role-chips').first().evaluate((el) => getComputedStyle(el).display)).toBe('grid');

  // Events → Stats: the semester in view, the rest in Filter ▾
  await open(page, '/events/#/events/stats', '.ev-stats-filters');
  const filter = page.locator('.ev-stats-filters .list-filter');
  await expect(page.locator('.ev-stats-filters select[name="semester"]')).toBeVisible();
  await expect(page.locator('.ev-stats-filters input[name="from"]')).toBeHidden();
  await filter.locator('summary').click();
  await page.locator('.ev-stats-filters input[name="noIsExcused"]').uncheck();
  await expect(filter.locator('summary')).toContainText('Filter · 1');
  await page.locator('.ev-stats-filters [data-reset]').click();
  await expect(page.locator('.ev-stats-filters .list-filter summary')).toHaveText(/^Filter\s*▾$/);

  // Alumni hub (as a team member who can manage it): every tab is on screen or under "More ▾"
  await open(page, '/sgaa/?fake', '#sgaa-nav');
  const nav = page.locator('#sgaa-nav');
  await expect(nav.locator('.nav-more')).toBeVisible();
  expect(await nav.evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
  await nav.locator('.nav-more-btn').click();
  await expect(nav.locator('.nav-more-pop a', { hasText: 'Events' })).toBeVisible();
  expect(problems).toEqual([]);
});
