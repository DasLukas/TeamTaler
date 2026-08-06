package integration_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/bookings"
	"github.com/DasLukas/TeamTaler/internal/catalog"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/finance"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/periods"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

const testPassword = "a-correct-horse-battery-staple"

type fixture struct {
	t          *testing.T
	ctx        context.Context
	db         *sql.DB
	auth       auth.Service
	groups     groups.Service
	catalog    catalog.Service
	bookings   bookings.Service
	finance    finance.Service
	periods    periods.Service
	admin      domain.Principal
	group      domain.Group
	membership domain.Membership
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	authService := auth.Service{DB: db, SessionLifetime: 0}
	authService.SessionLifetime = 24 * time.Hour
	if err := authService.Bootstrap(ctx, "admin@example.test", "Admin", testPassword, "Alpha Team", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := authService.Login(ctx, "admin@example.test", testPassword)
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	groupService := groups.Service{DB: db}
	groupItems, err := groupService.List(ctx, session.Principal.UserID)
	if err != nil || len(groupItems) != 1 {
		t.Fatalf("list bootstrap group: groups=%d err=%v", len(groupItems), err)
	}
	return &fixture{
		t: t, ctx: ctx, db: db, auth: authService, groups: groupService,
		catalog: catalog.Service{DB: db}, bookings: bookings.Service{DB: db, Groups: groupService},
		finance: finance.Service{DB: db}, periods: periods.Service{DB: db},
		admin: session.Principal, group: groupItems[0], membership: groupItems[0].Membership,
	}
}

func (f *fixture) inviteMember(email, name string, roles []domain.Role) (domain.Principal, domain.Membership, string) {
	f.t.Helper()
	invitation, err := f.groups.CreateInvitation(f.ctx, f.admin, f.membership, email, name, roles, nil, nil)
	if err != nil {
		f.t.Fatalf("create invitation: %v", err)
	}
	session, membership, err := f.auth.AcceptInvitation(f.ctx, auth.InvitationAcceptance{Token: invitation.Token, DisplayName: name, Password: testPassword})
	if err != nil {
		f.t.Fatalf("accept invitation: %v", err)
	}
	return session.Principal, membership, invitation.Token
}

func (f *fixture) catalogItem(categoryName string, price int64) (domain.Category, domain.Product) {
	f.t.Helper()
	category, err := f.catalog.CreateCategory(f.ctx, f.admin, f.membership, catalog.CreateCategoryInput{Name: categoryName, Icon: domain.CategoryIconOther})
	if err != nil {
		f.t.Fatalf("create category: %v", err)
	}
	product, err := f.catalog.CreateProduct(f.ctx, f.admin, f.membership, "fixture-product-"+category.ID, category.ID, catalog.CreateProductInput{Name: "Item " + categoryName, PriceMinor: &price})
	if err != nil {
		f.t.Fatalf("create product: %v", err)
	}
	return category, product
}

func (f *fixture) openPeriodID() string {
	f.t.Helper()
	var id string
	if err := f.db.QueryRowContext(f.ctx, `SELECT id FROM periods WHERE group_id=? AND status='OPEN'`, f.group.ID).Scan(&id); err != nil {
		f.t.Fatalf("read open period: %v", err)
	}
	return id
}

func TestBootstrapLoginInvitationReplayAndTenantRBAC(t *testing.T) {
	f := newFixture(t)
	if _, err := f.groups.Create(f.ctx, f.admin, "Invalid Currency", "EU1"); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("invalid currency error = %v, want validation", err)
	}
	category, err := f.catalog.CreateCategory(f.ctx, f.admin, f.membership, catalog.CreateCategoryInput{Name: "Idempotent Products", Icon: domain.CategoryIconOther})
	if err != nil {
		t.Fatalf("create idempotency category: %v", err)
	}
	productPrice := int64(250)
	productInput := catalog.CreateProductInput{Name: "Retry-safe product", PriceMinor: &productPrice}
	product, err := f.catalog.CreateProduct(f.ctx, f.admin, f.membership, "product-create-retry", category.ID, productInput)
	if err != nil {
		t.Fatalf("create idempotent product: %v", err)
	}
	replayedProduct, err := f.catalog.CreateProduct(f.ctx, f.admin, f.membership, "product-create-retry", category.ID, productInput)
	if err != nil || replayedProduct.ID != product.ID {
		t.Fatalf("replay product=%#v err=%v", replayedProduct, err)
	}
	productInput.Name = "Conflicting retry"
	if _, err := f.catalog.CreateProduct(f.ctx, f.admin, f.membership, "product-create-retry", category.ID, productInput); !errors.Is(err, domain.ErrIdempotencyReuse) {
		t.Fatalf("reused product key error = %v, want idempotency reuse", err)
	}
	extremePrice := int64(100_000_000_001)
	if _, err := f.catalog.UpdateProduct(f.ctx, f.admin, f.membership, product.ID, catalog.UpdateProductInput{Name: product.Name, PriceMinor: &extremePrice, Active: true, Version: product.Version}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("extreme product price error = %v, want validation", err)
	}
	if _, err := f.auth.Login(f.ctx, "admin@example.test", "definitely-the-wrong-password"); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("wrong password error = %v, want unauthenticated", err)
	}
	memberPrincipal, member, invitationToken := f.inviteMember("member@example.test", "Member", nil)
	if memberPrincipal.SessionHash == "" || member.GroupID != f.group.ID {
		t.Fatalf("invitation did not create session and membership: %#v %#v", memberPrincipal, member)
	}
	if _, _, err := f.auth.AcceptInvitation(f.ctx, auth.InvitationAcceptance{Token: invitationToken, DisplayName: "Replay", Password: testPassword}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("invitation replay error = %v, want not found", err)
	}
	if _, err := f.catalog.CreateCategory(f.ctx, memberPrincipal, member, catalog.CreateCategoryInput{Name: "Forbidden", Icon: domain.CategoryIconOther}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("catalog RBAC error = %v, want forbidden", err)
	}
	if err := f.groups.UpdatePermissions(f.ctx, f.admin, f.membership, f.membership.ID, groups.PermissionUpdate{}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("last administrator removal error = %v, want conflict", err)
	}
	secondGroup, err := f.groups.Create(f.ctx, f.admin, "Beta Team", "EUR")
	if err != nil {
		t.Fatalf("create second group: %v", err)
	}
	if _, err := f.groups.MembershipForUser(f.ctx, secondGroup.ID, memberPrincipal.UserID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("cross-tenant membership error = %v, want forbidden", err)
	}
	if err := f.groups.UpdatePermissions(f.ctx, f.admin, secondGroup.Membership, member.ID, groups.PermissionUpdate{Roles: []domain.Role{domain.RoleFinanceManager}}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("cross-tenant permission update error = %v, want forbidden", err)
	}
}

