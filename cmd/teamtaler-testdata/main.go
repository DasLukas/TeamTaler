// Command teamtaler-testdata creates a disposable local TeamTaler database
// containing representative users, permissions, catalog items, bookings, and
// payments. It is a development helper and is not included in production
// builds or container images.
package main

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/bookings"
	"github.com/DasLukas/TeamTaler/internal/catalog"
	"github.com/DasLukas/TeamTaler/internal/config"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/finance"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/media"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
	systemadmin "github.com/DasLukas/TeamTaler/internal/system"
)

const (
	testPassword         = "TeamTaler-Test-2026!"
	testDataSeedTimeout  = 2 * time.Minute
	adminEmail           = "admin@example.test"
	systemOnlyAdminEmail = "systemonly@example.test"
	secondaryGroupName   = "TeamTaler Weekend Club"
	secondaryMemberEmail = "noah@example.test"
	secondaryCategory    = "Refreshments"
	secondaryProduct     = "Club Coffee"
)

// fixtureAssets contains the local-only catalog and profile images normalized
// into the disposable server's protected media store during seeding.
//
//go:embed assets/*.webp
var fixtureAssets embed.FS

type memberSeed struct {
	email                   string
	displayName             string
	roles                   []domain.Role
	permissions             []domain.PermissionKey
	replaceStarterWithGrant bool
}

type seededMember struct {
	principal  domain.Principal
	membership domain.Membership
}

type imageSeed struct {
	assetPath string
	product   domain.Product
}

var bookingReasonSeeds = []domain.ConfigurableItem{
	{ID: "TEAM_EVENT", Label: "Team event"},
	{ID: "TRAINING_MATERIALS", Label: "Training materials"},
}

var paymentReasonSeeds = []domain.ConfigurableItem{
	{ID: "MONTHLY_SETTLEMENT", Label: "Monthly settlement"},
	{ID: "CASH_DEPOSIT", Label: "Cash deposit"},
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

// run creates the complete development fixture in the configured empty
// database. Configuration is read from TEAMTALER_* variables and the operation
// is bounded to two minutes to accommodate image normalization on race-enabled
// or resource-constrained systems. It returns validation, storage, or domain-
// service errors and refuses to modify a database that already contains users.
func run() error {
	ctx, cancel := context.WithTimeout(context.Background(), testDataSeedTimeout)
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
	if err := seedSystemOnlyAdministrator(ctx, db, adminSession.Principal.UserID); err != nil {
		return err
	}
	adminGroup, err := onlyGroup(ctx, groupService, adminSession.Principal.UserID)
	if err != nil {
		return err
	}
	adminGroup.Membership, err = grantDevelopmentAdministratorCapabilities(ctx, groupService, adminSession.Principal, adminGroup.Membership)
	if err != nil {
		return err
	}
	if err := seedReasonSuggestions(ctx, groupService, adminSession.Principal, adminGroup.Membership); err != nil {
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
		permissions:             []domain.PermissionKey{domain.PermissionBookForGuests},
		replaceStarterWithGrant: true,
	})
	if err != nil {
		return err
	}
	for _, avatar := range []struct {
		assetPath string
		principal domain.Principal
	}{
		{assetPath: "assets/avatar-ada.webp", principal: adminSession.Principal},
		{assetPath: "assets/avatar-marie.webp", principal: marie.principal},
		{assetPath: "assets/avatar-jonas.webp", principal: jonas.principal},
		{assetPath: "assets/avatar-lena.webp", principal: lena.principal},
	} {
		if err := seedAvatar(ctx, authService, cfg.DataDirectory, avatar.principal, avatar.assetPath); err != nil {
			return err
		}
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
	for _, image := range []imageSeed{
		{assetPath: "assets/product-mineral-water.webp", product: water},
		{assetPath: "assets/product-apple-spritzer.webp", product: appleJuice},
		{assetPath: "assets/product-pretzel.webp", product: pretzel},
		{assetPath: "assets/product-late-to-practice.webp", product: lateFee},
		{assetPath: "assets/product-voluntary-contribution.webp", product: customContribution},
	} {
		if err := seedProductImage(ctx, catalogService, cfg.DataDirectory, adminSession.Principal, adminGroup.Membership, image); err != nil {
			return err
		}
	}

	financeService := finance.Service{DB: db}
	if _, err := financeService.CreatePayment(ctx, adminSession.Principal, adminGroup.Membership, "seed-payment-marie", finance.CreatePaymentInput{
		MembershipID: marie.membership.ID, AmountMinor: 200, Method: "CASH", Reference: "Training",
	}); err != nil {
		return fmt.Errorf("create Marie payment: %w", err)
	}
	if err := seedSecondaryGroup(ctx, authService, groupService, catalogService, cfg.DataDirectory, adminSession.Principal); err != nil {
		return err
	}

	if _, err := db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		return fmt.Errorf("checkpoint test database: %w", err)
	}
	fmt.Println("Development test data created.")
	return nil
}

