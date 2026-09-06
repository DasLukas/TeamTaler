package planning

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

func TestCreateSeriesIsIdempotentAndMaterializationIsUnique(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	command := recurringSeriesCommand(platform.Now().Add(48*time.Hour), EventAppointment, 3)

	created, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-create-0001", command)
	if err != nil {
		t.Fatalf("create series: %v", err)
	}
	replayed, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-create-0001", command)
	if err != nil {
		t.Fatalf("replay series creation: %v", err)
	}
	if replayed.Series.ID != created.Series.ID || replayed.FirstOccurrence.ID != created.FirstOccurrence.ID {
		t.Fatalf("replayed series=%s occurrence=%s, want %s and %s", replayed.Series.ID, replayed.FirstOccurrence.ID, created.Series.ID, created.FirstOccurrence.ID)
	}
	if created.Series.Status != "PUBLISHED" || created.Series.TimeZone != "Europe/Berlin" {
		t.Fatalf("created series status=%s timezone=%s", created.Series.Status, created.Series.TimeZone)
	}
	if created.FirstOccurrence.SeriesID == nil || *created.FirstOccurrence.SeriesID != created.Series.ID || created.FirstOccurrence.OriginalStartAt == nil || created.FirstOccurrence.IsSeriesException {
		t.Fatalf("first occurrence metadata=%#v", created.FirstOccurrence)
	}

	var eventCount, publishedTaskCount, eventPublishedTaskCount int
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_events WHERE series_id=?`, created.Series.ID).Scan(&eventCount); err != nil {
		t.Fatalf("count occurrences: %v", err)
	}
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_series_notification_tasks WHERE series_id=? AND event_type='PLANNING_SERIES_PUBLISHED'`, created.Series.ID).Scan(&publishedTaskCount); err != nil {
		t.Fatalf("count series publish tasks: %v", err)
	}
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_notification_tasks task JOIN planning_events event ON event.id=task.event_id WHERE event.series_id=? AND task.event_type='PLANNING_EVENT_PUBLISHED'`, created.Series.ID).Scan(&eventPublishedTaskCount); err != nil {
		t.Fatalf("count occurrence publish tasks: %v", err)
	}
	if eventCount != 3 || publishedTaskCount != 1 || eventPublishedTaskCount != 0 {
		t.Fatalf("counts occurrences=%d seriesPublished=%d eventPublished=%d", eventCount, publishedTaskCount, eventPublishedTaskCount)
	}
	inserted, err := fixture.Service.MaterializeSeries(ctx, platform.Now().AddDate(1, 0, 0))
	if err != nil || inserted != 0 {
		t.Fatalf("repeat materialization inserted=%d err=%v", inserted, err)
	}
}

func TestPublishedPollSeriesAllowsResponsesWithoutDeadline(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	command := recurringSeriesCommand(platform.Now().Add(48*time.Hour), EventAppointmentPoll, 3)
	command.ResponseDeadlineMinutesBefore = nil

	created, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-no-deadline-0001", command)
	if err != nil {
		t.Fatalf("create poll series without deadline: %v", err)
	}
	if created.Series.ResponseDeadlineMinutesBefore != nil || created.FirstOccurrence.ResponseDeadline != nil {
		t.Fatalf("unexpected response deadline: series=%#v occurrence=%#v", created.Series.ResponseDeadlineMinutesBefore, created.FirstOccurrence.ResponseDeadline)
	}
	if _, err := fixture.Service.SetParticipation(ctx, fixture.Principal, fixture.Membership, created.FirstOccurrence.ID, "YES"); err != nil {
		t.Fatalf("respond without deadline: %v", err)
	}
}

func TestCreateSeriesReplayReturnsOriginalResponseSnapshot(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	command := recurringSeriesCommand(platform.Now().Add(48*time.Hour), EventAppointment, 3)
	created, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-snapshot-0001", command)
	if err != nil {
		t.Fatalf("create series: %v", err)
	}
	update := SeriesUpdateCommand{EventInput: command.EventInput, Recurrence: command.Recurrence, Scope: SeriesScopeAll}
	update.Title = "Changed after creation"
	updated, err := fixture.Service.UpdateSeries(ctx, fixture.Principal, fixture.Membership, created.Series.ID, update, created.Series.Version)
	if err != nil {
		t.Fatalf("update series after creation: %v", err)
	}
	if updated.Title == created.Series.Title || updated.Version == created.Series.Version {
		t.Fatalf("series was not updated: created=%#v updated=%#v", created.Series, updated)
	}
	replayed, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-snapshot-0001", command)
	if err != nil {
		t.Fatalf("replay original creation: %v", err)
	}
	if replayed.Series.Title != created.Series.Title || replayed.Series.Version != created.Series.Version || replayed.FirstOccurrence.Title != created.FirstOccurrence.Title || replayed.FirstOccurrence.Version != created.FirstOccurrence.Version {
		t.Fatalf("replayed response=%#v, want original snapshot=%#v", replayed, created)
	}
}

func TestSeriesTimeUpdatePreservesOccurrenceAndParticipation(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	command := recurringSeriesCommand(platform.Now().Add(72*time.Hour), EventAppointmentPoll, 4)
	created, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-update-0001", command)
	if err != nil {
		t.Fatalf("create poll series: %v", err)
	}
	second := seriesOccurrence(t, fixture, created.Series.ID, 2)
	if _, err := fixture.Service.SetParticipation(ctx, fixture.Principal, fixture.Membership, second.ID, "YES"); err != nil {
		t.Fatalf("respond to occurrence: %v", err)
	}

	shiftedStart := mustTime(second.StartsAt).Add(time.Hour)
	shiftedEnd := mustTime(*second.EndsAt).Add(time.Hour)
	count := 3
	update := SeriesUpdateCommand{
		EventInput: EventInput{
			Title:                         "Shifted series",
			EventType:                     EventAppointmentPoll,
			AudienceType:                  AudienceAllActive,
			StartsAt:                      platform.Timestamp(shiftedStart),
			EndsAt:                        stringPointer(platform.Timestamp(shiftedEnd)),
			ResponseDeadlineMinutesBefore: intPointer(120),
		},
		Recurrence:          RecurrenceInput{Frequency: RecurrenceDaily, Interval: 1, Range: RecurrenceRangeInput{Type: RecurrenceRangeCount, Count: &count}},
		Scope:               SeriesScopeThisAndFollowing,
		FromOriginalStartAt: second.OriginalStartAt,
	}
	if _, err := fixture.Service.UpdateSeries(ctx, fixture.Principal, fixture.Membership, created.Series.ID, update, created.Series.Version); err != nil {
		t.Fatalf("update future series segment: %v", err)
	}

	updated, err := fixture.Service.GetEvent(ctx, fixture.Membership, second.ID)
	if err != nil {
		t.Fatalf("read shifted occurrence: %v", err)
	}
	if updated.StartsAt != platform.Timestamp(shiftedStart) || updated.ConfirmationRevision != 1 || updated.MyParticipation == nil || updated.MyParticipation.Status != "YES" || updated.MyParticipation.EffectiveStatus != "YES" {
		t.Fatalf("updated occurrence=%#v", updated)
	}
	var rowCount, participationCount int
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_events WHERE series_id=? AND series_sequence=2`, created.Series.ID).Scan(&rowCount); err != nil {
		t.Fatalf("count stable occurrence: %v", err)
	}
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_participations WHERE event_id=? AND membership_id=?`, second.ID, fixture.Membership.ID).Scan(&participationCount); err != nil {
		t.Fatalf("count preserved response: %v", err)
	}
	if rowCount != 1 || participationCount != 1 {
		t.Fatalf("stable occurrence rows=%d participations=%d", rowCount, participationCount)
	}
}

func TestSeriesUpdateRejectsCapacityBelowExistingRegistrations(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	secondPrincipal, secondMember := fixture.addMember(t, "series-capacity", "Second registration")
	command := recurringSeriesCommand(platform.Now().Add(72*time.Hour), EventAppointmentRegistration, 3)
	command.Capacity = intPointer(2)
	created, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-capacity-0001", command)
	if err != nil {
		t.Fatalf("create registration series: %v", err)
	}
	second := seriesOccurrence(t, fixture, created.Series.ID, 2)
	if _, err := fixture.Service.SetParticipation(ctx, fixture.Principal, fixture.Membership, second.ID, "REGISTERED"); err != nil {
		t.Fatalf("register owner: %v", err)
	}
	if _, err := fixture.Service.SetParticipation(ctx, secondPrincipal, secondMember, second.ID, "REGISTERED"); err != nil {
		t.Fatalf("register second member: %v", err)
	}
	update := SeriesUpdateCommand{EventInput: command.EventInput, Recurrence: command.Recurrence, Scope: SeriesScopeAll}
	update.Capacity = intPointer(1)
	_, err = fixture.Service.UpdateSeries(ctx, fixture.Principal, fixture.Membership, created.Series.ID, update, created.Series.Version)
	var validation domain.ValidationError
	if !errors.As(err, &validation) || validation.Field != "capacity" {
		t.Fatalf("capacity update error=%v, want capacity validation", err)
	}
	persisted, err := fixture.Service.GetSeries(ctx, fixture.Membership, created.Series.ID)
	if err != nil {
		t.Fatalf("read series after rejected capacity: %v", err)
	}
	if persisted.Version != created.Series.Version || persisted.Capacity == nil || *persisted.Capacity != 2 {
		t.Fatalf("rejected capacity update changed series: %#v", persisted)
	}
}

func TestSeriesUpdateRejectsDisablingAnOccupiedWaitlist(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	secondPrincipal, secondMember := fixture.addMember(t, "series-waitlist", "Waitlisted registration")
	command := recurringSeriesCommand(platform.Now().Add(72*time.Hour), EventAppointmentRegistration, 3)
	command.Capacity = intPointer(1)
	command.WaitlistEnabled = true
	created, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-waitlist-0001", command)
	if err != nil {
		t.Fatalf("create registration series: %v", err)
	}
	second := seriesOccurrence(t, fixture, created.Series.ID, 2)
	if _, err := fixture.Service.SetParticipation(ctx, fixture.Principal, fixture.Membership, second.ID, "REGISTERED"); err != nil {
		t.Fatalf("register owner: %v", err)
	}
	participation, err := fixture.Service.SetParticipation(ctx, secondPrincipal, secondMember, second.ID, "REGISTERED")
	if err != nil {
		t.Fatalf("join waitlist: %v", err)
	}
	if participation.Status != "WAITLISTED" {
		t.Fatalf("second participation status=%s, want WAITLISTED", participation.Status)
	}
	update := SeriesUpdateCommand{EventInput: command.EventInput, Recurrence: command.Recurrence, Scope: SeriesScopeAll}
	update.Capacity = nil
	update.WaitlistEnabled = false
	_, err = fixture.Service.UpdateSeries(ctx, fixture.Principal, fixture.Membership, created.Series.ID, update, created.Series.Version)
	var validation domain.ValidationError
	if !errors.As(err, &validation) || validation.Field != "waitlistEnabled" {
		t.Fatalf("waitlist update error=%v, want waitlistEnabled validation", err)
	}
	persisted, err := fixture.Service.GetSeries(ctx, fixture.Membership, created.Series.ID)
	if err != nil {
		t.Fatalf("read series after rejected waitlist update: %v", err)
	}
	if !persisted.WaitlistEnabled || persisted.Capacity == nil || *persisted.Capacity != 1 {
		t.Fatalf("rejected waitlist update changed series: %#v", persisted)
	}
}

func TestPublishedSeriesUpdateRejectsAudienceWithoutActiveMembers(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	fixture.addRole(t, "role-series-empty", "Empty series target", nil)
	command := recurringSeriesCommand(platform.Now().Add(72*time.Hour), EventAppointment, 3)
	created, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-empty-audience-0001", command)
	if err != nil {
		t.Fatalf("create series: %v", err)
	}
	update := SeriesUpdateCommand{EventInput: command.EventInput, Recurrence: command.Recurrence, Scope: SeriesScopeAll}
	update.AudienceType = AudienceSelectedRoles
	update.TargetRoleIDs = []string{"role-series-empty"}
	_, err = fixture.Service.UpdateSeries(ctx, fixture.Principal, fixture.Membership, created.Series.ID, update, created.Series.Version)
	var validation domain.ValidationError
	if !errors.As(err, &validation) || validation.Field != "audience" {
		t.Fatalf("empty audience update error=%v, want audience validation", err)
	}
	persisted, err := fixture.Service.GetSeries(ctx, fixture.Membership, created.Series.ID)
	if err != nil {
		t.Fatalf("read series after rejected audience: %v", err)
	}
	if persisted.Version != created.Series.Version || persisted.AudienceType != AudienceAllActive {
		t.Fatalf("rejected audience update changed series: %#v", persisted)
	}
}

func TestSeriesAllUpdateRebasesSelectedOccurrenceTimeOntoFirstFutureDate(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	command := recurringSeriesCommand(platform.Now().Add(72*time.Hour), EventAppointment, 5)
	created, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-all-rebase-0001", command)
	if err != nil {
		t.Fatalf("create series: %v", err)
	}
	first := seriesOccurrence(t, fixture, created.Series.ID, 1)
	fifth := seriesOccurrence(t, fixture, created.Series.ID, 5)
	selectedStart := mustTime(fifth.StartsAt).Add(90 * time.Minute)
	selectedEnd := selectedStart.Add(time.Hour)
	update := SeriesUpdateCommand{
		EventInput: EventInput{
			Title:        "Rebased time",
			EventType:    EventAppointment,
			AudienceType: AudienceAllActive,
			StartsAt:     platform.Timestamp(selectedStart),
			EndsAt:       stringPointer(platform.Timestamp(selectedEnd)),
		},
		Recurrence: command.Recurrence,
		Scope:      SeriesScopeAll,
	}
	if _, err := fixture.Service.UpdateSeries(ctx, fixture.Principal, fixture.Membership, created.Series.ID, update, created.Series.Version); err != nil {
		t.Fatalf("update all occurrences from later selection: %v", err)
	}
	updatedFirst := seriesOccurrence(t, fixture, created.Series.ID, 1)
	location, err := time.LoadLocation(created.Series.TimeZone)
	if err != nil {
		t.Fatalf("load series timezone: %v", err)
	}
	wantDate := mustTime(first.StartsAt).In(location)
	wantTime := selectedStart.In(location)
	got := mustTime(updatedFirst.StartsAt).In(location)
	if got.Year() != wantDate.Year() || got.Month() != wantDate.Month() || got.Day() != wantDate.Day() || got.Hour() != wantTime.Hour() || got.Minute() != wantTime.Minute() {
		t.Fatalf("first updated occurrence=%s, want date %s with time %02d:%02d", got.Format(time.RFC3339), wantDate.Format("2006-01-02"), wantTime.Hour(), wantTime.Minute())
	}
	if updatedFirst.ID != first.ID {
		t.Fatalf("first occurrence identity changed from %s to %s", first.ID, updatedFirst.ID)
	}
}

func TestSeriesFollowingCancellationIsDurable(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	created, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-cancel-0001", recurringSeriesCommand(platform.Now().Add(72*time.Hour), EventAppointment, 6))
	if err != nil {
		t.Fatalf("create series: %v", err)
	}
	third := seriesOccurrence(t, fixture, created.Series.ID, 3)
	if err := fixture.Service.CancelSeries(ctx, fixture.Principal, fixture.Membership, created.Series.ID, SeriesScopeThisAndFollowing, third.OriginalStartAt, created.Series.Version); err != nil {
		t.Fatalf("cancel following occurrences: %v", err)
	}
	for run := 0; run < 2; run++ {
		inserted, err := fixture.Service.MaterializeSeries(ctx, platform.Now().AddDate(1, 0, 0))
		if err != nil || inserted != 0 {
			t.Fatalf("materialization run %d inserted=%d err=%v", run, inserted, err)
		}
	}
	var active, cancelled, ranges int
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_events WHERE series_id=? AND series_sequence>=3 AND status!='CANCELLED'`, created.Series.ID).Scan(&active); err != nil {
		t.Fatalf("count active cancelled segment: %v", err)
	}
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_events WHERE series_id=? AND series_sequence>=3 AND status='CANCELLED'`, created.Series.ID).Scan(&cancelled); err != nil {
		t.Fatalf("count cancelled segment: %v", err)
	}
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_series_cancelled_ranges WHERE series_id=? AND from_sequence=3`, created.Series.ID).Scan(&ranges); err != nil {
		t.Fatalf("count cancellation ranges: %v", err)
	}
	if active != 0 || cancelled != 4 || ranges != 1 {
		t.Fatalf("cancelled segment active=%d cancelled=%d ranges=%d", active, cancelled, ranges)
	}
}

