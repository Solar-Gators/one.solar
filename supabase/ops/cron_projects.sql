-- Projects: run the timed work every 30 minutes, even when nobody has Projects open.
--
-- Optional, and not a migration: run it once by hand in Supabase → SQL Editor. Without it, Projects still does
-- the same work whenever someone opens the app (at most every 30 minutes), which is enough for a team that
-- uses it daily. With it, due-date reminders and the "due soon", "overdue" and "on a schedule" rules also run
-- on days nobody opens Projects.
--
-- It needs no secret: the job runs inside the database and calls one function, public.pm_run_scheduled(),
-- which does nothing if it already ran in the last 30 minutes, and never runs a reminder or a rule twice
-- for the same item and date.
--
-- Before running: Supabase → Integrations (or Database → Extensions): turn on pg_cron (it's already on if
-- supabase/ops/cron_send_notifications.sql was set up).
--
-- Check it: select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'projects-timed')
--             order by start_time desc limit 5;
--           select last_run from public.pm_schedule_state;
-- Stop it:  select cron.unschedule('projects-timed');

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'Turn on pg_cron first (Supabase → Integrations). Nothing was scheduled.';
  end if;
  if to_regprocedure('public.pm_run_scheduled()') is null then
    raise exception 'Projects isn''t in this database yet (migration 051). Nothing was scheduled.';
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'projects-timed';
  perform cron.schedule('projects-timed', '*/30 * * * *', 'select public.pm_run_scheduled()');
end;
$$;
