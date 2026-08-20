// Package finance implements member accounts, payments, FIFO allocation, and statistics.
package finance

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/idempotency"
	"github.com/DasLukas/TeamTaler/internal/ledger"
	"github.com/DasLukas/TeamTaler/internal/media"
	"github.com/DasLukas/TeamTaler/internal/notifications"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
	"github.com/DasLukas/TeamTaler/internal/tablequery"
)

// Service implements finance commands and read models over a migrated TeamTaler
// database.
type Service struct {
	// DB is the shared application database connection pool.
	DB *sql.DB
	// Notifications atomically records member-visible payment events.
	Notifications notifications.Service
}

func requirePermission(ctx context.Context, queryer authorization.Queryer, membership domain.Membership, permission domain.PermissionKey) error {
	allowed, err := authorization.NewPolicy(queryer).Can(ctx, membership.GroupID, membership.ID, permission, authorization.ResourceContext{GroupID: membership.GroupID})
	if err != nil {
		return err
	}
	if !allowed {
		return domain.ErrForbidden
	}
	return nil
}

// CategoryStatistic summarizes booking and reversal totals for a category
// without exposing other member identities. Its period scope follows the
// group's settlement setting.
type CategoryStatistic struct {
	CategoryID   string              `json:"categoryId"`
	CategoryName string              `json:"categoryName"`
	Icon         domain.CategoryIcon `json:"icon"`
	Quantity     int64               `json:"quantity"`
	GrossMinor   int64               `json:"grossMinor,string"`
	VoidedMinor  int64               `json:"voidedMinor,string"`
	NetMinor     int64               `json:"netMinor,string"`
}

// Account is the current consolidated account for a member, combining the
// append-only ledger, settlement-aware category statistics, and recent activity.
type Account struct {
	MembershipID       string              `json:"membershipId"`
	DisplayName        string              `json:"displayName"`
	Currency           string              `json:"currency"`
	BalanceMinor       int64               `json:"balanceMinor,string"`
	OpenPeriodID       string              `json:"openPeriodId"`
	OpenPeriodDue      int64               `json:"openPeriodDueMinor,string"`
	CategoryStats      []CategoryStatistic `json:"categoryStatistics"`
	GroupCategoryStats []CategoryStatistic `json:"groupCategoryStatistics"`
	RecentEntries      []LedgerEntry       `json:"recentEntries"`
}

// AccountSummary exposes one group membership's consolidated receivable and
// credential-derived temporary-guest classification to authorized finance
// managers without returning credentials or ledger movements.
type AccountSummary struct {
	MembershipID     string `json:"membershipId"`
	DisplayName      string `json:"displayName"`
	AvatarURL        string `json:"avatarUrl,omitempty"`
	IsTemporaryGuest bool   `json:"isTemporaryGuest"`
	Status           string `json:"status"`
	Currency         string `json:"currency"`
	BalanceMinor     int64  `json:"balanceMinor,string"`
}

// LedgerEntry is one immutable movement on a member receivable account. Positive
// amounts increase debt and negative amounts reduce debt or create credit.
type LedgerEntry struct {
	ID          string  `json:"id"`
	PeriodID    string  `json:"periodId"`
	BookingID   *string `json:"bookingId,omitempty"`
	PaymentID   *string `json:"paymentId,omitempty"`
	ReversalOf  *string `json:"reversalOf,omitempty"`
	Type        string  `json:"type"`
	AmountMinor int64   `json:"amountMinor,string"`
	Description string  `json:"description"`
	CreatedAt   string  `json:"createdAt"`
}

// Dashboard is the group-scoped landing-page read model combining account,
// booking, notification, and optional permission-gated group totals.
type Dashboard struct {
	Account          Account          `json:"account"`
	OpenPeriod       domain.Period    `json:"openPeriod"`
	RecentBookings   []domain.Booking `json:"recentBookings"`
	UnreadCount      int64            `json:"unreadNotificationCount"`
	GroupOutstanding *int64           `json:"groupOutstandingMinor,omitempty,string"`
}

// GroupOutstanding returns the signed net receivable across every member
// account in membership's group when VIEW_GROUP_STATISTICS is effective.
// Positive values are owed to the group, negative values are member credit,
// and nil means the caller is not authorized to see the aggregate. The query
// intentionally spans every accounting period so settlement configuration and
// period close operations never change the current consolidated balance. ctx
// bounds authorization and SQL work; policy and database errors propagate.
func (s Service) GroupOutstanding(ctx context.Context, membership domain.Membership) (*int64, error) {
	allowed, err := authorization.NewPolicy(s.DB).Can(ctx, membership.GroupID, membership.ID, domain.PermissionViewGroupStatistics, authorization.GroupResource(membership.GroupID))
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, nil
	}
	var outstanding int64
	if err := s.DB.QueryRowContext(ctx, `SELECT coalesce(sum(amount_minor),0) FROM ledger_entries WHERE group_id=? AND account='MEMBER_RECEIVABLE'`, membership.GroupID).Scan(&outstanding); err != nil {
		return nil, err
	}
	return &outstanding, nil
}

