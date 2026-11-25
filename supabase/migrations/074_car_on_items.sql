select public.migration_begin(74);

-- =============================================================================
-- 074: the car cycle belongs to the work, not the Space. A Space (one per subsystem, 072) lasts across cars;
-- each item says which car it's for, and the car switcher in Workbench filters the work by it.
--   * pm_items.program_id: the item's car. Existing items get their Space's car, or the current car.
--   * Spaces lose their car (pm_projects.program_id is cleared; the column stays for older templates).
--   * A new item without a car gets its parent's, else the current car. It can be set and changed like any
--     other field (pmx_patch), and the "program" filter is now the item's own car.
-- =============================================================================

alter table public.pm_items add column if not exists program_id uuid references public.pm_programs(id) on delete set null;
create index if not exists pm_items_program_idx on public.pm_items (program_id);

update public.pm_items i set program_id = coalesce(
    (select p.program_id from public.pm_projects p join public.pm_programs g on g.id = p.program_id where p.id = i.project_id and g.archived_at is null),
    (select g.id from public.pm_programs g where g.is_current and g.archived_at is null))
where i.program_id is null;
update public.pm_projects set program_id = null where program_id is not null;

/** A new item's car when none is given: its parent's, else the current car. A car has to exist and not be archived. */
create or replace function public.pmx_item_car()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' and new.program_id is null then
    new.program_id := coalesce((select program_id from pm_items where id = new.parent_id),
                               (select id from pm_programs where is_current and archived_at is null));
  end if;
  if new.program_id is not null and new.program_id is distinct from (case when tg_op = 'UPDATE' then old.program_id end)
     and not exists (select 1 from pm_programs where id = new.program_id and archived_at is null) then
    raise exception 'That car cycle doesn''t exist, or it''s archived.';
  end if;
  return new;
end;
$$;
drop trigger if exists pm_items_car on public.pm_items;
create trigger pm_items_car before insert or update of program_id on public.pm_items
  for each row execute function public.pmx_item_car();
revoke execute on function public.pmx_item_car() from public, anon, authenticated;

-- the car is one of the parts of an item a person can set
create or replace function public.pmx_patch(p jsonb)
returns jsonb language sql immutable set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(k, case
      when k in ('title', 'description', 'vehicle', 'blocked_reason', 'acceptance') then to_jsonb(coalesce(p ->> k, ''))
      when k = 'labels' then to_jsonb(pmx_texts(p -> k))
      when p -> k = '""'::jsonb then 'null'::jsonb
      else p -> k end), '{}'::jsonb)
  from unnest(array['title', 'description', 'priority', 'owner_id', 'division_id', 'subsystem_id', 'vehicle', 'start_date', 'due_date', 'estimate_hours',
                    'progress', 'actual_start', 'blocked', 'blocked_reason', 'acceptance', 'labels', 'sprint_id', 'parent_id', 'rank', 'program_id']) k
  where p ? k;
$$;

