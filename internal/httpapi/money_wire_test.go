package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/bookings"
	"github.com/DasLukas/TeamTaler/internal/catalog"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/finance"
)

func TestResponseMinorUnitsUseExactDecimalStrings(t *testing.T) {
	const exact int64 = 9_007_199_254_740_993
	exactProductPrice := exact
	groupOutstanding := exact
	payload := struct {
		Product   domain.Product    `json:"product"`
		Booking   domain.Booking    `json:"booking"`
		Payment   domain.Payment    `json:"payment"`
		Statement domain.Statement  `json:"statement"`
		Dashboard finance.Dashboard `json:"dashboard"`
	}{
		Product: domain.Product{PriceMinor: &exactProductPrice},
		Booking: domain.Booking{UnitPriceMinor: exact, TotalMinor: exact},
		Payment: domain.Payment{AmountMinor: exact, Allocations: []domain.PaymentAllocation{{AmountMinor: exact}}},
		Statement: domain.Statement{
			ChargesMinor: exact, PaymentsAllocatedMinor: exact, AdjustmentsAppliedMinor: exact,
			AdjustmentsProvidedMinor: exact, AmountDueMinor: exact,
		},
		Dashboard: finance.Dashboard{
			Account: finance.Account{
				BalanceMinor: exact, OpenPeriodDue: exact,
				CategoryStats:      []finance.CategoryStatistic{{GrossMinor: exact, VoidedMinor: exact, NetMinor: exact}},
				GroupCategoryStats: []finance.CategoryStatistic{{GrossMinor: exact, VoidedMinor: exact, NetMinor: exact}},
				RecentEntries:      []finance.LedgerEntry{{AmountMinor: exact}},
			},
			GroupOutstanding: &groupOutstanding,
		},
	}

	handler := http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		writeJSON(response, http.StatusOK, payload)
	})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/groups/grp_test/dashboard", nil))
	response := recorder.Result()
	defer response.Body.Close()
	var decoded any
	decoder := json.NewDecoder(response.Body)
	decoder.UseNumber()
	if err := decoder.Decode(&decoded); err != nil {
		t.Fatalf("decode money response: %v", err)
	}
	assertMinorUnitStrings(t, decoded, exact)
}

func TestMoneyCommandsContinueToAcceptIntegerMinorUnits(t *testing.T) {
	var product catalog.CreateProductInput
	if err := json.Unmarshal([]byte(`{"name":"Water","priceMinor":125,"sortOrder":0}`), &product); err != nil || product.PriceMinor == nil || *product.PriceMinor != 125 {
		t.Fatalf("decode product command: price=%v err=%v", product.PriceMinor, err)
	}
	var booking bookings.CreateInput
	if err := json.Unmarshal([]byte(`{"productId":"product-test","productVersion":1,"expectedPeriodId":"period-test","quantity":2,"unitPriceMinor":175}`), &booking); err != nil || booking.UnitPriceMinor == nil || *booking.UnitPriceMinor != 175 {
		t.Fatalf("decode booking command: unit price=%v err=%v", booking.UnitPriceMinor, err)
	}
	var payment finance.CreatePaymentInput
	if err := json.Unmarshal([]byte(`{"membershipId":"mem_test","amountMinor":125,"method":"CASH"}`), &payment); err != nil || payment.AmountMinor != 125 {
		t.Fatalf("decode payment command: amount=%d err=%v", payment.AmountMinor, err)
	}
}

func assertMinorUnitStrings(t *testing.T, value any, expected int64) {
	t.Helper()
	switch item := value.(type) {
	case map[string]any:
		for key, nested := range item {
			if strings.HasSuffix(key, "Minor") {
				encoded, ok := nested.(string)
				if !ok {
					t.Fatalf("%s used %T instead of a decimal string", key, nested)
				}
				if encoded != "0" && encoded != "9007199254740993" {
					t.Fatalf("%s = %q, want zero or %d", key, encoded, expected)
				}
			}
			assertMinorUnitStrings(t, nested, expected)
		}
	case []any:
		for _, nested := range item {
			assertMinorUnitStrings(t, nested, expected)
		}
	}
}
