package notifications

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// EventPreference contains the current member's independent external channel
// choices for one catalog event. Events owned by a disabled optional module are
// omitted from the member projection without deleting stored channel choices.
type EventPreference struct {
	EventDefinition
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

// GetPreferences returns the effective event matrix for the current membership.
// Events owned by a disabled optional module are hidden without deleting stored
// channel choices.
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
			) catalog ORDER BY catalog.event_type`, membership.GroupID, membership.ID, membership.GroupID, membership.ID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var eventType EventType
			var emailEnabled, pushEnabled bool
			if err := rows.Scan(&eventType, &emailEnabled, &pushEnabled); err != nil {
				return err
			}
			definition, supported := Definition(eventType)
			if !supported || !modules.allows(eventType) {
				continue
			}
			result.Events = append(result.Events, EventPreference{EventDefinition: definition, Email: emailEnabled, Push: pushEnabled, EmailAvailable: availability.EmailAvailable, PushAvailable: availability.PushAvailable})
		}
		return rows.Err()
	})
	return result, err
}

// UpdatePreferences applies independent email and push choices for exposed
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
