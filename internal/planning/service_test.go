package planning

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestAttendancePollCreationAndParticipation(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "planning.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := platform.Timestamp(platform.Now())
	if _, err = db.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-admin','admin@example.test','Admin','hash',?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	principal := domain.Principal{UserID: "user-admin", Email: "admin@example.test", DisplayName: "Admin"}
	group, err := (groups.Service{DB: db}).Create(ctx, principal, "Planning group", "EUR")
	if err != nil {
		t.Fatal(err)
	}
	service := Service{DB: db}
	settings, err := service.GetSettings(ctx, group.Membership)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.UpdateSettings(ctx, principal, group.Membership, true, settings.Version); err != nil {
		t.Fatal(err)
	}
	start := time.Now().UTC().Add(4 * time.Hour)
	event, err := service.CreateEvent(ctx, principal, group.Membership, "planning-event-test-0001", EventInput{Title: "Shift meal", EventType: EventAppointmentPoll, AudienceType: "ALL_ACTIVE_MEMBERS", StartsAt: platform.Timestamp(start)})
	if err != nil {
		t.Fatal(err)
	}
	if event.Status != "PUBLISHED" || event.Counts.Invited != 1 || event.ResponseDeadline != nil {
		t.Fatalf("event=%#v", event)
	}
	if _, err = service.SetParticipation(ctx, principal, group.Membership, event.ID, "YES"); err != nil {
		t.Fatal(err)
	}
	event, err = service.GetEvent(ctx, group.Membership, event.ID)
	if err != nil {
		t.Fatal(err)
	}
	if event.Counts.Yes != 1 || event.MyParticipation == nil || event.MyParticipation.Status != "YES" {
		t.Fatalf("event=%#v", event)
	}
	cancellable, err := service.CreateEvent(ctx, principal, group.Membership, "planning-event-test-0002", EventInput{Title: "Cancelled appointment", EventType: EventAppointment, AudienceType: "ALL_ACTIVE_MEMBERS", StartsAt: platform.Timestamp(start)})
	if err != nil {
		t.Fatal(err)
	}
	if !cancellable.CanCancel {
		t.Fatalf("event owner cannot cancel event=%#v", cancellable)
	}
	cancellable, err = service.Transition(ctx, principal, group.Membership, cancellable.ID, "CANCELLED", cancellable.Version)
	if err != nil {
		t.Fatal(err)
	}
	if cancellable.Status != "CANCELLED" {
		t.Fatalf("cancelled event status=%s", cancellable.Status)
	}
}
