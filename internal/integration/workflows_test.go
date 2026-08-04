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
	invitation, err := f.groups.CreateInvitation(f.ctx, f.admin, f.membership, email, name, roles, nil)
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
	category, err := f.catalog.CreateCategory(f.ctx, f.admin, f.membership, catalog.CreateCategoryInput{Name: categoryName})
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
	category, err := f.catalog.CreateCategory(f.ctx, f.admin, f.membership, catalog.CreateCategoryInput{Name: "Idempotent Products"})
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
	if _, err := f.catalog.CreateCategory(f.ctx, memberPrincipal, member, catalog.CreateCategoryInput{Name: "Forbidden"}); !errors.Is(err, domain.ErrForbidden) {
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
}

func TestUserDefinedProductPricingIsValidatedAndSnapshotted(t *testing.T) {
	f := newFixture(t)
	category, err := f.catalog.CreateCategory(f.ctx, f.admin, f.membership, catalog.CreateCategoryInput{Name: "Flexible charges"})
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
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM notifications WHERE membership_id=? AND type='PAYMENT_RECORDED' AND resource_id=?`, f.membership.ID, payment.ID).Scan(&paymentNotifications); err != nil || paymentNotifications != 1 {
		t.Fatalf("payment notifications=%d err=%v, want one", paymentNotifications, err)
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
