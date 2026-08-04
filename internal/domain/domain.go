// Package domain defines the stable business vocabulary shared by TeamTaler modules.
package domain

import (
	"errors"
	"fmt"
)

// Stable sentinel errors allow the transport layer to produce consistent problem responses.
var (
	ErrNotFound             = errors.New("resource not found")
	ErrForbidden            = errors.New("operation is not permitted")
	ErrConflict             = errors.New("resource conflict")
	ErrValidation           = errors.New("validation failed")
	ErrUnauthenticated      = errors.New("authentication required")
	ErrPrecondition         = errors.New("precondition failed")
	ErrIdempotencyReuse     = errors.New("idempotency key was reused with a different request")
	ErrRateLimited          = errors.New("request rate limit exceeded")
	ErrServiceUnavailable   = errors.New("required service is unavailable")
	ErrUnsupportedMediaType = errors.New("unsupported media type")
	ErrPayloadTooLarge      = errors.New("request payload is too large")
)

// ValidationError associates a safe client-facing message with invalid input.
type ValidationError struct {
	Field   string
	Message string
}

// Error implements error without exposing internal details.
func (e ValidationError) Error() string {
	if e.Field == "" {
		return e.Message
	}
	return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

// Unwrap classifies ValidationError as ErrValidation.
func (e ValidationError) Unwrap() error { return ErrValidation }

// Role is a cumulative group-level capability.
type Role string

const (
	RoleAdmin          Role = "ADMIN"
	RoleFinanceManager Role = "FINANCE_MANAGER"
	RoleCatalogManager Role = "CATALOG_MANAGER"
)

// CategoryPermission is a capability scoped to one category.
type CategoryPermission string

const (
	PermissionAssignToOthers CategoryPermission = "ASSIGN_TO_OTHERS"
	PermissionVoidBookings   CategoryPermission = "VOID_BOOKINGS"
)

// Principal describes an authenticated user and their current session.
type Principal struct {
	UserID      string
	Email       string
	DisplayName string
	SessionHash string
	CSRFToken   string
}

// Membership describes one user's participation in a group.
type Membership struct {
	ID             string                          `json:"id"`
	GroupID        string                          `json:"groupId"`
	UserID         string                          `json:"userId"`
	Email          string                          `json:"email"`
	DisplayName    string                          `json:"displayName"`
	Status         string                          `json:"status"`
	Roles          []Role                          `json:"roles"`
	CategoryGrants map[string][]CategoryPermission `json:"categoryGrants"`
}

// Group is the top-level isolation and accounting boundary.
type Group struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Currency   string     `json:"currency"`
	LogoURL    string     `json:"logoUrl,omitempty"`
	Membership Membership `json:"membership"`
}

// Category contains one group-defined product collection.
type Category struct {
	ID        string    `json:"id"`
	GroupID   string    `json:"groupId"`
	Name      string    `json:"name"`
	Active    bool      `json:"active"`
	SortOrder int       `json:"sortOrder"`
	Version   int64     `json:"version"`
	Products  []Product `json:"products,omitempty"`
}

// ProductPricingMode defines whether a product has a catalog price or requires
// the booking actor to choose a unit price.
type ProductPricingMode string

const (
	// ProductPricingFixed requires a positive catalog price.
	ProductPricingFixed ProductPricingMode = "FIXED"
	// ProductPricingUserDefined requires a positive unit price on every booking.
	ProductPricingUserDefined ProductPricingMode = "USER_DEFINED"
	// MaxProductPriceMinor bounds one product unit price in minor currency units.
	MaxProductPriceMinor int64 = 100_000_000_000
)

// Product is a catalog item whose price is snapshotted when booked. PriceMinor
// is present only for fixed-price products.
type Product struct {
	ID          string             `json:"id"`
	GroupID     string             `json:"groupId"`
	CategoryID  string             `json:"categoryId"`
	Name        string             `json:"name"`
	PriceMinor  *int64             `json:"priceMinor,omitempty,string"`
	PricingMode ProductPricingMode `json:"pricingMode"`
	Currency    string             `json:"currency"`
	ImageURL    string             `json:"imageUrl,omitempty"`
	Active      bool               `json:"active"`
	SortOrder   int                `json:"sortOrder"`
	Version     int64              `json:"version"`
}

// Booking is an immutable charge snapshot with optional reversal metadata.
type Booking struct {
	ID                 string  `json:"id"`
	GroupID            string  `json:"groupId"`
	PeriodID           string  `json:"periodId"`
	CategoryID         string  `json:"categoryId"`
	ProductID          string  `json:"productId"`
	ActorMembershipID  string  `json:"actorMembershipId"`
	TargetMembershipID string  `json:"targetMembershipId"`
	Quantity           int     `json:"quantity"`
	UnitPriceMinor     int64   `json:"unitPriceMinor,string"`
	TotalMinor         int64   `json:"totalMinor,string"`
	Currency           string  `json:"currency"`
	ProductName        string  `json:"productName"`
	CategoryName       string  `json:"categoryName"`
	Reason             string  `json:"reason,omitempty"`
	CreatedAt          string  `json:"createdAt"`
	VoidedAt           *string `json:"voidedAt,omitempty"`
	VoidReason         string  `json:"voidReason,omitempty"`
	CanVoid            bool    `json:"canVoid"`
}

// Payment records received money and its period allocations.
type Payment struct {
	ID           string              `json:"id"`
	GroupID      string              `json:"groupId"`
	MembershipID string              `json:"membershipId"`
	MemberName   string              `json:"memberName"`
	AmountMinor  int64               `json:"amountMinor,string"`
	Currency     string              `json:"currency"`
	ReceivedAt   string              `json:"receivedAt"`
	Method       string              `json:"method"`
	Reference    string              `json:"reference,omitempty"`
	Note         string              `json:"note,omitempty"`
	ReversedAt   *string             `json:"reversedAt,omitempty"`
	Status       string              `json:"status"`
	Allocations  []PaymentAllocation `json:"allocations"`
}

// PaymentAllocation maps part of a payment to a period using FIFO rules.
type PaymentAllocation struct {
	PeriodID    string `json:"periodId"`
	AmountMinor int64  `json:"amountMinor,string"`
}

// Period represents one flexible accounting interval.
type Period struct {
	ID       string  `json:"id"`
	GroupID  string  `json:"groupId"`
	Label    string  `json:"label"`
	Status   string  `json:"status"`
	StartsAt string  `json:"startsAt"`
	ClosedAt *string `json:"closedAt,omitempty"`
	DueAt    *string `json:"dueAt,omitempty"`
}

// Statement is an immutable member snapshot generated when a period closes.
type Statement struct {
	ID                       string `json:"id"`
	PeriodID                 string `json:"periodId"`
	MembershipID             string `json:"membershipId"`
	DisplayName              string `json:"displayName"`
	Email                    string `json:"email"`
	ChargesMinor             int64  `json:"chargesMinor,string"`
	PaymentsAllocatedMinor   int64  `json:"paymentsAllocatedMinor,string"`
	AdjustmentsAppliedMinor  int64  `json:"adjustmentsAppliedMinor,string"`
	AdjustmentsProvidedMinor int64  `json:"adjustmentsProvidedMinor,string"`
	AmountDueMinor           int64  `json:"amountDueMinor,string"`
	Currency                 string `json:"currency"`
	Status                   string `json:"status"`
}
