package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/bookings"
	"github.com/DasLukas/TeamTaler/internal/catalog"
	"github.com/DasLukas/TeamTaler/internal/config"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestBookingBulkRouteCreatesMultiProductCart(t *testing.T) {
	ctx := context.Background()
	dataDirectory := t.TempDir()
	db, err := storage.Open(ctx, filepath.Join(dataDirectory, "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "bulk-admin@example.test", "Bulk Admin", "bulk-route-password-long", "Bulk Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := authService.Login(ctx, "bulk-admin@example.test", "bulk-route-password-long")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	groupService := groups.Service{DB: db}
	groupItems, err := groupService.List(ctx, session.Principal.UserID)
	if err != nil || len(groupItems) != 1 {
		t.Fatalf("list groups: groups=%d err=%v", len(groupItems), err)
	}
	group := groupItems[0]
	group.Membership = assignTestTemplateRoles(t, ctx, groupService, session.Principal, group.Membership, domain.RoleTemplateMember, domain.RoleTemplateCatalog)
	catalogService := catalog.Service{DB: db}
	category, err := catalogService.CreateCategory(ctx, session.Principal, group.Membership, catalog.CreateCategoryInput{Name: "Bulk route", Icon: domain.CategoryIconOther})
	if err != nil {
		t.Fatalf("create category: %v", err)
	}
	firstPrice, secondPrice := int64(100), int64(250)
	firstProduct, err := catalogService.CreateProduct(ctx, session.Principal, group.Membership, "bulk-route-first", category.ID, catalog.CreateProductInput{Name: "First", PriceMinor: &firstPrice})
	if err != nil {
		t.Fatalf("create first product: %v", err)
	}
	secondProduct, err := catalogService.CreateProduct(ctx, session.Principal, group.Membership, "bulk-route-second", category.ID, catalog.CreateProductInput{Name: "Second", PriceMinor: &secondPrice})
	if err != nil {
		t.Fatalf("create second product: %v", err)
	}
	var periodID string
	if err := db.QueryRowContext(ctx, `SELECT id FROM periods WHERE group_id=? AND status='OPEN'`, group.ID).Scan(&periodID); err != nil {
		t.Fatalf("read open period: %v", err)
	}
	input := bookings.BulkCreateInput{
		ExpectedPeriodID: periodID,
		Items: []bookings.BulkCreateItem{
			{ProductID: firstProduct.ID, ProductVersion: firstProduct.Version, Quantity: 2},
			{ProductID: secondProduct.ID, ProductVersion: secondProduct.Version, Quantity: 1},
		},
		TargetMembershipIDs: []string{group.Membership.ID},
	}
	body, err := json.Marshal(input)
	if err != nil {
		t.Fatalf("encode request: %v", err)
	}
	publicURL := &url.URL{Scheme: "http", Host: "teamtaler.test"}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := New(config.Config{
		DataDirectory:   dataDirectory,
		WebDirectory:    t.TempDir(),
		PublicURL:       publicURL,
		SessionLifetime: 24 * time.Hour,
		MaxRequestBytes: 1 << 20,
	}, db, logger)
	request := httptest.NewRequest(http.MethodPost, publicURL.String()+"/api/v1/groups/"+group.ID+"/bookings/bulk", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "bulk-route-request-one")
	request.Header.Set("X-CSRF-Token", session.CSRFToken)
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: session.Token})
	request.AddCookie(&http.Cookie{Name: csrfCookieName, Value: session.CSRFToken})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("bulk route status = %d, want 201; body=%s", response.Code, response.Body.String())
	}
	var created []domain.Booking
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(created) != 2 || created[0].ProductID != firstProduct.ID || created[1].ProductID != secondProduct.ID || created[0].TargetMembershipID != group.Membership.ID || created[1].TargetMembershipID != group.Membership.ID {
		t.Fatalf("bulk route response = %#v", created)
	}
}
