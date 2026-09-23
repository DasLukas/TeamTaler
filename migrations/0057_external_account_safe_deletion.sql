ALTER TABLE external_accounts
ADD COLUMN deleted_at TEXT;

CREATE INDEX external_accounts_group_visibility_status_order_idx
ON external_accounts(group_id,deleted_at,status,sort_order,id);
