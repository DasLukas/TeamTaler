// Command teamtaler-testdata creates a disposable local TeamTaler database
// containing representative German users, groups, catalog items, bookings,
// payments, notifications, and settlements.
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
	"github.com/DasLukas/TeamTaler/internal/notifications"
	"github.com/DasLukas/TeamTaler/internal/periods"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
	systemadmin "github.com/DasLukas/TeamTaler/internal/system"
)

const (
	testPassword         = "TeamTaler-Test-2026!"
	testDataSeedTimeout  = 2 * time.Minute
	adminEmail           = "admin@example.test"
	systemOnlyAdminEmail = "systemonly@example.test"
	primaryGroupName     = "TSV Sonnenberg"
	secondaryGroupName   = "Freizeitteam Wochenende"
	secondaryMemberEmail = "noah@example.test"
	secondaryCategory    = "Vereinsheim"
	secondaryProduct     = "Vereinskaffee"
)

// fixtureAssets contains local-only media normalized into protected storage.
//
//go:embed assets/*.webp
var fixtureAssets embed.FS

type memberSeed struct {
	email       string
	displayName string
	roles       []domain.Role
}

type seededMember struct {
	principal  domain.Principal
	membership domain.Membership
}

type imageSeed struct {
	assetPath string
	product   domain.Product
}

type primaryCatalog struct {
	water, appleJuice, pretzel, cake, lateFee, trip, contribution domain.Product
}

type paymentSeed struct {
	key, membershipID, method, reference, note string
	amountMinor                                int64
}

var bookingReasonSeeds = []domain.ConfigurableItem{
	{ID: "TEAM_EVENT", Label: "Mannschaftsabend"},
	{ID: "TRAINING_MATERIALS", Label: "Trainingsmaterial"},
	{ID: "AWAY_TRIP", Label: "Auswärtsfahrt"},
	{ID: "LATE_TO_TRAINING", Label: "Verspätung beim Training"},
}

