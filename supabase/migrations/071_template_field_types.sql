select public.migration_begin(71);

-- =============================================================================
-- 071: the Engineering design template's fields belong to their own work types
-- =============================================================================
-- (070 is the workflow owners migration, built alongside this one.)
--
-- The six engineering fields in the "Engineering design" template (051) were on every work type, so a Design Task's
-- New item form asked for a test procedure and a review date. Each now belongs to the types it is for:
--
--   requirement                            Epic, Design Task
--   analysis_type                          Analysis
--   review_date                            Design Review
--   test_procedure, measured_result,       Test
--   outcome
--
-- Only the template changes: projects made from it before now keep their fields as they are (Settings → Work types
-- & fields → All fields → a field → "On" changes them). A template someone already edited keeps their choices: a field
-- that already names types is left alone.

update public.pm_templates t
set config = jsonb_set(t.config, '{fields}', (
  select coalesce(jsonb_agg(
    case when coalesce(jsonb_array_length(f -> 'type_ids'), 0) = 0 and m.names is not null
      then f || jsonb_build_object('type_ids', (
        select coalesce(jsonb_agg(ty ->> 'id'), '[]'::jsonb)
        from jsonb_array_elements(t.config -> 'types') ty where ty ->> 'name' = any(m.names)))
      else f end
    order by ord), '[]'::jsonb)
  from jsonb_array_elements(t.config -> 'fields') with ordinality e(f, ord)
  left join (values
    ('requirement', array['Epic', 'Design Task']),
    ('analysis_type', array['Analysis']),
    ('review_date', array['Design Review']),
    ('test_procedure', array['Test']),
    ('measured_result', array['Test']),
    ('outcome', array['Test'])) m(key, names) on m.key = f ->> 'key'))
where t.name = 'Engineering design' and jsonb_typeof(t.config -> 'fields') = 'array';

select public.migration_done(71, '071_template_field_types.sql');