func TestSeriesCancellationUsesMonotonicRevisionAndCancelsStaleTasks(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	command := recurringSeriesCommand(platform.Now().Add(72*time.Hour), EventAppointment, 5)
	created, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-cancel-revision-0001", command)
	if err != nil {
		t.Fatalf("create series: %v", err)
	}
	update := SeriesUpdateCommand{EventInput: command.EventInput, Recurrence: command.Recurrence, Scope: SeriesScopeAll}
	update.Title = "Pending update"
	updated, err := fixture.Service.UpdateSeries(ctx, fixture.Principal, fixture.Membership, created.Series.ID, update, created.Series.Version)
	if err != nil {
		t.Fatalf("update series: %v", err)
	}
	third := seriesOccurrence(t, fixture, created.Series.ID, 3)
	if err := fixture.Service.CancelSeries(ctx, fixture.Principal, fixture.Membership, created.Series.ID, SeriesScopeThisAndFollowing, third.OriginalStartAt, updated.Version); err != nil {
		t.Fatalf("first partial cancellation: %v", err)
	}
	afterFirst, err := fixture.Service.GetSeries(ctx, fixture.Membership, created.Series.ID)
	if err != nil {
		t.Fatalf("read first cancellation: %v", err)
	}
	if afterFirst.currentRevision != updated.currentRevision+1 {
		t.Fatalf("first cancellation revision=%d, want %d", afterFirst.currentRevision, updated.currentRevision+1)
	}
	second := seriesOccurrence(t, fixture, created.Series.ID, 2)
	if err := fixture.Service.CancelSeries(ctx, fixture.Principal, fixture.Membership, created.Series.ID, SeriesScopeThisAndFollowing, second.OriginalStartAt, afterFirst.Version); err != nil {
		t.Fatalf("second partial cancellation: %v", err)
	}
	afterSecond, err := fixture.Service.GetSeries(ctx, fixture.Membership, created.Series.ID)
	if err != nil {
		t.Fatalf("read second cancellation: %v", err)
	}
	if err := fixture.Service.CancelSeries(ctx, fixture.Principal, fixture.Membership, created.Series.ID, SeriesScopeAll, nil, afterSecond.Version); err != nil {
		t.Fatalf("cancel complete series: %v", err)
	}
	final, err := fixture.Service.GetSeries(ctx, fixture.Membership, created.Series.ID)
	if err != nil {
		t.Fatalf("read complete cancellation: %v", err)
	}
	var cancellationTasks, pendingCancellationTasks, pendingStaleUpdates int
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_series_notification_tasks WHERE series_id=? AND event_type='PLANNING_SERIES_CANCELLED'`, created.Series.ID).Scan(&cancellationTasks); err != nil {
		t.Fatalf("count cancellation tasks: %v", err)
	}
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_series_notification_tasks WHERE series_id=? AND event_type='PLANNING_SERIES_CANCELLED' AND status='PENDING'`, created.Series.ID).Scan(&pendingCancellationTasks); err != nil {
		t.Fatalf("count pending cancellation tasks: %v", err)
	}
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_series_notification_tasks WHERE series_id=? AND event_type='PLANNING_SERIES_UPDATED' AND status='PENDING'`, created.Series.ID).Scan(&pendingStaleUpdates); err != nil {
		t.Fatalf("count stale update tasks: %v", err)
	}
	if final.Status != "CANCELLED" || final.currentRevision != afterSecond.currentRevision+1 || cancellationTasks != 3 || pendingCancellationTasks != 1 || pendingStaleUpdates != 0 {
		t.Fatalf("final status=%s revision=%d cancellationTasks=%d pendingCancellation=%d pendingUpdates=%d", final.Status, final.currentRevision, cancellationTasks, pendingCancellationTasks, pendingStaleUpdates)
	}
}

func TestCancelledOccurrenceRemainsAnExceptionAndBlocksRematerialization(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	created, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-single-cancel-0001", recurringSeriesCommand(platform.Now().Add(72*time.Hour), EventAppointment, 4))
	if err != nil {
		t.Fatalf("create series: %v", err)
	}
	second := seriesOccurrence(t, fixture, created.Series.ID, 2)
	cancelled, err := fixture.Service.Transition(ctx, fixture.Principal, fixture.Membership, second.ID, "CANCELLED", second.Version)
	if err != nil {
		t.Fatalf("cancel one occurrence: %v", err)
	}
	if !cancelled.IsSeriesException {
		t.Fatal("cancelled occurrence was not marked as a series exception")
	}
	if inserted, err := fixture.Service.MaterializeSeries(ctx, platform.Now().AddDate(1, 0, 0)); err != nil || inserted != 0 {
		t.Fatalf("materialize after single cancellation inserted=%d err=%v", inserted, err)
	}
	var rows int
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_events WHERE series_id=? AND series_sequence=2`, created.Series.ID).Scan(&rows); err != nil {
		t.Fatalf("count cancelled occurrence identity: %v", err)
	}
	if rows != 1 {
		t.Fatalf("cancelled occurrence rows=%d, want 1", rows)
	}
}

