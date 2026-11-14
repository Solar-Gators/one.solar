/**
 * Inventory (050), clicked through like a person would, on the fake backend. The acceptance scenario:
 *   make an item; receive 100 into Cabinet A; use 20 for a subsystem; move 30 to Cabinet B; receive 50 from an
 *   Orders request (approved and ordered in Orders as usual) → 130; check stock by location, the division →
 *   subsystem report and the history; follow the item's QR label and record a use; count Cabinet B and apply a
 *   controlled difference; a member without Receive / Manage can't change stock, and a Guest can't open it.
 *
 * The accounts exist only in this browser's fake database.
 */
import { test, expect } from '@playwright/test';
import { watch, open, signUp, sql } from './helpers.mjs';

const TEST_PASS = ['inv', 'fake', 'mode', 'only', '7351'].join('-');
const LEAD = { name: 'Inv Lead', email: 'inv-lead@ufl.edu', password: TEST_PASS };
const MEMBER = { name: 'Inv Member', email: 'inv-member@ufl.edu', password: TEST_PASS };
const GUEST = { name: 'Inv Guest', email: 'inv-guest@ufl.edu', password: TEST_PASS };
const ITEM = 'M3x8 socket head cap screw';

/** The item's stock: { total, byLocation: { CAB-A: n } }, read straight from the database. */
async function stockOf(page) {
  const rows = await sql(page, `select l.code, sum(s.qty)::float8 qty from inventory_stock s join inventory_items i on i.id = s.item_id
    join inventory_locations l on l.id = s.location_id where i.name = $1 and s.qty > 0 group by l.code`, [ITEM]);
  const byLocation = Object.fromEntries(rows.map((r) => [r.code, r.qty]));
  return { total: rows.reduce((s, r) => s + r.qty, 0), byLocation };
}
const dialog = (page) => page.locator('dialog[open]');
async function signOut(page) {
  await open(page, '/orders/#/home', '#account-btn');
  await page.click('#account-btn');
  await page.click('#menu-sign-out');
  await expect(page.locator('#auth-form')).toBeVisible();
}

