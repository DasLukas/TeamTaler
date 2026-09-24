package httpapi

import (
	"net/http"

	"github.com/DasLukas/TeamTaler/internal/kiosk"
)

// handleListKioskPosters returns all templates owned by the authenticated
// administrator's group. It writes JSON or an authorized Problem Details error.
func (s *Server) handleListKioskPosters(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	items, err := s.kiosk.List(request.Context(), membership)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, items)
}

// handleCreateKioskPoster persists one administrator-owned template and
// returns its initial version. The endpoint remains usable while kiosk is off.
func (s *Server) handleCreateKioskPoster(response http.ResponseWriter, request *http.Request) {
	actor, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input kiosk.PosterInput
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.kiosk.Create(request.Context(), actor, membership, input)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(item.Version))
	writeJSON(response, http.StatusCreated, item)
}

// handleUpdateKioskPoster replaces a template when If-Match names its current
// version; it returns the updated template or Problem Details.
func (s *Server) handleUpdateKioskPoster(response http.ResponseWriter, request *http.Request) {
	actor, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	version, err := requiredIfMatchVersion(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input kiosk.PosterInput
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.kiosk.Update(request.Context(), actor, membership, request.PathValue("posterID"), version, input)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(item.Version))
	writeJSON(response, http.StatusOK, item)
}

// handleDeleteKioskPoster removes a version-matched template from the current
// group and returns 204 or Problem Details.
func (s *Server) handleDeleteKioskPoster(response http.ResponseWriter, request *http.Request) {
	actor, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	version, err := requiredIfMatchVersion(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if err := s.kiosk.Delete(request.Context(), actor, membership, request.PathValue("posterID"), version); err != nil {
		writeProblem(response, request, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

// handleKioskPosterPDF renders an authorized, enabled kiosk poster using live
// product details and emits the completed PDF only after rendering succeeds.
func (s *Server) handleKioskPosterPDF(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	pdf, err := s.kiosk.PDF(request.Context(), membership, request.PathValue("posterID"))
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("Content-Type", "application/pdf")
	response.Header().Set("Content-Disposition", `attachment; filename="teamtaler-kiosk-poster.pdf"`)
	response.Header().Set("Cache-Control", "private, no-store")
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write(pdf)
}
