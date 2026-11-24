-- After restoring a database dump into a Supabase project (docs/RECOVERY.md, step 4), run this once in
-- Supabase → SQL Editor.
--
-- A dump of the public schema (supabase db dump) doesn't bring back what our migrations added to
-- Supabase's own `auth` and `storage` schemas:
--   * the trigger that makes a profile (a Guest) for every new sign-up (001_initial.sql). Without it,
--     new accounts can't use any app.
--   * the trigger that copies a changed sign-in email to the profile (052), so notices follow it.
--   * the private "attachments" bucket and who may read, upload and delete files in it (017, read rule
--     from 025). Without them, attachments can't be opened or added.
--   * the public "sgaa" bucket (SGAA photos) and who may upload and delete in it (052).
-- The FILES in the buckets aren't in a dump either: copy them separately (docs/RECOVERY.md, step 5).
--
-- Safe to run more than once. It changes nothing in the public schema.

-- ---- Sign-ups get a profile ------------------------------------------------------
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---- A changed email reaches the profile -------------------------------------------
drop trigger if exists sync_profile_email on auth.users;
create trigger sync_profile_email after update of email on auth.users
  for each row execute function public.sync_profile_email();

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

  -- From 069_projects_stage2.sql (the latest version of this rule: by attachment_owner, so Projects items too).
  execute $p$
    create policy "attachments: read" on storage.objects for select to authenticated using (
      bucket_id = 'attachments' and (
        exists (
          select 1 from public.attachments a where a.path = name
            and public.attachment_access(public.attachment_kind(a), public.attachment_owner(a), false))
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

-- ---- The SGAA photos bucket and its rules -------------------------------------
do $storage$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'No Supabase Storage here: skipped the sgaa bucket.';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('sgaa', 'sgaa', true, 8388608, array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
  on conflict (id) do nothing;
  execute 'drop policy if exists "sgaa: upload" on storage.objects';
  execute 'drop policy if exists "sgaa: delete" on storage.objects';
  execute $p$
    create policy "sgaa: upload" on storage.objects for insert to authenticated with check (
      bucket_id = 'sgaa' and split_part(name, '/', 1) in ('needs', 'updates') and public.sgaa_can('sgaa.edit'))
  $p$;
  execute $p$
    create policy "sgaa: delete" on storage.objects for delete to authenticated using (
      bucket_id = 'sgaa' and public.sgaa_can('sgaa.edit'))
  $p$;
end
$storage$;

-- ---- Check ---------------------------------------------------------------------------
select
  exists (select 1 from pg_trigger where tgname = 'on_auth_user_created' and tgrelid = 'auth.users'::regclass) as signup_trigger,
  exists (select 1 from pg_trigger where tgname = 'sync_profile_email' and tgrelid = 'auth.users'::regclass) as email_sync_trigger,
  (select count(*) from pg_policies where schemaname = 'storage' and policyname like 'attachments:%') as attachment_rules,
  (select count(*) from pg_policies where schemaname = 'storage' and policyname like 'sgaa:%') as sgaa_rules;
-- Expect: signup_trigger = true, email_sync_trigger = true, attachment_rules = 3, sgaa_rules = 2.
