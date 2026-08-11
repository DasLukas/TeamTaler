package authorization_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestDefinitionsAndPermissionImplications(t *testing.T) {
	definitions := authorization.Definitions()
	if len(definitions) != 13 {
		t.Fatalf("definition count = %d, want 13", len(definitions))
	}
	if definitions[0].ImpliedPermissions == nil {
		t.Fatal("permission implications are nil, want an empty API array")
	}
	definitions[0].Description = "mutated"
	if authorization.Definitions()[0].Description == "mutated" {
		t.Fatal("Definitions returned shared mutable data")
	}

	effective := authorization.ExpandPermissions([]domain.PermissionKey{
		domain.PermissionBookForOthers,
		domain.PermissionVoidAnyBooking,
		domain.PermissionBookForOthers,
	})
	for _, permission := range []domain.PermissionKey{
		domain.PermissionBookForOthers,
		domain.PermissionVoidAnyBooking,
		domain.PermissionVoidOwnBooking,
		domain.PermissionViewAllBookingActivity,
		domain.PermissionViewMemberDirectory,
	} {
		if !containsPermission(effective, permission) {
			t.Fatalf("expanded permissions %#v do not contain %s", effective, permission)
		}
	}
	if len(effective) != 5 {
		t.Fatalf("expanded permissions = %#v, want five unique keys", effective)
	}
	if containsPermission(effective, domain.PermissionBookForGuests) {
		t.Fatal("BOOK_FOR_OTHERS must not imply BOOK_FOR_GUESTS")
	}
}

func TestValidateGrantAcceptsOnlyKnownGroupScopesInV1(t *testing.T) {
	tests := []struct {
		name    string
		grant   domain.PermissionGrant
		wantErr bool
	}{
		{
			name: "group grant",
			grant: domain.PermissionGrant{
				Permission: domain.PermissionRoleManagement,
				Scope:      domain.PermissionScope{Type: domain.PermissionScopeGroup},
			},
		},
		{
			name: "unknown permission",
			grant: domain.PermissionGrant{
				Permission: "UNSUPPORTED",
				Scope:      domain.PermissionScope{Type: domain.PermissionScopeGroup},
			},
			wantErr: true,
		},
		{
			name: "category scope reserved",
			grant: domain.PermissionGrant{
				Permission: domain.PermissionBookForOthers,
				Scope: domain.PermissionScope{
					Type:       domain.PermissionScopeCategory,
					CategoryID: "category-one",
				},
			},
			wantErr: true,
		},
		{
			name: "product scope reserved",
			grant: domain.PermissionGrant{
				Permission: domain.PermissionBookForOthers,
				Scope: domain.PermissionScope{
					Type:      domain.PermissionScopeProduct,
					ProductID: "product-one",
				},
			},
			wantErr: true,
		},
		{
			name: "malformed group scope",
			grant: domain.PermissionGrant{
				Permission: domain.PermissionBookForOthers,
				Scope: domain.PermissionScope{
					Type:       domain.PermissionScopeGroup,
					CategoryID: "category-one",
				},
			},
			wantErr: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := authorization.ValidateGrant(test.grant)
			if test.wantErr && !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("ValidateGrant error = %v, want validation", err)
			}
			if !test.wantErr && err != nil {
				t.Fatalf("ValidateGrant error = %v, want nil", err)
			}
		})
	}
}