// Account returns targetMembershipID's consolidated balance, settlement-aware
// statistics, permission-gated group aggregates, and recent ledger entries. An
// empty target selects membership itself; FINANCE_MANAGEMENT is required for a
// different target and VIEW_GROUP_STATISTICS controls the aggregate section.
// Category statistics cover the open period while settlements are enabled and
// all periods while they are disabled; the consolidated balance never changes.
// ctx bounds queries. It returns the Account or forbidden, not-found, and SQL errors.
func (s Service) Account(ctx context.Context, membership domain.Membership, targetMembershipID string) (Account, error) {
	if targetMembershipID == "" {
		targetMembershipID = membership.ID
	}
	if targetMembershipID != membership.ID {
		if err := requirePermission(ctx, s.DB, membership, domain.PermissionFinanceManagement); err != nil {
			return Account{}, err
		}
	}
	var account Account
	account.MembershipID = targetMembershipID
	err := s.DB.QueryRowContext(ctx, `SELECT u.display_name,g.currency,coalesce(sum(le.amount_minor),0)
		FROM memberships m JOIN users u ON u.id=m.user_id JOIN groups g ON g.id=m.group_id
		LEFT JOIN ledger_entries le ON le.group_id=m.group_id AND le.membership_id=m.id AND le.account='MEMBER_RECEIVABLE'
		WHERE m.id=? AND m.group_id=? GROUP BY u.display_name,g.currency`, targetMembershipID, membership.GroupID).
		Scan(&account.DisplayName, &account.Currency, &account.BalanceMinor)
	if errors.Is(err, sql.ErrNoRows) {
		return Account{}, domain.ErrNotFound
	}
	if err != nil {
		return Account{}, err
	}
	var settlementsEnabled bool
	if err := s.DB.QueryRowContext(ctx, `SELECT p.id,gs.settlements_enabled
		FROM periods p JOIN group_settings gs ON gs.group_id=p.group_id
		WHERE p.group_id=? AND p.status='OPEN'`, membership.GroupID).Scan(&account.OpenPeriodID, &settlementsEnabled); err != nil {
		return Account{}, err
	}
	if err := s.DB.QueryRowContext(ctx, `SELECT coalesce(sum(amount_minor),0) FROM ledger_entries WHERE group_id=? AND period_id=? AND membership_id=? AND account='MEMBER_RECEIVABLE'`,
		membership.GroupID, account.OpenPeriodID, targetMembershipID).Scan(&account.OpenPeriodDue); err != nil {
		return Account{}, err
	}
	statisticsPeriodID := ""
	if settlementsEnabled {
		statisticsPeriodID = account.OpenPeriodID
	}
	account.CategoryStats, err = s.categoryStatistics(ctx, membership.GroupID, targetMembershipID, statisticsPeriodID)
	if err != nil {
		return Account{}, err
	}
	account.GroupCategoryStats = make([]CategoryStatistic, 0)
	canViewGroupStatistics, err := authorization.NewPolicy(s.DB).Can(ctx, membership.GroupID, membership.ID, domain.PermissionViewGroupStatistics, authorization.GroupResource(membership.GroupID))
	if err != nil {
		return Account{}, err
	}
	if canViewGroupStatistics {
		account.GroupCategoryStats, err = s.categoryStatistics(ctx, membership.GroupID, "", statisticsPeriodID)
		if err != nil {
			return Account{}, err
		}
	}
	entries, err := s.DB.QueryContext(ctx, `SELECT id,period_id,booking_id,payment_id,reversal_of,
		CASE WHEN reversal_of IS NOT NULL THEN 'REVERSAL' WHEN booking_id IS NOT NULL THEN 'BOOKING' WHEN payment_id IS NOT NULL THEN 'PAYMENT' ELSE 'ADJUSTMENT' END,
		amount_minor,description,created_at
		FROM ledger_entries WHERE group_id=? AND membership_id=? AND account='MEMBER_RECEIVABLE'
		ORDER BY created_at DESC,id DESC LIMIT 50`, membership.GroupID, targetMembershipID)
	if err != nil {
		return Account{}, err
	}
	defer entries.Close()
	account.RecentEntries = make([]LedgerEntry, 0)
	for entries.Next() {
		var entry LedgerEntry
		if err := entries.Scan(&entry.ID, &entry.PeriodID, &entry.BookingID, &entry.PaymentID, &entry.ReversalOf, &entry.Type, &entry.AmountMinor, &entry.Description, &entry.CreatedAt); err != nil {
			return Account{}, err
		}
		account.RecentEntries = append(account.RecentEntries, entry)
	}
	return account, entries.Err()
}

// MovementQuery describes a server-side member-receivable movement query.
// CreatedAt bounds accept ISO 8601 dates or RFC 3339 timestamps. Amount bounds
// are inclusive signed minor units.
type MovementQuery struct {
	Search      string
	PeriodID    string
	Type        string
	CreatedFrom string
	CreatedTo   string
	AmountMin   *int64
	AmountMax   *int64
	Sort        string
	Direction   string
	Cursor      string
	Limit       int
}

// MovementPage is one stable keyset-paginated receivable movement slice.
type MovementPage struct {
	Items      []LedgerEntry
	NextCursor string
}

var movementSorts = map[string]struct{}{
	"createdAt": {}, "amount": {}, "description": {}, "type": {},
}

const (
	movementCreatedExpression = `strftime('%Y-%m-%dT%H:%M:%fZ',entry.created_at)`
	movementTypeExpression    = `CASE WHEN entry.reversal_of IS NOT NULL THEN 'REVERSAL' WHEN entry.booking_id IS NOT NULL THEN 'BOOKING' WHEN entry.payment_id IS NOT NULL THEN 'PAYMENT' ELSE 'ADJUSTMENT' END`
)

// movementSortExpression maps a normalized public sort key to a closed SQL
// expression. The default is intentionally safe so caller input is never
// reflected into query text even if validation is accidentally bypassed.
func movementSortExpression(sortKey string) string {
	switch sortKey {
	case "amount":
		return "entry.amount_minor"
	case "description":
		return "lower(entry.description)"
	case "type":
		return movementTypeExpression
	default:
		return movementCreatedExpression
	}
}