func TestFinanceAccountSummariesEnforceRolesAndTenantIsolation(t *testing.T) {
	f := newFixture(t)
	_, financeMember, _ := f.inviteMember("finance@example.test", "Finance Manager", []domain.Role{domain.RoleFinanceManager})
	_, regularMember, _ := f.inviteMember("regular@example.test", "Regular Member", nil)
	_, catalogMember, _ := f.inviteMember("catalog@example.test", "Catalog Manager", []domain.Role{domain.RoleCatalogManager})
	_, archivedMember, _ := f.inviteMember("former@example.test", "Former Member", nil)
	if err := f.groups.ArchiveMember(f.ctx, f.admin, f.membership, archivedMember.ID, false); err != nil {
		t.Fatalf("archive account summary member: %v", err)
	}

	periodID := f.openPeriodID()
	entries := []struct {
		id           string
		membershipID string
		amount       int64
	}{
		{id: "led-summary-admin", membershipID: f.membership.ID, amount: 9_007_199_254_740_993},
		{id: "led-summary-catalog", membershipID: catalogMember.ID, amount: 350},
		{id: "led-summary-regular", membershipID: regularMember.ID, amount: -200},
		{id: "led-summary-archived", membershipID: archivedMember.ID, amount: 75},
	}
	for _, entry := range entries {
		if _, err := f.db.ExecContext(f.ctx, `INSERT INTO ledger_entries(id,group_id,period_id,membership_id,account,amount_minor,description,created_at)
			VALUES(?,?,?,?,'MEMBER_RECEIVABLE',?,'Account summary fixture','2026-08-05T00:00:00Z')`, entry.id, f.group.ID, periodID, entry.membershipID, entry.amount); err != nil {
			t.Fatalf("insert account summary entry %s: %v", entry.id, err)
		}
	}

	if _, err := f.finance.ListAccountSummaries(f.ctx, regularMember); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("regular account summary access error = %v, want forbidden", err)
	}
	if _, err := f.finance.ListAccountSummaries(f.ctx, catalogMember); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("catalog account summary access error = %v, want forbidden", err)
	}
	financeSummaries, err := f.finance.ListAccountSummaries(f.ctx, financeMember)
	if err != nil {
		t.Fatalf("finance-manager account summaries: %v", err)
	}
	adminSummaries, err := f.finance.ListAccountSummaries(f.ctx, f.membership)
	if err != nil {
		t.Fatalf("administrator account summaries: %v", err)
	}
	if len(financeSummaries) != 5 || len(adminSummaries) != len(financeSummaries) {
		t.Fatalf("account summary counts finance=%d admin=%d, want 5", len(financeSummaries), len(adminSummaries))
	}
	wantBalances := map[string]int64{
		f.membership.ID:   9_007_199_254_740_993,
		financeMember.ID:  0,
		regularMember.ID:  -200,
		catalogMember.ID:  350,
		archivedMember.ID: 75,
	}
	for _, summary := range financeSummaries {
		if summary.BalanceMinor != wantBalances[summary.MembershipID] {
			t.Fatalf("balance for %s = %d, want %d", summary.MembershipID, summary.BalanceMinor, wantBalances[summary.MembershipID])
		}
		if summary.MembershipID == archivedMember.ID && summary.Status != "ARCHIVED" {
			t.Fatalf("archived status = %q, want ARCHIVED", summary.Status)
		}
	}
	if financeSummaries[0].MembershipID != f.membership.ID || financeSummaries[len(financeSummaries)-1].MembershipID != archivedMember.ID {
		t.Fatalf("account summary ordering = %#v", financeSummaries)
	}

	secondGroup, err := f.groups.Create(f.ctx, f.admin, "Tenant Two Finance", "EUR")
	if err != nil {
		t.Fatalf("create second finance tenant: %v", err)
	}
	var secondPeriodID string
	if err := f.db.QueryRowContext(f.ctx, `SELECT id FROM periods WHERE group_id=? AND status='OPEN'`, secondGroup.ID).Scan(&secondPeriodID); err != nil {
		t.Fatalf("read second tenant period: %v", err)
	}
	if _, err := f.db.ExecContext(f.ctx, `INSERT INTO ledger_entries(id,group_id,period_id,membership_id,account,amount_minor,description,created_at)
		VALUES('led-summary-second-tenant',?,?,?,'MEMBER_RECEIVABLE',999,'Tenant fixture','2026-08-05T00:00:00Z')`, secondGroup.ID, secondPeriodID, secondGroup.Membership.ID); err != nil {
		t.Fatalf("insert second tenant account summary: %v", err)
	}
	secondSummaries, err := f.finance.ListAccountSummaries(f.ctx, secondGroup.Membership)
	if err != nil || len(secondSummaries) != 1 || secondSummaries[0].BalanceMinor != 999 {
		t.Fatalf("second tenant summaries = %#v, err=%v", secondSummaries, err)
	}
}

