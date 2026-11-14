-- Send waiting notifications every 5 minutes, even when nobody is using the site (S-7).
--
-- Not a migration: run it once by hand in Supabase → SQL Editor, after the steps below. Running it again
-- is fine (it replaces the schedule). The secret never goes in this file or the repo.
--
-- Before running:
--   1. Supabase → Integrations (or Database → Extensions): turn on pg_cron and pg_net.
--   2. Make a long random secret, e.g. in a terminal: openssl rand -hex 32  (or any 40+ random characters).
--   3. Supabase → Edge Functions → Secrets: add CRON_SECRET = that value.
--   4. Supabase → Edge Functions → send-notifications: deploy the current
--      supabase/functions/send-notifications/index.ts, and turn "Verify JWT" OFF for it (it checks callers
--      itself now; the scheduled job has no sign-in to send).
--   5. Below, replace PASTE-THE-SAME-SECRET-HERE with the same value, run this file, then clear it from the
--      editor. It is stored encrypted in Supabase Vault; the schedule reads it from there.
--
-- Check it: select * from cron.job_run_details order by start_time desc limit 5;
--           and Admin → one.solar → Notifications shows messages going out without anyone clicking.
-- Stop it:  select cron.unschedule('send-notifications');

-- The secret, in Vault (replaced if it's already there).
do $$
begin
  if exists (select 1 from vault.secrets where name = 'notifications_cron_secret') then
    perform vault.update_secret((select id from vault.secrets where name = 'notifications_cron_secret'), 'PASTE-THE-SAME-SECRET-HERE');
  else
    perform vault.create_secret('PASTE-THE-SAME-SECRET-HERE', 'notifications_cron_secret', 'send-notifications schedule (x-cron-secret)');
  end if;
end;
$$;

-- Refuse to schedule with the placeholder still in place.
do $$
begin
  if (select decrypted_secret from vault.decrypted_secrets where name = 'notifications_cron_secret') = 'PASTE-THE-SAME-SECRET-HERE' then
    raise exception 'Replace PASTE-THE-SAME-SECRET-HERE with your CRON_SECRET first. Nothing was scheduled.';
  end if;
end;
$$;

-- Every 5 minutes: call the function with the secret. (Replaces any earlier schedule of the same name.)
select cron.schedule(
  'send-notifications',
  '*/5 * * * *',
  $job$
  select net.http_post(
    url := 'https://xvacijpdfqccsigcoctg.supabase.co/functions/v1/send-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'notifications_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $job$
);
