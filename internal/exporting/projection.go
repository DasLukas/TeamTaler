package exporting

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type dataset struct {
	name  string
	query string
	args  func(jobRecord) []any
}

type datasetManifest struct {
	Name   string `json:"name"`
	File   string `json:"file"`
	Rows   int64  `json:"rows"`
	SHA256 string `json:"sha256"`
}

type archiveManifest struct {
	FormatVersion string            `json:"formatVersion"`
	Scope         Scope             `json:"scope"`
	GroupID       string            `json:"groupId"`
	RequestedBy   string            `json:"requestedByUserId"`
	ExportedAt    string            `json:"exportedAt"`
	Datasets      []datasetManifest `json:"datasets"`
}

type schemaDocument struct {
	FormatVersion string          `json:"formatVersion"`
	Encoding      string          `json:"encoding"`
	CSV           schemaCSV       `json:"csv"`
	Datasets      []datasetSchema `json:"datasets"`
}

type schemaCSV struct {
	Delimiter string `json:"delimiter"`
	Newline   string `json:"newline"`
}

type datasetSchema struct {
	Name   string        `json:"name"`
	File   string        `json:"file"`
	Fields []schemaField `json:"fields"`
}

type schemaField struct {
	Name   string `json:"name"`
	Format string `json:"format"`
}

func datasetsFor(scope Scope) []dataset {
	if scope == ScopePersonal {
		return personalDatasets
	}
	return groupDatasets
}

func groupArg(record jobRecord) []any { return []any{record.GroupID} }

func personalArg(record jobRecord) []any {
	return []any{record.GroupID, record.MembershipID, record.UserID}
}

