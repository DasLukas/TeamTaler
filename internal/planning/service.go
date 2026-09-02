// Package planning implements group calendar events, recurring series, audiences, and participation.
package planning

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/idempotency"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
	"github.com/DasLukas/TeamTaler/internal/tablequery"
)

const (
	// EventAppointment identifies a calendar-only event without responses.
	EventAppointment = "APPOINTMENT"
	// EventAppointmentPoll identifies an event that accepts yes, maybe, or no responses.
	EventAppointmentPoll = "APPOINTMENT_POLL"
	// EventAppointmentRegistration identifies an event with registrations and optional capacity.
	EventAppointmentRegistration = "APPOINTMENT_REGISTRATION"
	// AudienceAllActive targets every active, credentialed membership in the group.
	AudienceAllActive = "ALL_ACTIVE_MEMBERS"
	// AudienceSelectedRoles targets active memberships assigned to selected roles.
	AudienceSelectedRoles = "SELECTED_ROLES"
	// AudienceSelectedMembers targets explicitly selected active memberships.
	AudienceSelectedMembers = "SELECTED_MEMBERS"
	// AudienceSelectedTargets combines selected roles and individual memberships.
	AudienceSelectedTargets = "SELECTED_TARGETS"
)

// Settings is the versioned group planning feature gate and its display time
// zone. Version is used as the optimistic-concurrency token for UpdateSettings.
type Settings struct {
	Enabled   bool   `json:"enabled"`
	Version   int64  `json:"version"`
	UpdatedAt string `json:"updatedAt"`
	TimeZone  string `json:"timeZone"`
}

// Counts is the privacy-safe event participation aggregate returned with an
// Event. It contains totals only and therefore does not disclose member IDs.
type Counts struct {
	Invited                int64 `json:"invited"`
	Yes                    int64 `json:"yes"`
	Maybe                  int64 `json:"maybe"`
	No                     int64 `json:"no"`
	Pending                int64 `json:"pending"`
	Registered             int64 `json:"registered"`
	Waitlisted             int64 `json:"waitlisted"`
	ReconfirmationRequired int64 `json:"reconfirmationRequired"`
}

// Participation is one membership's stored and effective event response.
// EffectiveStatus is the stored response, or PENDING when no response exists.
type Participation struct {
	MembershipID      string `json:"membershipId,omitempty"`
	DisplayName       string `json:"displayName,omitempty"`
	Status            string `json:"status"`
	EffectiveStatus   string `json:"effectiveStatus"`
	ConfirmedRevision int64  `json:"confirmedRevision"`
	Version           int64  `json:"version"`
	RespondedAt       string `json:"respondedAt,omitempty"`
	UpdatedAt         string `json:"updatedAt,omitempty"`
}

// Event is the permission-aware planning calendar read model. Target IDs and
// participant details are populated only when the requesting membership may
// view them.
type Event struct {
	ID                            string         `json:"id"`
	SeriesID                      *string        `json:"seriesId,omitempty"`
	OriginalStartAt               *string        `json:"originalStartAt,omitempty"`
	OriginalStartDate             *string        `json:"originalStartDate,omitempty"`
	IsSeriesException             bool           `json:"isSeriesException"`
	Title                         string         `json:"title"`
	Description                   string         `json:"description"`
	Location                      string         `json:"location"`
	EventType                     string         `json:"eventType"`
	Status                        string         `json:"status"`
	AudienceType                  string         `json:"audienceType"`
	AllDay                        bool           `json:"allDay"`
	TimeZone                      string         `json:"timeZone"`
	StartDate                     string         `json:"startDate,omitempty"`
	EndDateExclusive              string         `json:"endDateExclusive,omitempty"`
	StartsAt                      string         `json:"startsAt"`
	EndsAt                        *string        `json:"endsAt,omitempty"`
	ResponseDeadline              *string        `json:"responseDeadline,omitempty"`
	ResponseDeadlineMinutesBefore *int           `json:"responseDeadlineMinutesBefore,omitempty"`
	Capacity                      *int           `json:"capacity,omitempty"`
	WaitlistEnabled               bool           `json:"waitlistEnabled"`
	TargetRoleIDs                 []string       `json:"targetRoleIds"`
	TargetMembershipIDs           []string       `json:"targetMembershipIds"`
	ConfirmationRevision          int64          `json:"confirmationRevision"`
	Version                       int64          `json:"version"`
	Counts                        Counts         `json:"counts"`
	MyParticipation               *Participation `json:"myParticipation,omitempty"`
	CreatedAt                     string         `json:"createdAt"`
	UpdatedAt                     string         `json:"updatedAt"`
	CanEdit                       bool           `json:"canEdit"`
	CanCancel                     bool           `json:"canCancel"`
	CanViewParticipants           bool           `json:"canViewParticipants"`
	CanRespond                    bool           `json:"canRespond"`
}

// EventInput is the complete editable event representation accepted by create
// and update operations. Timed events use RFC 3339 timestamps. All-day events
// use an exclusive ISO calendar-date range and a server-pinned IANA time zone.
// Response deadlines are expressed as minutes before the derived StartsAt.
type EventInput struct {
	Title                         string   `json:"title"`
	Description                   string   `json:"description"`
	Location                      string   `json:"location"`
	EventType                     string   `json:"eventType"`
	AudienceType                  string   `json:"audienceType"`
	AllDay                        bool     `json:"allDay,omitempty"`
	TimeZone                      string   `json:"timeZone,omitempty"`
	StartDate                     string   `json:"startDate,omitempty"`
	EndDateExclusive              string   `json:"endDateExclusive,omitempty"`
	StartsAt                      string   `json:"startsAt"`
	EndsAt                        *string  `json:"endsAt"`
	ResponseDeadlineMinutesBefore *int     `json:"responseDeadlineMinutesBefore"`
	Capacity                      *int     `json:"capacity"`
	WaitlistEnabled               bool     `json:"waitlistEnabled"`
	TargetRoleIDs                 []string `json:"targetRoleIds"`
	TargetMembershipIDs           []string `json:"targetMembershipIds"`
}

// EventListQuery describes one calendar window. From and To are optional RFC
// 3339 instant bounds retained for timed-event clients. FromDate and
// ToDateExclusive form an optional exclusive ISO civil-date range for all-day
// events. When both bound pairs are present, each event mode uses its native
// range. Status is an optional lifecycle filter, Cursor is an opaque
// continuation token, and Limit is normalized to 100 unless it is 1 through
// 200.
type EventListQuery struct {
	From            string
	To              string
	FromDate        string
	ToDateExclusive string
	Status          string
	Cursor          string
	Limit           int
}

// Service performs tenant-scoped planning operations against one migrated
// TeamTaler database. Callers must provide the authenticated principal and
// active group membership required by each mutating operation.
type Service struct {
	// DB stores events, series, participation, audit records, and durable tasks.
	DB *sql.DB
}

func require(ctx context.Context, q authorization.Queryer, m domain.Membership, p domain.PermissionKey) error {
	return authorization.Require(ctx, q, m.GroupID, m.ID, p, authorization.GroupResource(m.GroupID))
}

func requireAny(ctx context.Context, q authorization.Queryer, m domain.Membership, permissions ...domain.PermissionKey) error {
	policy := authorization.NewPolicy(q)
	for _, permission := range permissions {
		allowed, err := policy.Can(ctx, m.GroupID, m.ID, permission, authorization.GroupResource(m.GroupID))
		if err != nil {
			return err
		}
		if allowed {
			return nil
		}
	}
	return domain.ErrForbidden
}

func requireEventMutation(ctx context.Context, q authorization.Queryer, m domain.Membership, ownerMembershipID string) error {
	if ownerMembershipID == m.ID {
		return require(ctx, q, m, domain.PermissionCreatePlanningEvents)
	}
	return require(ctx, q, m, domain.PermissionManagePlanningEvents)
}
func enabled(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, groupID string) error {
	var on bool
	if err := q.QueryRowContext(ctx, `SELECT enabled FROM group_planning_settings WHERE group_id=?`, groupID).Scan(&on); err != nil {
		return err
	}
	if !on {
		return domain.ErrPlanningDisabled
	}
	return nil
}

