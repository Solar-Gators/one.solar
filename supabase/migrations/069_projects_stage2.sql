select public.migration_begin(69);

-- =============================================================================
-- 069: Projects, Stage 2 of the Jira upgrade (draft number: renumber when the UI migrations land)
-- =============================================================================
--
--   1. More kinds of record in the link registry (068), each kept in its own app's hands:
--        event    an Events event, for people who can see that event (ev_sees)
--        sponsor  a Sponsors card, for people with a Sponsors permission (name, stage, season; never amounts or contacts)
--        item     another Projects item ("related to"), for people who can see its project. Not a scheduling
--                 dependency: it never moves dates. Shown on both items.
--   2. Three more things a move (or a view, or an automation) can check, in the shared condition model:
--        children_done   every item under it is done (true when there are none)
--        parent_status   the parent item's status, by name
--        been_in         it has been in a status, by name (now, or any earlier move to or from it)
--
--   3. One more rule action, move_parent: move the item's parent to a status once everything under it is done
--      (the "close the parent" starter rule). Starter rules themselves are just pre-filled rules on the page.
--
--   4. Project settings may also hold hidden_tabs (tabs a project doesn't show) and phases (named date ranges
--      shaded on its timeline); both are checked here and only change what the pages show.
--
--   5. Searches can ask for "worked_on" (items I changed in the last 30 days), and rules get a "move_children"
--      action (move the open items under it).
--   6. Dropdown choices can have colors (pm_fields.option_tones).
--   7. Files on Projects items: the shared files & links (017) get one more owner, a Projects item. Anyone who can
--      see the item sees its files; whoever can edit the item adds and removes them.
--
--   Nothing is removed or renamed; existing links, moves, views and rules work as before.

