select public.migration_begin(57);

-- =============================================================================
-- 057: fill in people's division & subsystem (056) from their Solar Evals
-- =============================================================================
--
--   056 started everyone with no division or subsystem, even people whose evals already say one
--   ("Electrical CE · BMS"). Now:
--     * once, here: everyone with none yet gets the one from their latest eval;
--     * from now on: saving an eval does the same for its person, if they still have none;
--     * Admin → Divisions & people → "Fill in from Solar Evals" runs it again (e.g. after adding
--       subsystems in Admin → CE divisions & subsystems).
--   It never changes anyone who already has one (what people set themselves wins). An eval's text is
--   matched by name, ignoring case and a trailing " CE": the subsystem (in the eval's division if it has
--   one by that name, else in any), or else the whole division. Names that match nothing are skipped.
-- =============================================================================

/** The current division & subsystem an eval's text names, if any. */
create or replace function public.person_org_match(p_division text, p_subsystem text, out division_id uuid, out subsystem_id uuid)
language sql stable security definer set search_path = public, pg_temp
as $$
  with n as (
    select lower(trim(regexp_replace(coalesce(p_division, ''), '\s+CE$', '', 'i'))) d,
           lower(regexp_replace(trim(coalesce(p_subsystem, '')), '\s+', ' ', 'g')) s
  ), hit as (
    select s.division_id, s.id subsystem_id, 0 pref, (lower(d.name) = n.d)::int same, d.sort, s.sort ssort
    from n, org_subsystems s join org_divisions d on d.id = s.division_id
    where n.s <> '' and lower(s.name) = n.s and s.archived_at is null and d.archived_at is null
    union all
    select d.id, null, 1, 1, d.sort, 0
    from n, org_divisions d
    where n.d <> '' and lower(trim(regexp_replace(d.name, '\s+CE$', '', 'i'))) = n.d and d.archived_at is null
  )
  select division_id, subsystem_id from hit order by pref, same desc, sort, ssort limit 1;
$$;

/** Give p_user (if they have no division or subsystem yet) the one their latest matching eval names. */
create or replace function public.person_org_fill(p_user uuid)
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare m record;
begin
  if p_user is null or exists (select 1 from person_org where user_id = p_user)
     or not exists (select 1 from profiles where id = p_user) then
    return false;
  end if;
  select x.division_id, x.subsystem_id into m
  from evals e, lateral person_org_match(e.division, e.subsystem) x
  where coalesce(e.subject_id, e.member_id) = p_user and x.division_id is not null
  order by (e.subsystem <> '') desc, e.updated_at desc
  limit 1;
  if m.division_id is null then return false; end if;
  insert into person_org (user_id, division_id, subsystem_id, main, updated_by_name)
  values (p_user, m.division_id, m.subsystem_id, true, 'From Solar Evals')
  on conflict do nothing;
  return true;
end;
$$;

/** Everyone with none yet. Returns how many were filled in. */
create or replace function public.person_org_fill_all_internal()
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_n int := 0; v_u uuid;
begin
  for v_u in select distinct coalesce(subject_id, member_id) from evals where coalesce(subject_id, member_id) is not null loop
    if person_org_fill(v_u) then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end;
$$;

/** Admin → Divisions & people → "Fill in from Solar Evals" (people managers). */
create or replace function public.person_org_fill_from_evals()
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not has_permission('users.manage') then
    raise exception 'Only people who can "Manage people & roles" can fill these in for everyone.';
  end if;
  return person_org_fill_all_internal();
end;
$$;

/** Saving an eval fills in its person's division & subsystem if they have none. Never stops the save. */
create or replace function public.evals_fill_person_org()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if (new.division <> '' or new.subsystem <> '') and coalesce(new.subject_id, new.member_id) is not null then
    begin
      perform person_org_fill(coalesce(new.subject_id, new.member_id));
    exception when others then
      null;   -- a fill-in is a nicety; the eval must save regardless
    end;
  end if;
  return null;
end;
$$;
create trigger evals_fill_person_org
  after insert or update of division, subsystem, subject_id, member_id on public.evals
  for each row execute function public.evals_fill_person_org();

revoke execute on function public.person_org_match(text, text) from public, anon, authenticated;
revoke execute on function public.person_org_fill(uuid) from public, anon, authenticated;
revoke execute on function public.person_org_fill_all_internal() from public, anon, authenticated;
revoke execute on function public.evals_fill_person_org() from public, anon, authenticated;
revoke execute on function public.person_org_fill_from_evals() from public, anon;
grant execute on function public.person_org_fill_from_evals() to authenticated;

-- Once, for everyone who did an eval before 056.
select public.person_org_fill_all_internal();

select public.migration_done(57, '057_people_org_from_evals.sql');
