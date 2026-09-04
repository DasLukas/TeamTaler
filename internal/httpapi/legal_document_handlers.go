package httpapi

import (
	"net/http"

	"github.com/DasLukas/TeamTaler/internal/domain"
	systemadmin "github.com/DasLukas/TeamTaler/internal/system"
)

// handlePublicLegalDocuments returns only public Markdown content and omits
// database, actor, revision, and host-file metadata.
func (s *Server) handlePublicLegalDocuments(response http.ResponseWriter, request *http.Request) {
	documents, err := s.systemAdmin.GetPublicLegalDocuments(request.Context())
	if err != nil {
		s.logger.Error("load public legal documents", "error", err)
		writeProblem(response, request, domain.ErrServiceUnavailable)
		return
	}
	writeJSON(response, http.StatusOK, documents)
}

// handleSystemLegalDocuments returns effective documents and safe source
// metadata to a current system administrator.
func (s *Server) handleSystemLegalDocuments(response http.ResponseWriter, request *http.Request) {
	if _, err := s.systemAdministrator(request); err != nil {
		writeProblem(response, request, err)
		return
	}
	documents, err := s.systemAdmin.GetLegalDocuments(request.Context())
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(documents.Revision))
	writeJSON(response, http.StatusOK, documents)
}

// handleUpdateSystemLegalDocuments replaces one or both persisted documents
// after administrator and optimistic-concurrency checks.
func (s *Server) handleUpdateSystemLegalDocuments(response http.ResponseWriter, request *http.Request) {
	principal, err := s.systemAdministrator(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	expected, err := requiredIfMatchVersion(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var patch systemadmin.LegalDocumentsPatch
	if err := decodeJSON(response, request, &patch); err != nil {
		writeProblem(response, request, err)
		return
	}
	documents, err := s.systemAdmin.UpdateLegalDocuments(request.Context(), principal.UserID, expected, patch)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(documents.Revision))
	writeJSON(response, http.StatusOK, documents)
}

// handleResetSystemLegalDocuments removes selected database overrides so live
// host files become effective again.
func (s *Server) handleResetSystemLegalDocuments(response http.ResponseWriter, request *http.Request) {
	principal, err := s.systemAdministrator(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	expected, err := requiredIfMatchVersion(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		Keys []systemadmin.LegalDocumentKey `json:"keys"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	documents, err := s.systemAdmin.ResetLegalDocuments(request.Context(), principal.UserID, expected, input.Keys)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(documents.Revision))
	writeJSON(response, http.StatusOK, documents)
}
