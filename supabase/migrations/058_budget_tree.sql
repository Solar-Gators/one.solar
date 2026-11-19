select public.migration_begin(58);

-- =============================================================================
-- 058: budget categories inside categories, and moving money between them
-- =============================================================================
--
--   Finances → Budget was one flat list of categories. Now:
--     * Any category can sit under another, any depth (Electrical → BMS → Cells): budgets.parents is
--       { "BMS": "Electrical", "Cells": "BMS" }. A category's spent and in-the-pipeline include everything
--       under it, and its sub-budgets are compared with its own budget.
--     * With "Approving over budget needs a written reason" on (budgets.block), the same switch also keeps
--       sub-budgets from adding up to more than their parent's budget, and approving checks the request's
--       category AND every category above it that has a budget.
--     * "Move money" moves budget from one category to another, kept with who, when and why
--       (budget_moves), instead of just editing two numbers.
--   Requests and purchases still say one category (their answer, or the Treasurer's pick); nothing about
--   them changes.
-- =============================================================================

/** Every category under p_name (not p_name itself), by budgets.parents, case-insensitively. */
create or replace function public.budget_below(p_parents jsonb, p_name text)
returns setof text
language sql immutable set search_path = public, pg_temp
as $$
  with recursive pairs as (
    select lower(trim(key)) c, lower(trim(value)) p from jsonb_each_text(coalesce(p_parents, '{}'))
  ), down(c, depth) as (
    select c, 1 from pairs where p = lower(trim(coalesce(p_name, '')))
    union
    select pairs.c, down.depth + 1 from pairs join down on pairs.p = down.c where down.depth < 20
  )
  select distinct c from down;
$$;

/** p_name and every category above it, nearest first (lower-cased). */
create or replace function public.budget_above(p_parents jsonb, p_name text)
returns table (name text, depth int)
language sql immutable set search_path = public, pg_temp
as $$
  with recursive pairs as (
    select lower(trim(key)) c, lower(trim(value)) p from jsonb_each_text(coalesce(p_parents, '{}'))
  ), up(name, depth) as (
    select lower(trim(coalesce(p_name, ''))), 0
    union
    select pairs.p, up.depth + 1 from pairs join up on pairs.c = up.name where up.depth < 20
  )
  select name, min(depth) from up where name <> '' group by name order by 2;
$$;

-- Same as 021, plus `parents` (checked: names, no loops, and with `block` on, sub-budgets fit their parent).
create or replace function public.set_budgets(p_budgets jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_clean   jsonb;
  v_bad     text;
  v_parents jsonb := '{}';
  v_amounts jsonb := coalesce(p_budgets -> 'amounts', '{}');
  r record;
  v_sum numeric;
begin
  if not (has_permission('request.order') or has_permission('workflow.edit')) then
    raise exception 'Only the Treasurer can change budgets.';
  end if;
  if jsonb_typeof(coalesce(p_budgets, '{}')) <> 'object' then raise exception 'Budgets must be a JSON object.'; end if;
  select key into v_bad from jsonb_each_text(v_amounts) where value !~ '^\d*\.?\d+$' limit 1;
  if v_bad is not null then raise exception 'The budget for "%" must be a dollar amount of 0 or more.', v_bad; end if;

  if jsonb_typeof(p_budgets -> 'parents') = 'object' then
    if (select count(*) from jsonb_object_keys(p_budgets -> 'parents')) > 500 then raise exception 'Up to 500 sub-categories.'; end if;
    for r in select trim(key) c, trim(value) p from jsonb_each_text(p_budgets -> 'parents') loop
      continue when r.c = '' or r.p = '';
      if length(r.c) > 80 or length(r.p) > 80 then raise exception 'Category names can be at most 80 characters.'; end if;
      if lower(r.c) = lower(r.p) then raise exception '"%" can''t be under itself.', r.c; end if;
      v_parents := v_parents || jsonb_build_object(r.c, r.p);
    end loop;
    -- No loops: nothing is under something that is under it.
    select c into v_bad from (select key c from jsonb_each_text(v_parents)) x
    where lower(trim(c)) in (select budget_below(v_parents, c)) limit 1;
    if v_bad is not null then raise exception '"%" would end up under itself. Pick another category to put it under.', v_bad; end if;
  end if;

  -- With the switch on, sub-budgets have to fit in their parent's budget.
  if coalesce((p_budgets -> 'block') = 'true'::jsonb, false) then
    for r in select distinct lower(trim(value)) p from jsonb_each_text(v_parents) loop
      select sum(a.value::numeric) into v_sum
      from jsonb_each_text(v_amounts) a
      where lower(trim(a.key)) in (select lower(trim(key)) from jsonb_each_text(v_parents) where lower(trim(value)) = r.p);
      if v_sum is not null and exists (select 1 from jsonb_each_text(v_amounts) a where lower(trim(a.key)) = r.p and a.value::numeric < v_sum) then
        raise exception 'The budgets under "%" add up to $%, more than its own $%. Raise its budget first, or lower theirs.',
          (select key from jsonb_each_text(v_amounts) where lower(trim(key)) = r.p limit 1), to_char(v_sum, 'FM999,999,990.00'),
          (select to_char(value::numeric, 'FM999,999,990.00') from jsonb_each_text(v_amounts) where lower(trim(key)) = r.p limit 1);
      end if;
    end loop;
  end if;

  v_clean := jsonb_build_object(
    'field', coalesce(p_budgets ->> 'field', ''),
    'amounts', v_amounts,
    'block', coalesce((p_budgets -> 'block') = 'true'::jsonb, false),
    'parents', v_parents,
    'order', coalesce((select jsonb_agg(v) from jsonb_array_elements_text(
                         case when jsonb_typeof(p_budgets -> 'order') = 'array' then p_budgets -> 'order' else '[]' end) v
                       where trim(v) <> ''), '[]'));
  insert into app_settings (key, value, updated_at, updated_by)
  values ('workflow', jsonb_build_object('rules', '[]'::jsonb, 'budgets', v_clean), now(), auth.uid())
  on conflict (key) do update set value = app_settings.value || jsonb_build_object('budgets', v_clean), updated_at = now(), updated_by = auth.uid();
end;
$$;

-- Same as 020, but a request also counts against every category above its own, and each one with a budget
-- is checked (nearest first). A category's use includes everything under it.
create or replace function public.budget_problem(p_request_id uuid)
returns text
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_b       jsonb := (select value -> 'budgets' from app_settings where key = 'workflow');
  v_req     jsonb := (select to_jsonb(r) from requests r where r.id = p_request_id);
  v_field   text := v_b ->> 'field';
  v_parents jsonb := coalesce(v_b -> 'parents', '{}');
  v_value   text;
  v_this    numeric := request_total(p_request_id);
  v_cat     record;
  v_names   text[];
  v_label   text;
  v_amount  numeric;
  v_used    numeric;
begin
  if v_b is null or coalesce(v_field, '') = '' or (v_b -> 'block') is distinct from 'true'::jsonb then return null; end if;
  v_value := request_category(p_request_id, v_field);
  if v_value = '' then return null; end if;
  for v_cat in select name from budget_above(v_parents, v_value) order by depth loop
    select a.key, a.value::numeric into v_label, v_amount
    from jsonb_each_text(coalesce(v_b -> 'amounts', '{}')) a
    where lower(trim(a.key)) = v_cat.name and a.value ~ '^\d*\.?\d+$' limit 1;
    continue when v_amount is null;
    v_names := array(select v_cat.name union select budget_below(v_parents, v_cat.name));
    select coalesce(sum(request_total(r.id)), 0) into v_used
    from requests r
    where r.id <> p_request_id and r.season = (v_req ->> 'season') and r.status in ('Approved', 'Ordered', 'Received')
      and lower(trim(request_category(r.id, v_field))) = any(v_names);
    v_used := v_used + coalesce((
      select sum(amount) from finance_purchases
      where request_id is null and dept_status <> 'cancelled' and season = (v_req ->> 'season')
        and lower(trim(category)) = any(v_names)), 0);
    if v_used + v_this > v_amount then
      return format('Approving this would put %s over its budget: $%s used + $%s = $%s of $%s.',
        v_label || case when v_cat.name <> lower(trim(v_value)) then format(' (which %s is under)', v_value) else '' end,
        to_char(v_used, 'FM999,999,990.00'), to_char(v_this, 'FM999,999,990.00'),
        to_char(v_used + v_this, 'FM999,999,990.00'), to_char(v_amount, 'FM999,999,990.00'));
    end if;
    v_amount := null;
  end loop;
  return null;
end;
$$;

-- ---- Moving money between categories, with history ---------------------------------------
create table public.budget_moves (
  id          uuid primary key default gen_random_uuid(),
  season      text not null default '',
  from_name   text not null check (length(from_name) between 1 and 80),
  to_name     text not null check (length(to_name) between 1 and 80),
  amount      numeric(12, 2) not null check (amount > 0),
  note        text not null default '' check (length(note) <= 500),
  moved_by    uuid references public.profiles(id) on delete set null,
  moved_by_name text not null default '',
  moved_at    timestamptz not null default now()
);
create index budget_moves_at_idx on public.budget_moves (moved_at desc);
alter table public.budget_moves enable row level security;
create policy "finances readers" on public.budget_moves for select to authenticated
  using (has_permission('finances.view') or has_permission('finances.edit') or has_permission('request.order') or has_permission('workflow.edit'));
revoke all on public.budget_moves from anon, authenticated;
grant select on public.budget_moves to authenticated;

/** Move p_amount of budget from one category to another (made if it has none), and keep a record. */
create or replace function public.move_budget(p_from text, p_to text, p_amount numeric, p_note text default '')
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_b      jsonb := coalesce((select value -> 'budgets' from app_settings where key = 'workflow'), '{}');
  v_amts   jsonb := coalesce(v_b -> 'amounts', '{}');
  v_from   text := trim(coalesce(p_from, ''));
  v_to     text := trim(coalesce(p_to, ''));
  v_fkey   text;
  v_tkey   text;
  v_have   numeric;
  v_amt    numeric := round(coalesce(p_amount, 0), 2);
begin
  if not (has_permission('request.order') or has_permission('workflow.edit')) then
    raise exception 'Only the Treasurer can change budgets.';
  end if;
  if v_from = '' or v_to = '' or lower(v_from) = lower(v_to) then raise exception 'Pick two different categories.'; end if;
  if length(v_to) > 80 then raise exception 'Category names can be at most 80 characters.'; end if;
  if v_amt <= 0 then raise exception 'Move an amount more than $0.'; end if;
  if length(coalesce(p_note, '')) > 500 then raise exception 'Keep the reason under 500 characters.'; end if;
  select key, value::numeric into v_fkey, v_have from jsonb_each_text(v_amts) where lower(trim(key)) = lower(v_from) limit 1;
  if v_fkey is null then raise exception '"%" has no budget to move from.', v_from; end if;
  if v_have < v_amt then
    raise exception '"%" only has $% of budget.', v_fkey, to_char(v_have, 'FM999,999,990.00');
  end if;
  select key into v_tkey from jsonb_each_text(v_amts) where lower(trim(key)) = lower(v_to) limit 1;
  v_amts := v_amts || jsonb_build_object(v_fkey, to_char(v_have - v_amt, 'FM999999990.00'))
                   || jsonb_build_object(coalesce(v_tkey, v_to), to_char(coalesce((v_amts ->> coalesce(v_tkey, v_to))::numeric, 0) + v_amt, 'FM999999990.00'));
  -- through set_budgets, so the same checks apply (sub-budgets fitting their parent, with the switch on)
  perform set_budgets(v_b || jsonb_build_object('amounts', v_amts));
  insert into budget_moves (season, from_name, to_name, amount, note, moved_by, moved_by_name)
  values (coalesce(current_season(), ''), v_fkey, coalesce(v_tkey, v_to), v_amt, trim(coalesce(p_note, '')), auth.uid(), coalesce(my_name(), ''));
end;
$$;

/**
 * After renaming / combining a category (rename_category) or deleting it: what was under it goes under the new
 * name (renaming) or under the deleted one's own parent (deleting), and it keeps its own place. Only
 * budgets.parents changes.
 */
create or replace function public.budget_rename_parents(p_from text, p_to text, p_deleting boolean default false)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_p    jsonb := coalesce((select value -> 'budgets' -> 'parents' from app_settings where key = 'workflow'), '{}');
  v_from text := lower(trim(coalesce(p_from, '')));
  v_to   text := trim(coalesce(p_to, ''));
  v_up   text := (select value from jsonb_each_text(v_p) where lower(trim(key)) = v_from limit 1);
  v_new  jsonb := '{}';
  r record;
begin
  if not (has_permission('request.order') or has_permission('workflow.edit')) then
    raise exception 'Only the Treasurer can change budgets.';
  end if;
  for r in select key c, value p from jsonb_each_text(v_p) loop
    if lower(trim(r.c)) = v_from then
      continue when p_deleting or v_to = '';
      r.c := v_to;
    end if;
    if lower(trim(r.p)) = v_from then
      if p_deleting or v_to = '' then
        continue when v_up is null;
        r.p := v_up;
      else
        r.p := v_to;
      end if;
    end if;
    continue when lower(trim(r.c)) = lower(trim(r.p)) or v_new ? r.c;
    v_new := v_new || jsonb_build_object(r.c, r.p);
  end loop;
  update app_settings set value = jsonb_set(value, '{budgets,parents}', v_new), updated_at = now(), updated_by = auth.uid()
  where key = 'workflow' and value ? 'budgets';
end;
$$;
revoke execute on function public.budget_rename_parents(text, text, boolean) from public, anon;
grant execute on function public.budget_rename_parents(text, text, boolean) to authenticated;

revoke execute on function public.budget_below(jsonb, text), public.budget_above(jsonb, text) from public, anon;
grant execute on function public.budget_below(jsonb, text), public.budget_above(jsonb, text) to authenticated;
revoke execute on function public.move_budget(text, text, numeric, text) from public, anon;
grant execute on function public.move_budget(text, text, numeric, text) to authenticated;

select public.migration_done(58, '058_budget_tree.sql');
