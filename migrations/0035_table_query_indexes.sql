CREATE INDEX bookings_group_created_page_idx
    ON bookings(group_id, strftime('%Y-%m-%dT%H:%M:%fZ', created_at) DESC, id DESC);
CREATE INDEX bookings_group_actor_created_page_idx
    ON bookings(group_id, actor_membership_id, strftime('%Y-%m-%dT%H:%M:%fZ', created_at) DESC, id DESC);
CREATE INDEX bookings_group_target_created_page_idx
    ON bookings(group_id, target_membership_id, strftime('%Y-%m-%dT%H:%M:%fZ', created_at) DESC, id DESC);
CREATE INDEX bookings_group_category_created_page_idx
    ON bookings(group_id, category_id, strftime('%Y-%m-%dT%H:%M:%fZ', created_at) DESC, id DESC);
CREATE INDEX bookings_group_product_created_page_idx
    ON bookings(group_id, product_id, strftime('%Y-%m-%dT%H:%M:%fZ', created_at) DESC, id DESC);

CREATE INDEX payments_group_received_page_idx
    ON payments(group_id, strftime('%Y-%m-%dT%H:%M:%fZ', received_at) DESC, id DESC);
CREATE INDEX payments_group_member_received_page_idx
    ON payments(group_id, membership_id, strftime('%Y-%m-%dT%H:%M:%fZ', received_at) DESC, id DESC);
CREATE INDEX payments_group_method_received_page_idx
    ON payments(group_id, method, strftime('%Y-%m-%dT%H:%M:%fZ', received_at) DESC, id DESC);
CREATE INDEX payments_group_reversed_received_page_idx
    ON payments(group_id, reversed_at, strftime('%Y-%m-%dT%H:%M:%fZ', received_at) DESC, id DESC);

CREATE INDEX ledger_member_movements_page_idx
    ON ledger_entries(group_id, membership_id, account, strftime('%Y-%m-%dT%H:%M:%fZ', created_at) DESC, id DESC);

CREATE INDEX audit_group_time_page_idx
    ON audit_events(group_id, strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) DESC, id DESC);
CREATE INDEX audit_group_actor_time_page_idx
    ON audit_events(group_id, actor_user_id, strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) DESC, id DESC);
CREATE INDEX audit_group_action_time_page_idx
    ON audit_events(group_id, action, strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) DESC, id DESC);
CREATE INDEX audit_group_resource_time_page_idx
    ON audit_events(group_id, resource_type, strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) DESC, id DESC);

CREATE INDEX system_audit_time_page_idx
    ON system_audit_events(strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) DESC, id DESC);
CREATE INDEX system_audit_actor_time_page_idx
    ON system_audit_events(actor_user_id, strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) DESC, id DESC);
CREATE INDEX system_audit_action_time_page_idx
    ON system_audit_events(action, strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) DESC, id DESC);
CREATE INDEX system_audit_resource_time_page_idx
    ON system_audit_events(resource_type, strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) DESC, id DESC);
