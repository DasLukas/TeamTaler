package catalog

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestBarcodeKeyNormalizesRetailCodesAndRejectsInvalidValues(t *testing.T) {
	variants := []domain.ProductBarcode{
		{Format: "UPC_A", Value: "012345000065"},
		{Format: "EAN_13", Value: "0012345000065"},
		{Format: "UPC_E", Value: "01234565"},
	}
	var expected string
	for _, variant := range variants {
		key, err := BarcodeKey(variant)
		if err != nil {
			t.Fatalf("normalize %#v: %v", variant, err)
		}
		if expected == "" {
			expected = key
		} else if key != expected {
			t.Fatalf("equivalent barcode %#v = %q, want %q", variant, key, expected)
		}
	}
	for _, invalid := range []domain.ProductBarcode{
		{Format: "EAN_13", Value: "0012345000066"},
		{Format: "UPC_E", Value: "01234566"},
		{Format: "UPC_A", Value: "01234500006x"},
		{Format: "CODE_128", Value: "\x00"},
		{Format: "QR", Value: "012345000065"},
	} {
		if _, err := BarcodeKey(invalid); !errors.Is(err, domain.ErrValidation) {
			t.Fatalf("invalid barcode %#v: err=%v", invalid, err)
		}
	}
}

func TestNormalizeBarcodesIdentifiesRejectedRow(t *testing.T) {
	valid := domain.ProductBarcode{Format: "EAN_13", Value: "4006381333931"}
	invalid := domain.ProductBarcode{Format: "EAN_13", Value: "4006381333932"}
	_, err := normalizeBarcodes([]domain.ProductBarcode{valid, invalid})
	var validation domain.ValidationError
	if !errors.As(err, &validation) || validation.Field != "barcodes[1].value" {
		t.Fatalf("invalid row error = %v, want barcodes[1].value", err)
	}
	_, err = normalizeBarcodes([]domain.ProductBarcode{valid, valid})
	if !errors.As(err, &validation) || validation.Field != "barcodes[1].value" {
		t.Fatalf("duplicate row error = %v, want barcodes[1].value", err)
	}
}