func TestSeriesCancellationAlsoCancelsFutureManualExceptions(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	created, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-cancel-exception-0001", recurringSeriesCommand(platform.Now().Add(72*time.Hour), EventAppointment, 4))
	if err != nil {
		t.Fatalf("create series: %v", err)
	}
	third := seriesOccurrence(t, fixture, created.Series.ID, 3)
	shiftedStart := mustTime(third.StartsAt).Add(2 * time.Hour)
	shiftedEnd := mustTime(*third.EndsAt).Add(2 * time.Hour)
	third, err = fixture.Service.UpdateEvent(ctx, fixture.Principal, fixture.Membership, third.ID, EventInput{
		Title:        "Manual exception",
		EventType:    EventAppointment,
		AudienceType: AudienceAllActive,
		StartsAt:     platform.Timestamp(shiftedStart),
		EndsAt:       stringPointer(platform.Timestamp(shiftedEnd)),
	}, third.Version)
	if err != nil {
		t.Fatalf("create manual exception: %v", err)
	}
	if !third.IsSeriesException {
		t.Fatal("manual occurrence update did not create an exception")
	}
	if err := fixture.Service.CancelSeries(ctx, fixture.Principal, fixture.Membership, created.Series.ID, SeriesScopeAll, nil, created.Series.Version); err != nil {
		t.Fatalf("cancel complete series: %v", err)
	}
	cancelled, err := fixture.Service.GetEvent(ctx, fixture.Membership, third.ID)
	if err != nil {
		t.Fatalf("read cancelled exception: %v", err)
	}
	if cancelled.Status != "CANCELLED" || !cancelled.IsSeriesException {
		t.Fatalf("cancelled exception status=%s exception=%t", cancelled.Status, cancelled.IsSeriesException)
	}
}