var paymentReasonSeeds = []domain.ConfigurableItem{
	{ID: "MONTHLY_SETTLEMENT", Label: "Monatsabrechnung"},
	{ID: "CASH_DEPOSIT", Label: "Bareinzahlung"},
	{ID: "PARTIAL_PAYMENT", Label: "Teilzahlung"},
	{ID: "TEAM_FUND", Label: "Mannschaftskasse"},
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

// run creates the complete development fixture in an empty configured database.
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

	seedNow := time.Now().UTC().Truncate(time.Second)
	baseNow := seedNow
	originalNow := platform.Now
	platform.Now = func() time.Time { return seedNow }
	defer func() { platform.Now = originalNow }()

	authService := auth.Service{DB: db, SessionLifetime: 30 * 24 * time.Hour}
	groupService := groups.Service{DB: db}
	notificationService := notifications.Service{DB: db, EmailDeliveryAvailable: true, PushDeliveryAvailable: true}
	catalogService := catalog.Service{DB: db}
	bookingService := bookings.Service{DB: db, Groups: groupService, Notifications: notificationService}
	financeService := finance.Service{DB: db, Notifications: notificationService}
	periodService := periods.Service{DB: db, Notifications: notificationService}

	if err := authService.Bootstrap(ctx, adminEmail, "Ada Administratorin", testPassword, primaryGroupName, "EUR"); err != nil {
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
	adminGroup.Membership, err = assignAdministratorStandardRoles(ctx, groupService, adminSession.Principal, adminGroup.Membership)
	if err != nil {
		return err
	}
	if err := configureGroup(ctx, groupService, adminSession.Principal, adminGroup.Membership); err != nil {
		return err
	}
	products, err := seedPrimaryCatalog(ctx, catalogService, adminSession.Principal, adminGroup.Membership)
	if err != nil {
		return err
	}

	marie, err := createMember(ctx, authService, groupService, adminSession.Principal, adminGroup.Membership, memberSeed{email: "marie@example.test", displayName: "Marie Mitglied"})
	if err != nil {
		return err
	}
	jonas, err := createMember(ctx, authService, groupService, adminSession.Principal, adminGroup.Membership, memberSeed{email: "jonas@example.test", displayName: "Jonas Kassenwart", roles: []domain.Role{domain.RoleFinanceManager, domain.RoleCatalogManager}})
	if err != nil {
		return err
	}
	lena, err := createMember(ctx, authService, groupService, adminSession.Principal, adminGroup.Membership, memberSeed{email: "lena@example.test", displayName: "Lena Spielerin"})
	if err != nil {
		return err
	}
	emil, err := createMember(ctx, authService, groupService, adminSession.Principal, adminGroup.Membership, memberSeed{email: "emil@example.test", displayName: "Emil Trainer"})
	if err != nil {
		return err
	}
	for _, avatar := range []struct {
		path      string
		principal domain.Principal
	}{{"assets/avatar-ada.webp", adminSession.Principal}, {"assets/avatar-marie.webp", marie.principal}, {"assets/avatar-jonas.webp", jonas.principal}} {
		if err := seedAvatar(ctx, authService, cfg.DataDirectory, avatar.principal, avatar.path); err != nil {
			return err
		}
	}
	if err := seedGroupLogo(ctx, groupService, cfg.DataDirectory, adminSession.Principal, adminGroup.Membership, "assets/product-voluntary-contribution.webp"); err != nil {
		return err
	}
	for _, image := range []imageSeed{
		{"assets/product-mineral-water.webp", products.water},
		{"assets/product-apple-spritzer.webp", products.appleJuice},
		{"assets/product-pretzel.webp", products.pretzel},
		{"assets/product-late-to-practice.webp", products.lateFee},
	} {
		if err := seedProductImage(ctx, catalogService, cfg.DataDirectory, adminSession.Principal, adminGroup.Membership, image); err != nil {
			return err
		}
	}
	products.water.Version++
	products.appleJuice.Version++
	products.pretzel.Version++
	products.lateFee.Version++

	if err := withTemporaryBookingGrants(ctx, db, adminGroup.ID, func() error {
		seedNow = baseNow.Add(3 * time.Hour)
		periodID, periodErr := openPeriodID(ctx, db, adminGroup.ID)
		if periodErr != nil {
			return periodErr
		}
		if _, bookingErr := bookingService.CreateBulk(ctx, adminSession.Principal, adminGroup.Membership, "seed-july-team-cart", bookings.BulkCreateInput{
			ExpectedPeriodID:           periodID,
			Items:                      []bookings.BulkCreateItem{{ProductID: products.water.ID, ProductVersion: products.water.Version, Quantity: 2}, {ProductID: products.pretzel.ID, ProductVersion: products.pretzel.Version, Quantity: 1}},
			TargetMembershipIDs:        []string{marie.membership.ID, jonas.membership.ID, lena.membership.ID},
			TemporaryGuestDisplayNames: []string{"Sofia Gast", "Ben Zuschauer"}, Reason: "Mannschaftsabend",
		}); bookingErr != nil {
			return fmt.Errorf("create July team bookings: %w", bookingErr)
		}
		if _, bookingErr := bookingService.CreateBatch(ctx, adminSession.Principal, adminGroup.Membership, "seed-july-late-fees", bookings.BatchCreateInput{
			ProductID: products.lateFee.ID, ProductVersion: products.lateFee.Version, ExpectedPeriodID: periodID, Quantity: 1,
			TargetMembershipIDs: []string{lena.membership.ID, emil.membership.ID}, Reason: "Verspätung beim Training",
		}); bookingErr != nil {
			return fmt.Errorf("create July penalty bookings: %w", bookingErr)
		}
		tripPrice := int64(1250)
		if _, bookingErr := bookingService.Create(ctx, adminSession.Principal, adminGroup.Membership, "seed-july-trip", bookings.CreateInput{
			ProductID: products.trip.ID, ProductVersion: products.trip.Version, ExpectedPeriodID: periodID, Quantity: 1,
			UnitPriceMinor: &tripPrice, TargetMembershipID: marie.membership.ID, Reason: "Auswärtsfahrt",
		}); bookingErr != nil {
			return fmt.Errorf("create July trip booking: %w", bookingErr)
		}
		if err := seedPayments(ctx, financeService, adminSession.Principal, adminGroup.Membership, platform.Timestamp(seedNow.Add(time.Hour)), []paymentSeed{
			{key: "seed-july-payment-marie", membershipID: marie.membership.ID, amountMinor: 700, method: "CASH", reference: "Bareinzahlung", note: "Nach dem Training"},
			{key: "seed-july-payment-jonas", membershipID: jonas.membership.ID, amountMinor: 550, method: "BANK_TRANSFER", reference: "Monatsabrechnung"},
			{key: "seed-july-payment-lena", membershipID: lena.membership.ID, amountMinor: 200, method: "PAYPAL", reference: "Teilzahlung"},
		}); err != nil {
			return err
		}
		if err := configureNotifications(ctx, notificationService, groupService, adminSession.Principal, adminGroup.Membership); err != nil {
			return err
		}
		seedNow = baseNow.AddDate(0, 0, 1)
		july, closeErr := periodService.Close(ctx, adminSession.Principal, adminGroup.Membership, "seed-close-july", periodID, periods.CloseInput{Label: "Erste Abrechnung", DueAt: seedNow.AddDate(0, 0, 10).Format("2006-01-02"), NextPeriodLabel: "Zweiter Zeitraum"})
		if closeErr != nil {
			return fmt.Errorf("close July settlement: %w", closeErr)
		}

		seedNow = baseNow.AddDate(0, 0, 2)
		contributionPrice := int64(750)
		if _, bookingErr := bookingService.CreateBulk(ctx, adminSession.Principal, adminGroup.Membership, "seed-august-team-cart", bookings.BulkCreateInput{
			ExpectedPeriodID: july.OpenPeriod.ID,
			Items: []bookings.BulkCreateItem{
				{ProductID: products.appleJuice.ID, ProductVersion: products.appleJuice.Version, Quantity: 1},
				{ProductID: products.cake.ID, ProductVersion: products.cake.Version, Quantity: 2},
				{ProductID: products.contribution.ID, ProductVersion: products.contribution.Version, Quantity: 1, UnitPriceMinor: &contributionPrice},
			},
			TargetMembershipIDs: []string{adminGroup.Membership.ID, marie.membership.ID, emil.membership.ID}, Reason: "Trainingsmaterial",
		}); bookingErr != nil {
			return fmt.Errorf("create August team bookings: %w", bookingErr)
		}
		if err := seedPayments(ctx, financeService, adminSession.Principal, adminGroup.Membership, platform.Timestamp(seedNow.Add(time.Hour)), []paymentSeed{
			{key: "seed-august-payment-marie", membershipID: marie.membership.ID, amountMinor: 1200, method: "BANK_TRANSFER", reference: "Monatsabrechnung"},
			{key: "seed-august-payment-emil", membershipID: emil.membership.ID, amountMinor: 600, method: "CARD", reference: "Teilzahlung"},
			{key: "seed-august-payment-admin", membershipID: adminGroup.Membership.ID, amountMinor: 1000, method: "OTHER", reference: "Mannschaftskasse", note: "Spende beim Sommerfest"},
		}); err != nil {
			return err
		}
		seedNow = baseNow.AddDate(0, 0, 3)
		august, closeErr := periodService.Close(ctx, adminSession.Principal, adminGroup.Membership, "seed-close-august", july.OpenPeriod.ID, periods.CloseInput{Label: "Zweite Abrechnung", DueAt: seedNow.AddDate(0, 0, 12).Format("2006-01-02"), NextPeriodLabel: "Aktueller Zeitraum"})
		if closeErr != nil {
			return fmt.Errorf("close August settlement: %w", closeErr)
		}
		seedNow = baseNow.AddDate(0, 0, 4)
		if _, bookingErr := bookingService.CreateBatch(ctx, adminSession.Principal, adminGroup.Membership, "seed-current-snacks", bookings.BatchCreateInput{
			ProductID: products.pretzel.ID, ProductVersion: products.pretzel.Version, ExpectedPeriodID: august.OpenPeriod.ID, Quantity: 2,
			TargetMembershipIDs: []string{jonas.membership.ID, lena.membership.ID}, Reason: "Mannschaftsabend",
		}); bookingErr != nil {
			return fmt.Errorf("create current bookings: %w", bookingErr)
		}
		if err := seedPayments(ctx, financeService, adminSession.Principal, adminGroup.Membership, platform.Timestamp(seedNow), []paymentSeed{
			{key: "seed-current-payment-lena", membershipID: lena.membership.ID, amountMinor: 500, method: "CASH", reference: "Bareinzahlung"},
			{key: "seed-current-payment-jonas", membershipID: jonas.membership.ID, amountMinor: 350, method: "CARD", reference: "Mannschaftskasse"},
		}); err != nil {
			return err
		}

		seedNow = baseNow.AddDate(0, 0, 4).Add(30 * time.Minute)
		reversedBooking, bookingErr := bookingService.Create(ctx, adminSession.Principal, adminGroup.Membership, "seed-current-booking-to-reverse", bookings.CreateInput{
			ProductID: products.water.ID, ProductVersion: products.water.Version, ExpectedPeriodID: august.OpenPeriod.ID, Quantity: 1,
			TargetMembershipID: marie.membership.ID, Reason: "Mannschaftsabend",
		})
		if bookingErr != nil {
			return fmt.Errorf("create booking reversal fixture: %w", bookingErr)
		}
		reversedPayment, paymentErr := financeService.CreatePayment(ctx, adminSession.Principal, adminGroup.Membership, "seed-current-payment-to-reverse", finance.CreatePaymentInput{
			MembershipID: marie.membership.ID, AmountMinor: 425, ReceivedAt: platform.Timestamp(seedNow), Method: "CASH", Reference: "Bareinzahlung", Note: "Doppelt erfasst",
		})
		if paymentErr != nil {
			return fmt.Errorf("create payment reversal fixture: %w", paymentErr)
		}

		seedNow = baseNow.AddDate(0, 0, 4).Add(time.Hour)
		if _, bookingErr := bookingService.Void(ctx, adminSession.Principal, adminGroup.Membership, "seed-current-booking-reversal", reversedBooking.ID, "Doppelte Testbuchung"); bookingErr != nil {
			return fmt.Errorf("reverse booking fixture: %w", bookingErr)
		}
		seedNow = baseNow.AddDate(0, 0, 4).Add(90 * time.Minute)
		if paymentErr := financeService.ReversePayment(ctx, adminSession.Principal, adminGroup.Membership, "seed-current-payment-reversal", reversedPayment.ID, "Doppelte Testzahlung"); paymentErr != nil {
			return fmt.Errorf("reverse payment fixture: %w", paymentErr)
		}
		return nil
	}); err != nil {
		return err
	}

	seedNow = baseNow.AddDate(0, 0, 5)
	if err := seedSecondaryGroup(ctx, authService, groupService, catalogService, bookingService, financeService, periodService, notificationService, cfg.DataDirectory, adminSession.Principal); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		return fmt.Errorf("checkpoint test database: %w", err)
	}
	fmt.Println("Abwechslungsreiche deutsche Testdaten wurden erstellt.")
	return nil
}