func TestOwnPaymentPermissionPostsOnlyForAuthenticatedMembership(t *testing.T) {
	f := newFixture(t)
	memberPrincipal, member, _ := f.inviteMember("self-payment@example.test", "Self Payment", nil)
	input := finance.CreateOwnPaymentInput{AmountMinor: 500, ReceivedAt: "2026-08-06T00:00:00Z", Method: "PAYPAL", Reference: "own-paypal-reference"}

	if _, err := f.finance.CreateOwnPayment(f.ctx, memberPrincipal, member, "self-payment-denied", input); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("self payment without permission error=%v, want forbidden", err)
	}
	if err := f.groups.UpdatePermissions(f.ctx, f.admin, f.membership, member.ID, groups.PermissionUpdate{
		GroupPermissions: []domain.GroupPermission{domain.PermissionSelfRecordPayment, domain.PermissionSelfRecordPayment},
	}); err != nil {
		t.Fatalf("grant self payment permission: %v", err)
	}
	if err := f.groups.UpdatePermissions(f.ctx, f.admin, f.membership, member.ID, groups.PermissionUpdate{
		GroupPermissions: []domain.GroupPermission{domain.GroupPermission("UNSUPPORTED")},
	}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("unsupported group permission error=%v, want validation", err)
	}
	member, err := f.groups.MembershipForUser(f.ctx, f.group.ID, member.UserID)
	if err != nil || len(member.GroupPermissions) != 1 || member.GroupPermissions[0] != domain.PermissionSelfRecordPayment {
		t.Fatalf("loaded group permissions=%#v err=%v", member.GroupPermissions, err)
	}

	payment, err := f.finance.CreateOwnPayment(f.ctx, memberPrincipal, member, "self-payment-posted", input)
	if err != nil {
		t.Fatalf("create own payment: %v", err)
	}
	if payment.Method != "PAYPAL" || payment.Reference != "own-paypal-reference" {
		t.Fatalf("self payment method/reference = %q/%q, want PAYPAL/own-paypal-reference", payment.Method, payment.Reference)
	}
	replayed, err := f.finance.CreateOwnPayment(f.ctx, memberPrincipal, member, "self-payment-posted", input)
	if err != nil || replayed.ID != payment.ID || payment.MembershipID != member.ID {
		t.Fatalf("replayed self payment=%#v original=%#v err=%v", replayed, payment, err)
	}
	account, err := f.finance.Account(f.ctx, member, member.ID)
	if err != nil || account.BalanceMinor != -500 {
		t.Fatalf("self payment balance=%d err=%v, want -500", account.BalanceMinor, err)
	}
	var notificationCount int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM notifications WHERE resource_id=?`, payment.ID).Scan(&notificationCount); err != nil || notificationCount != 0 {
		t.Fatalf("self payment notifications=%d err=%v, want zero", notificationCount, err)
	}
	var auditMetadata string
	if err := f.db.QueryRowContext(f.ctx, `SELECT metadata_json FROM audit_events WHERE resource_type='payment' AND resource_id=?`, payment.ID).Scan(&auditMetadata); err != nil || !strings.Contains(auditMetadata, `"source":"SELF_SERVICE"`) {
		t.Fatalf("self payment audit metadata=%q err=%v", auditMetadata, err)
	}
	if _, err := f.finance.ListPayments(f.ctx, member, 10); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("self payment member list error=%v, want forbidden", err)
	}
	if err := f.finance.ReversePayment(f.ctx, memberPrincipal, member, "self-payment-member-reverse", payment.ID, "not permitted"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("self payment member reverse error=%v, want forbidden", err)
	}
	if err := f.finance.ReversePayment(f.ctx, f.admin, f.membership, "self-payment-admin-reverse", payment.ID, "verified correction"); err != nil {
		t.Fatalf("finance reverse self payment: %v", err)
	}

	staleAuthorizedMembership := member
	if err := f.groups.UpdatePermissions(f.ctx, f.admin, f.membership, member.ID, groups.PermissionUpdate{}); err != nil {
		t.Fatalf("revoke self payment permission: %v", err)
	}
	if _, err := f.finance.CreateOwnPayment(f.ctx, memberPrincipal, staleAuthorizedMembership, "self-payment-stale-permission", input); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("self payment with stale permission snapshot error=%v, want forbidden", err)
	}
	member, err = f.groups.MembershipForUser(f.ctx, f.group.ID, member.UserID)
	if err != nil {
		t.Fatalf("reload revoked member: %v", err)
	}
	if _, err := f.finance.CreateOwnPayment(f.ctx, memberPrincipal, member, "self-payment-revoked", input); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("self payment after revocation error=%v, want forbidden", err)
	}

	workspacePayment, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "shared-payment-key", finance.CreatePaymentInput{
		MembershipID: f.membership.ID,
		AmountMinor:  100,
		Method:       "CASH",
	})
	if err != nil {
		t.Fatalf("create administrative payment with shared raw key: %v", err)
	}
	adminSelfPayment, err := f.finance.CreateOwnPayment(f.ctx, f.admin, f.membership, "shared-payment-key", finance.CreateOwnPaymentInput{
		AmountMinor: 100,
		ReceivedAt:  "2026-08-06T00:00:00Z",
		Method:      "CASH",
		Reference:   "Admin own cash payment",
	})
	if err != nil || adminSelfPayment.ID == workspacePayment.ID {
		t.Fatalf("payment endpoint idempotency scopes collided: workspace=%#v self=%#v err=%v", workspacePayment, adminSelfPayment, err)
	}
}

func TestExternalPaymentChangesNotifyTarget(t *testing.T) {
	f := newFixture(t)
	_, member, _ := f.inviteMember("payment-target@example.test", "Payment Target", nil)

	payment, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "external-payment-create", finance.CreatePaymentInput{
		MembershipID: member.ID,
		AmountMinor:  725,
		Method:       "BANK_TRANSFER",
		Reference:    "External payment",
	})
	if err != nil {
		t.Fatalf("create external payment: %v", err)
	}
	if err := f.finance.ReversePayment(f.ctx, f.admin, f.membership, "external-payment-reverse", payment.ID, "Bank correction"); err != nil {
		t.Fatalf("reverse external payment: %v", err)
	}

	rows, err := f.db.QueryContext(f.ctx, `SELECT type,context_json FROM notifications WHERE membership_id=? AND resource_id=? ORDER BY created_at,id`, member.ID, payment.ID)
	if err != nil {
		t.Fatalf("list external payment notifications: %v", err)
	}
	defer rows.Close()
	var types []string
	for rows.Next() {
		var notificationType, contextJSON string
		if err := rows.Scan(&notificationType, &contextJSON); err != nil {
			t.Fatalf("scan external payment notification: %v", err)
		}
		if !strings.Contains(contextJSON, `"amountMinor":"725"`) || !strings.Contains(contextJSON, `"currency":"EUR"`) {
			t.Fatalf("external payment notification context=%s", contextJSON)
		}
		types = append(types, notificationType)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate external payment notifications: %v", err)
	}
	if len(types) != 2 || types[0] != "PAYMENT_RECORDED" || types[1] != "PAYMENT_REVERSED" {
		t.Fatalf("external payment notification types=%v", types)
	}
}

func TestDefaultOpenPeriodLabels(t *testing.T) {
	f := newFixture(t)
	var bootstrapLabel string
	if err := f.db.QueryRowContext(f.ctx, `SELECT label FROM periods WHERE group_id=? AND status='OPEN'`, f.group.ID).Scan(&bootstrapLabel); err != nil || bootstrapLabel != domain.DefaultOpenPeriodLabel {
		t.Fatalf("bootstrap open period label = %q err=%v, want %q", bootstrapLabel, err, domain.DefaultOpenPeriodLabel)
	}
	secondGroup, err := f.groups.Create(f.ctx, f.admin, "Second Team", "EUR")
	if err != nil {
		t.Fatalf("create second group: %v", err)
	}
	var createdLabel string
	if err := f.db.QueryRowContext(f.ctx, `SELECT label FROM periods WHERE group_id=? AND status='OPEN'`, secondGroup.ID).Scan(&createdLabel); err != nil || createdLabel != domain.DefaultOpenPeriodLabel {
		t.Fatalf("created group open period label = %q err=%v, want %q", createdLabel, err, domain.DefaultOpenPeriodLabel)
	}
	closed, err := f.periods.Close(f.ctx, f.admin, f.membership, "default-period-label", f.openPeriodID(), periods.CloseInput{Label: "Initial period", DueAt: "2099-01-01"})
	if err != nil {
		t.Fatalf("close period with default successor label: %v", err)
	}
	if closed.OpenPeriod.Label != domain.DefaultOpenPeriodLabel {
		t.Fatalf("successor period label = %q, want %q", closed.OpenPeriod.Label, domain.DefaultOpenPeriodLabel)
	}
}

func TestCategoryIconCreationUpdateAndValidation(t *testing.T) {
	f := newFixture(t)
	category, err := f.catalog.CreateCategory(f.ctx, f.admin, f.membership, catalog.CreateCategoryInput{
		Name: "Team events", Icon: domain.CategoryIconEvent, SortOrder: 4,
	})
	if err != nil {
		t.Fatalf("create category with icon: %v", err)
	}
	if category.Icon != domain.CategoryIconEvent {
		t.Fatalf("created category icon = %q, want %q", category.Icon, domain.CategoryIconEvent)
	}

	updated, err := f.catalog.UpdateCategory(f.ctx, f.admin, f.membership, category.ID, catalog.UpdateCategoryInput{
		Name: category.Name, Icon: domain.CategoryIconSport, Active: true, SortOrder: category.SortOrder, Version: category.Version,
	})
	if err != nil {
		t.Fatalf("update category icon: %v", err)
	}
	if updated.Icon != domain.CategoryIconSport || updated.Version != category.Version+1 {
		t.Fatalf("updated category = %#v", updated)
	}

	listed, err := f.catalog.List(f.ctx, f.group.ID)
	if err != nil || len(listed) != 1 || listed[0].Icon != domain.CategoryIconSport {
		t.Fatalf("listed categories = %#v, err=%v", listed, err)
	}
	account, err := f.finance.Account(f.ctx, f.membership, f.membership.ID)
	if err != nil || len(account.CategoryStats) != 1 || account.CategoryStats[0].Icon != domain.CategoryIconSport {
		t.Fatalf("category statistics = %#v, err=%v", account.CategoryStats, err)
	}
	if _, err := f.catalog.CreateCategory(f.ctx, f.admin, f.membership, catalog.CreateCategoryInput{
		Name: "Unsafe icon", Icon: domain.CategoryIcon("<script>"),
	}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("unsupported category icon error = %v, want validation", err)
	}
}

func TestCatalogReorderPersistsAcrossCatalogBookingAndDashboardReads(t *testing.T) {
	f := newFixture(t)
	first, firstProduct := f.catalogItem("First", 100)
	second, secondCategoryProduct := f.catalogItem("Second", 200)
	third, thirdCategoryProduct := f.catalogItem("Third", 300)
	secondFirstPrice := int64(150)
	secondProduct, err := f.catalog.CreateProduct(f.ctx, f.admin, f.membership, "reorder-second-product", first.ID, catalog.CreateProductInput{
		Name: "Second product", PriceMinor: &secondFirstPrice,
	})
	if err != nil {
		t.Fatalf("create second reorder product: %v", err)
	}
	if first.SortOrder != 0 || second.SortOrder != 1 || third.SortOrder != 2 || firstProduct.SortOrder != 0 || secondProduct.SortOrder != 1 {
		t.Fatalf("appended catalog positions categories=%d,%d,%d products=%d,%d", first.SortOrder, second.SortOrder, third.SortOrder, firstProduct.SortOrder, secondProduct.SortOrder)
	}
	_, regularMember, _ := f.inviteMember("catalog-reorder-member@example.test", "Catalog Reorder Member", nil)
	order := catalog.ReorderInput{
		CategoryIDs: []string{third.ID, first.ID, second.ID},
		ProductIDsByCategory: map[string][]string{
			third.ID:  {thirdCategoryProduct.ID},
			first.ID:  {secondProduct.ID, firstProduct.ID},
			second.ID: {secondCategoryProduct.ID},
		},
	}
	if err := f.catalog.Reorder(f.ctx, f.admin, regularMember, order); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("regular member reorder error=%v, want forbidden", err)
	}
	invalidOrder := order
	invalidOrder.CategoryIDs = []string{third.ID, third.ID, second.ID}
	if err := f.catalog.Reorder(f.ctx, f.admin, f.membership, invalidOrder); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("duplicate category reorder error=%v, want validation", err)
	}
	if err := f.catalog.Reorder(f.ctx, f.admin, f.membership, order); err != nil {
		t.Fatalf("reorder catalog: %v", err)
	}

	listed, err := f.catalog.List(f.ctx, f.group.ID)
	if err != nil {
		t.Fatalf("list reordered catalog: %v", err)
	}
	if len(listed) != 3 || listed[0].ID != third.ID || listed[1].ID != first.ID || listed[2].ID != second.ID {
		t.Fatalf("reordered categories=%#v", listed)
	}
	if len(listed[1].Products) != 2 || listed[1].Products[0].ID != secondProduct.ID || listed[1].Products[1].ID != firstProduct.ID {
		t.Fatalf("reordered products=%#v", listed[1].Products)
	}
	if listed[0].Version != third.Version+1 || listed[1].Products[0].Version != secondProduct.Version+1 {
		t.Fatalf("reordered versions category=%d product=%d", listed[0].Version, listed[1].Products[0].Version)
	}
	account, err := f.finance.Account(f.ctx, f.membership, f.membership.ID)
	if err != nil || len(account.CategoryStats) != 3 || account.CategoryStats[0].CategoryID != third.ID || account.CategoryStats[1].CategoryID != first.ID {
		t.Fatalf("dashboard category order=%#v err=%v", account.CategoryStats, err)
	}
	var auditCount int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM audit_events WHERE group_id=? AND action='catalog.reordered'`, f.group.ID).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatalf("catalog reorder audit count=%d err=%v", auditCount, err)
	}
}

