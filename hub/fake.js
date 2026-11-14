/**
 * A made-up Supabase client for trying the home screen on localhost (?fake).
 *   ?fake              a Member
 *   ?fake=ce           Chief Engineer (accepts new people, 043)
 *   ?fake=admin        Admin (✎ Edit home screen; saved in this browser)
 *   ?fake=treasurer    Treasurer (Finances, Queue)
 *   ?fake=coordinator  Business Coordinator (Sponsors, Finances)
 *   ?fake=guest        a Guest: signed up, not accepted into the team yet (040)
 *   ?fake=alumni       a former member (deactivated, 044)
 *   ?fake=out          signed out
 * Only loaded on localhost; it never talks to the real database.
 */
const PERMS = {
  guest: [],
  alumni: [],
  member: [],
  admin: ['users.manage', 'workflow.edit', 'site.customize', 'settings.edit', 'request.review', 'request.order', 'finances.view', 'sponsors.view', 'people.accept'],
  ce: ['request.review', 'sponsors.view', 'evals.write', 'evals.view', 'people.accept'],
  treasurer: ['request.order', 'finances.view', 'finances.edit', 'sponsors.view'],
  coordinator: ['sponsors.view', 'sponsors.edit', 'finances.view'],
};
// People waiting to be accepted (040), for those who can accept them (Admin, CE, E-board since 043).
let waiting = [
  { id: 'fake-guest-1', full_name: 'Sam Newcomer', email: 'sam.newcomer@ufl.edu', created_at: new Date(Date.now() - 864e5).toISOString(), email_confirmed: true },
  { id: 'fake-guest-2', full_name: '', email: 'j.doe@ufl.edu', created_at: new Date(Date.now() - 3 * 864e5).toISOString(), email_confirmed: false },
];

export function createFakeClient(kind) {
  let role = kind && PERMS[kind] ? kind : 'member';
  let signedIn = kind !== 'out';
  const user = { id: 'fake-user', email: 'riley@ufl.edu' };
  const KEY = 'fake-onesolar-settings';
  const stored = () => {
    try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
  };
  // Logo, accent and banner: set localStorage "fake-onesolar-appearance" to try them, e.g.
  // {"announcement":{"text":"No orders during finals week","tone":"warning"}}
  const storedLook = () => {
    try { return JSON.parse(localStorage.getItem('fake-onesolar-appearance')); } catch { return null; }
  };
  const rows = {
    profiles: () => [{ full_name: 'Riley Tester', email: user.email, created_at: new Date(Date.now() - 2 * 864e5).toISOString() }],
    profile_roles: () => [{ role }],
    role_permissions: () => PERMS[role].map((permission) => ({ permission })),
    roles: () => [
      { key: 'guest', label: 'Guest' }, { key: 'member', label: 'Member' }, { key: 'ce', label: 'Chief Engineer' }, { key: 'treasurer', label: 'Treasurer' },
      { key: 'coordinator', label: 'Business Coordinator' }, { key: 'admin', label: 'Admin' },
    ],
    app_settings: () => [
      ...(stored() ? [{ key: 'onesolar', value: stored() }] : []),
      ...(storedLook() ? [{ key: 'appearance', value: storedLook() }] : []),
    ],
  };
  const query = (table) => {
    // Settings can be read signed out, like the real database.
    const where = [];
    // Only app_settings is filtered (by key); the other tables already return just this person's rows.
    const result = () => {
      let data = signedIn || table === 'app_settings' ? rows[table]() : [];
      if (table === 'app_settings') data = data.filter((r) => where.every(([c, v]) => r[c] === v));
      return { data, error: null };
    };
    const q = {
      select: () => q,
      eq: (c, v) => (where.push([c, v]), q),
      in: () => q,
      order: () => q,
      maybeSingle: async () => ({ data: result().data[0] || null, error: null }),
      then: (ok, bad) => Promise.resolve(result()).then(ok, bad),
    };
    return q;
  };
  return {
    from: query,
    rpc: async (fn, { p_key, p_value, p_user } = {}) => {
      if (['waiting_guests', 'waiting_people', 'accept_member', 'decline_guest'].includes(fn)) {
        if (!PERMS[role].includes('people.accept')) return { data: null, error: { message: 'Your role does not allow this action (people.accept).' } };
        if (fn === 'accept_member' && waiting.find((w) => w.id === p_user)?.email_confirmed === false) {
          return { data: null, error: { message: "They haven't confirmed their email address yet." } };
        }
        if (fn === 'accept_member' || fn === 'decline_guest') waiting = waiting.filter((w) => w.id !== p_user);
        if (fn === 'waiting_guests') return { data: waiting.map(({ email_confirmed, ...w }) => w), error: null };
        return { data: fn === 'waiting_people' ? waiting : null, error: null };
      }
      if (fn !== 'update_settings' || p_key !== 'onesolar') return { error: { message: 'Not in fake mode.' } };
      if (!PERMS[role].includes('site.customize')) return { error: { message: 'Your role does not allow this action (site.customize).' } };
      localStorage.setItem(KEY, JSON.stringify(p_value));
      return { error: null };
    },
    auth: {
      getSession: async () => ({ data: { session: signedIn ? { user } : null } }),
      signInWithPassword: async ({ email, password }) => {
        if (!email || !password) return { error: { message: 'Invalid login credentials' } };
        signedIn = true;
        role = 'member';
        return { error: null };
      },
      signOut: async () => {
        signedIn = false;
        return { error: null };
      },
    },
  };
}