// QueryMovements returns a tenant- and membership-scoped movement page. The
// authenticated membership may read itself; FINANCE_MANAGEMENT is required for
// another target membership.
func (s Service) QueryMovements(ctx context.Context, membership domain.Membership, targetMembershipID string, input MovementQuery) (MovementPage, error) {
	targetMembershipID = strings.TrimSpace(targetMembershipID)
	if targetMembershipID == "" {
		targetMembershipID = membership.ID
	}
	if targetMembershipID != membership.ID {
		if err := requirePermission(ctx, s.DB, membership, domain.PermissionFinanceManagement); err != nil {
			return MovementPage{}, err
		}
	}
	var targetExists int
	if err := s.DB.QueryRowContext(ctx, `SELECT count(*) FROM memberships WHERE group_id=? AND id=?`, membership.GroupID, targetMembershipID).Scan(&targetExists); err != nil {
		return MovementPage{}, err
	}
	if targetExists != 1 {
		return MovementPage{}, domain.ErrNotFound
	}
	var err error
	input.Search, err = tablequery.NormalizeSearch(input.Search)
	if err != nil {
		return MovementPage{}, err
	}
	input.Sort, input.Direction, err = tablequery.NormalizeSort(input.Sort, input.Direction, "createdAt", "desc", movementSorts)
	if err != nil {
		return MovementPage{}, err
	}
	input.CreatedFrom, err = tablequery.NormalizeTimeBound("createdFrom", input.CreatedFrom, false)
	if err != nil {
		return MovementPage{}, err
	}
	input.CreatedTo, err = tablequery.NormalizeTimeBound("createdTo", input.CreatedTo, true)
	if err != nil {
		return MovementPage{}, err
	}
	if input.CreatedFrom != "" && input.CreatedTo != "" && input.CreatedFrom >= input.CreatedTo {
		return MovementPage{}, domain.ValidationError{Field: "createdTo", Message: "must be later than createdFrom"}
	}
	if input.AmountMin != nil && input.AmountMax != nil && *input.AmountMin > *input.AmountMax {
		return MovementPage{}, domain.ValidationError{Field: "amountMax", Message: "must be greater than or equal to amountMin"}
	}
	input.PeriodID = strings.TrimSpace(input.PeriodID)
	input.Type = strings.ToUpper(strings.TrimSpace(input.Type))
	if input.Type != "" && input.Type != "BOOKING" && input.Type != "PAYMENT" && input.Type != "REVERSAL" && input.Type != "ADJUSTMENT" {
		return MovementPage{}, domain.ValidationError{Field: "type", Message: "must be BOOKING, PAYMENT, REVERSAL, or ADJUSTMENT"}
	}
	if input.Limit < 1 || input.Limit > 200 {
		input.Limit = 100
	}
	fingerprint, err := tablequery.Fingerprint(struct {
		GroupID, MembershipID, Search, PeriodID, Type, CreatedFrom, CreatedTo, Sort, Direction string
		AmountMin, AmountMax                                                                   *int64
	}{membership.GroupID, targetMembershipID, input.Search, input.PeriodID, input.Type, input.CreatedFrom, input.CreatedTo, input.Sort, input.Direction, input.AmountMin, input.AmountMax})
	if err != nil {
		return MovementPage{}, err
	}
	cursorKey, cursorID, err := tablequery.DecodeCursor(input.Cursor, fingerprint, input.Sort, input.Direction)
	if err != nil {
		return MovementPage{}, err
	}
	sortExpression := movementSortExpression(input.Sort)
	orderKeyword, comparison := tablequery.SQLOrderFragments(input.Direction)
	query := `SELECT entry.id,entry.period_id,entry.booking_id,entry.payment_id,entry.reversal_of,` + movementTypeExpression + `,
		entry.amount_minor,entry.description,entry.created_at,CAST(` + sortExpression + ` AS TEXT)
		FROM ledger_entries entry
		WHERE entry.group_id=? AND entry.membership_id=? AND entry.account='MEMBER_RECEIVABLE'`
	args := []any{membership.GroupID, targetMembershipID}
	if input.PeriodID != "" {
		query += ` AND entry.period_id=?`
		args = append(args, input.PeriodID)
	}
	if input.Type != "" {
		query += ` AND ` + movementTypeExpression + `=?`
		args = append(args, input.Type)
	}
	if input.CreatedFrom != "" {
		query += ` AND ` + movementCreatedExpression + `>=?`
		args = append(args, input.CreatedFrom)
	}
	if input.CreatedTo != "" {
		query += ` AND ` + movementCreatedExpression + `<?`
		args = append(args, input.CreatedTo)
	}
	if input.AmountMin != nil {
		query += ` AND entry.amount_minor>=?`
		args = append(args, *input.AmountMin)
	}
	if input.AmountMax != nil {
		query += ` AND entry.amount_minor<=?`
		args = append(args, *input.AmountMax)
	}
	if input.Search != "" {
		pattern := tablequery.LikePattern(input.Search)
		query += ` AND (entry.description LIKE ? ESCAPE '\' COLLATE NOCASE
			OR CAST(entry.amount_minor AS TEXT) LIKE ? ESCAPE '\'
			OR ` + movementTypeExpression + ` LIKE ? ESCAPE '\' COLLATE NOCASE)`
		args = append(args, pattern, pattern, pattern)
	}
	if cursorID != "" {
		var boundKey any = cursorKey
		if input.Sort == "amount" {
			boundKey, err = strconv.ParseInt(cursorKey, 10, 64)
			if err != nil {
				return MovementPage{}, domain.ValidationError{Field: "cursor", Message: "is invalid or does not match the current query"}
			}
		}
		query += ` AND (` + sortExpression + ` ` + comparison + ` ? OR (` + sortExpression + ` = ? AND entry.id ` + comparison + ` ?))`
		args = append(args, boundKey, boundKey, cursorID)
	}
	query += ` ORDER BY ` + sortExpression + ` ` + orderKeyword + `,entry.id ` + orderKeyword + ` LIMIT ?`
	args = append(args, input.Limit+1)
	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return MovementPage{}, err
	}
	defer rows.Close()
	items := make([]LedgerEntry, 0)
	sortKeys := make([]string, 0)
	for rows.Next() {
		var item LedgerEntry
		var sortKey string
		if err := rows.Scan(&item.ID, &item.PeriodID, &item.BookingID, &item.PaymentID, &item.ReversalOf,
			&item.Type, &item.AmountMinor, &item.Description, &item.CreatedAt, &sortKey); err != nil {
			return MovementPage{}, err
		}
		items = append(items, item)
		sortKeys = append(sortKeys, sortKey)
	}
	if err := rows.Err(); err != nil {
		return MovementPage{}, err
	}
	page := MovementPage{Items: items}
	if len(items) > input.Limit {
		page.Items = items[:input.Limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor, err = tablequery.EncodeCursor(fingerprint, input.Sort, input.Direction, sortKeys[input.Limit-1], last.ID)
		if err != nil {
			return MovementPage{}, err
		}
	}
	return page, nil
}

// categoryStatistics returns category totals for an optional member and period
// scope. Empty scope identifiers deliberately mean the entire group history.
func (s Service) categoryStatistics(ctx context.Context, groupID, membershipID, periodID string) ([]CategoryStatistic, error) {
	query := `WITH booking_statistics AS (
		SELECT category_id,
			coalesce(sum(CASE WHEN voided_at IS NULL THEN quantity ELSE 0 END),0) AS quantity,
			coalesce(sum(total_minor),0) AS gross_minor
		FROM bookings WHERE group_id=?`
	args := []any{groupID}
	if membershipID != "" {
		query += ` AND target_membership_id=?`
		args = append(args, membershipID)
	}
	if periodID != "" {
		query += ` AND period_id=?`
		args = append(args, periodID)
	}
	query += ` GROUP BY category_id
	), ledger_statistics AS (
		SELECT category_id,
			coalesce(-sum(CASE WHEN reversal_of IS NOT NULL AND amount_minor<0 THEN amount_minor ELSE 0 END),0) AS voided_minor,
			coalesce(sum(CASE WHEN payment_id IS NULL THEN amount_minor ELSE 0 END),0) AS net_minor
		FROM ledger_entries
		WHERE group_id=? AND account='MEMBER_RECEIVABLE' AND category_id IS NOT NULL`
	args = append(args, groupID)
	if membershipID != "" {
		query += ` AND membership_id=?`
		args = append(args, membershipID)
	}
	if periodID != "" {
		query += ` AND period_id=?`
		args = append(args, periodID)
	}
	query += ` GROUP BY category_id
	)
	SELECT c.id,c.name,c.icon,
		coalesce(bs.quantity,0),coalesce(bs.gross_minor,0),
		coalesce(ls.voided_minor,0),coalesce(ls.net_minor,0)
	FROM categories c
	LEFT JOIN booking_statistics bs ON bs.category_id=c.id
	LEFT JOIN ledger_statistics ls ON ls.category_id=c.id
	WHERE c.group_id=? ORDER BY c.sort_order,lower(c.name)`
	args = append(args, groupID)
	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]CategoryStatistic, 0)
	for rows.Next() {
		var statistic CategoryStatistic
		if err := rows.Scan(&statistic.CategoryID, &statistic.CategoryName, &statistic.Icon, &statistic.Quantity, &statistic.GrossMinor, &statistic.VoidedMinor, &statistic.NetMinor); err != nil {
			return nil, err
		}
		result = append(result, statistic)
	}
	return result, rows.Err()
}

