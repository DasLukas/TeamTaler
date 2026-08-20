package notifications

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestCreateTxAppliesGroupMemberAndIndependentSystemChannelGates(t *testing.T) {
	ctx := context.Background()
	db, membership := openNotificationPolicyFixture(t)
	defer db.Close()
	const now = "2026-08-20T08:00:00Z"
	for _, seed := range []struct {
		statement string
		arguments []any
	}{
		{`INSERT INTO membership_notification_channels(group_id,membership_id,event_type,channel,enabled_at,updated_at) VALUES('group-policy','member-policy','BOOKING_ASSIGNED','EMAIL',?,?)`, []any{now, now}},
		{`INSERT INTO membership_notification_channels(group_id,membership_id,event_type,channel,enabled_at,updated_at) VALUES('group-policy','member-policy','BOOKING_ASSIGNED','PUSH',?,?)`, []any{now, now}},
		{`INSERT INTO web_push_subscriptions(id,user_id,endpoint_hash,encrypted_subscription,vapid_key_id,device_label,created_at,updated_at,last_used_at) VALUES('push-one','user-policy','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sealed','current-key-id-1234','Browser',?,?,?)`, []any{now, now, now}},
	} {
		if _, err := db.ExecContext(ctx, seed.statement, seed.arguments...); err != nil {
			t.Fatalf("seed notification channel: %v", err)
		}
	}
	availability := ChannelAvailability{EmailAvailable: true, PushAvailable: true, PushKeyID: "current-key-id-1234"}
	service := Service{DB: db, ResolveChannelAvailability: func(context.Context, *sql.Tx) (ChannelAvailability, error) { return availability, nil }}
	create := func(resourceID, createdAt string, rollback bool) Notification {
		t.Helper()
		var notification Notification
		err := storage.WithTx(ctx, db, func(tx *sql.Tx) error {
			var err error
			notification, err = service.CreateTx(ctx, tx, CreateInput{
				GroupID: membership.GroupID, MembershipID: membership.ID, Type: TypeBookingAssigned,
				Title: "Booking assigned", Body: "A booking was assigned.", ResourceType: "booking", ResourceID: resourceID,
				CreatedAt: createdAt, Context: EventContext{AmountMinor: 100, Currency: "EUR"},
			})
			if err != nil {
				return err
			}
			if rollback {
				return errors.New("force rollback")
			}
			return nil
		})
		if rollback {
			if err == nil {
				t.Fatal("forced rollback unexpectedly committed")
			}
		} else if err != nil {
			t.Fatalf("create notification: %v", err)
		}
		return notification
	}

	first := create("booking-both", now, false)
	assertDeliveryChannels(t, db, first.ID, []Channel{ChannelEmail, ChannelPush})

	availability.EmailAvailable = false
	second := create("booking-push", "2026-08-20T08:01:00Z", false)
	assertDeliveryChannels(t, db, second.ID, []Channel{ChannelPush})

	rolledBack := create("booking-rollback", "2026-08-20T08:02:00Z", true)
	var rolledBackRows int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM notifications WHERE id=?`, rolledBack.ID).Scan(&rolledBackRows); err != nil || rolledBackRows != 0 {
		t.Fatalf("rolled-back notification rows=%d err=%v", rolledBackRows, err)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM group_notification_events WHERE group_id=? AND event_type='BOOKING_ASSIGNED'`, membership.GroupID); err != nil {
		t.Fatalf("disable group event: %v", err)
	}
	disabled := create("booking-disabled", "2026-08-20T08:03:00Z", false)
	if disabled.ID != "" {
		t.Fatalf("disabled group event created notification %q", disabled.ID)
	}
}

