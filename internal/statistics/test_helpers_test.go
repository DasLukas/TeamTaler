package statistics

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

type statisticsFixture struct {
	ctx        context.Context
	db         *sql.DB
	group      groups.Service
	membership domain.Membership
	principal  domain.Principal
	periodID   string
	now        time.Time
}

func newStatisticsFixture(t *testing.T) *statisticsFixture {
	t.Helper()
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "statistics.db"))
	if err != nil {
		t.Fatalf("open statistics database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "statistics-admin@example.test", "Statistics Admin", "statistics-password-long", "Statistics Group", "EUR"); err != nil {
		t.Fatalf("bootstrap statistics fixture: %v", err)
	}
	session, err := authService.Login(ctx, "statistics-admin@example.test", "statistics-password-long")
	if err != nil {
		t.Fatalf("login statistics fixture: %v", err)
	}
	groupService := groups.Service{DB: db}
	items, err := groupService.List(ctx, session.Principal.UserID)
	if err != nil || len(items) != 1 {
		t.Fatalf("list statistics group: groups=%d err=%v", len(items), err)
	}
	fixture := &statisticsFixture{
		ctx:        ctx,
		db:         db,
		group:      groupService,
		membership: items[0].Membership,
		principal:  session.Principal,
		now:        time.Date(2026, time.September, 15, 12, 0, 0, 0, time.UTC),
	}
	if err := db.QueryRowContext(ctx, `SELECT id FROM periods WHERE group_id=? AND status='OPEN'`, fixture.membership.GroupID).Scan(&fixture.periodID); err != nil {
		t.Fatalf("read fixture open period: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE memberships SET joined_at='2026-07-01T00:00:00Z' WHERE id=?`, fixture.membership.ID); err != nil {
		t.Fatalf("set deterministic fixture membership join time: %v", err)
	}
	return fixture
}

func (f *statisticsFixture) service() Service {
	return Service{DB: f.db, Clock: func() time.Time { return f.now }}
}

func (f *statisticsFixture) enableStatistics(t *testing.T, settlements bool) {
	t.Helper()
	enabled := true
	if _, err := f.group.UpdateSettings(f.ctx, f.principal, f.membership, groups.SettingsUpdate{
		StatisticsEnabled:  &enabled,
		SettlementsEnabled: &settlements,
	}); err != nil {
		t.Fatalf("enable statistics: %v", err)
	}
}

func (f *statisticsFixture) grant(t *testing.T, permissions ...domain.PermissionKey) {
	t.Helper()
	roleID := authorization.PresetRoleID(f.membership.GroupID, domain.RolePresetGroupAdministrator)
	for _, permission := range permissions {
		if _, err := f.db.ExecContext(f.ctx, `INSERT OR IGNORE INTO role_permission_grants(
			group_id,role_id,permission_key,scope_type,version,created_at,updated_at
		) VALUES(?,?,?,'GROUP',1,?,?)`, f.membership.GroupID, roleID, permission, "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z"); err != nil {
			t.Fatalf("grant %s: %v", permission, err)
		}
	}
}

func (f *statisticsFixture) seedCatalogAndMembers(t *testing.T) []string {
	t.Helper()
	const createdAt = "2026-07-01T10:00:00Z"
	if _, err := f.db.ExecContext(f.ctx, `INSERT INTO categories(id,group_id,name,active,sort_order,version,created_at,updated_at,icon)
		VALUES('category-statistics',?,'Current category',1,0,1,?,?,'food')`, f.membership.GroupID, createdAt, createdAt); err != nil {
		t.Fatalf("insert statistics category: %v", err)
	}
	if _, err := f.db.ExecContext(f.ctx, `INSERT INTO products(id,group_id,category_id,name,price_minor,active,sort_order,version,created_at,updated_at)
		VALUES('product-statistics',?,'category-statistics','Current product',100,1,0,1,?,?)`, f.membership.GroupID, createdAt, createdAt); err != nil {
		t.Fatalf("insert statistics product: %v", err)
	}
	members := make([]string, 3)
	for index := range members {
		userID := "statistics-user-" + string(rune('a'+index))
		membershipID := "statistics-member-" + string(rune('a'+index))
		email := userID + "@example.test"
		if _, err := f.db.ExecContext(f.ctx, `INSERT INTO users(id,email,display_name,password_hash,active,created_at,updated_at)
			VALUES(?,?,?,?,1,?,?)`, userID, email, "Member", "test-password-hash", createdAt, createdAt); err != nil {
			t.Fatalf("insert statistics user %d: %v", index, err)
		}
		if _, err := f.db.ExecContext(f.ctx, `INSERT INTO memberships(id,group_id,user_id,status,joined_at)
			VALUES(?,?,?,'ACTIVE',?)`, membershipID, f.membership.GroupID, userID, createdAt); err != nil {
			t.Fatalf("insert statistics membership %d: %v", index, err)
		}
		members[index] = membershipID
	}
	return members
}

func (f *statisticsFixture) insertBooking(t *testing.T, id, targetID, createdAt, voidedAt string, quantity int64) {
	t.Helper()
	var voided any
	if voidedAt != "" {
		voided = voidedAt
	}
	if _, err := f.db.ExecContext(f.ctx, `INSERT INTO bookings(
		id,group_id,period_id,category_id,product_id,actor_membership_id,target_membership_id,
		quantity,unit_price_minor,total_minor,product_name,category_name,created_at,voided_at,version
	) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`, id, f.membership.GroupID, f.periodID, "category-statistics", "product-statistics",
		f.membership.ID, targetID, quantity, 100, quantity*100, "Historic product", "Historic category", createdAt, voided); err != nil {
		t.Fatalf("insert booking %s: %v", id, err)
	}
}
