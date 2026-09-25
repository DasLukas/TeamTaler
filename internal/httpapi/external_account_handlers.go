package httpapi

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/externalaccounts"
)

const externalAccountsConfigETagHeader = "X-External-Accounts-Config-ETag"

func (s *Server) externalAccountManager(w http.ResponseWriter, r *http.Request) (domain.Principal, domain.Membership, bool) {
	principal, membership, err := s.membership(r)
	if err == nil {
		err = s.externalAccounts.AuthorizeManagement(r.Context(), membership)
	}
	if err != nil {
		writeProblem(w, r, err)
		return domain.Principal{}, domain.Membership{}, false
	}
	return principal, membership, true
}

func (s *Server) handleListExternalAccounts(w http.ResponseWriter, r *http.Request) {
	_, membership, err := s.membership(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	result, err := s.externalAccounts.ListAccounts(r.Context(), membership)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	writeExternalAccountCollection(w, r, result, nil, http.StatusOK)
}

func (s *Server) handleCreateExternalAccount(w http.ResponseWriter, r *http.Request) {
	principal, membership, ok := s.externalAccountManager(w, r)
	if !ok {
		return
	}
	var input externalaccounts.CreateAccountInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeProblem(w, r, err)
		return
	}
	version, err := requiredIfMatchVersion(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	result, err := s.externalAccounts.CreateAccount(r.Context(), principal, membership, r.Header.Get("Idempotency-Key"), version, input)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	writeExternalAccountCollection(w, r, result, nil, http.StatusCreated)
}

func (s *Server) handleUpdateExternalAccount(w http.ResponseWriter, r *http.Request) {
	principal, membership, ok := s.externalAccountManager(w, r)
	if !ok {
		return
	}
	version, err := requiredIfMatchVersion(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	var input externalaccounts.AccountInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeProblem(w, r, err)
		return
	}
	result, err := s.externalAccounts.UpdateAccount(r.Context(), principal, membership, r.PathValue("externalAccountID"), input, version)
	writeExternalAccountCollection(w, r, result, err, http.StatusOK)
}

func (s *Server) handleArchiveExternalAccount(w http.ResponseWriter, r *http.Request) {
	s.handleSetExternalAccountArchived(w, r, true)
}

func (s *Server) handleReactivateExternalAccount(w http.ResponseWriter, r *http.Request) {
	s.handleSetExternalAccountArchived(w, r, false)
}

func (s *Server) handleSetExternalAccountArchived(w http.ResponseWriter, r *http.Request, archived bool) {
	principal, membership, ok := s.externalAccountManager(w, r)
	if !ok {
		return
	}
	version, err := requiredIfMatchVersion(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	result, err := s.externalAccounts.SetAccountArchived(r.Context(), principal, membership, r.PathValue("externalAccountID"), archived, version)
	writeExternalAccountCollection(w, r, result, err, http.StatusOK)
}

func (s *Server) handleDeleteExternalAccount(w http.ResponseWriter, r *http.Request) {
	principal, membership, ok := s.externalAccountManager(w, r)
	if !ok {
		return
	}
	version, err := requiredIfMatchVersion(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	result, err := s.externalAccounts.DeleteAccount(r.Context(), principal, membership, r.PathValue("externalAccountID"), version)
	writeExternalAccountCollection(w, r, result, err, http.StatusOK)
}

func (s *Server) handleReorderExternalAccounts(w http.ResponseWriter, r *http.Request) {
	principal, membership, ok := s.externalAccountManager(w, r)
	if !ok {
		return
	}
	version, err := requiredIfMatchVersion(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	var input struct {
		AccountIDs []string `json:"accountIds"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		writeProblem(w, r, err)
		return
	}
	result, err := s.externalAccounts.ReorderAccounts(r.Context(), principal, membership, input.AccountIDs, version)
	writeExternalAccountCollection(w, r, result, err, http.StatusOK)
}

func writeExternalAccountCollection(w http.ResponseWriter, r *http.Request, result externalaccounts.AccountCollection, err error, status int) {
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	// The collection includes ledger-derived balances, so its configuration
	// version is deliberately exposed as a concurrency token rather than an
	// HTTP representation validator.
	w.Header().Set(externalAccountsConfigETagHeader, versionETag(result.Version))
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, status, result)
}

func (s *Server) handleListExternalAccountLinks(w http.ResponseWriter, r *http.Request) {
	_, membership, err := s.membership(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	result, err := s.externalAccounts.ListPaymentMethodLinks(r.Context(), membership)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	w.Header().Set("ETag", versionETag(result.Version))
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleReplaceExternalAccountLinks(w http.ResponseWriter, r *http.Request) {
	principal, membership, ok := s.externalAccountManager(w, r)
	if !ok {
		return
	}
	version, err := requiredIfMatchVersion(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	var input externalaccounts.ReplaceLinksInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeProblem(w, r, err)
		return
	}
	result, err := s.externalAccounts.ReplacePaymentMethodLinks(r.Context(), principal, membership, input, version)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	w.Header().Set("ETag", versionETag(result.Version))
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleListExternalAccountTransactions(w http.ResponseWriter, r *http.Request) {
	_, membership, err := s.membership(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	query, err := externalAccountTransactionQuery(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	result, err := s.externalAccounts.QueryTransactions(r.Context(), membership, query)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	if result.NextCursor != "" {
		w.Header().Set("X-Next-Cursor", result.NextCursor)
	}
	writeJSON(w, http.StatusOK, result.Items)
}

func externalAccountTransactionQuery(r *http.Request) (externalaccounts.TransactionQuery, error) {
	values := r.URL.Query()
	accountIDs := append([]string{}, values["accountId"]...)
	accountIDs = append(accountIDs, values["accountIds"]...)
	query := externalaccounts.TransactionQuery{Search: values.Get("q"), AccountIDs: accountIDs, Kinds: values["kind"], Source: values.Get("source"), Status: values.Get("status"), OccurredFrom: values.Get("occurredFrom"), OccurredTo: values.Get("occurredTo"), Sort: values.Get("sort"), Direction: values.Get("direction"), Cursor: values.Get("cursor"), Limit: queryLimit(r)}
	for field, target := range map[string]**int64{"amountMin": &query.AmountMin, "amountMax": &query.AmountMax} {
		if raw := strings.TrimSpace(values.Get(field)); raw != "" {
			value, err := strconv.ParseInt(raw, 10, 64)
			if err != nil {
				return query, domain.ValidationError{Field: field, Message: "must be an integer number of minor units"}
			}
			*target = &value
		}
	}
	return query, nil
}

func (s *Server) handleCreateExternalAccountTransaction(w http.ResponseWriter, r *http.Request) {
	principal, membership, ok := s.externalAccountManager(w, r)
	if !ok {
		return
	}
	var input externalaccounts.CreateTransactionInput
	attachment, err := s.decodeAttachmentCommand(w, r, &input)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	result, err := s.externalAccounts.CreateTransactionWithAttachment(r.Context(), principal, membership, r.Header.Get("Idempotency-Key"), input, attachment)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (s *Server) handleReverseExternalAccountTransaction(w http.ResponseWriter, r *http.Request) {
	principal, membership, ok := s.externalAccountManager(w, r)
	if !ok {
		return
	}
	var input externalaccounts.ReverseInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeProblem(w, r, err)
		return
	}
	result, err := s.externalAccounts.ReverseTransaction(r.Context(), principal, membership, r.Header.Get("Idempotency-Key"), r.PathValue("externalTransactionID"), input)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (s *Server) handleExternalAccountTransactionAttachment(w http.ResponseWriter, r *http.Request) {
	_, membership, err := s.membership(r)
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	attachment, err := s.externalAccounts.GetTransactionAttachment(r.Context(), membership, r.PathValue("externalTransactionID"))
	if err != nil {
		writeProblem(w, r, err)
		return
	}
	s.writeAttachment(w, r, attachment.FileName, attachment.MediaType, attachment.SizeBytes, attachment.Path, "external_transaction_id", r.PathValue("externalTransactionID"))
}
