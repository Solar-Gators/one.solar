-- 041: a record of which database updates have run (the migration ledger), and the baseline it starts from.
--
-- BEFORE running this: run supabase/checks/040_baseline_check.sql (read-only) and look at the result.
-- This file refuses to run if the database's tables, columns, functions, policies or triggers differ from
-- what migrations 001–040 create (the "blocking" rows of that check). See docs/MAINTAINING.md → "Before 041".
--
-- What it records, honestly:
--   001–040  status 'baseline': run by hand before this ledger existed, NOT individually verified. They are
--            covered only by the baseline comparison stored in schema_baseline (date, hashes, differences).
--   041 on   status 'applied', written by migration_done() as the LAST statement of each file. Postgres runs
--            the whole file as one transaction, so if anything fails, nothing is kept and no row is written.
--
-- Every later migration starts with  select public.migration_begin(N);
-- and ends with                      select public.migration_done(N, 'NNN_name.sql');

do $$
begin
  if to_regclass('public.schema_migrations') is not null then
    raise exception '041 has already been applied (schema_migrations exists).';
  end if;
  if coalesce((select (value ->> 'schemaVersion')::int from public.app_settings where key = 'general'), 0) <> 40 then
    raise exception 'Run migrations up to 040 first (this database is at schemaVersion %).',
      (select value ->> 'schemaVersion' from public.app_settings where key = 'general');
  end if;
end
$$;

-- The fingerprint (supabase/checks/fingerprint.sql, kept identical by tests/migrations.test.mjs).
create function public.schema_fingerprint()
returns table (kind text, name text, hash text)
language sql stable set search_path = pg_catalog, public
as $fp$
select 'table' as kind, c.relname::text as name, md5(c.relrowsecurity::text || c.relforcerowsecurity::text) as hash
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
union all
select 'column', c.relname || '.' || a.attname, md5(format_type(a.atttypid, a.atttypmod) || a.attnotnull::text)
from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
union all
select 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       md5(replace(p.prosrc, chr(13), '') || p.prosecdef::text || coalesce(array_to_string(p.proconfig, ','), '') || pg_get_function_result(p.oid))
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f'
union all
select 'policy', pol.tablename || '.' || pol.policyname, md5(pol.cmd || pol.roles::text || pol.permissive)
from pg_policies pol where pol.schemaname = 'public'
union all
select 'trigger', tn.nspname || '.' || tc.relname || '.' || t.tgname, md5(t.tgfoid::regprocedure::text || t.tgtype::text)
from pg_trigger t join pg_class tc on tc.oid = t.tgrelid join pg_namespace tn on tn.oid = tc.relnamespace
join pg_proc tp on tp.oid = t.tgfoid join pg_namespace pn on pn.oid = tp.pronamespace
where not t.tgisinternal and pn.nspname = 'public'
union all
select 'grant', g.table_name || ':' || g.grantee, md5(string_agg(g.privilege_type, ',' order by g.privilege_type))
from information_schema.role_table_grants g
where g.table_schema = 'public' and g.grantee in ('anon', 'authenticated')
group by g.table_name, g.grantee
union all
select 'grant', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || r.rolname, md5('execute')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join pg_roles r
where n.nspname = 'public' and p.prokind = 'f' and r.rolname in ('anon', 'authenticated')
  and p.prorettype <> 'trigger'::regtype and has_function_privilege(r.oid, p.oid, 'execute')
$fp$;

-- The baseline: what this database looked like when the ledger started, compared with the repo.
create table public.schema_baseline (
  id                int primary key default 1 check (id = 1),
  taken_at          timestamptz not null default now(),
  schema_version    int not null,
  expected_hash     text not null,
  actual_hash       text not null,
  result            text not null check (result in ('matched', 'accepted differences')),
  grant_rows        int not null default 0,
  note              text not null default ''
);
alter table public.schema_baseline enable row level security;
revoke all on public.schema_baseline from anon, authenticated;

do $$
declare
  -- What migrations 001–040 create (tables, columns, functions, policies, triggers), from tools/baseline.mjs.
  c_expected constant text := 'a7a34fb2ac5708befd033f18c08f3bd2';
  -- Set to true ONLY after the team has reviewed every blocking row of 040_baseline_check.sql and decided
  -- they are acceptable (write the reason in v_note). Otherwise fix the differences and run the check again.
  v_accept_differences boolean := false;
  v_note text := '';
  v_actual text;
  v_grants int;
