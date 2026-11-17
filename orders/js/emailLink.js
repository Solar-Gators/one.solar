/**
 * What an email link (password reset, confirm your email) brought back, read once as the page loads.
 *
 * Two things went wrong before this file existed:
 *  - Supabase announces "this was a password-reset link" (PASSWORD_RECOVERY) a moment after the page loads,
 *    before auth.init() starts listening, so the event was missed: the person was signed in and sent to Home
 *    instead of "Choose a new password". We listen here, as soon as the client exists, and remember it.
 *  - main.js tidies "?code=… / ?error=…" out of the address before the sign-in page draws, so an expired or
 *    already-used link failed silently. We read them here first.
 */
import { supabase } from './supabase.js';

const query = new URLSearchParams(location.search);
const hash = new URLSearchParams(location.hash.replace(/^#\/?/, '')); // some errors come back as #error=…

export const emailLink = {
  /** The page was opened from an email link (Supabase swaps it for a sign-in as the page loads). */
  code: query.has('code'),
  error: query.get('error_description') || hash.get('error_description') || '',
  errorCode: query.get('error_code') || hash.get('error_code') || '',
  /** Set when Supabase says the link was a password reset. */
  recovery: false,
};

supabase?.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') emailLink.recovery = true;
});

/** An error the link came back with sits in the hash (#error=…): it isn't a page, so clear it before the router reads it. */
export function clearLinkErrorFromHash() {
  if (hash.has('error') || hash.has('error_description')) history.replaceState(null, '', location.pathname + location.search);
}

/** What to tell someone on the sign-in page about the link they just used ('' if nothing went wrong). */
export function emailLinkProblem(signedIn) {
  if (emailLink.errorCode === 'otp_expired' || /expired|invalid/i.test(emailLink.error)) {
    return 'That email link has expired or was already used. Each link works once, for a limited time. Ask for a new one below.';
  }
  if (emailLink.error) return emailLink.error;
  // A code that didn't turn into a sign-in: almost always opened in a different browser or device than the one
  // that asked for it (the link only works where "Send reset link" or "Create account" was clicked).
  if (emailLink.code && !signedIn) {
    return 'That email link has to be opened in the same browser you asked for it from. Open it there, or ask for a new one below.';
  }
  return '';
}
