/**
 * Current user: Supabase session + profile (name, role) + permissions.
 *
 * Permissions come from the database (role_permissions table), so the UI and
 * the server-side checks in supabase/schema.sql always agree. The UI only
 * uses them to decide what to SHOW; the database enforces them.
 */
import { supabase, siteUrl } from './supabase.js';
import { emailLink } from './emailLink.js';

const state = {
  session: null,
  profile: null,
  permissions: new Set(),
  roles: [],
  recovering: false, // true after opening a password-reset link
  removed: false, // signed in, but the account was removed (035): signed out with a note
};

async function loadProfile() {
  const uid = state.session?.user?.id;
  if (!uid) {
    state.profile = null;
    state.permissions = new Set();
    return;
  }
  const [{ data: profile, error }, { data: roles }] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', uid).maybeSingle(),
    supabase.from('roles').select('*').order('sort'),
  ]);
  if (error) throw error;
  state.roles = roles || [];
  state.profile = profile;
  if (!profile) {
    // Their account was removed while they were signed in: sign out, and say why on the sign-in page.
    state.removed = true;
    state.session = null;
    state.permissions = new Set();
    await supabase.auth.signOut().catch(() => {});
    return;
  }

  // A person can have several roles (migration 008); before that, one `role` column.
  const { data: mine, error: rolesError } = await supabase.from('profile_roles').select('role').eq('user_id', uid);
  profile.roles = rolesError ? [profile.role].filter(Boolean) : mine.map((r) => r.role);
  // 040: new accounts are Guests (no rows would mean the same to the database) until someone accepts them.
  if (!profile.roles.length) profile.roles = ['guest'];

  const { data: perms } = await supabase.from('role_permissions').select('permission').in('role', profile.roles);
  state.permissions = new Set((perms || []).map((p) => p.permission));
}

export const auth = {
  get signedIn() {
    return !!state.session;
  },
  /** { id, email, full_name, roles: [roleKey, ...] } or null */
  get user() {
    return state.profile;
  },
  get displayName() {
    return state.profile?.full_name || state.profile?.email || '';
  },
  /** e.g. "Treasurer · Admin" (Member is only shown when it's the only role). */
  get roleLabel() {
    const mine = state.profile?.roles || [];
    const labels = state.roles.filter((r) => mine.includes(r.key)).map((r) => r.label);
    const shown = labels.length > 1 ? state.roles.filter((r) => mine.includes(r.key) && r.key !== 'member').map((r) => r.label) : labels;
    return shown.join(' · ') || 'Member';
  },
  /**
   * Signed in, but not on the team: not accepted yet (040, Guest) or deactivated (044, Former member).
   * Either way they see only the public apps.
   */
  get isGuest() {
    const mine = state.profile?.roles || [];
    return !!state.profile && mine.every((r) => r === 'guest' || r === 'alumni');
  },
  /** Deactivated (044): was on the team, isn't any more. */
  get isFormer() {
    return (state.profile?.roles || []).includes('alumni');
  },
  /** 052: signed up on SGAA (the alumni hub) to join as an alum, with any email address. */
  get signedUpAsAlum() {
    return state.session?.user?.user_metadata?.sgaa === 'alum';
  },
  /** Does the signed-in person have this role? */
  hasRole(key) {
    return (state.profile?.roles || []).includes(key);
  },
  get roles() {
    return state.roles;
  },
  /** 043: only accounts with a confirmed email address can be accepted. */
  get emailConfirmed() {
    const u = state.session?.user;
    return !!(u?.email_confirmed_at || u?.confirmed_at);
  },
  get recovering() {
    return state.recovering;
  },
  /** Set when an account was removed while signed in (shown once on the sign-in page). */
  get removed() {
    return state.removed;
  },
  can(permission) {
    return state.permissions.has(permission);
  },

  /** Load the current session and re-run `onChange(event)` when it changes. */
  async init(onChange) {
    const { data } = await supabase.auth.getSession();
    state.session = data.session;
    await loadProfile();

    supabase.auth.onAuthStateChange((event, session) => {
      const userChanged = session?.user?.id !== state.session?.user?.id;
      state.session = session;
      if (event === 'PASSWORD_RECOVERY') state.recovering = true;
      // Token refreshes also fire events; only re-render when the user changes.
      // (Supabase advises not awaiting its own calls inside this callback.)
      if (userChanged || event === 'PASSWORD_RECOVERY' || event === 'SIGNED_OUT') {
        setTimeout(async () => {
          await loadProfile().catch(() => {});
          onChange(event);
        }, 0);
      }
    });
    // A password-reset link announces itself while the page loads, usually before the listener above exists
    // (emailLink.js catches it). Either way, open "Choose a new password" instead of Home.
    if (emailLink.recovery && state.session) state.recovering = true;
  },

  async refresh() {
    await loadProfile();
  },

  async signIn(email, password) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  },

  /** Returns true if the user must confirm their email before signing in. */
  async signUp({ email, password, fullName }) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName }, emailRedirectTo: siteUrl() },
    });
    if (error) throw error;
    return !data.session;
  },

  /** Send the confirm-your-email link again (Supabase allows one a minute per address). */
  async resendConfirmation(email) {
    const { error } = await supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo: siteUrl() } });
    if (error) throw error;
  },

  async sendPasswordReset(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: siteUrl() });
    if (error) throw error;
  },

  /** Use a token_hash email link (emailLink.js). A reset link then opens "Choose a new password" (PASSWORD_RECOVERY). */
  async verifyEmailLink(tokenHash, type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (error) throw error;
  },

  async updatePassword(password) {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
    state.recovering = false;
  },

  /**
   * A new email address (052: alumni lose their UF address after graduating). Supabase emails a link to the new
   * address (and, with "Secure email change" on, to the old one too); the address changes once it's used.
   * Returns true when it changed right away (no confirmation needed).
   */
  async changeEmail(email) {
    const { data, error } = await supabase.auth.updateUser({ email }, { emailRedirectTo: siteUrl() });
    if (error) throw error;
    const changed = (data?.user?.email || '').toLowerCase() === email.toLowerCase();
    if (changed) await loadProfile();
    return changed;
  },

  async signOut() {
    await supabase.auth.signOut();
  },
};
