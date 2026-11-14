/**
 * Join several migrations into one file, to paste into Supabase → SQL Editor and run in one go.
 *
 *   node tools/bundle-migrations.mjs 41 48     # → supabase/bundles/041-048.sql
 *
 * The SQL Editor runs a pasted script as one transaction, so the bundle is all or nothing: if any
 * migration in it fails, none of them are applied (the ledger stays where it was). Each migration's own
 * checks still run in order (041 checks the baseline; 042+ refuse to run twice or out of order).
 *
 * The bundle is made from the files in supabase/migrations/ and is never edited by hand; those files
 * stay the source of truth. Before 041, still run supabase/checks/040_baseline_check.sql first.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const DIR = new URL('supabase/migrations/', ROOT);

export function bundle(from, to) {
  const files = readdirSync(DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort()
    .filter((f) => Number(f.slice(0, 3)) >= from && Number(f.slice(0, 3)) <= to);
  const numbers = files.map((f) => Number(f.slice(0, 3)));
  for (let n = from; n <= to; n++) if (!numbers.includes(n)) throw new Error(`There's no migration ${String(n).padStart(3, '0')}.`);
  for (const f of files) {
    const sql = readFileSync(new URL(f, DIR), 'utf8');
    if (/^\s*(begin|commit|rollback)\s*;/im.test(sql)) throw new Error(`${f} has its own begin/commit, so it can't go in a bundle.`);
  }
  const pad = (n) => String(n).padStart(3, '0');
  const header = `-- one.solar migrations ${pad(from)}–${pad(to)}, joined by tools/bundle-migrations.mjs. Don't edit: change the
-- files in supabase/migrations/ and run the tool again.
-- Paste all of it into Supabase → SQL Editor and click Run once. It's all or nothing: if anything fails,
-- nothing is changed. Afterwards: select version, name, applied_at from schema_migrations order by version;
-- Contains: ${files.join(', ')}
`;
  const body = files.map((f) => `\n-- =====================================================================\n-- ${f}\n-- =====================================================================\n${readFileSync(new URL(f, DIR), 'utf8').trim()}\n`).join('');
  return { name: `${pad(from)}-${pad(to)}.sql`, sql: header + body, files };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [from, to] = process.argv.slice(2).map(Number);
  if (!from || !to || from > to) {
    console.error('Usage: node tools/bundle-migrations.mjs <from> <to>   e.g. 41 48');
    process.exit(1);
  }
  const { name, sql, files } = bundle(from, to);
  const out = new URL('supabase/bundles/', ROOT);
  mkdirSync(out, { recursive: true });
  writeFileSync(new URL(name, out), sql);
  console.log(`Wrote supabase/bundles/${name} (${files.length} migrations).`);
}
