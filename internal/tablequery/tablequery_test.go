package tablequery

import (
	"errors"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
)

func TestNormalizeTimeBoundSupportsDateInputs(t *testing.T) {
	t.Parallel()
	from, err := NormalizeTimeBound("createdFrom", "2026-08-18", false)
	if err != nil {
		t.Fatalf("normalize lower date: %v", err)
	}
	to, err := NormalizeTimeBound("createdTo", "2026-08-18", true)
	if err != nil {
		t.Fatalf("normalize upper date: %v", err)
	}
	if from != "2026-08-18T00:00:00.000Z" || to != "2026-08-19T00:00:00.000Z" {
		t.Fatalf("date bounds = [%q,%q), want one complete UTC day", from, to)
	}
	timestamp, err := NormalizeTimeBound("createdTo", "2026-08-18T12:34:56+02:00", true)
	if err != nil || timestamp != "2026-08-18T10:34:56.000Z" {
		t.Fatalf("timestamp bound = %q, err=%v", timestamp, err)
	}
}

func TestCursorIsBoundToNormalizedQuery(t *testing.T) {
	t.Parallel()
	fingerprint, err := Fingerprint(map[string]string{"q": "coffee"})
	if err != nil {
		t.Fatalf("fingerprint: %v", err)
	}
	cursor, err := EncodeCursor(fingerprint, "createdAt", "desc", "2026-08-18T10:00:00Z", "row-2")
	if err != nil {
		t.Fatalf("encode cursor: %v", err)
	}
	key, id, err := DecodeCursor(cursor, fingerprint, "createdAt", "desc")
	if err != nil || key != "2026-08-18T10:00:00Z" || id != "row-2" {
		t.Fatalf("decoded cursor = (%q,%q,%v)", key, id, err)
	}
	_, _, err = DecodeCursor(cursor, fingerprint, "amount", "desc")
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("mismatched cursor error = %v, want validation", err)
	}
}

func TestLikePatternEscapesWildcards(t *testing.T) {
	t.Parallel()
	if got := LikePattern(`50%_off\today`); got != `%50\%\_off\\today%` {
		t.Fatalf("escaped pattern = %q", got)
	}
}

func TestSQLOrderFragmentsNeverReflectInput(t *testing.T) {
	t.Parallel()
	tests := []struct {
		direction  string
		keyword    string
		comparison string
	}{
		{direction: "asc", keyword: "ASC", comparison: ">"},
		{direction: "desc", keyword: "DESC", comparison: "<"},
		{direction: "desc; DROP TABLE users;--", keyword: "ASC", comparison: ">"},
	}
	for _, test := range tests {
		keyword, comparison := SQLOrderFragments(test.direction)
		if keyword != test.keyword || comparison != test.comparison {
			t.Fatalf("SQLOrderFragments(%q) = (%q,%q), want (%q,%q)", test.direction, keyword, comparison, test.keyword, test.comparison)
		}
	}
}

func TestAuditSortExpressionNeverReflectsInput(t *testing.T) {
	t.Parallel()
	if got := AuditSortExpression("actorName"); got != "lower(coalesce(actor.display_name,''))" {
		t.Fatalf("actorName expression = %q", got)
	}
	if got := AuditSortExpression("occurredAt DESC; DROP TABLE audit_events;--"); got != AuditOccurredSQLExpression {
		t.Fatalf("unexpected audit sort expression = %q", got)
	}
}

func TestNormalizeSortRejectsSQLFragments(t *testing.T) {
	t.Parallel()
	allowed := map[string]struct{}{"createdAt": {}, "amount": {}}
	tests := []struct {
		name      string
		sort      string
		direction string
	}{
		{name: "sort expression", sort: "amount DESC; DROP TABLE bookings;--", direction: "asc"},
		{name: "direction expression", sort: "amount", direction: "desc; DROP TABLE bookings;--"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, _, err := NormalizeSort(test.sort, test.direction, "createdAt", "desc", allowed)
			if !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("NormalizeSort(%q,%q) error = %v, want validation", test.sort, test.direction, err)
			}
		})
	}
}