-- saving an item writes its car too (and its history says when the car changed)
create or replace function public.pmx_update(p_id uuid, p_version int, p jsonb, p_internal boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  o         pm_items;
  n         pm_items;
  v_patch   jsonb := pmx_patch(p);
  v_changes jsonb := '{}';
  v_keys    text[];
  v_type    pm_types;
  v_st      pm_statuses;
  v_before  text[];
  v_miss    text[];
  v_req     text[];
  k         text;
  v_people  boolean := false;
  v_quiet   boolean := coalesce(current_setting('pm.quiet', true), '') = '1';
begin
  select * into o from pm_items where id = p_id for update;
  if o.id is null then raise exception 'That item doesn''t exist.'; end if;
  if not p_internal then
    perform pmx_need(o.project_id, 'view');
    if not pmx_may_edit(o) then
      -- planners may still set dates, sprint and order
      if pmx_can(o.project_id, 'plan') and not exists (select 1 from jsonb_object_keys(p) x where x not in ('start_date', 'due_date', 'sprint_id', 'rank', 'parent_id')) then null;
      else perform pmx_need(o.project_id, 'edit');
      end if;
    end if;
  end if;
  if o.archived_at is not null then raise exception '% is archived. Restore it to change it.', o.key; end if;
  if p_version is not null and p_version <> o.version then
    raise exception '% was changed by someone else while you had it open. Reload to see their changes, then make yours again.', o.key using errcode = 'OS409';
  end if;

  n := jsonb_populate_record(o, v_patch);
  if not p_internal then
    if n.owner_id is distinct from o.owner_id and n.owner_id is distinct from auth.uid() then perform pmx_need(o.project_id, 'assign'); end if;
    if n.sprint_id is distinct from o.sprint_id then perform pmx_need(o.project_id, 'plan'); end if;
  end if;
  if p ? 'type_id' and pmx_uuid(p ->> 'type_id') <> o.type_id then
    select * into v_type from pm_types where id = pmx_uuid(p ->> 'type_id') and project_id = o.project_id and archived_at is null;
    if v_type.id is null then raise exception 'Pick one of this project''s work-item types.'; end if;
    n.type_id := v_type.id;
    if not exists (select 1 from pm_statuses where id = o.status_id and workflow_id = v_type.workflow_id) then
      select * into v_st from pm_statuses where id = pmx_uuid(p ->> 'status_id') and workflow_id = v_type.workflow_id;
      if v_st.id is null then
        raise exception '% items use another workflow. Pick the status it should have there.', v_type.name using errcode = 'OS428', detail = '["status_id"]';
      end if;
      n.status_id := v_st.id;
      n.category := v_st.category;
      update pm_approvals set status = 'cancelled', note = 'The item''s type changed.', decided_at = now() where item_id = o.id and status = 'pending';
    end if;
    -- values of fields the new type doesn't use are kept in the history, not on the item
    n.custom := coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(o.custom) e join pm_fields f on f.project_id = o.project_id and f.key = e.key
      where cardinality(f.type_ids) = 0 or v_type.id = any(f.type_ids)), '{}');
  end if;
  n := pmx_check_item(n, o);
  if p ? 'custom' then n.custom := pmx_clean_custom(o.project_id, n.type_id, p -> 'custom', n.custom); end if;

  -- a required field can't be emptied (one that was already empty doesn't block unrelated edits)
  v_req := pmx_required(o.project_id, n.type_id, 'edit', null);
  v_before := pmx_missing(o, v_req);
  select coalesce(array_agg(x), '{}') into v_miss from unnest(pmx_missing(n, v_req)) x where not (x = any(v_before));
  if cardinality(v_miss) > 0 and not p_internal then
    raise exception '% can''t be left empty.', pmx_field_names(o.project_id, v_miss) using errcode = 'OS428', detail = to_jsonb(v_miss)::text;
  end if;

  foreach k in array array['title', 'description', 'priority', 'owner_id', 'division_id', 'subsystem_id', 'vehicle', 'start_date', 'due_date', 'estimate_hours',
                           'progress', 'actual_start', 'blocked', 'blocked_reason', 'acceptance', 'labels', 'sprint_id', 'parent_id', 'type_id', 'status_id', 'program_id'] loop
    if (to_jsonb(o) -> k) is distinct from (to_jsonb(n) -> k) then
      v_changes := v_changes || jsonb_build_object(k, case when k in ('description', 'acceptance') then '[true]'::jsonb else jsonb_build_array(to_jsonb(o) -> k, to_jsonb(n) -> k) end);
    end if;
  end loop;
  select v_changes || coalesce(jsonb_object_agg('cf.' || kk, jsonb_build_array(o.custom -> kk, n.custom -> kk)), '{}') into v_changes
  from (select jsonb_object_keys(o.custom || n.custom) as kk) x where (o.custom -> kk) is distinct from (n.custom -> kk);

  if p ? 'collaborators' then
    delete from pm_people where item_id = o.id and kind = 'collab' and not (user_id = any(pmx_uuids(p -> 'collaborators')));
    if found then v_people := true; end if;
    insert into pm_people (item_id, user_id, kind, project_id) select o.id, x, 'collab', o.project_id from unnest(pmx_uuids(p -> 'collaborators')) x where is_member(x)
    on conflict do nothing;
    if found then v_people := true; end if;
  end if;
  if p ? 'watchers' then
    delete from pm_people where item_id = o.id and kind = 'watch' and not (user_id = any(pmx_uuids(p -> 'watchers')));
    insert into pm_people (item_id, user_id, kind, project_id) select o.id, x, 'watch', o.project_id from unnest(pmx_uuids(p -> 'watchers')) x where is_member(x)
    on conflict do nothing;
  end if;
  if v_people then v_changes := v_changes || jsonb_build_object('collaborators', '[true]'::jsonb); end if;

  if v_changes = '{}'::jsonb and n.rank is not distinct from o.rank then return to_jsonb(o); end if;
  update pm_items set title = n.title, description = n.description, priority = n.priority, owner_id = n.owner_id, division_id = n.division_id,
    subsystem_id = n.subsystem_id, vehicle = n.vehicle, start_date = n.start_date, due_date = n.due_date, estimate_hours = n.estimate_hours,
    progress = n.progress, actual_start = n.actual_start, blocked = n.blocked, blocked_reason = n.blocked_reason, acceptance = n.acceptance,
    labels = n.labels, sprint_id = n.sprint_id, parent_id = n.parent_id, rank = n.rank, type_id = n.type_id, status_id = n.status_id, category = n.category, program_id = n.program_id,
    custom = n.custom, version = case when v_changes = '{}'::jsonb then version else version + 1 end,
    updated_at = case when v_changes = '{}'::jsonb then updated_at else now() end
  where id = o.id returning * into n;
  if v_changes = '{}'::jsonb then return to_jsonb(n); end if;   -- only its place in the list moved

  select array_agg(x) into v_keys from jsonb_object_keys(v_changes) x;
  perform pmx_log(o.project_id, o.id, 'updated', 'Changed ' || pmx_field_names(o.project_id, v_keys), jsonb_build_object('changes', v_changes));
  if n.owner_id is distinct from o.owner_id and n.owner_id is not null then
    perform pmx_notify(array[n.owner_id], 'assigned', o.id, 'Assigned to you: ' || n.title, coalesce(my_display_name(), 'Someone') || ' gave you ' || n.key || ' "' || n.title || '".');
  end if;
  if not v_quiet and v_keys && array['due_date', 'start_date', 'blocked', 'priority', 'title', 'owner_id'] then
    perform pmx_notify(pmx_audience(o.id), 'updated', o.id, 'Changed: ' || n.title,
      coalesce(my_display_name(), 'Someone') || ' changed ' || pmx_field_names(o.project_id, v_keys) || ' on ' || n.key || '.');
  end if;
  if n.owner_id is distinct from o.owner_id then perform pmx_fire('assigned', o.id, '{}'); end if;
  perform pmx_fire('updated', o.id, jsonb_build_object('changed', to_jsonb(v_keys)));
  return to_jsonb(n);
