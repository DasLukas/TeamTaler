package notifications

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// GroupEventSetting combines catalog metadata with the group's effective gate.
type GroupEventSetting struct {
	EventDefinition
	Enabled bool `json:"enabled"`
}

// GroupSettings is the administrator-visible notification policy for a group.
// Version is an optimistic concurrency token for whole-policy replacement.
type GroupSettings struct {
	Version           int64               `json:"version"`
	Timezone          string              `json:"timezone"`
	DueSoonLeadDays   int                 `json:"dueSoonLeadDays"`
	OverdueRepeatDays int                 `json:"overdueRepeatDays"`
	AvailableChannels []Channel           `json:"availableChannels"`
	Events            []GroupEventSetting `json:"events"`
	UpdatedAt         string              `json:"updatedAt"`
}

// GroupSettingsUpdate is the complete editable notification policy accepted
// from a group administrator.
type GroupSettingsUpdate struct {
	Timezone          string             `json:"timezone"`
	DueSoonLeadDays   int                `json:"dueSoonLeadDays"`
	OverdueRepeatDays int                `json:"overdueRepeatDays"`
	Events            []GroupEventUpdate `json:"events"`
}

// GroupEventUpdate contains one complete group event gate.
type GroupEventUpdate struct {
	Type    EventType `json:"type"`
	Enabled bool      `json:"enabled"`
}

// EventPreference contains the current member's independent external channel
// choices and the effective group gate for one catalog event. Stored choices
// remain visible when the group temporarily disables the event, while events
// owned by a disabled optional module are omitted from the member projection.
type EventPreference struct {
	EventDefinition
	Enabled        bool `json:"enabled"`
	Email          bool `json:"email"`
	Push           bool `json:"push"`
	EmailAvailable bool `json:"emailAvailable"`
	PushAvailable  bool `json:"pushAvailable"`
}

// Preferences is the member-visible channel matrix plus effective system gates.
type Preferences struct {
	Version           int64             `json:"version"`
	AvailableChannels []Channel         `json:"availableChannels"`
	Events            []EventPreference `json:"events"`
}

// PreferenceUpdate changes any subset of channel choices. Pointer fields make
// omission distinct from disabling a channel.
type PreferenceUpdate struct {
	Type  EventType `json:"type"`
	Email *bool     `json:"email,omitempty"`
	Push  *bool     `json:"push,omitempty"`
}

// PreferencesUpdate describes an atomic partial matrix update.
type PreferencesUpdate struct {
	Events []PreferenceUpdate `json:"events"`
}

// GetGroupSettings returns the group notification policy after re-checking the
// caller's current GROUP_ADMINISTRATION permission.
func (s Service) GetGroupSettings(ctx context.Context, membership domain.Membership) (GroupSettings, error) {
	var result GroupSettings
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := authorization.Require(ctx, tx, membership.GroupID, membership.ID, domain.PermissionGroupAdministration, authorization.GroupResource(membership.GroupID)); err != nil {
			return err
		}
		var err error
		result, err = readGroupSettings(ctx, tx, membership.GroupID)
		if err != nil {
			return err
		}
		availability, err := s.channelAvailability(ctx, tx)
		if err != nil {
			return err
		}
		result.AvailableChannels = availableChannels(availability)
		return nil
	})
	return result, err
}

