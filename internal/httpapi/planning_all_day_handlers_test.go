package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/planning"
)

func TestPlanningEventHandlerAcceptsAllDaySchedule(t *testing.T) {
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

	body := `{"title":"All-day planning","eventType":"APPOINTMENT","audienceType":"ALL_ACTIVE_MEMBERS","allDay":true,"startDate":"2026-03-29","endDateExclusive":"2026-03-30"}`
	request := roleHandlerRequest(principal, administrator.GroupID, http.MethodPost, body)
	request.Header.Set("Idempotency-Key", "http-all-day-event-0001")
	response := httptest.NewRecorder()
	server.handleCreatePlanningEvent(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("create all-day event status=%d body=%s", response.Code, response.Body.String())
	}
	var event planning.Event
	if err := json.Unmarshal(response.Body.Bytes(), &event); err != nil {
		t.Fatalf("decode all-day event: %v", err)
	}
	if !event.AllDay || event.TimeZone != "Europe/Berlin" || event.StartDate != "2026-03-29" || event.EndDateExclusive != "2026-03-30" || event.StartsAt != "2026-03-28T23:00:00Z" || event.EndsAt == nil || *event.EndsAt != "2026-03-29T22:00:00Z" {
		t.Fatalf("all-day event response=%#v", event)
	}

	listRequest := roleHandlerRequest(principal, administrator.GroupID, http.MethodGet, "")
	listRequest.URL.RawQuery = "fromDate=2026-03-29&toDateExclusive=2026-03-30&limit=20"
	listResponse := httptest.NewRecorder()
	server.handleListPlanningEvents(listResponse, listRequest)
	var page struct {
		Items []planning.Event `json:"items"`
	}
	if listResponse.Code != http.StatusOK || json.Unmarshal(listResponse.Body.Bytes(), &page) != nil {
		t.Fatalf("list civil all-day window status=%d body=%s", listResponse.Code, listResponse.Body.String())
	}
	if len(page.Items) != 1 || page.Items[0].ID != event.ID {
		t.Fatalf("civil all-day page=%#v", page.Items)
	}
	invalidList := roleHandlerRequest(principal, administrator.GroupID, http.MethodGet, "")
	invalidList.URL.RawQuery = "fromDate=2026-03-29"
	invalidListResponse := httptest.NewRecorder()
	server.handleListPlanningEvents(invalidListResponse, invalidList)
	if invalidListResponse.Code != http.StatusUnprocessableEntity {
		t.Fatalf("incomplete civil range status=%d body=%s", invalidListResponse.Code, invalidListResponse.Body.String())
	}

	mixedRequest := roleHandlerRequest(principal, administrator.GroupID, http.MethodPost, `{"title":"Mixed","eventType":"APPOINTMENT","audienceType":"ALL_ACTIVE_MEMBERS","allDay":true,"startDate":"2026-03-29","endDateExclusive":"2026-03-30","startsAt":"2026-03-29T10:00:00Z"}`)
	mixedRequest.Header.Set("Idempotency-Key", "http-all-day-event-invalid-0001")
	mixedResponse := httptest.NewRecorder()
	server.handleCreatePlanningEvent(mixedResponse, mixedRequest)
	if mixedResponse.Code != http.StatusUnprocessableEntity {
		t.Fatalf("mixed all-day schedule status=%d body=%s", mixedResponse.Code, mixedResponse.Body.String())
	}
}
