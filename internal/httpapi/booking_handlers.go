package httpapi

import (
	"net/http"

	"github.com/DasLukas/TeamTaler/internal/bookings"
)

// handleBookingContext returns the single privacy-minimized read model required
// by the booking page and never exposes member emails, roles, or grants as targets.
func (s *Server) handleBookingContext(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.bookings.Context(request.Context(), membership)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, item)
}

func (s *Server) handleListBookings(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	amountMin, err := optionalInt64Query(request, "amountMin")
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	amountMax, err := optionalInt64Query(request, "amountMax")
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	values := request.URL.Query()
	query := bookings.ActivityQuery{
		Search: values.Get("q"), PeriodID: values.Get("periodId"),
		ActorMembershipID: values.Get("actorMembershipId"), TargetMembershipID: values.Get("targetMembershipId"),
		CategoryID: values.Get("categoryId"), ProductID: values.Get("productId"), Status: values.Get("status"),
		CreatedFrom: values.Get("createdFrom"), CreatedTo: values.Get("createdTo"), AmountMin: amountMin, AmountMax: amountMax,
		Sort: values.Get("sort"), Direction: values.Get("direction"), Cursor: values.Get("cursor"), Limit: queryLimit(request),
	}
	page, err := s.bookings.QueryActivity(request.Context(), membership, query)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeTablePageHeaders(response, page.NextCursor, query.Limit)
	writeJSON(response, http.StatusOK, page.Items)
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

// handleCreateBookingBulk creates a complete multi-product, multi-target cart
// as one idempotent transaction and returns bookings in item-major order.
func (s *Server) handleCreateBookingBulk(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input bookings.BulkCreateInput
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	items, err := s.bookings.CreateBulk(request.Context(), principal, membership, request.Header.Get("Idempotency-Key"), input)
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
