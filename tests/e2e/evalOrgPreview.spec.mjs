/**
 * Solar Evals: the CE division and subsystem are picked from the team's lists (Admin → Divisions & people), with
 * "Other" for anything not listed; whoever sets up eval types can preview the self-eval exactly as a member sees it
 * (nothing saved); and the Summary places older evals that didn't name a division.
 * Fake backend only; the accounts and evals exist only in this browser's fake database.
 */
import { test, expect } from '@playwright/test';
import { watch, open, signUp, sql, signOut } from './helpers.mjs';

const ADMIN = { name: 'Ada Setup', email: 'ada-setup@ufl.edu', password: 'fake-only-orgpreview-pass-1' };
const MEMBER = { name: 'Max Member', email: 'max-member@ufl.edu', password: 'fake-only-orgpreview-pass-2' };
/** PM_SHOTS=1 keeps pictures in test-results/pm-shots (for looking at, not compared). */
const shot = (page, name) => (process.env.PM_SHOTS ? page.screenshot({ path: `test-results/pm-shots/${name}.png` }) : null);

async function seedOrg(page) {
  await sql(page, `
    with d as (insert into org_divisions (name, sort) values ('Electrical', 1), ('Aero / Structures', 2) returning id, name)
    insert into org_subsystems (division_id, name, sort)
    select d.id, s.name, s.sort from d join (values ('Electrical', 'BMS', 1), ('Electrical', 'Telemetry', 2), ('Aero / Structures', 'Body', 1)) s(div, name, sort) on s.div = d.name`);
}

