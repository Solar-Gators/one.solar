/**
 * A small stand-in for what Supabase provides before our migrations run, shared by the database tests
 * and tools (tests/db.test.mjs, tests/migrations.test.mjs, tools/baseline.mjs).
 *
 * Like a real Supabase project, new tables, functions and sequences in `public` are granted to anon and
 * authenticated by default, so a migration that forgets a revoke behaves here the way it would live.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

export const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text not null, raw_user_meta_data jsonb default '{}',
                           email_confirmed_at timestamptz default now(), banned_until timestamptz);
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
`;

export const MIGRATIONS_DIR = new URL('../../supabase/migrations/', import.meta.url);

/** Migration files in order, e.g. ['001_initial.sql', …]. */
export const migrationFiles = () => readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

/** The number a migration file starts with (41 for "041_migration_ledger.sql"). */
export const migrationNumber = (file) => Number(file.slice(0, 3));

/** A fresh database with the stub and every migration up to and including `upTo` (default: all). */
export async function freshDb({ upTo = Infinity, before } = {}) {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const file of migrationFiles()) {
    if (migrationNumber(file) > upTo) break;
    if (before) await before(db, file);
    await db.exec(readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8'));
  }
  return db;
}

export const FINGERPRINT_SQL = readFileSync(new URL('../../supabase/checks/fingerprint.sql', import.meta.url), 'utf8')
  .replace(/^--.*$/gm, '')
  .trim();

/** The fingerprint rows of a database: [{ kind, name, hash }] sorted. */
export async function fingerprint(db) {
  return (await db.query(`select * from (${FINGERPRINT_SQL}) f order by kind, name`)).rows;
}

/** One hash over the strict kinds (everything except grants), as migration 041 computes it. */
export const strictHash = async (db) =>
  (await db.query(`select md5(coalesce(string_agg(kind || '|' || name || '|' || hash, ';' order by kind collate "C", name collate "C"), ''))
                   as h from (${FINGERPRINT_SQL}) f where kind <> 'grant'`)).rows[0].h;
