package platform

import "testing"

func TestIsCurrencyCode(t *testing.T) {
	for _, value := range []string{"EUR", "USD", "GBP"} {
		if !IsCurrencyCode(value) {
			t.Fatalf("valid currency %q was rejected", value)
		}
	}
	for _, value := range []string{"", "EU", "EURO", "EU1", "eur", "€UR", "!!!"} {
		if IsCurrencyCode(value) {
			t.Fatalf("invalid currency %q was accepted", value)
		}
	}
}

func TestCurrencyExponent(t *testing.T) {
	tests := map[string]uint8{"EUR": 2, "JPY": 0, "KWD": 3, "CLF": 4, "ZZZ": 2, "jpy": 0}
	for currency, want := range tests {
		if got := CurrencyExponent(currency); got != want {
			t.Fatalf("CurrencyExponent(%q) = %d, want %d", currency, got, want)
		}
	}
}