func TestCatalogDeletionRequiresArchivalAndPreservesHistory(t *testing.T) {
	f := newFixture(t)
	category, product := f.catalogItem("Disposable", 125)
	regularPrincipal, regularMembership, _ := f.inviteMember("catalog-delete-member@example.test", "Catalog Delete Member", nil)
	if err := f.catalog.DeleteProduct(f.ctx, regularPrincipal, regularMembership, product.ID, product.Version); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("regular member delete product error=%v, want forbidden", err)
	}
	secondGroup, err := f.groups.Create(f.ctx, f.admin, "Catalog Delete Tenant", "EUR")
	if err != nil {
		t.Fatalf("create second deletion tenant: %v", err)
	}
	if err := f.catalog.DeleteProduct(f.ctx, f.admin, secondGroup.Membership, product.ID, product.Version); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("cross-tenant delete product error=%v, want not found", err)
	}
	if err := f.catalog.DeleteProduct(f.ctx, f.admin, f.membership, product.ID, product.Version); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("delete active product error=%v, want conflict", err)
	}
	archivedProduct, err := f.catalog.UpdateProduct(f.ctx, f.admin, f.membership, product.ID, catalog.UpdateProductInput{
		Name: product.Name, PriceMinor: product.PriceMinor, PricingMode: product.PricingMode, Active: false, SortOrder: product.SortOrder, Version: product.Version,
	})
	if err != nil {
		t.Fatalf("archive disposable product: %v", err)
	}
	if err := f.catalog.DeleteProduct(f.ctx, f.admin, f.membership, product.ID, product.Version); !errors.Is(err, domain.ErrPrecondition) {
		t.Fatalf("delete stale product error=%v, want precondition", err)
	}
	if err := f.catalog.DeleteProduct(f.ctx, f.admin, f.membership, product.ID, archivedProduct.Version); err != nil {
		t.Fatalf("delete archived unused product: %v", err)
	}
	var deletedUnusedProducts int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM products WHERE id=?`, product.ID).Scan(&deletedUnusedProducts); err != nil || deletedUnusedProducts != 0 {
		t.Fatalf("physically deleted unused products=%d err=%v, want zero", deletedUnusedProducts, err)
	}
	recreated, err := f.catalog.CreateProduct(f.ctx, f.admin, f.membership, "fixture-product-"+category.ID, category.ID, catalog.CreateProductInput{Name: product.Name, PriceMinor: product.PriceMinor})
	if err != nil || recreated.ID == product.ID {
		t.Fatalf("recreate after idempotency cleanup product=%#v err=%v", recreated, err)
	}
	recreated, err = f.catalog.UpdateProduct(f.ctx, f.admin, f.membership, recreated.ID, catalog.UpdateProductInput{
		Name: recreated.Name, PriceMinor: recreated.PriceMinor, PricingMode: recreated.PricingMode, Active: false, SortOrder: recreated.SortOrder, Version: recreated.Version,
	})
	if err != nil || f.catalog.DeleteProduct(f.ctx, f.admin, f.membership, recreated.ID, recreated.Version) != nil {
		t.Fatalf("remove recreated product=%#v err=%v", recreated, err)
	}
	if err := f.catalog.DeleteCategory(f.ctx, f.admin, f.membership, category.ID, category.Version); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("delete active category error=%v, want conflict", err)
	}
	if err := f.groups.UpdatePermissions(f.ctx, f.admin, f.membership, regularMembership.ID, groups.PermissionUpdate{
		CategoryGrants: map[string][]domain.CategoryPermission{category.ID: {domain.PermissionAssignToOthers}},
	}); err != nil {
		t.Fatalf("grant disposable category permission: %v", err)
	}
	if _, err := f.groups.CreateInvitation(f.ctx, f.admin, f.membership, "pending-delete@example.test", "Pending Delete", nil, nil,
		map[string][]domain.CategoryPermission{category.ID: {domain.PermissionAssignToOthers}}); err != nil {
		t.Fatalf("create invitation with category grant: %v", err)
	}
	archivedCategory, err := f.catalog.UpdateCategory(f.ctx, f.admin, f.membership, category.ID, catalog.UpdateCategoryInput{
		Name: category.Name, Icon: category.Icon, Active: false, SortOrder: category.SortOrder, Version: category.Version,
	})
	if err != nil {
		t.Fatalf("archive disposable category: %v", err)
	}
	if err := f.catalog.DeleteCategory(f.ctx, f.admin, f.membership, category.ID, archivedCategory.Version); err != nil {
		t.Fatalf("delete archived unused category: %v", err)
	}
	var staleInvitationGrants, staleMembershipGrants, deletionAudits int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM invitations WHERE group_id=? AND json_type(category_grants_json, ?) IS NOT NULL`, f.group.ID, `$."`+category.ID+`"`).Scan(&staleInvitationGrants); err != nil {
		t.Fatalf("read invitation grants: %v", err)
	}
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM audit_events WHERE group_id=? AND action IN ('product.deleted','category.deleted')`, f.group.ID).Scan(&deletionAudits); err != nil {
		t.Fatalf("read deletion audits: %v", err)
	}
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM category_permissions WHERE group_id=? AND category_id=?`, f.group.ID, category.ID).Scan(&staleMembershipGrants); err != nil {
		t.Fatalf("read membership grants: %v", err)
	}
	if staleInvitationGrants != 0 || staleMembershipGrants != 0 || deletionAudits != 3 {
		t.Fatalf("post-delete invitation grants=%d membership grants=%d deletion audits=%d", staleInvitationGrants, staleMembershipGrants, deletionAudits)
	}

	historyCategory, historyProduct := f.catalogItem("Historical", 250)
	periodID := f.openPeriodID()
	historicalBooking, err := f.bookings.Create(f.ctx, f.admin, f.membership, "catalog-delete-history", bookings.CreateInput{
		ProductID: historyProduct.ID, ProductVersion: historyProduct.Version, ExpectedPeriodID: periodID, Quantity: 1,
	})
	if err != nil {
		t.Fatalf("create historical booking: %v", err)
	}
	imageKey := strings.Repeat("a", 64) + ".png"
	if _, err := f.db.ExecContext(f.ctx, `UPDATE products SET image_key=? WHERE id=? AND group_id=?`, imageKey, historyProduct.ID, f.group.ID); err != nil {
		t.Fatalf("attach historical product image fixture: %v", err)
	}
	historyProduct, err = f.catalog.UpdateProduct(f.ctx, f.admin, f.membership, historyProduct.ID, catalog.UpdateProductInput{
		Name: historyProduct.Name, PriceMinor: historyProduct.PriceMinor, PricingMode: historyProduct.PricingMode, Active: false, SortOrder: historyProduct.SortOrder, Version: historyProduct.Version,
	})
	if err != nil {
		t.Fatalf("archive historical product: %v", err)
	}
	if err := f.catalog.DeleteProduct(f.ctx, f.admin, f.membership, historyProduct.ID, historyProduct.Version); err != nil {
		t.Fatalf("delete historical product: %v", err)
	}
	var tombstoneActive bool
	var tombstoneDeletedAt sql.NullString
	var tombstoneImageKey sql.NullString
	var tombstoneVersion int64
	if err := f.db.QueryRowContext(f.ctx, `SELECT active,deleted_at,image_key,version FROM products WHERE id=? AND group_id=?`, historyProduct.ID, f.group.ID).
		Scan(&tombstoneActive, &tombstoneDeletedAt, &tombstoneImageKey, &tombstoneVersion); err != nil {
		t.Fatalf("read historical product tombstone: %v", err)
	}
	if tombstoneActive || !tombstoneDeletedAt.Valid || tombstoneImageKey.Valid || tombstoneVersion != historyProduct.Version+1 {
		t.Fatalf("historical product tombstone active=%v deletedAt=%q imageKey=%q version=%d", tombstoneActive, tombstoneDeletedAt.String, tombstoneImageKey.String, tombstoneVersion)
	}
	listedCatalog, err := f.catalog.List(f.ctx, f.group.ID)
	if err != nil || len(listedCatalog) != 1 || listedCatalog[0].ID != historyCategory.ID || len(listedCatalog[0].Products) != 0 {
		t.Fatalf("catalog after historical product deletion=%#v err=%v", listedCatalog, err)
	}
	if err := f.catalog.Reorder(f.ctx, f.admin, f.membership, catalog.ReorderInput{
		CategoryIDs: []string{historyCategory.ID}, ProductIDsByCategory: map[string][]string{historyCategory.ID: {}},
	}); err != nil {
		t.Fatalf("reorder catalog without tombstoned product: %v", err)
	}
	if _, err := f.catalog.UpdateProduct(f.ctx, f.admin, f.membership, historyProduct.ID, catalog.UpdateProductInput{
		Name: historyProduct.Name, PriceMinor: historyProduct.PriceMinor, PricingMode: historyProduct.PricingMode, Active: false, SortOrder: historyProduct.SortOrder, Version: tombstoneVersion,
	}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("update tombstoned product error=%v, want not found", err)
	}
	if _, _, err := f.catalog.SetProductImage(f.ctx, f.admin, f.membership, historyProduct.ID, strings.Repeat("b", 64)+".png"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("image update for tombstoned product error=%v, want not found", err)
	}
	if _, err := f.catalog.ProductCategory(f.ctx, f.group.ID, historyProduct.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("category lookup for tombstoned product error=%v, want not found", err)
	}
	if err := f.catalog.DeleteProduct(f.ctx, f.admin, f.membership, historyProduct.ID, tombstoneVersion); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("repeat historical product deletion error=%v, want not found", err)
	}
	if _, err := f.bookings.Create(f.ctx, f.admin, f.membership, "catalog-delete-history-rebook", bookings.CreateInput{
		ProductID: historyProduct.ID, ProductVersion: tombstoneVersion, ExpectedPeriodID: periodID, Quantity: 1,
	}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("booking tombstoned product error=%v, want not found", err)
	}
	historicalBookings, err := f.bookings.List(f.ctx, f.membership, periodID, 20)
	if err != nil || len(historicalBookings) != 1 || historicalBookings[0].ID != historicalBooking.ID || historicalBookings[0].ProductName != historyProduct.Name {
		t.Fatalf("historical bookings after product deletion=%#v err=%v", historicalBookings, err)
	}
	account, err := f.finance.Account(f.ctx, f.membership, f.membership.ID)
	if err != nil || account.BalanceMinor != 250 || account.OpenPeriodDue != 250 {
		t.Fatalf("account after historical product deletion=%#v err=%v", account, err)
	}
	closeResult, err := f.periods.Close(f.ctx, f.admin, f.membership, "catalog-delete-history-close", periodID, periods.CloseInput{
		Label: "Historical close", DueAt: "2099-01-01", NextPeriodLabel: "Next period",
	})
	if err != nil || closeResult.Statements != 2 {
		t.Fatalf("close period after historical product deletion=%#v err=%v", closeResult, err)
	}
	statements, err := f.periods.Statements(f.ctx, f.membership, periodID)
	if err != nil || len(statements) != 2 {
		t.Fatalf("statements after historical product deletion=%#v err=%v", statements, err)
	}
	var adminStatement *domain.Statement
	for index := range statements {
		if statements[index].MembershipID == f.membership.ID {
			adminStatement = &statements[index]
			break
		}
	}
	if adminStatement == nil || adminStatement.ChargesMinor != 250 || adminStatement.AmountDueMinor != 250 {
		t.Fatalf("admin statement after historical product deletion=%#v", adminStatement)
	}
	historyCategory, err = f.catalog.UpdateCategory(f.ctx, f.admin, f.membership, historyCategory.ID, catalog.UpdateCategoryInput{
		Name: historyCategory.Name, Icon: historyCategory.Icon, Active: false, SortOrder: historyCategory.SortOrder, Version: historyCategory.Version,
	})
	if err != nil {
		t.Fatalf("archive historical category: %v", err)
	}
	if err := f.catalog.DeleteCategory(f.ctx, f.admin, f.membership, historyCategory.ID, historyCategory.Version); !errors.Is(err, domain.ErrConflict) || !strings.Contains(err.Error(), "historical financial records") {
		t.Fatalf("delete historical category error=%v, want financial-history conflict", err)
	}
}

