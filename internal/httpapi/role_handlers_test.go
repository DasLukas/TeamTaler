package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
)

func TestHandlePermissionDefinitionsReturnsStableArrayMetadata(t *testing.T) {
	t.Parallel()

	server, principal, _ := invitationImportServer(t, false)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/permission-definitions", nil)
	request = request.WithContext(context.WithValue(request.Context(), principalKey, principal))
	response := httptest.NewRecorder()

	server.handlePermissionDefinitions(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var definitions []permissionDefinitionResponse
	if err := json.Unmarshal(response.Body.Bytes(), &definitions); err != nil {
		t.Fatalf("decode permission definitions: %v", err)
	}
	if len(definitions) != 15 {
		t.Fatalf("permission definition count = %d, want 15", len(definitions))
	}
	for _, definition := range definitions {
		if definition.Implies == nil || len(definition.AllowedScopes) != 1 || definition.AllowedScopes[0] != domain.PermissionScopeGroup {
			t.Fatalf("permission definition metadata = %#v", definition)
		}
	}
}

func TestRoleHTTPOptimisticLifecycleAssignmentsAndAdministratorProtection(t *testing.T) {
	t.Parallel()

	server, principal, administrator := invitationImportServer(t, false)
	ctx := context.Background()
	create := roleHandlerRequest(principal, administrator.GroupID, http.MethodPost, `{"name":"Shift lead","description":"Books and reviews group activity.","grants":[{"permission":"BOOK_FOR_OTHERS","scope":{"type":"GROUP"}}]}`)
	createdResponse := httptest.NewRecorder()
	server.handleCreateRole(createdResponse, create)
	if createdResponse.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", createdResponse.Code, createdResponse.Body.String())
	}
	var role groups.ManagedRole
	if err := json.Unmarshal(createdResponse.Body.Bytes(), &role); err != nil {
		t.Fatalf("decode created role: %v", err)
	}
	if role.ID == "" || role.Version < 1 || createdResponse.Header().Get("ETag") != versionETag(role.Version) {
		t.Fatalf("created role = %#v, ETag = %q", role, createdResponse.Header().Get("ETag"))
	}

	duplicateName := roleHandlerRequest(principal, administrator.GroupID, http.MethodPost, `{"name":" shift LEAD ","grants":[]}`)
	duplicateNameResponse := httptest.NewRecorder()
	server.handleCreateRole(duplicateNameResponse, duplicateName)
	if duplicateNameResponse.Code != http.StatusUnprocessableEntity {
		t.Fatalf("case-insensitive duplicate role status = %d, body = %s", duplicateNameResponse.Code, duplicateNameResponse.Body.String())
	}

	controlCharacter := roleHandlerRequest(principal, administrator.GroupID, http.MethodPost, `{"name":"Invalid\u0085Role","grants":[]}`)
	controlCharacterResponse := httptest.NewRecorder()
	server.handleCreateRole(controlCharacterResponse, controlCharacter)
	if controlCharacterResponse.Code != http.StatusUnprocessableEntity {
		t.Fatalf("control-character role status = %d, body = %s", controlCharacterResponse.Code, controlCharacterResponse.Body.String())
	}

	unsupportedScope := roleHandlerRequest(principal, administrator.GroupID, http.MethodPost, `{"name":"Scoped role","grants":[{"permission":"BOOK_FOR_OTHERS","scope":{"type":"CATEGORY","categoryId":"cat-unknown"}}]}`)
	unsupportedScopeResponse := httptest.NewRecorder()
	server.handleCreateRole(unsupportedScopeResponse, unsupportedScope)
	if unsupportedScopeResponse.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unsupported role scope status = %d, body = %s", unsupportedScopeResponse.Code, unsupportedScopeResponse.Body.String())
	}

	missingPrecondition := roleHandlerRequest(principal, administrator.GroupID, http.MethodPut, `{"name":"Shift coordinator","grants":[{"permission":"BOOK_FOR_OTHERS","scope":{"type":"GROUP"}}]}`)
	missingPrecondition.SetPathValue("roleID", role.ID)
	missingPreconditionResponse := httptest.NewRecorder()
	server.handleUpdateRole(missingPreconditionResponse, missingPrecondition)
	if missingPreconditionResponse.Code != http.StatusPreconditionFailed {
		t.Fatalf("missing If-Match status = %d, body = %s", missingPreconditionResponse.Code, missingPreconditionResponse.Body.String())
	}

	update := roleHandlerRequest(principal, administrator.GroupID, http.MethodPut, `{"name":"Shift coordinator","description":"Updated role.","grants":[{"permission":"BOOK_FOR_OTHERS","scope":{"type":"GROUP"}},{"permission":"VIEW_ALL_BOOKING_ACTIVITY","scope":{"type":"GROUP"}}]}`)
	update.SetPathValue("roleID", role.ID)
	update.Header.Set("If-Match", versionETag(role.Version))
	updatedResponse := httptest.NewRecorder()
	server.handleUpdateRole(updatedResponse, update)
	if updatedResponse.Code != http.StatusOK {
		t.Fatalf("update status = %d, body = %s", updatedResponse.Code, updatedResponse.Body.String())
	}
	if err := json.Unmarshal(updatedResponse.Body.Bytes(), &role); err != nil {
		t.Fatalf("decode updated role: %v", err)
	}
	if role.Name != "Shift coordinator" || len(role.Grants) != 2 || updatedResponse.Header().Get("ETag") != versionETag(role.Version) {
		t.Fatalf("updated role = %#v, ETag = %q", role, updatedResponse.Header().Get("ETag"))
	}

	invitation, err := server.groups.CreateInvitationWithRoles(ctx, principal, administrator, "role-member@example.test", "Role Member", []string{authorization.TemplateRoleID(administrator.GroupID, domain.RoleTemplateMember)})
	if err != nil {
		t.Fatalf("create member invitation: %v", err)
	}
	_, member, err := server.auth.AcceptInvitation(ctx, auth.InvitationAcceptance{Token: invitation.Token, DisplayName: "Role Member", Password: "correct-horse-battery-staple"})
	if err != nil {
		t.Fatalf("accept member invitation: %v", err)
	}

	assign := roleHandlerRequest(principal, administrator.GroupID, http.MethodPut, fmt.Sprintf(`{"roleIds":[%q]}`, role.ID))
	assign.SetPathValue("membershipID", member.ID)
	assign.Header.Set("If-Match", versionETag(member.RoleAssignmentsVersion))
	assignedResponse := httptest.NewRecorder()
	server.handleReplaceMemberRoles(assignedResponse, assign)
	if assignedResponse.Code != http.StatusOK {
		t.Fatalf("assign status = %d, body = %s", assignedResponse.Code, assignedResponse.Body.String())
	}
	var assignment groups.AssignmentSet
	if err := json.Unmarshal(assignedResponse.Body.Bytes(), &assignment); err != nil {
		t.Fatalf("decode role assignment: %v", err)
	}
	if assignment.Version <= member.RoleAssignmentsVersion || len(assignment.RoleIDs) != 1 || assignment.RoleIDs[0] != role.ID {
		t.Fatalf("assigned roles = %#v", assignment)
	}

	staleAssign := roleHandlerRequest(principal, administrator.GroupID, http.MethodPut, `{"roleIds":[]}`)
	staleAssign.SetPathValue("membershipID", member.ID)
	staleAssign.Header.Set("If-Match", versionETag(member.RoleAssignmentsVersion))
	staleResponse := httptest.NewRecorder()
	server.handleReplaceMemberRoles(staleResponse, staleAssign)
	if staleResponse.Code != http.StatusUnprocessableEntity {
		t.Fatalf("stale assignment status = %d, body = %s", staleResponse.Code, staleResponse.Body.String())
	}

	assignedDelete := roleHandlerRequest(principal, administrator.GroupID, http.MethodDelete, "")
	assignedDelete.SetPathValue("roleID", role.ID)
	assignedDelete.Header.Set("If-Match", versionETag(role.Version))
	assignedDeleteResponse := httptest.NewRecorder()
	server.handleDeleteRole(assignedDeleteResponse, assignedDelete)
	if assignedDeleteResponse.Code != http.StatusConflict {
		t.Fatalf("assigned delete status = %d, body = %s", assignedDeleteResponse.Code, assignedDeleteResponse.Body.String())
	}
	var conflict problem
	if err := json.Unmarshal(assignedDeleteResponse.Body.Bytes(), &conflict); err != nil {
		t.Fatalf("decode role conflict: %v", err)
	}
	if conflict.MemberCount == nil || *conflict.MemberCount != 1 || conflict.PendingInvitationCount == nil || *conflict.PendingInvitationCount != 0 {
		t.Fatalf("role conflict counts = %#v", conflict)
	}

	memberRoleID := authorization.TemplateRoleID(administrator.GroupID, domain.RoleTemplateMember)
	unassign := roleHandlerRequest(principal, administrator.GroupID, http.MethodPut, fmt.Sprintf(`{"roleIds":[%q]}`, memberRoleID))
	unassign.SetPathValue("membershipID", member.ID)
	unassign.Header.Set("If-Match", versionETag(assignment.Version))
	unassignedResponse := httptest.NewRecorder()
	server.handleReplaceMemberRoles(unassignedResponse, unassign)
	if unassignedResponse.Code != http.StatusOK {
		t.Fatalf("unassign status = %d, body = %s", unassignedResponse.Code, unassignedResponse.Body.String())
	}
	rolesAfterUnassign, err := server.groups.ListRoles(ctx, administrator)
	if err != nil {
		t.Fatalf("reload roles after unassign: %v", err)
	}
	for _, current := range rolesAfterUnassign {
		if current.ID == role.ID {
			role = current
			break
		}
	}

	deleteRequest := roleHandlerRequest(principal, administrator.GroupID, http.MethodDelete, "")
	deleteRequest.SetPathValue("roleID", role.ID)
	deleteRequest.Header.Set("If-Match", versionETag(role.Version))
	deletedResponse := httptest.NewRecorder()
	server.handleDeleteRole(deletedResponse, deleteRequest)
	if deletedResponse.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body = %s", deletedResponse.Code, deletedResponse.Body.String())
	}

	removeFinalAdministrator := roleHandlerRequest(principal, administrator.GroupID, http.MethodPut, fmt.Sprintf(`{"roleIds":[%q]}`, memberRoleID))
	removeFinalAdministrator.SetPathValue("membershipID", administrator.ID)
	removeFinalAdministrator.Header.Set("If-Match", versionETag(administrator.RoleAssignmentsVersion))
	protectedResponse := httptest.NewRecorder()
	server.handleReplaceMemberRoles(protectedResponse, removeFinalAdministrator)
	if protectedResponse.Code != http.StatusConflict {
		t.Fatalf("final administrator removal status = %d, body = %s", protectedResponse.Code, protectedResponse.Body.String())
	}
}

