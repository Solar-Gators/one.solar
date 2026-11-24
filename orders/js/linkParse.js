/**
 * Reading what someone typed or pasted into a "Link a record" picker (069). No page or database code here, so the
 * tests can load it.
 */
/**
 * A pasted one.solar link, as the record it points at: { kind, id } or { kind, code }, or null when it isn't one.
 * Goes by the page part after "#", so a link from any copy of the site works.
 */
export function linkFromUrl(text) {
  const s = String(text || '').trim();
  if (!/^https?:\/\/\S+#\//.test(s)) return null;
  const uuid = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
  const rules = [
    [new RegExp(`#/requests/([A-Za-z0-9-]+)`), 'order', 'code'],
    [new RegExp(`#/inventory/items/${uuid}`, 'i'), 'inventory', 'id'],
    [new RegExp(`#/events/e/${uuid}`, 'i'), 'event', 'id'],
    [new RegExp(`#/sponsors/${uuid}`, 'i'), 'sponsor', 'id'],
    [new RegExp(`#/projects/item/([A-Za-z0-9-]+)`), 'item', 'code'],
  ];
  for (const [re, kind, what] of rules) {
    const m = s.match(re);
    if (m) return { kind, [what]: what === 'code' ? decodeURIComponent(m[1]).toUpperCase() : m[1].toLowerCase() };
  }
  return null;
}

/** Matches with the one whose code is exactly what was typed first (so typing "SG27-900" and Enter picks it). */
export const exactFirst = (rows, text) => {
  const t = String(text || '').trim().toUpperCase();
  return [...rows].sort((a, c) => (String(c.code || '').toUpperCase() === t) - (String(a.code || '').toUpperCase() === t));
};
