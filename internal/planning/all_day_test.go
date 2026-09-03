package planning

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

func TestAllDayEventPinsGroupTimeZoneAndDerivesDSTBoundaries(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	setPlanningTimeZone(t, fixture, "Europe/Berlin")

	event, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-all-day-dst-0001", allDayEventInput("DST day", "2026-03-29", "2026-03-30"))
	if err != nil {
		t.Fatalf("create all-day event: %v", err)
	}
	if !event.AllDay || event.TimeZone != "Europe/Berlin" || event.StartDate != "2026-03-29" || event.EndDateExclusive != "2026-03-30" {
		t.Fatalf("all-day metadata=%#v", event)
	}
	if event.StartsAt != "2026-03-28T23:00:00Z" || event.EndsAt == nil || *event.EndsAt != "2026-03-29T22:00:00Z" {
		t.Fatalf("derived DST boundaries start=%q end=%v", event.StartsAt, event.EndsAt)
	}
	if mustTime(*event.EndsAt).Sub(mustTime(event.StartsAt)) != 23*time.Hour {
		t.Fatalf("spring-forward all-day duration=%s, want 23h", mustTime(*event.EndsAt).Sub(mustTime(event.StartsAt)))
	}
	if event.OriginalStartDate != nil {
		t.Fatalf("standalone all-day original date=%v, want nil", event.OriginalStartDate)
	}
}

func TestAllDayEventRejectsMixedOrInvalidSchedules(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	setPlanningTimeZone(t, fixture, "Europe/Berlin")

	cases := []struct {
		name  string
		input EventInput
	}{
		{name: "timed with date", input: EventInput{Title: "Mixed", EventType: EventAppointment, AudienceType: AudienceAllActive, StartsAt: "2026-09-01T10:00:00Z", StartDate: "2026-09-01"}},
		{name: "all day with timestamp", input: func() EventInput {
			input := allDayEventInput("Mixed", "2026-09-01", "2026-09-02")
			input.StartsAt = "2026-09-01T10:00:00Z"
			return input
		}()},
		{name: "invalid date", input: allDayEventInput("Invalid", "2026-02-30", "2026-03-01")},
		{name: "empty range", input: allDayEventInput("Empty", "2026-09-01", "2026-09-01")},
		{name: "mismatched time zone", input: func() EventInput {
			input := allDayEventInput("Wrong zone", "2026-09-01", "2026-09-02")
			input.TimeZone = "America/New_York"
			return input
		}()},
	}
	for index, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-all-day-invalid-000"+string(rune('1'+index)), testCase.input)
			if !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("create error=%v, want validation", err)
			}
		})
	}

	setPlanningTimeZone(t, fixture, "Pacific/Apia")
	_, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-all-day-skipped-date-0001", allDayEventInput("Skipped date", "2011-12-30", "2011-12-31"))
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("skipped civil date error=%v, want validation", err)
	}
}

func TestAllDayUpdatePreservesPinnedTimeZoneAndParticipation(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	setPlanningTimeZone(t, fixture, "Europe/Berlin")
	input := allDayEventInput("Autumn poll", "2026-10-25", "2026-10-26")
	input.EventType = EventAppointmentPoll
	input.ResponseDeadlineMinutesBefore = intPointer(120)
	event, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-all-day-update-0001", input)
	if err != nil {
		t.Fatalf("create all-day poll: %v", err)
	}
	if _, err := fixture.Service.SetParticipation(ctx, fixture.Principal, fixture.Membership, event.ID, "YES"); err != nil {
		t.Fatalf("respond to all-day poll: %v", err)
	}
	if event.ResponseDeadline == nil || *event.ResponseDeadline != "2026-10-24T20:00:00Z" {
		t.Fatalf("all-day response deadline=%v", event.ResponseDeadline)
	}

	setPlanningTimeZone(t, fixture, "America/New_York")
	input.EndDateExclusive = "2026-10-27"
	event, err = fixture.Service.UpdateEvent(ctx, fixture.Principal, fixture.Membership, event.ID, input, event.Version)
	if err != nil {
		t.Fatalf("extend all-day event: %v", err)
	}
	if event.TimeZone != "Europe/Berlin" || event.ConfirmationRevision != 1 {
		t.Fatalf("updated event zone=%q confirmationRevision=%d", event.TimeZone, event.ConfirmationRevision)
	}
	if event.MyParticipation == nil || event.MyParticipation.Status != "YES" || event.MyParticipation.EffectiveStatus != "YES" {
		t.Fatalf("updated participation=%#v", event.MyParticipation)
	}
}

func TestListEventsIncludesAllDayEventOverlappingWindow(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	setPlanningTimeZone(t, fixture, "Europe/Berlin")
	event, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-all-day-overlap-0001", allDayEventInput("Multi-day", "2026-03-28", "2026-03-31"))
	if err != nil {
		t.Fatalf("create multi-day event: %v", err)
	}

	events, _, err := fixture.Service.ListEvents(ctx, fixture.Membership, "2026-03-29T00:00:00Z", "2026-03-30T00:00:00Z", "", "", 20)
	if err != nil {
		t.Fatalf("list overlapping all-day event: %v", err)
	}
	if len(events) != 1 || events[0].ID != event.ID {
		t.Fatalf("overlapping events=%#v", events)
	}
	events, _, err = fixture.Service.ListEvents(ctx, fixture.Membership, "2026-03-30T22:00:00Z", "2026-03-31T22:00:00Z", "", "", 20)
	if err != nil {
		t.Fatalf("list after exclusive end: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("event remained visible after exclusive end: %#v", events)
	}
}

func TestParticipationRejectsEndedAllDayEvent(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	setPlanningTimeZone(t, fixture, "Europe/Berlin")
	input := allDayEventInput("Ended poll", "2026-08-01", "2026-08-02")
	input.EventType = EventAppointmentPoll
	event, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-all-day-ended-0001", input)
	if err != nil {
		t.Fatalf("create ended all-day poll: %v", err)
	}
	if event.CanRespond {
		t.Fatal("ended all-day event still offers a response action")
	}
	if _, err := fixture.Service.SetParticipation(ctx, fixture.Principal, fixture.Membership, event.ID, "YES"); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("participation after all-day end error=%v, want conflict", err)
	}
}