// GetSettings returns the planning feature gate and group time zone visible to
// a membership with planning-use or group-administration permission.
//
// m supplies the tenant boundary and authorization subject. The method returns
// the current Settings or an authorization, not-found, or storage error.
//
// Example: settings, err := service.GetSettings(ctx, membership).
func (s Service) GetSettings(ctx context.Context, m domain.Membership) (Settings, error) {
	if err := requireAny(ctx, s.DB, m, domain.PermissionUsePlanning, domain.PermissionGroupAdministration); err != nil {
		return Settings{}, err
	}
	var v Settings
	err := s.DB.QueryRowContext(ctx, `SELECT planning.enabled,planning.version,planning.updated_at,notifications.timezone FROM group_planning_settings planning JOIN group_notification_settings notifications ON notifications.group_id=planning.group_id WHERE planning.group_id=?`, m.GroupID).Scan(&v.Enabled, &v.Version, &v.UpdatedAt, &v.TimeZone)
	return v, err
}

// UpdateSettings enables or disables planning for one group under optimistic
// concurrency. Disabling cancels pending planning deliveries; enabling restores
// future reminders and materializes that group's published series.
//
// a and m identify the administrator and tenant, on is the desired state, and
// version must match the stored Settings version. The method returns the
// committed Settings or an authorization, precondition, or storage error.
//
// Example: settings, err := service.UpdateSettings(ctx, actor, membership, true, version).
func (s Service) UpdateSettings(ctx context.Context, a domain.Principal, m domain.Membership, on bool, version int64) (Settings, error) {
	var out Settings
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := require(ctx, tx, m, domain.PermissionGroupAdministration); err != nil {
			return err
		}
		now := platform.Timestamp(platform.Now())
		r, err := tx.ExecContext(ctx, `UPDATE group_planning_settings SET enabled=?,version=version+1,updated_at=?,updated_by_user_id=? WHERE group_id=? AND version=?`, on, now, a.UserID, m.GroupID, version)
		if err != nil {
			return err
		}
		n, _ := r.RowsAffected()
		if n != 1 {
			return domain.ErrPrecondition
		}
		if !on {
			_, _ = tx.ExecContext(ctx, `UPDATE planning_notification_tasks SET status='CANCELLED',updated_at=? WHERE group_id=? AND status='PENDING'`, now, m.GroupID)
			_, _ = tx.ExecContext(ctx, `UPDATE planning_series_notification_tasks SET status='CANCELLED',updated_at=? WHERE group_id=? AND status='PENDING'`, now, m.GroupID)
			_, _ = tx.ExecContext(ctx, `UPDATE notification_delivery_jobs SET status='FAILED',next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,last_error_code='planning_disabled',updated_at=? WHERE group_id=? AND status IN ('PENDING','SENDING') AND notification_id IN (SELECT id FROM notifications WHERE group_id=? AND type LIKE 'PLANNING_%')`, now, m.GroupID, m.GroupID)
		}
		if err := audit.Record(ctx, tx, m.GroupID, a.UserID, m.ID, "group.planning_settings.updated", "group_planning_settings", m.GroupID, map[string]any{"enabled": on}); err != nil {
			return err
		}
		return tx.QueryRowContext(ctx, `SELECT planning.enabled,planning.version,planning.updated_at,notifications.timezone FROM group_planning_settings planning JOIN group_notification_settings notifications ON notifications.group_id=planning.group_id WHERE planning.group_id=?`, m.GroupID).Scan(&out.Enabled, &out.Version, &out.UpdatedAt, &out.TimeZone)
	})
	if err == nil && on {
		_, err = s.materializeGroupSeries(ctx, m.GroupID, platform.Now().AddDate(1, 0, 0))
	}
	return out, err
}

func validEventType(v string) bool {
	return v == EventAppointment || v == EventAppointmentPoll || v == EventAppointmentRegistration
}
func validAudience(v string) bool {
	return v == AudienceAllActive || v == AudienceSelectedRoles || v == AudienceSelectedMembers || v == AudienceSelectedTargets
}

func validEventStatus(v string) bool {
	return v == "PUBLISHED" || v == "CLOSED" || v == "COMPLETED" || v == "CANCELLED"
}

func validateOptionalInt(field string, value *int, minimum, maximum int) error {
	if value != nil && (*value < minimum || *value > maximum) {
		return domain.ValidationError{Field: field, Message: "is outside the supported range"}
	}
	return nil
}

func normalizeEvent(in *EventInput) error {
	in.Title = strings.TrimSpace(in.Title)
	in.Description = strings.TrimSpace(in.Description)
	in.Location = strings.TrimSpace(in.Location)
	if in.Title == "" || len(in.Title) > 160 {
		return domain.ValidationError{Field: "title", Message: "must contain 1 to 160 characters"}
	}
	if len(in.Description) > 4000 {
		return domain.ValidationError{Field: "description", Message: "must contain at most 4000 characters"}
	}
	if len(in.Location) > 240 {
		return domain.ValidationError{Field: "location", Message: "must contain at most 240 characters"}
	}
	if !validEventType(in.EventType) {
		return domain.ValidationError{Field: "eventType", Message: "is unsupported"}
	}
	if !validAudience(in.AudienceType) {
		return domain.ValidationError{Field: "audienceType", Message: "is unsupported"}
	}
	if err := normalizeEventSchedule(in); err != nil {
		return err
	}
	if in.EventType == EventAppointment {
		in.ResponseDeadlineMinutesBefore = nil
		in.Capacity = nil
		in.WaitlistEnabled = false
	}
	if in.EventType != EventAppointmentRegistration {
		in.Capacity = nil
		in.WaitlistEnabled = false
	}
	if in.WaitlistEnabled && in.Capacity == nil {
		return domain.ValidationError{Field: "waitlistEnabled", Message: "requires capacity"}
	}
	if err := validateOptionalInt("capacity", in.Capacity, 1, 100000); err != nil {
		return err
	}
	if err := validateOptionalInt("responseDeadlineMinutesBefore", in.ResponseDeadlineMinutesBefore, 0, 525600); err != nil {
		return err
	}
	return nil
}

func normalizeEventSchedule(in *EventInput) error {
	in.TimeZone = strings.TrimSpace(in.TimeZone)
	in.StartDate = strings.TrimSpace(in.StartDate)
	in.EndDateExclusive = strings.TrimSpace(in.EndDateExclusive)
	if in.AllDay {
		return normalizeAllDayEventSchedule(in)
	}
	if in.StartDate != "" || in.EndDateExclusive != "" {
		return domain.ValidationError{Field: "allDay", Message: "must be true when calendar-date fields are provided"}
	}
	if _, err := time.LoadLocation(in.TimeZone); err != nil || in.TimeZone == "" {
		return domain.ValidationError{Field: "timeZone", Message: "must be a valid pinned IANA time zone"}
	}
	start, err := time.Parse(time.RFC3339, in.StartsAt)
	if err != nil {
		return domain.ValidationError{Field: "startsAt", Message: "must be RFC 3339"}
	}
	in.StartsAt = platform.Timestamp(start)
	if in.EndsAt != nil {
		end, err := time.Parse(time.RFC3339, *in.EndsAt)
		if err != nil || !end.After(start) {
			return domain.ValidationError{Field: "endsAt", Message: "must be after startsAt"}
		}
		value := platform.Timestamp(end)
		in.EndsAt = &value
	}
	return nil
}