// ListAccountSummaries returns every operational membership and each deleted
// tombstone that currently has a non-zero consolidated receivable balance. The
// caller must have finance-manager privileges in the requested group. Results
// are grouped by lifecycle status, then ordered by descending balance and
// display name.
func (s Service) ListAccountSummaries(ctx context.Context, membership domain.Membership) ([]AccountSummary, error) {
	if err := requirePermission(ctx, s.DB, membership, domain.PermissionFinanceManagement); err != nil {
		return nil, err
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT m.id,u.id,u.display_name,
		CASE WHEN m.deleted_at IS NULL THEN u.avatar_key ELSE NULL END,
		(m.deleted_at IS NULL AND u.email IS NULL AND u.password_hash IS NULL),
		CASE WHEN m.deleted_at IS NOT NULL THEN 'DELETED' ELSE m.status END,
		g.currency,coalesce(sum(le.amount_minor),0)
		FROM memberships m
		JOIN users u ON u.id=m.user_id
		JOIN groups g ON g.id=m.group_id
		LEFT JOIN ledger_entries le ON le.group_id=m.group_id AND le.membership_id=m.id AND le.account='MEMBER_RECEIVABLE'
		WHERE m.group_id=?
		GROUP BY m.id,u.id,u.display_name,u.avatar_key,u.email,u.password_hash,m.status,m.deleted_at,g.currency
		HAVING m.deleted_at IS NULL OR coalesce(sum(le.amount_minor),0) != 0
		ORDER BY CASE WHEN m.deleted_at IS NOT NULL THEN 2 WHEN m.status='ACTIVE' THEN 0 ELSE 1 END,
			coalesce(sum(le.amount_minor),0) DESC,lower(u.display_name),m.id`, membership.GroupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]AccountSummary, 0)
	for rows.Next() {
		var item AccountSummary
		var userID string
		var avatarKey sql.NullString
		if err := rows.Scan(&item.MembershipID, &userID, &item.DisplayName, &avatarKey, &item.IsTemporaryGuest, &item.Status, &item.Currency, &item.BalanceMinor); err != nil {
			return nil, err
		}
		item.AvatarURL = media.UserAvatarURL(userID, avatarKey.String)
		result = append(result, item)
	}
	return result, rows.Err()
}

// CreatePaymentInput is the received-money command. AmountMinor uses the group's
// currency minor unit and ReceivedAt, when set, must be RFC 3339.
type CreatePaymentInput struct {
	MembershipID string `json:"membershipId"`
	AmountMinor  int64  `json:"amountMinor"`
	ReceivedAt   string `json:"receivedAt"`
	Method       string `json:"method"`
	Reference    string `json:"reference,omitempty"`
	Note         string `json:"note,omitempty"`
}

// CreateOwnPaymentInput is the self-service payment command. The target
// membership is intentionally absent and is derived from the authenticated
// membership by CreateOwnPayment.
type CreateOwnPaymentInput struct {
	AmountMinor int64  `json:"amountMinor"`
	ReceivedAt  string `json:"receivedAt"`
	Method      string `json:"method"`
	Reference   string `json:"reference,omitempty"`
}

const (
	paymentSourceFinanceWorkspace = "FINANCE_WORKSPACE"
	paymentSourceSelfService      = "SELF_SERVICE"
)

// CreatePayment validates finance authorization and idempotencyKey, records
// input, creates balanced ledger entries and a notification, and allocates funds
// to the oldest remaining claims. ctx bounds the transaction; actor is audited.
// It returns the created or replayed Payment, or validation, forbidden,
// not-found, idempotency, audit, and database errors.
func (s Service) CreatePayment(ctx context.Context, actor domain.Principal, membership domain.Membership, idempotencyKey string, input CreatePaymentInput) (domain.Payment, error) {
	if err := requirePermission(ctx, s.DB, membership, domain.PermissionFinanceManagement); err != nil {
		return domain.Payment{}, err
	}
	return s.createPayment(ctx, actor, membership, idempotencyKey, input, true, paymentSourceFinanceWorkspace)
}

// CreateOwnPayment records a payment for the authenticated membership only.
// The caller must have RECORD_OWN_PAYMENT; FINANCE_MANAGEMENT does not imply
// this independent self-service permission. The resulting payment is
// immediately posted, audited, and FIFO-allocated without creating a redundant
// notification for the actor.
func (s Service) CreateOwnPayment(ctx context.Context, actor domain.Principal, membership domain.Membership, idempotencyKey string, input CreateOwnPaymentInput) (domain.Payment, error) {
	if err := requirePermission(ctx, s.DB, membership, domain.PermissionRecordOwnPayment); err != nil {
		return domain.Payment{}, err
	}
	input.ReceivedAt = strings.TrimSpace(input.ReceivedAt)
	if input.ReceivedAt == "" {
		return domain.Payment{}, domain.ValidationError{Field: "receivedAt", Message: "is required"}
	}
	input.Reference = strings.TrimSpace(input.Reference)
	return s.createPayment(ctx, actor, membership, idempotencyKey, CreatePaymentInput{
		MembershipID: membership.ID,
		AmountMinor:  input.AmountMinor,
		ReceivedAt:   input.ReceivedAt,
		Method:       input.Method,
		Reference:    input.Reference,
	}, false, paymentSourceSelfService)
}

func (s Service) createPayment(ctx context.Context, actor domain.Principal, membership domain.Membership, idempotencyKey string, input CreatePaymentInput, notifyTarget bool, source string) (domain.Payment, error) {
	if len(idempotencyKey) < 8 || len(idempotencyKey) > 200 {
		return domain.Payment{}, domain.ValidationError{Field: "Idempotency-Key", Message: "must contain 8 to 200 characters"}
	}
	storedIdempotencyKey := idempotencyKey
	if source == paymentSourceSelfService {
		storedIdempotencyKey = "self:" + idempotencyKey
	}
	input.MembershipID = strings.TrimSpace(input.MembershipID)
	input.Method = strings.TrimSpace(input.Method)
	input.Reference = strings.TrimSpace(input.Reference)
	input.Note = strings.TrimSpace(input.Note)
	if len(input.Reference) > 120 {
		return domain.Payment{}, domain.ValidationError{Field: "reference", Message: "must contain at most 120 characters"}
	}
	if len(input.Note) > 1000 {
		return domain.Payment{}, domain.ValidationError{Field: "note", Message: "must contain at most 1000 characters"}
	}
	if input.AmountMinor <= 0 || input.AmountMinor > 100_000_000_000 {
		return domain.Payment{}, domain.ValidationError{Field: "amountMinor", Message: "must be a positive, reasonable integer"}
	}
	if input.Method == "" || len(input.Method) > 120 {
		return domain.Payment{}, domain.ValidationError{Field: "method", Message: "must identify a configured payment method"}
	}
	receivedAt := platform.Now()
	if input.ReceivedAt != "" {
		parsed, err := time.Parse(time.RFC3339, input.ReceivedAt)
		if err != nil {
			return domain.Payment{}, domain.ValidationError{Field: "receivedAt", Message: "must be an RFC 3339 timestamp"}
		}
		receivedAt = parsed.UTC()
	}
	encodedRequest, _ := json.Marshal(input)
	digest := sha256.Sum256(encodedRequest)
	requestHash := hex.EncodeToString(digest[:])
	var payment domain.Payment
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if source == paymentSourceSelfService {
			if err := requirePermission(ctx, tx, membership, domain.PermissionRecordOwnPayment); err != nil {
				return err
			}
		} else if err := requirePermission(ctx, tx, membership, domain.PermissionFinanceManagement); err != nil {
			return err
		}
		var storedHash, storedResponse string
		err := tx.QueryRowContext(ctx, `SELECT request_hash,response_json FROM idempotency_results WHERE group_id=? AND actor_user_id=? AND idempotency_key=?`,
			membership.GroupID, actor.UserID, storedIdempotencyKey).Scan(&storedHash, &storedResponse)
		if err == nil {
			if storedHash != requestHash {
				return domain.ErrIdempotencyReuse
			}
			if err := json.Unmarshal([]byte(storedResponse), &payment); err != nil {
				return err
			}
			return refreshPaymentMemberStateTx(ctx, tx, &payment)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err := tx.QueryRowContext(ctx, `SELECT label FROM group_payment_methods WHERE group_id=? AND id=?`, membership.GroupID, input.Method).Scan(&payment.MethodLabel); errors.Is(err, sql.ErrNoRows) {
			return domain.ValidationError{Field: "method", Message: "is not configured for this group"}
		} else if err != nil {
			return err
		}
		var ownReasonMode, otherReasonMode domain.ReasonMode
		if err := tx.QueryRowContext(ctx, `SELECT own_payment_reason_mode,other_payment_reason_mode FROM group_settings WHERE group_id=?`, membership.GroupID).Scan(&ownReasonMode, &otherReasonMode); err != nil {
			return err
		}
		reasonMode := ownReasonMode
		if source == paymentSourceFinanceWorkspace {
			reasonMode = otherReasonMode
		}
		if !reasonMode.Valid() {
			return fmt.Errorf("group %s has unsupported payment reason mode %q", membership.GroupID, reasonMode)
		}
		if reasonMode.Required() && input.Reference == "" {
			return domain.ValidationError{Field: "reference", Message: "is required"}
		}
		effectiveReference := input.Reference
		if !reasonMode.Enabled() {
			effectiveReference = ""
		}
		var currency, memberName, memberStatus string
		var deletedAt sql.NullString
		var currentBalance int64
		if err := tx.QueryRowContext(ctx, `SELECT u.display_name,m.status,m.deleted_at,
			coalesce((SELECT sum(le.amount_minor) FROM ledger_entries le
				WHERE le.group_id=m.group_id AND le.membership_id=m.id AND le.account='MEMBER_RECEIVABLE'),0)
			FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=? AND m.group_id=?`, input.MembershipID, membership.GroupID).
			Scan(&memberName, &memberStatus, &deletedAt, &currentBalance); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		if source == paymentSourceSelfService && (memberStatus != domain.MembershipStatusActive || deletedAt.Valid) {
			return domain.ErrNotFound
		}
		if deletedAt.Valid {
			memberStatus = domain.MembershipStatusDeleted
			if currentBalance <= 0 || input.AmountMinor > currentBalance {
				return fmt.Errorf("%w: deleted accounts accept only payments that settle their open balance", domain.ErrConflict)
			}
		}
		if err := tx.QueryRowContext(ctx, `SELECT currency FROM groups WHERE id=?`, membership.GroupID).Scan(&currency); err != nil {
			return err
		}
		var currentPeriod string
		if err := tx.QueryRowContext(ctx, `SELECT id FROM periods WHERE group_id=? AND status='OPEN'`, membership.GroupID).Scan(&currentPeriod); err != nil {
			return err
		}
		paymentID, _ := platform.NewID("pay")
		now := platform.Timestamp(platform.Now())
		ledgerDescription := "Payment received"
		if effectiveReference != "" {
			ledgerDescription += ": " + effectiveReference
		}
		payment = domain.Payment{ID: paymentID, GroupID: membership.GroupID, MembershipID: input.MembershipID, MemberName: memberName, MemberStatus: memberStatus, AmountMinor: input.AmountMinor,
			Currency: currency, ReceivedAt: platform.Timestamp(receivedAt), Method: input.Method, MethodLabel: payment.MethodLabel, Reference: effectiveReference, Note: input.Note, Status: "POSTED", Allocations: []domain.PaymentAllocation{}}
		_, err = tx.ExecContext(ctx, `INSERT INTO payments(id,group_id,membership_id,amount_minor,received_at,method,method_label,reference,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
			paymentID, membership.GroupID, input.MembershipID, input.AmountMinor, payment.ReceivedAt, input.Method, payment.MethodLabel, nullable(effectiveReference), nullable(input.Note), membership.ID, now)
		if err != nil {
			return err
		}
		if err := insertLedger(ctx, tx, membership.GroupID, currentPeriod, input.MembershipID, paymentID, "", "MEMBER_RECEIVABLE", -input.AmountMinor, ledgerDescription, now); err != nil {
			return err
		}
		if err := insertLedger(ctx, tx, membership.GroupID, currentPeriod, "", paymentID, "", "GROUP_CASH", input.AmountMinor, ledgerDescription, now); err != nil {
			return err
		}
		if err := ledger.RebuildPaymentAllocations(ctx, tx, membership.GroupID, input.MembershipID); err != nil {
			return err
		}
		allocationRows, err := tx.QueryContext(ctx, `SELECT period_id,amount_minor FROM payment_allocations WHERE payment_id=? ORDER BY rowid`, paymentID)
		if err != nil {
			return err
		}
		for allocationRows.Next() {
			var allocation domain.PaymentAllocation
			if err := allocationRows.Scan(&allocation.PeriodID, &allocation.AmountMinor); err != nil {
				allocationRows.Close()
				return err
			}
			payment.Allocations = append(payment.Allocations, allocation)
		}
		if err := allocationRows.Close(); err != nil {
			return err
		}
		if notifyTarget && membership.ID != input.MembershipID && memberStatus != domain.MembershipStatusDeleted {
			if _, err := s.Notifications.CreateTx(ctx, tx, notifications.CreateInput{
				GroupID: membership.GroupID, MembershipID: input.MembershipID,
				Type: notifications.TypePaymentRecorded, Title: "Zahlung eingegangen", Body: "Deinem Konto wurde eine Zahlung gutgeschrieben.",
				ResourceType: "payment", ResourceID: paymentID, CreatedAt: now,
				Context: notifications.EventContext{ActorName: membership.DisplayName, AmountMinor: input.AmountMinor, Currency: currency},
			}); err != nil {
				return err
			}
		}
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "payment.created", "payment", paymentID, map[string]any{"membershipId": input.MembershipID, "amountMinor": input.AmountMinor, "source": source}); err != nil {
			return err
		}
		encodedResponse, _ := json.Marshal(payment)
		_, err = tx.ExecContext(ctx, `INSERT INTO idempotency_results(group_id,actor_user_id,idempotency_key,request_hash,status_code,response_json,created_at) VALUES(?,?,?,?,201,?,?)`,
			membership.GroupID, actor.UserID, storedIdempotencyKey, requestHash, string(encodedResponse), now)
		return err
	})
	return payment, err
}

