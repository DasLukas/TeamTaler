// Command teamtaler-testdata creates a disposable local TeamTaler database
// containing representative users, permissions, catalog items, bookings, and
// payments. It is a development helper and is not included in production
// builds or container images.
package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/bookings"
	"github.com/DasLukas/TeamTaler/internal/catalog"
	"github.com/DasLukas/TeamTaler/internal/config"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/finance"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

const (
	testPassword = "TeamTaler-Test-2026!"
	adminEmail   = "admin@example.test"
)

type memberSeed struct {
	email       string
	displayName string
	roles       []domain.Role
	permissions []domain.PermissionKey
}

type seededMember struct {
	principal  domain.Principal
	membership domain.Membership
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

// run creates the complete development fixture in the configured empty
// database. Configuration is read from TEAMTALER_* variables and the operation
// is bounded to 30 seconds. It returns validation, storage, or domain-service
// errors and refuses to modify a database that already contains users.
func run() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load test-data configuration: %w", err)
	}
	db, err := storage.Open(ctx, cfg.DatabasePath)
	if err != nil {
		return err
	}
	defer db.Close()

	var userCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM users`).Scan(&userCount); err != nil {
		return fmt.Errorf("inspect test database: %w", err)
	}
	if userCount != 0 {
		return errors.New("test-data seeding requires an empty database")
	}

	authService := auth.Service{DB: db, SessionLifetime: 30 * 24 * time.Hour}
	groupService := groups.Service{DB: db}
	if err := authService.Bootstrap(ctx, adminEmail, "Ada Admin", testPassword, "TeamTaler Demo Club", "EUR"); err != nil {
		return fmt.Errorf("bootstrap administrator: %w", err)
	}
	adminSession, err := authService.Login(ctx, adminEmail, testPassword)
	if err != nil {
		return fmt.Errorf("login seeded administrator: %w", err)
	}
	adminGroup, err := onlyGroup(ctx, groupService, adminSession.Principal.UserID)
	if err != nil {
		return err
	}

	catalogService := catalog.Service{DB: db}
	drinks, err := catalogService.CreateCategory(ctx, adminSession.Principal, adminGroup.Membership, catalog.CreateCategoryInput{
		Name: "Beverages", Icon: domain.CategoryIconDrink, SortOrder: 10,
	})
	if err != nil {
		return fmt.Errorf("create drinks category: %w", err)
	}
	snacks, err := catalogService.CreateCategory(ctx, adminSession.Principal, adminGroup.Membership, catalog.CreateCategoryInput{
		Name: "Snacks", Icon: domain.CategoryIconFood, SortOrder: 20,
	})
	if err != nil {
		return fmt.Errorf("create snacks category: %w", err)
	}
	penalties, err := catalogService.CreateCategory(ctx, adminSession.Principal, adminGroup.Membership, catalog.CreateCategoryInput{
		Name: "Team Fund", Icon: domain.CategoryIconPenalty, SortOrder: 30,
	})
	if err != nil {
		return fmt.Errorf("create penalties category: %w", err)
	}

	water, err := createFixedProduct(ctx, catalogService, adminSession.Principal, adminGroup.Membership, drinks.ID, "seed-product-water", "Mineral Water", 150, 10)
	if err != nil {
		return err
	}
	appleJuice, err := createFixedProduct(ctx, catalogService, adminSession.Principal, adminGroup.Membership, drinks.ID, "seed-product-apple", "Apple Spritzer", 220, 20)
	if err != nil {
		return err
	}
	pretzel, err := createFixedProduct(ctx, catalogService, adminSession.Principal, adminGroup.Membership, snacks.ID, "seed-product-pretzel", "Pretzel", 200, 10)
	if err != nil {
		return err
	}
	lateFee, err := createFixedProduct(ctx, catalogService, adminSession.Principal, adminGroup.Membership, penalties.ID, "seed-product-late", "Late to Practice", 500, 10)
	if err != nil {
		return err
	}
	customContribution, err := catalogService.CreateProduct(ctx, adminSession.Principal, adminGroup.Membership, "seed-product-custom", penalties.ID, catalog.CreateProductInput{
		Name: "Voluntary Contribution", PricingMode: domain.ProductPricingUserDefined, SortOrder: 20,
	})
	if err != nil {
		return fmt.Errorf("create user-defined product: %w", err)
	}

	marie, err := createMember(ctx, authService, groupService, adminSession.Principal, adminGroup.Membership, memberSeed{
		email: "marie@example.test", displayName: "Marie Member",
		permissions: []domain.PermissionKey{domain.PermissionRecordOwnPayment, domain.PermissionBookForOthers},
	})
	if err != nil {
		return err
	}
	jonas, err := createMember(ctx, authService, groupService, adminSession.Principal, adminGroup.Membership, memberSeed{
		email: "jonas@example.test", displayName: "Jonas Treasurer",
		roles: []domain.Role{domain.RoleFinanceManager, domain.RoleCatalogManager},
	})
	if err != nil {
		return err
	}
	lena, err := createMember(ctx, authService, groupService, adminSession.Principal, adminGroup.Membership, memberSeed{
		email: "lena@example.test", displayName: "Lena Player",
	})
	if err != nil {
		return err
	}

	periodID, err := openPeriodID(ctx, db, adminGroup.ID)
	if err != nil {
		return err
	}
	bookingService := bookings.Service{DB: db, Groups: groupService}
	if _, err := bookingService.Create(ctx, marie.principal, marie.membership, "seed-booking-marie-water", bookings.CreateInput{
		ProductID: water.ID, ProductVersion: water.Version, ExpectedPeriodID: periodID, Quantity: 2,
	}); err != nil {
		return fmt.Errorf("create Marie water booking: %w", err)
	}
	if _, err := bookingService.Create(ctx, marie.principal, marie.membership, "seed-booking-marie-apple", bookings.CreateInput{
		ProductID: appleJuice.ID, ProductVersion: appleJuice.Version, ExpectedPeriodID: periodID, Quantity: 1,
		TargetMembershipID: lena.membership.ID, Reason: "Drink after practice",
	}); err != nil {
		return fmt.Errorf("create assigned drink booking: %w", err)
	}
	if _, err := bookingService.Create(ctx, adminSession.Principal, adminGroup.Membership, "seed-booking-jonas-pretzel", bookings.CreateInput{
		ProductID: pretzel.ID, ProductVersion: pretzel.Version, ExpectedPeriodID: periodID, Quantity: 2,
		TargetMembershipID: jonas.membership.ID, Reason: "Team snack",
	}); err != nil {
		return fmt.Errorf("create assigned Jonas snack booking: %w", err)
	}
	if _, err := bookingService.Create(ctx, adminSession.Principal, adminGroup.Membership, "seed-booking-lena-late", bookings.CreateInput{
		ProductID: lateFee.ID, ProductVersion: lateFee.Version, ExpectedPeriodID: periodID, Quantity: 1,
		TargetMembershipID: lena.membership.ID, Reason: "15 minutes late",
	}); err != nil {
		return fmt.Errorf("create penalty booking: %w", err)
	}
	customPrice := int64(750)
	if _, err := bookingService.Create(ctx, adminSession.Principal, adminGroup.Membership, "seed-booking-admin-custom", bookings.CreateInput{
		ProductID: customContribution.ID, ProductVersion: customContribution.Version, ExpectedPeriodID: periodID, Quantity: 1,
		UnitPriceMinor: &customPrice,
	}); err != nil {
		return fmt.Errorf("create contribution booking: %w", err)
	}

	financeService := finance.Service{DB: db}
	if _, err := financeService.CreatePayment(ctx, adminSession.Principal, adminGroup.Membership, "seed-payment-marie", finance.CreatePaymentInput{
		MembershipID: marie.membership.ID, AmountMinor: 200, Method: "CASH", Reference: "Training",
	}); err != nil {
		return fmt.Errorf("create Marie payment: %w", err)
	}

	if _, err := db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		return fmt.Errorf("checkpoint test database: %w", err)
	}
	fmt.Println("Development test data created.")
	return nil
}

// onlyGroup resolves the single group owned by a freshly bootstrapped test
// user. It returns an error when the fixture invariant is not satisfied.
func onlyGroup(ctx context.Context, service groups.Service, userID string) (domain.Group, error) {
	items, err := service.List(ctx, userID)
	if err != nil {
		return domain.Group{}, fmt.Errorf("list seeded groups: %w", err)
	}
	if len(items) != 1 {
		return domain.Group{}, fmt.Errorf("expected one seeded group, got %d", len(items))
	}
	return items[0], nil
}

// createFixedProduct adds one fixed-price product to the seeded catalog. The
// price is expressed in minor currency units. It returns the stored product or
// a contextualized catalog-service error.
func createFixedProduct(ctx context.Context, service catalog.Service, actor domain.Principal, membership domain.Membership, categoryID, idempotencyKey, name string, priceMinor int64, sortOrder int) (domain.Product, error) {
	item, err := service.CreateProduct(ctx, actor, membership, idempotencyKey, categoryID, catalog.CreateProductInput{
		Name: name, PriceMinor: &priceMinor, PricingMode: domain.ProductPricingFixed, SortOrder: sortOrder,
	})
	if err != nil {
		return domain.Product{}, fmt.Errorf("create product %q: %w", name, err)
	}
	return item, nil
}

// createMember creates and accepts one invitation with an explicit starter-role
// selection, then assigns an optional dynamic permission role. Accounts without
// requested management presets receive the editable member starter role. Every
// seeded account receives the shared local-only password. It returns the
// authenticated principal and active membership or a domain service error.
func createMember(ctx context.Context, authService auth.Service, groupService groups.Service, actor domain.Principal, actorMembership domain.Membership, seed memberSeed) (seededMember, error) {
	availableRoles, err := groupService.ListRoles(ctx, actorMembership)
	if err != nil {
		return seededMember{}, fmt.Errorf("list roles for %s: %w", seed.email, err)
	}
	wantedPresets := make(map[domain.RolePresetKey]struct{}, len(seed.roles)+1)
	if len(seed.roles) == 0 || len(seed.permissions) > 0 {
		wantedPresets[domain.RolePresetMember] = struct{}{}
	}
	for _, legacyRole := range seed.roles {
		switch legacyRole {
		case domain.RoleFinanceManager:
			wantedPresets[domain.RolePresetFinanceManager] = struct{}{}
		case domain.RoleCatalogManager:
			wantedPresets[domain.RolePresetCatalogManager] = struct{}{}
		}
	}
	roleIDs := make([]string, 0, len(wantedPresets))
	for _, role := range availableRoles {
		if _, selected := wantedPresets[role.PresetKey]; selected {
			roleIDs = append(roleIDs, role.ID)
		}
	}
	if len(roleIDs) == 0 {
		return seededMember{}, fmt.Errorf("resolve starter roles for %s", seed.email)
	}
	invitation, err := groupService.CreateInvitationWithRoles(ctx, actor, actorMembership, seed.email, seed.displayName, roleIDs)
	if err != nil {
		return seededMember{}, fmt.Errorf("invite %s: %w", seed.email, err)
	}
	session, membership, err := authService.AcceptInvitation(ctx, auth.InvitationAcceptance{
		Token: invitation.Token, DisplayName: seed.displayName, Password: testPassword,
	})
	if err != nil {
		return seededMember{}, fmt.Errorf("accept invitation for %s: %w", seed.email, err)
	}
	if len(seed.permissions) > 0 {
		grants := make([]domain.PermissionGrant, 0, len(seed.permissions))
		for _, permission := range seed.permissions {
			grants = append(grants, domain.PermissionGrant{
				Permission: permission,
				Scope:      domain.PermissionScope{Type: domain.PermissionScopeGroup},
			})
		}
		role, createErr := groupService.CreateRole(ctx, actor, actorMembership, groups.RoleCommand{
			Name:        seed.displayName + " permissions",
			Description: "Editable permissions for the disposable test-data account.",
			Grants:      grants,
		})
		if createErr != nil {
			return seededMember{}, fmt.Errorf("create dynamic role for %s: %w", seed.email, createErr)
		}
		roleIDs := append(append([]string(nil), membership.RoleIDs...), role.ID)
		if _, assignErr := groupService.ReplaceMemberRoles(ctx, actor, actorMembership, membership.ID, roleIDs, membership.RoleAssignmentsVersion); assignErr != nil {
			return seededMember{}, fmt.Errorf("assign dynamic role for %s: %w", seed.email, assignErr)
		}
		membership, err = groupService.MembershipForUser(ctx, membership.GroupID, membership.UserID)
		if err != nil {
			return seededMember{}, fmt.Errorf("reload dynamic role for %s: %w", seed.email, err)
		}
	}
	return seededMember{principal: session.Principal, membership: membership}, nil
}

// openPeriodID returns the only open accounting period for groupID. It returns
// a contextualized SQL error when the fixture or database is inconsistent.
func openPeriodID(ctx context.Context, db *sql.DB, groupID string) (string, error) {
	var periodID string
	if err := db.QueryRowContext(ctx, `SELECT id FROM periods WHERE group_id=? AND status='OPEN'`, groupID).Scan(&periodID); err != nil {
		return "", fmt.Errorf("resolve open period: %w", err)
	}
	return periodID, nil
}
