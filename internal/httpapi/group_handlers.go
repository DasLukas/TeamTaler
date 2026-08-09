package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/finance"
	"github.com/DasLukas/TeamTaler/internal/groups"
)

func (s *Server) handleListGroups(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	items, err := s.groups.List(request.Context(), principal.UserID)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, items)
}

func (s *Server) handleCreateGroup(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		Name     string `json:"name"`
		Currency string `json:"currency"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.groups.Create(request.Context(), principal, input.Name, input.Currency)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusCreated, item)
}

// handleUpdateGroup authorizes an administrator and updates the normalized
// group name. response receives the persisted name or Problem Details; request
// supplies session, CSRF-checked context, groupID, and JSON input. The method
// returns no Go value.
func (s *Server) handleUpdateGroup(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		Name string `json:"name"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	name, err := s.groups.UpdateName(request.Context(), principal, membership, input.Name)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"name": name})
}

// handleGetGroupSettings returns the current administrator-managed behavior
// settings. response receives GroupSettings or Problem Details; request
// supplies the authenticated group scope. The method returns no Go value.
func (s *Server) handleGetGroupSettings(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	settings, err := s.groups.Settings(request.Context(), membership)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"notificationEmailsEnabled":          settings.NotificationEmailsEnabled,
		"notificationEmailDeliveryAvailable": s.config.SMTP.Enabled,
		"defaultRoleId":                      settings.DefaultRoleID,
	})
}

// handleUpdateGroupSettings validates and persists a partial settings document.
// response receives the persisted GroupSettings or Problem Details; request
// supplies administrator identity, group scope, and JSON input. The method
// returns no Go value.
func (s *Server) handleUpdateGroupSettings(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		NotificationEmailsEnabled *bool   `json:"notificationEmailsEnabled"`
		DefaultRoleID             *string `json:"defaultRoleId"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	if input.NotificationEmailsEnabled == nil && input.DefaultRoleID == nil {
		writeProblem(response, request, domain.ValidationError{Field: "settings", Message: "must contain at least one supported field"})
		return
	}
	if input.NotificationEmailsEnabled != nil && *input.NotificationEmailsEnabled && !s.config.SMTP.Enabled {
		writeProblem(response, request, domain.ValidationError{Field: "notificationEmailsEnabled", Message: "requires configured SMTP delivery"})
		return
	}
	settings, err := s.groups.UpdateSettings(request.Context(), principal, membership, groups.SettingsUpdate{
		NotificationEmailsEnabled: input.NotificationEmailsEnabled,
		DefaultRoleID:             input.DefaultRoleID,
	})
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"notificationEmailsEnabled":          settings.NotificationEmailsEnabled,
		"notificationEmailDeliveryAvailable": s.config.SMTP.Enabled,
		"defaultRoleId":                      settings.DefaultRoleID,
	})
}

// handleGroupLogo authorizes an administrator, normalizes one multipart image,
// and attaches it to the group in the request path. response receives either a
// logoUrl JSON object or Problem Details; request supplies session, CSRF-checked
// context, groupID, and multipart input. The method returns no Go value.
func (s *Server) handleGroupLogo(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if err := authorization.Require(request.Context(), s.db, membership.GroupID, membership.ID, domain.PermissionGroupAdministration, authorization.GroupResource(membership.GroupID)); err != nil {
		writeProblem(response, request, err)
		return
	}
	imageKey, err := s.storeUploadedImage(response, request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	logoURL, _, err := s.groups.SetLogo(request.Context(), principal, membership, imageKey)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"logoUrl": logoURL})
}

// handleRemoveGroupLogo authorizes an administrator and clears the custom logo
// for the group in the request path. response receives 204 or Problem Details;
// request supplies session, CSRF-checked context, and groupID. The method
// returns no Go value.
func (s *Server) handleRemoveGroupLogo(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if _, err := s.groups.RemoveLogo(request.Context(), principal, membership); err != nil {
		writeProblem(response, request, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleListMembers(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	items, err := s.groups.ListMembers(request.Context(), membership)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	canAdmin, permissionErr := authorization.NewPolicy(s.db).Can(request.Context(), membership.GroupID, membership.ID, domain.PermissionGroupAdministration, authorization.GroupResource(membership.GroupID))
	if permissionErr != nil {
		writeProblem(response, request, permissionErr)
		return
	}
	if !canAdmin {
		activeItems := items[:0]
		for _, item := range items {
			if item.Status == "ACTIVE" {
				activeItems = append(activeItems, item)
			}
		}
		items = activeItems
	}
	encoded, _ := json.Marshal(items)
	digest := sha256.Sum256(encoded)
	response.Header().Set("ETag", `"`+hex.EncodeToString(digest[:])+`"`)
	writeJSON(response, http.StatusOK, items)
}

func (s *Server) handleUpdatePermissions(response http.ResponseWriter, request *http.Request) {
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
	var input groups.PermissionUpdate
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	version, err := s.groups.UpdatePermissions(request.Context(), principal, membership, request.PathValue("membershipID"), input, expectedVersion)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(version))
	response.WriteHeader(http.StatusNoContent)
}

// handleArchiveMember logically removes one membership while preserving its
// history. Self-removal requires the explicit confirmSelf=true query flag.
// response receives 204 or Problem Details; request supplies authenticated
// group and membership identifiers. The method returns no Go value.
func (s *Server) handleArchiveMember(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	confirmSelf := request.URL.Query().Get("confirmSelf") == "true"
	if err := s.groups.ArchiveMember(request.Context(), principal, membership, request.PathValue("membershipID"), confirmSelf); err != nil {
		writeProblem(response, request, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleListInvitations(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	items, err := s.groups.ListInvitations(request.Context(), membership)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, items)
}

func (s *Server) handleCreateInvitation(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		Email            string                                 `json:"email"`
		DisplayName      string                                 `json:"displayName"`
		Roles            []domain.Role                          `json:"roles"`
		GroupPermissions []domain.GroupPermission               `json:"groupPermissions"`
		CategoryGrants   map[string][]domain.CategoryPermission `json:"categoryGrants"`
		RoleIDs          []string                               `json:"roleIds"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	var item groups.Invitation
	if input.RoleIDs != nil {
		if len(input.Roles) > 0 || len(input.GroupPermissions) > 0 || len(input.CategoryGrants) > 0 {
			writeProblem(response, request, domain.ValidationError{Field: "roleIds", Message: "cannot be combined with deprecated roles, groupPermissions, or categoryGrants"})
			return
		}
		item, err = s.groups.CreateInvitationWithRoles(request.Context(), principal, membership, input.Email, input.DisplayName, input.RoleIDs)
	} else {
		item, err = s.groups.CreateInvitation(request.Context(), principal, membership, input.Email, input.DisplayName, input.Roles, input.GroupPermissions, input.CategoryGrants)
	}
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	acceptURL := strings.TrimSuffix(s.config.PublicURL.String(), "/") + "/invite#token=" + url.QueryEscape(item.Token)
	item.Token = ""
	writeJSON(response, http.StatusCreated, map[string]any{"invitation": item, "acceptUrl": acceptURL})
}

