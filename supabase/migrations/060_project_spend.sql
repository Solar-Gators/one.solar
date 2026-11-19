select public.migration_begin(60);

-- =============================================================================
-- 060: what a project spends: the Orders requests linked to its items, with their totals
-- =============================================================================
--
--   Projects could already link an Orders request to an item ("Parts & orders" on the item). Now the
--   project's Summary adds them up (spent: ordered or received; committed: approved, not ordered yet;
--   waiting: submitted), next to the project's own budget (project settings "budget", set by whoever can
--   configure the project), and an Orders request shows the project items it's linked to.
--   It reads with the caller's own access (security invoker): only links and requests they can already see.
-- =============================================================================

/** A linked request's total, only for a project the caller can see that links it (request_total isn't open to all). */
create or replace function public.pmx_linked_request_total(p_request uuid, p_project uuid)
returns numeric
language sql stable security definer set search_path = public, pg_temp
as $$
  select case when p_project = any(pm_visible())
                and exists (select 1 from pm_refs where project_id = p_project and kind = 'order' and ref_id = p_request)
              then request_total(p_request) end;
$$;
revoke execute on function public.pmx_linked_request_total(uuid, uuid) from public, anon;
grant execute on function public.pmx_linked_request_total(uuid, uuid) to authenticated;

/** The requests linked to a project's items: [{ id, number, title, status, total, items: [key…] }]. */
create or replace function public.pm_project_spend(p_project uuid)
returns jsonb
language sql stable security invoker set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(x order by x ->> 'number'), '[]'::jsonb) from (
    select jsonb_build_object('id', r.id, 'number', r.request_number, 'title', r.title, 'status', r.status,
             'total', pmx_linked_request_total(r.id, p_project), 'items', jsonb_agg(distinct i.key)) x
    from pm_refs f
    join pm_items i on i.id = f.item_id and i.archived_at is null
    join requests r on r.id = f.ref_id
    where f.project_id = p_project and f.kind = 'order'
    group by r.id, r.request_number, r.title, r.status
  ) q;
$$;
revoke execute on function public.pm_project_spend(uuid) from public, anon;
grant execute on function public.pm_project_spend(uuid) to authenticated;

select public.migration_done(60, '060_project_spend.sql');
