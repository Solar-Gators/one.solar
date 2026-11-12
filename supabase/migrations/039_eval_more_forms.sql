-- =============================================================================
-- 039: Solar Evals — an eval type can offer more than one form, and an
--      "E-board eval" type that uses it
-- =============================================================================
-- Run once, after 038: Supabase → SQL Editor → New query → paste → Run.
--
--   * Eval types get "Other forms they can pick" (settings.form.also): a list
--     of forms. Whoever starts an eval of that type picks any version of the
--     main form, any of those forms, or any of their variants. Types without
--     it work exactly as before.
--   * A new "E-board eval" type: the E-board position evaluates the E-board.
--     The evaluator picks the form when they start the eval: the person's
--     position on the Leadership eval, or any other form. Input from up to 3
--     people, picked by the evaluator, with private notes; no self-eval; a
--     meeting, then the eval is shared. Change any of it in Setup.
-- =============================================================================

-- The 036 checks, plus the list of other forms.
alter function public.eval_check_settings(jsonb) rename to eval_check_settings_base;

create or replace function public.eval_check_settings(s jsonb)
returns void
language plpgsql stable set search_path = public, pg_temp
as $$
declare a jsonb := s -> 'form' -> 'also';
begin
  perform eval_check_settings_base(s);
  if a is null or a = 'null'::jsonb then return; end if;
  if jsonb_typeof(a) <> 'array' or jsonb_array_length(a) > 30
     or exists (select 1 from jsonb_array_elements(a) x where jsonb_typeof(x) <> 'string') then
    raise exception '"Other forms they can pick": that list is incomplete.';
  end if;
  if exists (select 1 from jsonb_array_elements_text(a) x
             where not exists (select 1 from eval_tracks where id = x and removed_at is null)) then
    raise exception 'One of the other forms has been removed. Take it off the list.';
  end if;
end;
$$;

/** Does this form (or variant) belong to the eval type? Its form (and variants), or one of the other forms (and theirs). */
create or replace function public.eval_template_fits(p_track text, s jsonb)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select p_track = s -> 'form' ->> 'track'
      or ((s -> 'form' ->> 'variants')::boolean
          and exists (select 1 from eval_tracks where id = p_track and parent_id = s -> 'form' ->> 'track'))
      or exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(s -> 'form' -> 'also') = 'array' then s -> 'form' -> 'also' else '[]' end) x
                 join eval_tracks k on k.id = p_track
                 where x = k.id or x = k.parent_id);
$$;

/** Take away a form (and its variants) nobody's eval type uses. Evals written on it keep their own copy. */
create or replace function public.eval_form_remove(p_id text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_used text; v_top text;
begin
  perform require_permission('evals.templates');
  select coalesce(parent_id, id) into v_top from eval_tracks where id = p_id and removed_at is null;
  if v_top is null then return; end if;
  select string_agg(name, ', ') into v_used from eval_types y
  where y.settings -> 'form' ->> 'track' in (select id from eval_tracks where id = p_id or parent_id = p_id)
     or exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(y.settings -> 'form' -> 'also') = 'array' then y.settings -> 'form' -> 'also' else '[]' end) x
                where x in (select id from eval_tracks where id = p_id or parent_id = p_id));
  if v_used is not null then raise exception 'That form is used by %. Pick another form there first.', v_used; end if;
  update eval_tracks set removed_at = now() where id = p_id or parent_id = p_id;
end;
$$;

revoke execute on function public.eval_check_settings(jsonb) from public, anon;

-- The E-board eval.
do $$
declare s jsonb;
begin
  if exists (select 1 from eval_types where id = 'eboard') or not exists (select 1 from roles where key = 'eboard')
     or not exists (select 1 from eval_tracks where id = 'leadership' and removed_at is null) then
    return;
  end if;
  s := jsonb_build_object(
    'labels',        jsonb_build_object('subject', 'E-board member', 'evaluator', 'Evaluator', 'input', 'Input', 'variant', 'Position'),
    'subjects',      jsonb_build_object('rule', 'role', 'value', 'eboard'),
    'evaluators',    jsonb_build_object('rule', 'role', 'value', 'eboard'),
    'input',         jsonb_build_object('on', true, 'rule', 'anyone', 'max', 3, 'pickedBy', 'evaluator', 'notes', true),
    'form',          jsonb_build_object('track', 'leadership', 'variants', true,
                       'also', coalesce((select jsonb_agg(id order by sort, name) from eval_tracks
                                         where parent_id is null and removed_at is null and id <> 'leadership'), '[]'::jsonb)),
    'questionnaire', jsonb_build_object('on', false, 'source', 'evaluator', 'id', null),
    'meeting',       true,
    'comments',      true,
    'visibility',    jsonb_build_object(
                       'answers',  jsonb_build_object('evaluator', 'final', 'input', 'final', 'viewers', 'final', 'extra', 'never'),
                       'eval',     jsonb_build_object('subject', 'shared', 'input', 'draft', 'viewers', 'final', 'extra', 'never'),
                       'extraWho', jsonb_build_object('rule', 'none')),
    'notify',        jsonb_build_object('submitted', false, 'finished', false, 'meeting', true, 'shared', true, 'input', true));
  perform eval_check_settings(s);
  insert into eval_types (id, name, description, sort, settings) values
    ('eboard', 'E-board eval',
     'Semester review of E-board members. Pick the form when you start: their position on the Leadership eval, or any other form.',
     coalesce((select max(sort) + 1 from eval_types), 1), s);
  insert into eval_type_history (type_id, name, description, active, settings, note, saved_by_name)
  select id, name, description, active, settings, 'Added by 039: the evaluator picks the form for each eval.', 'Solar Gators'
  from eval_types where id = 'eboard';
end;
$$;

update app_settings set value = jsonb_set(value, '{schemaVersion}', '39') where key = 'general';
