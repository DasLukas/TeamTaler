package system

import (
	"context"
	"errors"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/tablequery"
)

func TestQueryAuditFiltersSortsAndPaginates(t *testing.T) {
	t.Parallel()
	db, service := openSystemService(t)
	defer db.Close()
	insertSystemTestUser(t, db, "system-actor-a", "actor-a@example.test", true)
	insertSystemTestUser(t, db, "system-actor-b", "actor-b@example.test", true)
	statements := []struct {
		id, actor, action, resourceType, resourceID, metadata, occurredAt string
	}{
		{"sya_query_1", "system-actor-a", "system.group.created", "group", "grp_a", `{"name":"Alpine"}`, "2026-08-17T10:00:00Z"},
		{"sya_query_2", "system-actor-b", "system.group.archived", "group", "grp_b", `{"name":"Beta"}`, "2026-08-18T10:00:00Z"},
		{"sya_query_3", "system-actor-a", "system.settings.updated", "system_settings", "singleton", `{"key":"maintenance"}`, "2026-08-18T11:00:00Z"},
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(context.Background(), `INSERT INTO system_audit_events(id,actor_user_id,action,resource_type,resource_id,metadata_json,occurred_at) VALUES(?,?,?,?,?,?,?)`,
			statement.id, statement.actor, statement.action, statement.resourceType, statement.resourceID, statement.metadata, statement.occurredAt); err != nil {
			t.Fatalf("insert system audit event %s: %v", statement.id, err)
		}
	}

	first, err := service.QueryAudit(context.Background(), tablequery.AuditQuery{
		Search: "group", ResourceType: "group", OccurredFrom: "2026-08-17", OccurredTo: "2026-08-18",
		Sort: "occurredAt", Direction: "asc", Limit: 1,
	})
	if err != nil || len(first.Items) != 1 || first.Items[0].ID != "sya_query_1" || first.NextCursor == "" {
		t.Fatalf("first audit page=%#v err=%v", first, err)
	}
	second, err := service.QueryAudit(context.Background(), tablequery.AuditQuery{
		Search: "group", ResourceType: "group", OccurredFrom: "2026-08-17", OccurredTo: "2026-08-18",
		Sort: "occurredAt", Direction: "asc", Limit: 1, Cursor: first.NextCursor,
	})
	if err != nil || len(second.Items) != 1 || second.Items[0].ID != "sya_query_2" || second.NextCursor != "" {
		t.Fatalf("second audit page=%#v err=%v", second, err)
	}
	_, err = service.QueryAudit(context.Background(), tablequery.AuditQuery{
		Search: "settings", Sort: "occurredAt", Direction: "asc", Limit: 1, Cursor: first.NextCursor,
	})
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("mismatched audit cursor error=%v, want validation", err)
	}
}