// seedSystemOnlyAdministrator creates one credentialed account with the global
// administrator assignment and deliberately no group membership. It exercises
// the authenticated system-only shell without widening any tenant access.
func seedSystemOnlyAdministrator(ctx context.Context, db *sql.DB, grantingUserID string) error {
	passwordHash, err := auth.HashPassword(testPassword)
	if err != nil {
		return fmt.Errorf("hash system-only administrator password: %w", err)
	}
	userID, err := platform.NewID("usr")
	if err != nil {
		return fmt.Errorf("create system-only administrator identifier: %w", err)
	}
	now := platform.Timestamp(platform.Now())
	return storage.WithTx(ctx, db, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)`, userID, systemOnlyAdminEmail, "System Only", passwordHash, now, now); err != nil {
			return fmt.Errorf("insert system-only administrator: %w", err)
		}
		if _, err := systemadmin.GrantAdministratorInTx(ctx, tx, userID, grantingUserID); err != nil {
			return fmt.Errorf("grant system-only administrator: %w", err)
		}
		return nil
	})
}

// seedSecondaryGroup creates a second disposable group with one catalog item
// for testing group switching and data isolation. The administrator and Lena
// reuse their existing accounts, while Noah is created exclusively for the new
// group. It returns a contextualized group, invitation, or catalog error.
func seedSecondaryGroup(ctx context.Context, authService auth.Service, groupService groups.Service, catalogService catalog.Service, dataDirectory string, administrator domain.Principal) error {
	secondaryGroup, err := groupService.Create(ctx, administrator, secondaryGroupName, "EUR")
	if err != nil {
		return fmt.Errorf("create secondary test group: %w", err)
	}
	secondaryGroup.Membership, err = grantDevelopmentAdministratorCapabilities(ctx, groupService, administrator, secondaryGroup.Membership)
	if err != nil {
		return err
	}
	if err := seedReasonSuggestions(ctx, groupService, administrator, secondaryGroup.Membership); err != nil {
		return err
	}
	category, err := catalogService.CreateCategory(ctx, administrator, secondaryGroup.Membership, catalog.CreateCategoryInput{
		Name: secondaryCategory, Icon: domain.CategoryIconDrink, SortOrder: 10,
	})
	if err != nil {
		return fmt.Errorf("create secondary test category: %w", err)
	}
	coffee, err := createFixedProduct(ctx, catalogService, administrator, secondaryGroup.Membership, category.ID, "seed-secondary-product-coffee", secondaryProduct, 180, 10)
	if err != nil {
		return fmt.Errorf("create secondary test product: %w", err)
	}
	if err := seedProductImage(ctx, catalogService, dataDirectory, administrator, secondaryGroup.Membership, imageSeed{
		assetPath: "assets/product-club-coffee.webp", product: coffee,
	}); err != nil {
		return err
	}
	for _, seed := range []memberSeed{
		{email: "lena@example.test", displayName: "Lena Player"},
		{email: secondaryMemberEmail, displayName: "Noah Newcomer"},
	} {
		member, err := createMember(ctx, authService, groupService, administrator, secondaryGroup.Membership, seed)
		if err != nil {
			return fmt.Errorf("seed secondary group member %s: %w", seed.email, err)
		}
		if seed.email == secondaryMemberEmail {
			if err := seedAvatar(ctx, authService, dataDirectory, member.principal, "assets/avatar-noah.webp"); err != nil {
				return err
			}
		}
	}
	return nil
}

// grantDevelopmentAdministratorCapabilities adds a disposable custom role with
// the non-administrative capabilities needed to populate every development
// workspace. Production group defaults remain least-privileged; only local test
// data receives this explicit supplemental assignment.
//
// Parameters:
//   - ctx: Bounds role creation, assignment, and membership reload operations.
//   - service: Group service connected to the disposable test database.
//   - actor: Authenticated group creator receiving the supplemental role.
//   - membership: Creator membership that already owns the reserved administrator role.
//
// Returns:
//   - domain.Membership: Reloaded membership with combined effective grants.
//   - error: Role creation, assignment, authorization, or storage failure.
func grantDevelopmentAdministratorCapabilities(ctx context.Context, service groups.Service, actor domain.Principal, membership domain.Membership) (domain.Membership, error) {
	permissions := []domain.PermissionKey{
		domain.PermissionFinanceManagement,
		domain.PermissionCatalogManagement,
		domain.PermissionViewGroupStatistics,
		domain.PermissionViewAllBookingActivity,
		domain.PermissionRecordOwnPayment,
		domain.PermissionCreateOwnBooking,
		domain.PermissionVoidOwnBooking,
		domain.PermissionVoidAnyBooking,
		domain.PermissionBookForOthers,
		domain.PermissionBookForGuests,
	}
	grants := make([]domain.PermissionGrant, 0, len(permissions))
	for _, permission := range permissions {
		grants = append(grants, domain.PermissionGrant{
			Permission: permission,
			Scope:      domain.PermissionScope{Type: domain.PermissionScopeGroup},
		})
	}
	role, err := service.CreateRole(ctx, actor, membership, groups.RoleCommand{
		Name:        "Development administrator capabilities",
		Description: "Supplemental capabilities for disposable local test data.",
		Grants:      grants,
	})
	if err != nil {
		return domain.Membership{}, fmt.Errorf("create development administrator role for group %q: %w", membership.GroupID, err)
	}
	roleIDs := append(append([]string(nil), membership.RoleIDs...), role.ID)
	if _, err := service.ReplaceMemberRoles(ctx, actor, membership, membership.ID, roleIDs, membership.RoleAssignmentsVersion); err != nil {
		return domain.Membership{}, fmt.Errorf("assign development administrator role for group %q: %w", membership.GroupID, err)
	}
	updated, err := service.MembershipForUser(ctx, membership.GroupID, membership.UserID)
	if err != nil {
		return domain.Membership{}, fmt.Errorf("reload development administrator for group %q: %w", membership.GroupID, err)
	}
	return updated, nil
}

// seedReasonSuggestions configures the two booking and two payment reasons
// shared by every disposable group. It returns permission, validation, audit,
// or storage errors from the group settings service.
func seedReasonSuggestions(ctx context.Context, service groups.Service, actor domain.Principal, membership domain.Membership) error {
	bookingReasons := append([]domain.ConfigurableItem(nil), bookingReasonSeeds...)
	paymentReasons := append([]domain.ConfigurableItem(nil), paymentReasonSeeds...)
	if _, err := service.UpdateSettings(ctx, actor, membership, groups.SettingsUpdate{
		BookingReasons: &bookingReasons,
		PaymentReasons: &paymentReasons,
	}); err != nil {
		return fmt.Errorf("seed transaction reason suggestions for group %q: %w", membership.GroupID, err)
	}
	return nil
}

// seedProductImage normalizes one embedded image into dataDirectory and
// attaches it to the corresponding product through the catalog service. It
// returns embedded-file, media-validation, authorization, audit, or storage
// errors with the affected product name.
func seedProductImage(ctx context.Context, service catalog.Service, dataDirectory string, actor domain.Principal, membership domain.Membership, seed imageSeed) error {
	imageKey, err := storeFixtureImage(dataDirectory, seed.assetPath)
	if err != nil {
		return fmt.Errorf("store image for product %q: %w", seed.product.Name, err)
	}
	if _, _, err := service.SetProductImage(ctx, actor, membership, seed.product.ID, imageKey); err != nil {
		return fmt.Errorf("attach image to product %q: %w", seed.product.Name, err)
	}
	return nil
}

// seedAvatar normalizes one embedded image into dataDirectory and attaches it
// to principal's account. It returns embedded-file, media-validation, or
// storage errors with the affected display name.
func seedAvatar(ctx context.Context, service auth.Service, dataDirectory string, principal domain.Principal, assetPath string) error {
	imageKey, err := storeFixtureImage(dataDirectory, assetPath)
	if err != nil {
		return fmt.Errorf("store avatar for %q: %w", principal.DisplayName, err)
	}
	if _, _, err := service.SetAvatar(ctx, principal, imageKey); err != nil {
		return fmt.Errorf("attach avatar to %q: %w", principal.DisplayName, err)
	}
	return nil
}

// storeFixtureImage opens assetPath from the embedded fixture, validates and
// normalizes it, and stores it content-addressed below dataDirectory. It
// returns the canonical image key or an embedded-file, validation, or I/O
// error.
func storeFixtureImage(dataDirectory, assetPath string) (string, error) {
	asset, err := fixtureAssets.Open(assetPath)
	if err != nil {
		return "", fmt.Errorf("open embedded asset %q: %w", assetPath, err)
	}
	defer asset.Close()
	imageKey, _, err := media.NormalizeAndStoreImage(dataDirectory, asset)
	if err != nil {
		return "", err
	}
	return imageKey, nil
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
// selection, then assigns an optional dynamic permission role. A fixture may
// replace the starter assignment to exercise an exact permission boundary.
// Every seeded account receives the shared local-only password. It returns the
// authenticated principal and active membership or a domain service error.
func createMember(ctx context.Context, authService auth.Service, groupService groups.Service, actor domain.Principal, actorMembership domain.Membership, seed memberSeed) (seededMember, error) {
	availableRoles, err := groupService.ListRoles(ctx, actorMembership)
	if err != nil {
		return seededMember{}, fmt.Errorf("list roles for %s: %w", seed.email, err)
	}
	wantedRoleIDs := make(map[string]struct{}, len(seed.roles)+1)
	if len(seed.roles) == 0 || len(seed.permissions) > 0 {
		wantedRoleIDs[authorization.TemplateRoleID(actorMembership.GroupID, domain.RoleTemplateMember)] = struct{}{}
	}
	for _, legacyRole := range seed.roles {
		switch legacyRole {
		case domain.RoleFinanceManager:
			wantedRoleIDs[authorization.TemplateRoleID(actorMembership.GroupID, domain.RoleTemplateFinance)] = struct{}{}
		case domain.RoleCatalogManager:
			wantedRoleIDs[authorization.TemplateRoleID(actorMembership.GroupID, domain.RoleTemplateCatalog)] = struct{}{}
		}
	}
	roleIDs := make([]string, 0, len(wantedRoleIDs))
	for _, role := range availableRoles {
		if _, selected := wantedRoleIDs[role.ID]; selected {
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
		roleIDs := []string{role.ID}
		if !seed.replaceStarterWithGrant {
			roleIDs = append(append([]string(nil), membership.RoleIDs...), role.ID)
		}
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
