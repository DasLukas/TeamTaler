package planning

import (
	"context"
	"database/sql"

	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

const eventProjectionColumns = `event.id,event.series_id,event.original_start_at,event.original_start_date,event.is_series_exception,event.title,event.description,event.location,event.event_type,event.status,
	event.audience_type,event.all_day,event.timezone,coalesce(event.start_date,''),coalesce(event.end_date_exclusive,''),event.starts_at,event.ends_at,event.response_deadline,event.response_deadline_minutes_before,event.capacity,event.waitlist_enabled,
	event.confirmation_revision,event.version,event.created_at,event.updated_at,
	event.starts_at_us,event.created_by_membership_id,EXISTS(SELECT 1 FROM planning_event_audience own_audience
		WHERE own_audience.event_id=event.id AND own_audience.membership_id=?)`

type planningPermissions struct {
	Manage           bool
	Create           bool
	ViewParticipants bool
}

type eventProjection struct {
	Event
	startMicros       int64
	ownerMembershipID string
	inAudience        bool
}

type rowScanner interface {
	Scan(dest ...any) error
}

func currentPlanningPermissions(ctx context.Context, queryer authorization.Queryer, membership domain.Membership) (planningPermissions, error) {
	policy := authorization.NewPolicy(queryer)
	resource := authorization.GroupResource(membership.GroupID)
	manage, err := policy.Can(ctx, membership.GroupID, membership.ID, domain.PermissionManagePlanningEvents, resource)
	if err != nil {
		return planningPermissions{}, err
	}
	if manage {
		return planningPermissions{Manage: true, Create: true, ViewParticipants: true}, nil
	}
	create, err := policy.Can(ctx, membership.GroupID, membership.ID, domain.PermissionCreatePlanningEvents, resource)
	if err != nil {
		return planningPermissions{}, err
	}
	view, err := policy.Can(ctx, membership.GroupID, membership.ID, domain.PermissionViewPlanningParticipants, resource)
	if err != nil {
		return planningPermissions{}, err
	}
	return planningPermissions{Create: create, ViewParticipants: view}, nil
}

func scanEventProjection(scanner rowScanner) (eventProjection, error) {
	var projection eventProjection
	err := scanner.Scan(
		&projection.ID, &projection.SeriesID, &projection.OriginalStartAt, &projection.OriginalStartDate, &projection.IsSeriesException, &projection.Title, &projection.Description, &projection.Location,
		&projection.EventType, &projection.Status, &projection.AudienceType, &projection.AllDay, &projection.TimeZone, &projection.StartDate, &projection.EndDateExclusive, &projection.StartsAt, &projection.EndsAt,
		&projection.ResponseDeadline, &projection.ResponseDeadlineMinutesBefore, &projection.Capacity, &projection.WaitlistEnabled,
		&projection.ConfirmationRevision, &projection.Version, &projection.CreatedAt,
		&projection.UpdatedAt, &projection.startMicros, &projection.ownerMembershipID, &projection.inAudience,
	)
	return projection, err
}

func collectEventProjections(rows *sql.Rows) ([]eventProjection, error) {
	projections := []eventProjection{}
	for rows.Next() {
		projection, err := scanEventProjection(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		projections = append(projections, projection)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	return projections, nil
}

func hydrateEventProjections(ctx context.Context, db authorization.Queryer, membership domain.Membership, permissions planningPermissions, projections []eventProjection) ([]Event, error) {
	if len(projections) == 0 {
		return []Event{}, nil
	}
	indices := make(map[string]int, len(projections))
	ids := make([]string, len(projections))
	editableIDs := []string{}
	now := platform.Now()
	for index := range projections {
		projection := &projections[index]
		indices[projection.ID] = index
		ids[index] = projection.ID
		canMutate := permissions.Manage || projection.ownerMembershipID == membership.ID && permissions.Create
		projection.CanEdit = canMutate && projection.Status == "PUBLISHED"
		projection.CanCancel = canMutate && (projection.Status == "PUBLISHED" || projection.Status == "CLOSED")
		projection.CanViewParticipants = projection.ownerMembershipID == membership.ID || permissions.Manage || permissions.ViewParticipants
		effectiveEnd := projection.StartsAt
		if projection.EndsAt != nil {
			effectiveEnd = *projection.EndsAt
		}
		projection.CanRespond = projection.inAudience && projection.Status == "PUBLISHED" && projection.EventType != EventAppointment &&
			mustTime(effectiveEnd).After(now) && (projection.ResponseDeadline == nil || mustTime(*projection.ResponseDeadline).After(now))
		if projection.CanEdit {
			projection.TargetRoleIDs = []string{}
			projection.TargetMembershipIDs = []string{}
			editableIDs = append(editableIDs, projection.ID)
		}
	}

	if len(editableIDs) > 0 {
		rows, err := db.QueryContext(ctx, `SELECT event_id,role_id FROM planning_event_target_roles WHERE event_id IN (`+marks(len(editableIDs))+`) ORDER BY event_id,role_id`, values(editableIDs)...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var eventID, roleID string
			if err := rows.Scan(&eventID, &roleID); err != nil {
				rows.Close()
				return nil, err
			}
			projections[indices[eventID]].TargetRoleIDs = append(projections[indices[eventID]].TargetRoleIDs, roleID)
		}
		if err := closeRows(rows); err != nil {
			return nil, err
		}

		rows, err = db.QueryContext(ctx, `SELECT event_id,membership_id FROM planning_event_target_memberships WHERE event_id IN (`+marks(len(editableIDs))+`) ORDER BY event_id,membership_id`, values(editableIDs)...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var eventID, membershipID string
			if err := rows.Scan(&eventID, &membershipID); err != nil {
				rows.Close()
				return nil, err
			}
			projections[indices[eventID]].TargetMembershipIDs = append(projections[indices[eventID]].TargetMembershipIDs, membershipID)
		}
		if err := closeRows(rows); err != nil {
			return nil, err
		}
	}

	rows, err := db.QueryContext(ctx, `SELECT audience.event_id,count(*),
		coalesce(sum(participation.status='YES'),0),coalesce(sum(participation.status='MAYBE'),0),
		coalesce(sum(participation.status='NO'),0),coalesce(sum(participation.status='REGISTERED'),0),
		coalesce(sum(participation.status='WAITLISTED'),0),
		0
		FROM planning_event_audience audience
		JOIN memberships member ON member.id=audience.membership_id AND member.status='ACTIVE' AND member.deleted_at IS NULL
		JOIN users recipient ON recipient.id=member.user_id AND recipient.active=1 AND recipient.email IS NOT NULL AND recipient.password_hash IS NOT NULL
		LEFT JOIN planning_participations participation ON participation.event_id=audience.event_id AND participation.membership_id=audience.membership_id
		WHERE audience.event_id IN (`+marks(len(ids))+`) GROUP BY audience.event_id`, values(ids)...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var eventID string
		counts := Counts{}
		if err := rows.Scan(&eventID, &counts.Invited, &counts.Yes, &counts.Maybe, &counts.No, &counts.Registered, &counts.Waitlisted, &counts.ReconfirmationRequired); err != nil {
			rows.Close()
			return nil, err
		}
		projections[indices[eventID]].Counts = counts
	}
	if err := closeRows(rows); err != nil {
		return nil, err
	}

	rows, err = db.QueryContext(ctx, `SELECT event_id,status,confirmed_revision,version,responded_at,updated_at
		FROM planning_participations WHERE membership_id=? AND event_id IN (`+marks(len(ids))+`)`, append([]any{membership.ID}, values(ids)...)...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var eventID string
		participation := Participation{}
		if err := rows.Scan(&eventID, &participation.Status, &participation.ConfirmedRevision, &participation.Version, &participation.RespondedAt, &participation.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		projection := &projections[indices[eventID]]
		participation.EffectiveStatus = participation.Status
		projection.MyParticipation = &participation
	}
	if err := closeRows(rows); err != nil {
		return nil, err
	}

	events := make([]Event, len(projections))
	for index := range projections {
		if projections[index].EventType == EventAppointmentPoll {
			counts := &projections[index].Counts
			counts.Pending = counts.Invited - counts.Yes - counts.Maybe - counts.No
		}
		events[index] = projections[index].Event
	}
	return events, nil
}

func values(ids []string) []any {
	result := make([]any, len(ids))
	for index, id := range ids {
		result[index] = id
	}
	return result
}

func closeRows(rows *sql.Rows) error {
	iterationErr := rows.Err()
	closeErr := rows.Close()
	if iterationErr != nil {
		return iterationErr
	}
	return closeErr
}

func visibleEventProjection(projection eventProjection, membership domain.Membership, permissions planningPermissions) bool {
	return permissions.Manage || projection.ownerMembershipID == membership.ID || projection.inAudience
}
