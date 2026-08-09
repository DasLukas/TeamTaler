package httpapi

import (
	"errors"
	"net/http"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
)

type permissionDefinitionResponse struct {
	Key           domain.PermissionKey         `json:"key"`
	Description   string                       `json:"description"`
	AllowedScopes []domain.PermissionScopeType `json:"allowedScopes"`
	Implies       []domain.PermissionKey       `json:"implies"`
}

func (s *Server) handlePermissionDefinitions(response http.ResponseWriter, request *http.Request) {
	if _, err := s.principal(request); err != nil {
		writeProblem(response, request, err)
		return
	}
	definitions := groups.PermissionDefinitions()
	result := make([]permissionDefinitionResponse, 0, len(definitions))
	for _, definition := range definitions {
		result = append(result, permissionDefinitionResponse{
			Key: definition.Key, Description: definition.Description,
			AllowedScopes: []domain.PermissionScopeType{domain.PermissionScopeGroup},
			Implies:       append(make([]domain.PermissionKey, 0, len(definition.ImpliedPermissions)), definition.ImpliedPermissions...),
		})
	}
	writeJSON(response, http.StatusOK, result)
}

func (s *Server) handleListRoles(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	items, err := s.groups.ListRoles(request.Context(), membership)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, items)
}

func (s *Server) handleCreateRole(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input groups.RoleCommand
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.groups.CreateRole(request.Context(), principal, membership, input)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(item.Version))
	writeJSON(response, http.StatusCreated, item)
}

func (s *Server) handleGetRole(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.groups.GetRole(request.Context(), membership, request.PathValue("roleID"))
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(item.Version))
	writeJSON(response, http.StatusOK, item)
}

func (s *Server) handleUpdateRole(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	expectedVersion, err := requiredIfMatchVersion(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input groups.RoleCommand
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.groups.UpdateRole(request.Context(), principal, membership, request.PathValue("roleID"), expectedVersion, input)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(item.Version))
	writeJSON(response, http.StatusOK, item)
}

func (s *Server) handleDeleteRole(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	expectedVersion, err := requiredIfMatchVersion(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if err := s.groups.DeleteRole(request.Context(), principal, membership, request.PathValue("roleID"), expectedVersion); err != nil {
		writeProblem(response, request, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleListRoleAssignments(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	items, err := s.groups.ListRoleAssignments(request.Context(), membership)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, items)
}

func (s *Server) handleReplaceMemberRoles(response http.ResponseWriter, request *http.Request) {
	s.handleReplaceRoles(response, request, domain.RoleAssignmentMembership, request.PathValue("membershipID"))
}

func (s *Server) handleReplaceInvitationRoles(response http.ResponseWriter, request *http.Request) {
	s.handleReplaceRoles(response, request, domain.RoleAssignmentInvitation, request.PathValue("invitationID"))
}

func (s *Server) handleReplaceRoles(response http.ResponseWriter, request *http.Request, targetType domain.RoleAssignmentTargetType, targetID string) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	expectedVersion, err := requiredIfMatchVersion(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		RoleIDs []string `json:"roleIds"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	var item groups.AssignmentSet
	if targetType == domain.RoleAssignmentMembership {
		item, err = s.groups.ReplaceMemberRoles(request.Context(), principal, membership, targetID, input.RoleIDs, expectedVersion)
	} else {
		item, err = s.groups.ReplaceInvitationRoles(request.Context(), principal, membership, targetID, input.RoleIDs, expectedVersion)
	}
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(item.Version))
	writeJSON(response, http.StatusOK, item)
}

func roleConflictCounts(err error) (int64, int64, bool) {
	var inUse groups.RoleInUseError
	if !errors.As(err, &inUse) {
		return 0, 0, false
	}
	return inUse.MemberCount, inUse.PendingInvitationCount, true
}
