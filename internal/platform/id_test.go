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
