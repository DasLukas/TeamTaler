package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/catalog"
	"github.com/DasLukas/TeamTaler/internal/config"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestImageRequiresMembershipAndGroupReference(t *testing.T) {
	ctx := context.Background()
	dataDirectory := t.TempDir()
	db, err := storage.Open(ctx, filepath.Join(dataDirectory, "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "image-admin@example.test", "Image Admin", "image-test-password-long", "Image Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := authService.Login(ctx, "image-admin@example.test", "image-test-password-long")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	groupService := groups.Service{DB: db}
	groupItems, err := groupService.List(ctx, session.Principal.UserID)
	if err != nil || len(groupItems) != 1 {
		t.Fatalf("list groups: groups=%d err=%v", len(groupItems), err)
	}
	groupItems[0].Membership = assignTestTemplateRoles(t, ctx, groupService, session.Principal, groupItems[0].Membership, domain.RoleTemplateCatalog)
	catalogService := catalog.Service{DB: db}
	category, err := catalogService.CreateCategory(ctx, session.Principal, groupItems[0].Membership, catalog.CreateCategoryInput{Name: "Drinks", Icon: domain.CategoryIconDrink})
	if err != nil {
		t.Fatalf("create category: %v", err)
	}
	priceMinor := int64(100)
	product, err := catalogService.CreateProduct(ctx, session.Principal, groupItems[0].Membership, "image-product-one", category.ID, catalog.CreateProductInput{Name: "Water", PriceMinor: &priceMinor})
	if err != nil {
		t.Fatalf("create product: %v", err)
	}
	imageBody := []byte("normalized-image-fixture")
	digest := sha256.Sum256(imageBody)
	imageKey := hex.EncodeToString(digest[:]) + ".png"
	if err := os.MkdirAll(filepath.Join(dataDirectory, "images"), 0o750); err != nil {
		t.Fatalf("create image directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dataDirectory, "images", imageKey), imageBody, 0o640); err != nil {
		t.Fatalf("write image: %v", err)
	}
	imageURL, _, err := catalogService.SetProductImage(ctx, session.Principal, groupItems[0].Membership, product.ID, imageKey)
	if err != nil {
		t.Fatalf("set product image: %v", err)
	}
	if imageURL != "/api/v1/groups/"+groupItems[0].ID+"/images/"+imageKey {
		t.Fatalf("upload image URL = %q", imageURL)
	}
	listed, err := catalogService.List(ctx, groupItems[0].ID)
	if err != nil || len(listed) != 1 || len(listed[0].Products) != 1 || listed[0].Products[0].ImageURL != "/api/v1/groups/"+groupItems[0].ID+"/images/"+imageKey {
		t.Fatalf("group-scoped image URL: categories=%#v err=%v", listed, err)
	}
	secondGroup, err := groupService.Create(ctx, session.Principal, "Second Image Group", "EUR")
	if err != nil {
		t.Fatalf("create second group: %v", err)
	}
	logoBody := []byte("normalized-logo-fixture")
	logoDigest := sha256.Sum256(logoBody)
	logoKey := hex.EncodeToString(logoDigest[:]) + ".png"
	if err := os.WriteFile(filepath.Join(dataDirectory, "images", logoKey), logoBody, 0o640); err != nil {
		t.Fatalf("write logo image: %v", err)
	}
	if _, _, err := groupService.SetLogo(ctx, session.Principal, groupItems[0].Membership, logoKey); err != nil {
		t.Fatalf("set group logo: %v", err)
	}
	server := &Server{config: config.Config{DataDirectory: dataDirectory}, db: db, groups: groupService}

	positive := imageRequest(t, groupItems[0].ID, imageKey, session.Principal)
	positiveResponse := httptest.NewRecorder()
	server.handleImage(positiveResponse, positive)
	if positiveResponse.Code != http.StatusOK || positiveResponse.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("authorized image response: status=%d cache=%q", positiveResponse.Code, positiveResponse.Header().Get("Cache-Control"))
	}

	crossTenant := imageRequest(t, secondGroup.ID, imageKey, session.Principal)
	crossTenantResponse := httptest.NewRecorder()
	server.handleImage(crossTenantResponse, crossTenant)
	if crossTenantResponse.Code != http.StatusNotFound {
		t.Fatalf("known hash in unreferencing tenant status = %d, want 404", crossTenantResponse.Code)
	}

	logoPositive := imageRequest(t, groupItems[0].ID, logoKey, session.Principal)
	logoPositiveResponse := httptest.NewRecorder()
	server.handleImage(logoPositiveResponse, logoPositive)
	if logoPositiveResponse.Code != http.StatusOK {
		t.Fatalf("authorized group logo response status = %d, want 200", logoPositiveResponse.Code)
	}
	logoCrossTenant := imageRequest(t, secondGroup.ID, logoKey, session.Principal)
	logoCrossTenantResponse := httptest.NewRecorder()
	server.handleImage(logoCrossTenantResponse, logoCrossTenant)
	if logoCrossTenantResponse.Code != http.StatusNotFound {
		t.Fatalf("group logo in unreferencing tenant status = %d, want 404", logoCrossTenantResponse.Code)
	}

	loggedOut := imageRequest(t, groupItems[0].ID, imageKey, domain.Principal{})
	loggedOutResponse := httptest.NewRecorder()
	server.handleImage(loggedOutResponse, loggedOut)
	if loggedOutResponse.Code != http.StatusUnauthorized {
		t.Fatalf("logged-out known hash status = %d, want 401", loggedOutResponse.Code)
	}
}

func imageRequest(t *testing.T, groupID, imageKey string, principal domain.Principal) *http.Request {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/groups/"+groupID+"/images/"+imageKey, nil)
	request.SetPathValue("groupID", groupID)
	request.SetPathValue("imageKey", imageKey)
	if principal.UserID != "" {
		request = request.WithContext(context.WithValue(request.Context(), principalKey, principal))
	}
	return request
}

func TestUserAvatarRequiresCurrentReferenceAndAuthentication(t *testing.T) {
	ctx := context.Background()
	dataDirectory := t.TempDir()
	db, err := storage.Open(ctx, filepath.Join(dataDirectory, "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "avatar-admin@example.test", "Avatar Admin", "avatar-test-password-long", "Avatar Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := authService.Login(ctx, "avatar-admin@example.test", "avatar-test-password-long")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	imageBody := []byte("normalized-avatar-fixture")
	digest := sha256.Sum256(imageBody)
	imageKey := hex.EncodeToString(digest[:]) + ".png"
	if err := os.MkdirAll(filepath.Join(dataDirectory, "images"), 0o750); err != nil {
		t.Fatalf("create image directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dataDirectory, "images", imageKey), imageBody, 0o640); err != nil {
		t.Fatalf("write avatar: %v", err)
	}
	if _, _, err := authService.SetAvatar(ctx, session.Principal, imageKey); err != nil {
		t.Fatalf("set avatar: %v", err)
	}
	server := &Server{config: config.Config{DataDirectory: dataDirectory}, db: db, auth: authService}

	request := userAvatarRequest(t, session.Principal.UserID, imageKey, session.Principal)
	response := httptest.NewRecorder()
	server.handleUserAvatar(response, request)
	if response.Code != http.StatusOK || response.Body.String() != string(imageBody) {
		t.Fatalf("current avatar response: status=%d body=%q", response.Code, response.Body.String())
	}

	staleRequest := userAvatarRequest(t, session.Principal.UserID, strings.Repeat("a", 64)+".png", session.Principal)
	staleResponse := httptest.NewRecorder()
	server.handleUserAvatar(staleResponse, staleRequest)
	if staleResponse.Code != http.StatusNotFound {
		t.Fatalf("stale avatar status=%d, want 404", staleResponse.Code)
	}

	loggedOutRequest := userAvatarRequest(t, session.Principal.UserID, imageKey, domain.Principal{})
	loggedOutResponse := httptest.NewRecorder()
	server.handleUserAvatar(loggedOutResponse, loggedOutRequest)
	if loggedOutResponse.Code != http.StatusUnauthorized {
		t.Fatalf("logged-out avatar status=%d, want 401", loggedOutResponse.Code)
	}
}

func userAvatarRequest(t *testing.T, userID, imageKey string, principal domain.Principal) *http.Request {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/users/"+userID+"/avatar/"+imageKey, nil)
	request.SetPathValue("userID", userID)
	request.SetPathValue("imageKey", imageKey)
	if principal.UserID != "" {
		request = request.WithContext(context.WithValue(request.Context(), principalKey, principal))
	}
	return request
}

func TestRequiredIfMatchVersion(t *testing.T) {
	tests := []struct {
		name        string
		header      string
		wantVersion int64
		wantError   bool
	}{
		{name: "strong version", header: `"v7"`, wantVersion: 7},
		{name: "missing", wantError: true},
		{name: "malformed", header: `"latest"`, wantError: true},
		{name: "unquoted", header: `v7`, wantError: true},
		{name: "zero", header: `"v0"`, wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodDelete, "/api/v1/groups/group-a/products/product-a", nil)
			if test.header != "" {
				request.Header.Set("If-Match", test.header)
			}
			version, err := requiredIfMatchVersion(request)
			if (err != nil) != test.wantError || version != test.wantVersion {
				t.Fatalf("required If-Match version=%d err=%v, want version=%d error=%v", version, err, test.wantVersion, test.wantError)
			}
		})
	}
}
