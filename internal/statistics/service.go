package statistics

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

// Service reads privacy-preserving statistics from the shared application
// database. Clock is optional and exists for deterministic tests; production
// callers normally leave it nil so platform.Now is used.
type Service struct {
	// DB is the migrated TeamTaler database.
	DB *sql.DB
	// Clock returns the generation instant when supplied.
	Clock  func() time.Time
	reader statisticsQueryer
}

type statisticsQueryer interface {
	authorization.Queryer
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

type dashboardContext struct {
	statisticsEnabled  bool
	settlementsEnabled bool
	currency           string
	timezone           string
	groupCreatedAt     time.Time
}

// Dashboard returns member, booking, and complete-ledger finance aggregates
// from one read-only database snapshot. The group must have statistics enabled
// and membership must currently hold VIEW_STATISTICS. All returned money values
// retain int64 precision and serialize as strings. Query validation,
// authorization, disabled features, and database failures are returned as
// errors.
func (s Service) Dashboard(ctx context.Context, membership domain.Membership, query Query) (Dashboard, error) {
	if s.DB == nil {
		return Dashboard{}, errors.New("statistics service requires a database")
	}
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Dashboard{}, err
	}
	defer tx.Rollback()
	snapshot := s
	snapshot.reader = tx
	configuration, err := snapshot.authorize(ctx, membership)
	if err != nil {
		return Dashboard{}, err
	}
	rangeValue, err := snapshot.resolveRange(ctx, membership.GroupID, query, configuration)
	if err != nil {
		return Dashboard{}, err
	}
	members, privacyApplied, err := snapshot.memberStatistics(ctx, membership, rangeValue)
	if err != nil {
		return Dashboard{}, err
	}
	rangeValue.meta.PrivacyThresholdApplied = privacyApplied
	finance, err := snapshot.financeStatistics(ctx, membership, configuration, rangeValue)
	if err != nil {
		return Dashboard{}, err
	}
	if err := tx.Commit(); err != nil {
		return Dashboard{}, err
	}
	return Dashboard{Meta: rangeValue.meta, Members: members, Finance: finance}, nil
}

func (s Service) authorize(ctx context.Context, membership domain.Membership) (dashboardContext, error) {
	queryer := s.queryer()
	var configuration dashboardContext
	var createdAt string
	err := queryer.QueryRowContext(ctx, `SELECT settings.statistics_enabled,settings.settlements_enabled,g.currency,
		COALESCE((SELECT value_text FROM system_setting_overrides WHERE setting_key='instance.timezone' AND value_type='STRING'),'Europe/Berlin'),
		g.created_at
		FROM groups g
		JOIN group_settings settings ON settings.group_id=g.id
		WHERE g.id=? AND g.status='ACTIVE'`, membership.GroupID).
		Scan(&configuration.statisticsEnabled, &configuration.settlementsEnabled, &configuration.currency, &configuration.timezone, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return dashboardContext{}, domain.ErrForbidden
	}
	if err != nil {
		return dashboardContext{}, err
	}
	if !configuration.statisticsEnabled {
		return dashboardContext{}, domain.ErrForbidden
	}
	if err := authorization.Require(ctx, queryer, membership.GroupID, membership.ID, domain.PermissionViewStatistics, authorization.GroupResource(membership.GroupID)); err != nil {
		return dashboardContext{}, err
	}
	configuration.groupCreatedAt, err = time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return dashboardContext{}, fmt.Errorf("parse group creation timestamp: %w", err)
	}
	if _, err := time.LoadLocation(configuration.timezone); err != nil {
		return dashboardContext{}, fmt.Errorf("load statistics timezone: %w", err)
	}
	return configuration, nil
}

