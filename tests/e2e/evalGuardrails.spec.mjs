/**
 * Solar Evals guardrails (065) in Setup: "Leave out people whose position has its own eval" (on for the Member
 * eval), the "Except people in these positions" list, and "Check these rules" listing evals that don't fit.
 * Fake backend only; the accounts and evals exist only in this browser's fake database.
 */
import { test, expect } from '@playwright/test';
import { watch, open, signUp, sql } from './helpers.mjs';

const ADMIN = { name: 'Gia Guard', email: 'gia-guard@ufl.edu', password: 'fake-only-guardrails-pass-1' };
const shot = (page, name) => (process.env.PM_SHOTS ? page.screenshot({ path: `test-results/pm-shots/${name}.png`, fullPage: true }) : null);

test('Setup: leave out other positions, except list, and the rule check', async ({ page }) => {
  const problems = await watch(page);
  await signUp(page, ADMIN, ['admin', 'ce']);
  await sql(page, `update profiles set accepted_at = now() where email = $1`, [ADMIN.email]);
  // a Subsystem Lead (also a Member) whose Member eval self-eval was started before the rule
  await sql(page, `
    insert into auth.users (id, email, password, raw_user_meta_data) values ('00000000-0000-0000-0000-00000000aaa1', 'sam-lead@ufl.edu', 'x', '{"full_name":"Sam Lead"}')`);
  await sql(page, `insert into profile_roles (user_id, role) values ('00000000-0000-0000-0000-00000000aaa1', 'member'), ('00000000-0000-0000-0000-00000000aaa1', 'subsystem_lead')`);
  await sql(page, `update profiles set accepted_at = now() where id = '00000000-0000-0000-0000-00000000aaa1'`);
  await sql(page, `
    with t as (select id, label, rubric from eval_templates where track_id = 'master' order by created_at desc limit 1)
    insert into evals (template_id, template_label, rubric, member_name, semester, evaluator_id, ratings, status, kind, type_id, type_settings)
    select t.id, 'Member eval · ' || t.label, t.rubric, 'Sam Lead', 'Fall 2026', '00000000-0000-0000-0000-00000000aaa1',
           '{}'::jsonb, 'draft', 'self', 'member', (select settings from eval_types where id = 'member') from t`);

  await open(page, '/evals/?fake#/setup/member', '[data-act="sCheck"]');
  const own = page.locator('input[data-sp="settings.subjects.except_others"]');
  await expect(own).toBeChecked();
  await expect(page.locator('.srow, .scard').filter({ hasText: 'Positions with their own eval now' }).first()).toContainText('Subsystem Lead');

  await page.click('[data-act="sCheck"]');
  const ck = page.locator('#ruleCheck');
  await expect(ck).toContainText('1 found');
  await expect(ck).toContainText('Sam Lead is Subsystem Lead, which has its own eval, and Member eval is left out for them');
  await shot(page, 'evals-guardrails-check');

  // the except list: tick a position, it's named in the summary and saved
  await page.locator('details.except').first().locator('summary').click();
  await page.locator('input[data-except="settings.subjects"][value="integration_pm"]').check();
  await expect(page.locator('details.except').first().locator('summary')).toContainText('Integration Project Manager');
  await own.uncheck();
  await page.click('[data-act="sSave"]');
  await page.locator('#dTSave button[value="ok"]').click();
  await expect.poll(async () => (await sql(page, `select settings -> 'subjects' as s from eval_types where id = 'member'`))[0].s)
    .toMatchObject({ except: ['integration_pm'] });
  expect((await sql(page, `select settings -> 'subjects' ? 'except_others' as on from eval_types where id = 'member'`))[0].on).toBe(false);
  await page.click('[data-act="sCheck"]');
  await expect(page.locator('#ruleCheck')).toContainText('None');
  expect(problems.splice(0)).toEqual([]);
});
