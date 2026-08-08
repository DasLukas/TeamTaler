package httpapi

import (
	"net/http"

	"github.com/DasLukas/TeamTaler/internal/bookings"
)

func (s *Server) handleListBookings(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	items, err := s.bookings.ListActivity(request.Context(), membership, request.URL.Query().Get("periodId"), queryLimit(request))
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, items)
}

func (s *Server) handleCreateBooking(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input bookings.CreateInput
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.bookings.Create(request.Context(), principal, membership, request.Header.Get("Idempotency-Key"), input)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusCreated, item)
}

func (s *Server) handleCreateBookingBatch(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input bookings.BatchCreateInput
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	items, err := s.bookings.CreateBatch(request.Context(), principal, membership, request.Header.Get("Idempotency-Key"), input)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusCreated, items)
}

func (s *Server) handleVoidBooking(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		Reason string `json:"reason"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.bookings.Void(request.Context(), principal, membership, request.Header.Get("Idempotency-Key"), request.PathValue("bookingID"), input.Reason)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, item)
}
