-- The schema fingerprint: one row per database object one.solar defines, with a hash of what matters
-- about it. Read-only. Used by:
--   supabase/checks/040_baseline_check.sql   (generated: compares a database with the repo, before 041)
--   supabase/migrations/041_migration_ledger.sql  (public.schema_fingerprint() runs this same query)
--   tools/baseline.mjs and tests/migrations.test.mjs
--
-- kind      strict?  what is hashed
-- table     yes      row-level security on / forced
-- column    yes      type and not-null
-- function  yes      source text (line endings ignored: Windows and Mac copies differ), security definer,
--                    settings (search_path), result type
-- policy    yes      command, roles, permissive (not the expression text: Postgres versions print it differently)
-- trigger   yes      function and timing/events (triggers that call one.solar's functions, incl. on auth.users)
-- grant     no       what anon / authenticated may do (Supabase adds default grants a local copy doesn't have)
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
