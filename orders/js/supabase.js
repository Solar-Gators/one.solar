/**
 * The shared Supabase client.
 * The library version is pinned exactly (npm test refuses a floating "@2"): 2.119.0 is what "@2" served
 * when it was pinned (2026-11-13), so nothing changed for users. Upgrade on purpose, in its own change,
 * and run the release checklist (docs/RELEASING.md).
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './site-config.js';

export const isConfigured = !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_ANON_KEY.startsWith('YOUR-');

export const supabase = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        // PKCE puts the email-link code in "?code=…" instead of the URL hash,
        // which keeps it out of the way of the hash router (#/requests …).
        flowType: 'pkce',
        detectSessionInUrl: true,
        persistSession: true,
      },
    })
  : null;

/** The URL email links should return to (works on localhost and GitHub Pages). */
export const siteUrl = () => `${location.origin}${location.pathname}`;