var groupDatasets = []dataset{
	{name: "planning_settings", query: `SELECT group_id,enabled,version,updated_at,updated_by_user_id FROM group_planning_settings WHERE group_id=?`, args: groupArg},
	{name: "planning_series_cancelled_ranges", query: `SELECT group_id,series_id,from_sequence,from_original_start_at,created_by_membership_id,created_at FROM planning_series_cancelled_ranges WHERE group_id=? ORDER BY series_id,from_sequence`, args: groupArg},
	{name: "planning_series", query: `SELECT id,group_id,status,timezone,current_revision,materialized_through,version,created_by_membership_id,updated_by_membership_id,published_at,cancelled_at,created_at,updated_at FROM planning_series WHERE group_id=? ORDER BY id`, args: groupArg},
	{name: "planning_series_revisions", query: `SELECT group_id,series_id,revision,effective_from_original_start_at,effective_from_sequence,title,description,location,event_type,audience_type,all_day,start_date,duration_days,starts_at,duration_minutes,response_deadline_minutes_before,capacity,waitlist_enabled,frequency,interval_value,weekdays_json,monthly_mode,range_type,occurrence_count,until_at,created_by_membership_id,created_at FROM planning_series_revisions WHERE group_id=? ORDER BY series_id,revision`, args: groupArg},
	{name: "planning_series_target_roles", query: `SELECT group_id,series_id,revision,role_id FROM planning_series_target_roles WHERE group_id=? ORDER BY series_id,revision,role_id`, args: groupArg},
	{name: "planning_series_target_memberships", query: `SELECT group_id,series_id,revision,membership_id FROM planning_series_target_memberships WHERE group_id=? ORDER BY series_id,revision,membership_id`, args: groupArg},
	{name: "planning_series_recipients", query: `SELECT group_id,series_id,membership_id,first_notified_at,last_synced_at FROM planning_series_recipients WHERE group_id=? ORDER BY series_id,membership_id`, args: groupArg},
	{name: "planning_events", query: `SELECT id,group_id,series_id,series_revision,series_sequence,original_start_at,original_start_date,is_series_exception,title,description,location,event_type,status,audience_type,all_day,timezone,start_date,end_date_exclusive,starts_at,ends_at,response_deadline,response_deadline_minutes_before,capacity,waitlist_enabled,confirmation_revision,version,created_by_membership_id,updated_by_membership_id,published_at,closed_at,completed_at,cancelled_at,created_at,updated_at FROM planning_events WHERE group_id=? ORDER BY starts_at,id`, args: groupArg},
	{name: "planning_event_target_roles", query: `SELECT group_id,event_id,role_id FROM planning_event_target_roles WHERE group_id=? ORDER BY event_id,role_id`, args: groupArg},
	{name: "planning_event_target_memberships", query: `SELECT group_id,event_id,membership_id FROM planning_event_target_memberships WHERE group_id=? ORDER BY event_id,membership_id`, args: groupArg},
	{name: "planning_audience", query: `SELECT group_id,event_id,membership_id,display_name_snapshot,invited_at FROM planning_event_audience WHERE group_id=? ORDER BY event_id,membership_id`, args: groupArg},
	{name: "planning_participations", query: `SELECT group_id,event_id,membership_id,status,waitlist_position,confirmed_revision,version,responded_at,updated_at FROM planning_participations WHERE group_id=? ORDER BY event_id,membership_id`, args: groupArg},
	{name: "planning_notification_tasks", query: `SELECT id,group_id,event_id,target_membership_id,event_type,scheduled_for,event_revision,status,created_at,updated_at FROM planning_notification_tasks WHERE group_id=? ORDER BY scheduled_for,id`, args: groupArg},
	{name: "planning_series_notification_tasks", query: `SELECT id,group_id,series_id,target_membership_id,event_type,series_revision,status,scheduled_for,created_at,updated_at FROM planning_series_notification_tasks WHERE group_id=? ORDER BY scheduled_for,id`, args: groupArg},
	{name: "planning_notification_runs", query: `SELECT id,task_id,group_id,event_id,target_membership_id,event_type,notification_id,processed_at FROM planning_notification_runs WHERE group_id=? ORDER BY processed_at,id`, args: groupArg},
	{name: "group", query: `SELECT id,name,currency,status,version,created_at,updated_at,archived_at,archived_by,archived_from_status,
		CASE WHEN logo_key IS NULL THEN 0 ELSE 1 END AS logo_present FROM groups WHERE id=?`, args: groupArg},
	{name: "group_settings", query: `SELECT group_id,members_can_view_all_bookings,default_role_id,
		foreign_booking_reason_required,own_payment_reason_required,other_payment_reason_required,settlements_enabled,
		own_booking_reason_mode,foreign_booking_reason_mode,own_payment_reason_mode,other_payment_reason_mode,default_theme,
		settlement_due_soon_days,settlement_overdue_repeat_days,statistics_enabled,updated_at
		FROM group_settings WHERE group_id=?`, args: groupArg},
	{name: "payment_methods", query: `SELECT group_id,id,label,sort_order,attachment_mode,payment_target_type,paypal_me_handle,
		sepa_recipient_name,sepa_iban,sepa_bic,created_at FROM group_payment_methods
		WHERE group_id=? ORDER BY sort_order,id`, args: groupArg},
	{name: "reason_suggestions", query: `SELECT group_id,id,kind,label,sort_order,created_at FROM group_reason_suggestions
		WHERE group_id=? ORDER BY kind,sort_order,id`, args: groupArg},
	{name: "memberships", query: `SELECT membership.id,membership.group_id,membership.user_id,user.email,user.display_name,user.active,
		CASE WHEN user.avatar_key IS NULL THEN 0 ELSE 1 END AS avatar_present,membership.status,membership.joined_at,membership.archived_at,
		membership.deleted_at,membership.temporary_guest_name_key,membership.role_assignments_version,membership.theme_override
		FROM memberships membership JOIN users user ON user.id=membership.user_id WHERE membership.group_id=? ORDER BY membership.joined_at,membership.id`, args: groupArg},
	{name: "legacy_membership_roles", query: `SELECT group_id,membership_id,role,granted_at,granted_by
		FROM membership_roles WHERE group_id=? ORDER BY membership_id,role`, args: groupArg},
	{name: "legacy_membership_permissions", query: `SELECT group_id,membership_id,permission,granted_at,granted_by
		FROM membership_permissions WHERE group_id=? ORDER BY membership_id,permission`, args: groupArg},
	{name: "legacy_category_permissions", query: `SELECT group_id,membership_id,category_id,permission,granted_at,granted_by
		FROM category_permissions WHERE group_id=? ORDER BY membership_id,category_id,permission`, args: groupArg},
	{name: "roles", query: `SELECT id,group_id,preset_key,name,description,name_locked,deletable,version,created_at,updated_at,created_by,updated_by
		FROM roles WHERE group_id=? ORDER BY lower(name),id`, args: groupArg},
	{name: "role_permission_grants", query: `SELECT group_id,role_id,permission_key,scope_type,category_id,product_id,version,created_at,updated_at,created_by,updated_by
		FROM role_permission_grants WHERE group_id=? ORDER BY role_id,permission_key,scope_type,category_id,product_id`, args: groupArg},
	{name: "membership_role_assignments", query: `SELECT group_id,membership_id,role_id,version,assigned_at,assigned_by
		FROM membership_role_assignments WHERE group_id=? ORDER BY membership_id,role_id`, args: groupArg},
	{name: "invitations", query: `SELECT id,group_id,email,display_name,expires_at,accepted_at,revoked_at,created_by,created_at,
		category_grants_json,group_permissions_json,role_assignments_version,target_membership_id,target_user_id
		FROM invitations WHERE group_id=? ORDER BY created_at,id`, args: groupArg},
	{name: "invitation_email_delivery", query: `SELECT invitation_id,group_id,status,attempt_count,next_attempt_at,sent_at,last_error_code,created_at,updated_at
		FROM invitation_email_outbox WHERE group_id=? ORDER BY created_at,invitation_id`, args: groupArg},
	{name: "invitation_role_assignments", query: `SELECT group_id,invitation_id,role_id,version,assigned_at,assigned_by
		FROM invitation_role_assignments WHERE group_id=? ORDER BY invitation_id,role_id`, args: groupArg},
	{name: "public_join_link", query: `SELECT group_id,enabled,expires_at,version,created_by,updated_by,created_at,updated_at
		FROM public_join_links WHERE group_id=?`, args: groupArg},
	{name: "public_join_registrations", query: `SELECT id,group_id,join_link_version,email,display_name,expires_at,consumed_at,invalidated_at,created_at
		FROM public_join_registrations WHERE group_id=? ORDER BY created_at,id`, args: groupArg},
	{name: "public_join_email_delivery", query: `SELECT registration_id,group_id,status,attempt_count,next_attempt_at,sent_at,last_error_code,created_at,updated_at
		FROM public_join_email_outbox WHERE group_id=? ORDER BY created_at,registration_id`, args: groupArg},
	{name: "categories", query: `SELECT id,group_id,name,icon,active,sort_order,version,created_at,updated_at
		FROM categories WHERE group_id=? ORDER BY sort_order,id`, args: groupArg},
	{name: "products", query: `SELECT id,group_id,category_id,name,price_minor,(SELECT currency FROM groups WHERE id=products.group_id) AS currency,pricing_mode,
		CASE WHEN image_key IS NULL THEN 0 ELSE 1 END AS image_present,active,deleted_at,sort_order,version,created_at,updated_at
		FROM products WHERE group_id=? ORDER BY category_id,sort_order,id`, args: groupArg},
	{name: "periods", query: `SELECT id,group_id,label,status,starts_at,closed_at,due_at,closed_by,created_at
		FROM periods WHERE group_id=? ORDER BY starts_at,id`, args: groupArg},
	{name: "bookings", query: `SELECT id,group_id,period_id,category_id,product_id,actor_membership_id,target_membership_id,quantity,
		unit_price_minor,total_minor,(SELECT currency FROM groups WHERE id=bookings.group_id) AS currency,product_name,category_name,reason,created_at,voided_at,voided_by,void_reason,version
		FROM bookings WHERE group_id=? ORDER BY created_at,id`, args: groupArg},
	{name: "payments", query: `SELECT id,group_id,membership_id,amount_minor,(SELECT currency FROM groups WHERE id=payments.group_id) AS currency,received_at,method,method_label,reference,note,created_by,
		created_at,reversed_at,reversed_by,reversal_reason FROM payments WHERE group_id=? ORDER BY created_at,id`, args: groupArg},
	{name: "payment_attachments", query: `SELECT payment_id,group_id,original_filename,media_type,size_bytes,sha256,created_by_membership_id,created_at
		FROM payment_attachments WHERE group_id=? ORDER BY created_at,payment_id`, args: groupArg},
	{name: "payment_allocations", query: `SELECT group_id,payment_id,period_id,amount_minor,(SELECT currency FROM groups WHERE id=payment_allocations.group_id) AS currency FROM payment_allocations
		WHERE group_id=? ORDER BY payment_id,period_id`, args: groupArg},
	{name: "period_adjustment_allocations", query: `SELECT group_id,membership_id,source_period_id,target_period_id,amount_minor,(SELECT currency FROM groups WHERE id=period_adjustment_allocations.group_id) AS currency
		FROM period_adjustment_allocations WHERE group_id=? ORDER BY membership_id,source_period_id,target_period_id`, args: groupArg},
	{name: "ledger_entries", query: `SELECT id,group_id,period_id,membership_id,category_id,booking_id,payment_id,reversal_of,account,
		amount_minor,(SELECT currency FROM groups WHERE id=ledger_entries.group_id) AS currency,description,created_at FROM ledger_entries WHERE group_id=? ORDER BY created_at,id`, args: groupArg},
	{name: "period_statements", query: `SELECT id,group_id,period_id,membership_id,display_name,email,charges_minor,payments_allocated_minor,
		adjustments_applied_minor,adjustments_provided_minor,amount_due_minor,(SELECT currency FROM groups WHERE id=period_statements.group_id) AS currency,status,created_at
		FROM period_statements WHERE group_id=? ORDER BY created_at,id`, args: groupArg},
	{name: "membership_notification_settings", query: `SELECT group_id,membership_id,version,updated_at
		FROM membership_notification_settings WHERE group_id=? ORDER BY membership_id`, args: groupArg},
	{name: "membership_notification_channels", query: `SELECT group_id,membership_id,event_type,channel,enabled_at,updated_at
		FROM membership_notification_channels WHERE group_id=? ORDER BY membership_id,event_type,channel`, args: groupArg},
	{name: "notifications", query: `SELECT id,group_id,membership_id,type,title,body,resource_type,resource_id,context_json,read_at,created_at
		FROM notifications WHERE group_id=? ORDER BY created_at,id`, args: groupArg},
	{name: "notification_delivery", query: `SELECT id,notification_id,group_id,channel,target_membership_id,status,attempt_count,
		next_attempt_at,delivered_at,expires_at,last_error_code,created_at,updated_at
		FROM notification_delivery_jobs WHERE group_id=? ORDER BY created_at,id`, args: groupArg},
	{name: "notification_reminder_runs", query: `SELECT group_id,statement_id,event_type,occurrence_date,notification_id,created_at
		FROM notification_reminder_runs WHERE group_id=? ORDER BY occurrence_date,statement_id,event_type`, args: groupArg},
	{name: "audit_events", query: `SELECT id,group_id,actor_user_id,actor_membership_id,action,resource_type,resource_id,
		metadata_json,occurred_at FROM audit_events WHERE group_id=? ORDER BY occurred_at,id`, args: groupArg},
}

