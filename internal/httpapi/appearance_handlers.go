package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"

	"github.com/DasLukas/TeamTaler/internal/domain"
)

type appearanceResponse struct {
	ColorMode domain.ColorMode `json:"colorMode"`
}

type themePreferenceResponse struct {
	ThemeOverride *domain.ThemeID `json:"themeOverride"`
}

// handleUpdateAppearance persists the authenticated account's color mode and
// returns the normalized preference.
func (s *Server) handleUpdateAppearance(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input appearanceResponse
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	if err := s.auth.UpdateColorMode(request.Context(), principal, input.ColorMode); err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, input)
}

// handleUpdateThemePreference persists an optional theme override on the
// authenticated account's active membership in the request group.
func (s *Server) handleUpdateThemePreference(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		ThemeOverride json.RawMessage `json:"themeOverride"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	if len(input.ThemeOverride) == 0 {
		writeProblem(response, request, domain.ValidationError{Field: "themeOverride", Message: "is required"})
		return
	}
	var themeOverride *domain.ThemeID
	if !bytes.Equal(bytes.TrimSpace(input.ThemeOverride), []byte("null")) {
		var value domain.ThemeID
		if err := json.Unmarshal(input.ThemeOverride, &value); err != nil {
			writeProblem(response, request, domain.ValidationError{Field: "themeOverride", Message: "must be a string or null"})
			return
		}
		themeOverride = &value
	}
	if err := s.groups.UpdateThemePreference(request.Context(), principal, membership, themeOverride); err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, themePreferenceResponse{ThemeOverride: themeOverride})
}
