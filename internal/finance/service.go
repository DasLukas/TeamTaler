// Package finance implements member accounts, payments, FIFO allocation, and statistics.
package finance

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/idempotency"
	"github.com/DasLukas/TeamTaler/internal/ledger"
	"github.com/DasLukas/TeamTaler/internal/media"
	"github.com/DasLukas/TeamTaler/internal/notifications"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// Service implements finance commands and read models over a migrated TeamTaler
// database.
type Service struct {
	// DB is the shared application database connection pool.
	DB *sql.DB
	// Notifications atomically records member-visible payment events.
	Notifications notifications.Service
}

// CategoryStatistic summarizes current-period booking and reversal totals for a
// category without exposing other member identities.
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
// append-only ledger, current-period category statistics, and recent activity.
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

// AccountSummary exposes one group membership's consolidated receivable to
// authorized finance managers without returning its ledger movements.
type AccountSummary struct {
	MembershipID string `json:"membershipId"`
	DisplayName  string `json:"displayName"`
	AvatarURL    string `json:"avatarUrl,omitempty"`
	Status       string `json:"status"`
	Currency     string `json:"currency"`
	BalanceMinor int64  `json:"balanceMinor,string"`
}

// LedgerEntry is one immutable movement on a member receivable account. Positive
// amounts increase debt and negative amounts reduce debt or create credit.
type LedgerEntry struct {
	ID          string  `json:"id"`
	PeriodID    string  `json:"periodId"`
	BookingID   *string `json:"bookingId,omitempty"`
	PaymentID   *string `json:"paymentId,omitempty"`
	ReversalOf  *string `json:"reversalOf,omitempty"`
	AmountMinor int64   `json:"amountMinor,string"`
	Description string  `json:"description"`
	CreatedAt   string  `json:"createdAt"`
}

// Dashboard is the group-scoped landing-page read model combining account,
// booking, notification, and optional finance-manager totals.
type Dashboard struct {
	Account          Account          `json:"account"`
	OpenPeriod       domain.Period    `json:"openPeriod"`
	RecentBookings   []domain.Booking `json:"recentBookings"`
	UnreadCount      int64            `json:"unreadNotificationCount"`
	GroupOutstanding *int64           `json:"groupOutstandingMinor,omitempty,string"`
}

