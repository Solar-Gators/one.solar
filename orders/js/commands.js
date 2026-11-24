/**
 * What Orders, Inventory, Projects, Events, Sponsors, Finances and Admin add to the Ctrl/⌘ + K palette
 * (shared/command-palette.js): things to start and pages to open, each only for people allowed to use it.
 * main.js calls registerAppCommands() whenever the page redraws, so signing in or a role change shows up.
 */
import { auth } from './auth.js';
import { appUrl } from '../../shared/onesolar.js';
import { registerCommands } from '../../shared/command-palette.js';
import { ADMIN_TABS } from './views/admin.js';
import { INV_PERMS } from './views/inventory/kit.js';
import { PM_PERMS } from './views/projects/kit.js';

let unregister = null;

export function registerAppCommands() {
  unregister?.();
  if (!auth.signedIn || auth.isGuest) return void (unregister = null);
  const any = (perms) => perms.some((p) => auth.can(p));
  const cmd = (id, title, href, keywords = '', icon = '＋') => ({ id, title, href: appUrl(href), keywords, icon });
  const list = [
    cmd('new-request', 'New request', 'orders/#/new', 'order buy purchase part'),
    cmd('my-requests', 'My requests', 'orders/#/requests', 'orders list', '→'),
    any(['request.review']) && cmd('approvals', 'Requests to approve', 'orders/#/approvals', 'queue review approve', '→'),
    any(['request.order']) && cmd('to-order', 'Requests to order', 'orders/#/treasurer', 'queue treasurer buy', '→'),
    any(INV_PERMS) && cmd('inv-find', 'Inventory items', 'inventory/#/inventory/items', 'inventory stock parts search', '→'),
    any(['inventory.receive', 'inventory.manage']) && cmd('inv-new', 'Add an inventory item', 'inventory/#/inventory/items/new', 'inventory new part create'),
    any(['inventory.receive', 'inventory.manage']) && cmd('inv-receive', 'Receive parts', 'inventory/#/inventory/receive', 'inventory delivery check in'),
    any(INV_PERMS) && cmd('inv-scan', 'Scan a label', 'inventory/#/inventory/scan', 'inventory qr barcode camera', '→'),
    any(PM_PERMS) && cmd('pm-mine', 'My work', 'projects/#/projects', 'projects tasks assigned', '→'),
    any(PM_PERMS) && cmd('pm-all', 'All projects', 'projects/#/projects/all', 'projects', '→'),
    cmd('ev-mine', 'My events', 'events/#/events', 'events meetings rsvp', '→'),
    any(['events.create']) && cmd('ev-new', 'New event', 'events/#/events/new', 'events meeting create'),
    any(['sponsors.view', 'sponsors.edit']) && cmd('sponsors', 'Sponsor board', 'sponsors/#/sponsors', 'sponsors donors', '→'),
    any(['finances.view', 'finances.edit']) && cmd('finances', 'Finances', 'finances/#/finances', 'money budget ledger treasurer', '→'),
    ...ADMIN_TABS.filter(([, , perms, , hidden]) => !hidden && any(perms))
      .map(([key, label, , group]) => ({ ...cmd(`admin-${key}`, `Admin: ${label}`, `admin/#/admin/${key}`, `settings ${group}`, '⚙') })),
  ].filter(Boolean);
  unregister = registerCommands(list);
}