var personalDatasets = []dataset{
	{name: "planning_series_cancelled_ranges", query: `SELECT range_row.group_id,range_row.series_id,range_row.from_sequence,range_row.from_original_start_at,range_row.created_at FROM planning_series_cancelled_ranges range_row JOIN planning_series_recipients recipient ON recipient.series_id=range_row.series_id AND recipient.group_id=range_row.group_id WHERE range_row.group_id=? AND recipient.membership_id=? AND EXISTS(SELECT 1 FROM memberships WHERE id=recipient.membership_id AND user_id=?) ORDER BY range_row.series_id,range_row.from_sequence`, args: personalArg},
	{name: "planning_series", query: `SELECT series.id,series.group_id,series.status,series.timezone,series.current_revision,series.version,series.published_at,series.cancelled_at,series.created_at,series.updated_at FROM planning_series series JOIN planning_series_recipients recipient ON recipient.series_id=series.id AND recipient.group_id=series.group_id WHERE series.group_id=? AND recipient.membership_id=? AND EXISTS(SELECT 1 FROM memberships WHERE id=recipient.membership_id AND user_id=?) ORDER BY series.id`, args: personalArg},
	{name: "planning_series_revisions", query: `SELECT revision.group_id,revision.series_id,revision.revision,revision.effective_from_original_start_at,revision.effective_from_sequence,revision.title,revision.description,revision.location,revision.event_type,revision.audience_type,revision.all_day,revision.start_date,revision.duration_days,revision.starts_at,revision.duration_minutes,revision.response_deadline_minutes_before,revision.capacity,revision.waitlist_enabled,revision.frequency,revision.interval_value,revision.weekdays_json,revision.monthly_mode,revision.range_type,revision.occurrence_count,revision.until_at,revision.created_at FROM planning_series_revisions revision JOIN planning_series_recipients recipient ON recipient.series_id=revision.series_id AND recipient.group_id=revision.group_id WHERE revision.group_id=? AND recipient.membership_id=? AND EXISTS(SELECT 1 FROM memberships WHERE id=recipient.membership_id AND user_id=?) ORDER BY revision.series_id,revision.revision`, args: personalArg},
	{name: "planning_events", query: `SELECT event.id,event.group_id,event.series_id,event.series_revision,event.series_sequence,event.original_start_at,event.original_start_date,event.is_series_exception,event.title,event.description,event.location,event.event_type,event.status,event.all_day,event.timezone,event.start_date,event.end_date_exclusive,event.starts_at,event.ends_at,event.response_deadline,event.response_deadline_minutes_before,event.confirmation_revision,event.version,event.created_at,event.updated_at FROM planning_events event JOIN planning_event_audience audience ON audience.event_id=event.id AND audience.group_id=event.group_id WHERE event.group_id=? AND audience.membership_id=? AND EXISTS(SELECT 1 FROM memberships WHERE id=audience.membership_id AND user_id=?) ORDER BY event.starts_at,event.id`, args: personalArg},
	{name: "planning_audience", query: `SELECT audience.group_id,audience.event_id,audience.membership_id,audience.display_name_snapshot,audience.invited_at FROM planning_event_audience audience WHERE audience.group_id=? AND audience.membership_id=? AND EXISTS(SELECT 1 FROM memberships WHERE id=audience.membership_id AND user_id=?) ORDER BY audience.event_id`, args: personalArg},
	{name: "planning_participations", query: `SELECT participation.group_id,participation.event_id,participation.membership_id,participation.status,participation.waitlist_position,participation.confirmed_revision,participation.version,participation.responded_at,participation.updated_at FROM planning_participations participation WHERE participation.group_id=? AND participation.membership_id=? AND EXISTS(SELECT 1 FROM memberships WHERE id=participation.membership_id AND user_id=?) ORDER BY participation.event_id`, args: personalArg},
	{name: "profile", query: `SELECT id,email,display_name,active,created_at,updated_at,color_mode,default_group_id,last_used_group_id,
		CASE WHEN avatar_key IS NULL THEN 0 ELSE 1 END AS avatar_present FROM users WHERE id=?`, args: func(record jobRecord) []any { return []any{record.UserID} }},
	{name: "group", query: `SELECT id,name,currency,status,created_at,updated_at FROM groups WHERE id=?`, args: groupArg},
	{name: "membership", query: `SELECT id,group_id,user_id,status,joined_at,archived_at,deleted_at,role_assignments_version,theme_override
		FROM memberships WHERE group_id=? AND id=? AND user_id=?`, args: personalArg},
	{name: "roles", query: `SELECT role.id,role.name,role.description,role.preset_key,assignment.assigned_at,assignment.assigned_by
		FROM membership_role_assignments assignment JOIN roles role ON role.group_id=assignment.group_id AND role.id=assignment.role_id
		WHERE assignment.group_id=? AND assignment.membership_id=? AND EXISTS (SELECT 1 FROM memberships WHERE user_id=? AND id=assignment.membership_id)
		ORDER BY lower(role.name),role.id`, args: personalArg},
	{name: "effective_permissions", query: `SELECT DISTINCT grant.permission_key,grant.scope_type,grant.category_id,grant.product_id
		FROM membership_role_assignments assignment JOIN role_permission_grants grant ON grant.group_id=assignment.group_id AND grant.role_id=assignment.role_id
		WHERE assignment.group_id=? AND assignment.membership_id=? AND EXISTS (SELECT 1 FROM memberships WHERE user_id=? AND id=assignment.membership_id)
		ORDER BY grant.permission_key,grant.scope_type,grant.category_id,grant.product_id`, args: personalArg},
	{name: "notification_preferences", query: `SELECT settings.group_id,settings.membership_id,settings.version,settings.updated_at
		FROM membership_notification_settings settings WHERE settings.group_id=? AND settings.membership_id=?
		AND EXISTS (SELECT 1 FROM memberships WHERE id=settings.membership_id AND user_id=?)`, args: personalArg},
	{name: "notification_channels", query: `SELECT channel.group_id,channel.membership_id,channel.event_type,channel.channel,channel.enabled_at,channel.updated_at
		FROM membership_notification_channels channel WHERE channel.group_id=? AND channel.membership_id=?
		AND EXISTS (SELECT 1 FROM memberships WHERE id=channel.membership_id AND user_id=?) ORDER BY channel.event_type,channel.channel`, args: personalArg},
	{name: "notifications", query: `SELECT notification.id,notification.group_id,notification.membership_id,notification.type,notification.title,
		notification.body,notification.resource_type,notification.resource_id,notification.context_json,notification.read_at,notification.created_at
		FROM notifications notification WHERE notification.group_id=? AND notification.membership_id=?
		AND EXISTS (SELECT 1 FROM memberships WHERE id=notification.membership_id AND user_id=?) ORDER BY notification.created_at,notification.id`, args: personalArg},
	{name: "bookings", query: `SELECT booking.id,booking.group_id,booking.period_id,booking.category_id,booking.product_id,booking.actor_membership_id,
		booking.target_membership_id,booking.quantity,booking.unit_price_minor,booking.total_minor,booking.product_name,booking.category_name,
		(SELECT currency FROM groups WHERE id=booking.group_id) AS currency,booking.reason,booking.created_at,booking.voided_at,booking.voided_by,booking.void_reason,booking.version
		FROM bookings booking WHERE booking.group_id=? AND (booking.actor_membership_id=? OR booking.target_membership_id=(SELECT id FROM memberships WHERE user_id=? AND group_id=booking.group_id))
		ORDER BY booking.created_at,booking.id`, args: personalArg},
	{name: "payments", query: `SELECT payment.id,payment.group_id,payment.membership_id,payment.amount_minor,(SELECT currency FROM groups WHERE id=payment.group_id) AS currency,payment.received_at,payment.method,
		payment.method_label,payment.reference,payment.note,payment.created_by,payment.created_at,payment.reversed_at,payment.reversed_by,payment.reversal_reason
		FROM payments payment WHERE payment.group_id=? AND (payment.membership_id=? OR payment.created_by=?) ORDER BY payment.created_at,payment.id`,
		args: func(record jobRecord) []any { return []any{record.GroupID, record.MembershipID, record.MembershipID} }},
	{name: "payment_attachments", query: `SELECT attachment.payment_id,attachment.group_id,attachment.original_filename,attachment.media_type,
		attachment.size_bytes,attachment.sha256,attachment.created_by_membership_id,attachment.created_at
		FROM payment_attachments attachment JOIN payments payment ON payment.id=attachment.payment_id AND payment.group_id=attachment.group_id
		WHERE attachment.group_id=? AND (payment.membership_id=? OR payment.created_by=?) ORDER BY attachment.created_at,attachment.payment_id`,
		args: func(record jobRecord) []any { return []any{record.GroupID, record.MembershipID, record.MembershipID} }},
	{name: "payment_allocations", query: `SELECT allocation.group_id,allocation.payment_id,allocation.period_id,allocation.amount_minor,
		(SELECT currency FROM groups WHERE id=allocation.group_id) AS currency
		FROM payment_allocations allocation JOIN payments payment ON payment.id=allocation.payment_id AND payment.group_id=allocation.group_id
		WHERE allocation.group_id=? AND (payment.membership_id=? OR payment.created_by=?) ORDER BY allocation.payment_id,allocation.period_id`,
		args: func(record jobRecord) []any { return []any{record.GroupID, record.MembershipID, record.MembershipID} }},
	{name: "period_adjustment_allocations", query: `SELECT allocation.group_id,allocation.membership_id,allocation.source_period_id,
		allocation.target_period_id,allocation.amount_minor,(SELECT currency FROM groups WHERE id=allocation.group_id) AS currency
		FROM period_adjustment_allocations allocation WHERE allocation.group_id=? AND allocation.membership_id=?
		AND EXISTS (SELECT 1 FROM memberships WHERE id=allocation.membership_id AND user_id=?)
		ORDER BY allocation.source_period_id,allocation.target_period_id`, args: personalArg},
	{name: "ledger_entries", query: `SELECT entry.id,entry.group_id,entry.period_id,entry.membership_id,entry.category_id,entry.booking_id,
		entry.payment_id,entry.reversal_of,entry.account,entry.amount_minor,(SELECT currency FROM groups WHERE id=entry.group_id) AS currency,entry.description,entry.created_at
		FROM ledger_entries entry WHERE entry.group_id=? AND entry.membership_id=?
		AND EXISTS (SELECT 1 FROM memberships WHERE id=entry.membership_id AND user_id=?) ORDER BY entry.created_at,entry.id`, args: personalArg},
	{name: "period_statements", query: `SELECT statement.id,statement.group_id,statement.period_id,statement.membership_id,statement.display_name,
		statement.email,statement.charges_minor,statement.payments_allocated_minor,statement.adjustments_applied_minor,
		statement.adjustments_provided_minor,statement.amount_due_minor,(SELECT currency FROM groups WHERE id=statement.group_id) AS currency,statement.status,statement.created_at
		FROM period_statements statement WHERE statement.group_id=? AND statement.membership_id=?
		AND EXISTS (SELECT 1 FROM memberships WHERE id=statement.membership_id AND user_id=?) ORDER BY statement.created_at,statement.id`, args: personalArg},
	{name: "audit_events", query: `SELECT event.id,event.group_id,event.actor_user_id,event.actor_membership_id,event.action,
		event.resource_type,event.resource_id,event.metadata_json,event.occurred_at FROM audit_events event
		WHERE event.group_id=? AND event.actor_membership_id=? AND event.actor_user_id=? ORDER BY event.occurred_at,event.id`, args: personalArg},
}