begin
  -- The fingerprint at 040, before anything in this file changed the schema (so 041's own objects are left out).
  select md5(coalesce(string_agg(f.kind || '|' || f.name || '|' || f.hash, ';' order by f.kind collate "C", f.name collate "C"), ''))
    into v_actual
  from public.schema_fingerprint() f
  where f.kind <> 'grant' and f.name not in ('schema_fingerprint()', 'schema_baseline')
    and f.name not like 'schema_baseline.%';
  if v_actual <> c_expected and not v_accept_differences then
    raise exception 'This database differs from migrations 001–040 (hash % instead of %). Nothing was changed. Run supabase/checks/040_baseline_check.sql to see the differences, and follow docs/MAINTAINING.md → "Before 041".',
      v_actual, c_expected;
  end if;
  -- Security invariants that are never "accepted": RLS on every table, and no table writes for anon/authenticated.
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity) then
    raise exception 'A table in public has row-level security turned off. Nothing was changed. Fix that first.';
  end if;
  if exists (select 1 from information_schema.role_table_grants g where g.table_schema = 'public'
             and g.grantee in ('anon', 'authenticated') and g.privilege_type <> 'SELECT') then
    raise exception 'anon or authenticated can write to a table directly. Nothing was changed. Revoke it first (see 040_baseline_check.sql).';
  end if;
  select count(*) into v_grants from public.schema_fingerprint() f where f.kind = 'grant';
  insert into public.schema_baseline (schema_version, expected_hash, actual_hash, result, grant_rows, note)
  values (40, c_expected, v_actual, case when v_actual = c_expected then 'matched' else 'accepted differences' end,
          v_grants, trim(v_note || ' Grants to anon/authenticated are recorded by count, not compared.'));
end
$$;

-- The ledger.
create table public.schema_migrations (
  version    int primary key,
  name       text not null,
  status     text not null check (status in ('baseline', 'applied')),
  applied_at timestamptz,
  applied_by text,
  note       text not null default ''
);

insert into public.schema_migrations (version, name, status, note)
select v, n, 'baseline',
       'Run by hand before the ledger existed; not individually verified. Covered by the baseline comparison in schema_baseline.'
from (values
  (1, '001_initial.sql'), (2, '002_form_fields.sql'), (3, '003_archive_and_import.sql'), (4, '004_cost_adjustments.sql'),
  (5, '005_editable_permissions.sql'), (6, '006_seasons.sql'), (7, '007_one_vendor_per_request.sql'),
  (8, '008_roles_admin_history.sql'), (9, '009_form_rules_layout_exports.sql'), (10, '010_workflow_budgets_notifications.sql'),
  (11, '011_notification_choices.sql'), (12, '012_link_imported_requests.sql'), (13, '013_history_drafts_ticket.sql'),
  (14, '014_finances.sql'), (15, '015_sponsors.sql'), (16, '016_request_watchers.sql'), (17, '017_attachments.sql'),
  (18, '018_treasurer_ledger.sql'), (19, '019_fix_wording_pickup.sql'), (20, '020_ledger_category.sql'),
  (21, '021_budget_categories.sql'), (22, '022_paid_status.sql'), (23, '023_rename_category_fix.sql'),
  (24, '024_cancel_approved.sql'), (25, '025_treasurer_tools.sql'), (26, '026_sponsor_history.sql'),
  (27, '027_sponsor_outreach.sql'), (28, '028_solar_evals.sql'), (29, '029_onesolar.sql'), (30, '030_onesolar_wording.sql'),
  (31, '031_eval_self_reviews.sql'), (32, '032_eval_questions.sql'), (33, '033_undo_received.sql'),
  (34, '034_edit_approved_items.sql'), (35, '035_people_admin_only.sql'), (36, '036_eval_types.sql'),
  (37, '037_eval_form_names.sql'), (38, '038_eval_communication.sql'), (39, '039_eval_more_forms.sql'), (40, '040_guests.sql')
) as m(v, n);

/** First statement of every migration from 042 on: refuses a re-run, and a run out of order. */
create function public.migration_begin(p_version int)
returns void
language plpgsql set search_path = public, pg_temp
as $$
declare v_last int;
begin
  if exists (select 1 from schema_migrations where version = p_version) then
    raise exception 'Migration % has already been applied. Nothing was changed.', lpad(p_version::text, 3, '0');
  end if;
  select max(version) into v_last from schema_migrations;
  if v_last <> p_version - 1 then
    raise exception 'Apply migration % first (this database is at %). Nothing was changed.',
      lpad((v_last + 1)::text, 3, '0'), lpad(v_last::text, 3, '0');
  end if;
end;
$$;

/** Last statement of every migration: records it (inside the same transaction) and updates schemaVersion. */
create function public.migration_done(p_version int, p_name text)
returns void
language plpgsql set search_path = public, pg_temp
as $$
begin
  perform migration_begin(p_version); -- still not recorded and still in order
  insert into schema_migrations (version, name, status, applied_at, applied_by)
  values (p_version, p_name, 'applied', now(), current_user);
  update app_settings set value = jsonb_set(value, '{schemaVersion}', to_jsonb(p_version)) where key = 'general';
  notify pgrst, 'reload schema'; -- new or changed functions are callable right away
end;
$$;

-- Who can read it: anyone on the team (version numbers aren't sensitive). Nobody writes it directly.
alter table public.schema_migrations enable row level security;
revoke all on public.schema_migrations, public.schema_baseline from anon, authenticated;
grant select on public.schema_migrations, public.schema_baseline to authenticated;
create policy "team read" on public.schema_migrations for select to authenticated using (is_member());
create policy "team read" on public.schema_baseline for select to authenticated using (is_member());
revoke execute on function public.schema_fingerprint(), public.migration_begin(int), public.migration_done(int, text)
  from public, anon, authenticated;

-- 041 itself, the first 'applied' row.
select public.migration_done(41, '041_migration_ledger.sql');
