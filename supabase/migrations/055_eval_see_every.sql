select public.migration_begin(55);

-- =============================================================================
-- 055: Solar Evals: "See every eval (troubleshooting)"
-- =============================================================================
--
--   For troubleshooting: someone whose role has evals.all reads every evaluation (drafts too) and every
--   submitted self-eval, whatever the eval type's "Who sees what" says. Read only: it doesn't let them
--   change, finish, share or delete anything. Admin only by default; untick it in Admin → Roles &
--   permissions when it's no longer needed.
--
--   Self-eval drafts stay private to the person writing them. Input notes stay between their author and
--   the evaluator.
-- =============================================================================

insert into public.permissions (key, label, description, sort) values
  ('evals.all', 'See every eval (troubleshooting)', 'Solar Evals: read every evaluation, drafts included, and every submitted self-eval, whatever each eval type''s "Who sees what" says. Read only.', 15)
on conflict (key) do nothing;
insert into public.role_permissions (role, permission)
select 'admin', 'evals.all' where exists (select 1 from public.roles where key = 'admin')
on conflict do nothing;
select public.record_permissions_snapshot();

-- A second read policy: Postgres lets a row through when any policy allows it, so "eval readers" is unchanged.
drop policy if exists "troubleshooting readers" on public.evals;
create policy "troubleshooting readers" on public.evals for select to authenticated using (
  public.has_permission('evals.all') and (kind <> 'self' or status <> 'draft')
);

select public.migration_done(55, '055_eval_see_every.sql');