func TestAuthenticationThrottlesSessionActivityWrites(t *testing.T) {
	f := newFixture(t)
	session, err := f.auth.Login(f.ctx, "admin@example.test", testPassword)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	const recent = "2099-01-01T00:00:00Z"
	if _, err := f.db.ExecContext(f.ctx, `UPDATE sessions SET last_seen_at=? WHERE id_hash=?`, recent, session.Principal.SessionHash); err != nil {
		t.Fatalf("set recent session activity: %v", err)
	}
	if _, err := f.auth.Authenticate(f.ctx, session.Token, session.CSRFToken); err != nil {
		t.Fatalf("authenticate recent session: %v", err)
	}
	var lastSeen string
	if err := f.db.QueryRowContext(f.ctx, `SELECT last_seen_at FROM sessions WHERE id_hash=?`, session.Principal.SessionHash).Scan(&lastSeen); err != nil || lastSeen != recent {
		t.Fatalf("recent session activity = %q err=%v, want unchanged", lastSeen, err)
	}
	const stale = "2000-01-01T00:00:00Z"
	if _, err := f.db.ExecContext(f.ctx, `UPDATE sessions SET last_seen_at=? WHERE id_hash=?`, stale, session.Principal.SessionHash); err != nil {
		t.Fatalf("set stale session activity: %v", err)
	}
	if _, err := f.auth.Authenticate(f.ctx, session.Token, session.CSRFToken); err != nil {
		t.Fatalf("authenticate stale session: %v", err)
	}
	if err := f.db.QueryRowContext(f.ctx, `SELECT last_seen_at FROM sessions WHERE id_hash=?`, session.Principal.SessionHash).Scan(&lastSeen); err != nil || lastSeen == stale {
		t.Fatalf("stale session activity was not refreshed: %q err=%v", lastSeen, err)
	}
}

