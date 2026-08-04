PRAGMA foreign_keys = ON;

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE memberships (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
    joined_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE (group_id, user_id),
    UNIQUE (group_id, id)
) STRICT;
CREATE INDEX memberships_user_idx ON memberships(user_id, status);

CREATE TABLE membership_roles (
    group_id TEXT NOT NULL,
    membership_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('ADMIN', 'FINANCE_MANAGER', 'CATALOG_MANAGER')),
    granted_at TEXT NOT NULL,
    granted_by TEXT,
    PRIMARY KEY (membership_id, role),
    FOREIGN KEY (group_id, membership_id) REFERENCES memberships(group_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX membership_roles_group_idx ON membership_roles(group_id, role);

CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    type TEXT NOT NULL DEFAULT 'STANDARD' CHECK (type IN ('STANDARD', 'PENALTY')),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (group_id, id)
) STRICT;
CREATE INDEX categories_group_idx ON categories(group_id, active, sort_order, name);

CREATE TABLE category_permissions (
    group_id TEXT NOT NULL,
    membership_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    permission TEXT NOT NULL CHECK (permission IN ('ASSIGN_TO_OTHERS', 'VOID_BOOKINGS')),
    granted_at TEXT NOT NULL,
    granted_by TEXT,
    PRIMARY KEY (membership_id, category_id, permission),
    FOREIGN KEY (group_id, membership_id) REFERENCES memberships(group_id, id) ON DELETE CASCADE,
    FOREIGN KEY (group_id, category_id) REFERENCES categories(group_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX category_permissions_group_idx ON category_permissions(group_id, category_id);

CREATE TABLE products (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    price_minor INTEGER NOT NULL CHECK (price_minor > 0),
    image_key TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (group_id, id),
    FOREIGN KEY (group_id, category_id) REFERENCES categories(group_id, id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX products_category_idx ON products(group_id, category_id, active, sort_order, name);

CREATE TABLE periods (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
    starts_at TEXT NOT NULL,
    closed_at TEXT,
    due_at TEXT,
    closed_by TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (group_id, id)
) STRICT;
CREATE UNIQUE INDEX periods_one_open_idx ON periods(group_id) WHERE status = 'OPEN';
CREATE INDEX periods_group_idx ON periods(group_id, starts_at DESC);

CREATE TABLE bookings (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    period_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    actor_membership_id TEXT NOT NULL,
    target_membership_id TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
    unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor > 0),
    total_minor INTEGER NOT NULL CHECK (total_minor > 0),
    product_name TEXT NOT NULL,
    category_name TEXT NOT NULL,
    category_type TEXT NOT NULL CHECK (category_type IN ('STANDARD', 'PENALTY')),
    reason TEXT,
    created_at TEXT NOT NULL,
    voided_at TEXT,
    voided_by TEXT,
    void_reason TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    UNIQUE (group_id, id),
    FOREIGN KEY (group_id, period_id) REFERENCES periods(group_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id, category_id) REFERENCES categories(group_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id, product_id) REFERENCES products(group_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id, actor_membership_id) REFERENCES memberships(group_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id, target_membership_id) REFERENCES memberships(group_id, id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX bookings_group_period_idx ON bookings(group_id, period_id, created_at DESC);
CREATE INDEX bookings_target_idx ON bookings(group_id, target_membership_id, created_at DESC);

CREATE TABLE payments (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    membership_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    received_at TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('CASH', 'BANK_TRANSFER', 'OTHER')),
    reference TEXT,
    note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    reversed_at TEXT,
    reversed_by TEXT,
    reversal_reason TEXT,
    UNIQUE (group_id, id),
    FOREIGN KEY (group_id, membership_id) REFERENCES memberships(group_id, id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX payments_member_idx ON payments(group_id, membership_id, received_at DESC);

CREATE TABLE payment_allocations (
	group_id TEXT NOT NULL,
	payment_id TEXT NOT NULL,
	period_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
	PRIMARY KEY (payment_id, period_id),
	FOREIGN KEY (group_id, payment_id) REFERENCES payments(group_id, id) ON DELETE RESTRICT,
	FOREIGN KEY (group_id, period_id) REFERENCES periods(group_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE period_adjustment_allocations (
	group_id TEXT NOT NULL,
	membership_id TEXT NOT NULL,
	source_period_id TEXT NOT NULL,
	target_period_id TEXT NOT NULL,
	amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
	PRIMARY KEY (membership_id, source_period_id, target_period_id),
	FOREIGN KEY (group_id, membership_id) REFERENCES memberships(group_id, id) ON DELETE RESTRICT,
	FOREIGN KEY (group_id, source_period_id) REFERENCES periods(group_id, id) ON DELETE RESTRICT,
	FOREIGN KEY (group_id, target_period_id) REFERENCES periods(group_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE ledger_entries (
    id TEXT PRIMARY KEY,
	group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
	period_id TEXT,
	membership_id TEXT,
	category_id TEXT,
	booking_id TEXT,
	payment_id TEXT,
	reversal_of TEXT,
    account TEXT NOT NULL CHECK (account IN ('MEMBER_RECEIVABLE', 'CATEGORY_REVENUE', 'GROUP_CASH')),
    amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
    description TEXT NOT NULL,
	created_at TEXT NOT NULL,
	UNIQUE (group_id, id),
	FOREIGN KEY (group_id, period_id) REFERENCES periods(group_id, id) ON DELETE RESTRICT,
	FOREIGN KEY (group_id, membership_id) REFERENCES memberships(group_id, id) ON DELETE RESTRICT,
	FOREIGN KEY (group_id, category_id) REFERENCES categories(group_id, id) ON DELETE RESTRICT,
	FOREIGN KEY (group_id, booking_id) REFERENCES bookings(group_id, id) ON DELETE RESTRICT,
	FOREIGN KEY (group_id, payment_id) REFERENCES payments(group_id, id) ON DELETE RESTRICT,
	FOREIGN KEY (group_id, reversal_of) REFERENCES ledger_entries(group_id, id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX ledger_group_member_idx ON ledger_entries(group_id, membership_id, created_at);
CREATE INDEX ledger_booking_idx ON ledger_entries(booking_id);
CREATE INDEX ledger_payment_idx ON ledger_entries(payment_id);
CREATE UNIQUE INDEX ledger_one_reversal_idx ON ledger_entries(reversal_of) WHERE reversal_of IS NOT NULL;

CREATE TABLE period_statements (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    period_id TEXT NOT NULL,
    membership_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL,
    charges_minor INTEGER NOT NULL,
    payments_allocated_minor INTEGER NOT NULL,
	adjustments_applied_minor INTEGER NOT NULL DEFAULT 0,
	adjustments_provided_minor INTEGER NOT NULL DEFAULT 0,
    amount_due_minor INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('OPEN', 'PARTIAL', 'PAID', 'CREDIT')),
    created_at TEXT NOT NULL,
    UNIQUE (period_id, membership_id),
    FOREIGN KEY (group_id, period_id) REFERENCES periods(group_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id, membership_id) REFERENCES memberships(group_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE invitations (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    display_name TEXT,
    token_hash TEXT NOT NULL UNIQUE,
    roles_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(roles_json)),
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    revoked_at TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;
CREATE INDEX invitations_group_idx ON invitations(group_id, created_at DESC);

CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    membership_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    read_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (group_id, membership_id) REFERENCES memberships(group_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX notifications_member_idx ON notifications(group_id, membership_id, read_at, created_at DESC);

CREATE TABLE audit_events (
    id TEXT PRIMARY KEY,
    group_id TEXT REFERENCES groups(id) ON DELETE RESTRICT,
    actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
    actor_membership_id TEXT REFERENCES memberships(id) ON DELETE RESTRICT,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    occurred_at TEXT NOT NULL
) STRICT;
CREATE INDEX audit_group_idx ON audit_events(group_id, occurred_at DESC);

CREATE TABLE idempotency_results (
    group_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    response_json TEXT NOT NULL CHECK (json_valid(response_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (group_id, actor_user_id, idempotency_key)
) STRICT;

CREATE TRIGGER ledger_entries_no_update
BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
CREATE TRIGGER ledger_entries_no_delete
BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
CREATE TRIGGER closed_period_no_update
BEFORE UPDATE ON periods WHEN OLD.status = 'CLOSED'
BEGIN SELECT RAISE(ABORT, 'closed periods are immutable'); END;
CREATE TRIGGER period_statements_no_update
BEFORE UPDATE ON period_statements BEGIN SELECT RAISE(ABORT, 'period statements are immutable'); END;
CREATE TRIGGER period_statements_no_delete
BEFORE DELETE ON period_statements BEGIN SELECT RAISE(ABORT, 'period statements are immutable'); END;
CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
