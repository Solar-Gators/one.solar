select public.migration_begin(62);

-- =============================================================================
-- 062: a team date can be the season's start: the timeline numbers weeks from it (01, 02, …)
-- =============================================================================
--
--   The Gantt's header shows months over season weeks, like the team's roadmap slides. Week 01 starts on
--   the most recent "Season start" team date (Projects → Timeline → Plan → Team dates…). Without one, the
--   header shows calendar dates instead.
-- =============================================================================

alter table public.pm_key_dates drop constraint if exists pm_key_dates_kind_check;
alter table public.pm_key_dates add constraint pm_key_dates_kind_check
  check (kind in ('competition', 'review', 'deadline', 'milestone', 'break', 'season'));

select public.migration_done(62, '062_season_start.sql');