func TestDynamicInvitationRoleUpdateUsesAssignmentETag(t *testing.T) {
	t.Parallel()

	server, principal, administrator := invitationImportServer(t, false)
	role, err := server.groups.CreateRole(context.Background(), principal, administrator, groups.RoleCommand{
		Name: "Invitation booker",
		Grants: []domain.PermissionGrant{{
			Permission: domain.PermissionBookForOthers,
			Scope:      domain.PermissionScope{Type: domain.PermissionScopeGroup},
		}},
	})
	if err != nil {
		t.Fatalf("create invitation role: %v", err)
	}
	invitation, err := server.groups.CreateInvitationWithRoles(context.Background(), principal, administrator, "dynamic-invitation@example.test", "Pending Member", []string{authorization.TemplateRoleID(administrator.GroupID, domain.RoleTemplateMember)})
	if err != nil {
		t.Fatalf("create invitation: %v", err)
	}

	missingIfMatch := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, fmt.Sprintf(`{"displayName":"Assigned Member","roleIds":[%q]}`, role.ID))
	missingIfMatch.SetPathValue("invitationID", invitation.ID)
	missingIfMatchResponse := httptest.NewRecorder()
	server.handleUpdateInvitation(missingIfMatchResponse, missingIfMatch)
	if missingIfMatchResponse.Code != http.StatusPreconditionFailed {
		t.Fatalf("missing invitation If-Match status = %d, body = %s", missingIfMatchResponse.Code, missingIfMatchResponse.Body.String())
	}

	update := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, fmt.Sprintf(`{"displayName":"Assigned Member","roleIds":[%q]}`, role.ID))
	update.SetPathValue("invitationID", invitation.ID)
	update.Header.Set("If-Match", versionETag(invitation.RoleAssignmentsVersion))
	updatedResponse := httptest.NewRecorder()
	server.handleUpdateInvitation(updatedResponse, update)
	if updatedResponse.Code != http.StatusOK {
		t.Fatalf("dynamic invitation update status = %d, body = %s", updatedResponse.Code, updatedResponse.Body.String())
	}
	var updated groups.Invitation
	if err := json.Unmarshal(updatedResponse.Body.Bytes(), &updated); err != nil {
		t.Fatalf("decode dynamic invitation: %v", err)
	}
	if updated.DisplayName != "Assigned Member" || len(updated.RoleIDs) != 1 || updated.RoleIDs[0] != role.ID || updatedResponse.Header().Get("ETag") != versionETag(updated.RoleAssignmentsVersion) {
		t.Fatalf("updated invitation = %#v, ETag = %q", updated, updatedResponse.Header().Get("ETag"))
	}

	stale := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, fmt.Sprintf(`{"displayName":"Stale","roleIds":[%q]}`, role.ID))
	stale.SetPathValue("invitationID", invitation.ID)
	stale.Header.Set("If-Match", versionETag(invitation.RoleAssignmentsVersion))
	staleResponse := httptest.NewRecorder()
	server.handleUpdateInvitation(staleResponse, stale)
	if staleResponse.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale invitation update status = %d, body = %s", staleResponse.Code, staleResponse.Body.String())
	}

	if _, err := server.db.ExecContext(context.Background(), `UPDATE invitations SET expires_at='2000-01-01T00:00:00Z' WHERE id=?`, invitation.ID); err != nil {
		t.Fatalf("expire invitation: %v", err)
	}
	expired := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, fmt.Sprintf(`{"displayName":"Expired","roleIds":[%q]}`, role.ID))
	expired.SetPathValue("invitationID", invitation.ID)
	expired.Header.Set("If-Match", versionETag(updated.RoleAssignmentsVersion))
	expiredResponse := httptest.NewRecorder()
	server.handleUpdateInvitation(expiredResponse, expired)
	if expiredResponse.Code != http.StatusConflict {
		t.Fatalf("expired invitation update status = %d, body = %s", expiredResponse.Code, expiredResponse.Body.String())
	}
}

