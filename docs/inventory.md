# Inventory

What the shop has, where it is, who used it and for what. Address: **`/inventory/`**. Needs the database update
[`supabase/migrations/050_inventory.sql`](../supabase/migrations/050_inventory.sql); until it's applied, every page says
"Inventory isn't set up yet" and nothing else changes.

## Using it

| Page | What it's for |
| --- | --- |
| **Inventory** (dashboard) | Low or out of stock, deliveries waiting to be received, lots expiring, items due for a count, recent activity. "Start an Orders request" makes a **draft** Orders request for what's low (one per supplier); it's approved and ordered as usual. |
| **Items** | The catalog: search by name, SKU, manufacturer or supplier part number; filter by category, location or state; download Excel; print labels. |
| **An item** | Where it's kept (location, lot, quantity), big **Use / Put back / Receive / Move / Set aside / Release / Correct** buttons, lots and expiry, suppliers, safety information, its label, its history (with Undo) and every change to its record. A scanned label opens this page. |
| **A location** | What's in it and in the places inside it, with Use / Move on each line. |
| **Receive** | Ordered Orders lines not all here yet. Receive part of a line (6 of 10 now, 4 later), into stock at a location, **straight to a subsystem** (used on arrival, never on a shelf), or as **not an inventory item** (a service, a one-off). Link a line to the catalog first; the only suggestion is an exact part-number match. "Receive something else" is for stock that didn't come through Orders. |
| **Activity** | Every stock change, filtered by item, location, kind and dates; Undo; Excel download. |
| **Counts** | Start a count (a location and what's inside it, a category, a count class, or only what's due), type what's on the shelf, add anything found, submit, apply. |
| **Reports** | What was used, by CE division → subsystem, item, person, project and month, for a date range; Excel download. |
| **Settings** | Locations, categories, CE divisions & subsystems, settings, and importing a spreadsheet. |
| **Scan** | Scan a QR label with the camera (browsers with the built-in barcode reader, e.g. Chrome on Android) or type a SKU / location code. Any phone camera app also opens a label directly. |

**What it's for.** Every use, put-back and direct-to-subsystem receipt says which **CE division** (and, if it's for
one, which **subsystem**) it was for, or **General shop**. People's last choice is remembered. Each use counts once
in the reports: in its subsystem, as "whole division", or as General shop. Renaming a division or subsystem keeps
history right (each entry keeps the name it had); moving a subsystem to another division keeps earlier use with
the division it was recorded under. The list is edited in Inventory → Settings or **Admin → CE divisions & subsystems**
("Copy from Solar Evals" fills it from the CE tracks the first time).

**History is permanent.** Nothing is edited or deleted: Undo adds an entry that puts stock back. You can undo your
own use / put-back / move / receipt for a day; inventory managers can undo anything once. Undoing an Orders receipt
un-marks the line as arrived (if the request is still Ordered).

**Lots and safety.** Items marked "Track lots" (epoxies, resins, adhesives, chemicals, cells) ask for a lot, expiry
and retest date on receipt; expired, damaged or suspect lots can't be used or released until fixed. Hazardous items
show their hazard classes, SDS link and storage notes. This complements UF's official hazardous-material inventory
and safety procedures; it doesn't replace them.

### Who can do what

| Permission | Lets you | Given by default to |
| --- | --- | --- |
| `inventory.view` See Inventory | look at everything in Inventory | every role except Guest / Alumni |
| `inventory.use` Use parts | take parts out and put them back | every role except Guest / Alumni |
| `inventory.receive` Receive & move stock | receive (Orders deliveries and by hand), move, set aside, add items | CE, Treasurer, Inventory manager, Admin |
| `inventory.count` Count stock | run counts and apply small differences | CE, Inventory manager, Admin |
| `inventory.manage` Manage inventory | edit items, locations, settings, import; correct stock; release set-aside stock; approve big count differences; undo anything | Inventory manager, Admin |

