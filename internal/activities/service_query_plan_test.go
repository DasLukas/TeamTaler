package activities

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestUnifiedActivityChronologyUsesTenantScopedSourceIndexes(t *testing.T) {
	db, err := storage.Open(context.Background(), filepath.Join(t.TempDir(), "activity-query-plan.db"))
	if err != nil {
		t.Fatalf("open activity query-plan database: %v", err)
	}
	defer db.Close()

	query, args := visibleActivityCTE(domain.Membership{ID: "member-plan", GroupID: "group-plan"}, permissions{
		viewAllBookings: true,
		manageFinance:   true,
	})
	query += ` SELECT activity.* FROM activity
		ORDER BY ` + activityOccurredExpression + ` DESC,activity.id DESC LIMIT ?`
	args = append(args, 101)
	rows, err := db.QueryContext(context.Background(), "EXPLAIN QUERY PLAN "+query, args...)
	if err != nil {
		t.Fatalf("explain unified activity chronology: %v", err)
	}
	defer rows.Close()
	details := make([]string, 0)
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatalf("scan unified activity query plan: %v", err)
		}
		details = append(details, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate unified activity query plan: %v", err)
	}
	plan := strings.Join(details, "\n")
	for _, sourceSearch := range []string{"SEARCH b USING INDEX", "SEARCH p USING INDEX", "SEARCH entry USING INDEX"} {
		if !strings.Contains(plan, sourceSearch) {
			t.Fatalf("unified activity query plan does not contain %q:\n%s", sourceSearch, plan)
		}
	}
}
