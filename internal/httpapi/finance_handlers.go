package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/config"
	"github.com/DasLukas/TeamTaler/internal/domain"
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

// handleOwnAccountMovements returns the authenticated member's complete
// receivable history through a bounded server-side table query.
func (s *Server) handleOwnAccountMovements(response http.ResponseWriter, request *http.Request) {
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
	query := finance.MovementQuery{
		Search: values.Get("q"), PeriodID: values.Get("periodId"), Type: values.Get("type"),
		CreatedFrom: values.Get("createdFrom"), CreatedTo: values.Get("createdTo"),
		AmountMin: amountMin, AmountMax: amountMax, Sort: values.Get("sort"), Direction: values.Get("direction"),
		Cursor: values.Get("cursor"), Limit: queryLimit(request),
	}
	page, err := s.finance.QueryMovements(request.Context(), membership, membership.ID, query)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeTablePageHeaders(response, page.NextCursor, query.Limit)
	writeJSON(response, http.StatusOK, page.Items)
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
	query := finance.PaymentQuery{
		Search: values.Get("q"), MembershipID: values.Get("membershipId"), Method: values.Get("method"),
		Status: values.Get("status"), ReceivedFrom: values.Get("receivedFrom"), ReceivedTo: values.Get("receivedTo"),
		AmountMin: amountMin, AmountMax: amountMax, Sort: values.Get("sort"), Direction: values.Get("direction"),
		Cursor: values.Get("cursor"), Limit: queryLimit(request),
	}
	page, err := s.finance.QueryPayments(request.Context(), membership, query)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeTablePageHeaders(response, page.NextCursor, query.Limit)
	writeJSON(response, http.StatusOK, page.Items)
}

func (s *Server) handleCreatePayment(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input finance.CreatePaymentInput
	attachment, err := s.decodePaymentCommand(response, request, &input)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.finance.CreatePaymentWithAttachment(request.Context(), principal, membership, request.Header.Get("Idempotency-Key"), input, attachment)
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
	attachment, err := s.decodePaymentCommand(response, request, &input)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.finance.CreateOwnPaymentWithAttachment(request.Context(), principal, membership, request.Header.Get("Idempotency-Key"), input, attachment)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusCreated, item)
}

func (s *Server) decodePaymentCommand(response http.ResponseWriter, request *http.Request, target any) (*finance.PaymentAttachmentUpload, error) {
	mediaType, parameters, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil {
		return nil, domain.ValidationError{Message: "Content-Type must be application/json or multipart/form-data"}
	}
	if mediaType == "application/json" {
		return nil, decodeJSON(response, request, target)
	}
	if mediaType != "multipart/form-data" || parameters["boundary"] == "" {
		return nil, fmt.Errorf("%w: Content-Type must be application/json or multipart/form-data", domain.ErrUnsupportedMediaType)
	}
	settings, loaded := effectiveSystemSettings(request)
	maxBytes := config.DefaultAttachmentUploadBytes
	if loaded {
		maxBytes = settings.AttachmentUploadMaxBytes.Value
	}
	reader, err := request.MultipartReader()
	if err != nil || reader == nil {
		return nil, domain.ValidationError{Message: "request must contain valid multipart form data"}
	}
	var commandBody, attachmentBody []byte
	var attachmentName string
	commandSeen, attachmentSeen := false, false
	for {
		part, nextErr := reader.NextPart()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(nextErr, &tooLarge) {
				return nil, fmt.Errorf("%w: attachment exceeds the configured %d-byte upload limit", domain.ErrPayloadTooLarge, maxBytes)
			}
			return nil, domain.ValidationError{Message: "request must contain valid multipart form data"}
		}
		name := part.FormName()
		switch name {
		case "command":
			if commandSeen {
				part.Close()
				return nil, domain.ValidationError{Field: "command", Message: "must occur exactly once"}
			}
			partType, _, _ := mime.ParseMediaType(part.Header.Get("Content-Type"))
			if partType != "application/json" {
				part.Close()
				return nil, fmt.Errorf("%w: command part must use application/json", domain.ErrUnsupportedMediaType)
			}
			commandBody, err = io.ReadAll(io.LimitReader(part, config.MultipartRequestReserve+1))
			commandSeen = true
		case "attachment":
			if attachmentSeen || strings.TrimSpace(part.FileName()) == "" {
				part.Close()
				return nil, domain.ValidationError{Field: "attachment", Message: "must occur at most once as a file field"}
			}
			attachmentBody, err = io.ReadAll(io.LimitReader(part, maxBytes+1))
			attachmentName = part.FileName()
			attachmentSeen = true
		default:
			part.Close()
			return nil, domain.ValidationError{Message: "multipart request contains an unknown part"}
		}
		part.Close()
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				return nil, fmt.Errorf("%w: attachment exceeds the configured %d-byte upload limit", domain.ErrPayloadTooLarge, maxBytes)
			}
			return nil, domain.ValidationError{Message: "multipart request could not be read"}
		}
		if name == "command" && int64(len(commandBody)) > config.MultipartRequestReserve {
			return nil, domain.ValidationError{Field: "command", Message: "is too large"}
		}
		if name == "attachment" && int64(len(attachmentBody)) > maxBytes {
			return nil, fmt.Errorf("%w: attachment exceeds the configured %d-byte upload limit", domain.ErrPayloadTooLarge, maxBytes)
		}
	}
	if !commandSeen {
		return nil, domain.ValidationError{Field: "command", Message: "is required"}
	}
	decoder := json.NewDecoder(bytes.NewReader(commandBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return nil, domain.ValidationError{Field: "command", Message: "must contain valid JSON: " + err.Error()}
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, domain.ValidationError{Field: "command", Message: "must contain exactly one JSON value"}
	}
	if !attachmentSeen {
		return nil, nil
	}
	return &finance.PaymentAttachmentUpload{FileName: attachmentName, Reader: bytes.NewReader(attachmentBody), MaxBytes: maxBytes}, nil
}

func (s *Server) handlePaymentAttachment(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	membership, err := s.groups.MembershipForUser(request.Context(), request.PathValue("groupID"), principal.UserID)
	if errors.Is(err, domain.ErrForbidden) {
		writeProblem(response, request, domain.ErrNotFound)
		return
	}
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	attachment, err := s.finance.GetPaymentAttachment(request.Context(), membership, request.PathValue("paymentID"))
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	file, err := os.Open(attachment.Path)
	if errors.Is(err, os.ErrNotExist) {
		writeProblem(response, request, domain.ErrNotFound)
		return
	}
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	defer file.Close()
	disposition := "inline"
	if attachment.MediaType == "application/pdf" {
		disposition = "attachment"
	}
	response.Header().Set("Content-Type", attachment.MediaType)
	response.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": attachment.FileName}))
	response.Header().Set("Content-Length", fmt.Sprintf("%d", attachment.SizeBytes))
	response.Header().Set("Cache-Control", "private, no-store")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	if _, err := io.Copy(response, io.LimitReader(file, attachment.SizeBytes)); err != nil {
		s.logger.Error("stream payment attachment", "payment_id", request.PathValue("paymentID"), "error", err)
	}
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