// Account returns targetMembershipID's consolidated balance, current-period
// statistics, anonymous group aggregates, and recent ledger entries. An empty
// target selects membership itself; finance privileges are required for others.
// ctx bounds queries. It returns the Account or forbidden, not-found, and SQL errors.
func (s Service) Account(ctx context.Context, membership domain.Membership, targetMembershipID string) (Account, error) {
	if targetMembershipID == "" {
		targetMembershipID = membership.ID
	}
	if targetMembershipID != membership.ID && !groups.HasRole(membership, domain.RoleFinanceManager) {
		return Account{}, domain.ErrForbidden
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
	if err := s.DB.QueryRowContext(ctx, `SELECT id FROM periods WHERE group_id=? AND status='OPEN'`, membership.GroupID).Scan(&account.OpenPeriodID); err != nil {
		return Account{}, err
	}
	if err := s.DB.QueryRowContext(ctx, `SELECT coalesce(sum(amount_minor),0) FROM ledger_entries WHERE group_id=? AND period_id=? AND membership_id=? AND account='MEMBER_RECEIVABLE'`,
		membership.GroupID, account.OpenPeriodID, targetMembershipID).Scan(&account.OpenPeriodDue); err != nil {
		return Account{}, err
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT c.id,c.name,c.icon,
		coalesce((SELECT sum(b.quantity) FROM bookings b WHERE b.category_id=c.id AND b.target_membership_id=? AND b.period_id=? AND b.voided_at IS NULL),0),
		coalesce((SELECT sum(b.total_minor) FROM bookings b WHERE b.category_id=c.id AND b.target_membership_id=? AND b.period_id=?),0),
		coalesce(-(SELECT sum(le.amount_minor) FROM ledger_entries le WHERE le.category_id=c.id AND le.membership_id=? AND le.period_id=? AND le.account='MEMBER_RECEIVABLE' AND le.reversal_of IS NOT NULL AND le.amount_minor<0),0),
		coalesce((SELECT sum(le.amount_minor) FROM ledger_entries le WHERE le.category_id=c.id AND le.membership_id=? AND le.period_id=? AND le.account='MEMBER_RECEIVABLE' AND le.payment_id IS NULL),0)
		FROM categories c WHERE c.group_id=? ORDER BY c.sort_order,lower(c.name)`,
		targetMembershipID, account.OpenPeriodID, targetMembershipID, account.OpenPeriodID, targetMembershipID, account.OpenPeriodID, targetMembershipID, account.OpenPeriodID, membership.GroupID)
	if err != nil {
		return Account{}, err
	}
	defer rows.Close()
	account.CategoryStats = make([]CategoryStatistic, 0)
	for rows.Next() {
		var statistic CategoryStatistic
		if err := rows.Scan(&statistic.CategoryID, &statistic.CategoryName, &statistic.Icon, &statistic.Quantity, &statistic.GrossMinor, &statistic.VoidedMinor, &statistic.NetMinor); err != nil {
			return Account{}, err
		}
		account.CategoryStats = append(account.CategoryStats, statistic)
	}
	if err := rows.Err(); err != nil {
		return Account{}, err
	}
	groupStats, err := s.DB.QueryContext(ctx, `SELECT c.id,c.name,c.icon,
		coalesce((SELECT sum(b.quantity) FROM bookings b WHERE b.category_id=c.id AND b.period_id=? AND b.voided_at IS NULL),0),
		coalesce((SELECT sum(b.total_minor) FROM bookings b WHERE b.category_id=c.id AND b.period_id=?),0),
		coalesce(-(SELECT sum(le.amount_minor) FROM ledger_entries le WHERE le.category_id=c.id AND le.period_id=? AND le.account='MEMBER_RECEIVABLE' AND le.reversal_of IS NOT NULL AND le.amount_minor<0),0),
		coalesce((SELECT sum(le.amount_minor) FROM ledger_entries le WHERE le.category_id=c.id AND le.period_id=? AND le.account='MEMBER_RECEIVABLE' AND le.payment_id IS NULL),0)
		FROM categories c WHERE c.group_id=? ORDER BY c.sort_order,lower(c.name)`,
		account.OpenPeriodID, account.OpenPeriodID, account.OpenPeriodID, account.OpenPeriodID, membership.GroupID)
	if err != nil {
		return Account{}, err
	}
	account.GroupCategoryStats = make([]CategoryStatistic, 0)
	for groupStats.Next() {
		var statistic CategoryStatistic
		if err := groupStats.Scan(&statistic.CategoryID, &statistic.CategoryName, &statistic.Icon, &statistic.Quantity, &statistic.GrossMinor, &statistic.VoidedMinor, &statistic.NetMinor); err != nil {
			groupStats.Close()
			return Account{}, err
		}
		account.GroupCategoryStats = append(account.GroupCategoryStats, statistic)
	}
	if err := groupStats.Close(); err != nil {
		return Account{}, err
	}
	entries, err := s.DB.QueryContext(ctx, `SELECT id,period_id,booking_id,payment_id,reversal_of,amount_minor,description,created_at
		FROM ledger_entries WHERE group_id=? AND membership_id=? AND account='MEMBER_RECEIVABLE'
		ORDER BY created_at DESC,id DESC LIMIT 50`, membership.GroupID, targetMembershipID)
	if err != nil {
		return Account{}, err
	}
	defer entries.Close()
	account.RecentEntries = make([]LedgerEntry, 0)
	for entries.Next() {
		var entry LedgerEntry
		if err := entries.Scan(&entry.ID, &entry.PeriodID, &entry.BookingID, &entry.PaymentID, &entry.ReversalOf, &entry.AmountMinor, &entry.Description, &entry.CreatedAt); err != nil {
			return Account{}, err
		}
		account.RecentEntries = append(account.RecentEntries, entry)
	}
	return account, entries.Err()
}

// ListAccountSummaries returns every active or archived membership with its
// consolidated receivable balance. The caller must have finance-manager
// privileges in the requested group. Results are grouped by membership status,
// then ordered by descending balance and display name.
func (s Service) ListAccountSummaries(ctx context.Context, membership domain.Membership) ([]AccountSummary, error) {
	if !groups.HasRole(membership, domain.RoleFinanceManager) {
		return nil, domain.ErrForbidden
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT m.id,u.id,u.display_name,u.avatar_key,m.status,g.currency,coalesce(sum(le.amount_minor),0)
		FROM memberships m
		JOIN users u ON u.id=m.user_id
		JOIN groups g ON g.id=m.group_id
		LEFT JOIN ledger_entries le ON le.group_id=m.group_id AND le.membership_id=m.id AND le.account='MEMBER_RECEIVABLE'
		WHERE m.group_id=?
		GROUP BY m.id,u.id,u.display_name,u.avatar_key,m.status,g.currency
		ORDER BY CASE m.status WHEN 'ACTIVE' THEN 0 ELSE 1 END,
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
		if err := rows.Scan(&item.MembershipID, &userID, &item.DisplayName, &avatarKey, &item.Status, &item.Currency, &item.BalanceMinor); err != nil {
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
	if !groups.HasRole(membership, domain.RoleFinanceManager) {
		return domain.Payment{}, domain.ErrForbidden
	}
	return s.createPayment(ctx, actor, membership, idempotencyKey, input, true, paymentSourceFinanceWorkspace)
}

// CreateOwnPayment records a payment for the authenticated membership only.
// The caller must have SELF_RECORD_PAYMENT or a broader finance role. The
// resulting payment is immediately posted, audited, and FIFO-allocated without
// creating a redundant notification for the actor.
func (s Service) CreateOwnPayment(ctx context.Context, actor domain.Principal, membership domain.Membership, idempotencyKey string, input CreateOwnPaymentInput) (domain.Payment, error) {
	if !groups.HasGroupPermission(membership, domain.PermissionSelfRecordPayment) {
		return domain.Payment{}, domain.ErrForbidden
	}
	input.ReceivedAt = strings.TrimSpace(input.ReceivedAt)
	if input.ReceivedAt == "" {
		return domain.Payment{}, domain.ValidationError{Field: "receivedAt", Message: "is required"}
	}
	input.Reference = strings.TrimSpace(input.Reference)
	if input.Reference == "" {
		return domain.Payment{}, domain.ValidationError{Field: "reference", Message: "is required"}
	}
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
	input.Method = strings.ToUpper(strings.TrimSpace(input.Method))
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
	if input.Method != "CASH" && input.Method != "BANK_TRANSFER" && input.Method != "PAYPAL" && input.Method != "OTHER" {
		return domain.Payment{}, domain.ValidationError{Field: "method", Message: "must be CASH, BANK_TRANSFER, PAYPAL, or OTHER"}
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
			var allowed int
			if err := tx.QueryRowContext(ctx, `SELECT
				EXISTS(SELECT 1 FROM membership_roles WHERE group_id=? AND membership_id=? AND role IN ('ADMIN','FINANCE_MANAGER'))
				OR EXISTS(SELECT 1 FROM membership_permissions WHERE group_id=? AND membership_id=? AND permission='SELF_RECORD_PAYMENT')`,
				membership.GroupID, membership.ID, membership.GroupID, membership.ID).Scan(&allowed); err != nil {
				return err
			}
			if allowed == 0 {
				return domain.ErrForbidden
			}
		}
		var storedHash, storedResponse string
		err := tx.QueryRowContext(ctx, `SELECT request_hash,response_json FROM idempotency_results WHERE group_id=? AND actor_user_id=? AND idempotency_key=?`,
			membership.GroupID, actor.UserID, storedIdempotencyKey).Scan(&storedHash, &storedResponse)
		if err == nil {
			if storedHash != requestHash {
				return domain.ErrIdempotencyReuse
			}
			return json.Unmarshal([]byte(storedResponse), &payment)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		var currency, memberName string
		var targetExists int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM memberships WHERE id=? AND group_id=? AND status='ACTIVE'`, input.MembershipID, membership.GroupID).Scan(&targetExists); err != nil {
			return err
		}
		if targetExists == 0 {
			return domain.ErrNotFound
		}
		if err := tx.QueryRowContext(ctx, `SELECT u.display_name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=?`, input.MembershipID).Scan(&memberName); err != nil {
			return err
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
		if input.Reference != "" {
			ledgerDescription += ": " + input.Reference
		}
		payment = domain.Payment{ID: paymentID, GroupID: membership.GroupID, MembershipID: input.MembershipID, MemberName: memberName, AmountMinor: input.AmountMinor,
			Currency: currency, ReceivedAt: platform.Timestamp(receivedAt), Method: input.Method, Reference: input.Reference, Note: input.Note, Status: "POSTED", Allocations: []domain.PaymentAllocation{}}
		_, err = tx.ExecContext(ctx, `INSERT INTO payments(id,group_id,membership_id,amount_minor,received_at,method,reference,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
			paymentID, membership.GroupID, input.MembershipID, input.AmountMinor, payment.ReceivedAt, input.Method, nullable(input.Reference), nullable(input.Note), membership.ID, now)
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
		if notifyTarget && membership.ID != input.MembershipID {
			if _, err := s.Notifications.CreateTx(ctx, tx, notifications.CreateInput{
				GroupID: membership.GroupID, MembershipID: input.MembershipID,
				Type: notifications.TypePaymentRecorded, Title: "Payment recorded", Body: "A payment was added to your account.",
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
	if !groups.HasRole(membership, domain.RoleFinanceManager) {
		return nil, domain.ErrForbidden
	}
	if limit < 1 || limit > 200 {
		limit = 100
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT p.id,p.group_id,p.membership_id,u.display_name,p.amount_minor,g.currency,p.received_at,p.method,coalesce(p.reference,''),coalesce(p.note,''),p.reversed_at
		FROM payments p JOIN groups g ON g.id=p.group_id JOIN memberships m ON m.id=p.membership_id JOIN users u ON u.id=m.user_id
		WHERE p.group_id=? ORDER BY p.received_at DESC LIMIT ?`, membership.GroupID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.Payment, 0)
	for rows.Next() {
		var item domain.Payment
		if err := rows.Scan(&item.ID, &item.GroupID, &item.MembershipID, &item.MemberName, &item.AmountMinor, &item.Currency, &item.ReceivedAt, &item.Method, &item.Reference, &item.Note, &item.ReversedAt); err != nil {
			return nil, err
		}
		item.Status = "POSTED"
		if item.ReversedAt != nil {
			item.Status = "REVERSED"
		}
		item.Allocations, err = s.allocations(ctx, item.ID)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
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
	if !groups.HasRole(membership, domain.RoleFinanceManager) {
		return domain.ErrForbidden
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
		var replay map[string]any
		found, err := idempotency.Load(ctx, tx, membership.GroupID, actor.UserID, idempotencyKey, requestHash, &replay)
		if err != nil || found {
			return err
		}
		var reversed sql.NullString
		var targetMembershipID, currency string
		var amountMinor int64
		if err := tx.QueryRowContext(ctx, `SELECT p.reversed_at,p.membership_id,p.amount_minor,g.currency FROM payments p JOIN groups g ON g.id=p.group_id WHERE p.id=? AND p.group_id=?`, paymentID, membership.GroupID).Scan(&reversed, &targetMembershipID, &amountMinor, &currency); errors.Is(err, sql.ErrNoRows) {
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
		if membership.ID != targetMembershipID {
			if _, err := s.Notifications.CreateTx(ctx, tx, notifications.CreateInput{
				GroupID: membership.GroupID, MembershipID: targetMembershipID,
				Type: notifications.TypePaymentReversed, Title: "Payment reversed", Body: "A payment on your account was reversed.",
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