func normalizeAllDayEventSchedule(in *EventInput) error {
	if strings.TrimSpace(in.StartsAt) != "" {
		return domain.ValidationError{Field: "startsAt", Message: "must be omitted for an all-day event"}
	}
	if in.EndsAt != nil {
		return domain.ValidationError{Field: "endsAt", Message: "must be omitted for an all-day event"}
	}
	location, err := time.LoadLocation(in.TimeZone)
	if err != nil || in.TimeZone == "" {
		return domain.ValidationError{Field: "timeZone", Message: "must be a valid IANA time zone"}
	}
	startDate, err := parseCalendarDate("startDate", in.StartDate)
	if err != nil {
		return err
	}
	endDate, err := parseCalendarDate("endDateExclusive", in.EndDateExclusive)
	if err != nil {
		return err
	}
	durationDays := civilDayIndex(endDate) - civilDayIndex(startDate)
	if durationDays < 1 || durationDays > 366 {
		return domain.ValidationError{Field: "endDateExclusive", Message: "must be 1 to 366 calendar days after startDate"}
	}
	startBoundary, err := calendarDateBoundary("startDate", startDate, location)
	if err != nil {
		return err
	}
	endBoundary, err := calendarDateBoundary("endDateExclusive", endDate, location)
	if err != nil {
		return err
	}
	in.StartDate = startDate.Format(time.DateOnly)
	in.EndDateExclusive = endDate.Format(time.DateOnly)
	in.StartsAt = platform.Timestamp(startBoundary)
	endsAt := platform.Timestamp(endBoundary)
	in.EndsAt = &endsAt
	return nil
}

func parseCalendarDate(field, value string) (time.Time, error) {
	parsed, err := time.Parse(time.DateOnly, value)
	if err != nil || parsed.Format(time.DateOnly) != value {
		return time.Time{}, domain.ValidationError{Field: field, Message: "must be an ISO calendar date"}
	}
	return parsed, nil
}

func calendarDateBoundary(field string, date time.Time, location *time.Location) (time.Time, error) {
	boundary := resolveLocalTime(location, date.Year(), date.Month(), date.Day(), 0, 0, 0, 0)
	local := boundary.In(location)
	if local.Year() != date.Year() || local.Month() != date.Month() || local.Day() != date.Day() {
		return time.Time{}, domain.ValidationError{Field: field, Message: "does not exist in the selected time zone"}
	}
	return boundary, nil
}

func planningGroupTimeZone(ctx context.Context, queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, groupID, requested string) (string, error) {
	var pinned string
	if err := queryer.QueryRowContext(ctx, `SELECT timezone FROM group_notification_settings WHERE group_id=?`, groupID).Scan(&pinned); err != nil {
		return "", err
	}
	pinned = strings.TrimSpace(pinned)
	if _, err := time.LoadLocation(pinned); err != nil {
		return "", domain.ValidationError{Field: "timeZone", Message: "the group time zone is invalid"}
	}
	requested = strings.TrimSpace(requested)
	if requested != "" && requested != pinned {
		return "", domain.ValidationError{Field: "timeZone", Message: "must match the group time zone"}
	}
	return pinned, nil
}

func responseDeadline(startsAt string, minutesBefore *int) *string {
	if minutesBefore == nil {
		return nil
	}
	deadline := mustTime(startsAt).Add(-time.Duration(*minutesBefore) * time.Minute)
	value := platform.Timestamp(deadline)
	return &value
}

// CreateEvent validates, publishes, and snapshots the audience of a planning
// event atomically.
//
// a and m identify the actor and tenant, idempotencyKey makes retries durable,
// and in supplies content, schedule, and audience. The method returns the
// published event or a validation, authorization, idempotency, or storage
// error.
//
// Example: event, err := service.CreateEvent(ctx, actor, membership, key, input).
func (s Service) CreateEvent(ctx context.Context, a domain.Principal, m domain.Membership, idempotencyKey string, in EventInput) (Event, error) {
	if err := idempotency.ValidateKey(idempotencyKey); err != nil {
		return Event{}, err
	}
	requestedTimeZone := strings.TrimSpace(in.TimeZone)
	if !in.AllDay && requestedTimeZone != "" {
		return Event{}, domain.ValidationError{Field: "timeZone", Message: "must be omitted for a timed event"}
	}
	pinned, err := planningGroupTimeZone(ctx, s.DB, m.GroupID, requestedTimeZone)
	if err != nil {
		return Event{}, err
	}
	in.TimeZone = pinned
	if err := normalizeEvent(&in); err != nil {
		return Event{}, err
	}
	hashInput := in
	hashInput.TimeZone = requestedTimeZone
	if hashInput.AllDay {
		hashInput.StartsAt = ""
		hashInput.EndsAt = nil
	}
	id, err := platform.NewID("pev")
	if err != nil {
		return Event{}, err
	}
	requestHash, err := idempotency.Hash(hashInput)
	if err != nil {
		return Event{}, err
	}
	now := platform.Timestamp(platform.Now())
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := enabled(ctx, tx, m.GroupID); err != nil {
			return err
		}
		if err := require(ctx, tx, m, domain.PermissionCreatePlanningEvents); err != nil {
			return err
		}
		var replay struct {
			ID string `json:"id"`
		}
		found, err := idempotency.Load(ctx, tx, m.GroupID, a.UserID, idempotencyKey, requestHash, &replay)
		if err != nil {
			return err
		}
		if found {
			id = replay.ID
			return nil
		}
		deadline := responseDeadline(in.StartsAt, in.ResponseDeadlineMinutesBefore)
		_, err = tx.ExecContext(ctx, `INSERT INTO planning_events(id,group_id,title,description,location,event_type,status,audience_type,all_day,timezone,start_date,end_date_exclusive,starts_at,ends_at,response_deadline,response_deadline_minutes_before,capacity,waitlist_enabled,created_by_membership_id,updated_by_membership_id,published_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'PUBLISHED',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, m.GroupID, in.Title, in.Description, in.Location, in.EventType, in.AudienceType, in.AllDay, nullableText(in.TimeZone), nullableText(in.StartDate), nullableText(in.EndDateExclusive), in.StartsAt, in.EndsAt, deadline, in.ResponseDeadlineMinutesBefore, in.Capacity, in.WaitlistEnabled, m.ID, m.ID, now, now, now)
		if err != nil {
			return err
		}
		if err := replaceEventTargets(ctx, tx, m.GroupID, id, in.AudienceType, in.TargetRoleIDs, in.TargetMembershipIDs); err != nil {
			return err
		}
		if err := addAudience(ctx, tx, m.GroupID, id, in.AudienceType, in.TargetRoleIDs, in.TargetMembershipIDs, 1); err != nil {
			return err
		}
		var audienceCount int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM planning_event_audience WHERE event_id=?`, id).Scan(&audienceCount); err != nil {
			return err
		}
		if audienceCount == 0 {
			return domain.ValidationError{Field: "audience", Message: "must contain at least one active member"}
		}
		if err := audit.Record(ctx, tx, m.GroupID, a.UserID, m.ID, "planning.event.created", "planning_event", id, map[string]any{"eventType": in.EventType, "allDay": in.AllDay}); err != nil {
			return err
		}
		return idempotency.Store(ctx, tx, m.GroupID, a.UserID, idempotencyKey, requestHash, 201, map[string]any{"id": id})
	})
	if err != nil {
		return Event{}, err
	}
	return s.GetEvent(ctx, m, id)
}

func replaceEventTargets(ctx context.Context, tx *sql.Tx, g, id, kind string, roles, members []string) error {
	_, _ = tx.ExecContext(ctx, `DELETE FROM planning_event_target_roles WHERE group_id=? AND event_id=?`, g, id)
	_, _ = tx.ExecContext(ctx, `DELETE FROM planning_event_target_memberships WHERE group_id=? AND event_id=?`, g, id)
	if kind == AudienceSelectedTargets && len(roles)+len(members) == 0 {
		return domain.ValidationError{Field: "audience", Message: "must include at least one role or membership"}
	}
	if kind == AudienceSelectedRoles || kind == AudienceSelectedTargets {
		if len(roles) == 0 {
			if kind == AudienceSelectedRoles {
				return domain.ValidationError{Field: "targetRoleIds", Message: "must not be empty"}
			}
		} else {
			for _, v := range roles {
				if _, err := tx.ExecContext(ctx, `INSERT INTO planning_event_target_roles(group_id,event_id,role_id) VALUES(?,?,?)`, g, id, v); err != nil {
					return domain.ValidationError{Field: "targetRoleIds", Message: "contains an invalid role"}
				}
			}
		}
	}
	if kind == AudienceSelectedMembers || kind == AudienceSelectedTargets {
		if len(members) == 0 {
			if kind == AudienceSelectedMembers {
				return domain.ValidationError{Field: "targetMembershipIds", Message: "must not be empty"}
			}
		} else {
			for _, v := range members {
				if _, err := tx.ExecContext(ctx, `INSERT INTO planning_event_target_memberships(group_id,event_id,membership_id) VALUES(?,?,?)`, g, id, v); err != nil {
					return domain.ValidationError{Field: "targetMembershipIds", Message: "contains an invalid membership"}
				}
			}
		}
	}
	return nil
}