// handleUpdateInvitation replaces the editable display-name and permission
// defaults of an open invitation while keeping its email and token unchanged.
// response receives the updated invitation or Problem Details; request supplies
// the authenticated group, invitation identifier, and JSON update.
func (s *Server) handleUpdateInvitation(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		DisplayName      string                                 `json:"displayName"`
		Roles            []domain.Role                          `json:"roles"`
		GroupPermissions []domain.GroupPermission               `json:"groupPermissions"`
		CategoryGrants   map[string][]domain.CategoryPermission `json:"categoryGrants"`
		RoleIDs          []string                               `json:"roleIds"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	expectedVersion, versionErr := requiredIfMatchVersion(request)
	if versionErr != nil {
		writeProblem(response, request, versionErr)
		return
	}
	var item groups.Invitation
	if input.RoleIDs != nil {
		if len(input.Roles) > 0 || len(input.GroupPermissions) > 0 || len(input.CategoryGrants) > 0 {
			writeProblem(response, request, domain.ValidationError{Field: "roleIds", Message: "cannot be combined with deprecated roles, groupPermissions, or categoryGrants"})
			return
		}
		item, err = s.groups.UpdateInvitationWithRoles(request.Context(), principal, membership, request.PathValue("invitationID"), input.DisplayName, input.RoleIDs, expectedVersion)
	} else {
		item, err = s.groups.UpdateInvitation(request.Context(), principal, membership, request.PathValue("invitationID"), input.DisplayName, input.Roles, input.GroupPermissions, input.CategoryGrants, expectedVersion)
	}
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if item.RoleAssignmentsVersion > 0 {
		response.Header().Set("ETag", versionETag(item.RoleAssignmentsVersion))
	}
	writeJSON(response, http.StatusOK, item)
}

// handleRevokeInvitation logically invalidates one invitation and cancels its
// queued email. response receives 204 or Problem Details; request supplies the
// authenticated group and invitation identifier. The method returns no Go
// value.
func (s *Server) handleRevokeInvitation(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if err := s.groups.RevokeInvitation(request.Context(), principal, membership, request.PathValue("invitationID"), "revoked_by_administrator"); err != nil {
		writeProblem(response, request, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDashboard(response http.ResponseWriter, request *http.Request) {
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
	periodItems, err := s.periods.List(request.Context(), membership.GroupID)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var openPeriod domain.Period
	for _, period := range periodItems {
		if period.Status == "OPEN" {
			openPeriod = period
			break
		}
	}
	recent, err := s.bookings.List(request.Context(), membership, "", 8)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var unread int64
	_ = s.db.QueryRowContext(request.Context(), `SELECT count(*) FROM notifications WHERE group_id=? AND membership_id=? AND read_at IS NULL`, membership.GroupID, membership.ID).Scan(&unread)
	dashboard := finance.Dashboard{Account: account, OpenPeriod: openPeriod, RecentBookings: recent, UnreadCount: unread}
	canManageFinance, permissionErr := authorization.NewPolicy(s.db).Can(request.Context(), membership.GroupID, membership.ID, domain.PermissionFinanceManagement, authorization.GroupResource(membership.GroupID))
	if permissionErr != nil {
		writeProblem(response, request, permissionErr)
		return
	}
	if canManageFinance {
		var outstanding int64
		_ = s.db.QueryRowContext(request.Context(), `SELECT coalesce(sum(amount_minor),0) FROM ledger_entries WHERE group_id=? AND account='MEMBER_RECEIVABLE'`, membership.GroupID).Scan(&outstanding)
		dashboard.GroupOutstanding = &outstanding
	}
	writeJSON(response, http.StatusOK, dashboard)
}

func (s *Server) handleAudit(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if err := authorization.Require(request.Context(), s.db, membership.GroupID, membership.ID, domain.PermissionGroupAdministration, authorization.GroupResource(membership.GroupID)); err != nil {
		writeProblem(response, request, err)
		return
	}
	items, err := audit.List(request.Context(), s.db, membership.GroupID, queryLimit(request))
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, items)
}
