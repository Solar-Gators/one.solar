/**
 * Plain-language messages (U-2): what a database or network error means for the person, and which
 * permission (and which roles) a page needs. No imports, so tests can load it in Node.
 */

const RAW_PERMISSION = /permission denied for (table|relation|function|schema|sequence)|violates row-level security|row-level security policy/i;
const OFFLINE = /failed to fetch|networkerror|network request failed|load failed|fetch failed|err_internet_disconnected/i;
const EXPIRED = /jwt expired|invalid jwt|refresh token|session (has )?expired|not authenticated/i;

export const OFFLINE_TEXT = "You're offline, or one.solar can't reach the database right now. Nothing was saved. Check your connection and try again.";
export const PERMISSION_TEXT = "Your role doesn't allow that. If you need to do it, ask an Admin or your Chief Engineer for a role that can.";
export const EXPIRED_TEXT = 'Your sign-in expired. Reload the page and sign in again; nothing you saved before this was lost.';

/**
 * The message to show for an error. Messages the database wrote for people (our RPCs' "Only an Admin can…",
 * a conflict's "X changed Y at 3:42 PM…") are kept as they are; raw Postgres and network errors are reworded.
 */
export function friendlyMessage(err) {
  const message = String(typeof err === 'string' ? err : err?.message ?? '').trim();
  const code = err?.code || '';
  if (code === 'OS409') return message; // already says who changed what, and to reload (045)
  if (OFFLINE.test(message) || (err?.name === 'TypeError' && /fetch/i.test(message))) return OFFLINE_TEXT;
  if (code === 'PGRST301' || code === 'PGRST303' || EXPIRED.test(message)) return EXPIRED_TEXT;
  if (RAW_PERMISSION.test(message) || (code === '42501' && !message)) return PERMISSION_TEXT;
  return message || 'Something went wrong. Try again, and use Report a problem if it keeps happening.';
}

/** '“Approve requests” or “Mark as ordered”' from permission keys. */
export function permissionNames(keys, permissions) {
  const label = (k) => `“${permissions.find((p) => p.key === k)?.label || k}”`;
  const names = [...new Set(keys)].map(label);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0] || '';
}

/** The roles (labels) that hold any of `keys`, Guests and former members never included. */
export function rolesWith(keys, rolePermissions, roles) {
  const holders = new Set(rolePermissions.filter((rp) => keys.includes(rp.permission)).map((rp) => rp.role));
  return roles.filter((r) => holders.has(r.key) && r.key !== 'guest' && r.key !== 'alumni').map((r) => r.label);
}

/** 'This page needs “Approve requests”. People with it: Chief Engineer, Admin.' */
export function needsText(keys, { permissions = [], rolePermissions = [], roles = [] } = {}) {
  const what = permissionNames(keys, permissions);
  const who = rolesWith(keys, rolePermissions, roles);
  return `This page needs ${what}.${who.length ? ` People with it: ${who.join(', ')}.` : ' No role has it right now; an Admin can add it under Admin → Roles.'}`;
}
