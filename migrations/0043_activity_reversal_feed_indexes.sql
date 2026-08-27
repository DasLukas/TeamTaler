-- Reversal activity branches are derived from immutable transaction metadata.
-- Partial indexes keep both group-wide and restricted visibility scans scoped
-- to the small set of reversed transactions without modifying existing data.

CREATE INDEX bookings_group_voided_activity_idx
    ON bookings(group_id, strftime('%Y-%m-%dT%H:%M:%fZ', voided_at) DESC, id DESC)
    WHERE voided_at IS NOT NULL;

CREATE INDEX bookings_group_target_voided_activity_idx
    ON bookings(group_id, target_membership_id, strftime('%Y-%m-%dT%H:%M:%fZ', voided_at) DESC, id DESC)
    WHERE voided_at IS NOT NULL;

CREATE INDEX bookings_group_actor_voided_activity_idx
    ON bookings(group_id, actor_membership_id, strftime('%Y-%m-%dT%H:%M:%fZ', voided_at) DESC, id DESC)
    WHERE voided_at IS NOT NULL;

CREATE INDEX payments_group_reversed_activity_idx
    ON payments(group_id, strftime('%Y-%m-%dT%H:%M:%fZ', reversed_at) DESC, id DESC)
    WHERE reversed_at IS NOT NULL;

CREATE INDEX payments_group_member_reversed_activity_idx
    ON payments(group_id, membership_id, strftime('%Y-%m-%dT%H:%M:%fZ', reversed_at) DESC, id DESC)
    WHERE reversed_at IS NOT NULL;
