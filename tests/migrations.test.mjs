/**
 * Migrations and the ledger (041):
 *   - the migration lists in the app and the fake backend match supabase/migrations/;
 *   - the baseline check and 041's expected hash are up to date with migrations 001–040;
 *   - 041 refuses a database that differs from the repo, and records 001–040 as "baseline" (not verified);
 *   - every later migration starts with migration_begin(N) and ends with migration_done(N, file), so a
 *     re-run, a run out of order, or a failure halfway leaves the ledger (and the schema) unchanged.
 *
 *   node tests/migrations.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb, migrationFiles, migrationNumber, MIGRATIONS_DIR, FINGERPRINT_SQL, strictHash } from './support/supabase-stub.mjs';
import { baselineAt40, CHECK_FILE } from '../tools/baseline.mjs';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${String(err.message).split('\n').join('\n    ')}`);
    process.exitCode = 1;
  }
}
async function rejects(promise, pattern) {
  try {
    await promise;
  } catch (err) {
    if (pattern) assert.match(err.message, pattern);
    return;
  }
  throw new Error(`expected an error matching ${pattern}`);
}

const files = migrationFiles();
const latest = migrationNumber(files.at(-1));
const read = (path) => readFileSync(new URL(path, new URL('../', import.meta.url)), 'utf8');
const sqlOf = (file) => readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8');
const squash = (s) => s.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim();
/** The SQL statements of a file, roughly (enough to find the first and the last one). */
const statements = (sql) => sql.replace(/--.*$/gm, '').split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);

console.log('Migrations');

await test('the migrations are numbered 001, 002, … with no gaps', () => {
  files.forEach((f, i) => assert.equal(migrationNumber(f), i + 1, `${f} is out of sequence`));
});

await test('Orders and the fake backend list exactly these migrations, and the app requires the latest', () => {
  const fake = read('tools/fake-supabase.js').match(/const MIGRATIONS = \[([^\]]*)\]/)[1].match(/'[^']+'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(fake, files, 'tools/fake-supabase.js MIGRATIONS');
  const main = read('orders/js/main.js');
  assert.equal(Number(main.match(/REQUIRED_SCHEMA_VERSION = (\d+)/)[1]), latest, 'REQUIRED_SCHEMA_VERSION in orders/js/main.js');
  const map = Object.fromEntries([...main.match(/const MIGRATIONS = \{([^}]*)\}/)[1].matchAll(/(\d+): '([^']+)'/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(Object.values(map), files.slice(1), 'MIGRATIONS in orders/js/main.js (002 on)');
});

await test("041's schema_fingerprint() is exactly supabase/checks/fingerprint.sql", () => {
  const body = sqlOf('041_migration_ledger.sql').match(/as \$fp\$([\s\S]*?)\$fp\$/)[1];
  assert.equal(squash(body), squash(FINGERPRINT_SQL));
});

const base = await baselineAt40();
await test('the committed 040 baseline check and 041\'s expected hash are up to date', () => {
  assert.equal(readFileSync(CHECK_FILE, 'utf8'), base.sql, 'run: node tools/baseline.mjs');
  assert.match(sqlOf('041_migration_ledger.sql'), new RegExp(`c_expected constant text := '${base.hash}'`), 'update c_expected in 041');
});

await test('the baseline check finds nothing on a database built from the repo, and finds a change', async () => {
  const db = await freshDb({ upTo: 40 });
  assert.deepEqual((await db.query(base.sql)).rows, []);
  await db.exec(`create or replace function public.is_member(p_user uuid default null) returns boolean
                 language sql stable security definer set search_path = public, pg_temp as $$ select true $$;`);
  await db.exec(`grant insert on public.requests to authenticated`);
  const found = (await db.query(base.sql)).rows.map((r) => `${r.kind} ${r.name} ${r.blocks_041}`);
  assert.deepEqual(found, ['function is_member(p_user uuid) true', 'grant requests:authenticated false']);
  await db.close();
});

await test('041 refuses a database that differs from the repo, and changes nothing', async () => {
  const db = await freshDb({ upTo: 40 });
  await db.exec(`create function public.added_by_hand() returns int language sql as $$ select 1 $$`);
  await rejects(db.exec(sqlOf('041_migration_ledger.sql')), /differs from migrations 001–040/);
  assert.equal((await db.query(`select to_regclass('public.schema_migrations') as t`)).rows[0].t, null);
  assert.equal((await db.query(`select to_regprocedure('public.schema_fingerprint()') as f`)).rows[0].f, null);
  await db.close();
});

await test('041 refuses a database where anon or authenticated can write a table, even if accepted', async () => {
  const db = await freshDb({ upTo: 40 });
  await db.exec(`grant update on public.requests to anon`);
  await rejects(db.exec(sqlOf('041_migration_ledger.sql')), /can write to a table directly/);
  await db.close();
});

const db = await freshDb();
await test('after every migration: 001–040 are "baseline" (not verified), 041 on are "applied", in order', async () => {
  const rows = (await db.query(`select version, name, status, applied_at is not null as dated from schema_migrations order by version`)).rows;
  assert.deepEqual(rows.map((r) => r.name), files);
  for (const r of rows) {
    if (r.version <= 40) assert.deepEqual([r.status, r.dated], ['baseline', false], `${r.name}`);
    else assert.deepEqual([r.status, r.dated], ['applied', true], `${r.name}`);
  }
  const baseline = (await db.query(`select result, schema_version, expected_hash = actual_hash as same from schema_baseline`)).rows[0];
  assert.deepEqual(baseline, { result: 'matched', schema_version: 40, same: true });
  const general = (await db.query(`select value->>'schemaVersion' as v from app_settings where key = 'general'`)).rows[0].v;
  assert.equal(Number(general), latest);
});