// ListEvents returns one keyset-paginated page of events visible to m, ordered
// by start time and ID. from and to are optional RFC 3339 bounds, status is an
// optional lifecycle filter, cursor is the previous page token, and limit is
// normalized to the supported page size.
//
// A bounded future query materializes only the requesting group through to.
// The method returns the page, an empty or next cursor, and a validation,
// authorization, planning-disabled, or storage error.
//
// Example: events, next, err := service.ListEvents(ctx, membership, from, to, "PUBLISHED", cursor, 100).
func (s Service) ListEvents(ctx context.Context, m domain.Membership, from, to, status, cursor string, limit int) ([]Event, string, error) {
	return s.ListEventsWithQuery(ctx, m, EventListQuery{
		From: from, To: to, Status: status, Cursor: cursor, Limit: limit,
	})
}

// ListEventsWithQuery returns one permission-filtered, keyset-paginated page
// ordered by the exact start instant and ID. The opaque cursor is bound to the
// tenant, membership, normalized bounds, and status and is rejected when
// reused with another calendar query. Each complete instant or civil-date
// window is limited to 366 days. A bounded query materializes only relevant
// occurrences for the requesting group, including distant recurrence windows.
//
// It returns the visible events and an empty or opaque next cursor, or a
// validation, authorization, planning-disabled, or storage error.
//
// Example: events, next, err := service.ListEventsWithQuery(ctx, membership,
// planning.EventListQuery{FromDate: "2026-09-01", ToDateExclusive: "2026-10-01"}).
func (s Service) ListEventsWithQuery(ctx context.Context, m domain.Membership, input EventListQuery) ([]Event, string, error) {
	if err := enabled(ctx, s.DB, m.GroupID); err != nil {
		return nil, "", err
	}
	if err := require(ctx, s.DB, m, domain.PermissionUsePlanning); err != nil {
		return nil, "", err
	}
	if input.Limit < 1 || input.Limit > 200 {
		input.Limit = 100
	}
	var fromTime, toTime time.Time
	input.From = strings.TrimSpace(input.From)
	input.To = strings.TrimSpace(input.To)
	if input.From != "" {
		parsed, err := time.Parse(time.RFC3339, input.From)
		if err != nil {
			return nil, "", domain.ValidationError{Field: "from", Message: "must be RFC 3339"}
		}
		fromTime = parsed.UTC()
		input.From = platform.Timestamp(parsed)
	}
	if input.To != "" {
		parsed, err := time.Parse(time.RFC3339, input.To)
		if err != nil {
			return nil, "", domain.ValidationError{Field: "to", Message: "must be RFC 3339"}
		}
		toTime = parsed.UTC()
		input.To = platform.Timestamp(parsed)
	}
	if !fromTime.IsZero() && !toTime.IsZero() && !fromTime.Before(toTime) {
		return nil, "", domain.ValidationError{Field: "to", Message: "must be after from"}
	}
	if !fromTime.IsZero() && !toTime.IsZero() && toTime.Sub(fromTime) > maximumCalendarQueryWindow {
		return nil, "", domain.ValidationError{Field: "to", Message: "calendar queries are limited to 366 days"}
	}
	input.FromDate = strings.TrimSpace(input.FromDate)
	input.ToDateExclusive = strings.TrimSpace(input.ToDateExclusive)
	if (input.FromDate == "") != (input.ToDateExclusive == "") {
		field := "toDateExclusive"
		if input.FromDate == "" {
			field = "fromDate"
		}
		return nil, "", domain.ValidationError{Field: field, Message: "must be provided with the other civil-date bound"}
	}
	var fromDate, toDate time.Time
	if input.FromDate != "" {
		var err error
		fromDate, err = parseCalendarDate("fromDate", input.FromDate)
		if err != nil {
			return nil, "", err
		}
		toDate, err = parseCalendarDate("toDateExclusive", input.ToDateExclusive)
		if err != nil {
			return nil, "", err
		}
		civilDays := civilDayIndex(toDate) - civilDayIndex(fromDate)
		if civilDays < 1 {
			return nil, "", domain.ValidationError{Field: "toDateExclusive", Message: "must be after fromDate"}
		}
		if civilDays > int(maximumCalendarQueryWindow/(24*time.Hour)) {
			return nil, "", domain.ValidationError{Field: "toDateExclusive", Message: "calendar queries are limited to 366 days"}
		}
		input.FromDate = fromDate.Format(time.DateOnly)
		input.ToDateExclusive = toDate.Format(time.DateOnly)
	}
	input.Status = strings.ToUpper(strings.TrimSpace(input.Status))
	if input.Status != "" && !validEventStatus(input.Status) {
		return nil, "", domain.ValidationError{Field: "status", Message: "is unsupported"}
	}
	if !toTime.IsZero() || !toDate.IsZero() {
		if _, err := s.materializeGroupSeriesWindow(ctx, m.GroupID, fromTime, toTime, fromDate, toDate); err != nil {
			return nil, "", err
		}
	}
	permissions, err := currentPlanningPermissions(ctx, s.DB, m)
	if err != nil {
		return nil, "", err
	}
	fingerprint, err := tablequery.Fingerprint(struct {
		GroupID, MembershipID, From, To, FromDate, ToDateExclusive, Status string
		Manage                                                             bool
	}{m.GroupID, m.ID, input.From, input.To, input.FromDate, input.ToDateExclusive, input.Status, permissions.Manage})
	if err != nil {
		return nil, "", err
	}
	query := `SELECT ` + eventProjectionColumns + ` FROM planning_events event WHERE event.group_id=?
		AND (event.created_by_membership_id=? OR ?=1 OR EXISTS(
			SELECT 1 FROM planning_event_audience audience WHERE audience.event_id=event.id AND audience.membership_id=?))`
	args := []any{m.ID, m.GroupID, m.ID, permissions.Manage, m.ID}
	hasTimes := !fromTime.IsZero() || !toTime.IsZero()
	hasDates := !fromDate.IsZero()
	if hasTimes && hasDates {
		query += ` AND ((event.all_day=1 AND event.end_date_exclusive>? AND event.start_date<?) OR
			(event.all_day=0`
		args = append(args, input.FromDate, input.ToDateExclusive)
		query, args = appendNumericOverlap(query, args, fromTime, toTime)
		query += `))`
	} else if hasDates {
		query += ` AND event.all_day=1 AND event.end_date_exclusive>? AND event.start_date<?`
		args = append(args, input.FromDate, input.ToDateExclusive)
	} else if hasTimes {
		query, args = appendNumericOverlap(query, args, fromTime, toTime)
	}
	if input.Status != "" {
		query += ` AND event.status=?`
		args = append(args, input.Status)
	}
	if input.Cursor != "" {
		cursorStart, cursorID, err := tablequery.DecodeCursor(input.Cursor, fingerprint, "startsAt", "asc")
		if err != nil {
			return nil, "", err
		}
		startMicros, err := strconv.ParseInt(cursorStart, 10, 64)
		if err != nil {
			return nil, "", domain.ValidationError{Field: "cursor", Message: "is invalid or does not match the current query"}
		}
		query += ` AND (event.starts_at_us>? OR (event.starts_at_us=? AND event.id>?))`
		args = append(args, startMicros, startMicros, cursorID)
	}
	query += ` ORDER BY event.starts_at_us,event.id LIMIT ?`
	args = append(args, input.Limit+1)
	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, "", err
	}
	projections, err := collectEventProjections(rows)
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(projections) > input.Limit {
		last := projections[input.Limit-1]
		next, err = tablequery.EncodeCursor(fingerprint, "startsAt", "asc", strconv.FormatInt(last.startMicros, 10), last.ID)
		if err != nil {
			return nil, "", err
		}
		projections = projections[:input.Limit]
	}
	out, err := hydrateEventProjections(ctx, s.DB, m, permissions, projections)
	if err != nil {
		return nil, "", err
	}
	return out, next, nil
}

