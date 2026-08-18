// Package tablequery provides shared validation and opaque keyset cursor
// primitives for server-side table queries.
package tablequery

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/domain"
)

const maxCursorLength = 2048

// AuditQuery describes the common server-side query contract shared by group
// and instance audit tables. ActorMembershipID is supported only for group
// audit because system events have no tenant membership actor column.
type AuditQuery struct {
	Search            string
	ActorUserID       string
	ActorMembershipID string
	Actions           []string
	ResourceTypes     []string
	OccurredFrom      string
	OccurredTo        string
	Sort              string
	Direction         string
	Cursor            string
	Limit             int
}

var auditSorts = map[string]struct{}{
	"occurredAt": {}, "actorName": {}, "action": {}, "resourceType": {},
}

// NormalizeAudit validates the common audit query, applies stable defaults,
// and returns a fingerprint bound to scope. Scope must identify the authorized
// tenant or the global system table without including secrets.
func NormalizeAudit(input AuditQuery, scope string, allowActorMembership bool) (AuditQuery, string, error) {
	var err error
	input.Search, err = NormalizeSearch(input.Search)
	if err != nil {
		return AuditQuery{}, "", err
	}
	input.Sort, input.Direction, err = NormalizeSort(input.Sort, input.Direction, "occurredAt", "desc", auditSorts)
	if err != nil {
		return AuditQuery{}, "", err
	}
	input.OccurredFrom, err = NormalizeTimeBound("occurredFrom", input.OccurredFrom, false)
	if err != nil {
		return AuditQuery{}, "", err
	}
	input.OccurredTo, err = NormalizeTimeBound("occurredTo", input.OccurredTo, true)
	if err != nil {
		return AuditQuery{}, "", err
	}
	if input.OccurredFrom != "" && input.OccurredTo != "" && input.OccurredFrom >= input.OccurredTo {
		return AuditQuery{}, "", domain.ValidationError{Field: "occurredTo", Message: "must be later than occurredFrom"}
	}
	input.ActorUserID = strings.TrimSpace(input.ActorUserID)
	input.ActorMembershipID = strings.TrimSpace(input.ActorMembershipID)
	input.Actions, err = normalizeStringSet("action", input.Actions)
	if err != nil {
		return AuditQuery{}, "", err
	}
	input.ResourceTypes, err = normalizeStringSet("resourceType", input.ResourceTypes)
	if err != nil {
		return AuditQuery{}, "", err
	}
	if !allowActorMembership && input.ActorMembershipID != "" {
		return AuditQuery{}, "", domain.ValidationError{Field: "actorMembershipId", Message: "is not supported for system audit"}
	}
	for field, value := range map[string]string{
		"actorUserId": input.ActorUserID, "actorMembershipId": input.ActorMembershipID,
	} {
		if len(value) > 200 {
			return AuditQuery{}, "", domain.ValidationError{Field: field, Message: "must contain at most 200 characters"}
		}
	}
	if input.Limit < 1 || input.Limit > 200 {
		input.Limit = 100
	}
	fingerprint, err := Fingerprint(struct {
		Scope string
		AuditQuery
	}{Scope: scope, AuditQuery: AuditQuery{
		Search: input.Search, ActorUserID: input.ActorUserID, ActorMembershipID: input.ActorMembershipID,
		Actions: input.Actions, ResourceTypes: input.ResourceTypes, OccurredFrom: input.OccurredFrom,
		OccurredTo: input.OccurredTo, Sort: input.Sort, Direction: input.Direction,
	}})
	if err != nil {
		return AuditQuery{}, "", err
	}
	return input, fingerprint, nil
}

// normalizeStringSet trims, validates, deduplicates, and sorts repeated exact
// filter values so equivalent URL orders share one cursor fingerprint.
func normalizeStringSet(field string, values []string) ([]string, error) {
	unique := make(map[string]struct{}, len(values))
	for _, rawValue := range values {
		value := strings.TrimSpace(rawValue)
		if value == "" {
			continue
		}
		if len(value) > 200 {
			return nil, domain.ValidationError{Field: field, Message: "must contain values of at most 200 characters"}
		}
		unique[value] = struct{}{}
	}
	if len(unique) > 100 {
		return nil, domain.ValidationError{Field: field, Message: "must contain at most 100 values"}
	}
	result := make([]string, 0, len(unique))
	for value := range unique {
		result = append(result, value)
	}
	slices.Sort(result)
	return result, nil
}