func (s Service) resolveRange(ctx context.Context, groupID string, query Query, configuration dashboardContext) (resolvedRange, error) {
	now := platform.Now()
	if s.Clock != nil {
		now = s.Clock()
	}
	now = now.UTC()
	location, _ := time.LoadLocation(configuration.timezone)
	var hasOpenPeriod bool
	if err := s.queryer().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM periods WHERE group_id=? AND status='OPEN')`, groupID).Scan(&hasOpenPeriod); err != nil {
		return resolvedRange{}, err
	}
	currentPeriodAvailable := configuration.settlementsEnabled && hasOpenPeriod
	preset := Preset(strings.ToUpper(strings.TrimSpace(string(query.Preset))))
	if preset == "" {
		preset = PresetLast30Days
		if currentPeriodAvailable {
			preset = PresetCurrentPeriod
		}
	}
	if preset == PresetCurrentPeriod && !currentPeriodAvailable {
		return resolvedRange{}, domain.ValidationError{Field: "range", Message: "CURRENT_PERIOD requires enabled settlements and an open period"}
	}

	var from, to time.Time
	to = now
	localNow := now.In(location)
	localDayStart := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, location)
	switch preset {
	case PresetCurrentPeriod:
		var startsAt string
		if err := s.queryer().QueryRowContext(ctx, `SELECT starts_at FROM periods WHERE group_id=? AND status='OPEN'`, groupID).Scan(&startsAt); err != nil {
			return resolvedRange{}, err
		}
		parsed, err := time.Parse(time.RFC3339Nano, startsAt)
		if err != nil {
			return resolvedRange{}, fmt.Errorf("parse current period start: %w", err)
		}
		from = parsed.UTC()
	case PresetLast30Days:
		from = localDayStart.AddDate(0, 0, -29).UTC()
	case PresetLast90Days:
		from = localDayStart.AddDate(0, 0, -89).UTC()
	case PresetLast12Months:
		from = time.Date(localNow.Year(), localNow.Month(), 1, 0, 0, 0, 0, location).AddDate(0, -11, 0).UTC()
	case PresetAllTime:
		from = configuration.groupCreatedAt.UTC()
	case PresetCustom:
		if strings.TrimSpace(query.From) == "" || strings.TrimSpace(query.To) == "" {
			return resolvedRange{}, domain.ValidationError{Field: "from", Message: "and to are required for CUSTOM"}
		}
		parsedFrom, err := time.ParseInLocation("2006-01-02", strings.TrimSpace(query.From), location)
		if err != nil {
			return resolvedRange{}, domain.ValidationError{Field: "from", Message: "must be a YYYY-MM-DD date in the group timezone"}
		}
		parsedTo, err := time.ParseInLocation("2006-01-02", strings.TrimSpace(query.To), location)
		if err != nil {
			return resolvedRange{}, domain.ValidationError{Field: "to", Message: "must be a YYYY-MM-DD date in the group timezone"}
		}
		from, to = parsedFrom.UTC(), parsedTo.AddDate(0, 0, 1).UTC()
		if !from.Before(now) {
			return resolvedRange{}, domain.ValidationError{Field: "from", Message: "must start before the current time"}
		}
		if to.After(now) {
			to = now
		}
	default:
		return resolvedRange{}, domain.ValidationError{Field: "range", Message: "contains an unsupported statistics preset"}
	}
	if preset != PresetCustom && (strings.TrimSpace(query.From) != "" || strings.TrimSpace(query.To) != "") {
		return resolvedRange{}, domain.ValidationError{Field: "from", Message: "and to are accepted only for CUSTOM"}
	}
	if !from.Before(to) {
		return resolvedRange{}, domain.ValidationError{Field: "to", Message: "must be later than from"}
	}

	bucket := defaultBucketFor(preset, from, to)
	buckets, err := buildBuckets(from, to, location, bucket)
	if err != nil {
		return resolvedRange{}, err
	}
	generatedAt := platform.Timestamp(now)
	return resolvedRange{
		meta: Meta{
			GeneratedAt:            generatedAt,
			Timezone:               configuration.timezone,
			Preset:                 preset,
			FromInclusive:          platform.Timestamp(from),
			ToExclusive:            platform.Timestamp(to),
			Bucket:                 bucket,
			CurrentPeriodAvailable: currentPeriodAvailable,
		},
		from: from, to: to, location: location, buckets: buckets,
	}, nil
}

func (s Service) queryer() statisticsQueryer {
	if s.reader != nil {
		return s.reader
	}
	return s.DB
}

func defaultBucketFor(preset Preset, from, to time.Time) Bucket {
	switch preset {
	case PresetLast30Days:
		return BucketDay
	case PresetLast90Days:
		return BucketWeek
	case PresetLast12Months:
		return BucketMonth
	}
	days := to.Sub(from).Hours() / 24
	if days <= 45 {
		return BucketDay
	}
	if days <= 400 {
		return BucketWeek
	}
	localFrom, localTo := from.In(time.UTC), to.In(time.UTC)
	calendarMonths := (localTo.Year()-localFrom.Year())*12 + int(localTo.Month()-localFrom.Month()) + 1
	if calendarMonths <= maxSeriesBuckets {
		return BucketMonth
	}
	return BucketYear
}

func buildBuckets(from, to time.Time, location *time.Location, bucket Bucket) ([]bucketWindow, error) {
	localFrom := from.In(location)
	localTo := to.In(location)
	cursor := floorBucket(localFrom, bucket)
	result := make([]bucketWindow, 0, 32)
	for cursor.Before(localTo) {
		next := nextBucket(cursor, bucket)
		windowFrom := cursor
		if localFrom.After(windowFrom) {
			windowFrom = localFrom
		}
		windowTo := next
		if localTo.Before(windowTo) {
			windowTo = localTo
		}
		result = append(result, bucketWindow{periodStart: cursor, from: windowFrom.UTC(), to: windowTo.UTC()})
		if len(result) > maxSeriesBuckets {
			return nil, domain.ValidationError{Field: "range", Message: "produces more than 60 time-series buckets"}
		}
		cursor = next
	}
	return result, nil
}

func floorBucket(value time.Time, bucket Bucket) time.Time {
	year, month, day := value.Date()
	start := time.Date(year, month, day, 0, 0, 0, 0, value.Location())
	switch bucket {
	case BucketWeek:
		daysSinceMonday := (int(start.Weekday()) + 6) % 7
		return start.AddDate(0, 0, -daysSinceMonday)
	case BucketMonth:
		return time.Date(year, month, 1, 0, 0, 0, 0, value.Location())
	case BucketYear:
		return time.Date(year, time.January, 1, 0, 0, 0, 0, value.Location())
	default:
		return start
	}
}

func nextBucket(value time.Time, bucket Bucket) time.Time {
	switch bucket {
	case BucketWeek:
		return value.AddDate(0, 0, 7)
	case BucketMonth:
		return value.AddDate(0, 1, 0)
	case BucketYear:
		return value.AddDate(1, 0, 0)
	default:
		return value.AddDate(0, 0, 1)
	}
}

func bucketValues(rangeValue resolvedRange) (string, []any) {
	rows := make([]string, len(rangeValue.buckets))
	args := make([]any, 0, len(rangeValue.buckets)*3)
	for index, bucket := range rangeValue.buckets {
		rows[index] = "(?,?,?)"
		args = append(args, index, platform.Timestamp(bucket.from), platform.Timestamp(bucket.to))
	}
	return strings.Join(rows, ","), args
}
