package integration_test

import (
	"errors"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
)

func TestMemberManagementSeparatesGroupMembershipAndRoleResponsibilities(t *testing.T) {
	f := newFixture(t)
	groupPrincipal, groupMember, _ := f.inviteMember("group-manager@example.test", "Group Manager", nil)
	memberPrincipal, memberManager, _ := f.inviteMember("member-manager@example.test", "Member Manager", nil)
	rolePrincipal, roleManager, _ := f.inviteMember("role-manager@example.test", "Role Manager", nil)
	bookerPrincipal, booker, _ := f.inviteMember("booker@example.test", "Booker", nil)

	groupMember = assignRoleWithPermissions(t, f, groupMember, "Group configuration", domain.PermissionGroupAdministration)
	memberManager = assignRoleWithPermissions(t, f, memberManager, "Membership lifecycle", domain.PermissionMemberManagement)
	roleManager = assignRoleWithPermissions(t, f, roleManager, "Role definitions", domain.PermissionRoleManagement)
	booker = assignRoleWithPermissions(t, f, booker, "Book for others", domain.PermissionBookForOthers)

	if _, err := f.groups.Settings(f.ctx, groupMember); err != nil {
		t.Fatalf("group manager reads settings: %v", err)
	}
	notificationEmails := true
	if _, err := f.groups.UpdateSettings(f.ctx, groupPrincipal, groupMember, groups.SettingsUpdate{NotificationEmailsEnabled: &notificationEmails}); err != nil {
		t.Fatalf("group manager updates configuration: %v", err)
	}
	if _, err := f.groups.CreateInvitationWithRoles(f.ctx, groupPrincipal, groupMember, "blocked-member@example.test", "Blocked", []string{authorization.TemplateRoleID(f.group.ID, domain.RoleTemplateMember)}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("group manager invitation error=%v, want forbidden", err)
	}

	if _, err := f.groups.Settings(f.ctx, memberManager); err != nil {
		t.Fatalf("member manager reads shared settings: %v", err)
	}
	defaultRoleID := authorization.TemplateRoleID(f.group.ID, domain.RoleTemplateFinance)
	if _, err := f.groups.UpdateSettings(f.ctx, memberPrincipal, memberManager, groups.SettingsUpdate{DefaultRoleID: &defaultRoleID}); err != nil {
		t.Fatalf("member manager updates default role: %v", err)
	}
	notificationEmails = false
	if _, err := f.groups.UpdateSettings(f.ctx, memberPrincipal, memberManager, groups.SettingsUpdate{NotificationEmailsEnabled: &notificationEmails}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("member manager group configuration error=%v, want forbidden", err)
	}
	mixedDefaultRoleID := authorization.TemplateRoleID(f.group.ID, domain.RoleTemplateMember)
	mixedUpdate := groups.SettingsUpdate{DefaultRoleID: &mixedDefaultRoleID, NotificationEmailsEnabled: &notificationEmails}
	if _, err := f.groups.UpdateSettings(f.ctx, groupPrincipal, groupMember, mixedUpdate); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("group manager mixed settings error=%v, want forbidden", err)
	}
	if _, err := f.groups.UpdateSettings(f.ctx, memberPrincipal, memberManager, mixedUpdate); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("member manager mixed settings error=%v, want forbidden", err)
	}
	if _, err := f.groups.UpdateSettings(f.ctx, f.admin, f.membership, mixedUpdate); err != nil {
		t.Fatalf("administrator mixed settings update: %v", err)
	}
	if _, err := f.groups.ListMembers(f.ctx, memberManager); err != nil {
		t.Fatalf("member manager lists members: %v", err)
	}
	if _, err := f.groups.CreateInvitationWithRoles(f.ctx, memberPrincipal, memberManager, "new-member@example.test", "New Member", []string{authorization.TemplateRoleID(f.group.ID, domain.RoleTemplateMember)}); err != nil {
		t.Fatalf("member manager creates invitation: %v", err)
	}
	if _, err := f.groups.CreateRole(f.ctx, memberPrincipal, memberManager, groups.RoleCommand{Name: "Blocked role", Grants: nil}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("member manager role creation error=%v, want forbidden", err)
	}

	if _, err := f.groups.ListRoles(f.ctx, roleManager); err != nil {
		t.Fatalf("role manager lists roles: %v", err)
	}
	if _, err := f.groups.CreateRole(f.ctx, rolePrincipal, roleManager, groups.RoleCommand{Name: "Ordinary role", Grants: nil}); err != nil {
		t.Fatalf("role manager creates role: %v", err)
	}
	if _, err := f.groups.Settings(f.ctx, roleManager); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("role manager settings error=%v, want forbidden", err)
	}
	if _, err := f.groups.CreateInvitationWithRoles(f.ctx, rolePrincipal, roleManager, "blocked-role-manager@example.test", "Blocked", []string{authorization.TemplateRoleID(f.group.ID, domain.RoleTemplateMember)}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("role manager invitation error=%v, want forbidden", err)
	}
	if _, err := f.groups.ListMembers(f.ctx, booker); err != nil {
		t.Fatalf("book-for-others compatibility directory read: %v", err)
	}
	if _, err := f.groups.CreateInvitationWithRoles(f.ctx, bookerPrincipal, booker, "blocked-booker@example.test", "Blocked", []string{authorization.TemplateRoleID(f.group.ID, domain.RoleTemplateMember)}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("book-for-others invitation error=%v, want forbidden", err)
	}

	ordinaryRoleIDs := append([]string(nil), roleManager.RoleIDs...)
	ordinaryRoleIDs = append(ordinaryRoleIDs, authorization.TemplateRoleID(f.group.ID, domain.RoleTemplateCatalog))
	assignment, err := f.groups.ReplaceMemberRoles(f.ctx, memberPrincipal, memberManager, roleManager.ID, ordinaryRoleIDs, roleManager.RoleAssignmentsVersion)
	if err != nil || len(assignment.RoleIDs) != len(ordinaryRoleIDs) {
		t.Fatalf("member manager ordinary assignment=%#v err=%v", assignment, err)
	}
	protectedRoleIDs := append(append([]string(nil), assignment.RoleIDs...), authorization.PresetRoleID(f.group.ID, domain.RolePresetGroupAdministrator))
	if _, err := f.groups.ReplaceMemberRoles(f.ctx, memberPrincipal, memberManager, roleManager.ID, protectedRoleIDs, assignment.Version); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("member manager protected assignment error=%v, want forbidden", err)
	}
	if _, err := f.groups.ReplaceMemberRoles(f.ctx, f.admin, f.membership, roleManager.ID, protectedRoleIDs, assignment.Version); err != nil {
		t.Fatalf("administrator protected assignment: %v", err)
	}
}

