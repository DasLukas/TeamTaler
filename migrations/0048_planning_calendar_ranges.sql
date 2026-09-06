ALTER TABLE planning_events ADD COLUMN starts_at_us INTEGER;
ALTER TABLE planning_events ADD COLUMN ends_at_us INTEGER;
ALTER TABLE planning_events ADD COLUMN response_deadline_us INTEGER;

UPDATE planning_events
SET starts_at_us=CAST(strftime('%s',starts_at) AS INTEGER)*1000000+
        CASE WHEN instr(starts_at,'.')>0
            THEN CAST(substr(substr(starts_at,instr(starts_at,'.')+1,length(starts_at)-instr(starts_at,'.')-1)||'000000',1,6) AS INTEGER)
            ELSE 0 END,
    ends_at_us=CASE WHEN ends_at IS NULL THEN NULL
        ELSE CAST(strftime('%s',ends_at) AS INTEGER)*1000000+
            CASE WHEN instr(ends_at,'.')>0
                THEN CAST(substr(substr(ends_at,instr(ends_at,'.')+1,length(ends_at)-instr(ends_at,'.')-1)||'000000',1,6) AS INTEGER)
                ELSE 0 END END,
    response_deadline_us=CASE WHEN response_deadline IS NULL THEN NULL
        ELSE CAST(strftime('%s',response_deadline) AS INTEGER)*1000000+
            CASE WHEN instr(response_deadline,'.')>0
                THEN CAST(substr(substr(response_deadline,instr(response_deadline,'.')+1,length(response_deadline)-instr(response_deadline,'.')-1)||'000000',1,6) AS INTEGER)
                ELSE 0 END END;

CREATE TRIGGER planning_events_project_calendar_insert
AFTER INSERT ON planning_events
BEGIN
    UPDATE planning_events
    SET starts_at_us=CAST(strftime('%s',NEW.starts_at) AS INTEGER)*1000000+
            CASE WHEN instr(NEW.starts_at,'.')>0
                THEN CAST(substr(substr(NEW.starts_at,instr(NEW.starts_at,'.')+1,length(NEW.starts_at)-instr(NEW.starts_at,'.')-1)||'000000',1,6) AS INTEGER)
                ELSE 0 END,
        ends_at_us=CASE WHEN NEW.ends_at IS NULL THEN NULL
            ELSE CAST(strftime('%s',NEW.ends_at) AS INTEGER)*1000000+
                CASE WHEN instr(NEW.ends_at,'.')>0
                    THEN CAST(substr(substr(NEW.ends_at,instr(NEW.ends_at,'.')+1,length(NEW.ends_at)-instr(NEW.ends_at,'.')-1)||'000000',1,6) AS INTEGER)
                    ELSE 0 END END,
        response_deadline_us=CASE WHEN NEW.response_deadline IS NULL THEN NULL
            ELSE CAST(strftime('%s',NEW.response_deadline) AS INTEGER)*1000000+
                CASE WHEN instr(NEW.response_deadline,'.')>0
                    THEN CAST(substr(substr(NEW.response_deadline,instr(NEW.response_deadline,'.')+1,length(NEW.response_deadline)-instr(NEW.response_deadline,'.')-1)||'000000',1,6) AS INTEGER)
                    ELSE 0 END END
    WHERE id=NEW.id;
END;

CREATE TRIGGER planning_events_project_calendar_update
AFTER UPDATE OF starts_at,ends_at,response_deadline,starts_at_us,ends_at_us,response_deadline_us ON planning_events
WHEN NEW.starts_at_us IS NOT CAST(strftime('%s',NEW.starts_at) AS INTEGER)*1000000+
        CASE WHEN instr(NEW.starts_at,'.')>0
            THEN CAST(substr(substr(NEW.starts_at,instr(NEW.starts_at,'.')+1,length(NEW.starts_at)-instr(NEW.starts_at,'.')-1)||'000000',1,6) AS INTEGER)
            ELSE 0 END
  OR NEW.ends_at_us IS NOT CASE WHEN NEW.ends_at IS NULL THEN NULL
        ELSE CAST(strftime('%s',NEW.ends_at) AS INTEGER)*1000000+
            CASE WHEN instr(NEW.ends_at,'.')>0
                THEN CAST(substr(substr(NEW.ends_at,instr(NEW.ends_at,'.')+1,length(NEW.ends_at)-instr(NEW.ends_at,'.')-1)||'000000',1,6) AS INTEGER)
                ELSE 0 END END
  OR NEW.response_deadline_us IS NOT CASE WHEN NEW.response_deadline IS NULL THEN NULL
        ELSE CAST(strftime('%s',NEW.response_deadline) AS INTEGER)*1000000+
            CASE WHEN instr(NEW.response_deadline,'.')>0
                THEN CAST(substr(substr(NEW.response_deadline,instr(NEW.response_deadline,'.')+1,length(NEW.response_deadline)-instr(NEW.response_deadline,'.')-1)||'000000',1,6) AS INTEGER)
                ELSE 0 END END
BEGIN
    UPDATE planning_events
    SET starts_at_us=CAST(strftime('%s',NEW.starts_at) AS INTEGER)*1000000+
            CASE WHEN instr(NEW.starts_at,'.')>0
                THEN CAST(substr(substr(NEW.starts_at,instr(NEW.starts_at,'.')+1,length(NEW.starts_at)-instr(NEW.starts_at,'.')-1)||'000000',1,6) AS INTEGER)
                ELSE 0 END,
        ends_at_us=CASE WHEN NEW.ends_at IS NULL THEN NULL
            ELSE CAST(strftime('%s',NEW.ends_at) AS INTEGER)*1000000+
                CASE WHEN instr(NEW.ends_at,'.')>0
                    THEN CAST(substr(substr(NEW.ends_at,instr(NEW.ends_at,'.')+1,length(NEW.ends_at)-instr(NEW.ends_at,'.')-1)||'000000',1,6) AS INTEGER)
                    ELSE 0 END END,
        response_deadline_us=CASE WHEN NEW.response_deadline IS NULL THEN NULL
            ELSE CAST(strftime('%s',NEW.response_deadline) AS INTEGER)*1000000+
                CASE WHEN instr(NEW.response_deadline,'.')>0
                    THEN CAST(substr(substr(NEW.response_deadline,instr(NEW.response_deadline,'.')+1,length(NEW.response_deadline)-instr(NEW.response_deadline,'.')-1)||'000000',1,6) AS INTEGER)
                    ELSE 0 END END
    WHERE id=NEW.id;
END;

CREATE INDEX planning_events_calendar_start_us_idx
    ON planning_events(group_id,starts_at_us,id);
CREATE INDEX planning_events_calendar_end_us_idx
    ON planning_events(group_id,ends_at_us,starts_at_us,id)
    WHERE ends_at_us IS NOT NULL;
CREATE INDEX planning_events_response_deadline_us_idx
    ON planning_events(status,response_deadline_us,id)
    WHERE response_deadline_us IS NOT NULL;
CREATE INDEX planning_events_lifecycle_end_us_idx
    ON planning_events(status,coalesce(ends_at_us,starts_at_us),id);
CREATE INDEX planning_events_all_day_civil_range_idx
    ON planning_events(group_id,start_date,end_date_exclusive,id)
    WHERE all_day=1;
