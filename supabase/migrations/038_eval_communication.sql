-- =============================================================================
-- 038: Solar Evals — "Communication" also rates how easy someone is to work with
-- =============================================================================
-- Run once, after 037: Supabase → SQL Editor → New query → paste → Run.
--
--   Every form's "Communication" row (member evals and leadership evals) now
--   covers the personable side too: approachable, respectful, receptive to
--   feedback, easy to work with. Each form whose latest version still has the
--   original Communication wording gets a new version (e.g. v1.0 → v1.1) with
--   the new wording; nothing else on it changes. Versions are never edited, so
--   the old ones stay in History, and evals already written keep their copy.
--   A Communication row someone already reworded is left alone (listed in the
--   messages below the query); change it on the Forms tab if you want to.
-- =============================================================================

do $$
declare
  member_old jsonb := '["Fails to share critical updates, repeatedly delaying others.", "Gives sporadic updates; teammates must repeatedly request information.", "Shares progress, blockers, and schedule changes promptly and clearly.", "Anticipates information needs and coordinates before issues disrupt work.", "Improves team communication practices and prevents recurring disconnects."]';
  member_new jsonb := '{"sub": "Progress, blockers, coordination, approachability",
    "levels": ["Fails to share critical updates, or is difficult or dismissive to work with.",
               "Gives sporadic updates; can be hard to reach or unreceptive to feedback.",
               "Shares progress, blockers and changes promptly; approachable and easy to work with.",
               "Anticipates information needs; teammates find them easy and pleasant to work with.",
               "Improves how the team communicates; others actively want to work with them."]}';
  lead_old jsonb := '["Withholds or misses critical updates, creating avoidable delays.", "Provides irregular updates; others repeatedly have to ask.", "Shares progress, blockers, and changes promptly and clearly.", "Anticipates coordination needs and prevents avoidable confusion.", "Establishes communication practices that resolve recurring gaps."]';
  lead_new jsonb := '{"sub": "Updates, coordination, feedback, approachability",
    "levels": ["Withholds critical updates or is hard to approach; others avoid working with them.",
               "Updates are irregular, or interactions are often curt, defensive or unresponsive.",
               "Shares updates promptly and clearly; approachable, respectful and easy to work with.",
               "Anticipates coordination needs; people seek them out because they are easy to work with.",
               "Sets the tone for open, respectful communication across the team."]}';
  v record;
  r jsonb;
  v_label text;
  n int := 0;
begin
  for v in
    select distinct on (t.track_id) t.*, k.name as track_name
    from eval_templates t join eval_tracks k on k.id = t.track_id
    where t.removed_at is null and k.removed_at is null
    order by t.track_id, t.created_at desc
  loop
    -- The latest version, with its original Communication row reworded.
    select jsonb_set(v.rubric, '{pages}', jsonb_agg(
             jsonb_set(p, '{criteria}', coalesce((
               select jsonb_agg(case
                   when c ->> 'id' = 'communication' and c -> 'levels' = member_old then c || member_new
                   when c ->> 'id' = 'communication' and c -> 'levels' = lead_old then c || lead_new
                   else c end order by ci)
               from jsonb_array_elements(p -> 'criteria') with ordinality as x(c, ci)), '[]'::jsonb))
             order by pi))
      into r
    from jsonb_array_elements(v.rubric -> 'pages') with ordinality as y(p, pi);

    if r is distinct from v.rubric then
      v_label := case when v.label ~ '^v\d+\.\d+$'
                      then 'v' || split_part(substr(v.label, 2), '.', 1) || '.' || (split_part(v.label, '.', 2)::int + 1)
                      else left(v.label, 22) || ' · communication' end;
      if exists (select 1 from eval_templates where track_id = v.track_id and lower(label) = lower(v_label) and removed_at is null) then
        v_label := left(v.label, 20) || ' · communication 2';
      end if;
      insert into eval_templates (track_id, label, note, based_on, rubric, author_name)
      values (v.track_id, v_label, 'Communication now also rates the personable side: how approachable and easy to work with they are.', v.id, r, 'Solar Gators');
      n := n + 1;
    elsif exists (select 1 from jsonb_array_elements(v.rubric -> 'pages') p, jsonb_array_elements(p -> 'criteria') c where c ->> 'id' = 'communication') then
      raise notice 'Left alone (its Communication row was already reworded): % %', v.track_name, v.label;
    end if;
  end loop;
  raise notice 'New versions with the new Communication wording: %', n;
end;
$$;

update app_settings set value = jsonb_set(value, '{schemaVersion}', '38') where key = 'general';
