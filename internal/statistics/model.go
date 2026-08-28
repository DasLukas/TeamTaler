// Package statistics provides permission-aware, tenant-scoped aggregate views
// for the TeamTaler statistics dashboard.
package statistics

import "time"

// Preset identifies a server-resolved statistics time window.
type Preset string

const (
	// PresetCurrentPeriod starts at the group's currently open accounting period.
	PresetCurrentPeriod Preset = "CURRENT_PERIOD"
	// PresetLast30Days covers the rolling 30 days ending at generation time.
	PresetLast30Days Preset = "LAST_30_DAYS"
	// PresetLast90Days covers the rolling 90 days ending at generation time.
	PresetLast90Days Preset = "LAST_90_DAYS"
	// PresetLast12Months covers the rolling 12 months ending at generation time.
	PresetLast12Months Preset = "LAST_12_MONTHS"
	// PresetAllTime starts at group creation and ends at generation time.
	PresetAllTime Preset = "ALL_TIME"
	// PresetCustom uses explicit inclusive local YYYY-MM-DD bounds.
	PresetCustom Preset = "CUSTOM"
)

// Bucket identifies the calendar granularity used for a time series.
type Bucket string

const (
	// BucketDay groups events by local calendar day.
	BucketDay Bucket = "DAY"
	// BucketWeek groups events into local Monday-based calendar weeks.
	BucketWeek Bucket = "WEEK"
	// BucketMonth groups events by local calendar month.
	BucketMonth Bucket = "MONTH"
	// BucketYear groups long all-time ranges by local calendar year.
	BucketYear Bucket = "YEAR"
)

const (
	maxSeriesBuckets            = 60
	privacyParticipantThreshold = int64(3)
)

// Query contains the optional statistics range parameters accepted by both
// dashboard endpoints. From and To are required only for CUSTOM and use local
// YYYY-MM-DD dates. To is inclusive at the wire; its effective exclusive bound
// is the earlier of the following local midnight and the generation instant.
// An empty Preset selects CURRENT_PERIOD when settlements are enabled and an
// open period exists, or LAST_30_DAYS otherwise. Bucket selection is
// intentionally server controlled.
type Query struct {
	Preset Preset
	From   string
	To     string
}

// Meta describes the effective server-side range and privacy treatment used to
// produce a statistics response.
type Meta struct {
	GeneratedAt             string `json:"generatedAt"`
	Timezone                string `json:"timezone"`
	Preset                  Preset `json:"preset"`
	FromInclusive           string `json:"fromInclusive"`
	ToExclusive             string `json:"toExclusive"`
	Bucket                  Bucket `json:"bucket"`
	CurrentPeriodAvailable  bool   `json:"currentPeriodAvailable"`
	PrivacyThresholdApplied bool   `json:"privacyThresholdApplied"`
}

// MemberSnapshot contains current anonymous membership counts and is not
// affected by the selected historical range.
type MemberSnapshot struct {
	RegularMembers  int64  `json:"regularMembers"`
	TemporaryGuests int64  `json:"temporaryGuests"`
	AsOf            string `json:"asOf"`
}

// MemberSummary contains the range-wide member activity KPIs. CancellationRate
// is nil when no booking was posted in the selected range.
type MemberSummary struct {
	ActiveParticipants int64    `json:"activeParticipants"`
	BookingCount       int64    `json:"bookingCount"`
	ValidBookedUnits   int64    `json:"validBookedUnits"`
	CancellationRate   *float64 `json:"cancellationRate"`
}

// MemberActivityPoint contains posted and reversed units for one local bucket.
type MemberActivityPoint struct {
	PeriodStart   string `json:"periodStart"`
	PostedUnits   int64  `json:"postedUnits"`
	ReversedUnits int64  `json:"reversedUnits"`
}

// MemberCategoryItem is one anonymous category ranking item.
type MemberCategoryItem struct {
	CategoryID       string `json:"categoryId"`
	CategoryName     string `json:"categoryName"`
	Icon             string `json:"icon"`
	ValidBookedUnits int64  `json:"validBookedUnits"`
	IsOther          bool   `json:"isOther"`
}

// MemberProductItem is one anonymous product ranking item.
type MemberProductItem struct {
	ProductID        string `json:"productId"`
	ProductName      string `json:"productName"`
	CategoryID       string `json:"categoryId"`
	CategoryName     string `json:"categoryName"`
	ValidBookedUnits int64  `json:"validBookedUnits"`
	IsOther          bool   `json:"isOther"`
}