// ListPayments returns at most limit newest-first payments and allocations for
// membership's group. ctx bounds queries; finance privileges are required. It
// returns the slice or forbidden and SQL errors.
func (s Service) ListPayments(ctx context.Context, membership domain.Membership, limit int) ([]domain.Payment, error) {
	page, err := s.QueryPayments(ctx, membership, PaymentQuery{Limit: limit})
	return page.Items, err
}

// PaymentQuery describes a server-side finance payment table query. ReceivedAt
// bounds accept ISO 8601 dates or RFC 3339 timestamps; ReceivedFrom is inclusive
// and ReceivedTo is exclusive after date-only upper-bound normalization. Amount
// bounds are inclusive minor units.
type PaymentQuery struct {
	Search       string
	MembershipID string
	Method       string
	Status       string
	ReceivedFrom string
	ReceivedTo   string
	AmountMin    *int64
	AmountMax    *int64
	Sort         string
	Direction    string
	Cursor       string
	Limit        int
}

// PaymentPage is one stable keyset-paginated payment slice. NextCursor is empty
// when no further matching payment exists.
type PaymentPage struct {
	Items      []domain.Payment
	NextCursor string
}

var paymentSorts = map[string]struct{}{
	"receivedAt": {}, "amount": {}, "memberName": {}, "method": {}, "status": {},
}