func appendNumericOverlap(query string, args []any, from, to time.Time) (string, []any) {
	if !from.IsZero() {
		fromMicros := from.UnixMicro()
		query += ` AND ((event.ends_at_us IS NOT NULL AND event.ends_at_us>?) OR (event.ends_at_us IS NULL AND event.starts_at_us>=?))`
		args = append(args, fromMicros, fromMicros)
	}
	if !to.IsZero() {
		query += ` AND event.starts_at_us<?`
		args = append(args, to.UnixMicro())
	}
	return query, args
}

// GetEvent returns a permission-aware event projection for id, including
// aggregate counts and the requesting membership's response.
//
// m supplies the tenant and visibility subject. Invisible and unknown events
// both return domain.ErrNotFound; authorization, planning-disabled, and storage
// errors may also be returned.
//
// Example: event, err := service.GetEvent(ctx, membership, eventID).
func (s Service) GetEvent(ctx context.Context, m domain.Membership, id string) (Event, error) {
	if err := enabled(ctx, s.DB, m.GroupID); err != nil {
		return Event{}, err
	}
	if err := require(ctx, s.DB, m, domain.PermissionUsePlanning); err != nil {
		return Event{}, err
	}
	permissions, err := currentPlanningPermissions(ctx, s.DB, m)
	if err != nil {
		return Event{}, err
	}
	projection, err := scanEventProjection(s.DB.QueryRowContext(ctx, `SELECT `+eventProjectionColumns+`
		FROM planning_events event WHERE event.group_id=? AND event.id=?`, m.ID, m.GroupID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Event{}, domain.ErrNotFound
	}
	if err != nil {
		return Event{}, err
	}
	if !visibleEventProjection(projection, m, permissions) {
		return Event{}, domain.ErrNotFound
	}
	events, err := hydrateEventProjections(ctx, s.DB, m, permissions, []eventProjection{projection})
	if err != nil {
		return Event{}, err
	}
	return events[0], nil
}

func stringsFor(rows *sql.Rows, err error) ([]string, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// UpdateEvent replaces editable fields on one event under optimistic
// concurrency. Existing participation remains effective after every edit;
// editing a series occurrence marks that occurrence as a manual exception.
//
// a and m identify the actor and tenant, id selects the event, in is the full
// replacement input, and version must match the stored event version. The
// method returns the updated projection or a validation, authorization,
// not-found, conflict, precondition, or storage error.
//
// Example: event, err := service.UpdateEvent(ctx, actor, membership, eventID, input, version).
func (s Service) UpdateEvent(ctx context.Context, a domain.Principal, m domain.Membership, id string, in EventInput, version int64) (Event, error) {
	requestedTimeZone := strings.TrimSpace(in.TimeZone)
	if !in.AllDay && requestedTimeZone != "" {
		return Event{}, domain.ValidationError{Field: "timeZone", Message: "must be omitted for a timed event"}
	}
	var pinned string
	err := s.DB.QueryRowContext(ctx, `SELECT timezone FROM planning_events WHERE group_id=? AND id=?`, m.GroupID, id).Scan(&pinned)
	if errors.Is(err, sql.ErrNoRows) {
		return Event{}, domain.ErrNotFound
	}
	if err != nil {
		return Event{}, err
	}
	if _, err := time.LoadLocation(pinned); err != nil || pinned == "" {
		return Event{}, domain.ValidationError{Field: "timeZone", Message: "the event time zone is invalid"}
	}
	if requestedTimeZone != "" && requestedTimeZone != pinned {
		return Event{}, domain.ValidationError{Field: "timeZone", Message: "must match the event time zone"}
	}
	in.TimeZone = pinned
	if err := normalizeEvent(&in); err != nil {
		return Event{}, err
	}
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := enabled(ctx, tx, m.GroupID); err != nil {
			return err
		}
		var owner, status, oldStart, oldType, oldAudience string
		var oldEndsAt, oldTimeZone, oldStartDate, oldEndDateExclusive, seriesID, originalStartAt, oldOriginalStartDate sql.NullString
		var oldAllDay bool
		var currentVersion int64
		if err := tx.QueryRowContext(ctx, `SELECT created_by_membership_id,status,starts_at,ends_at,event_type,audience_type,all_day,timezone,start_date,end_date_exclusive,series_id,original_start_at,original_start_date,version FROM planning_events WHERE group_id=? AND id=?`, m.GroupID, id).Scan(&owner, &status, &oldStart, &oldEndsAt, &oldType, &oldAudience, &oldAllDay, &oldTimeZone, &oldStartDate, &oldEndDateExclusive, &seriesID, &originalStartAt, &oldOriginalStartDate, &currentVersion); err != nil {
			return domain.ErrNotFound
		}
		if err := requireEventMutation(ctx, tx, m, owner); err != nil {
			return err
		}
		if currentVersion != version {
			return domain.ErrPrecondition
		}
		if status != "PUBLISHED" {
			return domain.ErrConflict
		}
		if in.EventType != oldType {
			return domain.ValidationError{Field: "eventType", Message: "is immutable after publication"}
		}
		if !publishedAudienceCompatible(oldAudience, in.AudienceType) {
			return domain.ValidationError{Field: "audienceType", Message: "cannot replace the published audience"}
		}
		var addedRoleIDs, addedMembershipIDs []string
		addedRoleIDs, addedMembershipIDs, err = publishedTargetAdditions(ctx, tx, id, in.AudienceType, in.TargetRoleIDs, in.TargetMembershipIDs)
		if err != nil {
			return err
		}
		timingChanged := oldStart != in.StartsAt || nullableStringChanged(oldEndsAt, in.EndsAt) || oldAllDay != in.AllDay || nullableTextChanged(oldTimeZone, in.TimeZone) || nullableTextChanged(oldStartDate, in.StartDate) || nullableTextChanged(oldEndDateExclusive, in.EndDateExclusive)
		deadline := responseDeadline(in.StartsAt, in.ResponseDeadlineMinutesBefore)
		if timingChanged && deadline != nil && !mustTime(*deadline).After(platform.Now()) {
			return domain.ValidationError{Field: "responseDeadlineMinutesBefore", Message: "must produce a future deadline when the start changes"}
		}
		if err := validateRegistrationStateChange(ctx, tx, id, in.Capacity, in.WaitlistEnabled); err != nil {
			return err
		}
		var originalStartDate any
		if seriesID.Valid && in.AllDay {
			value := oldOriginalStartDate.String
			if value == "" {
				location, loadErr := time.LoadLocation(in.TimeZone)
				if loadErr != nil || !originalStartAt.Valid {
					return domain.ValidationError{Field: "timeZone", Message: "cannot derive the original series date"}
				}
				value = mustTime(originalStartAt.String).In(location).Format(time.DateOnly)
			}
			originalStartDate = value
		}
		r, err := tx.ExecContext(ctx, `UPDATE planning_events SET title=?,description=?,location=?,event_type=?,audience_type=?,all_day=?,timezone=?,start_date=?,end_date_exclusive=?,original_start_date=?,starts_at=?,ends_at=?,response_deadline=?,response_deadline_minutes_before=?,capacity=?,waitlist_enabled=?,is_series_exception=CASE WHEN series_id IS NULL THEN 0 ELSE 1 END,version=version+1,updated_by_membership_id=?,updated_at=? WHERE group_id=? AND id=? AND version=?`, in.Title, in.Description, in.Location, in.EventType, in.AudienceType, in.AllDay, nullableText(in.TimeZone), nullableText(in.StartDate), nullableText(in.EndDateExclusive), originalStartDate, in.StartsAt, in.EndsAt, deadline, in.ResponseDeadlineMinutesBefore, in.Capacity, in.WaitlistEnabled, m.ID, platform.Timestamp(platform.Now()), m.GroupID, id, version)
		if err != nil {
			return err
		}
		n, _ := r.RowsAffected()
		if n != 1 {
			return domain.ErrPrecondition
		}
		now := platform.Timestamp(platform.Now())
		_, _ = tx.ExecContext(ctx, `UPDATE planning_notification_tasks SET status='CANCELLED',updated_at=? WHERE event_id=? AND status='PENDING' AND event_type!='PLANNING_WAITLIST_PROMOTED'`, now, id)
		_, _ = tx.ExecContext(ctx, `UPDATE planning_notification_tasks SET event_revision=?,updated_at=? WHERE event_id=? AND status='PENDING' AND event_type='PLANNING_WAITLIST_PROMOTED'`, version+1, now, id)
		if err := tasksForAudience(ctx, tx, m.GroupID, id, "PLANNING_EVENT_UPDATED", now, version+1); err != nil {
			return err
		}
		if err := addEventTargets(ctx, tx, m.GroupID, id, in.AudienceType, addedRoleIDs, addedMembershipIDs); err != nil {
			return err
		}
		if len(addedRoleIDs) > 0 || len(addedMembershipIDs) > 0 {
			if err := addAudience(ctx, tx, m.GroupID, id, in.AudienceType, addedRoleIDs, addedMembershipIDs, version+1); err != nil {
				return err
			}
		}
		return audit.Record(ctx, tx, m.GroupID, a.UserID, m.ID, "planning.event.updated", "planning_event", id, map[string]any{"timingChanged": timingChanged})
	})
	if err != nil {
		return Event{}, err
	}
	return s.GetEvent(ctx, m, id)
}