func TestPolicyUnionsRolesCalculatesImplicationsAndReadsRevocationImmediately(t *testing.T) {
	ctx := context.Background()
	db := openAuthorizationFixture(t)
	defer db.Close()

	insertIdentityFixture(t, db, "group-one", "admin-one", "member-one")
	insertIdentityFixture(t, db, "group-two", "admin-two", "member-two")
	seedAdministrator(t, db, "group-one", "admin-one", "user-admin-one")
	seedAdministrator(t, db, "group-two", "admin-two", "user-admin-two")

	now := "2026-08-07T10:00:00Z"
	statements := []struct {
		query string
		args  []any
	}{
		{
			query: `INSERT INTO roles(id,group_id,name,description,created_at,updated_at) VALUES(?,?,?,?,?,?)`,
			args:  []any{"role-custom-void", "group-one", "Booking supervisor", "Test union role", now, now},
		},
		{
			query: `INSERT INTO role_permission_grants(group_id,role_id,permission_key,scope_type,created_at,updated_at) VALUES(?,?,'VOID_ANY_BOOKING','GROUP',?,?)`,
			args:  []any{"group-one", "role-custom-void", now, now},
		},
		{
			query: `INSERT INTO roles(id,group_id,name,description,created_at,updated_at) VALUES(?,?,?,?,?,?)`,
			args:  []any{"role-custom-book", "group-one", "Booking delegate", "Second union role", now, now},
		},
		{
			query: `INSERT INTO role_permission_grants(group_id,role_id,permission_key,scope_type,created_at,updated_at) VALUES(?,?,'BOOK_FOR_OTHERS','GROUP',?,?)`,
			args:  []any{"group-one", "role-custom-book", now, now},
		},
		{
			query: `INSERT INTO membership_role_assignments(group_id,membership_id,role_id,assigned_at) VALUES(?,?,?,?)`,
			args:  []any{"group-one", "member-one", "role-custom-void", now},
		},
		{
			query: `INSERT INTO membership_role_assignments(group_id,membership_id,role_id,assigned_at) VALUES(?,?,?,?)`,
			args:  []any{"group-one", "member-one", "role-custom-book", now},
		},
	}
	for index, statement := range statements {
		if _, err := db.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("prepare policy fixture %d: %v", index, err)
		}
	}

	policy := authorization.NewPolicy(db)
	for _, permission := range []domain.PermissionKey{
		domain.PermissionVoidOwnBooking,
		domain.PermissionVoidAnyBooking,
		domain.PermissionViewAllBookingActivity,
		domain.PermissionBookForOthers,
	} {
		allowed, err := policy.Can(ctx, "group-one", "member-one", permission, authorization.GroupResource("group-one"))
		if err != nil || !allowed {
			t.Fatalf("Can(%s) = %t, %v, want true, nil", permission, allowed, err)
		}
	}

	allowed, err := policy.Can(ctx, "group-two", "member-one", domain.PermissionBookForOthers, authorization.GroupResource("group-two"))
	if err != nil || allowed {
		t.Fatalf("cross-tenant Can = %t, %v, want false, nil", allowed, err)
	}
	allowed, err = policy.Can(ctx, "group-one", "member-one", domain.PermissionBookForOthers, authorization.GroupResource("group-two"))
	if err != nil || allowed {
		t.Fatalf("mismatched resource Can = %t, %v, want false, nil", allowed, err)
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin transactional revocation: %v", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM membership_role_assignments WHERE membership_id='member-one' AND role_id='role-custom-void'`); err != nil {
		tx.Rollback()
		t.Fatalf("revoke custom role in transaction: %v", err)
	}
	allowed, err = authorization.NewPolicy(tx).Can(ctx, "group-one", "member-one", domain.PermissionViewAllBookingActivity, authorization.GroupResource("group-one"))
	if err != nil || allowed {
		tx.Rollback()
		t.Fatalf("transactional Can after revocation = %t, %v, want false, nil", allowed, err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatalf("roll back transactional revocation: %v", err)
	}
	allowed, err = policy.Can(ctx, "group-one", "member-one", domain.PermissionViewAllBookingActivity, authorization.GroupResource("group-one"))
	if err != nil || !allowed {
		t.Fatalf("Can after rolled-back revocation = %t, %v, want true, nil", allowed, err)
	}

	if _, err := db.ExecContext(ctx, `DELETE FROM membership_role_assignments WHERE membership_id='member-one' AND role_id='role-custom-void'`); err != nil {
		t.Fatalf("revoke custom role: %v", err)
	}
	allowed, err = policy.Can(ctx, "group-one", "member-one", domain.PermissionViewAllBookingActivity, authorization.GroupResource("group-one"))
	if err != nil || allowed {
		t.Fatalf("Can after immediate revocation = %t, %v, want false, nil", allowed, err)
	}
	if err := authorization.Require(ctx, db, "group-one", "member-one", domain.PermissionViewAllBookingActivity, authorization.GroupResource("group-one")); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("Require after revocation error = %v, want forbidden", err)
	}
}

