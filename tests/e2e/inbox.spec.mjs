/**
 * "Waiting on you" on the one.solar home screen (067, my_inbox): one list of what needs you from every app, the
 * urgent ones first, six at a time ("Show all" is remembered). Uses the home screen's fake mode (hub/fake.js), whose
 * rows match what my_inbox returns; tests/inbox.test.mjs checks the database side.
 */
import { test, expect } from '@playwright/test';
import { watch } from './helpers.mjs';

test('what needs you, urgent first, links into each app; Show all is remembered', async ({ page }) => {
  const problems = await watch(page);
  await page.goto('/?fake=admin');
  const box = page.locator('#inbox');
  await expect(box).toBeVisible();
  await expect(box.locator('h2')).toContainText('Waiting on you');
  await expect(box.locator('.inbox-n')).toHaveText('7');
  await expect(box.locator('.inbox-row')).toHaveCount(6);
  await expect(box.locator('.inbox-row').first()).toHaveClass(/is-urgent/);
  await box.locator('#inbox-more').click();
  await expect(box.locator('.inbox-row')).toHaveCount(7);
  await expect(box.locator('.inbox-row', { hasText: '3 requests to approve' })).toHaveAttribute('href', /orders\/#\/approvals$/);
  await page.reload();
  await expect(page.locator('#inbox .inbox-row')).toHaveCount(7);
  expect(problems).toEqual([]);
});

test('nothing waiting: one quiet line; guests and signed-out visitors get no list', async ({ page }) => {
  await page.goto('/?fake');
  await expect(page.locator('#inbox .inbox-clear')).toContainText('all caught up');
  await page.goto('/?fake=guest');
  await expect(page.locator('#hello')).toBeVisible();
  await expect(page.locator('#inbox')).toBeHidden();
  await page.goto('/?fake=out');
  await expect(page.locator('#hello')).toBeVisible();
  await expect(page.locator('#inbox')).toBeHidden();
});