func nullableText(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullableTextChanged(previous sql.NullString, current string) bool {
	return previous.Valid != (current != "") || previous.Valid && previous.String != current
}

func nullableStringChanged(previous sql.NullString, current *string) bool {
	return previous.Valid != (current != nil) || previous.Valid && previous.String != *current
}

func validateRegistrationStateChange(ctx context.Context, tx *sql.Tx, eventID string, capacity *int, waitlistEnabled bool) error {
	var registered, waitlisted int
	if err := tx.QueryRowContext(ctx, `SELECT coalesce(sum(status='REGISTERED'),0),coalesce(sum(status='WAITLISTED'),0) FROM planning_participations WHERE event_id=?`, eventID).Scan(&registered, &waitlisted); err != nil {
		return err
	}
	if capacity != nil && *capacity < registered {
		return domain.ValidationError{Field: "capacity", Message: "cannot be below the registered participant count"}
	}
	if !waitlistEnabled && waitlisted > 0 {
		return domain.ValidationError{Field: "waitlistEnabled", Message: "cannot be disabled while participants are waitlisted"}
	}
	return nil
}

func publishedAudienceCompatible(previous, requested string) bool {
	if previous == requested {
		return true
	}
	return requested == AudienceSelectedTargets && (previous == AudienceSelectedRoles || previous == AudienceSelectedMembers)
}

func publishedTargetAdditions(ctx context.Context, tx *sql.Tx, eventID, audienceType string, requestedRoleIDs, requestedMembershipIDs []string) ([]string, []string, error) {
	switch audienceType {
	case AudienceSelectedRoles:
		existing, err := stringsFor(tx.QueryContext(ctx, `SELECT role_id FROM planning_event_target_roles WHERE event_id=?`, eventID))
		if err != nil {
			return nil, nil, err
		}
		added, err := addOnlyTargetDelta(existing, requestedRoleIDs, "targetRoleIds")
		return added, nil, err
	case AudienceSelectedMembers:
		existing, err := stringsFor(tx.QueryContext(ctx, `SELECT membership_id FROM planning_event_target_memberships WHERE event_id=?`, eventID))
		if err != nil {
			return nil, nil, err
		}
		added, err := addOnlyTargetDelta(existing, requestedMembershipIDs, "targetMembershipIds")
		return nil, added, err
	case AudienceSelectedTargets:
		existingRoles, err := stringsFor(tx.QueryContext(ctx, `SELECT role_id FROM planning_event_target_roles WHERE event_id=?`, eventID))
		if err != nil {
			return nil, nil, err
		}
		existingMembers, err := stringsFor(tx.QueryContext(ctx, `SELECT membership_id FROM planning_event_target_memberships WHERE event_id=?`, eventID))
		if err != nil {
			return nil, nil, err
		}
		addedRoles, err := addOnlyTargetDelta(existingRoles, requestedRoleIDs, "targetRoleIds")
		if err != nil {
			return nil, nil, err
		}
		addedMembers, err := addOnlyTargetDelta(existingMembers, requestedMembershipIDs, "targetMembershipIds")
		return addedRoles, addedMembers, err
	default:
		return nil, nil, nil
	}
}

func addOnlyTargetDelta(existing, requested []string, field string) ([]string, error) {
	existingSet := make(map[string]struct{}, len(existing))
	requestedSet := make(map[string]struct{}, len(requested))
	for _, id := range existing {
		existingSet[id] = struct{}{}
	}
	for _, id := range requested {
		requestedSet[id] = struct{}{}
	}
	for _, id := range existing {
		if _, retained := requestedSet[id]; !retained {
			return nil, domain.ValidationError{Field: field, Message: "cannot remove existing targets after publication"}
		}
	}
	added := make([]string, 0, len(requestedSet))
	for _, id := range requested {
		if _, existed := existingSet[id]; existed {
			continue
		}
		existingSet[id] = struct{}{}
		added = append(added, id)
	}
	return added, nil
}

// addEventTargets persists published-event audience extensions without removing
// any previously selected role or membership.
func addEventTargets(ctx context.Context, tx *sql.Tx, groupID, eventID, audienceType string, roleIDs, membershipIDs []string) error {
	if audienceType == AudienceSelectedRoles || audienceType == AudienceSelectedTargets {
		for _, roleID := range roleIDs {
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO planning_event_target_roles(group_id,event_id,role_id) VALUES(?,?,?)`, groupID, eventID, roleID); err != nil {
				return domain.ValidationError{Field: "targetRoleIds", Message: "contains an invalid role"}
			}
		}
	}
	if audienceType == AudienceSelectedMembers || audienceType == AudienceSelectedTargets {
		for _, membershipID := range membershipIDs {
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO planning_event_target_memberships(group_id,event_id,membership_id) VALUES(?,?,?)`, groupID, eventID, membershipID); err != nil {
				return domain.ValidationError{Field: "targetMembershipIds", Message: "contains an invalid membership"}
			}
		}
	}
	return nil
}

func value(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}
func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func addAudience(ctx context.Context, tx *sql.Tx, g, id, kind string, roles, members []string, eventVersion int64) error {
	return addAudienceWithNotification(ctx, tx, g, id, kind, roles, members, eventVersion, true)
}

func addAudienceWithNotification(ctx context.Context, tx *sql.Tx, g, id, kind string, roles, members []string, eventVersion int64, notify bool) error {
	now := platform.Timestamp(platform.Now())
	filter, args := audienceCandidateFilter(g, kind, roles, members)
	rows, err := tx.QueryContext(ctx, `SELECT m.id,u.display_name`+filter, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var mid, name string
		if err := rows.Scan(&mid, &name); err != nil {
			return err
		}
		r, err := tx.ExecContext(ctx, `INSERT INTO planning_event_audience(group_id,event_id,membership_id,display_name_snapshot,invited_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`, g, id, mid, name, now)
		if err != nil {
			return err
		}
		n, _ := r.RowsAffected()
		if n == 1 && notify {
			if err := insertTask(ctx, tx, g, id, mid, "PLANNING_EVENT_PUBLISHED", now, eventVersion); err != nil {
				return err
			}
		}
	}
	return rows.Err()
}