func TestNotificationPolicyVersioningAndPreferenceRetention(t *testing.T) {
	ctx := context.Background()
	db, membership := openNotificationPolicyFixture(t)
	defer db.Close()
	service := Service{DB: db, EmailDeliveryAvailable: true, PushDeliveryAvailable: true}
	actor := domain.Principal{UserID: membership.UserID}
	settings, err := service.GetGroupSettings(ctx, membership)
	if err != nil || settings.Version != 1 || len(settings.Events) != 7 {
		t.Fatalf("initial group settings=%#v err=%v", settings, err)
	}
	updates := make([]GroupEventUpdate, 0, len(settings.Events))
	for _, event := range settings.Events {
		updates = append(updates, GroupEventUpdate{Type: event.Type, Enabled: true})
	}
	settings, err = service.UpdateGroupSettings(ctx, actor, membership, GroupSettingsUpdate{
		Timezone: "Europe/Berlin", DueSoonLeadDays: 3, OverdueRepeatDays: 7, Events: updates,
	}, settings.Version)
	if err != nil || settings.Version != 2 {
		t.Fatalf("updated group settings=%#v err=%v", settings, err)
	}
	if _, err := service.UpdateGroupSettings(ctx, actor, membership, GroupSettingsUpdate{
		Timezone: "Europe/Berlin", DueSoonLeadDays: 3, OverdueRepeatDays: 7, Events: updates,
	}, 1); !errors.Is(err, domain.ErrPrecondition) {
		t.Fatalf("stale group policy error=%v, want precondition", err)
	}
	preferences, err := service.GetPreferences(ctx, membership)
	if err != nil || preferences.Version != 1 || len(preferences.AvailableChannels) != 2 {
		t.Fatalf("initial preferences=%#v err=%v", preferences, err)
	}
	email, push := true, true
	preferences, err = service.UpdatePreferences(ctx, membership, PreferencesUpdate{Events: []PreferenceUpdate{{Type: TypeSettlementOverdue, Email: &email, Push: &push}}}, preferences.Version)
	if err != nil || preferences.Version != 2 {
		t.Fatalf("updated preferences=%#v err=%v", preferences, err)
	}
	for index := range updates {
		if updates[index].Type == TypeSettlementOverdue {
			updates[index].Enabled = false
		}
	}
	settings, err = service.UpdateGroupSettings(ctx, actor, membership, GroupSettingsUpdate{
		Timezone: "Europe/Berlin", DueSoonLeadDays: 3, OverdueRepeatDays: 7, Events: updates,
	}, settings.Version)
	if err != nil {
		t.Fatalf("disable overdue event: %v", err)
	}
	preferences, err = service.GetPreferences(ctx, membership)
	if err != nil {
		t.Fatalf("read retained preferences: %v", err)
	}
	var overdue EventPreference
	for _, event := range preferences.Events {
		if event.Type == TypeSettlementOverdue {
			overdue = event
		}
	}
	if overdue.Enabled || !overdue.Email || !overdue.Push {
		t.Fatalf("retained disabled event preferences=%#v", overdue)
	}
	disable := false
	if _, err := service.UpdatePreferences(ctx, membership, PreferencesUpdate{Events: []PreferenceUpdate{{Type: TypeSettlementOverdue, Email: &disable}}}, preferences.Version); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("disabled group event preference error=%v, want validation", err)
	}
}

func openNotificationPolicyFixture(t *testing.T) (*sql.DB, domain.Membership) {
	t.Helper()
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "notification-policy.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	const now = "2026-08-20T08:00:00Z"
	for _, seed := range []struct {
		statement string
		arguments []any
	}{
		{`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-policy','member@example.test','Member','hash',?,?)`, []any{now, now}},
		{`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-policy','Policy group','EUR',?,?)`, []any{now, now}},
		{`INSERT INTO memberships(id,group_id,user_id,joined_at) VALUES('member-policy','group-policy','user-policy',?)`, []any{now}},
		{`INSERT INTO group_settings(group_id,members_can_view_all_bookings,notification_emails_enabled,updated_at) VALUES('group-policy',0,0,?)`, []any{now}},
	} {
		if _, err := db.ExecContext(ctx, seed.statement, seed.arguments...); err != nil {
			db.Close()
			t.Fatalf("seed policy fixture: %v", err)
		}
	}
	err = storage.WithTx(ctx, db, func(tx *sql.Tx) error {
		return authorization.SeedGroupRoles(ctx, tx, "group-policy", "user-policy", "member-policy", time.Date(2026, time.August, 20, 8, 0, 0, 0, time.UTC))
	})
	if err != nil {
		db.Close()
		t.Fatalf("seed group administrator: %v", err)
	}
	return db, domain.Membership{ID: "member-policy", GroupID: "group-policy", UserID: "user-policy", Status: "ACTIVE"}
}

func assertDeliveryChannels(t *testing.T, db *sql.DB, notificationID string, want []Channel) {
	t.Helper()
	rows, err := db.Query(`SELECT channel FROM notification_delivery_jobs WHERE notification_id=? ORDER BY channel`, notificationID)
	if err != nil {
		t.Fatalf("read delivery channels: %v", err)
	}
	defer rows.Close()
	got := make([]Channel, 0)
	for rows.Next() {
		var channel Channel
		if err := rows.Scan(&channel); err != nil {
			t.Fatalf("scan delivery channel: %v", err)
		}
		got = append(got, channel)
	}
	if len(got) != len(want) {
		t.Fatalf("delivery channels=%v, want %v", got, want)
	}
	for index := range got {
		if got[index] != want[index] {
			t.Fatalf("delivery channels=%v, want %v", got, want)
		}
	}
}