// seedPrimaryCatalog creates German categories and products with mixed pricing.
func seedPrimaryCatalog(ctx context.Context, service catalog.Service, actor domain.Principal, membership domain.Membership) (primaryCatalog, error) {
	drinks, err := service.CreateCategory(ctx, actor, membership, catalog.CreateCategoryInput{Name: "Getränke", Icon: domain.CategoryIconDrink, SortOrder: 10})
	if err != nil {
		return primaryCatalog{}, fmt.Errorf("create drinks category: %w", err)
	}
	snacks, err := service.CreateCategory(ctx, actor, membership, catalog.CreateCategoryInput{Name: "Snacks", Icon: domain.CategoryIconFood, SortOrder: 20})
	if err != nil {
		return primaryCatalog{}, fmt.Errorf("create snacks category: %w", err)
	}
	fund, err := service.CreateCategory(ctx, actor, membership, catalog.CreateCategoryInput{Name: "Mannschaftskasse", Icon: domain.CategoryIconPenalty, SortOrder: 30})
	if err != nil {
		return primaryCatalog{}, fmt.Errorf("create team-fund category: %w", err)
	}
	water, err := createFixedProduct(ctx, service, actor, membership, drinks.ID, "seed-product-water", "Mineralwasser", 150, 10)
	if err != nil {
		return primaryCatalog{}, err
	}
	apple, err := createFixedProduct(ctx, service, actor, membership, drinks.ID, "seed-product-apple", "Apfelschorle", 220, 20)
	if err != nil {
		return primaryCatalog{}, err
	}
	pretzel, err := createFixedProduct(ctx, service, actor, membership, snacks.ID, "seed-product-pretzel", "Laugenbrezel", 200, 10)
	if err != nil {
		return primaryCatalog{}, err
	}
	cake, err := createFixedProduct(ctx, service, actor, membership, snacks.ID, "seed-product-cake", "Stück Kuchen", 280, 20)
	if err != nil {
		return primaryCatalog{}, err
	}
	late, err := createFixedProduct(ctx, service, actor, membership, fund.ID, "seed-product-late", "Zu spät zum Training", 500, 10)
	if err != nil {
		return primaryCatalog{}, err
	}
	trip, err := service.CreateProduct(ctx, actor, membership, "seed-product-trip", fund.ID, catalog.CreateProductInput{Name: "Mannschaftsfahrt", PricingMode: domain.ProductPricingUserDefined, SortOrder: 20})
	if err != nil {
		return primaryCatalog{}, fmt.Errorf("create trip product: %w", err)
	}
	contribution, err := service.CreateProduct(ctx, actor, membership, "seed-product-contribution", fund.ID, catalog.CreateProductInput{Name: "Freiwilliger Beitrag", PricingMode: domain.ProductPricingUserDefined, SortOrder: 30})
	if err != nil {
		return primaryCatalog{}, fmt.Errorf("create contribution product: %w", err)
	}
	return primaryCatalog{water, apple, pretzel, cake, late, trip, contribution}, nil
}