func audienceCandidateFilter(g, kind string, roles, members []string) (string, []any) {
	query := ` FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.group_id=? AND m.status='ACTIVE' AND m.deleted_at IS NULL AND u.active=1 AND u.email IS NOT NULL AND u.password_hash IS NOT NULL`
	args := []any{g}
	if kind == AudienceSelectedMembers {
		query += ` AND m.id IN (` + marks(len(members)) + `)`
		for _, v := range members {
			args = append(args, v)
		}
	} else if kind == AudienceSelectedRoles {
		query += ` AND EXISTS(SELECT 1 FROM membership_role_assignments a WHERE a.membership_id=m.id AND a.role_id IN (` + marks(len(roles)) + `))`
		for _, v := range roles {
			args = append(args, v)
		}
	} else if kind == AudienceSelectedTargets {
		clauses := make([]string, 0, 2)
		if len(members) > 0 {
			clauses = append(clauses, `m.id IN (`+marks(len(members))+`)`)
			for _, v := range members {
				args = append(args, v)
			}
		}
		if len(roles) > 0 {
			clauses = append(clauses, `EXISTS(SELECT 1 FROM membership_role_assignments a WHERE a.membership_id=m.id AND a.role_id IN (`+marks(len(roles))+`))`)
			for _, v := range roles {
				args = append(args, v)
			}
		}
		query += ` AND (` + strings.Join(clauses, ` OR `) + `)`
	}
	return query, args
}
func marks(n int) string {
	if n < 1 {
		return "NULL"
	}
	return strings.TrimRight(strings.Repeat("?,", n), ",")
}
func insertTask(ctx context.Context, tx *sql.Tx, g, e, m, t, at string, rev int64) error {
	id, err := platform.NewID("pnt")
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO planning_notification_tasks(id,group_id,event_id,target_membership_id,event_type,scheduled_for,event_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id,target_membership_id,event_type,scheduled_for) DO UPDATE SET status='PENDING',event_revision=excluded.event_revision,updated_at=excluded.updated_at WHERE planning_notification_tasks.status IN ('PENDING','CANCELLED')`, id, g, e, m, t, at, rev, at, at)
	return err
}

func tasksForAudience(ctx context.Context, tx *sql.Tx, g, id, eventType, at string, rev int64) error {
	query := `SELECT audience.membership_id FROM planning_event_audience audience JOIN planning_events event ON event.id=audience.event_id WHERE audience.event_id=?`
	if eventType == "PLANNING_EVENT_UPDATED" || eventType == "PLANNING_EVENT_CANCELLED" {
		query += ` AND (event.event_type!='APPOINTMENT_REGISTRATION' OR EXISTS(SELECT 1 FROM planning_participations participation WHERE participation.event_id=audience.event_id AND participation.membership_id=audience.membership_id AND participation.status IN ('REGISTERED','WAITLISTED')))`
	}
	rows, err := tx.QueryContext(ctx, query, id)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var membershipID string
		if err := rows.Scan(&membershipID); err != nil {
			return err
		}
		if err := insertTask(ctx, tx, g, id, membershipID, eventType, at, rev); err != nil {
			return err
		}
	}
	return rows.Err()
}

// Transition moves an event to a supported CLOSED or CANCELLED state under
// optimistic concurrency. Closing reconciles registrations; cancelling a
// series occurrence preserves it as a manual exception.
//
// a and m identify the actor and tenant, id selects the event, target is the
// requested lifecycle state, and version must match the stored event version.
// The method returns the updated projection or a validation, authorization,
// not-found, conflict, precondition, or storage error.
//
// Example: event, err := service.Transition(ctx, actor, membership, eventID, "CANCELLED", version).
func (s Service) Transition(ctx context.Context, a domain.Principal, m domain.Membership, id, target string, version int64) (Event, error) {
	if target != "CLOSED" && target != "COMPLETED" && target != "CANCELLED" {
		return Event{}, domain.ValidationError{Field: "status", Message: "is unsupported"}
	}
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := enabled(ctx, tx, m.GroupID); err != nil {
			return err
		}
		var owner, currentStatus, effectiveEnd string
		if err := tx.QueryRowContext(ctx, `SELECT created_by_membership_id,status,coalesce(ends_at,starts_at) FROM planning_events WHERE group_id=? AND id=? AND version=? AND status IN ('PUBLISHED','CLOSED')`, m.GroupID, id, version).Scan(&owner, &currentStatus, &effectiveEnd); err != nil {
			return domain.ErrPrecondition
		}
		if err := requireEventMutation(ctx, tx, m, owner); err != nil {
			return err
		}
		if target == "CLOSED" && currentStatus != "PUBLISHED" {
			return domain.ErrPrecondition
		}
		if target == "COMPLETED" && currentStatus != "PUBLISHED" && currentStatus != "CLOSED" {
			return domain.ErrPrecondition
		}
		nowValue := platform.Now()
		now := platform.Timestamp(nowValue)
		if target == "CLOSED" {
			changed, err := closePublishedEventTx(ctx, tx, id, closeEventOptions{
				Now: nowValue, GroupID: m.GroupID, ExpectedVersion: &version,
				ActorUserID: a.UserID, ActorMembershipID: m.ID, AuditAction: "planning.event.closed",
			})
			if err != nil {
				return err
			}
			if !changed {
				return domain.ErrPrecondition
			}
			return nil
		}
		if target == "COMPLETED" && mustTime(effectiveEnd).After(nowValue) {
			return domain.ErrConflict
		}
		if target == "CANCELLED" {
			_, _ = tx.ExecContext(ctx, `UPDATE planning_notification_tasks SET status='CANCELLED',updated_at=? WHERE event_id=? AND status='PENDING'`, now, id)
		}
		column := strings.ToLower(target) + "_at"
		r, err := tx.ExecContext(ctx, `UPDATE planning_events SET status=?,`+column+`=?,is_series_exception=CASE WHEN ?='CANCELLED' AND series_id IS NOT NULL THEN 1 ELSE is_series_exception END,version=version+1,updated_at=? WHERE id=? AND version=?`, target, now, target, now, id, version)
		if err != nil {
			return err
		}
		n, _ := r.RowsAffected()
		if n != 1 {
			return domain.ErrPrecondition
		}
		if target == "CANCELLED" {
			if err := tasksForAudience(ctx, tx, m.GroupID, id, "PLANNING_EVENT_CANCELLED", now, version+1); err != nil {
				return err
			}
		}
		return audit.Record(ctx, tx, m.GroupID, a.UserID, m.ID, "planning.event."+strings.ToLower(target), "planning_event", id, map[string]any{})
	})
	if err != nil {
		return Event{}, err
	}
	return s.GetEvent(ctx, m, id)
}

// SetParticipation records the requesting membership's poll response or
// registration for a published event. Registration capacity, waitlist order,
// optional deadlines and the current event revision snapshot are enforced
// atomically.
//
// a and m identify the respondent and tenant, id selects the event, and status
// is an event-type-specific response value. The method returns the effective
// Participation or a validation, authorization, not-found, conflict, or storage
// error.
//
// Example: participation, err := service.SetParticipation(ctx, actor, membership, eventID, "YES").
func (s Service) SetParticipation(ctx context.Context, a domain.Principal, m domain.Membership, id, status string) (Participation, error) {
	var out Participation
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := enabled(ctx, tx, m.GroupID); err != nil {
			return err
		}
		if err := require(ctx, tx, m, domain.PermissionUsePlanning); err != nil {
			return err
		}
		var typ, eventStatus, effectiveEnd string
		var deadline sql.NullString
		var capacity sql.NullInt64
		var wait bool
		var rev int64
		if err := tx.QueryRowContext(ctx, `SELECT event_type,status,response_deadline,capacity,waitlist_enabled,confirmation_revision,coalesce(ends_at,starts_at) FROM planning_events e WHERE group_id=? AND id=? AND EXISTS(SELECT 1 FROM planning_event_audience a WHERE a.event_id=e.id AND a.membership_id=?)`, m.GroupID, id, m.ID).Scan(&typ, &eventStatus, &deadline, &capacity, &wait, &rev, &effectiveEnd); err != nil {
			return domain.ErrNotFound
		}
		if eventStatus != "PUBLISHED" {
			return domain.ErrConflict
		}
		nowValue := platform.Now()
		if !nowValue.Before(mustTime(effectiveEnd)) {
			return domain.ErrConflict
		}
		var previous string
		_ = tx.QueryRowContext(ctx, `SELECT status FROM planning_participations WHERE event_id=? AND membership_id=?`, id, m.ID).Scan(&previous)
		if typ == EventAppointmentPoll {
			if status != "YES" && status != "MAYBE" && status != "NO" {
				return domain.ValidationError{Field: "status", Message: "is invalid for an appointment poll"}
			}
			if deadline.Valid && !nowValue.Before(mustTime(deadline.String)) {
				return domain.ErrConflict
			}
		} else if typ == EventAppointmentRegistration {
			if status != "REGISTERED" && status != "WITHDRAWN" {
				return domain.ValidationError{Field: "status", Message: "is invalid for appointment registration"}
			}
			if status == "REGISTERED" {
				if deadline.Valid && !nowValue.Before(mustTime(deadline.String)) {
					return domain.ErrConflict
				}
				if capacity.Valid {
					var used int64
					_ = tx.QueryRowContext(ctx, `SELECT count(*) FROM planning_participations WHERE event_id=? AND status='REGISTERED'`, id).Scan(&used)
					if used >= capacity.Int64 && previous != "REGISTERED" {
						if !wait {
							return domain.ErrConflict
						}
						status = "WAITLISTED"
					}
				}
			}
		} else {
			return domain.ErrConflict
		}
		now := platform.Timestamp(nowValue)
		var pos any
		if status == "WAITLISTED" {
			var next int64
			if previous == "WAITLISTED" {
				_ = tx.QueryRowContext(ctx, `SELECT waitlist_position FROM planning_participations WHERE event_id=? AND membership_id=?`, id, m.ID).Scan(&next)
			} else {
				_ = tx.QueryRowContext(ctx, `SELECT coalesce(max(waitlist_position),0)+1 FROM planning_participations WHERE event_id=?`, id).Scan(&next)
			}
			pos = next
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO planning_participations(group_id,event_id,membership_id,status,waitlist_position,confirmed_revision,version,responded_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(event_id,membership_id) DO UPDATE SET status=excluded.status,waitlist_position=excluded.waitlist_position,confirmed_revision=excluded.confirmed_revision,version=planning_participations.version+1,responded_at=excluded.responded_at,updated_at=excluded.updated_at`, m.GroupID, id, m.ID, status, pos, rev, now, now)
		if err != nil {
			return err
		}
		if status == "WITHDRAWN" && previous == "REGISTERED" {
			if err := promote(ctx, tx, m.GroupID, id); err != nil {
				return err
			}
		}
		if err := audit.Record(ctx, tx, m.GroupID, a.UserID, m.ID, "planning.participation.updated", "planning_event", id, map[string]any{"status": status}); err != nil {
			return err
		}
		return tx.QueryRowContext(ctx, `SELECT status,status,confirmed_revision,version,responded_at,updated_at FROM planning_participations WHERE event_id=? AND membership_id=?`, id, m.ID).Scan(&out.Status, &out.EffectiveStatus, &out.ConfirmedRevision, &out.Version, &out.RespondedAt, &out.UpdatedAt)
	})
	return out, err
}
func mustTime(v string) time.Time { t, _ := time.Parse(time.RFC3339Nano, v); return t }
func promote(ctx context.Context, tx *sql.Tx, g, id string) error {
	var mid string
	err := tx.QueryRowContext(ctx, `SELECT participation.membership_id FROM planning_participations participation JOIN memberships membership ON membership.id=participation.membership_id AND membership.status='ACTIVE' AND membership.deleted_at IS NULL JOIN users user ON user.id=membership.user_id AND user.active=1 AND user.email IS NOT NULL AND user.password_hash IS NOT NULL WHERE participation.event_id=? AND participation.status='WAITLISTED' ORDER BY participation.waitlist_position,participation.membership_id LIMIT 1`, id).Scan(&mid)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	now := platform.Timestamp(platform.Now())
	_, err = tx.ExecContext(ctx, `UPDATE planning_participations SET status='REGISTERED',waitlist_position=NULL,version=version+1,updated_at=? WHERE event_id=? AND membership_id=?`, now, id, mid)
	if err == nil {
		var rev int64
		_ = tx.QueryRowContext(ctx, `SELECT version FROM planning_events WHERE id=?`, id).Scan(&rev)
		err = insertTask(ctx, tx, g, id, mid, "PLANNING_WAITLIST_PROMOTED", now, rev)
	}
	return err
}

