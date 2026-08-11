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

const (
	// DefaultOpenPeriodLabel is the user-facing label assigned to a new open accounting period.
	DefaultOpenPeriodLabel = "Aktueller Zeitraum"
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

// Role is a deprecated legacy role identifier retained for v1 compatibility.
// New authorization decisions must use PermissionKey values resolved through
// assigned RoleDefinition records instead of inspecting this value.
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

// GroupPermission is a narrowly scoped capability assigned to one membership.
type GroupPermission string

const (
	// PermissionSelfRecordPayment allows a membership to record payments only
	// for its own account through the dedicated self-service endpoint.
	PermissionSelfRecordPayment GroupPermission = "SELF_RECORD_PAYMENT"
)

// PermissionKey identifies one stable, group-authorized application capability.
// Permission keys are persisted and compared directly; role names must never be
// used for authorization decisions.
type PermissionKey string

const (
	// PermissionGroupAdministration permits group, membership, invitation, and
	// protected administrator-assignment management.
	PermissionGroupAdministration PermissionKey = "GROUP_ADMINISTRATION"
	// PermissionRoleManagement permits role, grant, and unprotected assignment management.
	PermissionRoleManagement PermissionKey = "ROLE_MANAGEMENT"
	// PermissionFinanceManagement permits access to group financial management functions.
	PermissionFinanceManagement PermissionKey = "FINANCE_MANAGEMENT"
	// PermissionCatalogManagement permits category and product management.
	PermissionCatalogManagement PermissionKey = "CATALOG_MANAGEMENT"
	// PermissionViewMemberDirectory permits reading the group's member directory.
	PermissionViewMemberDirectory PermissionKey = "VIEW_MEMBER_DIRECTORY"
	// PermissionViewGroupStatistics permits reading aggregate group statistics.
	PermissionViewGroupStatistics PermissionKey = "VIEW_GROUP_STATISTICS"
	// PermissionViewAllBookingActivity permits viewing every identified group booking in the activity feed.
	PermissionViewAllBookingActivity PermissionKey = "VIEW_ALL_BOOKING_ACTIVITY"
	// PermissionRecordOwnPayment permits self-service payment recording for the current member.
	PermissionRecordOwnPayment PermissionKey = "RECORD_OWN_PAYMENT"
	// PermissionCreateOwnBooking permits creating bookings that charge the current membership.
	PermissionCreateOwnBooking PermissionKey = "CREATE_OWN_BOOKING"
	// PermissionVoidOwnBooking permits voiding bookings where the current membership
	// is either the booking actor or target.
	PermissionVoidOwnBooking PermissionKey = "VOID_OWN_BOOKING"
	// PermissionVoidAnyBooking permits voiding every booking in the group.
	PermissionVoidAnyBooking PermissionKey = "VOID_ANY_BOOKING"
	// PermissionBookForOthers permits reasoned bookings for another credentialed active member.
	PermissionBookForOthers PermissionKey = "BOOK_FOR_OTHERS"
	// PermissionBookForGuests permits bookings for credentialless temporary guests.
	PermissionBookForGuests PermissionKey = "BOOK_FOR_GUESTS"
)

// PermissionScopeType identifies the resource boundary attached to a permission grant.
// CATEGORY and PRODUCT are reserved by the schema for future policy versions; v1
// mutation APIs accept GROUP grants only.
type PermissionScopeType string

const (
	// PermissionScopeGroup applies a grant to every applicable resource in one group.
	PermissionScopeGroup PermissionScopeType = "GROUP"
	// PermissionScopeCategory reserves a grant for one category.
	PermissionScopeCategory PermissionScopeType = "CATEGORY"
	// PermissionScopeProduct reserves a grant for one product.
	PermissionScopeProduct PermissionScopeType = "PRODUCT"
)

// PermissionScope describes where a PermissionGrant applies.
// CategoryID is required only for CATEGORY and ProductID only for PRODUCT. In
// v1, callers create group scopes with PermissionScope{Type: PermissionScopeGroup}.
type PermissionScope struct {
	Type       PermissionScopeType `json:"type"`
	CategoryID string              `json:"categoryId,omitempty"`
	ProductID  string              `json:"productId,omitempty"`
}

// PermissionGrant assigns one stable permission to one resource scope.
// Permission is validated against the supported permission definitions and Scope
// is GROUP-only in v1 mutation paths.
type PermissionGrant struct {
	Permission PermissionKey   `json:"permission"`
	Scope      PermissionScope `json:"scope"`
}

// PermissionDefinition describes one supported permission and its calculated implications.
// ImpliedPermissions is informational for clients; authorization calculates the
// same closure server-side and does not persist redundant implied grants.
type PermissionDefinition struct {
	Key                PermissionKey   `json:"key"`
	Description        string          `json:"description"`
	ImpliedPermissions []PermissionKey `json:"impliedPermissions"`
}

// RolePresetKey identifies a seeded role template independently from its editable display name.
// Only the group-administrator preset has a locked name; preset keys themselves
// are immutable once a role is created.
type RolePresetKey string

const (
	// RolePresetGroupAdministrator identifies the required protected administrator role.
	RolePresetGroupAdministrator RolePresetKey = "GROUP_ADMINISTRATOR"
	// RolePresetMember identifies the editable starter role seeded for new groups.
	RolePresetMember RolePresetKey = "MEMBER"
	// RolePresetFinanceManager identifies the optional seeded finance role.
	RolePresetFinanceManager RolePresetKey = "FINANCE_MANAGER"
	// RolePresetCatalogManager identifies the optional seeded catalog role.
	RolePresetCatalogManager RolePresetKey = "CATALOG_MANAGER"
)

// RoleDefinition is one group-owned, versioned collection of permission grants.
// ID is stable, PresetKey is empty for custom roles, and Version is the optimistic
// concurrency token used for role updates.
type RoleDefinition struct {
	ID          string            `json:"id"`
	GroupID     string            `json:"groupId"`
	Name        string            `json:"name"`
	Description string            `json:"description"`
	PresetKey   RolePresetKey     `json:"presetKey,omitempty"`
	NameLocked  bool              `json:"nameLocked"`
	Deletable   bool              `json:"deletable"`
	Version     int64             `json:"version"`
	Grants      []PermissionGrant `json:"grants"`
	CreatedAt   string            `json:"createdAt"`
	UpdatedAt   string            `json:"updatedAt"`
}

// RoleAssignmentTargetType identifies whether a role assignment belongs to an
// active membership or to a pending invitation.
type RoleAssignmentTargetType string

const (
	// RoleAssignmentMembership identifies an active membership assignment.
	RoleAssignmentMembership RoleAssignmentTargetType = "MEMBERSHIP"
	// RoleAssignmentInvitation identifies a pending invitation assignment.
	RoleAssignmentInvitation RoleAssignmentTargetType = "INVITATION"
)

// RoleAssignment links one role to a membership or invitation target.
// Version belongs to the assignment row; collection replacement uses the target's
// roleAssignmentsVersion value as its optimistic concurrency token.
type RoleAssignment struct {
	GroupID    string                   `json:"groupId"`
	RoleID     string                   `json:"roleId"`
	TargetType RoleAssignmentTargetType `json:"targetType"`
	TargetID   string                   `json:"targetId"`
	AssignedAt string                   `json:"assignedAt"`
	AssignedBy string                   `json:"assignedBy,omitempty"`
	Version    int64                    `json:"version"`
}

// Principal describes an authenticated user and their current session.
type Principal struct {
	UserID      string
	Email       string
	DisplayName string
	AvatarURL   string
	SessionHash string
	CSRFToken   string
}

// Membership describes one user's participation in a group.
type Membership struct {
	ID                     string                          `json:"id"`
	GroupID                string                          `json:"groupId"`
	UserID                 string                          `json:"userId"`
	Email                  *string                         `json:"email,omitempty"`
	DisplayName            string                          `json:"displayName"`
	AvatarURL              string                          `json:"avatarUrl,omitempty"`
	Status                 string                          `json:"status"`
	IsTemporaryGuest       bool                            `json:"isTemporaryGuest"`
	Roles                  []Role                          `json:"roles"`
	GroupPermissions       []GroupPermission               `json:"groupPermissions"`
	CategoryGrants         map[string][]CategoryPermission `json:"categoryGrants"`
	RoleIDs                []string                        `json:"roleIds"`
	EffectiveGrants        []PermissionGrant               `json:"effectiveGrants"`
	RoleAssignmentsVersion int64                           `json:"roleAssignmentsVersion"`
}

const (
	// MembershipStatusActive identifies a membership that can access the group.
	MembershipStatusActive = "ACTIVE"
	// MembershipStatusArchived identifies a reversible inactive membership.
	MembershipStatusArchived = "ARCHIVED"
	// MembershipStatusDeleted identifies a history-only financial tombstone.
	MembershipStatusDeleted = "DELETED"
)

// Group is the top-level isolation and accounting boundary.
type Group struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Currency   string     `json:"currency"`
	LogoURL    string     `json:"logoUrl,omitempty"`
	Membership Membership `json:"membership"`
}