A new role, **Inventory manager**, has all five. Change any of this in Admin → Roles & permissions. The database
checks every change (the buttons only hide what you can't do).

### Reserved for projects (061)

When a Projects item links a part and says how many it needs, that many are **reserved** while the item is open (not done, not archived). The part's page shows **Reserved for projects**: the total, what's free after it (or how much more than available), and which items, with links (items in private projects show only as "a private project"). Nothing is taken out of stock: someone still uses the parts as usual.

## How it's built

- **Pages:** [`inventory/index.html`](../inventory/index.html) (`<body data-app="inventory">`) loads the shared
  `orders/js/main.js`; routes are in [`router.js`](../orders/js/router.js) (`#/inventory/…`). Views are in
  [`orders/js/views/inventory/`](../orders/js/views/inventory); pure logic (tested in Node) in
  [`orders/js/inventory/`](../orders/js/inventory): `core.js` (units, states, links, lots), `importer.js`
  (CSV/Excel import checks), `reports.js` (rollups), `qr.js` (QR SVGs with the vendored, MIT-licensed
  [`shared/vendor/qrcode-generator.mjs`](../shared/vendor/qrcode-generator.mjs)), `api.js` (every read and RPC).
  Styles: [`orders/css/inventory.css`](../orders/css/inventory.css).
- **Database (050):** tables `inventory_*` and `org_divisions` / `org_subsystems`; row-level security lets anyone with
  an Inventory permission read; **every change is a `security definer` function** that checks permissions, locks
  the item row, keeps stock (`inventory_stock`, never negative) and history (`inventory_movements`, permanent) together.
- **Each stock change has an operation id** made by the page; sending it twice (a retry after a lost reply) does
  nothing the second time and returns the first result.
- **Counts** remember, per line, the stock when it was counted; applying corrects by (counted − that), so parts
  taken out during the count aren't lost. A line whose stock changed after it was counted has to be recounted.
- **Orders:** ordering never adds stock. Only Ordered or Received requests can be received. A line is "arrived" in
  Orders once Inventory has received all of it; the request becomes Received when every line has arrived. Orders
  can't delete a line or lower its quantity below what Inventory has received (trigger `inv_guard_order_line`).
  Receipts show in the request's history ("Received in Inventory") and in a panel on the request page.
- **Errors the pages handle:** `OS409` stock changed since the page looked, `OS410` this file was imported before,
  `OS412` looks like an item already in the catalog, `OS422` not that much there (or still to come).

### What 050 changes outside Inventory

- New permissions `inventory.*`, the role `inventory_manager`, default grants, and a permissions snapshot (Admin → History).
- `request_items.arrived_via_inventory` (new column), the trigger `inv_guard_order_line` on `request_items`, and
  `'inventory'` added to `request_events_kind_check`.
- `app_settings` row `inventory` (count frequency, approval thresholds, expiry warning, blind counts).

## Tests

- `node tests/inventory.test.mjs`: the database (permissions, stock rules, idempotency, undo, lots, Orders
  integration, counts, import, reports, access by role).
- `node tests/inventoryModules.test.mjs`: the pure modules, including a QR encode → decode round trip.
- `npx playwright test tests/e2e/inventory.spec.mjs`: the whole flow in a browser on the fake backend.
- All are part of `npm test` / `npm run test:smoke`.

## Deploying

1. Open a PR with the branch. CI runs every test; with auto-merge on, it merges when "Tests" pass.
2. Supabase's GitHub integration applies `050_inventory.sql` when it reaches `main` (it's the next file after 049).
   Or run it yourself in the SQL editor if the integration is off. It's one transaction: all or nothing.
3. Check: the yellow "database needs an update" banner is gone for Admins; open `/inventory/`; the home screen shows the Inventory card
   to people with an Inventory permission.
4. First setup (an inventory manager or Admin): Settings → **CE divisions & subsystems** (or "Copy from Solar Evals"),
   **Locations** (shop → cabinets → shelves/bins), **Categories**, then add items or **Import a spreadsheet**, then
   print labels (Items → Print labels, Settings → Locations → Print all labels).
5. Give people the **Inventory manager** role in Admin → Users if someone other than Admins runs the shop.

Nothing else needs configuring: no new secrets, Edge Functions, buckets or GitHub settings.

## Rolling back

- **The pages:** revert the PR. The database keeps working for Orders; the Inventory pages disappear.
- **Hide Inventory but keep the data:** in Admin → Roles & permissions, untick the Inventory permissions for the roles
  that shouldn't have it. The home-screen card, the pages and the database functions then refuse those roles.
- **The database:** don't drop it unless you're sure; history is permanent on purpose. If you must undo 050 on a
  database with no inventory data, drop in this order: the trigger `inv_guard_order_line` on `request_items`, the
  `inventory_*` and `org_*` tables and `inv_*` / `inventory_*` / `org_*` functions, the column
  `request_items.arrived_via_inventory`, the `inventory.*` permissions and role grants, the `inventory_manager` role, the
  `inventory` app setting; put `request_events_kind_check` back without `'inventory'` (delete any `request_events`
  rows of kind `inventory` first); and delete 050 from the migration ledger (041). Then set `REQUIRED_SCHEMA_VERSION` back
  to 49. Test it on a copy first.

## Known limits

- Concurrency is enforced by row locks and the never-negative constraint; the fake backend is single-connection, so
  the tests check the locks and constraint rather than racing two sessions.
- Costs in reports are estimates (the item's unit cost, or the Orders price per unit when received from an order).
- Scanning inside one.solar needs a browser with `BarcodeDetector` (Chrome on Android, recent Chromium); elsewhere
  use the phone's camera app, or type the code.
- Labels print from the browser (plain paper or label sheets, then cut); there's no label-printer driver.
