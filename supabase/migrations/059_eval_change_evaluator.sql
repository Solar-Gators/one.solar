select public.migration_begin(59);

-- =============================================================================
-- 059: Solar Evals: change who an eval's evaluator is, and delete a wrong eval
-- =============================================================================
--
--   Some members picked the wrong evaluator on their self-eval. Whoever can "Assign evaluators"
--   (evals.assign: Admin and the President) can now change it on any eval:
--     * a self-eval: who it goes to (ce_id); a CE eval already started from it moves along while it's
--       still a draft (the new evaluator carries on with what was written);
--     * an eval written about someone: who writes it (evaluator_id), and the self-eval it came from points
--       at them too.
--   It's allowed even when the assignments (053) or the evaluation chart (054) say someone else, since
--   fixing that is the point. Each change is kept (eval_evaluator_changes) with who, when and why, and the
--   new evaluator is told about a submitted self-eval.
--
--   They can also delete an eval someone made by mistake (wrong type, wrong person, a duplicate), whatever
--   its stage; the writer could only delete their own drafts. A copy of the eval and its input notes is kept
--   (eval_deletions) with who, when and why, so it can be put back (eval_restore). Deleting a self-eval
--   leaves an evaluation already started from it; putting the self-eval back links them again.
-- =============================================================================

create table public.eval_evaluator_changes (
  id          uuid primary key default gen_random_uuid(),
  eval_id     uuid not null references public.evals(id) on delete cascade,
  from_id     uuid references public.profiles(id) on delete set null,
  to_id       uuid references public.profiles(id) on delete set null,
  note        text not null default '' check (length(note) <= 500),
  changed_by  uuid references public.profiles(id) on delete set null,
  changed_by_name text not null default '',
  changed_at  timestamptz not null default now()
);
create index eval_evaluator_changes_eval_idx on public.eval_evaluator_changes (eval_id, changed_at);
alter table public.eval_evaluator_changes enable row level security;
create policy "assigners read" on public.eval_evaluator_changes for select to authenticated
  using (has_permission('evals.assign') or has_permission('evals.all'));
revoke all on public.eval_evaluator_changes from anon, authenticated;
grant select on public.eval_evaluator_changes to authenticated;

-- Same as 053, plus: an Admin's change of evaluator (eval_change_evaluator) isn't held to the assignments.
create or replace function public.eval_assignment_guard()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_who uuid[]; v_evaluator uuid; v_subject uuid; s jsonb;
begin
  if current_setting('onesolar.eval_reassign', true) = 'on' then return new; end if;
  if not eval_type_assigned(new.type_id) then return new; end if;
  if new.kind = 'self' then
    if new.ce_id is null then return new; end if;
    if tg_op = 'UPDATE' and new.ce_id is not distinct from old.ce_id
       and not (new.status <> 'draft' and old.status = 'draft') then return new; end if;
    v_evaluator := new.ce_id; v_subject := new.evaluator_id;
  else
    if new.self_eval_id is not null or new.subject_id is null then return new; end if;
    if tg_op = 'UPDATE' and new.subject_id is not distinct from old.subject_id then return new; end if;
    v_evaluator := new.evaluator_id; v_subject := new.subject_id;
  end if;
  v_who := eval_assigned_evaluators(new.type_id, v_subject);
  if cardinality(v_who) = 0 or v_evaluator = any(v_who) then return new; end if;
  s := coalesce(new.type_settings, eval_default_settings());
  if new.kind = 'self' then
    raise exception 'Your % is assigned: pick %. Ask an Admin or the President if that''s wrong.', lower(eval_lbl(s, 'evaluator')), eval_names(v_who);
  end if;
  raise exception '% is assigned to %, not you. Ask an Admin or the President if that''s wrong.',
    coalesce((select nullif(trim(full_name), '') from profiles where id = v_subject), 'That person'), eval_names(v_who);
end;
$$;

/** Change who evaluates on p_eval (a self-eval: who it goes to; otherwise who writes it). */
create or replace function public.eval_change_evaluator(p_eval uuid, p_to uuid, p_note text default '')
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  e      evals;
  v_from uuid;
  v_subj uuid;
  v_done text;
