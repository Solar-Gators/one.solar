select public.migration_begin(70);

-- 070: workflows that are easier to own.
--  * Project Managers may change workflows (the "workflows" ability), in new projects, in the starting templates and in
--    every existing project's Project Manager role.
--  * The "Engineering design" template gives Design Review and Test their own workflows (other types keep the shared
--    one), so each kind of work moves the way it really does.

-- new projects: the Project Manager role includes "workflows"
create or replace function public.pmx_make_config(p_statuses jsonb, p_types jsonb, p_fields jsonb, p_gate text, p_free boolean)
returns jsonb language plpgsql volatile set search_path = public, pg_temp
as $$
declare
  v_wf     uuid := gen_random_uuid();
  v_roles  jsonb;
  v_st     jsonb := '[]';
  v_tr     jsonb := '[]';
  v_types  jsonb := '[]';
  v_fields jsonb := '[]';
  v_ids    uuid[] := '{}';
  v_viewer uuid := gen_random_uuid();
  r        jsonb;
  i        int := 0;
  n        int := jsonb_array_length(p_statuses);
begin
  v_roles := jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid(), 'key', 'admin', 'name', 'Project Administrator', 'sort', 1, 'caps', to_jsonb(pmx_all_caps())),
    jsonb_build_object('id', gen_random_uuid(), 'key', 'manager', 'name', 'Project Manager', 'sort', 2, 'caps',
      to_jsonb(array['view', 'create', 'edit', 'assign', 'transition', 'approve', 'comment', 'delete', 'plan', 'boards', 'automations', 'members', 'workflows'])),
    jsonb_build_object('id', gen_random_uuid(), 'key', 'contributor', 'name', 'Contributor', 'sort', 3, 'caps',
      to_jsonb(array['view', 'create', 'edit', 'assign', 'transition', 'comment'])),
    jsonb_build_object('id', gen_random_uuid(), 'key', 'approver', 'name', 'Approver', 'sort', 4, 'caps',
      to_jsonb(array['view', 'comment', 'transition', 'approve'])),
    jsonb_build_object('id', v_viewer, 'key', 'viewer', 'name', 'Viewer', 'sort', 5, 'caps', to_jsonb(array['view', 'comment'])));
  for r in select * from jsonb_array_elements(p_statuses) loop
    v_ids := v_ids || gen_random_uuid();
    i := i + 1;
    v_st := v_st || jsonb_build_object('id', v_ids[i], 'name', r ->> 0, 'category', r ->> 1, 'color', coalesce(r ->> 2, 'gray'),
      'sort', i * 10, 'x', 40 + (i - 1) * 190, 'y', 70);
  end loop;
  for i in 1..n loop
    if p_free then
      v_tr := v_tr || jsonb_build_object('id', gen_random_uuid(), 'name', p_statuses -> (i - 1) ->> 0, 'from_status', null, 'to_status', v_ids[i], 'sort', i * 10);
    else
      if i < n then
        v_tr := v_tr || jsonb_build_object('id', gen_random_uuid(), 'name', 'Move to ' || (p_statuses -> i ->> 0), 'from_status', v_ids[i], 'to_status', v_ids[i + 1],
          'sort', i * 20, 'require_approval', (p_statuses -> i ->> 0) is not distinct from p_gate);
        v_tr := v_tr || jsonb_build_object('id', gen_random_uuid(), 'name', 'Back to ' || (p_statuses -> (i - 1) ->> 0), 'from_status', v_ids[i + 1], 'to_status', v_ids[i],
          'sort', i * 20 + 1);
      end if;
    end if;
  end loop;
  i := 0;
  for r in select * from jsonb_array_elements(p_types) loop
    i := i + 1;
    v_types := v_types || jsonb_build_object('id', gen_random_uuid(), 'name', r ->> 0, 'icon', coalesce(r ->> 1, ''), 'color', coalesce(r ->> 2, 'blue'),
      'level', coalesce((r ->> 3)::int, 1), 'is_milestone', coalesce((r ->> 4)::boolean, false), 'workflow_id', v_wf, 'sort', i * 10);
  end loop;
  i := 0;
  for r in select * from jsonb_array_elements(coalesce(p_fields, '[]')) loop
    i := i + 1;
    v_fields := v_fields || jsonb_build_object('id', gen_random_uuid(), 'key', r ->> 0, 'name', r ->> 1, 'type', r ->> 2,
      'options', coalesce(r -> 3, '[]'), 'sort', i * 10);
  end loop;
  return jsonb_build_object('format', 1, 'visibility', 'team', 'team_role', v_viewer,
    'settings', jsonb_build_object('working_days', jsonb_build_array(1, 2, 3, 4, 5), 'holidays', '[]'::jsonb, 'sprints', false, 'sprint_days', 14),
    'roles', v_roles,
    'workflows', jsonb_build_array(jsonb_build_object('id', v_wf, 'name', 'Workflow', 'statuses', v_st, 'transitions', v_tr)),
    'types', v_types, 'fields', v_fields, 'layouts', '[]'::jsonb, 'views', '[]'::jsonb, 'automations', '[]'::jsonb, 'items', '[]'::jsonb, 'deps', '[]'::jsonb);
