package system

import (
	"context"
	"database/sql"
	"errors"
)

// NotificationChannelAvailability is a transactionally consistent snapshot of
// the instance-wide optional notification delivery gates.
type NotificationChannelAvailability struct {
	EmailActive   bool
	WebPushActive bool
	WebPushKeyID  string
}

// ResolveNotificationChannelsTx loads channel availability using tx so a
// business event can evaluate system configuration, group policy, member
// preference, and delivery-job insertion in one transaction.
//
// Parameters:
//   - ctx: Bounds settings resolution and secret verification.
//   - tx: Caller-owned transaction over the service database.
//
// Returns:
//   - NotificationChannelAvailability: Effective active channel gates and the
//     current VAPID key identifier.
//   - error: Missing transaction, storage, or secret verification failures.
//
// Example: state, err := service.ResolveNotificationChannelsTx(ctx, tx).
func (s Service) ResolveNotificationChannelsTx(ctx context.Context, tx *sql.Tx) (NotificationChannelAvailability, error) {
	if tx == nil {
		return NotificationChannelAvailability{}, errors.New("resolve notification channels: transaction is required")
	}
	loaded, err := s.loadSettings(ctx, tx)
	if err != nil {
		return NotificationChannelAvailability{}, err
	}
	return NotificationChannelAvailability{
		EmailActive:   loaded.settings.SMTP.Active,
		WebPushActive: loaded.settings.WebPush.Active,
		WebPushKeyID:  loaded.settings.WebPush.KeyID,
	}, nil
}