begin
  perform require_permission('evals.assign');
  select * into e from evals where id = p_eval for update;
  if e.id is null then raise exception 'That eval doesn''t exist any more.'; end if;
  if length(coalesce(p_note, '')) > 500 then raise exception 'Keep the reason under 500 characters.'; end if;
  if p_to is null or not exists (select 1 from profiles where id = p_to) then raise exception 'Pick someone with a one.solar account.'; end if;
  if not exists (select 1 from profile_roles where user_id = p_to and role not in ('guest', 'alumni')) then
    raise exception '% isn''t on the team (a Guest or an alum).', coalesce((select nullif(trim(full_name), '') from profiles where id = p_to), 'That person');
  end if;
  v_from := case when e.kind = 'self' then e.ce_id else e.evaluator_id end;
  v_subj := case when e.kind = 'self' then e.evaluator_id else coalesce(e.subject_id, e.member_id) end;
  if p_to is not distinct from v_from then return; end if;
  if p_to = v_subj then raise exception 'Someone can''t be their own evaluator.'; end if;

  -- the CE eval that goes with it has to still be a draft to move
  select string_agg(distinct case status when 'final' then 'finished' else 'shared' end, ', ') into v_done
  from evals where kind <> 'self' and status <> 'draft'
    and ((e.kind = 'self' and self_eval_id = e.id) or (e.kind <> 'self' and id = e.id));
  if v_done is not null then
    raise exception 'The evaluation is already % by %. Take it back to a draft first, then change the evaluator.', v_done,
      coalesce((select nullif(trim(full_name), '') from profiles where id = v_from), 'the evaluator');
  end if;

  perform set_config('onesolar.eval_reassign', 'on', true);
  if e.kind = 'self' then
    update evals set ce_id = p_to, input_ids = array_remove(coalesce(input_ids, '{}'), p_to), updated_at = now() where id = e.id;
    update evals set evaluator_id = p_to, input_ids = array_remove(coalesce(input_ids, '{}'), p_to), updated_at = now()
    where self_eval_id = e.id and kind <> 'self' and status = 'draft';
  else
    update evals set evaluator_id = p_to, input_ids = array_remove(coalesce(input_ids, '{}'), p_to), updated_at = now() where id = e.id;
    if e.self_eval_id is not null then update evals set ce_id = p_to, updated_at = now() where id = e.self_eval_id; end if;
  end if;
  perform set_config('onesolar.eval_reassign', '', true);

  insert into eval_evaluator_changes (eval_id, from_id, to_id, note, changed_by, changed_by_name)
  values (e.id, v_from, p_to, trim(coalesce(p_note, '')), auth.uid(), coalesce(my_name(), ''));
  -- a submitted self-eval: the new evaluator is told it's waiting for them
  if e.kind = 'self' and e.status <> 'draft' then perform notify_eval(e.id, 'self_submitted', array[p_to]); end if;
end;
$$;
revoke execute on function public.eval_change_evaluator(uuid, uuid, text) from public, anon;
grant execute on function public.eval_change_evaluator(uuid, uuid, text) to authenticated;

-- ---- deleting a wrong eval ----------------------------------------------------------------------
create table public.eval_deletions (
  id              uuid primary key default gen_random_uuid(),
  eval_id         uuid not null,                  -- no reference: the eval is gone
  kind            text not null,
  status          text not null,
  type_id         text,
  semester        text,
  subject_name    text not null default '',
  evaluator_name  text not null default '',
  snapshot        jsonb not null,                 -- the evals row
  notes           jsonb not null default '[]',    -- its eval_input_notes
  linked          uuid[] not null default '{}',   -- a self-eval: the evaluations started from it
  note            text not null default '' check (length(note) <= 500),
  deleted_by      uuid references public.profiles(id) on delete set null,
  deleted_by_name text not null default '',
  deleted_at      timestamptz not null default now(),
  restored_at     timestamptz,
  restored_by_name text
);
create index eval_deletions_at_idx on public.eval_deletions (deleted_at desc);
alter table public.eval_deletions enable row level security;
create policy "assigners read" on public.eval_deletions for select to authenticated
  using (has_permission('evals.assign') or has_permission('evals.all'));
