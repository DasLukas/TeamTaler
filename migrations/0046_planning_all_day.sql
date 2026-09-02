ALTER TABLE planning_events ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0 CHECK(all_day IN (0,1));
ALTER TABLE planning_events ADD COLUMN timezone TEXT CHECK(timezone IS NULL OR length(trim(timezone)) BETWEEN 1 AND 120);
ALTER TABLE planning_events ADD COLUMN start_date TEXT;
ALTER TABLE planning_events ADD COLUMN end_date_exclusive TEXT;
ALTER TABLE planning_events ADD COLUMN original_start_date TEXT;

UPDATE planning_events
SET timezone=(SELECT settings.timezone FROM group_notification_settings settings WHERE settings.group_id=planning_events.group_id)
WHERE timezone IS NULL;

CREATE TRIGGER planning_events_validate_all_day_insert
BEFORE INSERT ON planning_events
WHEN NEW.timezone IS NULL
  OR length(trim(NEW.timezone)) NOT BETWEEN 1 AND 120
  OR (NEW.all_day=0 AND (NEW.start_date IS NOT NULL OR NEW.end_date_exclusive IS NOT NULL))
  OR (NEW.all_day=1 AND (
      NEW.timezone IS NULL
      OR NEW.start_date IS NULL
      OR length(NEW.start_date)!=10
      OR NEW.start_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      OR date(NEW.start_date) IS NULL
      OR date(NEW.start_date)!=NEW.start_date
      OR NEW.end_date_exclusive IS NULL
      OR length(NEW.end_date_exclusive)!=10
      OR NEW.end_date_exclusive NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      OR date(NEW.end_date_exclusive) IS NULL
      OR date(NEW.end_date_exclusive)!=NEW.end_date_exclusive
      OR NEW.end_date_exclusive<=NEW.start_date
      OR NEW.ends_at IS NULL
  ))
  OR ((NEW.series_id IS NULL OR NEW.all_day=0) AND NEW.original_start_date IS NOT NULL)
  OR (NEW.series_id IS NOT NULL AND NEW.all_day=1 AND (
      NEW.original_start_date IS NULL
      OR length(NEW.original_start_date)!=10
      OR NEW.original_start_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      OR date(NEW.original_start_date) IS NULL
      OR date(NEW.original_start_date)!=NEW.original_start_date
  ))
BEGIN
    SELECT RAISE(ABORT,'invalid planning event all-day schedule');
END;

CREATE TRIGGER planning_events_validate_all_day_update
BEFORE UPDATE ON planning_events
WHEN NEW.timezone IS NULL
  OR length(trim(NEW.timezone)) NOT BETWEEN 1 AND 120
  OR (NEW.all_day=0 AND (NEW.start_date IS NOT NULL OR NEW.end_date_exclusive IS NOT NULL))
  OR (NEW.all_day=1 AND (
      NEW.timezone IS NULL
      OR NEW.start_date IS NULL
      OR length(NEW.start_date)!=10
      OR NEW.start_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      OR date(NEW.start_date) IS NULL
      OR date(NEW.start_date)!=NEW.start_date
      OR NEW.end_date_exclusive IS NULL
      OR length(NEW.end_date_exclusive)!=10
      OR NEW.end_date_exclusive NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      OR date(NEW.end_date_exclusive) IS NULL
      OR date(NEW.end_date_exclusive)!=NEW.end_date_exclusive
      OR NEW.end_date_exclusive<=NEW.start_date
      OR NEW.ends_at IS NULL
  ))
  OR ((NEW.series_id IS NULL OR NEW.all_day=0) AND NEW.original_start_date IS NOT NULL)
  OR (NEW.series_id IS NOT NULL AND NEW.all_day=1 AND (
      NEW.original_start_date IS NULL
      OR length(NEW.original_start_date)!=10
      OR NEW.original_start_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      OR date(NEW.original_start_date) IS NULL
      OR date(NEW.original_start_date)!=NEW.original_start_date
  ))
BEGIN
    SELECT RAISE(ABORT,'invalid planning event all-day schedule');
END;

CREATE INDEX planning_events_calendar_end_idx ON planning_events(group_id,ends_at,id) WHERE ends_at IS NOT NULL;

ALTER TABLE planning_series_revisions ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0 CHECK(all_day IN (0,1));
ALTER TABLE planning_series_revisions ADD COLUMN start_date TEXT;
ALTER TABLE planning_series_revisions ADD COLUMN duration_days INTEGER CHECK(duration_days BETWEEN 1 AND 7);

CREATE TRIGGER planning_series_revisions_validate_all_day_insert
BEFORE INSERT ON planning_series_revisions
WHEN (NEW.all_day=0 AND (NEW.start_date IS NOT NULL OR NEW.duration_days IS NOT NULL))
  OR (NEW.all_day=1 AND (
      NEW.start_date IS NULL
      OR length(NEW.start_date)!=10
      OR NEW.start_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      OR date(NEW.start_date) IS NULL
      OR date(NEW.start_date)!=NEW.start_date
      OR NEW.duration_days IS NULL
      OR NEW.duration_minutes IS NOT NULL
  ))
BEGIN
    SELECT RAISE(ABORT,'invalid planning series all-day schedule');
END;

CREATE TRIGGER planning_series_revisions_validate_all_day_update
BEFORE UPDATE ON planning_series_revisions
WHEN (NEW.all_day=0 AND (NEW.start_date IS NOT NULL OR NEW.duration_days IS NOT NULL))
  OR (NEW.all_day=1 AND (
      NEW.start_date IS NULL
      OR length(NEW.start_date)!=10
      OR NEW.start_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      OR date(NEW.start_date) IS NULL
      OR date(NEW.start_date)!=NEW.start_date
      OR NEW.duration_days IS NULL
      OR NEW.duration_minutes IS NOT NULL
  ))
BEGIN
    SELECT RAISE(ABORT,'invalid planning series all-day schedule');
END;