// GroupSettings contains administrator-managed behavior shared by every member
// of one group.
type GroupSettings struct {
	NotificationEmailsEnabled    bool               `json:"notificationEmailsEnabled"`
	SettlementsEnabled           bool               `json:"settlementsEnabled"`
	DefaultRoleID                *string            `json:"defaultRoleId"`
	ForeignBookingReasonRequired bool               `json:"foreignBookingReasonRequired"`
	OwnPaymentReasonRequired     bool               `json:"ownPaymentReasonRequired"`
	OtherPaymentReasonRequired   bool               `json:"otherPaymentReasonRequired"`
	PaymentMethods               []ConfigurableItem `json:"paymentMethods"`
	BookingReasons               []ConfigurableItem `json:"bookingReasons"`
	PaymentReasons               []ConfigurableItem `json:"paymentReasons"`
}

// ConfigurableItem is one administrator-managed, ordered option used by
// transaction forms. ID is stable inside one group and Label is user-visible.
type ConfigurableItem struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// TransactionSettings contains the non-sensitive operational behavior that
// active members need to render finance, booking, and payment surfaces.
type TransactionSettings struct {
	SettlementsEnabled           bool               `json:"settlementsEnabled"`
	ForeignBookingReasonRequired bool               `json:"foreignBookingReasonRequired"`
	OwnPaymentReasonRequired     bool               `json:"ownPaymentReasonRequired"`
	OtherPaymentReasonRequired   bool               `json:"otherPaymentReasonRequired"`
	PaymentMethods               []ConfigurableItem `json:"paymentMethods"`
	BookingReasons               []ConfigurableItem `json:"bookingReasons"`
	PaymentReasons               []ConfigurableItem `json:"paymentReasons"`
}