const (
	paymentReceivedExpression = `strftime('%Y-%m-%dT%H:%M:%fZ',p.received_at)`
	paymentStatusExpression   = `CASE WHEN p.reversed_at IS NULL THEN 'POSTED' ELSE 'REVERSED' END`
)

// paymentSortExpression maps a normalized public sort key to a closed SQL
// expression. The default is intentionally safe so caller input is never
// reflected into query text even if validation is accidentally bypassed.
func paymentSortExpression(sortKey string) string {
	switch sortKey {
	case "amount":
		return "p.amount_minor"
	case "memberName":
		return "lower(u.display_name)"
	case "method":
		return "lower(coalesce(p.method_label,p.method))"
	case "status":
		return paymentStatusExpression
	default:
		return paymentReceivedExpression
	}
}

// QueryPayments returns a filtered, sorted, keyset-paginated payment page for
// one tenant. Finance-management permission is checked before query validation
// or storage access.
func (s Service) QueryPayments(ctx context.Context, membership domain.Membership, input PaymentQuery) (PaymentPage, error) {
	if err := requirePermission(ctx, s.DB, membership, domain.PermissionFinanceManagement); err != nil {
		return PaymentPage{}, err
	}
	var err error
	input.Search, err = tablequery.NormalizeSearch(input.Search)
	if err != nil {
		return PaymentPage{}, err
	}
	input.Sort, input.Direction, err = tablequery.NormalizeSort(input.Sort, input.Direction, "receivedAt", "desc", paymentSorts)
	if err != nil {
		return PaymentPage{}, err
	}
	input.ReceivedFrom, err = tablequery.NormalizeTimeBound("receivedFrom", input.ReceivedFrom, false)
	if err != nil {
		return PaymentPage{}, err
	}
	input.ReceivedTo, err = tablequery.NormalizeTimeBound("receivedTo", input.ReceivedTo, true)
	if err != nil {
		return PaymentPage{}, err
	}
	if input.ReceivedFrom != "" && input.ReceivedTo != "" && input.ReceivedFrom >= input.ReceivedTo {
		return PaymentPage{}, domain.ValidationError{Field: "receivedTo", Message: "must be later than receivedFrom"}
	}
	if input.AmountMin != nil && *input.AmountMin < 0 {
		return PaymentPage{}, domain.ValidationError{Field: "amountMin", Message: "must be zero or greater"}
	}
	if input.AmountMax != nil && *input.AmountMax < 0 {
		return PaymentPage{}, domain.ValidationError{Field: "amountMax", Message: "must be zero or greater"}
	}
	if input.AmountMin != nil && input.AmountMax != nil && *input.AmountMin > *input.AmountMax {
		return PaymentPage{}, domain.ValidationError{Field: "amountMax", Message: "must be greater than or equal to amountMin"}
	}
	input.MembershipID = strings.TrimSpace(input.MembershipID)
	input.Method = strings.TrimSpace(input.Method)
	input.Status = strings.ToUpper(strings.TrimSpace(input.Status))
	if input.Status != "" && input.Status != "POSTED" && input.Status != "REVERSED" {
		return PaymentPage{}, domain.ValidationError{Field: "status", Message: "must be POSTED or REVERSED"}
	}
	if input.Limit < 1 || input.Limit > 200 {
		input.Limit = 100
	}
	fingerprint, err := tablequery.Fingerprint(struct {
		GroupID, ViewerMembershipID                                                     string
		Search, MembershipID, Method, Status, ReceivedFrom, ReceivedTo, Sort, Direction string
		AmountMin, AmountMax                                                            *int64
	}{membership.GroupID, membership.ID, input.Search, input.MembershipID, input.Method, input.Status, input.ReceivedFrom, input.ReceivedTo, input.Sort, input.Direction, input.AmountMin, input.AmountMax})
	if err != nil {
		return PaymentPage{}, err
	}
	cursorKey, cursorID, err := tablequery.DecodeCursor(input.Cursor, fingerprint, input.Sort, input.Direction)
	if err != nil {
		return PaymentPage{}, err
	}
	sortExpression := paymentSortExpression(input.Sort)
	orderKeyword, comparison := tablequery.SQLOrderFragments(input.Direction)
	query := `SELECT p.id,p.group_id,p.membership_id,u.display_name,
		CASE WHEN m.deleted_at IS NOT NULL THEN 'DELETED' ELSE m.status END,
		p.amount_minor,g.currency,p.received_at,p.method,coalesce(p.method_label,''),coalesce(p.reference,''),coalesce(p.note,''),p.reversed_at,CAST(` + sortExpression + ` AS TEXT)
		FROM payments p JOIN groups g ON g.id=p.group_id JOIN memberships m ON m.id=p.membership_id JOIN users u ON u.id=m.user_id
		WHERE p.group_id=?`
	args := []any{membership.GroupID}
	if input.MembershipID != "" {
		query += ` AND p.membership_id=?`
		args = append(args, input.MembershipID)
	}
	if input.Method != "" {
		query += ` AND p.method=?`
		args = append(args, input.Method)
	}
	if input.Status == "POSTED" {
		query += ` AND p.reversed_at IS NULL`
	} else if input.Status == "REVERSED" {
		query += ` AND p.reversed_at IS NOT NULL`
	}
	if input.ReceivedFrom != "" {
		query += ` AND ` + paymentReceivedExpression + `>=?`
		args = append(args, input.ReceivedFrom)
	}
	if input.ReceivedTo != "" {
		query += ` AND ` + paymentReceivedExpression + `<?`
		args = append(args, input.ReceivedTo)
	}
	if input.AmountMin != nil {
		query += ` AND p.amount_minor>=?`
		args = append(args, *input.AmountMin)
	}
	if input.AmountMax != nil {
		query += ` AND p.amount_minor<=?`
		args = append(args, *input.AmountMax)
	}
	if input.Search != "" {
		pattern := tablequery.LikePattern(input.Search)
		query += ` AND (u.display_name LIKE ? ESCAPE '\' COLLATE NOCASE
			OR p.method LIKE ? ESCAPE '\' COLLATE NOCASE
			OR coalesce(p.method_label,'') LIKE ? ESCAPE '\' COLLATE NOCASE
			OR coalesce(p.reference,'') LIKE ? ESCAPE '\' COLLATE NOCASE
			OR coalesce(p.note,'') LIKE ? ESCAPE '\' COLLATE NOCASE
			OR CAST(p.amount_minor AS TEXT) LIKE ? ESCAPE '\'
			OR ` + paymentStatusExpression + ` LIKE ? ESCAPE '\' COLLATE NOCASE)`
		args = append(args, pattern, pattern, pattern, pattern, pattern, pattern, pattern)
	}
	if cursorID != "" {
		var boundKey any = cursorKey
		if input.Sort == "amount" {
			boundKey, err = strconv.ParseInt(cursorKey, 10, 64)
			if err != nil {
				return PaymentPage{}, domain.ValidationError{Field: "cursor", Message: "is invalid or does not match the current query"}
			}
		}
		query += ` AND (` + sortExpression + ` ` + comparison + ` ? OR (` + sortExpression + ` = ? AND p.id ` + comparison + ` ?))`
		args = append(args, boundKey, boundKey, cursorID)
	}
	query += ` ORDER BY ` + sortExpression + ` ` + orderKeyword + `,p.id ` + orderKeyword + ` LIMIT ?`
	args = append(args, input.Limit+1)
	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return PaymentPage{}, err
	}
	defer rows.Close()
	result := make([]domain.Payment, 0)
	sortKeys := make([]string, 0)
	for rows.Next() {
		var item domain.Payment
		var sortKey string
		if err := rows.Scan(&item.ID, &item.GroupID, &item.MembershipID, &item.MemberName, &item.MemberStatus, &item.AmountMinor, &item.Currency, &item.ReceivedAt, &item.Method, &item.MethodLabel, &item.Reference, &item.Note, &item.ReversedAt, &sortKey); err != nil {
			return PaymentPage{}, err
		}
		item.Status = "POSTED"
		if item.ReversedAt != nil {
			item.Status = "REVERSED"
		}
		result = append(result, item)
		sortKeys = append(sortKeys, sortKey)
	}
	if err := rows.Err(); err != nil {
		return PaymentPage{}, err
	}
	page := PaymentPage{Items: result}
	if len(result) > input.Limit {
		page.Items = result[:input.Limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor, err = tablequery.EncodeCursor(fingerprint, input.Sort, input.Direction, sortKeys[input.Limit-1], last.ID)
		if err != nil {
			return PaymentPage{}, err
		}
	}
	paymentIDs := make([]string, len(page.Items))
	for index := range page.Items {
		paymentIDs[index] = page.Items[index].ID
	}
	allocations, err := s.allocationsByPayment(ctx, membership.GroupID, paymentIDs)
	if err != nil {
		return PaymentPage{}, err
	}
	for index := range page.Items {
		page.Items[index].Allocations = allocations[page.Items[index].ID]
		if page.Items[index].Allocations == nil {
			page.Items[index].Allocations = make([]domain.PaymentAllocation, 0)
		}
	}
	return page, nil
}

