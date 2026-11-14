/**
 * Low stock → an Orders request. Inventory doesn't buy anything itself: it starts a draft request in Orders (one per
 * supplier, since a request has one vendor) filled in from the items' preferred supplier, and links each line to
 * its catalog item so receiving it later is one click. The requester checks the draft and submits it as usual.
 */
import { api } from '../../api.js';
import { inv } from '../../inventory/api.js';
import { suggestedOrder } from '../../inventory/core.js';
import { appUrl } from '../../../../shared/onesolar.js';

/** items: overview rows. Returns [{ supplier, number, href, lines }]. */
export async function startRestockRequests(items) {
  const parts = await inv.supplierParts();
  const groups = new Map();
  for (const item of items) {
    const mine = parts.filter((p) => p.item_id === item.id);
    const sp = mine.find((p) => p.preferred) || mine[0] || null;
    const supplier = sp?.supplier || '';
    if (!groups.has(supplier)) groups.set(supplier, []);
    const pack = Number(sp?.pack_qty) || 1;
    groups.get(supplier).push({ item, sp, pack, packs: Math.max(1, Math.ceil(suggestedOrder(item) / pack)) });
  }
  const made = [];
  for (const [supplier, lines] of groups) {
    const names = lines.map((l) => l.item.name);
    const number = await api.saveRequest(null, {
      action: 'draft',
      request: {
        title: `Restock: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`.slice(0, 200),
        justification: `Low in Inventory: ${lines.map((l) => `${l.item.name} (${l.item.sku}) has ${l.item.available} ${l.item.unit} available, reorder point ${l.item.reorder_point}`).join('; ')}.`,
      },
      items: lines.map((l) => ({
        item_name: l.item.name,
        vendor: supplier,
        part_number: l.sp?.supplier_pn || l.item.mpn || '',
        product_link: l.sp?.url || '',
        quantity: l.packs,
        unit_price: l.sp?.last_price ?? '',
        notes: `${l.item.sku}${l.pack > 1 ? `, pack of ${l.pack} ${l.item.unit}` : ''}`,
      })),
    });
    // Link the new lines to their items (a draft that's edited later may lose this; receiving then suggests the match by part number).
    const req = await api.getRequest(number).catch(() => null);
    for (const [i, line] of (req?.items || []).entries()) {
      const l = lines[i];
      if (l) await inv.linkOrderLine(line.id, l.item.id, l.pack).catch(() => {});
    }
    made.push({ supplier: supplier || 'No supplier yet', number, href: appUrl(`orders/#/requests/${encodeURIComponent(number)}/edit`), lines: lines.length });
  }
  return made;
}