func TestProductBarcodesAreGroupScopedAndPersistAcrossCatalogReads(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.Service{DB: db, SessionLifetime: time.Hour}
	if err := authService.Bootstrap(ctx, "barcode-admin@example.test", "Barcode Admin", "barcode-test-password-long", "Barcode Group", "EUR"); err != nil {
		t.Fatal(err)
	}
	session, err := authService.Login(ctx, "barcode-admin@example.test", "barcode-test-password-long")
	if err != nil {
		t.Fatal(err)
	}
	groupService := groups.Service{DB: db}
	listedGroups, err := groupService.List(ctx, session.Principal.UserID)
	if err != nil || len(listedGroups) != 1 {
		t.Fatalf("groups=%#v err=%v", listedGroups, err)
	}
	admin := listedGroups[0].Membership
	if listedGroups[0].KioskEnabled {
		t.Fatal("kiosk unexpectedly enabled on a new group")
	}
	var kioskGrants int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM role_permission_grants WHERE group_id=? AND permission_key='USE_KIOSK'`, admin.GroupID).Scan(&kioskGrants); err != nil || kioskGrants != 0 {
		t.Fatalf("default kiosk grants=%d err=%v", kioskGrants, err)
	}
	groupSettings, err := groupService.Settings(ctx, admin)
	if err != nil || groupSettings.KioskEnabled {
		t.Fatalf("initial kiosk settings=%#v err=%v", groupSettings, err)
	}
	kioskEnabled := true
	groupSettings, err = groupService.UpdateSettings(ctx, session.Principal, admin, groups.SettingsUpdate{KioskEnabled: &kioskEnabled})
	if err != nil || !groupSettings.KioskEnabled {
		t.Fatalf("enable kiosk=%#v err=%v", groupSettings, err)
	}
	listedGroups, err = groupService.List(ctx, session.Principal.UserID)
	if err != nil || !listedGroups[0].KioskEnabled {
		t.Fatalf("member-visible kiosk setting=%#v err=%v", listedGroups, err)
	}
	assignment, err := groupService.ReplaceMemberRoles(ctx, session.Principal, admin, admin.ID, []string{
		"role:GROUP_ADMINISTRATOR:" + admin.GroupID,
		"role:CATALOG_MANAGER:" + admin.GroupID,
	}, admin.RoleAssignmentsVersion)
	if err != nil || assignment.Version <= admin.RoleAssignmentsVersion {
		t.Fatalf("assign catalog role=%#v err=%v", assignment, err)
	}
	service := Service{DB: db}
	category, err := service.CreateCategory(ctx, session.Principal, admin, CreateCategoryInput{Name: "Drinks", Icon: domain.CategoryIconDrink})
	if err != nil {
		t.Fatal(err)
	}
	price := int64(100)
	first, err := service.CreateProduct(ctx, session.Principal, admin, "barcode-product-first", category.ID, CreateProductInput{Name: "Water", PriceMinor: &price, Barcodes: []domain.ProductBarcode{{Format: "UPC_A", Value: "012345000065"}}})
	if err != nil || len(first.Barcodes) != 1 {
		t.Fatalf("create product=%#v err=%v", first, err)
	}
	_, err = service.CreateProduct(ctx, session.Principal, admin, "barcode-product-conflict", category.ID, CreateProductInput{Name: "Other water", PriceMinor: &price, Barcodes: []domain.ProductBarcode{{Format: "EAN_13", Value: "0012345000065"}}})
	if !errors.Is(err, domain.ErrConflict) || !strings.Contains(err.Error(), "barcode[0]") {
		t.Fatalf("equivalent barcode conflict: %v", err)
	}
	second, err := service.CreateProduct(ctx, session.Principal, admin, "barcode-product-second", category.ID, CreateProductInput{Name: "Soda", PriceMinor: &price})
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.UpdateProduct(ctx, session.Principal, admin, second.ID, UpdateProductInput{
		Name: second.Name, PriceMinor: &price, PricingMode: second.PricingMode, Active: true, Version: second.Version,
		Barcodes: []domain.ProductBarcode{{Format: "EAN_13", Value: "0012345000065"}},
	})
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("update barcode conflict: %v", err)
	}
	items, err := service.List(ctx, admin.GroupID)
	if err != nil || len(items) != 1 || len(items[0].Products) != 2 || len(items[0].Products[0].Barcodes) != 1 || items[0].Products[1].Version != second.Version {
		t.Fatalf("catalog=%#v err=%v", items, err)
	}
	updated, err := service.UpdateProduct(ctx, session.Principal, admin, first.ID, UpdateProductInput{
		Name: first.Name, PriceMinor: &price, PricingMode: first.PricingMode, Active: true, Version: first.Version,
	})
	if err != nil || len(updated.Barcodes) != 1 {
		t.Fatalf("legacy update preserved barcode=%#v err=%v", updated, err)
	}
	updated, err = service.UpdateProduct(ctx, session.Principal, admin, first.ID, UpdateProductInput{
		Name: first.Name, PriceMinor: &price, PricingMode: first.PricingMode, Active: true, Version: updated.Version,
		Barcodes: []domain.ProductBarcode{},
	})
	if err != nil || len(updated.Barcodes) != 0 {
		t.Fatalf("clear barcode=%#v err=%v", updated, err)
	}
	reused, err := service.CreateProduct(ctx, session.Principal, admin, "barcode-reused-after-clear", category.ID, CreateProductInput{Name: "Reused", PriceMinor: &price, Barcodes: first.Barcodes})
	if err != nil {
		t.Fatalf("reuse released barcode: %v", err)
	}
	archived, err := service.UpdateProduct(ctx, session.Principal, admin, reused.ID, UpdateProductInput{
		Name: reused.Name, PriceMinor: &price, PricingMode: reused.PricingMode, Active: false, Version: reused.Version,
	})
	if err != nil || len(archived.Barcodes) != 1 {
		t.Fatalf("archive retains barcode=%#v err=%v", archived, err)
	}
	if err := service.DeleteProduct(ctx, session.Principal, admin, reused.ID, archived.Version); err != nil {
		t.Fatalf("delete archived product: %v", err)
	}
	if _, err := service.CreateProduct(ctx, session.Principal, admin, "barcode-reused-after-delete", category.ID, CreateProductInput{Name: "Again", PriceMinor: &price, Barcodes: first.Barcodes}); err != nil {
		t.Fatalf("reuse deleted product barcode: %v", err)
	}
	otherGroup, err := groupService.Create(ctx, session.Principal, "Other Barcode Group", "EUR")
	if err != nil {
		t.Fatal(err)
	}
	otherAdmin := otherGroup.Membership
	if _, err := groupService.ReplaceMemberRoles(ctx, session.Principal, otherAdmin, otherAdmin.ID, []string{
		"role:GROUP_ADMINISTRATOR:" + otherAdmin.GroupID,
		"role:CATALOG_MANAGER:" + otherAdmin.GroupID,
	}, otherAdmin.RoleAssignmentsVersion); err != nil {
		t.Fatal(err)
	}
	otherCategory, err := service.CreateCategory(ctx, session.Principal, otherGroup.Membership, CreateCategoryInput{Name: "Drinks", Icon: domain.CategoryIconDrink})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateProduct(ctx, session.Principal, otherGroup.Membership, "barcode-other-group", otherCategory.ID, CreateProductInput{Name: "Water", PriceMinor: &price, Barcodes: first.Barcodes}); err != nil {
		t.Fatalf("same barcode in distinct group: %v", err)
	}
}