// Participants returns one keyset-paginated page of identified audience
// members and their effective responses. Event owners and memberships with the
// participant-view permission may call it.
//
// m supplies the tenant and authorization subject, id selects the event,
// cursor is the previous membership token, and limit is normalized to the
// supported page size. The method returns the page, an empty or next cursor,
// and a validation, authorization, not-found, planning-disabled, or storage
// error.
//
// Example: participants, next, err := service.Participants(ctx, membership, eventID, cursor, 100).
func (s Service) Participants(ctx context.Context, m domain.Membership, id, cursor string, limit int) ([]Participation, string, error) {
	if err := enabled(ctx, s.DB, m.GroupID); err != nil {
		return nil, "", err
	}
	if err := require(ctx, s.DB, m, domain.PermissionUsePlanning); err != nil {
		return nil, "", err
	}
	if limit < 1 || limit > 200 {
		limit = 100
	}
	var owner string
	if err := s.DB.QueryRowContext(ctx, `SELECT created_by_membership_id FROM planning_events WHERE group_id=? AND id=?`, m.GroupID, id).Scan(&owner); err != nil {
		return nil, "", domain.ErrNotFound
	}
	if owner != m.ID {
		if err := require(ctx, s.DB, m, domain.PermissionViewPlanningParticipants); err != nil {
			return nil, "", err
		}
	}
	query := `SELECT a.membership_id,a.display_name_snapshot,coalesce(p.status,''),coalesce(p.confirmed_revision,0),coalesce(p.version,0),coalesce(p.responded_at,''),coalesce(p.updated_at,'') FROM planning_event_audience a LEFT JOIN planning_participations p ON p.event_id=a.event_id AND p.membership_id=a.membership_id WHERE a.group_id=? AND a.event_id=?`
	args := []any{m.GroupID, id}
	if cursor != "" {
		var cursorName string
		if err := s.DB.QueryRowContext(ctx, `SELECT lower(display_name_snapshot) FROM planning_event_audience WHERE group_id=? AND event_id=? AND membership_id=?`, m.GroupID, id, cursor).Scan(&cursorName); errors.Is(err, sql.ErrNoRows) {
			return nil, "", domain.ValidationError{Field: "cursor", Message: "is invalid"}
		} else if err != nil {
			return nil, "", err
		}
		query += ` AND (lower(a.display_name_snapshot)>? OR (lower(a.display_name_snapshot)=? AND a.membership_id>?))`
		args = append(args, cursorName, cursorName, cursor)
	}
	query += ` ORDER BY lower(a.display_name_snapshot),a.membership_id LIMIT ?`
	args = append(args, limit+1)
	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	var out []Participation
	for rows.Next() {
		var p Participation
		if err := rows.Scan(&p.MembershipID, &p.DisplayName, &p.Status, &p.ConfirmedRevision, &p.Version, &p.RespondedAt, &p.UpdatedAt); err != nil {
			return nil, "", err
		}
		p.EffectiveStatus = p.Status
		if p.Status == "" {
			p.EffectiveStatus = "PENDING"
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	next := ""
	if len(out) > limit {
		next = out[limit-1].MembershipID
		out = out[:limit]
	}
	return out, next, nil
}