// UpdateGroupSettings validates and atomically replaces a group notification
// policy. expectedVersion must match the current version; permission is checked
// again inside the serialized transaction.
func (s Service) UpdateGroupSettings(ctx context.Context, actor domain.Principal, membership domain.Membership, input GroupSettingsUpdate, expectedVersion int64) (GroupSettings, error) {
	if expectedVersion < 1 {
		return GroupSettings{}, fmt.Errorf("%w: a current group notification settings version is required", domain.ErrPrecondition)
	}
	input.Timezone = strings.TrimSpace(input.Timezone)
	if input.Timezone == "" || input.Timezone == "Local" || len(input.Timezone) > 64 {
		return GroupSettings{}, domain.ValidationError{Field: "timezone", Message: "must contain a valid IANA time zone"}
	}
	if _, err := time.LoadLocation(input.Timezone); err != nil {
		return GroupSettings{}, domain.ValidationError{Field: "timezone", Message: "must contain a valid IANA time zone"}
	}
	if input.DueSoonLeadDays < 1 || input.DueSoonLeadDays > 30 {
		return GroupSettings{}, domain.ValidationError{Field: "dueSoonLeadDays", Message: "must be between 1 and 30"}
	}
	if input.OverdueRepeatDays < 0 || input.OverdueRepeatDays > 90 {
		return GroupSettings{}, domain.ValidationError{Field: "overdueRepeatDays", Message: "must be between 0 and 90"}
	}
	enabled, err := normalizeGroupEventUpdates(input.Events)
	if err != nil {
		return GroupSettings{}, err
	}
	var result GroupSettings
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := authorization.Require(ctx, tx, membership.GroupID, membership.ID, domain.PermissionGroupAdministration, authorization.GroupResource(membership.GroupID)); err != nil {
			return err
		}
		previous, err := readGroupSettings(ctx, tx, membership.GroupID)
		if err != nil {
			return err
		}
		if previous.Version != expectedVersion {
			return domain.ErrPrecondition
		}
		if sameGroupSettings(previous, input, enabled) {
			result = previous
			availability, err := s.channelAvailability(ctx, tx)
			if err != nil {
				return err
			}
			result.AvailableChannels = availableChannels(availability)
			return nil
		}
		now := platform.Timestamp(platform.Now())
		update, err := tx.ExecContext(ctx, `UPDATE group_notification_settings
			SET timezone=?,settlement_due_soon_days=?,settlement_overdue_repeat_days=?,version=version+1,updated_at=?
			WHERE group_id=? AND version=?`, input.Timezone, input.DueSoonLeadDays, input.OverdueRepeatDays, now, membership.GroupID, expectedVersion)
		if err != nil {
			return err
		}
		affected, _ := update.RowsAffected()
		if affected != 1 {
			return domain.ErrPrecondition
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM group_notification_events WHERE group_id=?`, membership.GroupID); err != nil {
			return err
		}
		for _, eventType := range enabled {
			if _, err := tx.ExecContext(ctx, `INSERT INTO group_notification_events(group_id,event_type,enabled_at) VALUES(?,?,?)`, membership.GroupID, eventType, now); err != nil {
				return err
			}
		}
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "group.notification_settings.updated", "group_notification_settings", membership.GroupID, map[string]any{
			"previousVersion": previous.Version, "enabledEvents": enabled,
			"timezone": input.Timezone, "dueSoonLeadDays": input.DueSoonLeadDays,
			"overdueRepeatDays": input.OverdueRepeatDays,
		}); err != nil {
			return err
		}
		result, err = readGroupSettings(ctx, tx, membership.GroupID)
		if err == nil {
			availability, availabilityErr := s.channelAvailability(ctx, tx)
			if availabilityErr != nil {
				return availabilityErr
			}
			result.AvailableChannels = availableChannels(availability)
		}
		return err
	})
	return result, err
}

// GetPreferences returns the effective event matrix for the current membership.
// Disabled group events remain visible but cannot be edited. Events owned by a
// disabled optional module are hidden without deleting stored channel choices.
func (s Service) GetPreferences(ctx context.Context, membership domain.Membership) (Preferences, error) {
	var result Preferences
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireActiveMembership(ctx, tx, membership); err != nil {
			return err
		}
		availability, err := s.channelAvailability(ctx, tx)
		if err != nil {
			return err
		}
		result.AvailableChannels = availableChannels(availability)
		if err := tx.QueryRowContext(ctx, `SELECT version FROM membership_notification_settings WHERE group_id=? AND membership_id=?`, membership.GroupID, membership.ID).Scan(&result.Version); err != nil {
			return err
		}
		modules, err := readNotificationModuleAvailability(ctx, tx, membership.GroupID)
		if err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, `SELECT catalog.event_type,
			EXISTS(SELECT 1 FROM group_notification_events event WHERE event.group_id=? AND event.event_type=catalog.event_type),
			EXISTS(SELECT 1 FROM membership_notification_channels preference WHERE preference.group_id=? AND preference.membership_id=? AND preference.event_type=catalog.event_type AND preference.channel='EMAIL'),
			EXISTS(SELECT 1 FROM membership_notification_channels preference WHERE preference.group_id=? AND preference.membership_id=? AND preference.event_type=catalog.event_type AND preference.channel='PUSH')
			FROM (
				SELECT 'BOOKING_ASSIGNED' event_type UNION ALL SELECT 'BOOKING_REVERSED' UNION ALL
				SELECT 'PAYMENT_RECORDED' UNION ALL SELECT 'PAYMENT_REVERSED' UNION ALL
				SELECT 'SETTLEMENT_CREATED' UNION ALL SELECT 'SETTLEMENT_DUE_SOON' UNION ALL SELECT 'SETTLEMENT_OVERDUE' UNION ALL
				SELECT 'PLANNING_EVENT_PUBLISHED' UNION ALL
				SELECT 'PLANNING_EVENT_UPDATED' UNION ALL SELECT 'PLANNING_EVENT_CANCELLED' UNION ALL
				SELECT 'PLANNING_WAITLIST_PROMOTED' UNION ALL SELECT 'PLANNING_SERIES_PUBLISHED' UNION ALL
				SELECT 'PLANNING_SERIES_UPDATED' UNION ALL SELECT 'PLANNING_SERIES_CANCELLED'
			) catalog ORDER BY catalog.event_type`, membership.GroupID, membership.GroupID, membership.ID, membership.GroupID, membership.ID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var eventType EventType
			var groupEnabled, emailEnabled, pushEnabled bool
			if err := rows.Scan(&eventType, &groupEnabled, &emailEnabled, &pushEnabled); err != nil {
				return err
			}
			definition, supported := Definition(eventType)
			if !supported || !modules.allows(eventType) {
				continue
			}
			result.Events = append(result.Events, EventPreference{EventDefinition: definition, Enabled: groupEnabled, Email: emailEnabled, Push: pushEnabled, EmailAvailable: availability.EmailAvailable, PushAvailable: availability.PushAvailable})
		}
		return rows.Err()
	})
	return result, err
}

// UpdatePreferences applies independent email and push choices for group-enabled
// events. A system-disabled channel cannot be mutated, which preserves the
// member's stored choice while administrators temporarily disable delivery.
func (s Service) UpdatePreferences(ctx context.Context, membership domain.Membership, input PreferencesUpdate, expectedVersion int64) (Preferences, error) {
	if expectedVersion < 1 {
		return Preferences{}, fmt.Errorf("%w: a current notification preferences version is required", domain.ErrPrecondition)
	}
	if len(input.Events) == 0 || len(input.Events) > len(eventCatalog) {
		return Preferences{}, domain.ValidationError{Field: "events", Message: fmt.Sprintf("must contain 1 to %d event updates", len(eventCatalog))}
	}
	seen := make(map[EventType]struct{}, len(input.Events))
	for _, update := range input.Events {
		if _, supported := Definition(update.Type); !supported {
			return Preferences{}, domain.ValidationError{Field: "events.type", Message: "contains an unsupported notification event"}
		}
		if _, duplicate := seen[update.Type]; duplicate {
			return Preferences{}, domain.ValidationError{Field: "events", Message: "must contain unique event types"}
		}
		seen[update.Type] = struct{}{}
		if update.Email == nil && update.Push == nil {
			return Preferences{}, domain.ValidationError{Field: "events", Message: "each event must change at least one channel"}
		}
	}
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireActiveMembership(ctx, tx, membership); err != nil {
			return err
		}
		availability, err := s.channelAvailability(ctx, tx)
		if err != nil {
			return err
		}
		var currentVersion int64
		if err := tx.QueryRowContext(ctx, `SELECT version FROM membership_notification_settings WHERE group_id=? AND membership_id=?`, membership.GroupID, membership.ID).Scan(&currentVersion); err != nil {
			return err
		}
		if currentVersion != expectedVersion {
			return domain.ErrPrecondition
		}
		modules, err := readNotificationModuleAvailability(ctx, tx, membership.GroupID)
		if err != nil {
			return err
		}
		now := platform.Timestamp(platform.Now())
		changed := false
		for _, update := range input.Events {
			if !modules.allows(update.Type) {
				return domain.ValidationError{Field: "events.type", Message: "can only change events exposed by an enabled module"}
			}
			var groupEnabled bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM group_notification_events WHERE group_id=? AND event_type=?)`, membership.GroupID, update.Type).Scan(&groupEnabled); err != nil {
				return err
			}
			if !groupEnabled {
				return domain.ValidationError{Field: "events.type", Message: "can only change events enabled by the group"}
			}
			if update.Email != nil {
				if !availability.EmailAvailable {
					return domain.ValidationError{Field: "events.email", Message: "cannot be changed while email delivery is unavailable"}
				}
				preferenceChanged, err := setPreference(ctx, tx, membership, update.Type, ChannelEmail, *update.Email, now)
				if err != nil {
					return err
				}
				changed = changed || preferenceChanged
			}
			if update.Push != nil {
				if !availability.PushAvailable {
					return domain.ValidationError{Field: "events.push", Message: "cannot be changed while push delivery is unavailable"}
				}
				preferenceChanged, err := setPreference(ctx, tx, membership, update.Type, ChannelPush, *update.Push, now)
				if err != nil {
					return err
				}
				changed = changed || preferenceChanged
			}
		}
		if changed {
			result, err := tx.ExecContext(ctx, `UPDATE membership_notification_settings SET version=version+1,updated_at=? WHERE group_id=? AND membership_id=? AND version=?`, now, membership.GroupID, membership.ID, expectedVersion)
			if err != nil {
				return err
			}
			affected, _ := result.RowsAffected()
			if affected != 1 {
				return domain.ErrPrecondition
			}
		}
		return nil
	})
	if err != nil {
		return Preferences{}, err
	}
	return s.GetPreferences(ctx, membership)
}

