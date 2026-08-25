package httpapi

import (
	"net/http"

	"github.com/DasLukas/TeamTaler/internal/activities"
)

// handleActivities returns the authenticated membership's globally paginated
// unified booking, payment, and adjustment feed.
func (s *Server) handleActivities(response http.ResponseWriter, request *http.Request) {
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
	query := activities.Query{
		Search: values.Get("q"), Kinds: values["kind"], TargetMembershipID: values.Get("targetMembershipId"),
		CategoryIDs: values["categoryId"], ProductIDs: values["productId"], Status: values.Get("status"),
		OccurredFrom: values.Get("occurredFrom"), OccurredTo: values.Get("occurredTo"),
		AmountMin: amountMin, AmountMax: amountMax, Sort: values.Get("sort"), Direction: values.Get("direction"),
		Cursor: values.Get("cursor"), Limit: queryLimit(request),
	}
	page, err := s.activities.QueryEntries(request.Context(), membership, query)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeTablePageHeaders(response, page.NextCursor, query.Limit)
	writeJSON(response, http.StatusOK, page.Items)
}

// handleActivityFilterOptions returns transaction kind, member, and booking
// catalog choices from the same authorized source scope as handleActivities.
func (s *Server) handleActivityFilterOptions(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	options, err := s.activities.ListFilterOptions(request.Context(), membership)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, options)
}