test.describe('eval divisions and the member preview', () => {
  test.describe.configure({ mode: 'serial' });
  /** @type {import('@playwright/test').Page} */
  let page;
  let problems;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    problems = await watch(page);
    await signUp(page, ADMIN, ['admin', 'ce']);
    await sql(page, `update profiles set accepted_at = now() where email = $1`, [ADMIN.email]);
    await seedOrg(page);
  });
  test.afterAll(async () => page?.close());
  test.afterEach(() => {
    const found = problems.splice(0);
    expect(found).toEqual([]);
  });

  test('Setup → Preview as a member: the same start window and form, and nothing is saved or sent', async () => {
    const before = (await sql(page, `select count(*)::int n from evals`))[0].n;
    await open(page, '/evals/?fake#/setup/member', '[data-act="sPreview"]');
    await page.click('[data-act="sPreview"]');
    const dlg = page.locator('#dSelf');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('#sfPreview')).toBeVisible();
    // the division lists only its own subsystems; "Other" opens a box to type one
    await dlg.locator('[data-org="div"]').selectOption({ label: 'Electrical' });
    await expect(dlg.locator('[data-org="sub"] option')).toContainText(['Pick your subsystem', 'BMS', 'Telemetry', 'Other (not listed)…']);
    await expect(dlg.locator('[data-org="subOther"]')).toBeHidden();
    await dlg.locator('[data-org="sub"]').selectOption({ label: 'Other (not listed)…' });
    await expect(dlg.locator('[data-org="subOther"]')).toBeVisible();
    await dlg.locator('[data-org="subOther"]').fill('Motor controller');
    await shot(page, 'evals-preview-start');
    await dlg.getByRole('button', { name: 'Start' }).click();

    await expect(page).toHaveURL(/#\/evals\/preview$/);
    await expect(page.locator('.banner.preview')).toContainText('Preview as a member');
    await expect(page.locator('#saveState')).toContainText('nothing is saved');
    await expect(page.locator('.qa [data-org="div"]')).toHaveValue(/.+/);
    await expect(page.locator('.qa [data-org="subOther"]')).toHaveValue('Motor controller');
    await page.locator('textarea[data-qa]').first().fill('Built the pack harness.');
    await shot(page, 'evals-preview-form');
    page.once('dialog', (d) => d.accept());
    await page.locator('[data-act="selfSubmit"]').click();
    if (await page.locator('.toast, #toast').first().isVisible().catch(() => false)) await expect(page.locator('.toast, #toast').first()).toContainText(/Preview|Pick/);
    expect((await sql(page, `select count(*)::int n from evals`))[0].n).toBe(before);   // nothing was saved

    await page.locator('.banner.preview [data-act="pvExit"]').click();
    await expect(page).toHaveURL(/#\/setup\/member$/);
    await page.goto('/evals/?fake#/evals/preview');   // a preview lives only on the page it started on
    await expect(page).toHaveURL(/#\/setup/);
  });

  test('a member picks their CE division and subsystem; the eval keeps the names', async () => {
    await signOut(page);
    await signUp(page, MEMBER, ['member']);
    await sql(page, `update profiles set accepted_at = now() where email = $1`, [MEMBER.email]);
    await open(page, '/evals/?fake', '#tabs');
    await page.locator('[data-act="newSelf"]').first().click();
    const dlg = page.locator('#dSelf');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('#sfPreview')).toBeHidden();
    await expect(dlg.locator('[data-org="div"]')).toHaveAttribute('required', '');
    await dlg.locator('[data-org="div"]').selectOption({ label: 'Aero / Structures' });
    await expect(dlg.locator('[data-org="sub"] option')).toContainText(['Pick your subsystem', 'Body', 'Other (not listed)…']);
    await dlg.locator('[data-org="sub"]').selectOption({ label: 'Body' });
    if (await dlg.locator('#sfCe').isVisible()) await dlg.locator('#sfCe').selectOption({ index: 1 });
    await dlg.getByRole('button', { name: 'Start' }).click();
    await expect(page).toHaveURL(/#\/evals\/[0-9a-f-]{36}/);
    expect(await sql(page, `select division, subsystem from evals where kind = 'self' and member_name = $1`, [MEMBER.name]))
      .toEqual([{ division: 'Aero / Structures', subsystem: 'Body' }]);

    // changed at the top of the form: Other, typed in
    await page.locator('.qa [data-org="div"]').selectOption({ label: 'Other (not listed)…' });
    await page.locator('.qa [data-org="divOther"]').fill('Business');
    await expect.poll(async () => (await sql(page, `select division from evals where kind = 'self' and member_name = $1`, [MEMBER.name]))[0].division).toBe('Business');
  });

  test('Summary: people are placed as in Admin → Divisions & people; anyone not listed there, from their eval read loosely', async () => {
    await signOut(page);
    await open(page, '/orders/', '#auth-form');
    await page.fill('#l-email', ADMIN.email);
    await page.fill('#l-pass', ADMIN.password);
    await page.locator('#auth-form [type="submit"]').click();
    await expect(page.locator('#auth-form')).toHaveCount(0);
    await sql(page, `
      with t as (select id, label, rubric from eval_templates where track_id = 'master' order by created_at desc limit 1)
      insert into evals (template_id, template_label, rubric, member_name, semester, division, subsystem, evaluator_id, ratings, status, kind, type_id, type_settings, finalized_at)
      select t.id, 'Member eval · ' || t.label, t.rubric, 'Old Eval', 'Fall 2026', '', 'bms', (select id from profiles where email = '${ADMIN.email}'),
             '{}'::jsonb, 'final', 'ce', 'member', (select settings from eval_types where id = 'member'), now() from t`);
    // an older eval with a division's name typed as the subsystem, spelled differently
    await sql(page, `
      with t as (select id, label, rubric from eval_templates where track_id = 'master' order by created_at desc limit 1)
      insert into evals (template_id, template_label, rubric, member_name, semester, division, subsystem, evaluator_id, ratings, status, kind, type_id, type_settings, finalized_at)
      select t.id, 'Member eval · ' || t.label, t.rubric, 'Typed Division', 'Fall 2026', '', 'Aero-Structures', (select id from profiles where email = '${ADMIN.email}'),
             '{}'::jsonb, 'final', 'ce', 'member', (select settings from eval_types where id = 'member'), now() from t`);
    // Max's eval says "Business", but Admin → Divisions & people has them in Electrical → Telemetry: Admin wins
    await sql(page, `
      with t as (select id, label, rubric from eval_templates where track_id = 'master' order by created_at desc limit 1)
      insert into evals (template_id, template_label, rubric, member_name, subject_id, semester, division, subsystem, evaluator_id, ratings, status, kind, type_id, type_settings, finalized_at)
      select t.id, 'Member eval · ' || t.label, t.rubric, 'Max Member', (select id from profiles where email = '${MEMBER.email}'), 'Fall 2026', 'Business', 'Sales',
             (select id from profiles where email = '${ADMIN.email}'), '{}'::jsonb, 'final', 'ce', 'member', (select settings from eval_types where id = 'member'), now() from t`);
    await sql(page, `delete from person_org where user_id = (select id from profiles where email = $1)`, [MEMBER.email]);
    await sql(page, `insert into person_org (user_id, division_id, subsystem_id, main)
      select p.id, d.id, s.id, true from profiles p, org_divisions d join org_subsystems s on s.division_id = d.id
      where p.email = $1 and d.name = 'Electrical' and s.name = 'Telemetry'`, [MEMBER.email]);
    await open(page, '/evals/?fake#/summary', '.sum');
    await page.click('[data-act="sumTab"][data-k="makeup"]');
    await page.selectOption('[data-act="sumSem"]', 'Fall 2026');
    const elec = page.locator('.mk-div', { hasText: 'Electrical' });
    await expect(elec).toContainText('Telemetry');
    await expect(elec).toContainText('BMS');
    await expect(page.locator('.mk-div', { hasText: 'Business' })).toHaveCount(0);
    await expect(page.locator('.mk-div', { hasText: 'Aero / Structures' })).toBeVisible();
    await expect(page.locator('.mk-div', { hasText: 'No division' })).toHaveCount(0);
    const note = page.locator('.sum-card .sub').first();
    await expect(note).toContainText("aren't listed there yet");
    await expect(note).toContainText('Old Eval');
    await expect(note).not.toContainText('Max Member');
    await shot(page, 'evals-summary-admin');
  });
});