func TestDynamicSeriesAudienceAndPublishTaskDedupe(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	created, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-dynamic-0001", recurringSeriesCommand(platform.Now().Add(72*time.Hour), EventAppointment, 4))
	if err != nil {
		t.Fatalf("create series: %v", err)
	}
	update := SeriesUpdateCommand{
		EventInput: recurringSeriesCommand(mustTime(created.FirstOccurrence.StartsAt), EventAppointment, 4).EventInput,
		Recurrence: recurringSeriesCommand(mustTime(created.FirstOccurrence.StartsAt), EventAppointment, 4).Recurrence,
		Scope:      SeriesScopeAll,
	}
	update.Title = "Updated recurring meeting"
	updated, err := fixture.Service.UpdateSeries(ctx, fixture.Principal, fixture.Membership, created.Series.ID, update, created.Series.Version)
	if err != nil {
		t.Fatalf("update series: %v", err)
	}
	if inserted, err := fixture.Service.MaterializeSeries(ctx, platform.Now().AddDate(1, 0, 0)); err != nil || inserted != 0 {
		t.Fatalf("materialize existing recipients inserted=%d err=%v", inserted, err)
	}
	var ownerRevisionTwoPublished int
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_series_notification_tasks WHERE series_id=? AND target_membership_id=? AND event_type='PLANNING_SERIES_PUBLISHED' AND series_revision=?`, created.Series.ID, fixture.Membership.ID, updated.currentRevision).Scan(&ownerRevisionTwoPublished); err != nil {
		t.Fatalf("count duplicate owner publication: %v", err)
	}
	if ownerRevisionTwoPublished != 0 {
		t.Fatalf("owner received %d revision-two publication tasks", ownerRevisionTwoPublished)
	}

	_, added := fixture.addMember(t, "series-late", "Late member")
	if _, err := fixture.Service.MaterializeSeries(ctx, platform.Now().AddDate(1, 0, 0)); err != nil {
		t.Fatalf("sync late member: %v", err)
	}
	var audienceCount, publicationCount, ledgerCount int
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_event_audience audience JOIN planning_events event ON event.id=audience.event_id WHERE event.series_id=? AND audience.membership_id=? AND event.starts_at>?`, created.Series.ID, added.ID, platform.Timestamp(platform.Now())).Scan(&audienceCount); err != nil {
		t.Fatalf("count late member audience: %v", err)
	}
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_series_notification_tasks WHERE series_id=? AND target_membership_id=? AND event_type='PLANNING_SERIES_PUBLISHED' AND series_revision=?`, created.Series.ID, added.ID, updated.currentRevision).Scan(&publicationCount); err != nil {
		t.Fatalf("count late member publication: %v", err)
	}
	if audienceCount != 4 || publicationCount != 1 {
		t.Fatalf("late member audience=%d publication tasks=%d", audienceCount, publicationCount)
	}
	if _, err := fixture.DB.ExecContext(ctx, `UPDATE memberships SET status='ARCHIVED',archived_at=? WHERE id=?`, platform.Timestamp(platform.Now()), added.ID); err != nil {
		t.Fatalf("archive late member: %v", err)
	}
	if _, err := fixture.Service.MaterializeSeries(ctx, platform.Now().AddDate(1, 0, 0)); err != nil {
		t.Fatalf("sync archived member: %v", err)
	}
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_event_audience audience JOIN planning_events event ON event.id=audience.event_id WHERE event.series_id=? AND audience.membership_id=?`, created.Series.ID, added.ID).Scan(&audienceCount); err != nil {
		t.Fatalf("count archived audience: %v", err)
	}
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_series_recipients WHERE series_id=? AND membership_id=?`, created.Series.ID, added.ID).Scan(&ledgerCount); err != nil {
		t.Fatalf("count recipient ledger: %v", err)
	}
	if audienceCount != 0 || ledgerCount != 1 {
		t.Fatalf("archived audience=%d ledger=%d", audienceCount, ledgerCount)
	}
}

func TestSeriesUpdatesNotifyOnlyRecipientsAffectedByTheSegment(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	_, first := fixture.addMember(t, "series-target-first", "First target")
	_, second := fixture.addMember(t, "series-target-second", "Second target")
	_, third := fixture.addMember(t, "series-target-third", "Third target")
	command := recurringSeriesCommand(platform.Now().Add(72*time.Hour), EventAppointment, 4)
	command.AudienceType = AudienceSelectedMembers
	command.TargetMembershipIDs = []string{first.ID}
	created, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-affected-0001", command)
	if err != nil {
		t.Fatalf("create targeted series: %v", err)
	}
	boundary := seriesOccurrence(t, fixture, created.Series.ID, 3)
	count := 2
	firstUpdate := SeriesUpdateCommand{
		EventInput: EventInput{
			Title:               "First segment update",
			EventType:           EventAppointment,
			AudienceType:        AudienceSelectedMembers,
			StartsAt:            boundary.StartsAt,
			EndsAt:              boundary.EndsAt,
			TargetMembershipIDs: []string{second.ID},
		},
		Recurrence:          RecurrenceInput{Frequency: RecurrenceDaily, Interval: 1, Range: RecurrenceRangeInput{Type: RecurrenceRangeCount, Count: &count}},
		Scope:               SeriesScopeThisAndFollowing,
		FromOriginalStartAt: boundary.OriginalStartAt,
	}
	updated, err := fixture.Service.UpdateSeries(ctx, fixture.Principal, fixture.Membership, created.Series.ID, firstUpdate, created.Series.Version)
	if err != nil {
		t.Fatalf("replace first segment target: %v", err)
	}
	secondUpdate := firstUpdate
	secondUpdate.Title = "Second segment update"
	secondUpdate.TargetMembershipIDs = []string{third.ID}
	updated, err = fixture.Service.UpdateSeries(ctx, fixture.Principal, fixture.Membership, created.Series.ID, secondUpdate, updated.Version)
	if err != nil {
		t.Fatalf("replace second segment target: %v", err)
	}
	var firstTasks, secondTasks, thirdTasks int
	for membershipID, target := range map[string]*int{first.ID: &firstTasks, second.ID: &secondTasks, third.ID: &thirdTasks} {
		if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_series_notification_tasks WHERE series_id=? AND series_revision=? AND event_type='PLANNING_SERIES_UPDATED' AND target_membership_id=?`, created.Series.ID, updated.currentRevision, membershipID).Scan(target); err != nil {
			t.Fatalf("count revision recipient %s: %v", membershipID, err)
		}
	}
	if firstTasks != 0 || secondTasks != 1 || thirdTasks != 1 {
		t.Fatalf("current revision tasks first=%d second=%d third=%d", firstTasks, secondTasks, thirdTasks)
	}
}

