-- Turn on automatic migrations: tell Supabase's GitHub integration which migrations already ran.
--
-- Not a migration: run it once by hand in Supabase → SQL Editor, BEFORE turning on
-- Settings → Integrations → GitHub → "Deploy to production". Running it again is fine.
--
-- Why: on every push to main, the integration runs each file in supabase/migrations that has no row in
-- supabase_migrations.schema_migrations (Supabase's own history). Every migration so far was run by hand in
-- the SQL Editor, so that history is empty and it would try to run 001 onwards again. This copies the list
-- from our own ledger (public.schema_migrations, migration 041), which records exactly what ran here.
--
-- It changes nothing in the app's tables: it only writes Supabase's migration history.
-- File names → history rows the way the Supabase CLI reads them: "049_steps_in_orders.sql" is version
-- '049', name 'steps_in_orders'.

do $$
declare
  v_max  int := (select max(version) from public.schema_migrations);
  v_gaps text := (select string_agg(lpad(g::text, 3, '0'), ', ')
                  from generate_series(1, (select max(version) from public.schema_migrations)) g
                  where g not in (select version from public.schema_migrations));
begin
  if v_max is null then raise exception 'No migration ledger here (migration 041). Nothing was recorded.'; end if;
  if v_gaps is not null then raise exception 'The ledger is missing %. Nothing was recorded; ask before going on.', v_gaps; end if;
end;
$$;

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text not null primary key);
alter table supabase_migrations.schema_migrations add column if not exists statements text[];
alter table supabase_migrations.schema_migrations add column if not exists name text;

insert into supabase_migrations.schema_migrations (version, name)
select lpad(version::text, 3, '0'), regexp_replace(name, '^\d+_(.*)\.sql$', '\1')
from public.schema_migrations
on conflict (version) do nothing;

-- Check: every row should say "matches". Anything else would make the integration's deploy fail
-- ("a history entry with no matching file"), so tell whoever maintains the repo before turning it on.
select h.version, h.name,
       case when l.version is not null then 'matches' else 'NOT IN THIS REPO''S LEDGER' end as check
from supabase_migrations.schema_migrations h
left join public.schema_migrations l on lpad(l.version::text, 3, '0') = h.version
order by h.version;
