package httpapi

import (
	"net/http"

	"github.com/DasLukas/TeamTaler/internal/finance"
)

func (s *Server) handleOwnAccount(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	account, err := s.finance.Account(request.Context(), membership, membership.ID)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, account)
}

func (s *Server) handleMemberAccount(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	account, err := s.finance.Account(request.Context(), membership, request.PathValue("membershipID"))
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, account)
}

// handleListAccounts returns consolidated member balances to finance managers.
// The request supplies the authenticated group and response receives the exact
// minor-unit account summaries or Problem Details.
func (s *Server) handleListAccounts(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	items, err := s.finance.ListAccountSummaries(request.Context(), membership)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, items)
}

func (s *Server) handleListPayments(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	items, err := s.finance.ListPayments(request.Context(), membership, queryLimit(request))
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, items)
}

func (s *Server) handleCreatePayment(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input finance.CreatePaymentInput
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.finance.CreatePayment(request.Context(), principal, membership, request.Header.Get("Idempotency-Key"), input)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusCreated, item)
}

// handleCreateOwnPayment records received money for the authenticated
// membership. The request cannot choose a target membership; authorization and
// target derivation remain server-side.
func (s *Server) handleCreateOwnPayment(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input finance.CreateOwnPaymentInput
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.finance.CreateOwnPayment(request.Context(), principal, membership, request.Header.Get("Idempotency-Key"), input)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusCreated, item)
}

func (s *Server) handleReversePayment(response http.ResponseWriter, request *http.Request) {
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
	if err := s.finance.ReversePayment(request.Context(), principal, membership, request.Header.Get("Idempotency-Key"), request.PathValue("paymentID"), input.Reason); err != nil {
		writeProblem(response, request, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}