func TestSeriesUsesPinnedTimezoneAndRedactsTargets(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	_, invited := fixture.addMember(t, "series-invited", "Invited member")
	location, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("load Berlin timezone: %v", err)
	}
	localStart := platform.Now().In(location).AddDate(0, 0, 3)
	localStart = time.Date(localStart.Year(), localStart.Month(), localStart.Day(), 0, 30, 0, 0, location)
	command := recurringSeriesCommand(localStart.UTC(), EventAppointment, 3)
	command.AudienceType = AudienceSelectedMembers
	command.TargetMembershipIDs = []string{invited.ID}
	command.Recurrence.Frequency = RecurrenceWeekly
	command.Recurrence.Weekdays = nil
	created, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-timezone-0001", command)
	if err != nil {
		t.Fatalf("create timezone series: %v", err)
	}
	setPlanningTimeZone(t, fixture, "UTC")
	update := SeriesUpdateCommand{EventInput: command.EventInput, Recurrence: command.Recurrence, Scope: SeriesScopeAll}
	updated, err := fixture.Service.UpdateSeries(ctx, fixture.Principal, fixture.Membership, created.Series.ID, update, created.Series.Version)
	if err != nil {
		t.Fatalf("update pinned-timezone series: %v", err)
	}
	wantWeekday := weekdayCode[localStart.Weekday()]
	if updated.TimeZone != "Europe/Berlin" || len(updated.Recurrence.Weekdays) != 1 || updated.Recurrence.Weekdays[0] != wantWeekday {
		t.Fatalf("updated timezone=%s weekdays=%v, want Europe/Berlin and %s", updated.TimeZone, updated.Recurrence.Weekdays, wantWeekday)
	}
	visible, err := fixture.Service.GetSeries(ctx, invited, created.Series.ID)
	if err != nil {
		t.Fatalf("invited member reads series: %v", err)
	}
	if visible.CanEdit || visible.TargetMembershipIDs != nil || visible.TargetRoleIDs != nil {
		t.Fatalf("member-visible series leaked edit targets: %#v", visible)
	}
}