func generateArchive(ctx context.Context, tx *sql.Tx, output io.Writer, record jobRecord, exportedAt time.Time, maxBytes int64, progress func(int) error) error {
	limited := &limitedWriter{writer: output, limit: maxBytes}
	archive := zip.NewWriter(limited)
	manifest := archiveManifest{FormatVersion: "1.0", Scope: record.Scope, GroupID: record.GroupID,
		RequestedBy: record.UserID, ExportedAt: exportedAt.UTC().Format(time.RFC3339Nano), Datasets: []datasetManifest{}}
	schema := schemaDocument{FormatVersion: "1.0", Encoding: "UTF-8", CSV: schemaCSV{Delimiter: ",", Newline: "CRLF"}, Datasets: []datasetSchema{}}
	for _, current := range datasetsFor(record.Scope) {
		if err := ctx.Err(); err != nil {
			archive.Close()
			return err
		}
		entry, fields, rows, digest, err := writeDataset(ctx, tx, archive, current, record, exportedAt)
		if err != nil {
			archive.Close()
			return err
		}
		manifest.Datasets = append(manifest.Datasets, datasetManifest{Name: current.name, File: entry, Rows: rows, SHA256: digest})
		schema.Datasets = append(schema.Datasets, datasetSchema{Name: current.name, File: entry, Fields: fields})
		if progress != nil {
			if err := progress(len(manifest.Datasets)); err != nil {
				archive.Close()
				return err
			}
		}
	}
	if err := writeJSONEntry(archive, "schema.json", schema, exportedAt); err != nil {
		archive.Close()
		return err
	}
	if err := writeJSONEntry(archive, "manifest.json", manifest, exportedAt); err != nil {
		archive.Close()
		return err
	}
	if err := archive.Close(); err != nil {
		return fmt.Errorf("close export archive: %w", err)
	}
	return nil
}