await test('041 keeps its own objects out of the 040 comparison', async () => {
  const db40 = await freshDb({ upTo: 40 });
  assert.equal(await strictHash(db40), base.hash);
  await db40.close();
});

await test('every migration from 042 starts with migration_begin(N) and ends with migration_done(N, file)', () => {
  for (const file of files.filter((f) => migrationNumber(f) >= 42)) {
    const st = statements(sqlOf(file));
    const n = migrationNumber(file);
    assert.match(st[0], new RegExp(`^select public\\.migration_begin\\(${n}\\)$`), `${file}: first statement`);
    assert.match(st.at(-1), new RegExp(`^select public\\.migration_done\\(${n}, '${file}'\\)$`), `${file}: last statement`);
  }
});

await test('running a migration again is refused and leaves the ledger as it was', async () => {
  const before = (await db.query(`select count(*)::int as n from schema_migrations`)).rows[0].n;
  await rejects(db.exec(sqlOf(files.at(-1))), /already been applied/);
  assert.equal((await db.query(`select count(*)::int as n from schema_migrations`)).rows[0].n, before);
});

await test('a migration run out of order is refused', async () => {
  await rejects(db.exec(`select public.migration_begin(${latest + 2})`), new RegExp(`Apply migration ${String(latest + 1).padStart(3, '0')} first`));
});

await test('a migration that fails halfway leaves no changes and no ledger row', async () => {
  const n = latest + 1;
  await rejects(db.exec(`
    select public.migration_begin(${n});
    create table public.half_done (id int);
    select 1 / 0;
    select public.migration_done(${n}, 'test.sql');`), /division by zero/);
  assert.equal((await db.query(`select to_regclass('public.half_done') as t`)).rows[0].t, null);
  assert.equal((await db.query(`select count(*)::int as n from schema_migrations where version = ${n}`)).rows[0].n, 0);
});

await test('the website cannot write the ledger or run the migration helpers', async () => {
  await db.exec(`set role authenticated`);
  try {
    await rejects(db.exec(`insert into schema_migrations (version, name, status) values (999, 'x', 'applied')`), /permission denied/);
    await rejects(db.exec(`select public.migration_done(999, 'x')`), /permission denied/);
    await rejects(db.exec(`select * from public.schema_fingerprint()`), /permission denied/);
  } finally {
    await db.exec(`reset role`);
  }
});

console.log('After a restore (supabase/restore/post_restore.sql)');

const POST_RESTORE = read('supabase/restore/post_restore.sql');

await test('it brings back the sign-up trigger, and running it twice is fine', async () => {
  const db = await freshDb();
  await db.exec(`drop trigger on_auth_user_created on auth.users`); // as after restoring a dump of public only
  await db.exec(POST_RESTORE);
  await db.exec(POST_RESTORE);
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000aa', 'restored@ufl.edu', '{"full_name": "Rae Stored"}')`);
  const p = (await db.query(`select full_name from profiles where email = 'restored@ufl.edu'`)).rows[0];
  assert.deepEqual(p, { full_name: 'Rae Stored' });
  await db.close();
});

await test('its attachment rules are the latest ones in the migrations', () => {
  /** "read" → the last `create policy "attachments: read" … $p$` text, across files in order. */
  const latest = {};
  const grab = (sql, into) => {
    for (const m of sql.matchAll(/create policy "attachments: (\w+)"([\s\S]*?)\$p\$/g)) into[m[1]] = squash(m[2]);
  };
  for (const f of files) grab(sqlOf(f), latest);
  const restore = {};
  grab(POST_RESTORE, restore);
  assert.deepEqual(Object.keys(restore).sort(), ['delete', 'read', 'upload']);
  assert.deepEqual(restore, latest, 'a migration changed a storage rule: copy it into supabase/restore/post_restore.sql');
});

await test('the joined 041+ file (tools/bundle-migrations.mjs) takes a database at 040 to the latest, all or nothing', async () => {
  const { bundle } = await import('../tools/bundle-migrations.mjs');
  const last = migrationNumber(migrationFiles().at(-1));
  const { sql } = bundle(41, last);
  const db = await freshDb({ upTo: 40 });
  await db.exec(sql);
  assert.equal((await db.query('select max(version)::int v from schema_migrations')).rows[0].v, last);
  const db2 = await freshDb({ upTo: 40 });
  const broken = sql.replace(`select public.migration_done(${last},`, `select 1/0;\nselect public.migration_done(${last},`);
  await rejects(db2.exec(`begin;\n${broken}\ncommit;`), /division by zero/);
  await db2.exec('rollback');
  assert.equal((await db2.query(`select to_regclass('public.schema_migrations') is null as gone`)).rows[0].gone, true);
});

await test('the baseline is the same whether the migrations were pasted with Windows (CRLF) or Unix (LF) line endings', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { SUPABASE_STUB } = await import('./support/supabase-stub.mjs');
  const build = async (crlf) => {
    const db = new PGlite();
    await db.exec(SUPABASE_STUB);
    for (const f of migrationFiles().filter((f) => migrationNumber(f) <= 40)) {
      const sql = readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8').replace(/\r\n/g, '\n');
      await db.exec(crlf ? sql.replace(/\n/g, '\r\n') : sql);
    }
    return strictHash(db);
  };
  assert.equal(await build(true), await build(false));
});

console.log(`\n${passed} passed`);
