-- Activity chronology uses the audited payment creation time rather than the
-- independently selected payment value date.

CREATE INDEX payments_group_created_page_idx
    ON payments(group_id, strftime('%Y-%m-%dT%H:%M:%fZ', created_at) DESC, id DESC);

CREATE INDEX payments_group_member_created_page_idx
    ON payments(group_id, membership_id, strftime('%Y-%m-%dT%H:%M:%fZ', created_at) DESC, id DESC);