test.describe('inventory', () => {
  test.describe.configure({ mode: 'serial' });
  /** @type {import('@playwright/test').Page} */
  let page;
  let problems;
  let itemUrl;

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

  test('setup: a CE division with a subsystem, and two cabinets', async () => {
    await open(page, '/inventory/#/inventory/setup/org', '[data-add-div]');
    await page.click('[data-add-div]');
    await dialog(page).locator('#o-name').fill('Powertrain');
    await dialog(page).getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.inv-org')).toContainText('Powertrain');
    await page.click('[data-add-sub]');
    await dialog(page).locator('#o-names').fill('Battery\nMotor controller');
    await dialog(page).getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.inv-org-subs')).toContainText('Battery');

    await open(page, '/inventory/#/inventory/setup/locations', '[data-add]');
    for (const [code, name] of [['CAB-A', 'Cabinet A'], ['CAB-B', 'Cabinet B']]) {
      await page.click('[data-add]');
      await dialog(page).locator('#l-code').fill(code);
      await dialog(page).locator('#l-name').fill(name);
      await dialog(page).getByRole('button', { name: 'Save' }).click();
      await expect(page.locator('.inv-tree')).toContainText(code);
    }
  });

  test('make an item; receive 100 into Cabinet A; use 20 for Battery; move 30 to Cabinet B', async () => {
    await open(page, '/inventory/#/inventory/items/new', '#i-name');
    await page.fill('#i-name', ITEM);
    await page.fill('#i-mpn', '91292A112');
    await page.fill('#i-rp', '40');
    await page.getByRole('button', { name: 'Add item' }).click();
    await expect(page.locator('h1')).toContainText(ITEM);
    itemUrl = page.url();

    await page.click('[data-act="receive"]');
    await dialog(page).locator('#a-to').selectOption({ label: 'CAB-A · Cabinet A' });
    await dialog(page).locator('#a-qty').fill('100');
    await dialog(page).getByRole('button', { name: 'Add to stock' }).click();
    await expect(page.locator('.alert-success')).toContainText('100 ea available now');

    await page.click('.inv-actions [data-act="use"]');
    await dialog(page).locator('#a-qty').fill('20');
    await dialog(page).locator('#att-division').selectOption({ label: 'Powertrain' });
    await dialog(page).locator('#att-subsystem').selectOption({ label: 'Battery' });
    await dialog(page).getByRole('button', { name: 'Take it out' }).click();
    await expect(page.locator('.alert-success')).toContainText('80 ea available now');

    await page.click('.inv-actions [data-act="move"]');
    await dialog(page).locator('#a-to').selectOption({ label: 'CAB-B · Cabinet B' });
    await dialog(page).locator('#a-qty').fill('30');
    await dialog(page).getByRole('button', { name: 'Move it' }).click();
    await expect(page.locator('.alert-success')).toContainText('80 ea available now');

    expect(await stockOf(page)).toEqual({ total: 80, byLocation: { 'CAB-A': 50, 'CAB-B': 30 } });
  });

  test('Orders still approves and orders as before; receiving 50 of it in Inventory makes 130 and marks it Received', async () => {
    await open(page, '/orders/#/new', '#f-title');
    await page.fill('#f-title', 'Screws restock');
    await page.selectOption('#f-subsystem', { index: 1 });
    await page.fill('#f-needed_by', '2030-01-15');
    await page.fill('#f-justification', 'Running low on M3 screws.');
    await page.fill('#f-vendor', 'McMaster-Carr');
    const line = page.locator('tr[data-index="0"]');
    await line.locator('[data-ifield="item_name"]').fill('M3x8 SHCS');
    await line.locator('[data-ifield="product_link"]').fill('https://example.com/screws');
    await line.locator('[data-ifield="quantity"]').fill('50');
    await line.locator('[data-ifield="unit_price"]').fill('0.10');
    await page.getByRole('button', { name: 'Submit Request' }).click();
    await expect(page.locator('.alert-success')).toContainText('submitted for approval');
    const number = (page.url().match(/#\/requests\/([^/?]+)/) || [])[1];
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.locator('.alert-success')).toContainText('approved');
    await page.fill('#o-number', 'T-5150');
    await page.getByRole('button', { name: 'Mark as Ordered' }).click();
    await expect(page.locator('.alert-success')).toContainText('marked as ordered');
    // The request page now offers receiving it in Inventory.
    await expect(page.locator('#inventory-panel')).toContainText('Receive in Inventory');

    await open(page, `/inventory/#/inventory/receive/${number}`, '[data-line]');
    await page.click('[data-link]');
    await dialog(page).locator('[data-q]').fill('M3x8');
    await dialog(page).locator('[data-items]').selectOption({ index: 0 });
    await dialog(page).getByRole('button', { name: 'Link' }).click();
    await expect(page.locator('[data-line]')).toContainText(ITEM);

    await page.click('[data-receive]');
    await expect(dialog(page).locator('#r-qty')).toHaveValue('50');
    await dialog(page).locator('#r-loc').selectOption({ label: 'CAB-A · Cabinet A' });
    await dialog(page).getByRole('button', { name: 'Receive' }).click();
    await expect(page.locator('.alert-success')).toContainText('The request is now Received in Orders');

    expect(await stockOf(page)).toEqual({ total: 130, byLocation: { 'CAB-A': 100, 'CAB-B': 30 } });
    const [req] = await sql(page, 'select status from requests where request_number = $1', [number]);
    expect(req.status).toBe('Received');
    await open(page, `/orders/#/requests/${number}`, '#inventory-panel .card');
    await expect(page.locator('#inventory-panel')).toContainText('50 of 50');
    await expect(page.locator('.timeline')).toContainText('Received in Inventory');
  });

  test('stock by location, the division → subsystem report, and the history', async () => {
    await page.goto(itemUrl);
    await expect(page.locator('.inv-big')).toContainText('130 ea');
    const where = page.locator('section', { hasText: 'Where it is' });
    await expect(where.locator('tr', { hasText: 'CAB-A' })).toContainText('100 ea');
    await expect(where.locator('tr', { hasText: 'CAB-B' })).toContainText('30 ea');
    const history = page.locator('[data-history]');
    for (const what of ['Received from Orders', 'Received', 'Used', 'Moved']) await expect(history).toContainText(what);
    await expect(history).toContainText('Battery');

    await open(page, '/inventory/#/inventory/reports?from=&to=', '.inv-roll');
    const powertrain = page.locator('.inv-roll', { hasText: 'Powertrain' });
    await expect(powertrain).toContainText('Battery');
    await expect(powertrain).toContainText('20 ea');
  });

  test('a QR label opens the item, and a use can be recorded from it', async () => {
    await page.goto(itemUrl);
    await page.click('[data-print-label]');
    await expect(page.locator('.inv-label svg')).toHaveCount(1);
    // The address in the code (the QR round-trip itself is checked in tests/inventoryModules.test.mjs).
    const itemId = itemUrl.split('/').pop();
    const target = await page.evaluate(async (id) => (await import('/orders/js/views/inventory/labels.js')).labelUrl('item', id), itemId);
    expect(target).toContain(`inventory/#/inventory/items/${itemId}`);
    await page.goto(target);
    await expect(page.locator('h1')).toContainText(ITEM);
    await page.click('.inv-actions [data-act="use"]');
    await dialog(page).locator('#a-from').selectOption({ index: 0 });
    await dialog(page).locator('#a-qty').fill('2');
    await dialog(page).locator('#att-division').selectOption({ label: 'General shop (not for one subsystem)' });
    await dialog(page).getByRole('button', { name: 'Take it out' }).click();
    await expect(page.locator('.alert-success')).toContainText('128 ea available now');
  });

  test('count Cabinet B, find 28 not 30, apply the correction', async () => {
    await open(page, '/inventory/#/inventory/counts', '[data-start]');
    await page.click('[data-start]');
    await dialog(page).locator('#c-name').fill('Cabinet B check');
    await dialog(page).locator('#c-loc').selectOption({ label: 'CAB-B · Cabinet B' });
    await dialog(page).getByRole('button', { name: 'Start' }).click();
    await expect(page.locator('h1')).toContainText('Cabinet B check');
    const input = page.locator('[data-count]');
    await input.fill('28');
    await input.press('Enter');
    await expect(input).toHaveClass(/is-saved/);
    await expect(page.locator('[data-diff]')).toContainText('−2');
    await page.click('[data-submit]');
    await dialog(page).getByRole('button', { name: 'Submit' }).click();
    await expect(page.locator('.alert-success')).toContainText('Submitted');
    await page.click('[data-apply]');
    await dialog(page).getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('.alert-success')).toContainText('Applied: 1 correction');
    expect(await stockOf(page)).toEqual({ total: 126, byLocation: { 'CAB-A': 98, 'CAB-B': 28 } });
  });

  test('a member can use parts but not receive or correct; a Guest can\'t open Inventory', async () => {
    // Same browser (the fake database lives in it): sign the lead out, then sign up as a member.
    await signOut(page);
    const member = page;
    const memberProblems = problems;
    await signUp(member, MEMBER, ['member']);
    await member.goto(itemUrl.replace(/^.*?\/inventory\//, '/inventory/'));
    await expect(member.locator('h1')).toContainText(ITEM);
    await expect(member.locator('.inv-actions [data-act="use"]')).toBeVisible();
    for (const act of ['receive', 'correct', 'release']) await expect(member.locator(`.inv-actions [data-act="${act}"]`)).toHaveCount(0);
    await expect(member.locator('#main-nav [data-nav="inv-receive"]')).toBeHidden();
    // The database refuses it too, whatever the page shows.
    const refused = await member.evaluate(async () => {
      const { supabase } = await import('/orders/js/supabase.js');
      const [{ data: item }] = [await supabase.from('inventory_items').select('id').limit(1).single()];
      const { data: loc } = await supabase.from('inventory_locations').select('id').eq('code', 'CAB-A').single();
      const op = () => crypto.randomUUID();
      const r1 = await supabase.rpc('inventory_receive', { p_op: op(), p: { item_id: item.id, location_id: loc.id, qty: 5 } });
      const r2 = await supabase.rpc('inventory_adjust', { p_op: op(), p: { item_id: item.id, location_id: loc.id, set_to: 500, expected: 98, reason: 'nope' } });
      return [r1.error?.message || 'allowed', r2.error?.message || 'allowed'];
    });
    for (const msg of refused) expect(msg).toMatch(/Receive|Manage|permission|can't|isn't allowed/i);
    expect(await stockOf(member)).toEqual({ total: 126, byLocation: { 'CAB-A': 98, 'CAB-B': 28 } });
    expect(memberProblems.splice(0).filter((p) => !/403|401|Forbidden|permission/i.test(p))).toEqual([]);

    await signOut(page);
    const guest = page;
    await signUp(guest, GUEST, []);
    await guest.goto('/inventory/#/inventory');
    await expect(guest.locator('#app')).toContainText(/accept|waiting|Guest/i);
    await expect(guest.locator('.inv-actions, [data-restock]')).toHaveCount(0);
  });
});
