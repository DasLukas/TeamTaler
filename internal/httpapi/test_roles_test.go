package httpapi

import (
	"context"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
)

func assignTestTemplateRoles(t *testing.T, ctx context.Context, service groups.Service, actor domain.Principal, membership domain.Membership, templates ...domain.RoleTemplateKey) domain.Membership {
	t.Helper()
	roleIDs := append([]string(nil), membership.RoleIDs...)
	seen := make(map[string]struct{}, len(roleIDs)+len(templates))
	for _, roleID := range roleIDs {
		seen[roleID] = struct{}{}
	}
	for _, template := range templates {
		roleID := authorization.TemplateRoleID(membership.GroupID, template)
		if _, exists := seen[roleID]; exists {
			continue
		}
		seen[roleID] = struct{}{}
		roleIDs = append(roleIDs, roleID)
	}
	if _, err := service.ReplaceMemberRoles(ctx, actor, membership, membership.ID, roleIDs, membership.RoleAssignmentsVersion); err != nil {
		t.Fatalf("assign test template roles: %v", err)
	}
	updated, err := service.MembershipForUser(ctx, membership.GroupID, membership.UserID)
	if err != nil {
		t.Fatalf("reload test membership: %v", err)
	}
	return updated
}