// allocationsByPayment loads every allocation for a bounded payment page in a
// single query, avoiding one database round trip per rendered table row.
func (s Service) allocationsByPayment(ctx context.Context, groupID string, paymentIDs []string) (map[string][]domain.PaymentAllocation, error) {
	result := make(map[string][]domain.PaymentAllocation, len(paymentIDs))
	if len(paymentIDs) == 0 {
		return result, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(paymentIDs)), ",")
	args := make([]any, 0, len(paymentIDs)+1)
	args = append(args, groupID)
	for _, paymentID := range paymentIDs {
		args = append(args, paymentID)
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT payment_id,period_id,amount_minor
		FROM payment_allocations WHERE group_id=? AND payment_id IN (`+placeholders+`)
		ORDER BY payment_id,period_id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var paymentID string
		var allocation domain.PaymentAllocation
		if err := rows.Scan(&paymentID, &allocation.PeriodID, &allocation.AmountMinor); err != nil {
			return nil, err
		}
		result[paymentID] = append(result[paymentID], allocation)
	}
	return result, rows.Err()
}

func (s Service) allocations(ctx context.Context, paymentID string) ([]domain.PaymentAllocation, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT period_id,amount_minor FROM payment_allocations WHERE payment_id=? ORDER BY period_id`, paymentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.PaymentAllocation, 0)
	for rows.Next() {
		var item domain.PaymentAllocation
		if err := rows.Scan(&item.PeriodID, &item.AmountMinor); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

// ReversePayment idempotently reverses paymentID, creates balanced reversal
// ledger entries in the open period, and rebuilds claim allocations while
// preserving the original. ctx bounds the transaction; actor and membership
// scope audit/authorization. It returns validation, forbidden, not-found,
// conflict, idempotency, audit, or SQL errors.
func (s Service) ReversePayment(ctx context.Context, actor domain.Principal, membership domain.Membership, idempotencyKey, paymentID, reason string) error {
	if err := requirePermission(ctx, s.DB, membership, domain.PermissionFinanceManagement); err != nil {
		return err
	}
	if err := idempotency.ValidateKey(idempotencyKey); err != nil {
		return err
	}
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return domain.ValidationError{Field: "reason", Message: "is required"}
	}
	if len(reason) > 500 {
		return domain.ValidationError{Field: "reason", Message: "must contain at most 500 characters"}
	}
	requestHash, err := idempotency.Hash(map[string]any{"action": "payment.reverse", "paymentId": paymentID, "reason": reason})
	if err != nil {
		return err
	}
	return storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requirePermission(ctx, tx, membership, domain.PermissionFinanceManagement); err != nil {
			return err
		}
		var replay map[string]any
		found, err := idempotency.Load(ctx, tx, membership.GroupID, actor.UserID, idempotencyKey, requestHash, &replay)
		if err != nil || found {
			return err
		}
		var reversed sql.NullString
		var targetMembershipID, currency string
		var targetDeletedAt sql.NullString
		var amountMinor int64
		if err := tx.QueryRowContext(ctx, `SELECT p.reversed_at,p.membership_id,p.amount_minor,g.currency,m.deleted_at
			FROM payments p JOIN groups g ON g.id=p.group_id JOIN memberships m ON m.id=p.membership_id
			WHERE p.id=? AND p.group_id=?`, paymentID, membership.GroupID).Scan(&reversed, &targetMembershipID, &amountMinor, &currency, &targetDeletedAt); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		if reversed.Valid {
			return domain.ErrConflict
		}
		var currentPeriod string
		if err := tx.QueryRowContext(ctx, `SELECT id FROM periods WHERE group_id=? AND status='OPEN'`, membership.GroupID).Scan(&currentPeriod); err != nil {
			return err
		}
		now := platform.Timestamp(platform.Now())
		update, err := tx.ExecContext(ctx, `UPDATE payments SET reversed_at=?,reversed_by=?,reversal_reason=? WHERE id=? AND reversed_at IS NULL`, now, membership.ID, reason, paymentID)
		if err != nil {
			return err
		}
		changed, _ := update.RowsAffected()
		if changed != 1 {
			return domain.ErrConflict
		}
		rows, err := tx.QueryContext(ctx, `SELECT id,membership_id,account,amount_minor,description FROM ledger_entries WHERE group_id=? AND payment_id=? AND reversal_of IS NULL`, membership.GroupID, paymentID)
		if err != nil {
			return err
		}
		type original struct {
			id, member, account, description string
			amount                           int64
		}
		var originals []original
		for rows.Next() {
			var item original
			var member sql.NullString
			if err := rows.Scan(&item.id, &member, &item.account, &item.amount, &item.description); err != nil {
				rows.Close()
				return err
			}
			item.member = member.String
			originals = append(originals, item)
		}
		rows.Close()
		for _, entry := range originals {
			if err := insertLedger(ctx, tx, membership.GroupID, currentPeriod, entry.member, paymentID, entry.id, entry.account, -entry.amount, "Reversal: "+entry.description, now); err != nil {
				return err
			}
		}
		if err := ledger.RebuildPaymentAllocations(ctx, tx, membership.GroupID, targetMembershipID); err != nil {
			return err
		}
		if membership.ID != targetMembershipID && !targetDeletedAt.Valid {
			if _, err := s.Notifications.CreateTx(ctx, tx, notifications.CreateInput{
				GroupID: membership.GroupID, MembershipID: targetMembershipID,
				Type: notifications.TypePaymentReversed, Title: "Zahlung storniert", Body: "Eine Zahlung auf deinem Konto wurde storniert.",
				ResourceType: "payment", ResourceID: paymentID, CreatedAt: now,
				Context: notifications.EventContext{ActorName: membership.DisplayName, AmountMinor: amountMinor, Currency: currency},
			}); err != nil {
				return err
			}
		}
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "payment.reversed", "payment", paymentID, map[string]any{"reason": reason}); err != nil {
			return err
		}
		return idempotency.Store(ctx, tx, membership.GroupID, actor.UserID, idempotencyKey, requestHash, 204, map[string]any{"paymentId": paymentID, "status": "REVERSED"})
	})
}

func refreshPaymentMemberStateTx(ctx context.Context, tx *sql.Tx, payment *domain.Payment) error {
	if payment == nil || payment.MembershipID == "" {
		return domain.ValidationError{Field: "payment", Message: "requires a membership id"}
	}
	return tx.QueryRowContext(ctx, `SELECT u.display_name,CASE WHEN m.deleted_at IS NOT NULL THEN 'DELETED' ELSE m.status END
		FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=?`, payment.MembershipID).
		Scan(&payment.MemberName, &payment.MemberStatus)
}

func insertLedger(ctx context.Context, tx *sql.Tx, groupID, periodID, membershipID, paymentID, reversalOf, account string, amount int64, description, createdAt string) error {
	id, _ := platform.NewID("led")
	_, err := tx.ExecContext(ctx, `INSERT INTO ledger_entries(id,group_id,period_id,membership_id,payment_id,reversal_of,account,amount_minor,description,created_at)
		VALUES(?,?,?,nullif(?,''),?,nullif(?,''),?,?,?,?)`, id, groupID, periodID, membershipID, paymentID, reversalOf, account, amount, description, createdAt)
	return err
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}
