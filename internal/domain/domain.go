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
	ErrPlanningDisabled     = errors.New("planning is disabled")
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
	// PermissionGroupAdministration permits group configuration, audit access,
	// and protected administrator-assignment management.
	PermissionGroupAdministration PermissionKey = "GROUP_ADMINISTRATION"
	// PermissionMemberManagement permits membership, invitation, guest, join-access,
	// and role-assignment management.
	PermissionMemberManagement PermissionKey = "MEMBER_MANAGEMENT"
	// PermissionRoleManagement permits role and grant management.
	PermissionRoleManagement PermissionKey = "ROLE_MANAGEMENT"
	// PermissionFinanceManagement permits access to group financial management functions.
	PermissionFinanceManagement PermissionKey = "FINANCE_MANAGEMENT"
	// PermissionCatalogManagement permits category and product management.
	PermissionCatalogManagement PermissionKey = "CATALOG_MANAGEMENT"
	// PermissionViewMemberDirectory permits reading the group's member directory.
	PermissionViewMemberDirectory PermissionKey = "VIEW_MEMBER_DIRECTORY"
	// PermissionViewStatistics permits reading all group member, activity, and financial statistics.
	PermissionViewStatistics PermissionKey = "VIEW_STATISTICS"
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
	// PermissionUsePlanning permits access to published planning events and own participation.
	PermissionUsePlanning PermissionKey = "USE_PLANNING"
	// PermissionCreatePlanningEvents permits members to create and manage their own events.
	PermissionCreatePlanningEvents PermissionKey = "CREATE_PLANNING_EVENTS"
	// PermissionViewPlanningParticipants permits identified participant reads.
	PermissionViewPlanningParticipants PermissionKey = "VIEW_PLANNING_PARTICIPANTS"
	// PermissionManagePlanningEvents permits management of all events and recurring series.
	PermissionManagePlanningEvents PermissionKey = "MANAGE_PLANNING_EVENTS"
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

// RolePresetKey identifies a role with reserved system semantics independently
// from its display name. The protected group administrator is the only system
// role in the current model.
type RolePresetKey string

const (
	// RolePresetGroupAdministrator identifies the required protected administrator role.
	RolePresetGroupAdministrator RolePresetKey = "GROUP_ADMINISTRATOR"
)

// RoleTemplateKey identifies one ordinary role template created during group
// bootstrap. It is used only to derive deterministic seed identifiers and is
// never persisted as authorization metadata.
type RoleTemplateKey string