// CategoryIcon identifies one supported visual category marker.
type CategoryIcon string

const (
	// CategoryIconOther is the general-purpose category marker.
	CategoryIconOther CategoryIcon = "other"
	// CategoryIconDrink represents beverage categories.
	CategoryIconDrink CategoryIcon = "drink"
	// CategoryIconFood represents meal and snack categories.
	CategoryIconFood CategoryIcon = "food"
	// CategoryIconPenalty represents fine and penalty categories.
	CategoryIconPenalty CategoryIcon = "penalty"
	// CategoryIconSport represents sport and training categories.
	CategoryIconSport CategoryIcon = "sport"
	// CategoryIconEvent represents event categories.
	CategoryIconEvent CategoryIcon = "event"
	// CategoryIconTransport represents travel and transport categories.
	CategoryIconTransport CategoryIcon = "transport"
	// CategoryIconMoney represents financial and donation categories.
	CategoryIconMoney CategoryIcon = "money"
)

// ValidCategoryIcon reports whether icon belongs to the closed set accepted by
// the database and public catalogue API.
//
// Parameters:
//   - icon: Category icon value supplied by a caller or decoded command.
//
// Returns:
//   - bool: True only for a supported category icon.
func ValidCategoryIcon(icon CategoryIcon) bool {
	switch icon {
	case CategoryIconOther, CategoryIconDrink, CategoryIconFood, CategoryIconPenalty,
		CategoryIconSport, CategoryIconEvent, CategoryIconTransport, CategoryIconMoney:
		return true
	default:
		return false
	}
}

