package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/planning"
)

func TestPlanningSeriesHandlersEnforcePreconditionsScopesAndBundledNotifications(t *testing.T) {
	server, principal, administrator := invitationImportServer(t, false)
	server.planning = planning.Service{DB: server.db}
	ctx := context.Background()
	settings, err := server.planning.GetSettings(ctx, administrator)
	if err != nil {
		t.Fatalf("get planning settings: %v", err)
	}
	if _, err := server.planning.UpdateSettings(ctx, principal, administrator, true, settings.Version); err != nil {
		t.Fatalf("enable planning: %v", err)
	}

	startsAt := time.Now().UTC().Add(48 * time.Hour).Truncate(time.Minute)
	endsAt := startsAt.Add(time.Hour).Format(time.RFC3339)
	deadlineLead := 90
	occurrenceCount := 3
	createCommand := planning.SeriesCreateCommand{
		EventInput: planning.EventInput{
			Title:                         "Weekly lunch",
			Description:                   "A recurring response poll.",
			Location:                      "Kitchen",
			EventType:                     planning.EventAppointmentPoll,
			AudienceType:                  planning.AudienceAllActive,
			StartsAt:                      startsAt.Format(time.RFC3339),
			EndsAt:                        &endsAt,
			ResponseDeadlineMinutesBefore: &deadlineLead,
		},
		Recurrence: planning.RecurrenceInput{
			Frequency: planning.RecurrenceWeekly,
			Interval:  1,
			Range: planning.RecurrenceRangeInput{
				Type:  planning.RecurrenceRangeCount,
				Count: &occurrenceCount,
			},
		},
	}
	createBody, err := json.Marshal(createCommand)
	if err != nil {
		t.Fatalf("encode create series command: %v", err)
	}
	create := roleHandlerRequest(principal, administrator.GroupID, http.MethodPost, string(createBody))
	create.Header.Set("Idempotency-Key", "http-series-create")
	createdResponse := httptest.NewRecorder()
	server.handleCreatePlanningSeries(createdResponse, create)
	if createdResponse.Code != http.StatusCreated {
		t.Fatalf("create series status=%d body=%s", createdResponse.Code, createdResponse.Body.String())
	}
	var created planning.SeriesCreateResult
	if err := json.Unmarshal(createdResponse.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created series: %v", err)
	}
	if created.Series.Status != "PUBLISHED" || created.Series.Version != 1 || created.FirstOccurrence.SeriesID == nil || *created.FirstOccurrence.SeriesID != created.Series.ID {
		t.Fatalf("created series=%#v firstOccurrence=%#v", created.Series, created.FirstOccurrence)
	}
	if got := createdResponse.Header().Get("ETag"); got != versionETag(created.Series.Version) {
		t.Fatalf("create series ETag=%q want=%q", got, versionETag(created.Series.Version))
	}

	replay := roleHandlerRequest(principal, administrator.GroupID, http.MethodPost, string(createBody))
	replay.Header.Set("Idempotency-Key", "http-series-create")
	replayResponse := httptest.NewRecorder()
	server.handleCreatePlanningSeries(replayResponse, replay)
	var replayed planning.SeriesCreateResult
	if replayResponse.Code != http.StatusCreated || json.Unmarshal(replayResponse.Body.Bytes(), &replayed) != nil || replayed.Series.ID != created.Series.ID || replayed.FirstOccurrence.ID != created.FirstOccurrence.ID {
		t.Fatalf("replayed series status=%d body=%s", replayResponse.Code, replayResponse.Body.String())
	}

	updateCommand := planning.SeriesUpdateCommand{
		EventInput: createCommand.EventInput,
		Recurrence: createCommand.Recurrence,
		Scope:      planning.SeriesScopeAll,
	}
	updateCommand.Title = "Updated weekly lunch"
	updateBody, err := json.Marshal(updateCommand)
	if err != nil {
		t.Fatalf("encode update series command: %v", err)
	}
	missingIfMatch := roleHandlerRequest(principal, administrator.GroupID, http.MethodPut, string(updateBody))
	missingIfMatch.SetPathValue("seriesID", created.Series.ID)
	missingIfMatchResponse := httptest.NewRecorder()
	server.handleUpdatePlanningSeries(missingIfMatchResponse, missingIfMatch)
	if missingIfMatchResponse.Code != http.StatusPreconditionFailed {
		t.Fatalf("missing series If-Match status=%d body=%s", missingIfMatchResponse.Code, missingIfMatchResponse.Body.String())
	}

	invalidScopeCommand := updateCommand
	invalidScopeCommand.Scope = "THIS"
	invalidScopeBody, err := json.Marshal(invalidScopeCommand)
	if err != nil {
		t.Fatalf("encode invalid-scope command: %v", err)
	}
	invalidScope := roleHandlerRequest(principal, administrator.GroupID, http.MethodPut, string(invalidScopeBody))
	invalidScope.SetPathValue("seriesID", created.Series.ID)
	invalidScope.Header.Set("If-Match", versionETag(created.Series.Version))
	invalidScopeResponse := httptest.NewRecorder()
	server.handleUpdatePlanningSeries(invalidScopeResponse, invalidScope)
	if invalidScopeResponse.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid series scope status=%d body=%s", invalidScopeResponse.Code, invalidScopeResponse.Body.String())
	}

	update := roleHandlerRequest(principal, administrator.GroupID, http.MethodPut, string(updateBody))
	update.SetPathValue("seriesID", created.Series.ID)
	update.Header.Set("If-Match", versionETag(created.Series.Version))
	updatedResponse := httptest.NewRecorder()
	server.handleUpdatePlanningSeries(updatedResponse, update)
	if updatedResponse.Code != http.StatusOK {
		t.Fatalf("update series status=%d body=%s", updatedResponse.Code, updatedResponse.Body.String())
	}
	var updated planning.Series
	if err := json.Unmarshal(updatedResponse.Body.Bytes(), &updated); err != nil {
		t.Fatalf("decode updated series: %v", err)
	}
	if updated.Title != updateCommand.Title || updated.Version <= created.Series.Version || updatedResponse.Header().Get("ETag") != versionETag(updated.Version) {
		t.Fatalf("updated series=%#v ETag=%q", updated, updatedResponse.Header().Get("ETag"))
	}

	var secondOriginalStartAt string
	if err := server.db.QueryRowContext(ctx, `SELECT original_start_at FROM planning_events WHERE series_id=? ORDER BY series_sequence LIMIT 1 OFFSET 1`, created.Series.ID).Scan(&secondOriginalStartAt); err != nil {
		t.Fatalf("load second occurrence: %v", err)
	}
	cancelBody, err := json.Marshal(map[string]any{
		"scope":               planning.SeriesScopeThisAndFollowing,
		"fromOriginalStartAt": secondOriginalStartAt,
	})
	if err != nil {
		t.Fatalf("encode series cancellation: %v", err)
	}
	cancel := roleHandlerRequest(principal, administrator.GroupID, http.MethodPost, string(cancelBody))
	cancel.SetPathValue("seriesID", created.Series.ID)
	cancel.Header.Set("If-Match", versionETag(updated.Version))
	cancelledResponse := httptest.NewRecorder()
	server.handleCancelPlanningSeries(cancelledResponse, cancel)
	if cancelledResponse.Code != http.StatusNoContent || cancelledResponse.Body.Len() != 0 {
		t.Fatalf("cancel future series segment status=%d body=%s", cancelledResponse.Code, cancelledResponse.Body.String())
	}

	get := roleHandlerRequest(principal, administrator.GroupID, http.MethodGet, "")
	get.SetPathValue("seriesID", created.Series.ID)
	getResponse := httptest.NewRecorder()
	server.handleGetPlanningSeries(getResponse, get)
	var afterCancellation planning.Series
	if getResponse.Code != http.StatusOK || json.Unmarshal(getResponse.Body.Bytes(), &afterCancellation) != nil {
		t.Fatalf("get series status=%d body=%s", getResponse.Code, getResponse.Body.String())
	}
	if afterCancellation.Status != "PUBLISHED" || afterCancellation.Version <= updated.Version || getResponse.Header().Get("ETag") != versionETag(afterCancellation.Version) {
		t.Fatalf("series after segment cancellation=%#v ETag=%q", afterCancellation, getResponse.Header().Get("ETag"))
	}
	assertHTTPPlanningCount(t, server, `SELECT count(*) FROM planning_events WHERE series_id=? AND status='PUBLISHED'`, []any{created.Series.ID}, 1)
	assertHTTPPlanningCount(t, server, `SELECT count(*) FROM planning_events WHERE series_id=? AND status='CANCELLED'`, []any{created.Series.ID}, 2)
	assertHTTPPlanningCount(t, server, `SELECT count(*) FROM planning_notification_tasks WHERE event_id IN (SELECT id FROM planning_events WHERE series_id=?) AND event_type='PLANNING_EVENT_PUBLISHED'`, []any{created.Series.ID}, 0)
	assertHTTPPlanningCount(t, server, `SELECT count(*) FROM planning_series_notification_tasks WHERE series_id=?`, []any{created.Series.ID}, 3)

	currentSettings, err := server.planning.GetSettings(ctx, administrator)
	if err != nil {
		t.Fatalf("reload planning settings: %v", err)
	}
	if _, err := server.planning.UpdateSettings(ctx, principal, administrator, false, currentSettings.Version); err != nil {
		t.Fatalf("disable planning: %v", err)
	}
	disabled := roleHandlerRequest(principal, administrator.GroupID, http.MethodGet, "")
	disabled.SetPathValue("seriesID", created.Series.ID)
	disabledResponse := httptest.NewRecorder()
	server.handleGetPlanningSeries(disabledResponse, disabled)
	var disabledProblem problem
	if disabledResponse.Code != http.StatusConflict || json.Unmarshal(disabledResponse.Body.Bytes(), &disabledProblem) != nil || disabledProblem.Code != "PLANNING_DISABLED" {
		t.Fatalf("disabled planning response status=%d body=%s", disabledResponse.Code, disabledResponse.Body.String())
	}
	assertHTTPPlanningCount(t, server, `SELECT count(*) FROM planning_series_notification_tasks WHERE series_id=? AND status='PENDING'`, []any{created.Series.ID}, 0)
}

func assertHTTPPlanningCount(t *testing.T, server *Server, query string, args []any, want int) {
	t.Helper()
	var got int
	if err := server.db.QueryRowContext(context.Background(), query, args...).Scan(&got); err != nil {
		t.Fatalf("query planning HTTP state: %v", err)
	}
	if got != want {
		t.Fatalf("planning HTTP state count=%d want=%d for %q", got, want, query)
	}
}