const (
	// RoleTemplateMember identifies the ordinary member-role template.
	RoleTemplateMember RoleTemplateKey = "MEMBER"
	// RoleTemplateFinance identifies the ordinary finance-role template.
	RoleTemplateFinance RoleTemplateKey = "FINANCE_MANAGER"
	// RoleTemplateCatalog identifies the ordinary catalog-role template.
	RoleTemplateCatalog RoleTemplateKey = "CATALOG_MANAGER"
	// RoleTemplateGuest identifies the ordinary guest-role template.
	RoleTemplateGuest RoleTemplateKey = "GUEST"
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

// ColorMode controls whether the application uses the light palette, the dark
// palette, or follows the operating-system preference for one account.
type ColorMode string

const (
	// ColorModeSystem follows the operating-system color-scheme preference.
	ColorModeSystem ColorMode = "SYSTEM"
	// ColorModeLight always uses the light color palette.
	ColorModeLight ColorMode = "LIGHT"
	// ColorModeDark always uses the dark color palette.
	ColorModeDark ColorMode = "DARK"
)

// Valid reports whether mode is supported by the appearance API and database.
func (mode ColorMode) Valid() bool {
	switch mode {
	case ColorModeSystem, ColorModeLight, ColorModeDark:
		return true
	default:
		return false
	}
}

// ThemeID identifies one predefined TeamTaler color theme.
type ThemeID string

const (
	// ThemeTeamTaler is the standard TeamTaler navy and teal theme.
	ThemeTeamTaler ThemeID = "TEAMTALER"
	// ThemeNRW uses the North Rhine-Westphalia red, green, and white palette.
	ThemeNRW ThemeID = "NRW"
	// ThemeTiefImWesten uses Bochum-inspired blue, light blue, and yellow colors.
	ThemeTiefImWesten ThemeID = "TIEF_IM_WESTEN"
	// ThemeFire uses a fire-service-inspired RAL 3000 red palette.
	ThemeFire ThemeID = "FIRE"
)

// Valid reports whether theme is supported by the appearance API and database.
func (theme ThemeID) Valid() bool {
	switch theme {
	case ThemeTeamTaler, ThemeNRW, ThemeTiefImWesten, ThemeFire:
		return true
	default:
		return false
	}
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
	ThemeOverride          *ThemeID                        `json:"themeOverride"`
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
	ID                string     `json:"id"`
	Name              string     `json:"name"`
	Currency          string     `json:"currency"`
	LogoURL           string     `json:"logoUrl,omitempty"`
	DefaultTheme      ThemeID    `json:"defaultTheme"`
	StatisticsEnabled bool       `json:"statisticsEnabled"`
	PlanningEnabled   bool       `json:"planningEnabled"`
	Membership        Membership `json:"membership"`
}

// ReasonMode controls whether a transaction reason is hidden, optional, or
// mandatory for one administrator-configured transaction context.
type ReasonMode string

const (
	// ReasonModeOff removes the reason field and discards submitted reason text.
	ReasonModeOff ReasonMode = "OFF"
	// ReasonModeOptional exposes the reason field without requiring a value.
	ReasonModeOptional ReasonMode = "OPTIONAL"
	// ReasonModeRequired exposes the reason field and requires a non-empty value.
	ReasonModeRequired ReasonMode = "REQUIRED"
)

// Valid reports whether mode belongs to the closed set accepted by settings
// commands and persisted group policy.
func (mode ReasonMode) Valid() bool {
	switch mode {
	case ReasonModeOff, ReasonModeOptional, ReasonModeRequired:
		return true
	default:
		return false
	}
}

// Enabled reports whether a transaction form should expose its reason field.
func (mode ReasonMode) Enabled() bool { return mode != ReasonModeOff }

// Required reports whether a transaction command must include a reason.
func (mode ReasonMode) Required() bool { return mode == ReasonModeRequired }

// AttachmentMode controls whether a configured payment method accepts or
// requires one immutable receipt attachment.
type AttachmentMode string

const (
	// AttachmentModeOff rejects attachments for the payment method.
	AttachmentModeOff AttachmentMode = "OFF"
	// AttachmentModeOptional accepts a payment with or without an attachment.
	AttachmentModeOptional AttachmentMode = "OPTIONAL"
	// AttachmentModeRequired requires an attachment before posting a payment.
	AttachmentModeRequired AttachmentMode = "REQUIRED"
)

// Valid reports whether mode is one of the three persisted attachment modes.
func (mode AttachmentMode) Valid() bool {
	switch mode {
	case AttachmentModeOff, AttachmentModeOptional, AttachmentModeRequired:
		return true
	default:
		return false
	}
}

// Enabled reports whether the payment method accepts a receipt attachment.
func (mode AttachmentMode) Enabled() bool { return mode != AttachmentModeOff }

// Required reports whether the payment method requires a receipt attachment.
func (mode AttachmentMode) Required() bool { return mode == AttachmentModeRequired }

// GroupSettings contains administrator-managed behavior shared by every member
// of one group.
type GroupSettings struct {
	DefaultTheme                 ThemeID            `json:"defaultTheme"`
	NotificationEmailsEnabled    bool               `json:"notificationEmailsEnabled"`
	StatisticsEnabled            bool               `json:"statisticsEnabled"`
	SettlementsEnabled           bool               `json:"settlementsEnabled"`
	DefaultRoleID                *string            `json:"defaultRoleId"`
	OwnBookingReasonMode         ReasonMode         `json:"ownBookingReasonMode"`
	ForeignBookingReasonMode     ReasonMode         `json:"foreignBookingReasonMode"`
	OwnPaymentReasonMode         ReasonMode         `json:"ownPaymentReasonMode"`
	OtherPaymentReasonMode       ReasonMode         `json:"otherPaymentReasonMode"`
	ForeignBookingReasonRequired bool               `json:"foreignBookingReasonRequired"`
	OwnPaymentReasonRequired     bool               `json:"ownPaymentReasonRequired"`
	OtherPaymentReasonRequired   bool               `json:"otherPaymentReasonRequired"`
	PaymentMethods               []PaymentMethod    `json:"paymentMethods"`
	BookingReasons               []ConfigurableItem `json:"bookingReasons"`
	PaymentReasons               []ConfigurableItem `json:"paymentReasons"`
}

// ConfigurableItem is one administrator-managed, ordered option used by
// transaction forms. ID is stable inside one group and Label is user-visible.
type ConfigurableItem struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// PaymentTargetType identifies one supported external payment instruction.
// The empty value and NONE are never exposed as configured targets; callers use
// a nil PaymentTarget instead.
type PaymentTargetType string

const (
	// PaymentTargetPayPalMe identifies a PayPal.Me recipient handle.
	PaymentTargetPayPalMe PaymentTargetType = "PAYPAL_ME"
	// PaymentTargetSEPATransfer identifies an EUR SEPA credit-transfer recipient.
	PaymentTargetSEPATransfer PaymentTargetType = "SEPA_TRANSFER"
)

// Valid reports whether targetType is one of the externally configurable
// payment-target variants. It takes no additional parameters, returns false for
// empty or unknown values, and cannot fail.
func (targetType PaymentTargetType) Valid() bool {
	switch targetType {
	case PaymentTargetPayPalMe, PaymentTargetSEPATransfer:
		return true
	default:
		return false
	}
}

// PaymentTarget contains the normalized external recipient data associated
// with one payment method. Type selects the valid field subset: PayPal.Me uses
// PayPalMeHandle, while SEPA uses RecipientName, IBAN, and optional BIC.
type PaymentTarget struct {
	Type           PaymentTargetType `json:"type"`
	PayPalMeHandle string            `json:"paypalMeHandle,omitempty"`
	RecipientName  string            `json:"recipientName,omitempty"`
	IBAN           string            `json:"iban,omitempty"`
	BIC            string            `json:"bic,omitempty"`
}

// PaymentMethod is one administrator-managed payment option. AttachmentMode
// determines whether callers may or must include a receipt when posting it;
// PaymentTarget optionally supplies member-visible external payment details.
type PaymentMethod struct {
	ID             string         `json:"id"`
	Label          string         `json:"label"`
	AttachmentMode AttachmentMode `json:"attachmentMode"`
	PaymentTarget  *PaymentTarget `json:"paymentTarget"`
}

// TransactionSettings contains operational behavior and explicitly
// member-visible external payment instructions that active members need to
// render finance, booking, and payment surfaces.
type TransactionSettings struct {
	SettlementsEnabled           bool               `json:"settlementsEnabled"`
	OwnBookingReasonMode         ReasonMode         `json:"ownBookingReasonMode"`
	ForeignBookingReasonMode     ReasonMode         `json:"foreignBookingReasonMode"`
	OwnPaymentReasonMode         ReasonMode         `json:"ownPaymentReasonMode"`
	OtherPaymentReasonMode       ReasonMode         `json:"otherPaymentReasonMode"`
	ForeignBookingReasonRequired bool               `json:"foreignBookingReasonRequired"`
	OwnPaymentReasonRequired     bool               `json:"ownPaymentReasonRequired"`
	OtherPaymentReasonRequired   bool               `json:"otherPaymentReasonRequired"`
	PaymentMethods               []PaymentMethod    `json:"paymentMethods"`
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
	ID                    string                    `json:"id"`
	GroupID               string                    `json:"groupId"`
	MembershipID          string                    `json:"membershipId"`
	MemberName            string                    `json:"memberName"`
	MemberStatus          string                    `json:"membershipStatus"`
	MemberAvatarURL       string                    `json:"memberAvatarUrl,omitempty"`
	ActorMembershipID     string                    `json:"actorMembershipId"`
	ActorDisplayName      string                    `json:"actorDisplayName"`
	ActorMembershipStatus string                    `json:"actorMembershipStatus"`
	ActorAvatarURL        string                    `json:"actorAvatarUrl,omitempty"`
	AmountMinor           int64                     `json:"amountMinor,string"`
	Currency              string                    `json:"currency"`
	ReceivedAt            string                    `json:"receivedAt"`
	Method                string                    `json:"method"`
	MethodLabel           string                    `json:"methodLabel"`
	Reference             string                    `json:"reference,omitempty"`
	Note                  string                    `json:"note,omitempty"`
	ReversedAt            *string                   `json:"reversedAt,omitempty"`
	Status                string                    `json:"status"`
	Allocations           []PaymentAllocation       `json:"allocations"`
	Attachment            *PaymentAttachmentSummary `json:"attachment,omitempty"`
}

// PaymentAttachmentSummary exposes safe immutable receipt metadata. URL is a
// protected same-origin endpoint and never reveals the storage key.
type PaymentAttachmentSummary struct {
	FileName  string `json:"fileName"`
	MediaType string `json:"mediaType"`
	SizeBytes int64  `json:"sizeBytes"`
	URL       string `json:"url"`
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
	MembershipStatus         string  `json:"membershipStatus"`
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
