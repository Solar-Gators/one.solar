/**
 * A made-up Supabase client for trying the home screen on localhost (?fake).
 *   ?fake              a Member
 *   ?fake=admin        Admin (✎ Edit home screen; saved in this browser)
 *   ?fake=treasurer    Treasurer (Finances, Queue)
 *   ?fake=coordinator  Business Coordinator (Sponsors, Finances)
 *   ?fake=out          signed out
 * Only loaded on localhost; it never talks to the real database.
 */
const PERMS = {
  member: [],
  admin: ['users.manage', 'workflow.edit', 'site.customize', 'settings.edit', 'request.review', 'request.order', 'finances.view', 'sponsors.view'],
  ce: ['request.review', 'sponsors.view', 'evals.write', 'evals.view'],
  treasurer: ['request.order', 'finances.view', 'finances.edit', 'sponsors.view'],
  coordinator: ['sponsors.view', 'sponsors.edit', 'finances.view'],
};

export function createFakeClient(kind) {
  let role = kind && PERMS[kind] ? kind : 'member';
  let signedIn = kind !== 'out';
  const user = { id: 'fake-user', email: 'riley@ufl.edu' };
  const KEY = 'fake-onesolar-settings';
  const stored = () => {
    try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
  };
  const rows = {
    profiles: () => [{ full_name: 'Riley Tester', email: user.email }],
    profile_roles: () => [{ role }],
    role_permissions: () => PERMS[role].map((permission) => ({ permission })),
    roles: () => [
      { key: 'member', label: 'Member' }, { key: 'ce', label: 'Chief Engineer' }, { key: 'treasurer', label: 'Treasurer' },
      { key: 'coordinator', label: 'Business Coordinator' }, { key: 'admin', label: 'Admin' },
    ],
    app_settings: () => (stored() ? [{ value: stored() }] : []),
  };
  const query = (table) => {
    // Settings can be read signed out, like the real database.
    const result = () => ({ data: signedIn || table === 'app_settings' ? rows[table]() : [], error: null });
    const q = {
      select: () => q,
      eq: () => q,
      in: () => q,
      order: () => q,
      maybeSingle: async () => ({ data: result().data[0] || null, error: null }),
      then: (ok, bad) => Promise.resolve(result()).then(ok, bad),
    };
    return q;
  };
  return {
    from: query,
    rpc: async (fn, { p_key, p_value }) => {
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