end;
$$;

-- existing projects: the Project Manager role gets "workflows" (roles renamed or re-keyed by a project are left alone)
update public.pm_roles set caps = caps || array['workflows']
where key = 'manager' and not ('workflows' = any(caps));

-- the starting templates: the same for their Project Manager role
update public.pm_templates t set config = jsonb_set(t.config, '{roles}', (
    select jsonb_agg(case when r ->> 'key' = 'manager' and not (r -> 'caps' ? 'workflows') then jsonb_set(r, '{caps}', (r -> 'caps') || '"workflows"'::jsonb) else r end order by n)
    from jsonb_array_elements(t.config -> 'roles') with ordinality as x(r, n)))
where jsonb_typeof(t.config -> 'roles') = 'array' and jsonb_array_length(t.config -> 'roles') > 0;

/**
 * A workflow of its own for one type in a template's config. p_statuses: [[name, category, color]…] in order; any
 * status can move to any other; p_gate: the status that needs approval to enter (or null).
 */
create or replace function public.pmx_type_workflow(p_config jsonb, p_type text, p_name text, p_statuses jsonb, p_gate text)
returns jsonb language plpgsql volatile set search_path = public, pg_temp
as $$
declare
  v_wf  uuid := gen_random_uuid();
  v_st  jsonb := '[]';
  v_tr  jsonb := '[]';
  v_id  uuid;
  r     jsonb;
  i     int := 0;
begin
  for r in select * from jsonb_array_elements(p_statuses) loop
    i := i + 1;
    v_id := gen_random_uuid();
    v_st := v_st || jsonb_build_object('id', v_id, 'name', r ->> 0, 'category', r ->> 1, 'color', coalesce(r ->> 2, 'gray'), 'sort', i * 10, 'x', 40 + (i - 1) * 190, 'y', 70);
    v_tr := v_tr || jsonb_build_object('id', gen_random_uuid(), 'name', r ->> 0, 'from_status', null, 'to_status', v_id, 'sort', i * 10,
      'require_approval', (r ->> 0) is not distinct from p_gate);
  end loop;
  return jsonb_set(jsonb_set(p_config, '{workflows}', coalesce(p_config -> 'workflows', '[]') || jsonb_build_array(jsonb_build_object('id', v_wf, 'name', p_name, 'statuses', v_st, 'transitions', v_tr))),
    '{types}', (select jsonb_agg(case when ty ->> 'name' = p_type then jsonb_set(ty, '{workflow_id}', to_jsonb(v_wf)) else ty end order by n)
                from jsonb_array_elements(p_config -> 'types') with ordinality as x(ty, n)));
end;
$$;
revoke execute on function public.pmx_type_workflow(jsonb, text, text, jsonb, text) from public, anon, authenticated;

-- "Engineering design": its shared workflow keeps Design Task, Analysis, Epic, Milestone and Subtask; Design Review and
-- Test get their own. Only while the template still has its one starting workflow (an edited template is left alone).
update public.pm_templates set config = public.pmx_type_workflow(public.pmx_type_workflow(
    jsonb_set(config, '{workflows,0,name}', '"Design work"'),
    'Design Review', 'Design review', '[["Scheduled", "todo", "gray"], ["In Review", "doing", "purple"], ["Changes Needed", "doing", "amber"], ["Passed", "done", "green"]]', 'Passed'),
    'Test', 'Test', '[["Planned", "todo", "gray"], ["Testing", "doing", "blue"], ["Passed", "done", "green"], ["Failed", "done", "red"]]', null),
  description = 'Draft → In Design → In Review → Approved → Released, one step at a time; "Approved" needs someone who may approve. Design reviews (Scheduled → In Review → Passed, which needs approval) and tests (Planned → Testing → Passed or Failed) each have their own workflow. Design tasks, analyses, design reviews and tests with engineering fields.',
  updated_at = now()
where name = 'Engineering design' and jsonb_array_length(config -> 'workflows') = 1;

select public.migration_done(70, '070_workflow_owners.sql');