func TestListEventsRejectsOversizedCalendarWindow(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	from := platform.Timestamp(platform.Now())
	to := platform.Timestamp(platform.Now().Add(367 * 24 * time.Hour))
	_, _, err := fixture.Service.ListEvents(ctx, fixture.Membership, from, to, "", "", 20)
	var validation domain.ValidationError
	if !errors.As(err, &validation) || validation.Field != "to" {
		t.Fatalf("oversized calendar error=%v, want to validation", err)
	}
}

func TestDistantSeriesWindowMaterializesIdempotentlyAcrossDSTWithoutAdvancingContinuousHorizon(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	setPlanningTimeZone(t, fixture, "Europe/Berlin")
	location, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatal(err)
	}
	anchor := time.Date(2026, time.September, 4, 9, 0, 0, 0, location)
	if !anchor.After(platform.Now()) {
		anchor = platform.Now().In(location).AddDate(0, 0, 3)
		anchor = time.Date(anchor.Year(), anchor.Month(), anchor.Day(), 9, 0, 0, 0, location)
	}
	command := recurringSeriesCommand(anchor, EventAppointment, 3)
	command.Recurrence.Range = RecurrenceRangeInput{Type: RecurrenceRangeNever}
	created, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-distant-window-0001", command)
	if err != nil {
		t.Fatalf("create never-ending series: %v", err)
	}
	var beforeThrough sql.NullString
	if err := fixture.DB.QueryRowContext(ctx, `SELECT materialized_through FROM planning_series WHERE id=?`, created.Series.ID).Scan(&beforeThrough); err != nil {
		t.Fatal(err)
	}
	transition := nextOffsetTransitionDate(t, location, time.Date(2036, time.January, 1, 12, 0, 0, 0, location))
	fromDate := transition.AddDate(0, 0, -2)
	toDate := transition.AddDate(0, 0, 3)
	from := resolveLocalTime(location, fromDate.Year(), fromDate.Month(), fromDate.Day(), 0, 0, 0, 0)
	to := resolveLocalTime(location, toDate.Year(), toDate.Month(), toDate.Day(), 0, 0, 0, 0)
	query := EventListQuery{From: platform.Timestamp(from), To: platform.Timestamp(to), Limit: 20}

	var beforeCount int
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_events WHERE series_id=?`, created.Series.ID).Scan(&beforeCount); err != nil {
		t.Fatal(err)
	}
	events, _, err := fixture.Service.ListEventsWithQuery(ctx, fixture.Membership, query)
	if err != nil {
		t.Fatalf("materialize distant window: %v", err)
	}
	if len(events) != 5 {
		t.Fatalf("distant window events=%v", eventIDs(events))
	}
	offsets := map[int]struct{}{}
	for _, event := range events {
		local := mustTime(event.StartsAt).In(location)
		if local.Hour() != 9 || local.Minute() != 0 {
			t.Fatalf("distant occurrence lost wall clock: %s", local.Format(time.RFC3339))
		}
		_, offset := local.Zone()
		offsets[offset] = struct{}{}
	}
	if len(offsets) != 2 {
		t.Fatalf("window did not cross a DST offset: %v", offsets)
	}
	var afterFirstCount int
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_events WHERE series_id=?`, created.Series.ID).Scan(&afterFirstCount); err != nil {
		t.Fatal(err)
	}
	if afterFirstCount != beforeCount+5 {
		t.Fatalf("distant materialization count=%d, want %d", afterFirstCount, beforeCount+5)
	}
	if _, _, err := fixture.Service.ListEventsWithQuery(ctx, fixture.Membership, query); err != nil {
		t.Fatalf("repeat distant materialization: %v", err)
	}
	var afterSecondCount int
	var afterThrough sql.NullString
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_events WHERE series_id=?`, created.Series.ID).Scan(&afterSecondCount); err != nil {
		t.Fatal(err)
	}
	if err := fixture.DB.QueryRowContext(ctx, `SELECT materialized_through FROM planning_series WHERE id=?`, created.Series.ID).Scan(&afterThrough); err != nil {
		t.Fatal(err)
	}
	if afterSecondCount != afterFirstCount {
		t.Fatalf("repeat window inserted duplicates: first=%d second=%d", afterFirstCount, afterSecondCount)
	}
	if beforeThrough != afterThrough {
		t.Fatalf("remote window advanced continuous horizon: before=%v after=%v", beforeThrough, afterThrough)
	}
}

func TestMemberReadAndSettingsEnableMaterializeOnlyTheirGroup(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	now := platform.Timestamp(platform.Now())
	if _, err := fixture.DB.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-series-other-admin','other-admin@example.test','Other administrator','hash',?,?)`, now, now); err != nil {
		t.Fatalf("insert other administrator: %v", err)
	}
	otherPrincipal := domain.Principal{UserID: "user-series-other-admin", Email: "other-admin@example.test", DisplayName: "Other administrator"}
	otherGroup, err := (groups.Service{DB: fixture.DB}).Create(ctx, otherPrincipal, "Other planning group", "EUR")
	if err != nil {
		t.Fatalf("create other group: %v", err)
	}
	otherService := Service{DB: fixture.DB}
	otherSettings, err := otherService.GetSettings(ctx, otherGroup.Membership)
	if err != nil {
		t.Fatalf("read other settings: %v", err)
	}
	if _, err := otherService.UpdateSettings(ctx, otherPrincipal, otherGroup.Membership, true, otherSettings.Version); err != nil {
		t.Fatalf("enable other planning: %v", err)
	}
	otherSeries, err := otherService.CreateSeries(ctx, otherPrincipal, otherGroup.Membership, "planning-series-other-group-0001", recurringSeriesCommand(platform.Now().Add(72*time.Hour), EventAppointment, 3))
	if err != nil {
		t.Fatalf("create other series: %v", err)
	}
	if _, err := fixture.DB.ExecContext(ctx, `DELETE FROM planning_events WHERE series_id=? AND series_sequence=3`, otherSeries.Series.ID); err != nil {
		t.Fatalf("remove other occurrence: %v", err)
	}
	from := platform.Timestamp(platform.Now())
	to := platform.Timestamp(platform.Now().Add(30 * 24 * time.Hour))
	if _, _, err := fixture.Service.ListEvents(ctx, fixture.Membership, from, to, "", "", 20); err != nil {
		t.Fatalf("list first group events: %v", err)
	}
	settings, err := fixture.Service.GetSettings(ctx, fixture.Membership)
	if err != nil {
		t.Fatalf("read first settings: %v", err)
	}
	settings, err = fixture.Service.UpdateSettings(ctx, fixture.Principal, fixture.Membership, false, settings.Version)
	if err != nil {
		t.Fatalf("disable first planning: %v", err)
	}
	if _, err := fixture.Service.UpdateSettings(ctx, fixture.Principal, fixture.Membership, true, settings.Version); err != nil {
		t.Fatalf("re-enable first planning: %v", err)
	}
	var otherCount int
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_events WHERE series_id=? AND series_sequence=3`, otherSeries.Series.ID).Scan(&otherCount); err != nil {
		t.Fatalf("count untouched other occurrence: %v", err)
	}
	if otherCount != 0 {
		t.Fatalf("first-group operation materialized %d other-group occurrences", otherCount)
	}
}

func TestConcurrentSeriesMaterializationIsIdempotent(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	created, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-concurrent-0001", recurringSeriesCommand(platform.Now().Add(72*time.Hour), EventAppointment, 4))
	if err != nil {
		t.Fatalf("create series: %v", err)
	}
	if _, err := fixture.DB.ExecContext(ctx, `DELETE FROM planning_events WHERE series_id=? AND series_sequence=4`, created.Series.ID); err != nil {
		t.Fatalf("remove materialized occurrence: %v", err)
	}
	start := make(chan struct{})
	errorsByRun := make(chan error, 2)
	var wait sync.WaitGroup
	for run := 0; run < 2; run++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			_, err := fixture.Service.MaterializeSeries(ctx, platform.Now().AddDate(1, 0, 0))
			errorsByRun <- err
		}()
	}
	close(start)
	wait.Wait()
	close(errorsByRun)
	for err := range errorsByRun {
		if err != nil {
			t.Fatalf("concurrent materialization: %v", err)
		}
	}
	var count int
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_events WHERE series_id=? AND series_sequence=4`, created.Series.ID).Scan(&count); err != nil {
		t.Fatalf("count rematerialized occurrence: %v", err)
	}
	if count != 1 {
		t.Fatalf("rematerialized occurrence count=%d, want 1", count)
	}
}