type notificationModuleAvailability struct {
	planningEnabled    bool
	settlementsEnabled bool
}

func readNotificationModuleAvailability(ctx context.Context, queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, groupID string) (notificationModuleAvailability, error) {
	var result notificationModuleAvailability
	err := queryer.QueryRowContext(ctx, `SELECT planning.enabled,settings.settlements_enabled
		FROM group_planning_settings planning
		JOIN group_settings settings ON settings.group_id=planning.group_id
		WHERE planning.group_id=?`, groupID).Scan(&result.planningEnabled, &result.settlementsEnabled)
	return result, err
}

func (availability notificationModuleAvailability) allows(eventType EventType) bool {
	if IsPlanningEvent(eventType) {
		return availability.planningEnabled
	}
	switch eventType {
	case TypeSettlementCreated, TypeSettlementDueSoon, TypeSettlementOverdue:
		return availability.settlementsEnabled
	default:
		return true
	}
}

func (s Service) channelAvailability(ctx context.Context, tx *sql.Tx) (ChannelAvailability, error) {
	if s.ResolveChannelAvailability != nil {
		return s.ResolveChannelAvailability(ctx, tx)
	}
	return ChannelAvailability{EmailAvailable: s.EmailDeliveryAvailable, PushAvailable: s.PushDeliveryAvailable}, nil
}

