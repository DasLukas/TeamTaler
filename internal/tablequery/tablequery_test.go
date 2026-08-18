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