func writeDataset(ctx context.Context, tx *sql.Tx, archive *zip.Writer, current dataset, record jobRecord, modified time.Time) (string, []schemaField, int64, string, error) {
	rows, err := tx.QueryContext(ctx, current.query, current.args(record)...)
	if err != nil {
		return "", nil, 0, "", fmt.Errorf("query export dataset %s: %w", current.name, err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return "", nil, 0, "", fmt.Errorf("read export dataset %s columns: %w", current.name, err)
	}
	entryName := "data/" + current.name + ".csv"
	header := &zip.FileHeader{Name: entryName, Method: zip.Deflate}
	header.SetModTime(modified.UTC())
	header.SetMode(0o600)
	entry, err := archive.CreateHeader(header)
	if err != nil {
		return "", nil, 0, "", fmt.Errorf("create export dataset %s: %w", current.name, err)
	}
	digest := sha256.New()
	csvWriter := csv.NewWriter(io.MultiWriter(entry, digest))
	csvWriter.UseCRLF = true
	if err := csvWriter.Write(columns); err != nil {
		return "", nil, 0, "", err
	}
	schemaFields := make([]schemaField, len(columns))
	for index, column := range columns {
		schemaFields[index] = schemaField{Name: column, Format: fieldFormat(column)}
	}
	var count int64
	for rows.Next() {
		values := make([]any, len(columns))
		targets := make([]any, len(columns))
		for index := range values {
			targets[index] = &values[index]
		}
		if err := rows.Scan(targets...); err != nil {
			return "", nil, 0, "", fmt.Errorf("scan export dataset %s: %w", current.name, err)
		}
		line := make([]string, len(columns))
		for index, value := range values {
			line[index] = exportValue(columns[index], value)
		}
		if err := csvWriter.Write(line); err != nil {
			return "", nil, 0, "", fmt.Errorf("write export dataset %s: %w", current.name, err)
		}
		count++
	}
	if err := rows.Err(); err != nil {
		return "", nil, 0, "", fmt.Errorf("iterate export dataset %s: %w", current.name, err)
	}
	csvWriter.Flush()
	if err := csvWriter.Error(); err != nil {
		return "", nil, 0, "", fmt.Errorf("flush export dataset %s: %w", current.name, err)
	}
	return entryName, schemaFields, count, hex.EncodeToString(digest.Sum(nil)), nil
}

func writeJSONEntry(archive *zip.Writer, name string, value any, modified time.Time) error {
	header := &zip.FileHeader{Name: name, Method: zip.Deflate}
	header.SetModTime(modified.UTC())
	header.SetMode(0o600)
	entry, err := archive.CreateHeader(header)
	if err != nil {
		return fmt.Errorf("create %s: %w", name, err)
	}
	encoder := json.NewEncoder(entry)
	encoder.SetEscapeHTML(true)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return fmt.Errorf("encode %s: %w", name, err)
	}
	return nil
}

