select public.migration_begin(73);

-- =============================================================================
-- 073: delete, not just archive, in Workbench.
--   * pm_delete_item(id, dry_run): an item and everything under it, for people whose role has "Delete". With
--     dry_run it only says how many items would go (for the confirmation).
--   * pm_delete_project(id, key): a whole Space and everything in it, for Admins (Manage all projects) only, who
--     type its key to confirm. If its subsystem is still there, it gets a fresh, empty Space right away (072).
-- Both are permanent. Comments, history, checklists, links, files' records, approvals and inbox messages go
-- with what they belong to (their tables cascade); alumni-hub posts stay, without the link.
-- =============================================================================

create or replace function public.pm_delete_item(p_id uuid, p_dry_run boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  o     pm_items;
  v_ids uuid[];
begin
  perform pmx_open();
  select * into o from pm_items where id = p_id for update;
  if o.id is null then raise exception 'That item doesn''t exist.'; end if;
  perform pmx_need(o.project_id, 'delete');
  with recursive tree as (select id from pm_items where id = p_id union all select i.id from pm_items i join tree t on i.parent_id = t.id)
  select array_agg(id) into v_ids from tree;
  if p_dry_run then return jsonb_build_object('dry_run', true, 'key', o.key, 'items', cardinality(v_ids)); end if;
  delete from pm_items where id = any(v_ids);
  perform pmx_log(o.project_id, null, 'deleted', 'Deleted ' || o.key || ' "' || left(o.title, 120) || '"'
    || case when cardinality(v_ids) > 1 then ' and ' || (cardinality(v_ids) - 1) || ' under it' else '' end, jsonb_build_object('key', o.key, 'items', cardinality(v_ids)));
  return jsonb_build_object('key', o.key, 'items', cardinality(v_ids));
end;
$$;

create or replace function public.pm_delete_project(p_id uuid, p_key text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  o     pm_projects;
  v_n   int;
  v_new uuid;
begin
  perform pmx_open();
  if not has_permission('projects.manage') then
    raise exception 'Only an Admin (with "Manage all projects") can delete a Space. Archive it instead.' using errcode = '42501';
  end if;
  select * into o from pm_projects where id = p_id for update;
  if o.id is null then raise exception 'That Space doesn''t exist.'; end if;
  if upper(trim(coalesce(p_key, ''))) <> o.key then raise exception 'Type the Space''s key, %, to delete it.', o.key; end if;
  select count(*) into v_n from pm_items where project_id = o.id;
  delete from pm_items where project_id = o.id;   -- items first: they point at the Space's types and statuses
  delete from pm_projects where id = o.id;        -- the rest belongs to the Space and goes with it
  if o.subsystem_id is not null then v_new := pmx_ensure_space(o.subsystem_id); end if;
  return jsonb_build_object('key', o.key, 'items', v_n, 'new_space', (select key from pm_projects where id = v_new));
end;
$$;

-- the "delete" ability now also deletes for good: its name says so
create or replace function public.pmx_need(p_project uuid, p_cap text)
returns void language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_caps text[];
begin
  perform pmx_open();
  v_caps := pmx_caps_for(p_project, auth.uid());
  if not ('view' = any(v_caps)) then raise exception 'That project doesn''t exist, or you can''t see it.' using errcode = '42501'; end if;
  if not (p_cap = any(v_caps)) then
    raise exception 'Your role in this project can''t do this (it needs "%").',
      case p_cap when 'create' then 'Create items' when 'edit' then 'Edit items' when 'assign' then 'Assign people'
        when 'transition' then 'Move items between statuses' when 'approve' then 'Approve' when 'comment' then 'Comment'
        when 'delete' then 'Archive and delete items' when 'plan' then 'Plan and schedule' when 'boards' then 'Shared boards and views'
        when 'configure' then 'Project settings, types and fields' when 'workflows' then 'Workflows'
        when 'automations' then 'Automation rules' when 'members' then 'Members and roles' else p_cap end
      using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.pm_delete_item(uuid, boolean) from public, anon;
grant execute on function public.pm_delete_item(uuid, boolean) to authenticated;
revoke execute on function public.pm_delete_project(uuid, text) from public, anon;
grant execute on function public.pm_delete_project(uuid, text) to authenticated;

select public.migration_done(73, '073_delete.sql');