// seedPayments creates finance-managed payments sharing one received time.
func seedPayments(ctx context.Context, service finance.Service, actor domain.Principal, membership domain.Membership, receivedAt string, items []paymentSeed) error {
	for _, item := range items {
		if _, err := service.CreatePayment(ctx, actor, membership, item.key, finance.CreatePaymentInput{MembershipID: item.membershipID, AmountMinor: item.amountMinor, ReceivedAt: receivedAt, Method: item.method, Reference: item.reference, Note: item.note}); err != nil {
			return fmt.Errorf("create payment %q: %w", item.key, err)
		}
	}
	return nil
}

// seedSystemOnlyAdministrator creates one global administrator without a group.
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
		if _, err := tx.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)`, userID, systemOnlyAdminEmail, "Systemverwaltung", passwordHash, now, now); err != nil {
			return fmt.Errorf("insert system-only administrator: %w", err)
		}
		if _, err := systemadmin.GrantAdministratorInTx(ctx, tx, userID, grantingUserID); err != nil {
			return fmt.Errorf("grant system-only administrator: %w", err)
		}
		return nil
	})
}

// seedSecondaryGroup creates an unbranded group and one closed settlement.
func seedSecondaryGroup(ctx context.Context, authService auth.Service, groupService groups.Service, catalogService catalog.Service, bookingService bookings.Service, financeService finance.Service, periodService periods.Service, notificationService notifications.Service, dataDirectory string, administrator domain.Principal) error {
	group, err := groupService.Create(ctx, administrator, secondaryGroupName, "EUR")
	if err != nil {
		return fmt.Errorf("create secondary test group: %w", err)
	}
	group.Membership, err = assignAdministratorStandardRoles(ctx, groupService, administrator, group.Membership)
	if err != nil {
		return err
	}
	if err := configureGroup(ctx, groupService, administrator, group.Membership); err != nil {
		return err
	}
	category, err := catalogService.CreateCategory(ctx, administrator, group.Membership, catalog.CreateCategoryInput{Name: secondaryCategory, Icon: domain.CategoryIconDrink, SortOrder: 10})
	if err != nil {
		return fmt.Errorf("create secondary category: %w", err)
	}
	coffee, err := createFixedProduct(ctx, catalogService, administrator, group.Membership, category.ID, "seed-secondary-coffee", secondaryProduct, 180, 10)
	if err != nil {
		return err
	}
	if _, err := createFixedProduct(ctx, catalogService, administrator, group.Membership, category.ID, "seed-secondary-cake", "Kuchen vom Blech", 250, 20); err != nil {
		return err
	}
	if err := seedProductImage(ctx, catalogService, dataDirectory, administrator, group.Membership, imageSeed{"assets/product-club-coffee.webp", coffee}); err != nil {
		return err
	}
	coffee.Version++
	lena, err := createMember(ctx, authService, groupService, administrator, group.Membership, memberSeed{email: "lena@example.test", displayName: "Lena Spielerin"})
	if err != nil {
		return err
	}
	noah, err := createMember(ctx, authService, groupService, administrator, group.Membership, memberSeed{email: secondaryMemberEmail, displayName: "Noah Neuzugang"})
	if err != nil {
		return err
	}
	if err := seedAvatar(ctx, authService, dataDirectory, noah.principal, "assets/avatar-noah.webp"); err != nil {
		return err
	}
	return withTemporaryBookingGrants(ctx, groupService.DB, group.ID, func() error {
		periodID, periodErr := openPeriodID(ctx, groupService.DB, group.ID)
		if periodErr != nil {
			return periodErr
		}
		if _, bookingErr := bookingService.CreateBatch(ctx, administrator, group.Membership, "seed-secondary-bookings", bookings.BatchCreateInput{ProductID: coffee.ID, ProductVersion: coffee.Version, ExpectedPeriodID: periodID, Quantity: 2, TargetMembershipIDs: []string{lena.membership.ID, noah.membership.ID}, TemporaryGuestDisplayNames: []string{"Mila Besucherin"}, Reason: "Mannschaftsabend"}); bookingErr != nil {
			return fmt.Errorf("create secondary bookings: %w", bookingErr)
		}
		if err := seedPayments(ctx, financeService, administrator, group.Membership, platform.Timestamp(platform.Now()), []paymentSeed{{key: "seed-secondary-payment-noah", membershipID: noah.membership.ID, amountMinor: 250, method: "CASH", reference: "Bareinzahlung"}}); err != nil {
			return err
		}
		if err := configureNotifications(ctx, notificationService, groupService, administrator, group.Membership); err != nil {
			return err
		}
		result, closeErr := periodService.Close(ctx, administrator, group.Membership, "seed-close-secondary", periodID, periods.CloseInput{Label: "Vereinsabend", DueAt: platform.Now().AddDate(0, 0, 14).Format("2006-01-02"), NextPeriodLabel: "Nächster Vereinsabend"})
		if closeErr != nil {
			return fmt.Errorf("close secondary settlement: %w", closeErr)
		}
		if _, bookingErr := bookingService.Create(ctx, noah.principal, noah.membership, "seed-secondary-current", bookings.CreateInput{ProductID: coffee.ID, ProductVersion: coffee.Version, ExpectedPeriodID: result.OpenPeriod.ID, Quantity: 1, Reason: "Mannschaftsabend"}); bookingErr != nil {
			return fmt.Errorf("create secondary current booking: %w", bookingErr)
		}
		return nil
	})
}

// assignAdministratorStandardRoles combines only built-in standard roles.
func assignAdministratorStandardRoles(ctx context.Context, service groups.Service, actor domain.Principal, membership domain.Membership) (domain.Membership, error) {
	roleIDs := []string{
		authorization.PresetRoleID(membership.GroupID, domain.RolePresetGroupAdministrator),
		authorization.TemplateRoleID(membership.GroupID, domain.RoleTemplateMember),
		authorization.TemplateRoleID(membership.GroupID, domain.RoleTemplateFinance),
		authorization.TemplateRoleID(membership.GroupID, domain.RoleTemplateCatalog),
	}
	if _, err := service.ReplaceMemberRoles(ctx, actor, membership, membership.ID, roleIDs, membership.RoleAssignmentsVersion); err != nil {
		return domain.Membership{}, fmt.Errorf("assign administrator standard roles for group %q: %w", membership.GroupID, err)
	}
	updated, err := service.MembershipForUser(ctx, membership.GroupID, membership.UserID)
	if err != nil {
		return domain.Membership{}, fmt.Errorf("reload administrator for group %q: %w", membership.GroupID, err)
	}
	return updated, nil
}

// withTemporaryBookingGrants adds seed-only booking grants and always removes them.
func withTemporaryBookingGrants(ctx context.Context, db *sql.DB, groupID string, fn func() error) error {
	roleID := authorization.PresetRoleID(groupID, domain.RolePresetGroupAdministrator)
	now := platform.Timestamp(platform.Now())
	if err := storage.WithTx(ctx, db, func(tx *sql.Tx) error {
		for _, permission := range []domain.PermissionKey{domain.PermissionBookForOthers, domain.PermissionBookForGuests, domain.PermissionVoidAnyBooking} {
			if _, err := tx.ExecContext(ctx, `INSERT INTO role_permission_grants(group_id,role_id,permission_key,scope_type,version,created_at,updated_at) VALUES(?,?,?,'GROUP',1,?,?)`, groupID, roleID, permission, now, now); err != nil {
				return fmt.Errorf("grant temporary fixture permission %q: %w", permission, err)
			}
		}
		return nil
	}); err != nil {
		return err
	}
	seedErr := fn()
	_, cleanupErr := db.ExecContext(ctx, `DELETE FROM role_permission_grants WHERE group_id=? AND role_id=? AND permission_key IN (?,?,?)`, groupID, roleID, domain.PermissionBookForOthers, domain.PermissionBookForGuests, domain.PermissionVoidAnyBooking)
	if cleanupErr != nil {
		cleanupErr = fmt.Errorf("remove temporary fixture booking grants: %w", cleanupErr)
	}
	return errors.Join(seedErr, cleanupErr)
}

// configureGroup enables all group features and German transaction choices.
func configureGroup(ctx context.Context, service groups.Service, actor domain.Principal, membership domain.Membership) error {
	enabled := true
	optional, required := domain.ReasonModeOptional, domain.ReasonModeRequired
	methods := []domain.PaymentMethod{
		{ID: "BANK_TRANSFER", Label: "Überweisung", AttachmentMode: domain.AttachmentModeOff},
		{ID: "CARD", Label: "Karte", AttachmentMode: domain.AttachmentModeOff},
		{ID: "CASH", Label: "Bar", AttachmentMode: domain.AttachmentModeOff},
		{ID: "PAYPAL", Label: "PayPal", AttachmentMode: domain.AttachmentModeOff},
		{ID: "OTHER", Label: "Sonstige", AttachmentMode: domain.AttachmentModeOptional},
	}
	bookingReasons := append([]domain.ConfigurableItem(nil), bookingReasonSeeds...)
	paymentReasons := append([]domain.ConfigurableItem(nil), paymentReasonSeeds...)
	if _, err := service.UpdateSettings(ctx, actor, membership, groups.SettingsUpdate{NotificationEmailsEnabled: &enabled, SettlementsEnabled: &enabled, OwnBookingReasonMode: &optional, ForeignBookingReasonMode: &required, OwnPaymentReasonMode: &required, OtherPaymentReasonMode: &required, PaymentMethods: &methods, BookingReasons: &bookingReasons, PaymentReasons: &paymentReasons}); err != nil {
		return fmt.Errorf("configure features for group %q: %w", membership.GroupID, err)
	}
	return nil
}

// configureNotifications enables every event and both channels for all members.
func configureNotifications(ctx context.Context, service notifications.Service, groupService groups.Service, actor domain.Principal, administrator domain.Membership) error {
	settings, err := service.GetGroupSettings(ctx, administrator)
	if err != nil {
		return fmt.Errorf("read notification settings for group %q: %w", administrator.GroupID, err)
	}
	events := make([]notifications.GroupEventUpdate, 0, len(notifications.Catalog()))
	for _, definition := range notifications.Catalog() {
		events = append(events, notifications.GroupEventUpdate{Type: definition.Type, Enabled: true})
	}
	if _, err := service.UpdateGroupSettings(ctx, actor, administrator, notifications.GroupSettingsUpdate{Timezone: "Europe/Berlin", DueSoonLeadDays: 7, OverdueRepeatDays: 3, Events: events}, settings.Version); err != nil {
		return fmt.Errorf("enable notification events for group %q: %w", administrator.GroupID, err)
	}
	members, err := groupService.ListMembers(ctx, administrator)
	if err != nil {
		return fmt.Errorf("list notification members for group %q: %w", administrator.GroupID, err)
	}
	enabled := true
	for _, member := range members {
		preferences, readErr := service.GetPreferences(ctx, member)
		if readErr != nil {
			return fmt.Errorf("read notification preferences for %q: %w", member.DisplayName, readErr)
		}
		updates := make([]notifications.PreferenceUpdate, 0, len(events))
		for _, event := range events {
			updates = append(updates, notifications.PreferenceUpdate{Type: event.Type, Email: &enabled, Push: &enabled})
		}
		if _, updateErr := service.UpdatePreferences(ctx, member, notifications.PreferencesUpdate{Events: updates}, preferences.Version); updateErr != nil {
			return fmt.Errorf("enable notification preferences for %q: %w", member.DisplayName, updateErr)
		}
	}
	return nil
}

// seedProductImage stores and attaches one embedded product image.
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

// seedGroupLogo stores and attaches one embedded image to a group.
func seedGroupLogo(ctx context.Context, service groups.Service, dataDirectory string, actor domain.Principal, membership domain.Membership, assetPath string) error {
	imageKey, err := storeFixtureImage(dataDirectory, assetPath)
	if err != nil {
		return fmt.Errorf("store group logo: %w", err)
	}
	if _, _, err := service.SetLogo(ctx, actor, membership, imageKey); err != nil {
		return fmt.Errorf("attach group logo: %w", err)
	}
	return nil
}

// seedAvatar stores and attaches one embedded profile image.
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

// storeFixtureImage validates and content-addresses one embedded image.
func storeFixtureImage(dataDirectory, assetPath string) (string, error) {
	asset, err := fixtureAssets.Open(assetPath)
	if err != nil {
		return "", fmt.Errorf("open embedded asset %q: %w", assetPath, err)
	}
	defer asset.Close()
	imageKey, _, err := media.NormalizeAndStoreImage(dataDirectory, asset)
	return imageKey, err
}

// onlyGroup resolves the single group owned by a freshly bootstrapped user.
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

// createFixedProduct adds one fixed-price product to the seeded catalog.
func createFixedProduct(ctx context.Context, service catalog.Service, actor domain.Principal, membership domain.Membership, categoryID, idempotencyKey, name string, priceMinor int64, sortOrder int) (domain.Product, error) {
	item, err := service.CreateProduct(ctx, actor, membership, idempotencyKey, categoryID, catalog.CreateProductInput{Name: name, PriceMinor: &priceMinor, PricingMode: domain.ProductPricingFixed, SortOrder: sortOrder})
	if err != nil {
		return domain.Product{}, fmt.Errorf("create product %q: %w", name, err)
	}
	return item, nil
}

// createMember invites an account using only built-in standard roles.
func createMember(ctx context.Context, authService auth.Service, groupService groups.Service, actor domain.Principal, actorMembership domain.Membership, seed memberSeed) (seededMember, error) {
	wanted := make(map[string]struct{}, len(seed.roles)+1)
	if len(seed.roles) == 0 {
		wanted[authorization.TemplateRoleID(actorMembership.GroupID, domain.RoleTemplateMember)] = struct{}{}
	}
	for _, role := range seed.roles {
		switch role {
		case domain.RoleFinanceManager:
			wanted[authorization.TemplateRoleID(actorMembership.GroupID, domain.RoleTemplateFinance)] = struct{}{}
		case domain.RoleCatalogManager:
			wanted[authorization.TemplateRoleID(actorMembership.GroupID, domain.RoleTemplateCatalog)] = struct{}{}
		default:
			return seededMember{}, fmt.Errorf("unsupported non-standard role %q for %s", role, seed.email)
		}
	}
	roleIDs := make([]string, 0, len(wanted))
	for roleID := range wanted {
		roleIDs = append(roleIDs, roleID)
	}
	invitation, err := groupService.CreateInvitationWithRoles(ctx, actor, actorMembership, seed.email, seed.displayName, roleIDs)
	if err != nil {
		return seededMember{}, fmt.Errorf("invite %s: %w", seed.email, err)
	}
	preview, err := authService.PreviewInvitation(ctx, invitation.Token)
	if err != nil {
		return seededMember{}, fmt.Errorf("preview invitation for %s: %w", seed.email, err)
	}
	session, membership, err := authService.AcceptInvitation(ctx, auth.InvitationAcceptance{Token: invitation.Token, DisplayName: seed.displayName, Password: testPassword, ExpectedAccountState: preview.AccountState})
	if err != nil {
		return seededMember{}, fmt.Errorf("accept invitation for %s: %w", seed.email, err)
	}
	return seededMember{principal: session.Principal, membership: membership}, nil
}

// openPeriodID returns the only open accounting period for one group.
func openPeriodID(ctx context.Context, db *sql.DB, groupID string) (string, error) {
	var periodID string
	if err := db.QueryRowContext(ctx, `SELECT id FROM periods WHERE group_id=? AND status='OPEN'`, groupID).Scan(&periodID); err != nil {
		return "", fmt.Errorf("resolve open period: %w", err)
	}
	return periodID, nil
}
