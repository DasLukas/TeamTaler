package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/activities"
	"github.com/DasLukas/TeamTaler/internal/bookings"
	"github.com/DasLukas/TeamTaler/internal/catalog"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/finance"
	"github.com/DasLukas/TeamTaler/internal/platform"
	systemadmin "github.com/DasLukas/TeamTaler/internal/system"
)

func TestTableQueryHandlersFilterSortAndPaginateWithoutChangingArrayBodies(t *testing.T) {
	server, principal, membership := invitationImportServer(t, false)
	ctx := context.Background()
	membership = assignTestTemplateRoles(t, ctx, server.groups, principal, membership,
		domain.RoleTemplateMember, domain.RoleTemplateCatalog, domain.RoleTemplateFinance)
	server.catalog = catalog.Service{DB: server.db}
	server.activities = activities.Service{DB: server.db}
	server.bookings = bookings.Service{DB: server.db, Groups: server.groups}
	server.finance = finance.Service{DB: server.db}

	category, err := server.catalog.CreateCategory(ctx, principal, membership, catalog.CreateCategoryInput{Name: "Refreshments", Icon: domain.CategoryIconOther})
	if err != nil {
		t.Fatalf("create category: %v", err)
	}
	prices := []int64{100, 200, 300}
	products := make([]domain.Product, 0, len(prices))
	for index, price := range prices {
		product, err := server.catalog.CreateProduct(ctx, principal, membership, "table-product-"+string(rune('a'+index)), category.ID,
			catalog.CreateProductInput{Name: []string{"Coffee", "Tea", "Juice"}[index], PriceMinor: &price})
		if err != nil {
			t.Fatalf("create product %d: %v", index, err)
		}
		products = append(products, product)
	}
	var periodID string
	if err := server.db.QueryRowContext(ctx, `SELECT id FROM periods WHERE group_id=? AND status='OPEN'`, membership.GroupID).Scan(&periodID); err != nil {
		t.Fatalf("read open period: %v", err)
	}
	originalNow := platform.Now
	t.Cleanup(func() { platform.Now = originalNow })
	for index, product := range products {
		occurredAt := time.Date(2026, 8, 18, 10+index, 0, 0, 0, time.UTC)
		platform.Now = func() time.Time { return occurredAt }
		if _, err := server.bookings.Create(ctx, principal, membership, "table-booking-key-"+string(rune('a'+index)), bookings.CreateInput{
			ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: periodID, Quantity: 1,
		}); err != nil {
			t.Fatalf("create booking %d: %v", index, err)
		}
		if _, err := server.finance.CreatePayment(ctx, principal, membership, "table-payment-key-"+string(rune('a'+index)), finance.CreatePaymentInput{
			MembershipID: membership.ID, AmountMinor: prices[index], ReceivedAt: occurredAt.Format(time.RFC3339),
			Method: "CASH", Reference: []string{"first", "second", "third"}[index], Note: "Table query payment",
		}); err != nil {
			t.Fatalf("create payment %d: %v", index, err)
		}
	}
	if _, err := server.db.ExecContext(ctx, `INSERT INTO ledger_entries(id,group_id,period_id,membership_id,account,amount_minor,description,created_at)
		VALUES('table-adjustment',?,?,?,?,50,'Manual adjustment','2026-08-18T13:00:00Z')`, membership.GroupID, periodID, membership.ID, "MEMBER_RECEIVABLE"); err != nil {
		t.Fatalf("create adjustment: %v", err)
	}

	unifiedResponse := performTableGET(t, principal, membership.GroupID,
		"/api/v1/groups/"+membership.GroupID+"/activities?sort=amount&direction=asc&limit=4", server.handleActivities)
	if unifiedResponse.Code != http.StatusOK || unifiedResponse.Header().Get("X-Has-More") != "true" || unifiedResponse.Header().Get("X-Next-Cursor") == "" {
		t.Fatalf("unified response status=%d headers=%v body=%s", unifiedResponse.Code, unifiedResponse.Header(), unifiedResponse.Body.String())
	}
	var firstUnified []activities.Entry
	if err := json.Unmarshal(unifiedResponse.Body.Bytes(), &firstUnified); err != nil || len(firstUnified) != 4 {
		t.Fatalf("unified first page=%#v err=%v body=%s", firstUnified, err, unifiedResponse.Body.String())
	}
	wantFirstAmounts := []int64{-300, -200, -100, 50}
	for index, want := range wantFirstAmounts {
		if firstUnified[index].AmountMinor != want {
			t.Fatalf("unified first amounts=%#v, index %d want %d", firstUnified, index, want)
		}
	}
	unifiedCursor := url.QueryEscape(unifiedResponse.Header().Get("X-Next-Cursor"))
	nextUnifiedResponse := performTableGET(t, principal, membership.GroupID,
		"/api/v1/groups/"+membership.GroupID+"/activities?sort=amount&direction=asc&limit=4&cursor="+unifiedCursor, server.handleActivities)
	var nextUnified []activities.Entry
	if err := json.Unmarshal(nextUnifiedResponse.Body.Bytes(), &nextUnified); err != nil || nextUnifiedResponse.Code != http.StatusOK || len(nextUnified) != 3 || nextUnified[0].AmountMinor != 100 || nextUnified[2].AmountMinor != 300 {
		t.Fatalf("unified next page status=%d items=%#v err=%v body=%s", nextUnifiedResponse.Code, nextUnified, err, nextUnifiedResponse.Body.String())
	}
	adjustmentResponse := performTableGET(t, principal, membership.GroupID,
		"/api/v1/groups/"+membership.GroupID+"/activities?kind=ADJUSTMENT&amountMin=50&amountMax=50", server.handleActivities)
	var adjustments []activities.Entry
	if err := json.Unmarshal(adjustmentResponse.Body.Bytes(), &adjustments); err != nil || adjustmentResponse.Code != http.StatusOK || len(adjustments) != 1 || adjustments[0].Kind != activities.KindAdjustment {
		t.Fatalf("adjustments status=%d items=%#v err=%v body=%s", adjustmentResponse.Code, adjustments, err, adjustmentResponse.Body.String())
	}

	multiActivityResponse := performTableGET(t, principal, membership.GroupID,
		"/api/v1/groups/"+membership.GroupID+"/bookings?categoryId="+url.QueryEscape(category.ID)+"&categoryId=missing-category&productId="+url.QueryEscape(products[0].ID)+"&productId="+url.QueryEscape(products[2].ID)+"&sort=amount&direction=asc&limit=10",
		server.handleListBookings)
	var multiActivity []domain.Booking
	if err := json.Unmarshal(multiActivityResponse.Body.Bytes(), &multiActivity); err != nil || multiActivityResponse.Code != http.StatusOK || len(multiActivity) != 2 || multiActivity[0].ProductName != "Coffee" || multiActivity[1].ProductName != "Juice" {
		t.Fatalf("multi-value activity status=%d items=%#v err=%v body=%s", multiActivityResponse.Code, multiActivity, err, multiActivityResponse.Body.String())
	}
	activityOptionsResponse := performTableGET(t, principal, membership.GroupID,
		"/api/v1/groups/"+membership.GroupID+"/bookings/filter-options", server.handleBookingFilterOptions)
	var activityOptions bookings.ActivityFilterOptions
	if err := json.Unmarshal(activityOptionsResponse.Body.Bytes(), &activityOptions); err != nil || activityOptionsResponse.Code != http.StatusOK || len(activityOptions.Members) != 1 || activityOptions.Members[0].MembershipID != membership.ID {
		t.Fatalf("activity options status=%d options=%#v err=%v body=%s", activityOptionsResponse.Code, activityOptions, err, activityOptionsResponse.Body.String())
	}

	activityResponse := performTableGET(t, principal, membership.GroupID,
		"/api/v1/groups/"+membership.GroupID+"/bookings?q=e&createdFrom=2026-08-18&createdTo=2026-08-18&sort=amount&direction=asc&limit=1",
		server.handleListBookings)
	if activityResponse.Code != http.StatusOK || activityResponse.Header().Get("X-Has-More") != "true" || activityResponse.Header().Get("X-Next-Cursor") == "" {
		t.Fatalf("activity response status=%d headers=%v body=%s", activityResponse.Code, activityResponse.Header(), activityResponse.Body.String())
	}
	var firstActivity []domain.Booking
	if err := json.Unmarshal(activityResponse.Body.Bytes(), &firstActivity); err != nil || len(firstActivity) != 1 || firstActivity[0].ProductName != "Coffee" {
		t.Fatalf("first activity=%#v err=%v", firstActivity, err)
	}
	activityCursor := url.QueryEscape(activityResponse.Header().Get("X-Next-Cursor"))
	nextActivity := performTableGET(t, principal, membership.GroupID,
		"/api/v1/groups/"+membership.GroupID+"/bookings?q=e&createdFrom=2026-08-18&createdTo=2026-08-18&sort=amount&direction=asc&limit=1&cursor="+activityCursor,
		server.handleListBookings)
	var secondActivity []domain.Booking
	if err := json.Unmarshal(nextActivity.Body.Bytes(), &secondActivity); err != nil || len(secondActivity) != 1 || secondActivity[0].ProductName != "Tea" {
		t.Fatalf("second activity status=%d items=%#v err=%v body=%s", nextActivity.Code, secondActivity, err, nextActivity.Body.String())
	}
	mismatchedCursor := performTableGET(t, principal, membership.GroupID,
		"/api/v1/groups/"+membership.GroupID+"/bookings?q=Coffee&sort=amount&direction=asc&limit=1&cursor="+activityCursor,
		server.handleListBookings)
	if mismatchedCursor.Code != http.StatusUnprocessableEntity {
		t.Fatalf("mismatched cursor status=%d body=%s", mismatchedCursor.Code, mismatchedCursor.Body.String())
	}
	maliciousSort := performTableGET(t, principal, membership.GroupID,
		"/api/v1/groups/"+membership.GroupID+"/bookings?sort="+url.QueryEscape("amount DESC; DROP TABLE bookings;--")+"&direction=asc",
		server.handleListBookings)
	if maliciousSort.Code != http.StatusUnprocessableEntity {
		t.Fatalf("malicious sort status=%d body=%s", maliciousSort.Code, maliciousSort.Body.String())
	}
	maliciousDirection := performTableGET(t, principal, membership.GroupID,
		"/api/v1/groups/"+membership.GroupID+"/bookings?sort=amount&direction="+url.QueryEscape("desc; DROP TABLE bookings;--"),
		server.handleListBookings)
	if maliciousDirection.Code != http.StatusUnprocessableEntity {
		t.Fatalf("malicious direction status=%d body=%s", maliciousDirection.Code, maliciousDirection.Body.String())
	}
	postInjectionActivity := performTableGET(t, principal, membership.GroupID,
		"/api/v1/groups/"+membership.GroupID+"/bookings?sort=amount&direction=asc&limit=10",
		server.handleListBookings)
	if postInjectionActivity.Code != http.StatusOK {
		t.Fatalf("post-injection activity status=%d body=%s", postInjectionActivity.Code, postInjectionActivity.Body.String())
	}

	paymentResponse := performTableGET(t, principal, membership.GroupID,
		"/api/v1/groups/"+membership.GroupID+"/payments?q=payment&status=POSTED&sort=amount&direction=desc&limit=2",
		server.handleListPayments)
	var paymentItems []domain.Payment
	if err := json.Unmarshal(paymentResponse.Body.Bytes(), &paymentItems); err != nil || paymentResponse.Code != http.StatusOK || len(paymentItems) != 2 || paymentItems[0].AmountMinor != 300 || paymentItems[1].AmountMinor != 200 || paymentItems[0].ActorMembershipID != membership.ID || paymentItems[0].ActorDisplayName != membership.DisplayName {
		t.Fatalf("payments status=%d items=%#v err=%v body=%s", paymentResponse.Code, paymentItems, err, paymentResponse.Body.String())
	}

	movementResponse := performTableGET(t, principal, membership.GroupID,
		"/api/v1/groups/"+membership.GroupID+"/accounts/me/movements?type=PAYMENT&sort=amount&direction=asc&limit=2",
		server.handleOwnAccountMovements)
	var movements []finance.LedgerEntry
	if err := json.Unmarshal(movementResponse.Body.Bytes(), &movements); err != nil || movementResponse.Code != http.StatusOK || len(movements) != 2 || movements[0].Type != "PAYMENT" || movements[0].AmountMinor != -300 {
		t.Fatalf("movements status=%d items=%#v err=%v body=%s", movementResponse.Code, movements, err, movementResponse.Body.String())
	}

	auditResponse := performTableGET(t, principal, membership.GroupID,
		"/api/v1/groups/"+membership.GroupID+"/audit?action=booking.created&occurredFrom=2026-08-18&occurredTo=2026-08-18&limit=1",
		server.handleAudit)
	var auditItems []map[string]any
	if err := json.Unmarshal(auditResponse.Body.Bytes(), &auditItems); err != nil || auditResponse.Code != http.StatusOK || len(auditItems) != 1 || auditResponse.Header().Get("X-Next-Cursor") == "" {
		t.Fatalf("audit status=%d items=%#v err=%v body=%s", auditResponse.Code, auditItems, err, auditResponse.Body.String())
	}
	multiAuditResponse := performTableGET(t, principal, membership.GroupID,
		"/api/v1/groups/"+membership.GroupID+"/audit?action=booking.created&action=payment.created&resourceType=booking&resourceType=payment&limit=10",
		server.handleAudit)
	if err := json.Unmarshal(multiAuditResponse.Body.Bytes(), &auditItems); err != nil || multiAuditResponse.Code != http.StatusOK || len(auditItems) != 6 {
		t.Fatalf("multi audit status=%d items=%#v err=%v body=%s", multiAuditResponse.Code, auditItems, err, multiAuditResponse.Body.String())
	}
	auditOptionsResponse := performTableGET(t, principal, membership.GroupID,
		"/api/v1/groups/"+membership.GroupID+"/audit/filter-options", server.handleAuditFilterOptions)
	var auditOptions struct {
		Actions             []string            `json:"actions"`
		ResourceTypes       []string            `json:"resourceTypes"`
		ActionResourceTypes map[string][]string `json:"actionResourceTypes"`
		Actors              []struct {
			MembershipID string `json:"membershipId"`
		} `json:"actors"`
	}
	if err := json.Unmarshal(auditOptionsResponse.Body.Bytes(), &auditOptions); err != nil || auditOptionsResponse.Code != http.StatusOK || !containsString(auditOptions.Actions, "booking.created") || !containsString(auditOptions.ResourceTypes, "payment") || !containsString(auditOptions.ActionResourceTypes["booking.created"], "booking") || len(auditOptions.Actors) != 1 || auditOptions.Actors[0].MembershipID != membership.ID {
		t.Fatalf("audit options status=%d options=%#v err=%v body=%s", auditOptionsResponse.Code, auditOptions, err, auditOptionsResponse.Body.String())
	}
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func TestSystemAuditHandlerUsesCompatibleObjectBodyAndCursorHeaders(t *testing.T) {
	server, principal, _ := invitationImportServer(t, false)
	service, err := systemadmin.NewService(server.db, systemadmin.Defaults{
		InstanceName: "TeamTaler", DefaultCurrency: "EUR", MediaUploadMaxBytes: 5 << 20,
		PublicJoinEnabled: true, MaxRequestBytes: 6 << 20, Sources: map[systemadmin.SettingKey]systemadmin.SettingSource{},
	}, nil)
	if err != nil {
		t.Fatalf("create system service: %v", err)
	}
	server.systemAdmin = service
	for index, occurredAt := range []string{"2026-08-18T10:00:00Z", "2026-08-18T11:00:00Z"} {
		if _, err := server.db.ExecContext(context.Background(), `INSERT INTO system_audit_events(id,actor_user_id,action,resource_type,resource_id,metadata_json,occurred_at) VALUES(?,?,?,?,?,?,?)`,
			[]string{"sya_http_a", "sya_http_b"}[index], principal.UserID, "system.query.test", "test_resource", "resource", `{}`, occurredAt); err != nil {
			t.Fatalf("insert system audit event: %v", err)
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/system/audit?action=system.query.test&limit=1", nil)
	request = request.WithContext(context.WithValue(request.Context(), principalKey, principal))
	response := httptest.NewRecorder()
	server.handleSystemAudit(response, request)
	if response.Code != http.StatusOK || response.Header().Get("X-Next-Cursor") == "" || response.Header().Get("X-Has-More") != "true" {
		t.Fatalf("system audit status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
	var body struct {
		Items []systemadmin.AuditEvent `json:"items"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || len(body.Items) != 1 || body.Items[0].ID != "sya_http_b" {
		t.Fatalf("system audit body=%#v err=%v raw=%s", body, err, response.Body.String())
	}
	optionsRequest := httptest.NewRequest(http.MethodGet, "/api/v1/system/audit/filter-options", nil)
	optionsRequest = optionsRequest.WithContext(context.WithValue(optionsRequest.Context(), principalKey, principal))
	optionsResponse := httptest.NewRecorder()
	server.handleSystemAuditFilterOptions(optionsResponse, optionsRequest)
	var options systemadmin.AuditFilterOptions
	if err := json.Unmarshal(optionsResponse.Body.Bytes(), &options); err != nil || optionsResponse.Code != http.StatusOK || !containsString(options.Actions, "system.query.test") || !containsString(options.ResourceTypes, "test_resource") || !containsString(options.ActionResourceTypes["system.query.test"], "test_resource") {
		t.Fatalf("system audit options status=%d options=%#v err=%v body=%s", optionsResponse.Code, options, err, optionsResponse.Body.String())
	}
}

func performTableGET(t *testing.T, principal domain.Principal, groupID, target string, handler func(http.ResponseWriter, *http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, target, nil)
	request.SetPathValue("groupID", groupID)
	request = request.WithContext(context.WithValue(request.Context(), principalKey, principal))
	response := httptest.NewRecorder()
	handler(response, request)
	return response
}