revoke all on public.eval_deletions from anon, authenticated;
grant select on public.eval_deletions to authenticated;

/** Delete an eval made by mistake, at any stage. Kept in eval_deletions so it can be put back. */
create or replace function public.eval_remove(p_eval uuid, p_note text default '')
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare e evals; v_id uuid; v_subj uuid; v_writer uuid;
begin
  perform require_permission('evals.assign');
  if length(coalesce(p_note, '')) > 500 then raise exception 'Keep the reason under 500 characters.'; end if;
  select * into e from evals where id = p_eval for update;
  if e.id is null then raise exception 'That eval doesn''t exist any more.'; end if;
  v_subj := case when e.kind = 'self' then e.evaluator_id else coalesce(e.subject_id, e.member_id) end;
  v_writer := case when e.kind = 'self' then e.ce_id else e.evaluator_id end;
  insert into eval_deletions (eval_id, kind, status, type_id, semester, subject_name, evaluator_name, snapshot, notes, linked,
                              note, deleted_by, deleted_by_name)
  values (e.id, e.kind, e.status, e.type_id, e.semester,
          coalesce((select nullif(trim(full_name), '') from profiles where id = v_subj), coalesce(to_jsonb(e) ->> 'member_name', '')),
          coalesce((select nullif(trim(full_name), '') from profiles where id = v_writer), ''),
          to_jsonb(e),
          coalesce((select jsonb_agg(to_jsonb(n)) from eval_input_notes n where n.eval_id = e.id), '[]'),
          case when e.kind = 'self' then array(select id from evals where self_eval_id = e.id) else '{}' end,
          trim(coalesce(p_note, '')), auth.uid(), coalesce(my_name(), ''))
  returning id into v_id;
  delete from evals where id = e.id;
  return v_id;
end;
$$;
revoke execute on function public.eval_remove(uuid, text) from public, anon;
grant execute on function public.eval_remove(uuid, text) to authenticated;

/** Put a deleted eval back, as it was (with its input notes; a self-eval is linked to its evaluations again). */
create or replace function public.eval_restore(p_deletion uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare d eval_deletions; e evals;
begin
  perform require_permission('evals.assign');
  select * into d from eval_deletions where id = p_deletion for update;
  if d.id is null then raise exception 'That deleted eval isn''t on the list any more.'; end if;
  if d.restored_at is not null then raise exception 'It was already put back.'; end if;
  if exists (select 1 from evals where id = d.eval_id) then raise exception 'That eval is already there.'; end if;
  e := jsonb_populate_record(null::evals, d.snapshot);
  -- the self-eval it started from is gone, or another evaluation took its place: keep it unlinked
  if e.self_eval_id is not null and (not exists (select 1 from evals where id = e.self_eval_id)
                                     or exists (select 1 from evals where self_eval_id = e.self_eval_id)) then
    e.self_eval_id := null;
  end if;
  perform set_config('onesolar.eval_reassign', 'on', true);
  insert into evals select e.*;
  perform set_config('onesolar.eval_reassign', '', true);
  insert into eval_input_notes select * from jsonb_populate_recordset(null::eval_input_notes, d.notes)
  where author_id in (select id from profiles)
  on conflict do nothing;
  if d.kind = 'self' and not exists (select 1 from evals where self_eval_id = d.eval_id) then
    update evals set self_eval_id = d.eval_id
    where id = (select x from unnest(d.linked) x join evals v on v.id = x and v.self_eval_id is null limit 1);
  end if;
  update eval_deletions set restored_at = now(), restored_by_name = coalesce(my_name(), '') where id = d.id;
  return d.eval_id;
end;
$$;
revoke execute on function public.eval_restore(uuid) from public, anon;
grant execute on function public.eval_restore(uuid) to authenticated;

select public.migration_done(59, '059_eval_change_evaluator.sql');
