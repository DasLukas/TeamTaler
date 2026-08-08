package httpapi

import (
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/memberimport"
)

func (s *Server) handleImportInvitations(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || (mediaType != "text/csv" && mediaType != "application/csv") {
		writeProblem(response, request, fmt.Errorf("%w: Content-Type must be text/csv", domain.ErrUnsupportedMediaType))
		return
	}
	document, err := io.ReadAll(io.LimitReader(request.Body, memberimport.MaxCSVBytes+1))
	if err != nil {
		var limitError *http.MaxBytesError
		if errors.As(err, &limitError) {
			writeProblem(response, request, fmt.Errorf("%w: CSV exceeds the configured request limit", domain.ErrPayloadTooLarge))
			return
		}
		writeProblem(response, request, fmt.Errorf("read CSV import: %w", err))
		return
	}
	if len(document) > memberimport.MaxCSVBytes {
		writeProblem(response, request, fmt.Errorf("%w: CSV must not exceed %d bytes", domain.ErrPayloadTooLarge, memberimport.MaxCSVBytes))
		return
	}
	rows, err := memberimport.ParseCSV(document)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	roleIDs := request.URL.Query()["roleId"]
	candidates := make([]groups.InvitationImportCandidate, len(rows))
	for index, row := range rows {
		candidates[index] = groups.InvitationImportCandidate{
			Row: row.Number, Email: row.Email, DisplayName: row.DisplayName, RoleNames: row.RoleNames, ValidationCode: row.ValidationCode,
		}
	}
	result, err := s.groups.ImportInvitations(request.Context(), principal, membership, request.Header.Get("Idempotency-Key"), roleIDs, candidates)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func (s *Server) handleRetryInvitationEmail(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	result, err := s.groups.RetryInvitationEmail(
		request.Context(), principal, membership, request.Header.Get("Idempotency-Key"), request.PathValue("invitationID"),
	)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

// handleResendInvitationEmail rotates an invitation token, queues a fresh
// delivery, and exposes the new fallback URL only for the first idempotent
// response. response receives the secret-free delivery result plus an optional
// acceptUrl; request supplies authenticated group context and Idempotency-Key.
func (s *Server) handleResendInvitationEmail(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	result, err := s.groups.ResendInvitationEmail(
		request.Context(), principal, membership, request.Header.Get("Idempotency-Key"), request.PathValue("invitationID"),
	)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	acceptURL := ""
	if result.Token != "" {
		acceptURL = strings.TrimSuffix(s.config.PublicURL.String(), "/") + "/invite#token=" + url.QueryEscape(result.Token)
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"invitationId":        result.InvitationID,
		"emailDeliveryStatus": result.EmailDeliveryStatus,
		"expiresAt":           result.ExpiresAt,
		"acceptUrl":           acceptURL,
	})
}