func TestAllDaySeriesUsesCivilDurationsAcrossDST(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	location, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("load Berlin timezone: %v", err)
	}
	transitionDate := nextOffsetTransitionDate(t, location, platform.Now().AddDate(0, 0, 2))
	startDate := transitionDate.AddDate(0, 0, -2)
	command := allDayRecurringSeriesCommand(startDate, EventAppointment, 5, 1)
	created, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-all-day-dst-0001", command)
	if err != nil {
		t.Fatalf("create all-day series: %v", err)
	}
	if !created.Series.AllDay || created.Series.StartDate != startDate.Format(time.DateOnly) || created.Series.DurationDays != 1 || created.Series.DurationMinutes != 0 {
		t.Fatalf("all-day series projection=%#v", created.Series)
	}
	foundDSTDuration := false
	for sequence := int64(1); sequence <= 5; sequence++ {
		occurrence := seriesOccurrence(t, fixture, created.Series.ID, sequence)
		wantStartDate := startDate.AddDate(0, 0, int(sequence-1)).Format(time.DateOnly)
		wantEndDate := startDate.AddDate(0, 0, int(sequence)).Format(time.DateOnly)
		if !occurrence.AllDay || occurrence.TimeZone != location.String() || occurrence.StartDate != wantStartDate || occurrence.EndDateExclusive != wantEndDate || occurrence.OriginalStartDate == nil || *occurrence.OriginalStartDate != wantStartDate {
			t.Fatalf("occurrence %d schedule=%#v", sequence, occurrence)
		}
		startBoundary, err := calendarDateBoundary("startDate", mustCalendarDate(t, wantStartDate), location)
		if err != nil {
			t.Fatalf("resolve expected start boundary: %v", err)
		}
		endBoundary, err := calendarDateBoundary("endDateExclusive", mustCalendarDate(t, wantEndDate), location)
		if err != nil {
			t.Fatalf("resolve expected end boundary: %v", err)
		}
		if occurrence.StartsAt != platform.Timestamp(startBoundary) || occurrence.EndsAt == nil || *occurrence.EndsAt != platform.Timestamp(endBoundary) {
			t.Fatalf("occurrence %d boundaries start=%s end=%v, want %s and %s", sequence, occurrence.StartsAt, occurrence.EndsAt, platform.Timestamp(startBoundary), platform.Timestamp(endBoundary))
		}
		if endBoundary.Sub(startBoundary) != 24*time.Hour {
			foundDSTDuration = true
		}
	}
	if !foundDSTDuration {
		t.Fatal("all-day series did not include a daylight-saving duration change")
	}
}

