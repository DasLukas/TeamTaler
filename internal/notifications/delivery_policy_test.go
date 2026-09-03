package notifications

import (
	"context"
	"testing"
)

func TestCheckDeliveryPolicyReevaluatesPlanningAndMemberGates(t *testing.T) {
	ctx := context.Background()
	db, membership := openNotificationPolicyFixture(t)
	defer db.Close()
	const now = "2026-08-30T12:00:00Z"
	for _, statement := range []string{
		`UPDATE group_planning_settings SET enabled=1,updated_at='2026-08-30T12:00:00Z' WHERE group_id='group-policy'`,
		`INSERT INTO membership_notification_channels(group_id,membership_id,event_type,channel,enabled_at,updated_at)
		 VALUES('group-policy','member-policy','PLANNING_EVENT_PUBLISHED','EMAIL','2026-08-30T12:00:00Z','2026-08-30T12:00:00Z')`,
		`INSERT INTO notifications(id,group_id,membership_id,type,title,body,context_json,created_at)
		 VALUES('notice-planning-policy','group-policy','member-policy','PLANNING_EVENT_PUBLISHED','Planning','Planning body','{}','2026-08-30T12:00:00Z')`,
		`INSERT INTO notification_delivery_jobs(id,notification_id,group_id,channel,target_membership_id,status,attempt_count,next_attempt_at,created_at,updated_at)
		 VALUES('job-planning-policy','notice-planning-policy','group-policy','EMAIL','member-policy','PENDING',0,'2026-08-30T12:00:00Z','2026-08-30T12:00:00Z','2026-08-30T12:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed delivery policy: %v", err)
		}
	}
	if code, err := CheckDeliveryPolicy(ctx, db, "job-planning-policy", ChannelEmail); err != nil || code != "" {
		t.Fatalf("enabled delivery policy code=%q err=%v", code, err)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM membership_notification_channels WHERE membership_id=? AND event_type='PLANNING_EVENT_PUBLISHED' AND channel='EMAIL'`, membership.ID); err != nil {
		t.Fatalf("disable member preference: %v", err)
	}
	if code, err := CheckDeliveryPolicy(ctx, db, "job-planning-policy", ChannelEmail); err != nil || code != DeliveryCodePreferenceDisabled {
		t.Fatalf("preference-disabled code=%q err=%v", code, err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO membership_notification_channels(group_id,membership_id,event_type,channel,enabled_at,updated_at) VALUES(?,?,?,?,?,?)`, membership.GroupID, membership.ID, TypePlanningEventPublished, ChannelEmail, now, now); err != nil {
		t.Fatalf("restore member preference: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE group_planning_settings SET enabled=0,updated_at=? WHERE group_id=?`, now, membership.GroupID); err != nil {
		t.Fatalf("disable planning module: %v", err)
	}
	if code, err := CheckDeliveryPolicy(ctx, db, "job-planning-policy", ChannelEmail); err != nil || code != DeliveryCodePlanningDisabled {
		t.Fatalf("planning-disabled code=%q err=%v", code, err)
	}
}