// Category contains one group-defined product collection.
type Category struct {
	ID        string       `json:"id"`
	GroupID   string       `json:"groupId"`
	Name      string       `json:"name"`
	Icon      CategoryIcon `json:"icon"`
	Active    bool         `json:"active"`
	SortOrder int          `json:"sortOrder"`
	Version   int64        `json:"version"`
	Products  []Product    `json:"products,omitempty"`
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
	ID                     string  `json:"id"`
	GroupID                string  `json:"groupId"`
	PeriodID               string  `json:"periodId"`
	CategoryID             string  `json:"categoryId"`
	ProductID              string  `json:"productId"`
	ActorMembershipID      string  `json:"actorMembershipId"`
	ActorDisplayName       string  `json:"actorDisplayName"`
	ActorAvatarURL         string  `json:"actorAvatarUrl,omitempty"`
	ActorMembershipStatus  string  `json:"actorMembershipStatus"`
	TargetMembershipID     string  `json:"targetMembershipId"`
	TargetDisplayName      string  `json:"targetDisplayName"`
	TargetAvatarURL        string  `json:"targetAvatarUrl,omitempty"`
	TargetMembershipStatus string  `json:"targetMembershipStatus"`
	Quantity               int     `json:"quantity"`
	UnitPriceMinor         int64   `json:"unitPriceMinor,string"`
	TotalMinor             int64   `json:"totalMinor,string"`
	Currency               string  `json:"currency"`
	ProductName            string  `json:"productName"`
	CategoryName           string  `json:"categoryName"`
	Reason                 string  `json:"reason,omitempty"`
	CreatedAt              string  `json:"createdAt"`
	VoidedAt               *string `json:"voidedAt,omitempty"`
	VoidReason             string  `json:"voidReason,omitempty"`
	CanVoid                bool    `json:"canVoid"`
	VoidReasonRequired     bool    `json:"voidReasonRequired"`
	VoidWithoutReasonUntil *string `json:"voidWithoutReasonUntil,omitempty"`
}

// Payment records received money and its period allocations.
type Payment struct {
	ID           string              `json:"id"`
	GroupID      string              `json:"groupId"`
	MembershipID string              `json:"membershipId"`
	MemberName   string              `json:"memberName"`
	MemberStatus string              `json:"membershipStatus"`
	AmountMinor  int64               `json:"amountMinor,string"`
	Currency     string              `json:"currency"`
	ReceivedAt   string              `json:"receivedAt"`
	Method       string              `json:"method"`
	MethodLabel  string              `json:"methodLabel"`
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
	ID                       string  `json:"id"`
	PeriodID                 string  `json:"periodId"`
	MembershipID             string  `json:"membershipId"`
	DisplayName              string  `json:"displayName"`
	Email                    *string `json:"email,omitempty"`
	ChargesMinor             int64   `json:"chargesMinor,string"`
	PaymentsAllocatedMinor   int64   `json:"paymentsAllocatedMinor,string"`
	AdjustmentsAppliedMinor  int64   `json:"adjustmentsAppliedMinor,string"`
	AdjustmentsProvidedMinor int64   `json:"adjustmentsProvidedMinor,string"`
	AmountDueMinor           int64   `json:"amountDueMinor,string"`
	Currency                 string  `json:"currency"`
	Status                   string  `json:"status"`
}
