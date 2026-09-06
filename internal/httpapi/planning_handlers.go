package httpapi

import (
	"net/http"
	"strconv"

	"github.com/DasLukas/TeamTaler/internal/planning"
)

func (s *Server) handleGetPlanningSettings(w http.ResponseWriter, r *http.Request) {
	_, membership, err := s.membership(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	item, err := s.planning.GetSettings(r.Context(), membership)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	w.Header().Set("ETag", versionETag(item.Version))
	writeJSON(w, http.StatusOK, item)
}
func (s *Server) handleUpdatePlanningSettings(w http.ResponseWriter, r *http.Request) {
	actor, membership, err := s.membership(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	version, err := requiredIfMatchVersion(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	var input struct {
		Enabled bool `json:"enabled"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		writeProblem(w, r, err)
		return
	}
	item, err := s.planning.UpdateSettings(r.Context(), actor, membership, input.Enabled, version)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	w.Header().Set("ETag", versionETag(item.Version))
	writeJSON(w, http.StatusOK, item)
}
func (s *Server) handleListPlanningEvents(w http.ResponseWriter, r *http.Request) {
	_, m, err := s.membership(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	items, next, err := s.planning.ListEventsWithQuery(r.Context(), m, planning.EventListQuery{
		From:            r.URL.Query().Get("from"),
		To:              r.URL.Query().Get("to"),
		FromDate:        r.URL.Query().Get("fromDate"),
		ToDateExclusive: r.URL.Query().Get("toDateExclusive"),
		Status:          r.URL.Query().Get("status"),
		Cursor:          r.URL.Query().Get("cursor"),
		Limit:           limit,
	})
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "nextCursor": next})
}
func (s *Server) handleCreatePlanningEvent(w http.ResponseWriter, r *http.Request) {
	a, m, err := s.membership(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	var input planning.EventInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeProblem(w, r, err)
		return
	}
	item, err := s.planning.CreateEvent(r.Context(), a, m, r.Header.Get("Idempotency-Key"), input)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	w.Header().Set("ETag", versionETag(item.Version))
	writeJSON(w, http.StatusCreated, item)
}
func (s *Server) handleGetPlanningEvent(w http.ResponseWriter, r *http.Request) {
	_, m, err := s.membership(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	item, err := s.planning.GetEvent(r.Context(), m, r.PathValue("eventID"))
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	w.Header().Set("ETag", versionETag(item.Version))
	writeJSON(w, http.StatusOK, item)
}
func (s *Server) handleUpdatePlanningEvent(w http.ResponseWriter, r *http.Request) {
	a, m, err := s.membership(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	v, err := requiredIfMatchVersion(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	var input planning.EventInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeProblem(w, r, err)
		return
	}
	item, err := s.planning.UpdateEvent(r.Context(), a, m, r.PathValue("eventID"), input, v)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	w.Header().Set("ETag", versionETag(item.Version))
	writeJSON(w, http.StatusOK, item)
}
func (s *Server) planningTransition(w http.ResponseWriter, r *http.Request, target string) {
	a, m, err := s.membership(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	v, err := requiredIfMatchVersion(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	item, err := s.planning.Transition(r.Context(), a, m, r.PathValue("eventID"), target, v)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	w.Header().Set("ETag", versionETag(item.Version))
	writeJSON(w, http.StatusOK, item)
}
func (s *Server) handleClosePlanningEvent(w http.ResponseWriter, r *http.Request) {
	s.planningTransition(w, r, "CLOSED")
}
func (s *Server) handleCompletePlanningEvent(w http.ResponseWriter, r *http.Request) {
	s.planningTransition(w, r, "COMPLETED")
}
func (s *Server) handleCancelPlanningEvent(w http.ResponseWriter, r *http.Request) {
	s.planningTransition(w, r, "CANCELLED")
}
func (s *Server) handleSetPlanningParticipation(w http.ResponseWriter, r *http.Request) {
	a, m, err := s.membership(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	var input struct {
		Status string `json:"status"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		writeProblem(w, r, err)
		return
	}
	_, err = s.planning.SetParticipation(r.Context(), a, m, r.PathValue("eventID"), input.Status)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	item, err := s.planning.GetEvent(r.Context(), m, r.PathValue("eventID"))
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	w.Header().Set("ETag", versionETag(item.Version))
	writeJSON(w, http.StatusOK, item)
}
func (s *Server) handleListPlanningParticipants(w http.ResponseWriter, r *http.Request) {
	_, m, err := s.membership(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	items, next, err := s.planning.Participants(r.Context(), m, r.PathValue("eventID"), r.URL.Query().Get("cursor"), limit)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "nextCursor": next})
}

func (s *Server) handleCreatePlanningSeries(w http.ResponseWriter, r *http.Request) {
	a, m, err := s.membership(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	var command planning.SeriesCreateCommand
	if err := decodeJSON(w, r, &command); err != nil {
		writeProblem(w, r, err)
		return
	}
	result, err := s.planning.CreateSeries(r.Context(), a, m, r.Header.Get("Idempotency-Key"), command)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	w.Header().Set("ETag", versionETag(result.Series.Version))
	writeJSON(w, http.StatusCreated, result)
}

func (s *Server) handleGetPlanningSeries(w http.ResponseWriter, r *http.Request) {
	_, m, err := s.membership(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	item, err := s.planning.GetSeries(r.Context(), m, r.PathValue("seriesID"))
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	w.Header().Set("ETag", versionETag(item.Version))
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) handleUpdatePlanningSeries(w http.ResponseWriter, r *http.Request) {
	a, m, err := s.membership(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	version, err := requiredIfMatchVersion(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	var command planning.SeriesUpdateCommand
	if err := decodeJSON(w, r, &command); err != nil {
		writeProblem(w, r, err)
		return
	}
	item, err := s.planning.UpdateSeries(r.Context(), a, m, r.PathValue("seriesID"), command, version)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	w.Header().Set("ETag", versionETag(item.Version))
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) handleCancelPlanningSeries(w http.ResponseWriter, r *http.Request) {
	a, m, err := s.membership(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	version, err := requiredIfMatchVersion(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	var input struct {
		Scope               planning.SeriesMutationScope `json:"scope"`
		FromOriginalStartAt *string                      `json:"fromOriginalStartAt"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		writeProblem(w, r, err)
		return
	}
	if err := s.planning.CancelSeries(r.Context(), a, m, r.PathValue("seriesID"), input.Scope, input.FromOriginalStartAt, version); err != nil {
		writeProblem(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
