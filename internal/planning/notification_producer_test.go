package planning

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/notifications"
)

func TestPlanningServiceProducesPublishUpdateAndCancelTasksEndToEnd(t *testing.T) {
	ctx := context.Background()
	db := openLifecycleFixture(t)
	defer db.Close()
	const (
		groupID      = "group-lifecycle"
		ownerID      = "member-owner"
		startAt      = "2099-08-30T14:00:00Z"
		fixtureStamp = "2026-08-30T10:00:00Z"
	)
	if _, err := db.ExecContext(ctx, `INSERT OR IGNORE INTO membership_role_assignments(
		group_id,membership_id,role_id,version,assigned_at
	) VALUES(?,?,?,1,?)`, groupID, ownerID, "role:GROUP_ADMINISTRATOR:"+groupID, fixtureStamp); err != nil {
		t.Fatalf("assign planning role: %v", err)
	}
	service := Service{DB: db}
	membership := domain.Membership{ID: ownerID, GroupID: groupID, UserID: "user-owner"}
	principal := domain.Principal{UserID: "user-owner"}
	published, err := service.CreateEvent(ctx, principal, membership, "planning-notification-producer-0001", EventInput{
		Title:                         "Team meal",
		EventType:                     EventAppointmentPoll,
		AudienceType:                  AudienceAllActive,
		StartsAt:                      startAt,
		ResponseDeadlineMinutesBefore: intPointer(120),
	})
	if err != nil {
		t.Fatalf("create planning event: %v", err)
	}
	eventID := published.ID
	assertTaskCounts(t, db, eventID, map[string]int{"PLANNING_EVENT_PUBLISHED": 2})
	worker, err := notifications.NewPlanningWorker(db, notifications.Service{DB: db}, nil)
	if err != nil {
		t.Fatalf("create notification worker: %v", err)
	}
	processAt := time.Now().UTC().Add(time.Minute)
	if created, err := worker.ProcessDue(ctx, processAt); err != nil || created != 2 {
		t.Fatalf("deliver published tasks: created=%d err=%v", created, err)
	}
	updated, err := service.UpdateEvent(ctx, principal, membership, eventID, EventInput{
		Title: "Updated team meal", EventType: EventAppointmentPoll, AudienceType: "ALL_ACTIVE_MEMBERS",
		StartsAt: startAt, ResponseDeadlineMinutesBefore: intPointer(120),
	}, published.Version)
	if err != nil {
		t.Fatalf("update published planning event: %v", err)
	}
	if created, err := worker.ProcessDue(ctx, time.Now().UTC().Add(time.Minute)); err != nil || created != 2 {
		t.Fatalf("deliver updated tasks: created=%d err=%v", created, err)
	}
	if _, err := service.Transition(ctx, principal, membership, eventID, "CANCELLED", updated.Version); err != nil {
		t.Fatalf("cancel planning event: %v", err)
	}
	if created, err := worker.ProcessDue(ctx, time.Now().UTC().Add(time.Minute)); err != nil || created != 2 {
		t.Fatalf("deliver cancelled tasks: created=%d err=%v", created, err)
	}
	for eventType, want := range map[string]int{
		"PLANNING_EVENT_PUBLISHED": 2,
		"PLANNING_EVENT_UPDATED":   2,
		"PLANNING_EVENT_CANCELLED": 2,
	} {
		var got int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM notifications WHERE resource_id=? AND type=?`, eventID, eventType).Scan(&got); err != nil || got != want {
			t.Fatalf("notification count for %s=%d err=%v, want %d", eventType, got, err, want)
		}
	}
}

func assertTaskCounts(t *testing.T, db queryRower, eventID string, wants map[string]int) {
	t.Helper()
	for eventType, want := range wants {
		var got int
		if err := db.QueryRowContext(context.Background(), `SELECT count(*) FROM planning_notification_tasks WHERE event_id=? AND event_type=?`, eventID, eventType).Scan(&got); err != nil || got != want {
			t.Fatalf("task count for %s=%d err=%v, want %d", eventType, got, err, want)
		}
	}
}

type queryRower interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func stringPointer(value string) *string { return &value }
