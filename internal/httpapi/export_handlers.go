package httpapi

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/exporting"
)

type createDataExportRequest struct {
	CurrentPassword string `json:"currentPassword"`
}

// handleCreateGroupDataExport queues a complete structured group-data archive
// after live GROUP_ADMINISTRATION authorization and password reauthentication.
func (s *Server) handleCreateGroupDataExport(response http.ResponseWriter, request *http.Request) {
	s.handleCreateDataExport(response, request, exporting.ScopeGroup)
}

// handleCreatePersonalDataExport queues the current actor's structured profile
// and membership data for the active route group after reauthentication.
func (s *Server) handleCreatePersonalDataExport(response http.ResponseWriter, request *http.Request) {
	s.handleCreateDataExport(response, request, exporting.ScopePersonal)
}

func (s *Server) handleCreateDataExport(response http.ResponseWriter, request *http.Request, scope exporting.Scope) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input createDataExportRequest
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	actorKey := "data-export-password:user:" + principal.UserID
	ipKey := "data-export-password:ip:" + s.clientIP(request)
	if !s.loginLimiter.allow(actorKey) || !s.loginLimiter.allow(ipKey) {
		writeProblem(response, request, domain.ErrRateLimited)
		return
	}
	select {
	case s.passwordSlots <- struct{}{}:
		defer func() { <-s.passwordSlots }()
	default:
		writeProblem(response, request, domain.ErrRateLimited)
		return
	}
	job, err := s.exports.Create(request.Context(), exporting.CreateInput{
		GroupID: membership.GroupID, MembershipID: membership.ID, UserID: principal.UserID,
		Scope: scope, CurrentPassword: input.CurrentPassword, IdempotencyKey: request.Header.Get("Idempotency-Key"),
	})
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	s.loginLimiter.reset(actorKey, ipKey)
	writeJSON(response, http.StatusAccepted, job)
}

// handleListDataExports returns only jobs owned by the current actor in one
// currently active group membership.
func (s *Server) handleListDataExports(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	groupID := strings.TrimSpace(request.URL.Query().Get("groupId"))
	if groupID == "" {
		writeProblem(response, request, domain.ValidationError{Field: "groupId", Message: "is required"})
		return
	}
	if _, err := s.groups.MembershipForUser(request.Context(), groupID, principal.UserID); err != nil {
		writeProblem(response, request, err)
		return
	}
	jobs, err := s.exports.List(request.Context(), principal.UserID, groupID, dataExportListLimit(request))
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, jobs)
}

// handleGetDataExport returns one actor-owned job without exposing tenant or
// filesystem metadata.
func (s *Server) handleGetDataExport(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	job, err := s.exports.Get(request.Context(), principal.UserID, request.PathValue("exportID"))
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, job)
}

// handleDownloadDataExport rechecks the current scope authorization and streams
// one complete retained ZIP with private, non-cacheable response headers.
func (s *Server) handleDownloadDataExport(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	download, err := s.exports.OpenDownload(request.Context(), principal.UserID, request.PathValue("exportID"))
	if err != nil {
		if errors.Is(err, exporting.ErrArtifactUnavailable) {
			err = fmt.Errorf("%w: export artifact is unavailable", domain.ErrServiceUnavailable)
		}
		writeProblem(response, request, err)
		return
	}
	defer download.Reader.Close()
	response.Header().Set("Content-Type", "application/zip")
	response.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`, download.Filename))
	response.Header().Set("Content-Length", strconv.FormatInt(download.SizeBytes, 10))
	response.Header().Set("Cache-Control", "private, no-store")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.Header().Set("X-Content-SHA256", download.SHA256)
	response.Header().Set("Last-Modified", download.LastModified.UTC().Format(http.TimeFormat))
	response.WriteHeader(http.StatusOK)
	_ = streamExportWithIdleDeadline(response, download.Reader, 30*time.Second)
}

func streamExportWithIdleDeadline(response http.ResponseWriter, source io.Reader, idleTimeout time.Duration) error {
	controller := http.NewResponseController(response)
	buffer := make([]byte, 128<<10)
	for {
		read, readErr := source.Read(buffer)
		if read > 0 {
			_ = controller.SetWriteDeadline(time.Now().Add(idleTimeout))
			if _, writeErr := response.Write(buffer[:read]); writeErr != nil {
				return writeErr
			}
		}
		if errors.Is(readErr, io.EOF) {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

func dataExportListLimit(request *http.Request) int {
	value, _ := strconv.Atoi(request.URL.Query().Get("limit"))
	if value < 1 || value > 100 {
		return 100
	}
	return value
}

// handleDeleteDataExport cancels an actor-owned active job or permanently
// removes a terminal job together with any published archive.
func (s *Server) handleDeleteDataExport(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if err := s.exports.Remove(request.Context(), principal.UserID, request.PathValue("exportID")); err != nil {
		writeProblem(response, request, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}
