package planning

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

func TestListEventsOrdersFractionalStartsNumerically(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	insertCalendarRangeEvent(t, fixture, "fraction-later", "2026-09-10T10:00:00.9Z", nil, false, "", "")
	insertCalendarRangeEvent(t, fixture, "fraction-first", "2026-09-10T10:00:00Z", nil, false, "", "")

	events, _, err := fixture.Service.ListEventsWithQuery(ctx, fixture.Membership, EventListQuery{
		From: "2026-09-10T09:00:00Z", To: "2026-09-10T11:00:00Z", Limit: 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].ID != "fraction-first" || events[1].ID != "fraction-later" {
		t.Fatalf("fractional order=%v", eventIDs(events))
	}
}

func TestListEventsOpaqueCursorHandlesMoreThanTwoHundredEqualStartsAndBindsQuery(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	for index := 0; index < 205; index++ {
		insertCalendarRangeEvent(t, fixture, fmt.Sprintf("equal-%03d", index), "2026-09-12T10:00:00.123456Z", nil, false, "", "")
	}
	query := EventListQuery{Status: "PUBLISHED", Limit: 200}
	first, cursor, err := fixture.Service.ListEventsWithQuery(ctx, fixture.Membership, query)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 200 || cursor == "" {
		t.Fatalf("first page len/cursor=%d/%q", len(first), cursor)
	}
	query.Cursor = cursor
	second, next, err := fixture.Service.ListEventsWithQuery(ctx, fixture.Membership, query)
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 5 || next != "" || first[len(first)-1].ID == second[0].ID {
		t.Fatalf("second page len/next/first=%d/%q/%v", len(second), next, eventIDs(second))
	}
	query.Status = ""
	if _, _, err := fixture.Service.ListEventsWithQuery(ctx, fixture.Membership, query); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("reused cursor error=%v, want validation", err)
	}
}

func TestListEventsUsesCivilDateOverlapForAllDayRows(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	setPlanningTimeZone(t, fixture, "Europe/Berlin")
	allDay, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "calendar-civil-all-day", allDayEventInput("DST weekend", "2026-03-28", "2026-03-31"))
	if err != nil {
		t.Fatal(err)
	}
	insertCalendarRangeEvent(t, fixture, "calendar-civil-timed", "2026-03-29T10:00:00Z", nil, false, "", "")

	events, _, err := fixture.Service.ListEventsWithQuery(ctx, fixture.Membership, EventListQuery{
		FromDate: "2026-03-30", ToDateExclusive: "2026-03-31", Limit: 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].ID != allDay.ID {
		t.Fatalf("civil-only events=%v", eventIDs(events))
	}
	events, _, err = fixture.Service.ListEventsWithQuery(ctx, fixture.Membership, EventListQuery{
		From: "2026-03-29T00:00:00Z", To: "2026-03-30T00:00:00Z",
		FromDate: "2026-03-29", ToDateExclusive: "2026-03-30", Limit: 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("combined native ranges=%v", eventIDs(events))
	}
	if _, _, err := fixture.Service.ListEventsWithQuery(ctx, fixture.Membership, EventListQuery{
		FromDate: "2026-01-01", ToDateExclusive: "2027-01-03",
	}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("oversized civil query error=%v, want validation", err)
	}
}

func insertCalendarRangeEvent(t *testing.T, fixture planningServiceFixture, id, startsAt string, endsAt *string, allDay bool, startDate, endDateExclusive string) {
	t.Helper()
	now := platform.Timestamp(platform.Now())
	_, err := fixture.DB.ExecContext(context.Background(), `INSERT INTO planning_events(
		id,group_id,title,event_type,status,audience_type,all_day,timezone,start_date,end_date_exclusive,starts_at,ends_at,
		created_by_membership_id,updated_by_membership_id,published_at,created_at,updated_at
	) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, fixture.Membership.GroupID, id, EventAppointment, "PUBLISHED", AudienceAllActive,
		allDay, "Europe/Berlin", nullableString(startDate), nullableString(endDateExclusive), startsAt, endsAt,
		fixture.Membership.ID, fixture.Membership.ID, now, now, now)
	if err != nil {
		t.Fatalf("insert calendar event %s: %v", id, err)
	}
}

func eventIDs(events []Event) []string {
	ids := make([]string, len(events))
	for index, event := range events {
		ids[index] = event.ID
	}
	return ids
}