end;
$$;

-- the "program" (car) filter is the item's own car now
create or replace function public.pmx_where(c jsonb, p_depth int default 0)
returns text language plpgsql stable set search_path = public, pg_temp
as $$
declare
  v_parts text[] := '{}';
  v_el    jsonb;
  f       text;
  op      text;
  v       jsonb;
  col     text;
  kind    text;
  k       text;
  s       text;
  lits    text;
  n       numeric;
begin
  if c is null or jsonb_typeof(c) <> 'object' or c = '{}'::jsonb then return 'true'; end if;
  if p_depth > 6 then raise exception 'That filter is nested too deeply.'; end if;
  if c ? 'all' or c ? 'any' then
    v := coalesce(c -> 'all', c -> 'any');
    if jsonb_typeof(v) <> 'array' then return 'true'; end if;
    if jsonb_array_length(v) > 40 then raise exception 'That filter has too many conditions.'; end if;
    for v_el in select * from jsonb_array_elements(v) loop
      v_parts := v_parts || pmx_where(v_el, p_depth + 1);
    end loop;
    if cardinality(v_parts) = 0 then return 'true'; end if;
    return '(' || array_to_string(v_parts, case when c ? 'all' then ' and ' else ' or ' end) || ')';
  end if;
  if c ? 'not' then return '(not ' || pmx_where(c -> 'not', p_depth + 1) || ')'; end if;

  f := coalesce(c ->> 'f', '');
  op := coalesce(c ->> 'op', 'eq');
  v := c -> 'v';
  -- 069: has been in a status (now, or any move to or from it in the item's history), by status name
  if f = 'been_in' then
    if op not in ('eq', 'ne', 'in', 'nin') then raise exception 'Unknown filter operator "%".', left(op, 20); end if;
    if jsonb_typeof(v) <> 'array' then v := jsonb_build_array(v); end if;
    if jsonb_array_length(v) > 200 then raise exception 'That filter has too many values.'; end if;
    select string_agg(format('%L', x), ', ') into lits from jsonb_array_elements_text(v) x where x is not null;
    if lits is null then raise exception 'The filter on "%" needs a value.', f; end if;
    col := format('exists (select 1 from pm_statuses hs where hs.project_id = i.project_id and hs.name in (%s) and (hs.id = i.status_id'
      || ' or exists (select 1 from pm_events he where he.item_id = i.id and he.kind = ''status'''
      || ' and (he.data ->> ''to'' = hs.id::text or he.data ->> ''from'' = hs.id::text))))', lits);
    return case when op in ('ne', 'nin') then '(not ' || col || ')' else col end;
  end if;
  if f in ('project', 'type', 'status', 'owner', 'reporter', 'division', 'subsystem', 'sprint', 'parent') then
    kind := 'uuid'; col := 'i.' || f || '_id';
  elsif f = 'program' then kind := 'uuid'; col := 'i.program_id';   -- 074: the item's own car
  elsif f in ('priority', 'category', 'vehicle', 'key', 'title') then kind := 'text'; col := 'i.' || f;
  elsif f = 'type_name' then kind := 'text'; col := '(select tt.name from pm_types tt where tt.id = i.type_id)';
  elsif f = 'status_name' then kind := 'text'; col := '(select ss.name from pm_statuses ss where ss.id = i.status_id)';
  elsif f = 'parent_status' then kind := 'text';   -- 069
    col := '(select ps.name from pm_items pi join pm_statuses ps on ps.id = pi.status_id where pi.id = i.parent_id)';
  elsif f in ('due', 'start') then kind := 'date'; col := 'i.' || f || '_date';
  elsif f in ('created', 'updated', 'completed') then kind := 'date'; col := '(i.' || f || '_at)::date';
  elsif f = 'progress' then kind := 'num'; col := 'i.progress';
  elsif f = 'estimate' then kind := 'num'; col := 'i.estimate_hours';
  elsif f = 'blocked' then kind := 'bool'; col := 'i.blocked';
  elsif f = 'unassigned' then kind := 'bool'; col := '(i.owner_id is null)';
  elsif f = 'accepted' then kind := 'bool'; col := '(i.accepted_at is not null)';
  elsif f = 'overdue' then kind := 'bool'; col := '(i.due_date < current_date and i.category <> ''done'')';
  elsif f = 'milestone' then kind := 'bool'; col := '(select tt.is_milestone from pm_types tt where tt.id = i.type_id)';
  elsif f = 'open_deps' then kind := 'bool';
    col := 'exists (select 1 from pm_deps dd join pm_items xx on xx.id = dd.from_item where dd.to_item = i.id and xx.category <> ''done'' and xx.archived_at is null)';
  elsif f = 'awaiting' then kind := 'bool'; col := 'exists (select 1 from pm_approvals aa where aa.item_id = i.id and aa.status = ''pending'')';
  elsif f = 'mine' then kind := 'bool';
    col := '(i.owner_id = auth.uid() or exists (select 1 from pm_people pe where pe.item_id = i.id and pe.user_id = auth.uid() and pe.kind = ''collab''))';
  elsif f = 'children_done' then kind := 'bool';   -- 069: every item under it is done (true when there are none)
    col := '(not exists (select 1 from pm_items ci where ci.parent_id = i.id and ci.archived_at is null and ci.category <> ''done''))';
  elsif f = 'worked_on' then kind := 'bool';   -- 069: I changed it (anything in its history) in the last 30 days
    col := 'exists (select 1 from pm_events we where we.item_id = i.id and we.actor_id = auth.uid() and we.created_at > now() - interval ''30 days'')';
  elsif f = 'watching' then kind := 'bool';
    col := 'exists (select 1 from pm_people pe where pe.item_id = i.id and pe.user_id = auth.uid() and pe.kind = ''watch'')';
  elsif f = 'labels' then kind := 'array'; col := 'i.labels';
  elsif f = 'text' then kind := 'search';
  elsif f ~ '^cf\.[a-z][a-z0-9_]{0,39}$' then kind := 'cf'; k := substr(f, 4); col := format('(i.custom ->> %L)', k);
  else raise exception 'Unknown filter field "%".', left(f, 40);
  end if;

  if op not in ('eq', 'ne', 'in', 'nin', 'lt', 'lte', 'gt', 'gte', 'contains', 'empty', 'notempty', 'is', 'within', 'past', 'last') then
    raise exception 'Unknown filter operator "%".', left(op, 20);
  end if;
  s := case when jsonb_typeof(v) in ('string', 'number', 'boolean') then v #>> '{}' else null end;

  if kind = 'bool' then
    return case when s = 'false' or op = 'ne' then '(not coalesce(' || col || ', false))' else 'coalesce(' || col || ', false)' end;
  end if;
  if kind = 'search' then
    if coalesce(s, '') = '' then return 'true'; end if;
    s := '%' || replace(replace(replace(left(s, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%';
    return format('(i.title ilike %L or i.key ilike %L or i.description ilike %L)', s, s, s);
  end if;
  if op in ('empty', 'notempty') then
    col := case kind when 'text' then format('(coalesce(%s, '''') = '''')', col) when 'array' then format('(cardinality(%s) = 0)', col)
                     when 'cf' then format('(coalesce(%s, '''') in ('''', ''[]''))', col) else format('(%s is null)', col) end;
    return case when op = 'empty' then col else '(not ' || col || ')' end;
  end if;

  if kind = 'date' and op in ('within', 'past', 'last') then
    n := coalesce(pmx_num(s), 0)::int;
    return case op when 'within' then format('(%s between current_date and current_date + %s)', col, n)
                   when 'past' then format('(%s < current_date - %s)', col, n)
                   else format('(%s between current_date - %s and current_date)', col, n) end;
  end if;

  -- a list of values
  if op in ('in', 'nin') or (kind = 'array' and jsonb_typeof(v) = 'array') then
    if jsonb_typeof(v) <> 'array' then v := jsonb_build_array(v); end if;
    if jsonb_array_length(v) > 200 then raise exception 'That filter has too many values.'; end if;
    select string_agg(case when kind = 'uuid' then case when x = 'me' then 'auth.uid()' else format('%L::uuid', pmx_uuid(x)) end else format('%L', x) end, ', ')
      into lits from jsonb_array_elements_text(v) x;
    if lits is null then return case when op = 'nin' then 'true' else 'false' end; end if;
    if kind = 'array' then
      return case when op = 'nin' then format('(not %s && array[%s]::text[])', col, lits) else format('(%s && array[%s]::text[])', col, lits) end;
    elsif kind = 'cf' then
      return case when op = 'nin' then format('(%s is null or (%s not in (%s) and not (i.custom -> %L) ?| array[%s]))', col, col, lits, k, lits)
                  else format('(%s in (%s) or (i.custom -> %L) ?| array[%s])', col, lits, k, lits) end;
    elsif kind = 'uuid' then
      return case when op = 'nin' then format('(%s is null or %s not in (%s))', col, col, lits) else format('(%s in (%s))', col, lits) end;
    else
      return case when op = 'nin' then format('(%s is null or %s::text not in (%s))', col, col, lits) else format('(%s::text in (%s))', col, lits) end;
    end if;
  end if;

  if s is null then raise exception 'The filter on "%" needs a value.', f; end if;
  if kind = 'uuid' then
    lits := case when s = 'me' then 'auth.uid()' else format('%L::uuid', pmx_uuid(s)) end;
    return case when op = 'ne' then format('(%s is distinct from %s)', col, lits) else format('(%s = %s)', col, lits) end;
  elsif kind = 'array' then
    return case when op = 'ne' then format('(not %L = any(%s))', s, col) else format('(%L = any(%s))', s, col) end;
  elsif kind = 'date' then
    lits := case when s = 'today' then 'current_date' else format('%L::date', s::date) end;
    return format('(%s %s %s)', col, case op when 'lt' then '<' when 'lte' then '<=' when 'gt' then '>' when 'gte' then '>=' when 'ne' then '<>' else '=' end, lits);
  elsif kind = 'num' then
    if pmx_num(s) is null then raise exception '"%" isn''t a number.', left(s, 40); end if;
    return format('(%s %s %s)', col, case op when 'lt' then '<' when 'lte' then '<=' when 'gt' then '>' when 'gte' then '>=' when 'ne' then '<>' else '=' end, pmx_num(s));
  elsif op = 'contains' then
    lits := '%' || replace(replace(replace(left(s, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%';
    return case when kind = 'cf' then format('(%s ilike %L or (i.custom -> %L) ? %L)', col, lits, k, s) else format('(%s ilike %L)', col, lits) end;
  elsif op in ('lt', 'lte', 'gt', 'gte') then
    if kind = 'cf' and pmx_num(s) is not null then
      return format('(pmx_num(%s) %s %s)', col, case op when 'lt' then '<' when 'lte' then '<=' when 'gt' then '>' else '>=' end, pmx_num(s));
    end if;
    return format('(%s %s %L)', col, case op when 'lt' then '<' when 'lte' then '<=' when 'gt' then '>' else '>=' end, s);
  elsif kind = 'cf' then
    return case when op = 'ne' then format('(%s is distinct from %L and not coalesce((i.custom -> %L) ? %L, false))', col, s, k, s)
                else format('(%s = %L or (i.custom -> %L) ? %L)', col, s, k, s) end;
  else
    return case when op = 'ne' then format('(%s is distinct from %L)', col, s) else format('(%s = %L)', col, s) end;
  end if;
end;
$$;

select public.migration_done(74, '074_car_on_items.sql');