// MemberCategoryBreakdown contains category items or an explicit privacy
// suppression marker. Items is always a non-nil array.
type MemberCategoryBreakdown struct {
	Suppressed bool                 `json:"suppressed"`
	Items      []MemberCategoryItem `json:"items"`
}

// MemberProductBreakdown contains product items or an explicit privacy
// suppression marker. Items is always a non-nil array.
type MemberProductBreakdown struct {
	Suppressed bool                `json:"suppressed"`
	Items      []MemberProductItem `json:"items"`
}

// MemberDashboard is the anonymous member statistics response.
type MemberDashboard struct {
	Meta           Meta                    `json:"meta"`
	MemberSnapshot MemberSnapshot          `json:"memberSnapshot"`
	Summary        MemberSummary           `json:"summary"`
	Activity       []MemberActivityPoint   `json:"activity"`
	TopCategories  MemberCategoryBreakdown `json:"topCategories"`
	TopProducts    MemberProductBreakdown  `json:"topProducts"`
}

// ReceivableSnapshot contains the complete-ledger distribution of member
// account balances as of the selected range end. MemberCreditMinor is the
// positive magnitude of all negative account balances.
type ReceivableSnapshot struct {
	GrossReceivableMinor int64  `json:"grossReceivableMinor,string"`
	MemberCreditMinor    int64  `json:"memberCreditMinor,string"`
	NetReceivableMinor   int64  `json:"netReceivableMinor,string"`
	OpenAccountCount     int64  `json:"openAccountCount"`
	BalancedAccountCount int64  `json:"balancedAccountCount"`
	CreditAccountCount   int64  `json:"creditAccountCount"`
	AsOf                 string `json:"asOf"`
}

// FinancialFlows reconciles the selected range. Closing equals opening plus
// booking charges minus payments plus adjustments.
type FinancialFlows struct {
	OpeningNetReceivableMinor int64 `json:"openingNetReceivableMinor,string"`
	NetBookingChargesMinor    int64 `json:"netBookingChargesMinor,string"`
	NetPaymentsMinor          int64 `json:"netPaymentsMinor,string"`
	NetAdjustmentsMinor       int64 `json:"netAdjustmentsMinor,string"`
	ClosingNetReceivableMinor int64 `json:"closingNetReceivableMinor,string"`
}

// FinanceActivityPoint contains reconciled flows and the closing complete-
// ledger receivable for one local bucket.
type FinanceActivityPoint struct {
	PeriodStart               string `json:"periodStart"`
	NetBookingChargesMinor    int64  `json:"netBookingChargesMinor,string"`
	NetPaymentsMinor          int64  `json:"netPaymentsMinor,string"`
	NetAdjustmentsMinor       int64  `json:"netAdjustmentsMinor,string"`
	ClosingNetReceivableMinor int64  `json:"closingNetReceivableMinor,string"`
}

// FinanceCategoryItem is one category's net booking charge contribution for
// the selected ledger-created range.
type FinanceCategoryItem struct {
	CategoryID             string `json:"categoryId"`
	CategoryName           string `json:"categoryName"`
	Icon                   string `json:"icon"`
	NetBookingChargesMinor int64  `json:"netBookingChargesMinor,string"`
	IsOther                bool   `json:"isOther"`
}

// OverdueSnapshot contains the current settlement debt that was already due
// before the group's current local date.
type OverdueSnapshot struct {
	AmountMinor  int64  `json:"amountMinor,string"`
	AccountCount int64  `json:"accountCount"`
	PeriodCount  int64  `json:"periodCount"`
	AsOf         string `json:"asOf"`
}

// FinanceDashboard is the aggregate finance statistics response. Overdue is
// nil while optional settlements are disabled.
type FinanceDashboard struct {
	Meta               Meta                   `json:"meta"`
	Currency           string                 `json:"currency"`
	ReceivableSnapshot ReceivableSnapshot     `json:"receivableSnapshot"`
	Flows              FinancialFlows         `json:"flows"`
	Series             []FinanceActivityPoint `json:"series"`
	Categories         []FinanceCategoryItem  `json:"categories"`
	Overdue            *OverdueSnapshot       `json:"overdue"`
}

type resolvedRange struct {
	meta     Meta
	from     time.Time
	to       time.Time
	location *time.Location
	buckets  []bucketWindow
}

type bucketWindow struct {
	periodStart time.Time
	from        time.Time
	to          time.Time
}