func TestReservedAdministratorRoleAlwaysRetainsManagementCore(t *testing.T) {
	f := newFixture(t)
	roles, err := f.groups.ListRoles(f.ctx, f.membership)
	if err != nil {
		t.Fatalf("list roles: %v", err)
	}
	var administrator groups.ManagedRole
	for _, role := range roles {
		if role.PresetKey == domain.RolePresetGroupAdministrator {
			administrator = role
			break
		}
	}
	for _, permission := range []domain.PermissionKey{domain.PermissionGroupAdministration, domain.PermissionMemberManagement, domain.PermissionRoleManagement} {
		if !roleHasDirectPermission(administrator, permission) {
			t.Fatalf("administrator role lacks direct %s grant", permission)
		}
		grants := make([]domain.PermissionGrant, 0, len(administrator.Grants)-1)
		for _, grant := range administrator.Grants {
			if grant.Permission != permission {
				grants = append(grants, grant)
			}
		}
		if _, err := f.groups.UpdateRole(f.ctx, f.admin, f.membership, administrator.ID, administrator.Version, groups.RoleCommand{Name: administrator.Name, Description: administrator.Description, Grants: grants}); !errors.Is(err, domain.ErrValidation) {
			t.Fatalf("remove protected %s error=%v, want validation", permission, err)
		}
	}
}

func assignRoleWithPermissions(t *testing.T, f *fixture, membership domain.Membership, name string, permissions ...domain.PermissionKey) domain.Membership {
	t.Helper()
	grants := make([]domain.PermissionGrant, 0, len(permissions))
	for _, permission := range permissions {
		grants = append(grants, domain.PermissionGrant{Permission: permission, Scope: domain.PermissionScope{Type: domain.PermissionScopeGroup}})
	}
	role, err := f.groups.CreateRole(f.ctx, f.admin, f.membership, groups.RoleCommand{Name: name, Grants: grants})
	if err != nil {
		t.Fatalf("create %s role: %v", name, err)
	}
	roleIDs := append(append([]string(nil), membership.RoleIDs...), role.ID)
	if _, err := f.groups.ReplaceMemberRoles(f.ctx, f.admin, f.membership, membership.ID, roleIDs, membership.RoleAssignmentsVersion); err != nil {
		t.Fatalf("assign %s role: %v", name, err)
	}
	updated, err := f.groups.MembershipForUser(f.ctx, membership.GroupID, membership.UserID)
	if err != nil {
		t.Fatalf("reload %s membership: %v", name, err)
	}
	return updated
}

func roleHasDirectPermission(role groups.ManagedRole, permission domain.PermissionKey) bool {
	for _, grant := range role.Grants {
		if grant.Permission == permission && grant.Scope.Type == domain.PermissionScopeGroup {
			return true
		}
	}
	return false
}
