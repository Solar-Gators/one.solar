-- After restoring a database dump into a Supabase project (docs/RECOVERY.md, step 4), run this once in
-- Supabase → SQL Editor.
--
-- A dump of the public schema (supabase db dump) doesn't bring back what our migrations added to
-- Supabase's own `auth` and `storage` schemas:
--   * the trigger that makes a profile (a Guest) for every new sign-up (001_initial.sql). Without it,
--     new accounts can't use any app.
--   * the private "attachments" bucket and who may read, upload and delete files in it (017, read rule
--     from 025). Without them, attachments can't be opened or added.
-- The FILES in the bucket aren't in a dump either: copy them separately (docs/RECOVERY.md, step 5).
--
-- Safe to run more than once. It changes nothing in the public schema.

-- ---- Sign-ups get a profile ------------------------------------------------------
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---- The attachments bucket and its rules --------------------------------------
do $storage$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'No Supabase Storage here: skipped the attachments bucket.';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('attachments', 'attachments', false, 10485760, array[
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'application/pdf', 'text/plain', 'text/csv',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/postscript', 'application/illustrator', 'application/zip'])
  on conflict (id) do nothing;

  execute 'drop policy if exists "attachments: read" on storage.objects';
  execute 'drop policy if exists "attachments: upload" on storage.objects';
  execute 'drop policy if exists "attachments: delete" on storage.objects';

  -- From 025_treasurer_tools.sql (the latest version of this rule).
  execute $p$
    create policy "attachments: read" on storage.objects for select to authenticated using (
      bucket_id = 'attachments' and (
        exists (
          select 1 from public.attachments a where a.path = name
            and public.attachment_access(public.attachment_kind(a), coalesce(a.sponsor_card_id, a.request_id, a.finance_row_id), false))
        or (split_part(name, '/', 2) ~ '^[0-9a-f-]{36}$'
            and not exists (select 1 from public.attachments a where a.path = name)
            and public.attachment_access(split_part(name, '/', 1), split_part(name, '/', 2)::uuid, true))))
  $p$;
  -- From 017_attachments.sql.
  execute $p$
    create policy "attachments: upload" on storage.objects for insert to authenticated with check (
      bucket_id = 'attachments'
      and split_part(name, '/', 2) ~ '^[0-9a-f-]{36}$'
      and public.attachment_access(split_part(name, '/', 1), split_part(name, '/', 2)::uuid, true))
  $p$;
  execute $p$
    create policy "attachments: delete" on storage.objects for delete to authenticated using (
      bucket_id = 'attachments'
      and split_part(name, '/', 2) ~ '^[0-9a-f-]{36}$'
      and public.attachment_access(split_part(name, '/', 1), split_part(name, '/', 2)::uuid, true)
      and not exists (select 1 from public.attachments a where a.path = name))
  $p$;
end
$storage$;

-- ---- Check ---------------------------------------------------------------------------
select
  exists (select 1 from pg_trigger where tgname = 'on_auth_user_created' and tgrelid = 'auth.users'::regclass) as signup_trigger,
  (select count(*) from pg_policies where schemaname = 'storage' and policyname like 'attachments:%') as attachment_rules;
-- Expect: signup_trigger = true, attachment_rules = 3.