func setPreference(ctx context.Context, tx *sql.Tx, membership domain.Membership, eventType EventType, channel Channel, enabled bool, now string) (bool, error) {
	if !enabled {
		result, err := tx.ExecContext(ctx, `DELETE FROM membership_notification_channels WHERE group_id=? AND membership_id=? AND event_type=? AND channel=?`, membership.GroupID, membership.ID, eventType, channel)
		if err != nil {
			return false, err
		}
		affected, _ := result.RowsAffected()
		return affected == 1, nil
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO membership_notification_channels(group_id,membership_id,event_type,channel,enabled_at,updated_at)
		VALUES(?,?,?,?,?,?) ON CONFLICT(membership_id,event_type,channel) DO NOTHING`,
		membership.GroupID, membership.ID, eventType, channel, now, now)
	if err != nil {
		return false, err
	}
	affected, _ := result.RowsAffected()
	return affected == 1, nil
}

func requireActiveMembership(ctx context.Context, queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, membership domain.Membership) error {
	var active bool
	err := queryer.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM memberships WHERE id=? AND group_id=? AND status='ACTIVE' AND deleted_at IS NULL)`, membership.ID, membership.GroupID).Scan(&active)
	if err != nil {
		return err
	}
	if !active {
		return domain.ErrNotFound
	}
	return nil
}