func TestBookingUndoAssignmentValidationAndBalancedLedger(t *testing.T) {
	f := newFixture(t)
	memberPrincipal, member, _ := f.inviteMember("booker@example.test", "Booker", nil)
	primaryCategory, primaryProduct := f.catalogItem("Drinks", 125)
	_, otherProduct := f.catalogItem("Penalties", 500)
	periodID := f.openPeriodID()
	input := bookings.CreateInput{ProductID: primaryProduct.ID, ProductVersion: primaryProduct.Version, ExpectedPeriodID: periodID, Quantity: 2}
	booking, err := f.bookings.Create(f.ctx, memberPrincipal, member, "booking-key-one", input)
	if err != nil {
		t.Fatalf("create self booking: %v", err)
	}
	replayed, err := f.bookings.Create(f.ctx, memberPrincipal, member, "booking-key-one", input)
	if err != nil || replayed.ID != booking.ID {
		t.Fatalf("idempotent replay = %#v err=%v", replayed, err)
	}
	var ledgerTotal int64
	if err := f.db.QueryRowContext(f.ctx, `SELECT sum(amount_minor) FROM ledger_entries WHERE booking_id=?`, booking.ID).Scan(&ledgerTotal); err != nil || ledgerTotal != 0 {
		t.Fatalf("booking ledger sum = %d err=%v, want zero", ledgerTotal, err)
	}
	voided, err := f.bookings.Void(f.ctx, memberPrincipal, member, "void-booking-one", booking.ID, "")
	if err != nil {
		t.Fatalf("30-second self undo: %v", err)
	}
	if replayedVoid, err := f.bookings.Void(f.ctx, memberPrincipal, member, "void-booking-one", booking.ID, ""); err != nil || replayedVoid.ID != voided.ID {
		t.Fatalf("idempotent booking reversal replay=%#v err=%v", replayedVoid, err)
	}
	var originalLedgerID, reversalPeriodID, reversalMembershipID, reversalCategoryID, reversalAccount, reversalDescription string
	var reversalAmount int64
	if err := f.db.QueryRowContext(f.ctx, `SELECT reversal_of,period_id,coalesce(membership_id,''),coalesce(category_id,''),account,amount_minor,description
		FROM ledger_entries WHERE booking_id=? AND reversal_of IS NOT NULL LIMIT 1`, booking.ID).
		Scan(&originalLedgerID, &reversalPeriodID, &reversalMembershipID, &reversalCategoryID, &reversalAccount, &reversalAmount, &reversalDescription); err != nil {
		t.Fatalf("read ledger reversal: %v", err)
	}
	if _, err := f.db.ExecContext(f.ctx, `INSERT INTO ledger_entries(id,group_id,period_id,membership_id,category_id,booking_id,reversal_of,account,amount_minor,description,created_at)
		VALUES('led_duplicate',?,?,?,?,?,?,?,?,?,'2099-01-01T00:00:00Z')`, f.group.ID, reversalPeriodID, nullableTest(reversalMembershipID), nullableTest(reversalCategoryID), booking.ID, originalLedgerID, reversalAccount, reversalAmount, reversalDescription); err == nil {
		t.Fatal("duplicate ledger reversal unexpectedly succeeded")
	}
	late, err := f.bookings.Create(f.ctx, memberPrincipal, member, "booking-key-two", bookings.CreateInput{ProductID: primaryProduct.ID, ProductVersion: primaryProduct.Version, ExpectedPeriodID: periodID, Quantity: 1})
	if err != nil {
		t.Fatalf("create late booking fixture: %v", err)
	}
	if _, err := f.db.ExecContext(f.ctx, `UPDATE bookings SET created_at='2000-01-01T00:00:00Z' WHERE id=?`, late.ID); err != nil {
		t.Fatalf("age booking: %v", err)
	}
	if _, err := f.bookings.Void(f.ctx, memberPrincipal, member, "void-booking-two", late.ID, ""); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("late self undo error = %v, want forbidden", err)
	}
	assignmentInput := bookings.CreateInput{ProductID: otherProduct.ID, ProductVersion: otherProduct.Version, ExpectedPeriodID: periodID, Quantity: 2, TargetMembershipID: member.ID}
	if _, err := f.bookings.Create(f.ctx, f.admin, f.membership, "assignment-no-reason", assignmentInput); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("third-party booking without reason = %v, want validation", err)
	}
	assignmentInput.Reason = "Late for training"
	if _, err := f.bookings.Create(f.ctx, f.admin, f.membership, "assignment-with-reason", assignmentInput); err != nil {
		t.Fatalf("third-party booking with reason: %v", err)
	}
	var notifications int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM notifications WHERE membership_id=?`, member.ID).Scan(&notifications); err != nil || notifications != 1 {
		t.Fatalf("assignment notifications = %d err=%v, want one", notifications, err)
	}
	if _, err := f.bookings.Create(f.ctx, memberPrincipal, member, "foreign-booking", bookings.CreateInput{ProductID: primaryProduct.ID, ProductVersion: primaryProduct.Version, ExpectedPeriodID: periodID, Quantity: 1, TargetMembershipID: f.membership.ID}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("unauthorized foreign booking = %v, want forbidden", err)
	}
	if err := f.groups.UpdatePermissions(f.ctx, f.admin, f.membership, member.ID, groups.PermissionUpdate{CategoryGrants: map[string][]domain.CategoryPermission{primaryCategory.ID: {domain.PermissionAssignToOthers}}}); err != nil {
		t.Fatalf("grant category assignment permission: %v", err)
	}
	member, err = f.groups.MembershipForUser(f.ctx, f.group.ID, memberPrincipal.UserID)
	if err != nil {
		t.Fatalf("reload member grants: %v", err)
	}
	if _, err := f.bookings.Create(f.ctx, memberPrincipal, member, "foreign-booking-granted", bookings.CreateInput{ProductID: primaryProduct.ID, ProductVersion: primaryProduct.Version, ExpectedPeriodID: periodID, Quantity: 1, TargetMembershipID: f.membership.ID, Reason: "Team purchase"}); err != nil {
		t.Fatalf("category-granted foreign booking: %v", err)
	}
	adminPrimary, err := f.bookings.Create(f.ctx, f.admin, f.membership, "admin-only-primary", bookings.CreateInput{ProductID: primaryProduct.ID, ProductVersion: primaryProduct.Version, ExpectedPeriodID: periodID, Quantity: 1})
	if err != nil {
		t.Fatalf("create administrator primary booking: %v", err)
	}
	adminOther, err := f.bookings.Create(f.ctx, f.admin, f.membership, "admin-only-other", bookings.CreateInput{ProductID: otherProduct.ID, ProductVersion: otherProduct.Version, ExpectedPeriodID: periodID, Quantity: 1})
	if err != nil {
		t.Fatalf("create administrator other booking: %v", err)
	}
	visible, err := f.bookings.List(f.ctx, member, periodID, 200)
	if err != nil {
		t.Fatalf("list before void grant: %v", err)
	}
	for _, item := range visible {
		if item.ID == adminPrimary.ID || item.ID == adminOther.ID {
			t.Fatalf("foreign booking %s leaked without void grant", item.ID)
		}
	}
	if err := f.groups.UpdatePermissions(f.ctx, f.admin, f.membership, member.ID, groups.PermissionUpdate{CategoryGrants: map[string][]domain.CategoryPermission{primaryCategory.ID: {domain.PermissionAssignToOthers, domain.PermissionVoidBookings}}}); err != nil {
		t.Fatalf("grant category void permission: %v", err)
	}
	member, err = f.groups.MembershipForUser(f.ctx, f.group.ID, memberPrincipal.UserID)
	if err != nil {
		t.Fatalf("reload member void grant: %v", err)
	}
	visible, err = f.bookings.List(f.ctx, member, periodID, 200)
	if err != nil {
		t.Fatalf("list after void grant: %v", err)
	}
	foundPrimary := false
	for _, item := range visible {
		if item.ID == adminPrimary.ID {
			foundPrimary = item.CanVoid
		}
		if item.ID == adminOther.ID {
			t.Fatal("foreign booking from an ungranted category was visible")
		}
	}
	if !foundPrimary {
		t.Fatal("category void grantee could not discover and manage the foreign booking")
	}
	activity, err := f.bookings.ListActivity(f.ctx, member, periodID, 200)
	if err != nil {
		t.Fatalf("list activity with disabled group setting: %v", err)
	}
	for _, item := range activity {
		if item.ID == adminOther.ID {
			t.Fatal("ungranted foreign booking leaked while group-wide visibility was disabled")
		}
	}
	if _, err := f.groups.UpdateSettings(f.ctx, f.admin, f.membership, domain.GroupSettings{MembersCanViewAllBookings: true}); err != nil {
		t.Fatalf("enable group-wide booking visibility: %v", err)
	}
	activity, err = f.bookings.ListActivity(f.ctx, member, periodID, 200)
	if err != nil {
		t.Fatalf("list activity with enabled group setting: %v", err)
	}
	foundOther := false
	for _, item := range activity {
		if item.ID == adminOther.ID {
			foundOther = true
			if item.CanVoid {
				t.Fatal("group-wide read visibility unexpectedly granted void permission")
			}
		}
	}
	if !foundOther {
		t.Fatal("group-wide booking visibility did not expose historical foreign booking")
	}
	dashboardVisible, err := f.bookings.List(f.ctx, member, periodID, 200)
	if err != nil {
		t.Fatalf("list personal dashboard bookings: %v", err)
	}
	for _, item := range dashboardVisible {
		if item.ID == adminOther.ID {
			t.Fatal("group-wide activity setting changed the personal dashboard booking scope")
		}
	}
}

func TestUserDefinedProductPricingIsValidatedAndSnapshotted(t *testing.T) {
	f := newFixture(t)
	category, err := f.catalog.CreateCategory(f.ctx, f.admin, f.membership, catalog.CreateCategoryInput{Name: "Flexible charges", Icon: domain.CategoryIconMoney})
	if err != nil {
		t.Fatalf("create flexible category: %v", err)
	}
	customProduct, err := f.catalog.CreateProduct(f.ctx, f.admin, f.membership, "custom-product-price", category.ID, catalog.CreateProductInput{
		Name: "Contribution", PricingMode: domain.ProductPricingUserDefined,
	})
	if err != nil {
		t.Fatalf("create user-defined-price product: %v", err)
	}
	if customProduct.PricingMode != domain.ProductPricingUserDefined || customProduct.PriceMinor != nil {
		t.Fatalf("custom product pricing = %s/%v", customProduct.PricingMode, customProduct.PriceMinor)
	}
	fixedPrice := int64(125)
	fixedProduct, err := f.catalog.CreateProduct(f.ctx, f.admin, f.membership, "fixed-product-price", category.ID, catalog.CreateProductInput{
		Name: "Fixed", PriceMinor: &fixedPrice,
	})
	if err != nil || fixedProduct.PricingMode != domain.ProductPricingFixed {
		t.Fatalf("create compatible fixed product: product=%#v err=%v", fixedProduct, err)
	}
	if _, err := f.catalog.CreateProduct(f.ctx, f.admin, f.membership, "invalid-custom-price", category.ID, catalog.CreateProductInput{
		Name: "Invalid", PricingMode: domain.ProductPricingUserDefined, PriceMinor: &fixedPrice,
	}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("custom product with catalog price error = %v, want validation", err)
	}
	if _, err := f.catalog.CreateProduct(f.ctx, f.admin, f.membership, "invalid-fixed-price", category.ID, catalog.CreateProductInput{
		Name: "Invalid", PricingMode: domain.ProductPricingFixed,
	}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("fixed product without catalog price error = %v, want validation", err)
	}

	periodID := f.openPeriodID()
	baseInput := bookings.CreateInput{ProductID: customProduct.ID, ProductVersion: customProduct.Version, ExpectedPeriodID: periodID, Quantity: 2}
	if _, err := f.bookings.Create(f.ctx, f.admin, f.membership, "custom-price-missing", baseInput); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("missing user-defined unit price error = %v, want validation", err)
	}
	chosenPrice := int64(350)
	baseInput.UnitPriceMinor = &chosenPrice
	booking, err := f.bookings.Create(f.ctx, f.admin, f.membership, "custom-price-booking", baseInput)
	if err != nil {
		t.Fatalf("book user-defined price: %v", err)
	}
	if booking.UnitPriceMinor != chosenPrice || booking.TotalMinor != 700 {
		t.Fatalf("custom booking price = %d total = %d, want 350/700", booking.UnitPriceMinor, booking.TotalMinor)
	}
	replayed, err := f.bookings.Create(f.ctx, f.admin, f.membership, "custom-price-booking", baseInput)
	if err != nil || replayed.ID != booking.ID {
		t.Fatalf("replay custom booking = %#v err=%v", replayed, err)
	}
	differentPrice := int64(400)
	baseInput.UnitPriceMinor = &differentPrice
	if _, err := f.bookings.Create(f.ctx, f.admin, f.membership, "custom-price-booking", baseInput); !errors.Is(err, domain.ErrIdempotencyReuse) {
		t.Fatalf("changed custom price idempotency error = %v, want reuse rejection", err)
	}
	if _, err := f.bookings.Create(f.ctx, f.admin, f.membership, "fixed-price-override", bookings.CreateInput{
		ProductID: fixedProduct.ID, ProductVersion: fixedProduct.Version, ExpectedPeriodID: periodID, Quantity: 1, UnitPriceMinor: &chosenPrice,
	}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("fixed-price override error = %v, want validation", err)
	}
	var metadata string
	if err := f.db.QueryRowContext(f.ctx, `SELECT metadata_json FROM audit_events WHERE action='booking.created' AND resource_id=?`, booking.ID).Scan(&metadata); err != nil {
		t.Fatalf("read custom-price audit event: %v", err)
	}
	if !strings.Contains(metadata, `"unitPriceMinor":350`) || !strings.Contains(metadata, `"totalMinor":700`) {
		t.Fatalf("custom-price audit metadata = %s", metadata)
	}
	updatedCustom, err := f.catalog.UpdateProduct(f.ctx, f.admin, f.membership, fixedProduct.ID, catalog.UpdateProductInput{
		Name: fixedProduct.Name, PricingMode: domain.ProductPricingUserDefined, Active: true, Version: fixedProduct.Version,
	})
	if err != nil || updatedCustom.PricingMode != domain.ProductPricingUserDefined || updatedCustom.PriceMinor != nil {
		t.Fatalf("switch fixed product to user-defined pricing: product=%#v err=%v", updatedCustom, err)
	}
	updatedFixed, err := f.catalog.UpdateProduct(f.ctx, f.admin, f.membership, fixedProduct.ID, catalog.UpdateProductInput{
		Name: fixedProduct.Name, PricingMode: domain.ProductPricingFixed, PriceMinor: &fixedPrice, Active: true, Version: updatedCustom.Version,
	})
	if err != nil || updatedFixed.PricingMode != domain.ProductPricingFixed || updatedFixed.PriceMinor == nil || *updatedFixed.PriceMinor != fixedPrice {
		t.Fatalf("switch user-defined product to fixed pricing: product=%#v err=%v", updatedFixed, err)
	}
}

func TestPaymentFIFOReversalAndClosedPeriodImmutability(t *testing.T) {
	f := newFixture(t)
	_, product := f.catalogItem("Products", 100)
	periodOne := f.openPeriodID()
	if _, err := f.bookings.Create(f.ctx, f.admin, f.membership, "period-one-booking", bookings.CreateInput{ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: periodOne, Quantity: 1}); err != nil {
		t.Fatalf("period one booking: %v", err)
	}
	closeOne, err := f.periods.Close(f.ctx, f.admin, f.membership, "close-period-one", periodOne, periods.CloseInput{Label: "Period One", DueAt: "2099-01-01", NextPeriodLabel: "Period Two"})
	if err != nil {
		t.Fatalf("close period one: %v", err)
	}
	replayedClose, err := f.periods.Close(f.ctx, f.admin, f.membership, "close-period-one", periodOne, periods.CloseInput{Label: "Period One", DueAt: "2099-01-01", NextPeriodLabel: "Period Two"})
	if err != nil || replayedClose.OpenPeriod.ID != closeOne.OpenPeriod.ID {
		t.Fatalf("idempotent period close replay=%#v err=%v", replayedClose, err)
	}
	periodTwo := closeOne.OpenPeriod.ID
	if _, err := f.bookings.Create(f.ctx, f.admin, f.membership, "period-two-booking", bookings.CreateInput{ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: periodTwo, Quantity: 2}); err != nil {
		t.Fatalf("period two booking: %v", err)
	}
	payment, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "payment-key-one", finance.CreatePaymentInput{MembershipID: f.membership.ID, AmountMinor: 150, Method: "CASH"})
	if err != nil {
		t.Fatalf("create payment: %v", err)
	}
	var paymentNotifications int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM notifications WHERE membership_id=? AND type='PAYMENT_RECORDED' AND resource_id=?`, f.membership.ID, payment.ID).Scan(&paymentNotifications); err != nil || paymentNotifications != 0 {
		t.Fatalf("self-targeted payment notifications=%d err=%v, want zero", paymentNotifications, err)
	}
	if len(payment.Allocations) != 2 || payment.Allocations[0].PeriodID != periodOne || payment.Allocations[0].AmountMinor != 100 || payment.Allocations[1].PeriodID != periodTwo || payment.Allocations[1].AmountMinor != 50 {
		t.Fatalf("FIFO allocations = %#v", payment.Allocations)
	}
	var paymentLedgerTotal int64
	if err := f.db.QueryRowContext(f.ctx, `SELECT sum(amount_minor) FROM ledger_entries WHERE payment_id=?`, payment.ID).Scan(&paymentLedgerTotal); err != nil || paymentLedgerTotal != 0 {
		t.Fatalf("payment ledger sum = %d err=%v, want zero", paymentLedgerTotal, err)
	}
	statements, err := f.periods.Statements(f.ctx, f.membership, periodOne)
	if err != nil || len(statements) != 1 || statements[0].Status != "PAID" {
		t.Fatalf("period one statements = %#v err=%v", statements, err)
	}
	if _, err := f.periods.Close(f.ctx, f.admin, f.membership, "close-period-two", periodTwo, periods.CloseInput{Label: "Period Two", DueAt: "2099-02-01", NextPeriodLabel: "Period Three"}); err != nil {
		t.Fatalf("close period two: %v", err)
	}
	var settlementNotifications int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM notifications WHERE membership_id=? AND type='SETTLEMENT_CREATED'`, f.membership.ID).Scan(&settlementNotifications); err != nil || settlementNotifications != 2 {
		t.Fatalf("settlement notifications=%d err=%v, want two", settlementNotifications, err)
	}
	if _, err := f.db.ExecContext(f.ctx, `UPDATE periods SET label='Tampered' WHERE id=?`, periodOne); err == nil {
		t.Fatal("closed period update unexpectedly succeeded")
	}
	if _, err := f.db.ExecContext(f.ctx, `UPDATE period_statements SET status='PAID' WHERE period_id=?`, periodTwo); err == nil {
		t.Fatal("statement update unexpectedly succeeded")
	}
	if _, err := f.db.ExecContext(f.ctx, `UPDATE audit_events SET action='tampered' WHERE group_id=?`, f.group.ID); err == nil {
		t.Fatal("audit update unexpectedly succeeded")
	}
	if err := f.finance.ReversePayment(f.ctx, f.admin, f.membership, "reverse-payment-one", payment.ID, "Bank transfer was returned"); err != nil {
		t.Fatalf("reverse payment: %v", err)
	}
	if err := f.finance.ReversePayment(f.ctx, f.admin, f.membership, "reverse-payment-one", payment.ID, "Bank transfer was returned"); err != nil {
		t.Fatalf("idempotent payment reversal replay: %v", err)
	}
	if err := f.finance.ReversePayment(f.ctx, f.admin, f.membership, "reverse-payment-two", payment.ID, "Duplicate reversal"); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("different-key second reversal = %v, want conflict", err)
	}
	account, err := f.finance.Account(f.ctx, f.membership, f.membership.ID)
	if err != nil || account.BalanceMinor != 300 {
		t.Fatalf("balance after payment reversal = %d err=%v, want 300", account.BalanceMinor, err)
	}
	secondGroup, err := f.groups.Create(f.ctx, f.admin, "Tenant Two", "EUR")
	if err != nil {
		t.Fatalf("create second tenant: %v", err)
	}
	var otherPeriod string
	if err := f.db.QueryRowContext(f.ctx, `SELECT id FROM periods WHERE group_id=? AND status='OPEN'`, secondGroup.ID).Scan(&otherPeriod); err != nil {
		t.Fatalf("read second tenant period: %v", err)
	}
	if _, err := f.db.ExecContext(f.ctx, `INSERT INTO payment_allocations(group_id,payment_id,period_id,amount_minor) VALUES(?,?,?,1)`, f.group.ID, payment.ID, otherPeriod); err == nil {
		t.Fatal("cross-tenant payment allocation unexpectedly succeeded")
	}
}

func TestOverpaymentCreditsFutureClaims(t *testing.T) {
	f := newFixture(t)
	_, product := f.catalogItem("Products", 100)
	periodOne := f.openPeriodID()
	if _, err := f.bookings.Create(f.ctx, f.admin, f.membership, "credit-charge-one", bookings.CreateInput{ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: periodOne, Quantity: 1}); err != nil {
		t.Fatalf("first credit scenario charge: %v", err)
	}
	payment, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "credit-overpayment", finance.CreatePaymentInput{MembershipID: f.membership.ID, AmountMinor: 500, Method: "BANK_TRANSFER"})
	if err != nil {
		t.Fatalf("overpayment: %v", err)
	}
	if len(payment.Allocations) != 1 || payment.Allocations[0].AmountMinor != 100 {
		t.Fatalf("initial overpayment allocations = %#v", payment.Allocations)
	}
	closedOne, err := f.periods.Close(f.ctx, f.admin, f.membership, "credit-close-one", periodOne, periods.CloseInput{Label: "Credit One", DueAt: "2099-01-01", NextPeriodLabel: "Credit Two"})
	if err != nil {
		t.Fatalf("close first credit period: %v", err)
	}
	periodTwo := closedOne.OpenPeriod.ID
	if _, err := f.bookings.Create(f.ctx, f.admin, f.membership, "credit-charge-two", bookings.CreateInput{ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: periodTwo, Quantity: 2}); err != nil {
		t.Fatalf("later charge: %v", err)
	}
	if _, err := f.periods.Close(f.ctx, f.admin, f.membership, "credit-close-two", periodTwo, periods.CloseInput{Label: "Credit Two", DueAt: "2099-02-01", NextPeriodLabel: "Credit Three"}); err != nil {
		t.Fatalf("close second credit period: %v", err)
	}
	statements, err := f.periods.Statements(f.ctx, f.membership, periodTwo)
	if err != nil || len(statements) != 1 || statements[0].PaymentsAllocatedMinor != 200 || statements[0].AmountDueMinor != 0 || statements[0].Status != "PAID" {
		t.Fatalf("later claim did not consume credit: %#v err=%v", statements, err)
	}
	account, err := f.finance.Account(f.ctx, f.membership, f.membership.ID)
	if err != nil || account.BalanceMinor != -200 {
		t.Fatalf("remaining credit balance = %d err=%v, want -200", account.BalanceMinor, err)
	}
}

func TestNegativeCorrectionOffsetsOldClaimBeforePayment(t *testing.T) {
	f := newFixture(t)
	_, product := f.catalogItem("Products", 100)
	periodOne := f.openPeriodID()
	booking, err := f.bookings.Create(f.ctx, f.admin, f.membership, "correction-charge", bookings.CreateInput{ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: periodOne, Quantity: 1})
	if err != nil {
		t.Fatalf("create corrected booking: %v", err)
	}
	if _, err := f.periods.Close(f.ctx, f.admin, f.membership, "correction-close", periodOne, periods.CloseInput{Label: "Closed Claim", DueAt: "2099-01-01", NextPeriodLabel: "Corrections"}); err != nil {
		t.Fatalf("close original period: %v", err)
	}
	if _, err := f.bookings.Void(f.ctx, f.admin, f.membership, "correction-void", booking.ID, "Correction after close"); err != nil {
		t.Fatalf("reverse old booking: %v", err)
	}
	statements, err := f.periods.Statements(f.ctx, f.membership, periodOne)
	if err != nil || len(statements) != 1 || statements[0].AdjustmentsAppliedMinor != 100 || statements[0].AmountDueMinor != 0 || statements[0].Status != "PAID" {
		t.Fatalf("corrected original statement = %#v err=%v", statements, err)
	}
	payment, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "correction-payment", finance.CreatePaymentInput{MembershipID: f.membership.ID, AmountMinor: 50, Method: "CASH"})
	if err != nil {
		t.Fatalf("create payment after correction: %v", err)
	}
	if len(payment.Allocations) != 0 {
		t.Fatalf("payment was incorrectly allocated after offsetting correction: %#v", payment.Allocations)
	}
	account, err := f.finance.Account(f.ctx, f.membership, f.membership.ID)
	if err != nil || account.BalanceMinor != -50 {
		t.Fatalf("corrected account balance = %d err=%v, want -50", account.BalanceMinor, err)
	}
	correctionPeriod := f.openPeriodID()
	if _, err := f.periods.Close(f.ctx, f.admin, f.membership, "correction-close-two", correctionPeriod, periods.CloseInput{Label: "Corrections", DueAt: "2099-02-01", NextPeriodLabel: "After Corrections"}); err != nil {
		t.Fatalf("close correction period: %v", err)
	}
	statements, err = f.periods.Statements(f.ctx, f.membership, correctionPeriod)
	if err != nil || len(statements) != 1 || statements[0].ChargesMinor != -100 || statements[0].AdjustmentsProvidedMinor != 100 || statements[0].AmountDueMinor != 0 || statements[0].Status != "PAID" {
		t.Fatalf("correction source statement = %#v err=%v", statements, err)
	}
}

func TestPartialCorrectionAndPaymentSettleOriginalClaim(t *testing.T) {
	f := newFixture(t)
	_, product := f.catalogItem("Products", 50)
	periodOne := f.openPeriodID()
	first, err := f.bookings.Create(f.ctx, f.admin, f.membership, "partial-correction-first", bookings.CreateInput{ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: periodOne, Quantity: 1})
	if err != nil {
		t.Fatalf("create first charge: %v", err)
	}
	if _, err := f.bookings.Create(f.ctx, f.admin, f.membership, "partial-correction-second", bookings.CreateInput{ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: periodOne, Quantity: 1}); err != nil {
		t.Fatalf("create second charge: %v", err)
	}
	closed, err := f.periods.Close(f.ctx, f.admin, f.membership, "partial-correction-close-one", periodOne, periods.CloseInput{Label: "Original", DueAt: "2099-01-01", NextPeriodLabel: "Corrections"})
	if err != nil {
		t.Fatalf("close original period: %v", err)
	}
	if _, err := f.bookings.Void(f.ctx, f.admin, f.membership, "partial-correction-void", first.ID, "Partial correction"); err != nil {
		t.Fatalf("void first charge: %v", err)
	}
	payment, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "partial-correction-payment", finance.CreatePaymentInput{MembershipID: f.membership.ID, AmountMinor: 50, Method: "CASH"})
	if err != nil {
		t.Fatalf("record remaining payment: %v", err)
	}
	if len(payment.Allocations) != 1 || payment.Allocations[0].PeriodID != periodOne || payment.Allocations[0].AmountMinor != 50 {
		t.Fatalf("partial correction payment allocations = %#v", payment.Allocations)
	}
	statements, err := f.periods.Statements(f.ctx, f.membership, periodOne)
	if err != nil || len(statements) != 1 || statements[0].AdjustmentsAppliedMinor != 50 || statements[0].PaymentsAllocatedMinor != 50 || statements[0].AmountDueMinor != 0 || statements[0].Status != "PAID" {
		t.Fatalf("partially corrected original statement = %#v err=%v", statements, err)
	}
	if _, err := f.periods.Close(f.ctx, f.admin, f.membership, "partial-correction-close-two", closed.OpenPeriod.ID, periods.CloseInput{Label: "Corrections", DueAt: "2099-02-01", NextPeriodLabel: "Next"}); err != nil {
		t.Fatalf("close partial correction period: %v", err)
	}
	statements, err = f.periods.Statements(f.ctx, f.membership, closed.OpenPeriod.ID)
	if err != nil || len(statements) != 1 || statements[0].ChargesMinor != -50 || statements[0].AdjustmentsProvidedMinor != 50 || statements[0].AmountDueMinor != 0 || statements[0].Status != "PAID" {
		t.Fatalf("partial correction source statement = %#v err=%v", statements, err)
	}
	account, err := f.finance.Account(f.ctx, f.membership, f.membership.ID)
	if err != nil || account.BalanceMinor != 0 {
		t.Fatalf("partial correction account balance = %d err=%v, want zero", account.BalanceMinor, err)
	}
}

func nullableTest(value string) any {
	if value == "" {
		return nil
	}
	return value
}