func TestSeedGroupRolesIsIdempotentAndAssignsProtectedAdministratorRole(t *testing.T) {
	ctx := context.Background()
	db := openAuthorizationFixture(t)
	defer db.Close()
	insertIdentityFixture(t, db, "group-seed", "admin-seed", "member-seed")

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin seed transaction: %v", err)
	}
	now := time.Date(2026, 8, 7, 10, 0, 0, 0, time.UTC)
	if err := authorization.SeedGroupRoles(ctx, tx, "group-seed", "user-admin-seed", "admin-seed", now); err != nil {
		tx.Rollback()
		t.Fatalf("seed group roles: %v", err)
	}
	if err := authorization.SeedGroupRoles(ctx, tx, "group-seed", "user-admin-seed", "admin-seed", now); err != nil {
		tx.Rollback()
		t.Fatalf("repeat group role seed: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit group role seed: %v", err)
	}

	var roleCount, adminAssignmentCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM roles WHERE group_id='group-seed' AND preset_key IS NOT NULL`).Scan(&roleCount); err != nil {
		t.Fatalf("count seeded roles: %v", err)
	}
	if err := db.QueryRowContext(ctx, `
		SELECT count(*)
		FROM membership_role_assignments a
		JOIN roles r ON r.group_id=a.group_id AND r.id=a.role_id
		WHERE a.group_id='group-seed' AND a.membership_id='admin-seed'
		  AND r.preset_key='GROUP_ADMINISTRATOR'`).Scan(&adminAssignmentCount); err != nil {
		t.Fatalf("count administrator assignment: %v", err)
	}
	if roleCount != 4 || adminAssignmentCount != 1 {
		t.Fatalf("seeded roles/admin assignments = %d/%d, want 4/1", roleCount, adminAssignmentCount)
	}
	policy := authorization.NewPolicy(db)
	for _, definition := range authorization.Definitions() {
		allowed, err := policy.Can(ctx, "group-seed", "admin-seed", definition.Key, authorization.GroupResource("group-seed"))
		if err != nil || !allowed {
			t.Fatalf("seeded administrator Can(%s) = %t, %v, want true, nil", definition.Key, allowed, err)
		}
	}
}

func openAuthorizationFixture(t *testing.T) *sql.DB {
	t.Helper()
	db, err := storage.Open(context.Background(), filepath.Join(t.TempDir(), "authorization.db"))
	if err != nil {
		t.Fatalf("open authorization database: %v", err)
	}
	return db
}

func insertIdentityFixture(t *testing.T, db *sql.DB, groupID, adminMembershipID, memberMembershipID string) {
	t.Helper()
	ctx := context.Background()
	now := "2026-08-07T09:00:00Z"
	userAdminID := "user-" + adminMembershipID
	userMemberID := "user-" + memberMembershipID
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)`, []any{userAdminID, userAdminID + "@example.test", "Admin", "hash", now, now}},
		{`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)`, []any{userMemberID, userMemberID + "@example.test", "Member", "hash", now, now}},
		{`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES(?,?,'EUR',?,?)`, []any{groupID, groupID, now, now}},
		{`INSERT INTO group_settings(group_id,members_can_view_all_bookings,updated_at) VALUES(?,0,?)`, []any{groupID, now}},
		{`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES(?,?,?,'ACTIVE',?)`, []any{adminMembershipID, groupID, userAdminID, now}},
		{`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES(?,?,?,'ACTIVE',?)`, []any{memberMembershipID, groupID, userMemberID, now}},
	}
	for index, statement := range statements {
		if _, err := db.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("prepare identity fixture %d: %v", index, err)
		}
	}
}

func seedAdministrator(t *testing.T, db *sql.DB, groupID, adminMembershipID, actorUserID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin administrator seed: %v", err)
	}
	if err := authorization.SeedGroupRoles(ctx, tx, groupID, actorUserID, adminMembershipID, time.Date(2026, 8, 7, 9, 0, 0, 0, time.UTC)); err != nil {
		tx.Rollback()
		t.Fatalf("seed administrator: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit administrator seed: %v", err)
	}
}

func containsPermission(permissions []domain.PermissionKey, expected domain.PermissionKey) bool {
	for _, permission := range permissions {
		if permission == expected {
			return true
		}
	}
	return false
}
