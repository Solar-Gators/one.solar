/**
 * "How this works" (shared/help.js): longer explanations sit behind one line that opens on click, the same in every
 * app, and each remembers in this browser whether it was left open or closed.
 */
import { test, expect } from '@playwright/test';
import { watch, open, signUp } from './helpers.mjs';

// The browser saves the choice just after the click (the toggle event); wait for it before reloading.
const saved = (page, id, v) => expect.poll(() => page.evaluate((k) => localStorage.getItem(k), `onesolar:help:${id}`)).toBe(v);

test('"How this works" opens on click and stays the way it was left', async ({ page }) => {
  const problems = await watch(page);
  await signUp(page, { name: 'Hal Help', email: 'hal-help@ufl.edu', password: 'fake-only-help-pass-1' }, ['admin']);

  // Admin → Approval rules: one short line shows; the rest is behind "How this works", closed at first
  await open(page, '/admin/#/admin/workflow', '#rules');
  const box = page.locator('details.about[data-help="admin-approval-rules"]');
  await expect(box).toBeVisible();
  await expect(box).not.toHaveAttribute('open', '');
  await box.locator('summary').click();
  await expect(box.locator('> div')).toContainText('If none match, any Chief Engineer can approve');
  await saved(page, 'admin-approval-rules', '1');
  await page.reload();
  await expect(page.locator('details.about[data-help="admin-approval-rules"]')).toHaveAttribute('open', '');
  await page.locator('details.about[data-help="admin-approval-rules"] summary').click();
  await saved(page, 'admin-approval-rules', '0');
  await page.reload();
  await expect(page.locator('details.about[data-help="admin-approval-rules"]')).not.toHaveAttribute('open', '');

  // Orders home: "How ordering works" remembers being opened
  await open(page, '/orders/', '.home-steps');
  const steps = page.locator('.home-steps details[data-help="orders-home-steps"]');
  await expect(steps).not.toHaveAttribute('open', '');
  await steps.locator('summary').click();
  await saved(page, 'orders-home-steps', '1');
  await page.reload();
  await expect(page.locator('.home-steps details[data-help="orders-home-steps"]')).toHaveAttribute('open', '');
  expect(problems).toEqual([]);
});