-- ---- filters: a checked model turned into SQL (never SQL from the page) ----------------------------
--   { "all": [ … ] } | { "any": [ … ] } | { "not": … } | { "f": field, "op": operator, "v": value }
--   Fields: project type status owner reporter division subsystem sprint parent program · priority category
--   vehicle key title type_name status_name · due start created updated completed · progress estimate ·
--   blocked overdue milestone open_deps accepted awaiting mine watching unassigned children_done · labels · text · cf.<key>
--   parent_status (the parent's status name) · been_in (status names it has ever been in: eq ne in nin)
--   Operators: eq ne in nin lt lte gt gte contains empty notempty is within past last
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
  elsif f = 'program' then kind := 'uuid'; col := '(select pp.program_id from pm_projects pp where pp.id = i.project_id)';
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
-- ---- Events ------------------------------------------------------------------------------------------
create or replace function public.events_link_describe(p_ids uuid[])
returns setof public.os_link_row language sql stable security definer set search_path = public, pg_temp
as $$
  select e.id, '', e.title,
         case when e.cancelled_at is not null then 'Cancelled' when coalesce(e.ends_at, e.starts_at) < now() then 'Past' else 'Upcoming' end,
         case when e.cancelled_at is not null then 'red' when coalesce(e.ends_at, e.starts_at) < now() then 'gray' else 'blue' end,
         to_char(e.starts_at at time zone 'America/New_York', 'Mon FMDD, YYYY'),
         'events/#/events/e/' || e.id
  from ev_events e where e.id = any(p_ids) and ev_sees(e.id);
$$;
create or replace function public.events_link_search(p_q text, p_limit int)
returns setof public.os_link_row language sql stable security definer set search_path = public, pg_temp
as $$
  select d.* from (
    select e.id, e.starts_at from ev_events e
    where length(trim(coalesce(p_q, ''))) > 0 and ev_sees(e.id)
      and (e.title || ' ' || e.location) ilike '%' || replace(replace(replace(trim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
    order by e.starts_at desc limit least(greatest(coalesce(p_limit, 12), 1), 50)) m
  cross join lateral public.events_link_describe(array[m.id]) d;
$$;

-- ---- Sponsors ----------------------------------------------------------------------------------------
create or replace function public.sponsors_can_view()
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select auth.uid() is not null and (has_permission('sponsors.view') or has_permission('sponsors.edit')); $$;

create or replace function public.sponsors_link_describe(p_ids uuid[])
returns setof public.os_link_row language sql stable security definer set search_path = public, pg_temp
as $$
  select c.id, '', c.name, coalesce(x.st ->> 'label', c.stage),
         case x.st ->> 'kind' when 'received' then 'green' when 'done' then 'green' when 'lost' then 'gray' else 'amber' end,
         nullif(c.season, ''),
         'sponsors/#/sponsors/' || c.id
  from sponsor_cards c
  left join lateral (select s as st from jsonb_array_elements(coalesce((select value -> 'stages' from app_settings where key = 'sponsors'), '[]')) s
                     where s ->> 'key' = c.stage limit 1) x on true
  where sponsors_can_view() and c.id = any(p_ids);
$$;
create or replace function public.sponsors_link_search(p_q text, p_limit int)
returns setof public.os_link_row language sql stable security definer set search_path = public, pg_temp
as $$
  select d.* from (
    select c.id, c.updated_at from sponsor_cards c
    where sponsors_can_view() and length(trim(coalesce(p_q, ''))) > 0
      and c.name ilike '%' || replace(replace(replace(trim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
    order by c.updated_at desc limit least(greatest(coalesce(p_limit, 12), 1), 50)) m
  cross join lateral public.sponsors_link_describe(array[m.id]) d;
$$;

-- ---- Projects items (related to) ---------------------------------------------------------------------
create or replace function public.projects_link_describe(p_ids uuid[])
returns setof public.os_link_row language sql stable security definer set search_path = public, pg_temp
as $$
  select i.id, i.key, i.title, s.name,
         case i.category when 'done' then 'green' when 'doing' then 'blue' else 'gray' end,
         case when i.archived_at is not null then 'archived' end,
         'projects/#/projects/item/' || i.key
  from pm_items i left join pm_statuses s on s.id = i.status_id
  where i.id = any(p_ids) and i.project_id = any(pm_visible());
$$;
create or replace function public.projects_link_search(p_q text, p_limit int)
returns setof public.os_link_row language sql stable security definer set search_path = public, pg_temp
as $$
  select d.* from (
    select i.id, i.updated_at from pm_items i
    where length(trim(coalesce(p_q, ''))) > 0 and i.archived_at is null and i.project_id = any(pm_visible())
      and (i.key || ' ' || i.title) ilike '%' || replace(replace(replace(trim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
    order by i.updated_at desc limit least(greatest(coalesce(p_limit, 12), 1), 50)) m
  cross join lateral public.projects_link_describe(array[m.id]) d;
$$;

insert into public.os_link_types (key, app, label, noun, add_label, search_hint, note_hint, search_fn, describe_fn, can_fn, deny_message, sort) values
  ('event', 'events', 'Event', 'event', 'Link an event', 'Event name or place', 'e.g. Signed off at this design review',
   'public.events_link_search(text, int)', 'public.events_link_describe(uuid[])', null, '', 30),
  ('sponsor', 'sponsors', 'Sponsor', 'sponsor', 'Link a sponsor', 'Sponsor name', 'e.g. They''re donating the cells',
   'public.sponsors_link_search(text, int)', 'public.sponsors_link_describe(uuid[])', 'public.sponsors_can_view()',
   'Your role can''t see Sponsors, so you can''t link them.', 40),
  ('item', 'projects', 'Related item', 'project item', 'Link a related item', 'Key or title', 'e.g. Same fault as this one',
   'public.projects_link_search(text, int)', 'public.projects_link_describe(uuid[])', null, '', 50)
on conflict (key) do nothing;

/** Link an item to a record in another app, or to a related item (068; 069: not to itself, not twice either way). */
create or replace function public.pm_add_ref(p_item uuid, p_kind text, p_ref uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  o pm_items;
  t os_link_types;
  r os_link_row;
  v_label text;
  v pm_refs;
begin
  select * into o from pm_items where id = p_item;
  if o.id is null then raise exception 'That item doesn''t exist.'; end if;
  perform pmx_need(o.project_id, 'view');
  if not pmx_may_edit(o) then perform pmx_need(o.project_id, 'edit'); end if;
  t := os_link_type(p_kind);
  if p_kind = 'item' and p_ref = p_item then raise exception 'An item can''t be related to itself.'; end if;
  if p_kind = 'item' and exists (select 1 from pm_refs where kind = 'item' and item_id = p_ref and ref_id = p_item) then
    raise exception 'Those two items are already related.';
  end if;
  execute format('select * from %s($1) limit 1', t.describe_fn::oid::regproc) into r using array[p_ref];
  if r.id is null then raise exception 'That % doesn''t exist.', t.noun; end if;
  v_label := case when coalesce(r.code, '') = '' then r.title else r.code || ' · ' || r.title end;
  insert into pm_refs (item_id, project_id, kind, ref_id, label, note, created_by)
  values (p_item, o.project_id, p_kind, p_ref, left(v_label, 200), left(coalesce(p_note, ''), 300), auth.uid())
  on conflict (item_id, kind, ref_id) do update set note = excluded.note returning * into v;
  perform pmx_log(o.project_id, p_item, 'link', 'Linked ' || case p_kind when 'order' then 'the order ' when 'inventory' then 'the inventory item '
    when 'item' then 'the related item ' else 'the ' || lower(t.noun) || ' ' end || v_label, '{}');
  return to_jsonb(v);
end;
$$;

revoke execute on function public.events_link_describe(uuid[]), public.events_link_search(text, int),
  public.sponsors_link_describe(uuid[]), public.sponsors_link_search(text, int), public.sponsors_can_view(),
  public.projects_link_describe(uuid[]), public.projects_link_search(text, int) from public, anon, authenticated;

-- ---- rules: "move its parent once everything under it is done" (for the starter rule templates) --------
-- Same as 051 with one more action: { "type": "move_parent", "status": <status id> }.
create or replace function public.pmx_check_actions(p_project uuid, p_actions jsonb)
returns void language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a jsonb; t text;
begin
  if p_actions is null or jsonb_typeof(p_actions) <> 'array' then raise exception 'Actions must be a list.'; end if;
  if jsonb_array_length(p_actions) > 10 then raise exception 'A rule can have up to 10 actions.'; end if;
  for a in select * from jsonb_array_elements(p_actions) loop
    t := a ->> 'type';
    if t = 'set_status' then
      if not exists (select 1 from pm_statuses where id = pmx_uuid(a ->> 'status') and project_id = p_project) then raise exception 'An action sets a status this project doesn''t have.'; end if;
    elsif t in ('assign', 'add_watcher', 'notify') then
      if coalesce(a ->> case t when 'notify' then 'to' else 'user' end, '') not in ('owner', 'reporter', 'lead', 'none', 'watchers', 'actor')
         and not is_member(pmx_uuid(a ->> case t when 'notify' then 'to' else 'user' end)) then
        raise exception 'An action names someone who isn''t on the team.';
      end if;
      if t = 'notify' and trim(coalesce(a ->> 'message', '')) = '' then raise exception 'A "notify" action needs a message.'; end if;
    elsif t = 'set_field' then
      if coalesce(a ->> 'field', '') not in ('priority', 'due_date', 'start_date', 'blocked', 'blocked_reason', 'progress', 'estimate_hours')
         and not exists (select 1 from pm_fields f where f.project_id = p_project and 'cf.' || f.key = a ->> 'field' and f.type <> 'formula') then
        raise exception 'An action sets a field ("%") that can''t be set by a rule.', left(coalesce(a ->> 'field', ''), 40);
      end if;
    elsif t = 'comment' then
      if trim(coalesce(a ->> 'text', '')) = '' then raise exception 'A "comment" action needs some text.'; end if;
    elsif t = 'create_item' then
      if trim(coalesce(a ->> 'title', '')) = '' then raise exception 'A "create an item" action needs a title.'; end if;
      if not exists (select 1 from pm_types where id = pmx_uuid(a ->> 'type_id') and project_id = p_project and archived_at is null) then
        raise exception 'A "create an item" action needs one of this project''s work-item types.';
      end if;
    elsif t = 'add_label' then
      if trim(coalesce(a ->> 'label', '')) = '' or length(a ->> 'label') > 40 then raise exception 'A "label" action needs a label (up to 40 characters).'; end if;
    elsif t = 'move_parent' then   -- 069
      if not exists (select 1 from pm_statuses where id = pmx_uuid(a ->> 'status') and project_id = p_project) then raise exception 'An action moves the parent to a status this project doesn''t have.'; end if;
    elsif t = 'move_children' then   -- 069
      if not exists (select 1 from pm_statuses where id = pmx_uuid(a ->> 'status') and project_id = p_project) then raise exception 'An action moves the items under it to a status this project doesn''t have.'; end if;
    else
      raise exception 'Unknown action "%".', left(coalesce(t, ''), 30);
    end if;
  end loop;
end;
$$;

create or replace function public.pmx_run_actions_in(p_project uuid, p_item uuid, p_actions jsonb, p_source text)
returns text language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  a       jsonb;
  t       text;
  v_item  uuid := p_item;
  o       pm_items;
  n       pm_items;
  v_tr    pm_transitions;
  v_type  pm_types;
  v_st    pm_statuses;
  v_done  text[] := '{}';
  v_val   jsonb;
  v_seq   int;
  v_key   text;
  v_users uuid[];
  v_miss  text[];
  v_moved int;
  v_left  int;
begin
  for a in select * from jsonb_array_elements(coalesce(p_actions, '[]')) loop
    t := a ->> 'type';
    if v_item is null and t <> 'create_item' then continue; end if;
    select * into o from pm_items where id = v_item;
    if t = 'set_status' then
      if o.status_id = pmx_uuid(a ->> 'status') then continue; end if;
      select tr.* into v_tr from pm_transitions tr join pm_types ty on ty.workflow_id = tr.workflow_id
      where ty.id = o.type_id and tr.to_status = pmx_uuid(a ->> 'status') and (tr.from_status = o.status_id or tr.from_status is null)
      order by tr.from_status nulls last, tr.sort limit 1;
      if v_tr.id is null then
        raise exception 'the workflow has no move from "%" to "%"', (select name from pm_statuses where id = o.status_id), (select name from pm_statuses where id = pmx_uuid(a ->> 'status'));
      end if;
      v_miss := pmx_missing(o, v_tr.require_fields);
      if cardinality(v_miss) > 0 then raise exception 'the move "%" needs %', v_tr.name, pmx_field_names(o.project_id, v_miss); end if;
      v_tr.actions := '[]';   -- a rule's move doesn't set off the move's own follow-up actions (no chains)
      perform pmx_set_status(v_item, v_tr, null, 'automation');
      v_done := v_done || ('moved to "' || (select name from pm_statuses where id = v_tr.to_status) || '"');
    elsif t = 'assign' then
      perform pmx_update(v_item, null, jsonb_build_object('owner_id', pmx_who(v_item, p_project, a ->> 'user')), true);
      v_done := v_done || 'assigned'::text;
    elsif t = 'set_field' then
      v_val := a -> 'value';
      if jsonb_typeof(v_val) = 'object' and v_val ? 'days' then v_val := to_jsonb(to_char(current_date + (v_val ->> 'days')::int, 'YYYY-MM-DD')); end if;
      if a ->> 'field' like 'cf.%' then perform pmx_update(v_item, null, jsonb_build_object('custom', jsonb_build_object(substr(a ->> 'field', 4), v_val)), true);
      else perform pmx_update(v_item, null, jsonb_build_object(a ->> 'field', v_val), true);
      end if;
      v_done := v_done || ('set ' || (a ->> 'field'));
    elsif t = 'comment' then
      insert into pm_comments (item_id, project_id, author_id, body) values (v_item, o.project_id, null, left(pmx_fill(a ->> 'text', v_item), 10000));
      v_done := v_done || 'commented'::text;
    elsif t = 'add_label' then
      perform pmx_update(v_item, null, jsonb_build_object('labels', to_jsonb(o.labels || (a ->> 'label'))), true);
      v_done := v_done || ('labelled ' || (a ->> 'label'));
    elsif t = 'add_watcher' then
      insert into pm_people (item_id, user_id, kind, project_id)
      select v_item, pmx_who(v_item, p_project, a ->> 'user'), 'watch', o.project_id where pmx_who(v_item, p_project, a ->> 'user') is not null on conflict do nothing;
      v_done := v_done || 'added a watcher'::text;
    elsif t = 'notify' then
      v_users := case when a ->> 'to' = 'watchers' then pmx_audience(v_item) else array[pmx_who(v_item, p_project, a ->> 'to')] end;
      -- a rule's message also reaches the person whose action set it off
      insert into pm_notifications (user_id, project_id, item_id, kind, title, body, actor_name)
      select auth.uid(), o.project_id, v_item, 'automation', left(pmx_fill(a ->> 'message', v_item), 200), '', 'A rule' where auth.uid() = any(v_users);
      perform pmx_notify(v_users, 'automation', v_item, left(pmx_fill(a ->> 'message', v_item), 200), pmx_fill(a ->> 'message', v_item));
      v_done := v_done || 'notified'::text;
    elsif t = 'move_parent' then
      -- 069: move the item's parent, but only once everything under the parent is done
      if o.parent_id is null then v_done := v_done || 'no parent to move'::text; continue; end if;
      if exists (select 1 from pm_items ci where ci.parent_id = o.parent_id and ci.archived_at is null and ci.category <> 'done') then
        v_done := v_done || 'left the parent: something under it is still open'::text; continue;
      end if;
      select * into n from pm_items where id = o.parent_id;
      if n.archived_at is not null or n.status_id = pmx_uuid(a ->> 'status') then continue; end if;
      select tr.* into v_tr from pm_transitions tr join pm_types ty on ty.workflow_id = tr.workflow_id
      where ty.id = n.type_id and tr.to_status = pmx_uuid(a ->> 'status') and (tr.from_status = n.status_id or tr.from_status is null)
      order by tr.from_status nulls last, tr.sort limit 1;
      if v_tr.id is null then
        raise exception 'the parent''s workflow has no move from "%" to "%"', (select name from pm_statuses where id = n.status_id), (select name from pm_statuses where id = pmx_uuid(a ->> 'status'));
      end if;
      v_miss := pmx_missing(n, v_tr.require_fields);
      if cardinality(v_miss) > 0 then raise exception 'the parent''s move "%" needs %', v_tr.name, pmx_field_names(n.project_id, v_miss); end if;
      v_tr.actions := '[]';
      perform pmx_set_status(n.id, v_tr, null, 'automation');
      v_done := v_done || ('moved ' || n.key || ' to "' || (select name from pm_statuses where id = v_tr.to_status) || '"');
    elsif t = 'move_children' then
      -- 069: move each open item under it to the status of that name in its own workflow. One that has no such move,
      -- or is missing a field the move needs, is left as it is (and counted); the rest still move.
      v_moved := 0; v_left := 0;
      for n in select * from pm_items where parent_id = v_item and archived_at is null and category <> 'done' order by rank loop
        v_tr := null;
        select tr.* into v_tr from pm_transitions tr join pm_types ty on ty.workflow_id = tr.workflow_id join pm_statuses ts on ts.id = tr.to_status
        where ty.id = n.type_id and ts.name = (select name from pm_statuses where id = pmx_uuid(a ->> 'status'))
          and ts.id <> n.status_id and (tr.from_status = n.status_id or tr.from_status is null)
        order by tr.from_status nulls last, tr.sort limit 1;
        if v_tr.id is null or cardinality(pmx_missing(n, v_tr.require_fields)) > 0 then v_left := v_left + 1; continue; end if;
        v_tr.actions := '[]';
        perform pmx_set_status(n.id, v_tr, null, 'automation');
        v_moved := v_moved + 1;
      end loop;
      v_done := v_done || ('moved ' || v_moved || ' item' || case when v_moved = 1 then '' else 's' end || ' under it'
        || case when v_left > 0 then ', left ' || v_left || ' (no such move, or a field it needs is empty)' else '' end);
    elsif t = 'create_item' then
      select * into v_type from pm_types where id = pmx_uuid(a ->> 'type_id') and project_id = p_project and archived_at is null;
      if v_type.id is null then raise exception 'the work-item type to create no longer exists'; end if;
      select * into v_st from pm_statuses where workflow_id = v_type.workflow_id order by sort, name limit 1;
      update pm_projects set item_seq = item_seq + 1 where id = p_project returning item_seq, key into v_seq, v_key;
      n := jsonb_populate_record(null::pm_items, jsonb_build_object('priority', coalesce(a ->> 'priority', 'medium'), 'description', coalesce(a ->> 'description', ''),
        'vehicle', '', 'blocked', false, 'blocked_reason', '', 'acceptance', '', 'labels', '[]'::jsonb, 'progress', 0, 'custom', '{}'::jsonb, 'version', 1));
      n.id := gen_random_uuid(); n.project_id := p_project; n.type_id := v_type.id; n.seq := v_seq; n.key := v_key || '-' || v_seq;
      n.title := left(coalesce(pmx_fill(a ->> 'title', v_item), 'New item'), 200); n.status_id := v_st.id; n.category := v_st.category;
      n.reporter_id := coalesce(auth.uid(), (select lead_id from pm_projects where id = p_project)); n.created_by := auth.uid();
      n.owner_id := pmx_who(v_item, p_project, coalesce(a ->> 'owner', 'none'));
      n.due_date := case when a ? 'due_in_days' then current_date + (a ->> 'due_in_days')::int end;
      n.division_id := o.division_id; n.subsystem_id := o.subsystem_id;
      n.rank := (select coalesce(max(rank), 0) + 1000 from pm_items where project_id = p_project);
      n.created_at := now(); n.updated_at := now();
      -- under the item that set the rule off, when the project's hierarchy allows that
      if v_item is not null and coalesce(a ->> 'as', 'child') = 'child' then
        begin n.parent_id := v_item; n := pmx_check_item(n, null::pm_items);
        exception when others then n.parent_id := null; end;
      end if;
      n := pmx_check_item(n, null::pm_items);
      insert into pm_items select n.*;
      perform pmx_log(p_project, n.id, 'created', 'Created ' || n.key || ' (by a rule)', jsonb_build_object('title', n.title, 'how', 'automation'));
      if n.owner_id is not null then perform pmx_notify(array[n.owner_id], 'assigned', n.id, 'Assigned to you: ' || n.title, 'A rule created ' || n.key || ' "' || n.title || '" for you.'); end if;
      if v_item is null then v_item := n.id; end if;
      v_done := v_done || ('created ' || n.key);
    end if;
  end loop;
  return array_to_string(v_done, '; ');
end;
$$;

-- ---- project settings: tabs a project hides (V7) and its phases (V4) -------------------------------------
-- Same as 051, plus checks for hidden_tabs and phases. Both only change what the pages show.
create or replace function public.pmx_check_settings(p jsonb)
returns jsonb language plpgsql immutable set search_path = public, pg_temp
as $$
declare d text; ph jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return '{}'::jsonb; end if;
  if octet_length(p::text) > 20000 then raise exception 'Those project settings are too big.'; end if;
  if p ? 'working_days' then
    if jsonb_typeof(p -> 'working_days') <> 'array' or jsonb_array_length(p -> 'working_days') = 0
       or exists (select 1 from jsonb_array_elements_text(p -> 'working_days') x where x !~ '^[0-6]$') then
      raise exception 'Pick at least one working day.';
    end if;
  end if;
  if p ? 'holidays' then
    if jsonb_typeof(p -> 'holidays') <> 'array' then raise exception 'Days off must be a list of dates.'; end if;
    for d in select * from jsonb_array_elements_text(p -> 'holidays') loop
      begin perform d::date; exception when others then raise exception '"%" isn''t a date.', left(d, 30); end;
    end loop;
  end if;
  if p ? 'hidden_tabs' then
    if jsonb_typeof(p -> 'hidden_tabs') <> 'array'
       or exists (select 1 from jsonb_array_elements_text(p -> 'hidden_tabs') x where x not in ('list', 'board', 'backlog', 'timeline', 'calendar', 'docs')) then
      raise exception 'Only List, Board, Backlog, Timeline, Calendar and Documents can be hidden.';
    end if;
  end if;
  if p ? 'phases' then
    if jsonb_typeof(p -> 'phases') <> 'array' then raise exception 'Phases must be a list.'; end if;
    if jsonb_array_length(p -> 'phases') > 20 then raise exception 'A project can have up to 20 phases.'; end if;
    for ph in select * from jsonb_array_elements(p -> 'phases') loop
      if jsonb_typeof(ph) <> 'object' or length(trim(coalesce(ph ->> 'name', ''))) not between 1 and 40 then raise exception 'Give each phase a name (up to 40 characters).'; end if;
      begin
        if (ph ->> 'end')::date < (ph ->> 'start')::date then raise exception 'bad'; end if;
      exception when others then
        raise exception '"%" needs a start and an end date, and the end can''t be before the start.', left(ph ->> 'name', 40);
      end;
      if coalesce(ph ->> 'tone', 'blue') not in ('gray', 'blue', 'green', 'teal', 'amber', 'orange', 'red', 'pink', 'purple', 'navy') then
        raise exception 'Unknown color for "%".', left(ph ->> 'name', 40);
      end if;
    end loop;
  end if;
  return p;
end;
$$;

-- ---- dropdown choices with colors -------------------------------------------------------------------------
alter table public.pm_fields add column if not exists option_tones jsonb not null default '{}';   -- { "Pass": "green" }

/** Same as 051, plus option_tones: { choice: color } for a dropdown's choices (only its own choices, known colors). */
create or replace function public.pm_save_field(p_project uuid, p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  o       pm_fields;
  v       pm_fields;
  v_type  text;
  v_opts  jsonb;
  v_val   jsonb := coalesce(nullif(p -> 'validation', 'null'), '{}');
  v_tones jsonb;
begin
  perform pmx_need(p_project, 'configure');
  if p_id is not null then
    select * into o from pm_fields where id = p_id and project_id = p_project for update;
    if o.id is null then raise exception 'That field doesn''t exist.'; end if;
    if p ? 'type' and p ->> 'type' <> o.type then raise exception 'A field''s kind can''t change once it exists (its values wouldn''t fit). Make a new field instead.'; end if;
  end if;
  v_type := coalesce(o.type, p ->> 'type');
  if trim(coalesce(p ->> 'name', o.name, '')) = '' then raise exception 'Give the field a name.'; end if;
  v_opts := case when p ? 'options' then to_jsonb(pmx_texts(p -> 'options')) else coalesce(o.options, '[]') end;
  if v_type in ('select', 'multiselect') then
    if jsonb_array_length(v_opts) = 0 then raise exception 'A dropdown needs at least one choice.'; end if;
    if jsonb_array_length(v_opts) > 200 or exists (select 1 from jsonb_array_elements_text(v_opts) x where length(x) > 100) then
      raise exception 'A dropdown can have up to 200 choices of up to 100 characters.';
    end if;
    if (select count(distinct lower(x)) from jsonb_array_elements_text(v_opts) x) <> jsonb_array_length(v_opts) then raise exception 'Two choices are the same.'; end if;
  end if;
  -- 069: colors for the choices; a color for a choice that's gone is dropped
  v_tones := case when p ? 'option_tones' then coalesce(nullif(p -> 'option_tones', 'null'), '{}') else coalesce(o.option_tones, '{}') end;
  if jsonb_typeof(v_tones) <> 'object' then raise exception 'Choice colors must be a list of choice: color.'; end if;
  if exists (select 1 from jsonb_each_text(v_tones) x where x.value not in ('gray', 'blue', 'green', 'teal', 'amber', 'orange', 'red', 'pink', 'purple', 'navy')) then
    raise exception 'Unknown color for a choice.';
  end if;
  select coalesce(jsonb_object_agg(x.key, x.value), '{}') into v_tones from jsonb_each(v_tones) x
  where v_type in ('select', 'multiselect') and v_opts ? x.key;
  if jsonb_typeof(v_val) <> 'object' or octet_length(v_val::text) > 600 then raise exception 'Those validation rules aren''t valid.'; end if;
  if v_val ? 'pattern' then
    begin perform 'x' ~ (v_val ->> 'pattern'); exception when others then raise exception 'The pattern isn''t a valid regular expression.'; end;
  end if;
  if v_type = 'formula' then
    -- A small arithmetic language worked out in the page (docs/projects.md): only these characters ever get in.
    if coalesce(p ->> 'formula', o.formula, '') !~ '^[A-Za-z0-9_ .,+*/()<>=!?:''"%-]+$' then
      raise exception 'A formula can only use numbers, field names, + - * / ( ) and the listed functions.';
    end if;
  end if;
  if p_id is null then
    if coalesce(p ->> 'key', '') !~ '^[a-z][a-z0-9_]{0,39}$' then raise exception 'The field key is lowercase letters, numbers and _ (e.g. test_date).'; end if;
    if exists (select 1 from pm_fields where project_id = p_project and key = p ->> 'key') then
      raise exception 'This project already has a field with the key "%".', p ->> 'key' using errcode = 'OS412';
    end if;
    insert into pm_fields (project_id, key, name, type, description, options, option_tones, default_value, validation, formula, type_ids, sort)
    values (p_project, p ->> 'key', trim(p ->> 'name'), v_type, coalesce(p ->> 'description', ''), v_opts, v_tones, nullif(p -> 'default_value', 'null'), v_val,
      coalesce(p ->> 'formula', ''), '{}', coalesce((p ->> 'sort')::int, (select coalesce(max(sort), 0) + 10 from pm_fields where project_id = p_project)))
    returning * into v;
  else
    update pm_fields set name = coalesce(nullif(trim(p ->> 'name'), ''), name), description = coalesce(p ->> 'description', description), options = v_opts,
      option_tones = v_tones,
      default_value = case when p ? 'default_value' then nullif(p -> 'default_value', 'null') else default_value end,
      validation = case when p ? 'validation' then v_val else validation end, formula = coalesce(p ->> 'formula', formula),
      sort = coalesce((p ->> 'sort')::int, sort),
      archived_at = case when p ? 'archived' then case when pmx_bool(p, 'archived', false) then coalesce(archived_at, now()) end else archived_at end
    where id = p_id returning * into v;
  end if;
  if p ? 'type_ids' then
    update pm_fields set type_ids = array(select x from unnest(pmx_uuids(p -> 'type_ids')) x where exists (select 1 from pm_types t where t.id = x and t.project_id = p_project))
    where id = v.id returning * into v;
  end if;
  if v.default_value is not null and v.type <> 'formula' then
    perform pmx_clean_custom(p_project, null, jsonb_build_object(v.key, v.default_value), '{}');
  end if;
  perform pmx_log(p_project, null, 'config', 'Saved the field "' || v.name || '"', '{}');
  return to_jsonb(v);
end;
$$;

-- ---- files on Projects items (the shared files & links of 017/018, one more owner) ------------------------
alter table public.attachments add column if not exists pm_item_id uuid references public.pm_items(id) on delete cascade;
create index if not exists attachments_pm_item_idx on public.attachments (pm_item_id) where pm_item_id is not null;
do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.attachments'::regclass and pg_get_constraintdef(oid) like '%num_nonnulls%' loop
    execute format('alter table public.attachments drop constraint %I', c);
  end loop;
end $$;
alter table public.attachments add constraint attachments_one_owner
  check (num_nonnulls(sponsor_card_id, request_id, finance_row_id, finance_purchase_id, pm_item_id) = 1);

create or replace function public.attachment_owner(a attachments)
returns uuid language sql immutable as $$
  select coalesce(a.sponsor_card_id, a.request_id, a.finance_row_id, a.finance_purchase_id, a.pm_item_id);
$$;

create or replace function public.attachment_kind(a attachments)
returns text language sql immutable as $$
  select case when a.sponsor_card_id is not null then 'sponsor' when a.request_id is not null then 'request'
              when a.finance_purchase_id is not null then 'purchase' when a.pm_item_id is not null then 'item' else 'finance' end;
$$;

/** Same as 040, plus Projects items: see = can see the item's project; change = can edit the item (pmx_may_edit). */
create or replace function public.attachment_access(p_kind text, p_owner uuid, p_edit boolean)
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_item pm_items;
begin
  if auth.uid() is null or not is_member() then return false; end if;
  if p_kind = 'sponsor' then
    return has_permission('sponsors.edit') or (not p_edit and has_permission('sponsors.view'));
  elsif p_kind = 'request' then
    return not p_edit
      or has_permission('request.review') or has_permission('request.order')
      or exists (select 1 from requests where id = p_owner and created_by = auth.uid());
  elsif p_kind in ('finance', 'purchase') then
    return has_permission('finances.edit') or (not p_edit and has_permission('finances.view'));
  elsif p_kind = 'item' then
    select * into v_item from pm_items where id = p_owner;
    if v_item.id is null or not (v_item.project_id = any(pm_visible())) then return false; end if;
    return not p_edit or (v_item.archived_at is null and pmx_may_edit(v_item));
  end if;
  return false;
end;
$$;

create or replace function public.add_attachment(p_kind text, p_owner uuid, p_path text, p_url text, p_file_name text, p_size bigint, p_mime text, p_label text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_project uuid;
begin
  if p_kind not in ('sponsor', 'request', 'finance', 'purchase', 'item') then raise exception 'Unknown kind of attachment.'; end if;
  if not attachment_access(p_kind, p_owner, true) then
    raise exception 'You can''t add files here.';
  end if;
  if p_path is not null and p_path not like p_kind || '/' || p_owner || '/%' then
    raise exception 'That file was uploaded to the wrong place.';
  end if;
  if p_url is not null and p_url !~ '^https?://\S+$' then
    raise exception 'Links must start with https://';
  end if;
  insert into attachments (sponsor_card_id, request_id, finance_row_id, finance_purchase_id, pm_item_id, path, url, file_name, size, mime, label, uploaded_by, uploaded_by_name)
  values (
    case when p_kind = 'sponsor' then p_owner end,
    case when p_kind = 'request' then p_owner end,
    case when p_kind = 'finance' then p_owner end,
    case when p_kind = 'purchase' then p_owner end,
    case when p_kind = 'item' then p_owner end,
    p_path, nullif(trim(coalesce(p_url, '')), ''), left(coalesce(p_file_name, ''), 200), p_size, left(coalesce(p_mime, ''), 100),
    left(trim(coalesce(p_label, '')), 120), auth.uid(), coalesce(my_display_name(), ''))
  returning id into v_id;
  if p_kind = 'sponsor' then
    perform log_sponsor_activity(p_owner, 'file', format('Added %s "%s".', case when p_url is null then 'the file' else 'the link' end,
      coalesce(nullif(trim(p_label), ''), nullif(p_file_name, ''), p_url)));
  elsif p_kind = 'item' then
    select project_id into v_project from pm_items where id = p_owner;
    perform pmx_log(v_project, p_owner, 'file', format('Added %s "%s"', case when p_url is null then 'the file' else 'the link' end,
      left(coalesce(nullif(trim(p_label), ''), nullif(p_file_name, ''), p_url), 120)), '{}');
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_attachment(p_id uuid)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_a attachments;
begin
  select * into v_a from attachments where id = p_id;
  if not found then return null; end if;
  if v_a.uploaded_by is distinct from auth.uid() and not attachment_access(attachment_kind(v_a), attachment_owner(v_a), true) then
    raise exception 'You can''t remove this file.';
  end if;
  delete from attachments where id = p_id;
  if v_a.sponsor_card_id is not null then
    perform log_sponsor_activity(v_a.sponsor_card_id, 'file', format('Removed "%s".', coalesce(nullif(v_a.label, ''), nullif(v_a.file_name, ''), v_a.url)));
  elsif v_a.pm_item_id is not null then
    perform pmx_log((select project_id from pm_items where id = v_a.pm_item_id), v_a.pm_item_id, 'file',
      format('Removed "%s"', left(coalesce(nullif(v_a.label, ''), nullif(v_a.file_name, ''), v_a.url), 120)), '{}');
  end if;
  if v_a.path is not null and not exists (select 1 from attachments where path = v_a.path) then return v_a.path; end if;
  return null;
end;
$$;

revoke execute on function public.attachment_access(text, uuid, boolean) from public, anon;
revoke execute on function public.add_attachment(text, uuid, text, text, text, bigint, text, text), public.delete_attachment(uuid) from public, anon;
grant execute on function public.attachment_access(text, uuid, boolean) to authenticated;
grant execute on function public.add_attachment(text, uuid, text, text, text, bigint, text, text), public.delete_attachment(uuid) to authenticated;

-- Storage: reading a file goes by its row's owner, of every kind (025 named only the first three owner columns).
do $storage$
begin
  if to_regclass('storage.objects') is null then return; end if;
  execute 'drop policy if exists "attachments: read" on storage.objects';
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
end
$storage$;

select public.migration_done(69, '069_projects_stage2.sql');