// AppendExactStringSet appends an IN predicate and its bound values for a
// normalized repeated filter. Column must be a trusted, static SQL expression;
// user-provided values are always returned as bind arguments.
func AppendExactStringSet(query string, args []any, column string, values []string) (string, []any) {
	if len(values) == 0 {
		return query, args
	}
	query += " AND " + column + " IN (" + strings.TrimSuffix(strings.Repeat("?,", len(values)), ",") + ")"
	for _, value := range values {
		args = append(args, value)
	}
	return query, args
}

type cursorPayload struct {
	Version     int    `json:"v"`
	Fingerprint string `json:"f"`
	Sort        string `json:"s"`
	Direction   string `json:"d"`
	Key         string `json:"k"`
	ID          string `json:"i"`
}

// NormalizeSearch trims a global search term and enforces a bounded query size.
// Empty input remains empty. The returned error is safe for an API validation
// response.
func NormalizeSearch(value string) (string, error) {
	value = strings.TrimSpace(value)
	if len(value) > 200 {
		return "", domain.ValidationError{Field: "q", Message: "must contain at most 200 characters"}
	}
	return value, nil
}

// NormalizeSort validates a requested sort key and direction. Empty values use
// the supplied defaults; direction is returned as lowercase "asc" or "desc".
func NormalizeSort(sort, direction, defaultSort, defaultDirection string, allowed map[string]struct{}) (string, string, error) {
	sort = strings.TrimSpace(sort)
	if sort == "" {
		sort = defaultSort
	}
	if _, ok := allowed[sort]; !ok {
		return "", "", domain.ValidationError{Field: "sort", Message: fmt.Sprintf("contains unsupported value %q", sort)}
	}
	direction = strings.ToLower(strings.TrimSpace(direction))
	if direction == "" {
		direction = defaultDirection
	}
	if direction != "asc" && direction != "desc" {
		return "", "", domain.ValidationError{Field: "direction", Message: "must be asc or desc"}
	}
	return sort, direction, nil
}

// NormalizeTimeBound validates an optional RFC 3339 timestamp or ISO 8601 date
// and converts it to the canonical UTC representation used by TeamTaler
// storage. A date-only lower bound means 00:00 UTC on that date. A date-only
// upper bound advances to 00:00 UTC on the following date so the selected day
// is included while SQL can retain an exclusive upper comparison.
func NormalizeTimeBound(field, value string, upper bool) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		parsed, err = time.Parse("2006-01-02", value)
		if err == nil && upper {
			parsed = parsed.AddDate(0, 0, 1)
		}
	}
	if err != nil {
		return "", domain.ValidationError{Field: field, Message: "must be an ISO 8601 date or RFC 3339 timestamp"}
	}
	return parsed.UTC().Format("2006-01-02T15:04:05.000Z"), nil
}

// LikePattern escapes SQL LIKE metacharacters and returns a contains pattern.
// The result is safe only when bound as a query argument with ESCAPE '\\'.
func LikePattern(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + replacer.Replace(value) + "%"
}

// Fingerprint returns a stable digest for a JSON-serializable normalized query.
// It binds continuation cursors to the filters and ordering that created them.
func Fingerprint(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("encode table query fingerprint: %w", err)
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

// EncodeCursor serializes the last row's stable sort tuple into an opaque URL-
// safe continuation cursor. Clients must persist and return it unchanged.
func EncodeCursor(fingerprint, sort, direction, key, id string) (string, error) {
	payload := cursorPayload{Version: 1, Fingerprint: fingerprint, Sort: sort, Direction: direction, Key: key, ID: id}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("encode table query cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(encoded), nil
}

// DecodeCursor validates and decodes a cursor for the exact normalized query.
// Malformed, oversized, mismatched, or incomplete cursors are rejected as
// client validation errors without exposing storage details.
func DecodeCursor(value, fingerprint, sort, direction string) (key, id string, err error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", "", nil
	}
	if len(value) > maxCursorLength {
		return "", "", invalidCursor()
	}
	encoded, decodeErr := base64.RawURLEncoding.DecodeString(value)
	if decodeErr != nil {
		return "", "", invalidCursor()
	}
	var payload cursorPayload
	if err := json.Unmarshal(encoded, &payload); err != nil {
		return "", "", invalidCursor()
	}
	if payload.Version != 1 || payload.Fingerprint != fingerprint || payload.Sort != sort || payload.Direction != direction || payload.Key == "" || payload.ID == "" || len(payload.Key) > 1000 || len(payload.ID) > 200 {
		return "", "", invalidCursor()
	}
	return payload.Key, payload.ID, nil
}

func invalidCursor() error {
	return domain.ValidationError{Field: "cursor", Message: "is invalid or does not match the current query"}
}