func TestParticipationRejectsAtExactResponseDeadline(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	fixedNow := time.Date(2026, time.September, 1, 10, 0, 0, 0, time.UTC)
	previousNow := platform.Now
	platform.Now = func() time.Time { return fixedNow }
	t.Cleanup(func() { platform.Now = previousNow })

	for index, eventType := range []string{EventAppointmentPoll, EventAppointmentRegistration} {
		input := EventInput{
			Title:                         "Exact deadline",
			EventType:                     eventType,
			AudienceType:                  AudienceAllActive,
			StartsAt:                      platform.Timestamp(fixedNow.Add(2 * time.Hour)),
			ResponseDeadlineMinutesBefore: intPointer(120),
		}
		if eventType == EventAppointmentRegistration {
			input.Capacity = intPointer(1)
		}
		event, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-exact-deadline-000"+string(rune('1'+index)), input)
		if err != nil {
			t.Fatalf("create %s event: %v", eventType, err)
		}
		if event.CanRespond {
			t.Fatalf("%s event offers a response at the exact deadline", eventType)
		}
		status := "YES"
		if eventType == EventAppointmentRegistration {
			status = "REGISTERED"
		}
		if _, err := fixture.Service.SetParticipation(ctx, fixture.Principal, fixture.Membership, event.ID, status); !errors.Is(err, domain.ErrConflict) {
			t.Fatalf("%s participation at exact deadline error=%v, want conflict", eventType, err)
		}
	}
}

func TestAllDayRegistrationSupportsCapacity(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	setPlanningTimeZone(t, fixture, "Europe/Berlin")
	location, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatal(err)
	}
	startDate := platform.Now().In(location).AddDate(0, 0, 2)
	input := allDayEventInput("All-day registration", startDate.Format(time.DateOnly), startDate.AddDate(0, 0, 1).Format(time.DateOnly))
	input.EventType = EventAppointmentRegistration
	input.Capacity = intPointer(1)
	event, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-all-day-registration-0001", input)
	if err != nil {
		t.Fatalf("create all-day registration: %v", err)
	}
	participation, err := fixture.Service.SetParticipation(ctx, fixture.Principal, fixture.Membership, event.ID, "REGISTERED")
	if err != nil {
		t.Fatalf("register for all-day event: %v", err)
	}
	if participation.Status != "REGISTERED" {
		t.Fatalf("all-day registration status=%q", participation.Status)
	}
}

func TestTimedEventResponseIncludesGroupTimeZone(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	setPlanningTimeZone(t, fixture, "Europe/Berlin")
	event, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-timed-timezone-0001", EventInput{
		Title: "Timed", EventType: EventAppointment, AudienceType: AudienceAllActive,
		StartsAt: platform.Timestamp(platform.Now().Add(2 * time.Hour)),
	})
	if err != nil {
		t.Fatalf("create timed event: %v", err)
	}
	if event.AllDay || event.TimeZone != "Europe/Berlin" || event.StartDate != "" || event.EndDateExclusive != "" {
		t.Fatalf("timed event metadata=%#v", event)
	}
	setPlanningTimeZone(t, fixture, "America/New_York")
	event, err = fixture.Service.GetEvent(ctx, fixture.Membership, event.ID)
	if err != nil {
		t.Fatalf("reload timed event: %v", err)
	}
	if event.TimeZone != "Europe/Berlin" {
		t.Fatalf("timed event time zone changed with group settings: %q", event.TimeZone)
	}
}

func TestAllDayCreateIdempotencyDoesNotDependOnCurrentGroupTimeZone(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	setPlanningTimeZone(t, fixture, "Europe/Berlin")
	input := allDayEventInput("Idempotent all day", "2026-10-25", "2026-10-26")
	created, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-all-day-idempotency-0001", input)
	if err != nil {
		t.Fatalf("create all-day event: %v", err)
	}
	setPlanningTimeZone(t, fixture, "America/New_York")
	replayed, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-all-day-idempotency-0001", input)
	if err != nil {
		t.Fatalf("replay all-day event after group time-zone change: %v", err)
	}
	if replayed.ID != created.ID || replayed.TimeZone != "Europe/Berlin" || replayed.StartsAt != created.StartsAt {
		t.Fatalf("replayed event=%#v created=%#v", replayed, created)
	}
}

func allDayEventInput(title, startDate, endDateExclusive string) EventInput {
	return EventInput{
		Title: title, EventType: EventAppointment, AudienceType: AudienceAllActive,
		AllDay: true, StartDate: startDate, EndDateExclusive: endDateExclusive,
	}
}

func setPlanningTimeZone(t *testing.T, fixture planningServiceFixture, timeZone string) {
	t.Helper()
	if _, err := fixture.DB.ExecContext(context.Background(), `UPDATE group_notification_settings SET timezone=? WHERE group_id=?`, timeZone, fixture.Membership.GroupID); err != nil {
		t.Fatalf("set planning time zone: %v", err)
	}
}