func TestCurrentAllDayOccurrenceIsEligibleForSeriesUpdateAndCancellation(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	location, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("load Berlin timezone: %v", err)
	}
	originalNow := platform.Now
	current := time.Date(2026, time.October, 25, 12, 0, 0, 0, location).UTC()
	platform.Now = func() time.Time { return current.AddDate(0, 0, -1) }
	defer func() { platform.Now = originalNow }()
	startDate := time.Date(2026, time.October, 25, 0, 0, 0, 0, time.UTC)
	command := allDayRecurringSeriesCommand(startDate, EventAppointment, 3, 1)
	created, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-current-all-day-0001", command)
	if err != nil {
		t.Fatalf("create current all-day series: %v", err)
	}
	currentOccurrence := seriesOccurrence(t, fixture, created.Series.ID, 1)
	platform.Now = func() time.Time { return current }
	update := SeriesUpdateCommand{EventInput: command.EventInput, Recurrence: command.Recurrence, Scope: SeriesScopeThisAndFollowing, FromOriginalStartAt: currentOccurrence.OriginalStartAt}
	update.Title = "Updated current all-day series"
	updated, err := fixture.Service.UpdateSeries(ctx, fixture.Principal, fixture.Membership, created.Series.ID, update, created.Series.Version)
	if err != nil {
		t.Fatalf("update current all-day segment: %v", err)
	}
	currentOccurrence = seriesOccurrence(t, fixture, created.Series.ID, 1)
	if currentOccurrence.Title != update.Title || currentOccurrence.StartDate != startDate.Format(time.DateOnly) {
		t.Fatalf("updated current occurrence=%#v", currentOccurrence)
	}
	if err := fixture.Service.CancelSeries(ctx, fixture.Principal, fixture.Membership, created.Series.ID, SeriesScopeAll, nil, updated.Version); err != nil {
		t.Fatalf("cancel current all-day series: %v", err)
	}
	var cancelled int
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_events WHERE series_id=? AND status='CANCELLED'`, created.Series.ID).Scan(&cancelled); err != nil {
		t.Fatalf("count cancelled all-day occurrences: %v", err)
	}
	if cancelled != 3 {
		t.Fatalf("cancelled occurrences=%d, want current occurrence plus two future occurrences", cancelled)
	}
}

func TestAllDaySeriesUpdatePreservesManualExceptionAndCancellationIncludesIt(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	location, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("load Berlin timezone: %v", err)
	}
	localStart := platform.Now().In(location).AddDate(0, 0, 3)
	startDate := time.Date(localStart.Year(), localStart.Month(), localStart.Day(), 0, 0, 0, 0, time.UTC)
	command := allDayRecurringSeriesCommand(startDate, EventAppointment, 4, 1)
	created, err := fixture.Service.CreateSeries(ctx, fixture.Principal, fixture.Membership, "planning-series-all-day-exception-0001", command)
	if err != nil {
		t.Fatalf("create all-day series: %v", err)
	}
	second := seriesOccurrence(t, fixture, created.Series.ID, 2)
	exceptionInput := EventInput{
		Title:            "Extended all-day exception",
		EventType:        EventAppointment,
		AudienceType:     AudienceAllActive,
		AllDay:           true,
		TimeZone:         second.TimeZone,
		StartDate:        second.StartDate,
		EndDateExclusive: mustCalendarDate(t, second.EndDateExclusive).AddDate(0, 0, 1).Format(time.DateOnly),
	}
	exception, err := fixture.Service.UpdateEvent(ctx, fixture.Principal, fixture.Membership, second.ID, exceptionInput, second.Version)
	if err != nil {
		t.Fatalf("create all-day exception: %v", err)
	}
	if !exception.IsSeriesException || exception.OriginalStartDate == nil || *exception.OriginalStartDate != second.StartDate {
		t.Fatalf("all-day exception metadata=%#v", exception)
	}
	update := SeriesUpdateCommand{EventInput: command.EventInput, Recurrence: command.Recurrence, Scope: SeriesScopeAll}
	update.Title = "Updated ordinary all-day occurrences"
	updated, err := fixture.Service.UpdateSeries(ctx, fixture.Principal, fixture.Membership, created.Series.ID, update, created.Series.Version)
	if err != nil {
		t.Fatalf("update all-day series: %v", err)
	}
	preserved, err := fixture.Service.GetEvent(ctx, fixture.Membership, exception.ID)
	if err != nil {
		t.Fatalf("read preserved all-day exception: %v", err)
	}
	if preserved.Title != exceptionInput.Title || preserved.EndDateExclusive != exceptionInput.EndDateExclusive || !preserved.IsSeriesException {
		t.Fatalf("preserved all-day exception=%#v", preserved)
	}
	if err := fixture.Service.CancelSeries(ctx, fixture.Principal, fixture.Membership, created.Series.ID, SeriesScopeAll, nil, updated.Version); err != nil {
		t.Fatalf("cancel all-day series with exception: %v", err)
	}
	cancelled, err := fixture.Service.GetEvent(ctx, fixture.Membership, exception.ID)
	if err != nil {
		t.Fatalf("read cancelled all-day exception: %v", err)
	}
	if cancelled.Status != "CANCELLED" || !cancelled.IsSeriesException {
		t.Fatalf("cancelled all-day exception=%#v", cancelled)
	}
}

func recurringSeriesCommand(start time.Time, eventType string, occurrenceCount int) SeriesCreateCommand {
	end := platform.Timestamp(start.Add(time.Hour))
	command := SeriesCreateCommand{
		EventInput: EventInput{
			Title:        "Recurring meeting",
			EventType:    eventType,
			AudienceType: AudienceAllActive,
			StartsAt:     platform.Timestamp(start),
			EndsAt:       &end,
		},
		Recurrence: RecurrenceInput{
			Frequency: RecurrenceDaily,
			Interval:  1,
			Range:     RecurrenceRangeInput{Type: RecurrenceRangeCount, Count: &occurrenceCount},
		},
	}
	if eventType != EventAppointment {
		command.ResponseDeadlineMinutesBefore = intPointer(120)
	}
	return command
}

func allDayRecurringSeriesCommand(startDate time.Time, eventType string, occurrenceCount, durationDays int) SeriesCreateCommand {
	command := SeriesCreateCommand{
		EventInput: EventInput{
			Title:            "Recurring all-day event",
			EventType:        eventType,
			AudienceType:     AudienceAllActive,
			AllDay:           true,
			StartDate:        startDate.Format(time.DateOnly),
			EndDateExclusive: startDate.AddDate(0, 0, durationDays).Format(time.DateOnly),
		},
		Recurrence: RecurrenceInput{
			Frequency: RecurrenceDaily,
			Interval:  1,
			Range:     RecurrenceRangeInput{Type: RecurrenceRangeCount, Count: &occurrenceCount},
		},
	}
	if eventType != EventAppointment {
		command.ResponseDeadlineMinutesBefore = intPointer(120)
	}
	return command
}

func mustCalendarDate(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.DateOnly, value)
	if err != nil {
		t.Fatalf("parse calendar date %q: %v", value, err)
	}
	return parsed
}

func nextOffsetTransitionDate(t *testing.T, location *time.Location, after time.Time) time.Time {
	t.Helper()
	local := after.In(location)
	previous := time.Date(local.Year(), local.Month(), local.Day(), 12, 0, 0, 0, location)
	_, previousOffset := previous.Zone()
	for days := 1; days <= 400; days++ {
		candidate := previous.AddDate(0, 0, days)
		_, offset := candidate.Zone()
		if offset != previousOffset {
			return time.Date(candidate.Year(), candidate.Month(), candidate.Day(), 0, 0, 0, 0, time.UTC)
		}
	}
	t.Fatal("no timezone offset transition found within 400 days")
	return time.Time{}
}

func seriesOccurrence(t *testing.T, fixture planningServiceFixture, seriesID string, sequence int64) Event {
	t.Helper()
	var eventID string
	if err := fixture.DB.QueryRowContext(context.Background(), `SELECT id FROM planning_events WHERE series_id=? AND series_sequence=?`, seriesID, sequence).Scan(&eventID); err != nil {
		t.Fatalf("find series occurrence %d: %v", sequence, err)
	}
	event, err := fixture.Service.GetEvent(context.Background(), fixture.Membership, eventID)
	if err != nil {
		t.Fatalf("read series occurrence %d: %v", sequence, err)
	}
	return event
}
