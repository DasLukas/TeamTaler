package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"

	"github.com/DasLukas/TeamTaler/internal/domain"
)

type groupPreferenceResponse struct {
	DefaultGroupID *string `json:"defaultGroupId"`
}

func (s *Server) handleUpdateDefaultGroup(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		DefaultGroupID json.RawMessage `json:"defaultGroupId"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	if len(input.DefaultGroupID) == 0 {
		writeProblem(response, request, domain.ValidationError{Field: "defaultGroupId", Message: "is required"})
		return
	}
	var defaultGroupID *string
	if !bytes.Equal(bytes.TrimSpace(input.DefaultGroupID), []byte("null")) {
		var value string
		if err := json.Unmarshal(input.DefaultGroupID, &value); err != nil {
			writeProblem(response, request, domain.ValidationError{Field: "defaultGroupId", Message: "must be a string or null"})
			return
		}
		defaultGroupID = &value
	}
	if err := s.auth.UpdateDefaultGroup(request.Context(), principal, defaultGroupID); err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, groupPreferenceResponse{DefaultGroupID: defaultGroupID})
}

func (s *Server) handleRecordLastUsedGroup(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		GroupID string `json:"groupId"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	if err := s.auth.RecordLastUsedGroup(request.Context(), principal, input.GroupID); err != nil {
		writeProblem(response, request, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}