func exportValue(column string, value any) string {
	if value == nil {
		return ""
	}
	var result string
	textual := true
	switch typed := value.(type) {
	case []byte:
		if utf8.Valid(typed) {
			result = string(typed)
		}
	case string:
		result = typed
	case int64:
		result = strconv.FormatInt(typed, 10)
		textual = false
	case float64:
		result = strconv.FormatFloat(typed, 'g', -1, 64)
		textual = false
	case bool:
		result = strconv.FormatBool(typed)
		textual = false
	default:
		result = fmt.Sprint(typed)
	}
	if strings.HasSuffix(column, "_json") {
		result = sanitizeJSON(result)
	}
	if !textual {
		return result
	}
	return preventSpreadsheetFormula(result)
}

func preventSpreadsheetFormula(value string) string {
	trimmed := strings.TrimLeft(value, " \r\n")
	if trimmed == "" {
		return value
	}
	if strings.ContainsRune("=+-@", rune(trimmed[0])) || strings.HasPrefix(trimmed, "\t") {
		return "'" + value
	}
	return value
}

func sanitizeJSON(encoded string) string {
	var value any
	if json.Unmarshal([]byte(encoded), &value) != nil {
		return "{}"
	}
	sanitizeJSONValue(value)
	result, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(result)
}

func sanitizeJSONValue(value any) {
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			if sensitiveJSONKey(key) {
				delete(typed, key)
				continue
			}
			sanitizeJSONValue(typed[key])
			if text, ok := typed[key].(string); ok && filepath.IsAbs(text) {
				typed[key] = "[redacted]"
			}
		}
	case []any:
		for _, item := range typed {
			sanitizeJSONValue(item)
		}
	}
}

func sensitiveJSONKey(key string) bool {
	normalized := strings.ToLower(strings.ReplaceAll(key, "-", "_"))
	for _, marker := range []string{"password", "token", "secret", "session", "csrf", "ciphertext", "storage_key", "endpoint", "private_key"} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}

func fieldFormat(column string) string {
	switch {
	case strings.HasSuffix(column, "_minor"):
		return "minor-unit-integer-string"
	case strings.HasSuffix(column, "_json"):
		return "json-string"
	case column == "due_at" || column == "occurrence_date" || column == "start_date" || column == "end_date_exclusive":
		return "iso-8601-date"
	case strings.HasSuffix(column, "_at") || column == "expires_at" || column == "starts_at":
		return "rfc3339-utc"
	default:
		return "string"
	}
}
