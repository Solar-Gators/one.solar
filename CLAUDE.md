# one.solar: rules for AI coding assistants

Claude Code reads this file automatically at the start of every session in this repo. Other assistants (Cursor,
Copilot, Codex…) can be pointed at it. The human guide is the "Handing over one.solar" section of README.md.

## What this is
- Static site (no build step, plain ES modules) on GitHub Pages at https://one.ufsolargators.org/, deployed by
  `.github/workflows/deploy.yml` only after `ci.yml` ("Tests") passes.
- One Supabase project (Postgres + Auth + Storage + one Edge Function). Reads go through Row Level Security;
  every write is a `security definer` function (RPC) that checks permissions itself.
- Apps: Orders, Finances, Sponsors and Admin share `orders/js/` (each app's `index.html` sets `data-app`);
  Solar Evals is `evals/`; the home screen is `index.html` + `hub/`. Docs are in `docs/`.

## How changes ship
- Work on a branch, open a pull request, turn on auto-merge (`gh pr merge --auto --squash`). It merges itself
  when the required "Tests" check passes. Push straight to `main` only when the person says so.
- On merge, GitHub Pages republishes the site, and Supabase's GitHub integration runs any new file in
  `supabase/migrations/` and redeploys the functions listed in `supabase/config.toml`.
- Commit or push only when the person asks.

## Never
- Put a secret in the repo: the Supabase service_role / `sb_secret_` key, the database password, `CRON_SECRET`,
  SMTP passwords, the Power Automate `FLOW_URL`. The anon / publishable key in `shared/config.js` is public and fine.
  The repo is public: everything committed is visible to anyone.
- Commit spreadsheets, `data/`, exports or anyone's personal data (they're in `.gitignore`; keep it that way).
- Edit or renumber a migration that has already run. Fix things with a new, higher-numbered file.
- Run SQL against the live database, or change Supabase / GitHub settings, yourself. Write the SQL or the steps,
  and the person runs or clicks them.
- Weaken or skip a test to make it pass, or add `continue-on-error`.
- Hand-edit `gatorwire/` (a built bundle) or the generated `supabase/checks/040_baseline_check.sql`.
- Put real passwords anywhere; test accounts only ever exist in fake mode (`npm run dev:fake`).

## Database changes
- New file `supabase/migrations/NNN_short_name.sql` (next free number, lowercase/underscores). It must start
  with `select public.migration_begin(N);` and end with `select public.migration_done(N, 'NNN_short_name.sql');`.
- No `begin`/`commit` of its own, nothing that can't run in a transaction (`create index concurrently`, `vacuum`).
- New tables: enable RLS and add policies; never grant anon/authenticated direct writes. New RPCs: `security
  definer`, `set search_path = public, pg_temp`, check `has_permission(...)`, `revoke ... from public, anon`, then
  `grant ... to authenticated`. Adding an argument to an existing RPC means a new function name (PostgREST
  matches by argument names), not an overload.
- Register it: `REQUIRED_SCHEMA_VERSION` and `MIGRATIONS` in `orders/js/main.js`, `MIGRATIONS` in
  `tools/fake-supabase.js`, `SCHEMA_VERSION` in `shared/version.js`. Add tests to `tests/db.test.mjs`. If you add
  or change an RPC, run `node tests/rpc.test.mjs --update`.
- Tell the person what the migration does and point them at the file before it merges.

## Before saying something is done
- `npm test` (unit + database tests, all in Node, no network) and `npm run test:smoke` (Playwright on the fake
  backend; `npx playwright install chromium` once) must pass. New site files must be `git add`ed (or
  `git add -N`) or the site check won't see them.
- For anything visible, run `npm run dev:fake`, open it, and check the page (and the browser console) yourself.
- Changed a page's `<head>` or the Supabase URL? Run `node tools/csp.mjs`.

## Style
- Plain words in the UI, written for students who aren't programmers. Brand is "one.solar" (lowercase).
- Match the code around you; small, readable functions; comments explain why.
- Update the docs in `docs/` when behaviour changes.