func TestLegacyAssignmentUpdatesRequireCurrentETag(t *testing.T) {
	t.Parallel()

	server, principal, administrator := invitationImportServer(t, false)
	ctx := context.Background()
	acceptedInvitation, err := server.groups.CreateInvitationWithRoles(ctx, principal, administrator, "legacy-member@example.test", "Legacy Member", []string{authorization.TemplateRoleID(administrator.GroupID, domain.RoleTemplateMember)})
	if err != nil {
		t.Fatalf("create member invitation: %v", err)
	}
	_, member, err := server.auth.AcceptInvitation(ctx, auth.InvitationAcceptance{Token: acceptedInvitation.Token, DisplayName: "Legacy Member", Password: "correct-horse-battery-staple"})
	if err != nil {
		t.Fatalf("accept member invitation: %v", err)
	}
	customRole, err := server.groups.CreateRole(ctx, principal, administrator, groups.RoleCommand{
		Name: "Preserved custom role",
		Grants: []domain.PermissionGrant{{
			Permission: domain.PermissionBookForOthers,
			Scope:      domain.PermissionScope{Type: domain.PermissionScopeGroup},
		}},
	})
	if err != nil {
		t.Fatalf("create preserved custom role: %v", err)
	}
	memberAssignment, err := server.groups.ReplaceMemberRoles(ctx, principal, administrator, member.ID, []string{customRole.ID}, member.RoleAssignmentsVersion)
	if err != nil {
		t.Fatalf("assign preserved custom member role: %v", err)
	}

	memberBody := `{"roles":["FINANCE_MANAGER"],"groupPermissions":[],"categoryGrants":{}}`
	missingMemberETag := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, memberBody)
	missingMemberETag.SetPathValue("membershipID", member.ID)
	missingMemberResponse := httptest.NewRecorder()
	server.handleUpdatePermissions(missingMemberResponse, missingMemberETag)
	if missingMemberResponse.Code != http.StatusPreconditionFailed {
		t.Fatalf("missing legacy member If-Match status = %d, body = %s", missingMemberResponse.Code, missingMemberResponse.Body.String())
	}

	updateMember := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, memberBody)
	updateMember.SetPathValue("membershipID", member.ID)
	updateMember.Header.Set("If-Match", versionETag(memberAssignment.Version))
	updatedMemberResponse := httptest.NewRecorder()
	server.handleUpdatePermissions(updatedMemberResponse, updateMember)
	if updatedMemberResponse.Code != http.StatusNoContent || updatedMemberResponse.Header().Get("ETag") == "" {
		t.Fatalf("legacy member update status = %d, ETag = %q, body = %s", updatedMemberResponse.Code, updatedMemberResponse.Header().Get("ETag"), updatedMemberResponse.Body.String())
	}
	updatedMember, err := server.groups.MembershipForUser(ctx, administrator.GroupID, member.UserID)
	if err != nil || !slices.Contains(updatedMember.RoleIDs, customRole.ID) {
		t.Fatalf("legacy member update lost custom role: membership = %#v, err = %v", updatedMember, err)
	}

	staleMember := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, `{"roles":[],"groupPermissions":[],"categoryGrants":{}}`)
	staleMember.SetPathValue("membershipID", member.ID)
	staleMember.Header.Set("If-Match", versionETag(memberAssignment.Version))
	staleMemberResponse := httptest.NewRecorder()
	server.handleUpdatePermissions(staleMemberResponse, staleMember)
	if staleMemberResponse.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale legacy member update status = %d, body = %s", staleMemberResponse.Code, staleMemberResponse.Body.String())
	}

	pendingInvitation, err := server.groups.CreateInvitationWithRoles(ctx, principal, administrator, "legacy-invitation@example.test", "Pending Legacy Member", []string{authorization.TemplateRoleID(administrator.GroupID, domain.RoleTemplateMember)})
	if err != nil {
		t.Fatalf("create pending invitation: %v", err)
	}
	pendingAssignment, err := server.groups.ReplaceInvitationRoles(ctx, principal, administrator, pendingInvitation.ID, []string{customRole.ID}, pendingInvitation.RoleAssignmentsVersion)
	if err != nil {
		t.Fatalf("assign preserved custom invitation role: %v", err)
	}
	invitationBody := `{"displayName":"Updated Legacy Member","roles":["CATALOG_MANAGER"],"groupPermissions":[],"categoryGrants":{}}`
	missingInvitationETag := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, invitationBody)
	missingInvitationETag.SetPathValue("invitationID", pendingInvitation.ID)
	missingInvitationResponse := httptest.NewRecorder()
	server.handleUpdateInvitation(missingInvitationResponse, missingInvitationETag)
	if missingInvitationResponse.Code != http.StatusPreconditionFailed {
		t.Fatalf("missing legacy invitation If-Match status = %d, body = %s", missingInvitationResponse.Code, missingInvitationResponse.Body.String())
	}

	updateInvitation := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, invitationBody)
	updateInvitation.SetPathValue("invitationID", pendingInvitation.ID)
	updateInvitation.Header.Set("If-Match", versionETag(pendingAssignment.Version))
	updatedInvitationResponse := httptest.NewRecorder()
	server.handleUpdateInvitation(updatedInvitationResponse, updateInvitation)
	if updatedInvitationResponse.Code != http.StatusOK {
		t.Fatalf("legacy invitation update status = %d, body = %s", updatedInvitationResponse.Code, updatedInvitationResponse.Body.String())
	}
	var updatedInvitation groups.Invitation
	if err := json.Unmarshal(updatedInvitationResponse.Body.Bytes(), &updatedInvitation); err != nil {
		t.Fatalf("decode legacy invitation update: %v", err)
	}
	if updatedInvitation.RoleAssignmentsVersion <= pendingAssignment.Version || updatedInvitationResponse.Header().Get("ETag") != versionETag(updatedInvitation.RoleAssignmentsVersion) || !slices.Contains(updatedInvitation.RoleIDs, customRole.ID) {
		t.Fatalf("legacy invitation update = %#v, ETag = %q", updatedInvitation, updatedInvitationResponse.Header().Get("ETag"))
	}

	staleInvitation := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, `{"displayName":"Stale","roles":[],"groupPermissions":[],"categoryGrants":{}}`)
	staleInvitation.SetPathValue("invitationID", pendingInvitation.ID)
	staleInvitation.Header.Set("If-Match", versionETag(pendingAssignment.Version))
	staleInvitationResponse := httptest.NewRecorder()
	server.handleUpdateInvitation(staleInvitationResponse, staleInvitation)
	if staleInvitationResponse.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale legacy invitation update status = %d, body = %s", staleInvitationResponse.Code, staleInvitationResponse.Body.String())
	}
}

func roleHandlerRequest(principal domain.Principal, groupID, method, body string) *http.Request {
	request := httptest.NewRequest(method, "/api/v1/groups/"+groupID+"/roles", bytes.NewBufferString(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	request.SetPathValue("groupID", groupID)
	return request.WithContext(context.WithValue(request.Context(), principalKey, principal))
}