type settingsReader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func readGroupSettings(ctx context.Context, queryer settingsReader, groupID string) (GroupSettings, error) {
	var result GroupSettings
	err := queryer.QueryRowContext(ctx, `SELECT version,timezone,settlement_due_soon_days,settlement_overdue_repeat_days,updated_at
		FROM group_notification_settings WHERE group_id=?`, groupID).
		Scan(&result.Version, &result.Timezone, &result.DueSoonLeadDays, &result.OverdueRepeatDays, &result.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return GroupSettings{}, domain.ErrNotFound
	}
	if err != nil {
		return GroupSettings{}, err
	}
	enabledRows, err := queryer.QueryContext(ctx, `SELECT event_type FROM group_notification_events WHERE group_id=?`, groupID)
	if err != nil {
		return GroupSettings{}, err
	}
	defer enabledRows.Close()
	enabled := make(map[EventType]struct{})
	for enabledRows.Next() {
		var eventType EventType
		if err := enabledRows.Scan(&eventType); err != nil {
			return GroupSettings{}, err
		}
		enabled[eventType] = struct{}{}
	}
	if err := enabledRows.Err(); err != nil {
		return GroupSettings{}, err
	}
	for _, definition := range Catalog() {
		_, isEnabled := enabled[definition.Type]
		result.Events = append(result.Events, GroupEventSetting{EventDefinition: definition, Enabled: isEnabled})
	}
	return result, nil
}

func normalizeGroupEventUpdates(values []GroupEventUpdate) ([]EventType, error) {
	if len(values) != len(eventCatalog) {
		return nil, domain.ValidationError{Field: "events", Message: "must contain every supported notification event exactly once"}
	}
	seen := make(map[EventType]struct{}, len(values))
	result := make([]EventType, 0, len(values))
	for _, value := range values {
		eventType := EventType(strings.TrimSpace(string(value.Type)))
		if _, supported := Definition(eventType); !supported {
			return nil, domain.ValidationError{Field: "events.type", Message: "contains an unsupported notification event"}
		}
		if _, duplicate := seen[eventType]; duplicate {
			return nil, domain.ValidationError{Field: "events", Message: "must contain unique event types"}
		}
		seen[eventType] = struct{}{}
		if value.Enabled {
			result = append(result, eventType)
		}
	}
	sort.Slice(result, func(left, right int) bool { return result[left] < result[right] })
	return result, nil
}

func sameGroupSettings(previous GroupSettings, input GroupSettingsUpdate, enabled []EventType) bool {
	if previous.Timezone != input.Timezone || previous.DueSoonLeadDays != input.DueSoonLeadDays || previous.OverdueRepeatDays != input.OverdueRepeatDays {
		return false
	}
	current := make([]EventType, 0, len(previous.Events))
	for _, event := range previous.Events {
		if event.Enabled {
			current = append(current, event.Type)
		}
	}
	sort.Slice(current, func(left, right int) bool { return current[left] < current[right] })
	if len(current) != len(enabled) {
		return false
	}
	for index := range current {
		if current[index] != enabled[index] {
			return false
		}
	}
	return true
}

func availableChannels(availability ChannelAvailability) []Channel {
	channels := make([]Channel, 0, 2)
	if availability.EmailAvailable {
		channels = append(channels, ChannelEmail)
	}
	if availability.PushAvailable {
		channels = append(channels, ChannelPush)
	}
	return channels
}
