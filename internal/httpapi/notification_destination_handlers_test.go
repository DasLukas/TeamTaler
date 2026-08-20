package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/notifications"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestResolveNotificationDestinationProtectsAccountAndMembershipScope(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "notification-destination.db"))
	if err != nil {
		t.Fatalf("open notification destination database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	const now = "2026-08-20T12:00:00Z"
	for _, statement := range []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('usr_owner','owner@example.test','Owner','hash','` + now + `','` + now + `')`,
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('usr_other','other@example.test','Other','hash','` + now + `','` + now + `')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('grp_active','Active Group','EUR','` + now + `','` + now + `')`,
		`INSERT INTO memberships(id,group_id,user_id,joined_at) VALUES('mem_owner','grp_active','usr_owner','` + now + `')`,
		`INSERT INTO memberships(id,group_id,user_id,joined_at) VALUES('mem_other','grp_active','usr_other','` + now + `')`,
		`INSERT INTO membership_role_assignments(group_id,membership_id,role_id,version,assigned_at) VALUES('grp_active','mem_other','role:GROUP_ADMINISTRATOR:grp_active',1,'` + now + `')`,
		`INSERT INTO notifications(id,group_id,membership_id,type,title,body,context_json,created_at) VALUES('ntf_owner','grp_active','mem_owner','BOOKING_ASSIGNED','Booking activity','A booking was assigned.','{}','` + now + `')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed notification destination database: %v", err)
		}
	}
	server := &Server{notifications: notifications.Service{DB: db}}

	request := authenticatedJSONRequest(http.MethodGet, "/api/v1/me/notifications/ntf_owner/destination", "", domain.Principal{UserID: "usr_owner"})
	request.SetPathValue("notificationID", "ntf_owner")
	response := httptest.NewRecorder()
	server.handleResolveNotificationDestination(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("resolve own notification status=%d body=%s", response.Code, response.Body.String())
	}
	var destination notifications.Destination
	if err := json.Unmarshal(response.Body.Bytes(), &destination); err != nil || destination.GroupID != "grp_active" {
		t.Fatalf("notification destination=%#v err=%v", destination, err)
	}

	for name, principal := range map[string]domain.Principal{
		"cross account": {UserID: "usr_other"},
		"anonymous":     {},
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/v1/me/notifications/ntf_owner/destination", nil)
			if principal.UserID != "" {
				request = authenticatedJSONRequest(http.MethodGet, request.URL.Path, "", principal)
			}
			request.SetPathValue("notificationID", "ntf_owner")
			response := httptest.NewRecorder()
			server.handleResolveNotificationDestination(response, request)
			want := http.StatusNotFound
			if principal.UserID == "" {
				want = http.StatusUnauthorized
			}
			if response.Code != want {
				t.Fatalf("status=%d body=%s, want %d", response.Code, response.Body.String(), want)
			}
		})
	}

	if _, err := db.ExecContext(ctx, `UPDATE memberships SET status='ARCHIVED',archived_at=? WHERE id='mem_owner'`, now); err != nil {
		t.Fatalf("archive notification membership: %v", err)
	}
	archived := authenticatedJSONRequest(http.MethodGet, "/api/v1/me/notifications/ntf_owner/destination", "", domain.Principal{UserID: "usr_owner"})
	archived.SetPathValue("notificationID", "ntf_owner")
	archivedResponse := httptest.NewRecorder()
	server.handleResolveNotificationDestination(archivedResponse, archived)
	if archivedResponse.Code != http.StatusNotFound {
		t.Fatalf("archived membership status=%d body=%s, want 404", archivedResponse.Code, archivedResponse.Body.String())
	}
}
