package platform

import "testing"

func TestNormalizeEmail(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
		want  string
		valid bool
	}{
		{name: "normalizes case and whitespace", input: " Member@Example.test ", want: "member@example.test", valid: true},
		{name: "accepts plus addressing", input: "member+import@example.test", want: "member+import@example.test", valid: true},
		{name: "rejects display-name form", input: "Member <member@example.test>", valid: false},
		{name: "rejects missing domain", input: "member@", valid: false},
		{name: "rejects multiple separators", input: "member@@example.test", valid: false},
		{name: "rejects header injection", input: "member@example.test\r\nBcc: other@example.test", valid: false},
		{name: "rejects unsupported SMTPUTF8 address", input: "mémber@example.test", valid: false},
		{name: "rejects empty input", input: " ", valid: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got, err := NormalizeEmail(test.input)
			if test.valid && err != nil {
				t.Fatalf("NormalizeEmail(%q): %v", test.input, err)
			}
			if !test.valid && err == nil {
				t.Fatalf("NormalizeEmail(%q) unexpectedly succeeded with %q", test.input, got)
			}
			if got != test.want {
				t.Fatalf("NormalizeEmail(%q) = %q, want %q", test.input, got, test.want)
			}
		})
	}
}
