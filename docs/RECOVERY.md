# Backups and recovery

How one.solar's data is backed up, and how to get it back. Read this **before** you need it, and run the
drill (below) once a semester.

## What has to be saved

| What | Where it lives | In a database dump? |
|---|---|---|
| Requests, finances, sponsors, evals, people, settings | Supabase database, `public` schema | Yes |
| Accounts (logins, passwords) | Supabase database, `auth` schema | Yes (data) |
| The sign-up trigger, the attachments bucket and its rules | `auth` / `storage` schemas (added by our migrations) | **No**: run `supabase/restore/post_restore.sql` |
| Attached files (receipts, quotes, photos) | Supabase Storage, bucket `attachments` | **No**: copied separately |
| The website | This GitHub repo | n/a (redeploy from git) |
| Edge Function secrets (Power Automate URL, email keys) | Supabase → Edge Functions → Secrets | **No**: keep them in the team's password manager |

Supabase's free plan keeps **no** automatic backups. Until the nightly backup below is running, take one by
hand before every database update (`docs/MAINTAINING.md` → "Database updates").

## Nightly backup

`docs/ops/nightly-backup.yml` is a GitHub Actions workflow. **It belongs in a separate, private repository**
(it handles the database password and members' data), never in this public one.

1. Create a private repo, e.g. `Solar-Gators/one.solar-ops`, with only Admins as members.
2. Copy `docs/ops/nightly-backup.yml` to `.github/workflows/nightly-backup.yml` there.
3. Add the four secrets listed at the top of the file. Put `BACKUP_PASSPHRASE` in the team's password
   manager as well: without it no backup can be opened.
4. Actions → Nightly backup → **Run workflow**. Check that it finishes and its artifact is there.
5. Afterwards, check once a week that the last 7 nights have an artifact (Actions → Nightly backup).

Each artifact is an encrypted `one.solar-<date>.tar.gz.gpg` containing `roles.sql`, `schema.sql`,
`data.sql` and `attachments/`. Artifacts are kept 7 days.

**Before the first run, check the commands against Supabase's current guide** ("Backup and restore using
the CLI"): the flags of `supabase db dump` and `supabase storage cp` have changed before. The drill below
proves they work.

### By hand (no workflow yet, or right before a risky update)

With the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) and the
database connection string (Project Settings → Database → Connection string → Session pooler):

```bash
supabase db dump --db-url "$DB_URL" -f roles.sql --role-only
```

```bash
supabase db dump --db-url "$DB_URL" -f schema.sql
```

```bash
supabase db dump --db-url "$DB_URL" -f data.sql --use-copy --data-only -x "storage.buckets_vectors" -x "storage.vector_indexes"
```

Keep these files somewhere private (they contain members' names and emails), never in a git repo.

## Restoring

Restore into a **new** Supabase project first (staging or a scratch project), check it, and only then
point the site at it, or restore over production if that's the decision.

1. **Decrypt** the backup: `gpg -d one.solar-<date>.tar.gz.gpg > backup.tar.gz`, then `tar -xzf backup.tar.gz`.
2. **Create the project** (or pick the scratch one) and get its connection string.
3. **Load the dump** (one transaction: all or nothing):
   ```bash
   psql --single-transaction --variable ON_ERROR_STOP=1 --file roles.sql --file schema.sql --command 'SET session_replication_role = replica' --file data.sql --dbname "$NEW_DB_URL"
   ```
4. **Run `supabase/restore/post_restore.sql`** in the new project's SQL Editor. It re-creates the sign-up
   trigger and the attachments bucket and rules. Its last line should show `signup_trigger = true` and
   `attachment_rules = 3`.
5. **Copy the files back**: `supabase link --project-ref <new ref>`, then
   `supabase storage cp -r attachments ss:///attachments --experimental` (from the folder holding
   `attachments/`).
6. **Check the database matches the repo**: in the SQL Editor run
   `select version, name, status from schema_migrations order by version desc limit 3;`. The newest
   row should be the newest file in `supabase/migrations/`. If the project was restored from before a
   migration, run the missing ones in order.
7. **Settings that aren't data**, in the new project:
   - Authentication → URL Configuration: the Site URL and redirect URLs (see `docs/MAINTAINING.md`).
   - Authentication → Email templates and SMTP, if they were customized.
   - Edge Functions: deploy them and re-enter their secrets from the password manager.
8. **Point the site at it** (only if it replaces production): update `SUPABASE_URL` and the anon key in
   `shared/config.js`, then release as usual (`docs/RELEASING.md`).
9. **Smoke test** with a real account: sign in, open a request with an attachment, open Finances and an
   eval, and sign up a test account (it should arrive as a Guest).

## The drill (once a semester)

Restore last night's backup into a scratch project, following "Restoring" steps 1–6 and 9. Write it down
below. A backup nobody has restored is only a hope.

| Date | Backup from | Who | Time taken | Problems found |
|---|---|---|---|---|
| | | | | |
