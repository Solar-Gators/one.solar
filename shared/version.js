/**
 * Which build of one.solar this page is, and which database it expects.
 *
 * VERSION is 'dev' in the repo; the deploy (tools/build-site.mjs --version=<sha>) writes the commit here and
 * in version.json, so an open page can tell when a newer build is live (shared/version-check.js).
 *
 * SCHEMA_VERSION is the database version (app_settings general.schemaVersion) this front end is built for:
 * the number of the newest file in supabase/migrations/. Bump it with orders/js/main.js REQUIRED_SCHEMA_VERSION
 * (tests/migrations.test.mjs and tests/version.test.mjs check them).
 */
export const VERSION = 'dev';
export const SCHEMA_VERSION = 48;
