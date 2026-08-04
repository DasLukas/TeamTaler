package httpapi

import (
	"net/http"

	"github.com/DasLukas/TeamTaler/internal/periods"
)

func (s *Server) handleListPeriods(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	items, err := s.periods.List(request.Context(), membership.GroupID)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, items)
}

func (s *Server) handleClosePeriod(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input periods.CloseInput
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	result, err := s.periods.Close(request.Context(), principal, membership, request.Header.Get("Idempotency-Key"), request.PathValue("periodID"), input)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func (s *Server) handleStatements(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	periodID := request.PathValue("periodID")
	if err := s.periods.EnsurePeriodInGroup(request.Context(), membership.GroupID, periodID); err != nil {
		writeProblem(response, request, err)
		return
	}
	items, err := s.periods.Statements(request.Context(), membership, periodID)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, items)
}

func (s *Server) handleSettlements(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	items, err := s.periods.Statements(request.Context(), membership, request.URL.Query().Get("periodId"))
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, items)
}
