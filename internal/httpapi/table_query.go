package httpapi

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/tablequery"
)

// optionalInt64Query parses one optional exact base-10 integer query value.
// Empty values are absent; malformed values produce transport-safe validation.
func optionalInt64Query(request *http.Request, name string) (*int64, error) {
	value := strings.TrimSpace(request.URL.Query().Get(name))
	if value == "" {
		return nil, nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return nil, domain.ValidationError{Field: name, Message: "must be a base-10 integer"}
	}
	return &parsed, nil
}

// auditTableQuery maps the common audit query-string contract without applying
// authorization or semantic validation; the owning service performs both
// normalization and cursor binding.
func auditTableQuery(request *http.Request) tablequery.AuditQuery {
	values := request.URL.Query()
	return tablequery.AuditQuery{
		Search: values.Get("q"), ActorUserID: values.Get("actorUserId"),
		ActorMembershipID: values.Get("actorMembershipId"), Actions: values["action"],
		ResourceTypes: values["resourceType"], OccurredFrom: values.Get("occurredFrom"),
		OccurredTo: values.Get("occurredTo"), Sort: values.Get("sort"),
		Direction: values.Get("direction"), Cursor: values.Get("cursor"), Limit: queryLimit(request),
	}
}

// writeTablePageHeaders publishes backward-compatible page metadata while the
// response body remains the endpoint's existing JSON shape.
func writeTablePageHeaders(response http.ResponseWriter, nextCursor string, limit int) {
	hasMore := nextCursor != ""
	response.Header().Set("X-Has-More", strconv.FormatBool(hasMore))
	response.Header().Set("X-Page-Limit", strconv.Itoa(limit))
	if hasMore {
		response.Header().Set("X-Next-Cursor", nextCursor)
	}
}
