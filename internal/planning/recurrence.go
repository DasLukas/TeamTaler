package planning

import (
	"sort"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/domain"
)

const (
	// RecurrenceDaily repeats after a number of local calendar days.
	RecurrenceDaily = "DAILY"
	// RecurrenceWeekly repeats on selected local weekdays.
	RecurrenceWeekly = "WEEKLY"
	// RecurrenceMonthly repeats by a selected monthly strategy.
	RecurrenceMonthly = "MONTHLY"
	// RecurrenceYearly repeats on the anchor month and day.
	RecurrenceYearly = "YEARLY"

	// MonthlyDayOfMonth repeats on the anchor numeric day and skips months that do not contain it.
	MonthlyDayOfMonth = "DAY_OF_MONTH"
	// MonthlyNthWeekday repeats on the anchor weekday ordinal within the month.
	MonthlyNthWeekday = "NTH_WEEKDAY"
	// MonthlyLastDay repeats on the final local day of each selected month.
	MonthlyLastDay = "LAST_DAY"

	// RecurrenceRangeNever keeps a series open and relies on bounded materialization.
	RecurrenceRangeNever = "NEVER"
	// RecurrenceRangeCount stops after a bounded number of occurrences.
	RecurrenceRangeCount = "COUNT"
	// RecurrenceRangeUntil stops after an inclusive local calendar date.
	RecurrenceRangeUntil = "UNTIL"
)

// RecurrenceRangeInput selects one mutually exclusive recurrence end condition.
// Type is NEVER, COUNT, or UNTIL; only the field associated with Type is used.
// Count includes the first occurrence and Until is an inclusive ISO local date.
type RecurrenceRangeInput struct {
	Type  string  `json:"type"`
	Count *int    `json:"count,omitempty"`
	Until *string `json:"until,omitempty"`
}

// RecurrenceInput is the structured recurrence rule accepted by the planning
// service. Frequency and Interval define the cadence; Weekdays applies to
// weekly rules, MonthlyMode applies to monthly rules, and Range bounds
// materialization. Rules are evaluated in the series' pinned local time zone.
type RecurrenceInput struct {
	Frequency   string               `json:"frequency"`
	Interval    int                  `json:"interval"`
	Weekdays    []string             `json:"weekdays,omitempty"`
	MonthlyMode string               `json:"monthlyMode,omitempty"`
	Range       RecurrenceRangeInput `json:"range"`
}

var weekdayNumber = map[string]time.Weekday{
	"SU": time.Sunday,
	"MO": time.Monday,
	"TU": time.Tuesday,
	"WE": time.Wednesday,
	"TH": time.Thursday,
	"FR": time.Friday,
	"SA": time.Saturday,
}

var weekdayCode = map[time.Weekday]string{
	time.Sunday: "SU", time.Monday: "MO", time.Tuesday: "TU", time.Wednesday: "WE",
	time.Thursday: "TH", time.Friday: "FR", time.Saturday: "SA",
}

func normalizeRecurrence(input *RecurrenceInput, anchor time.Time, location *time.Location) error {
	input.Frequency = strings.ToUpper(strings.TrimSpace(input.Frequency))
	if input.Interval < 1 || input.Interval > 99 {
		return domain.ValidationError{Field: "recurrence.interval", Message: "must be between 1 and 99"}
	}
	localAnchor := anchor.In(location)
	switch input.Frequency {
	case RecurrenceDaily, RecurrenceYearly:
		input.Weekdays = nil
		input.MonthlyMode = ""
	case RecurrenceWeekly:
		input.MonthlyMode = ""
		seen := map[string]struct{}{}
		for _, weekday := range input.Weekdays {
			weekday = strings.ToUpper(strings.TrimSpace(weekday))
			if _, valid := weekdayNumber[weekday]; !valid {
				return domain.ValidationError{Field: "recurrence.weekdays", Message: "contains an unsupported weekday"}
			}
			seen[weekday] = struct{}{}
		}
		if len(seen) == 0 {
			seen[weekdayCode[localAnchor.Weekday()]] = struct{}{}
		}
		if _, includesAnchor := seen[weekdayCode[localAnchor.Weekday()]]; !includesAnchor {
			return domain.ValidationError{Field: "recurrence.weekdays", Message: "must include the first occurrence weekday"}
		}
		input.Weekdays = input.Weekdays[:0]
		for weekday := range seen {
			input.Weekdays = append(input.Weekdays, weekday)
		}
		sort.Slice(input.Weekdays, func(i, j int) bool {
			return weekdaySortIndex(input.Weekdays[i]) < weekdaySortIndex(input.Weekdays[j])
		})
	case RecurrenceMonthly:
		input.Weekdays = nil
		input.MonthlyMode = strings.ToUpper(strings.TrimSpace(input.MonthlyMode))
		if input.MonthlyMode == "" {
			input.MonthlyMode = MonthlyDayOfMonth
		}
		if input.MonthlyMode != MonthlyDayOfMonth && input.MonthlyMode != MonthlyNthWeekday && input.MonthlyMode != MonthlyLastDay {
			return domain.ValidationError{Field: "recurrence.monthlyMode", Message: "is unsupported"}
		}
		if input.MonthlyMode == MonthlyLastDay && localAnchor.Day() != daysInMonth(localAnchor.Year(), localAnchor.Month(), location) {
			return domain.ValidationError{Field: "recurrence.monthlyMode", Message: "requires the first occurrence to be the last day of its month"}
		}
	default:
		return domain.ValidationError{Field: "recurrence.frequency", Message: "is unsupported"}
	}

	input.Range.Type = strings.ToUpper(strings.TrimSpace(input.Range.Type))
	switch input.Range.Type {
	case RecurrenceRangeNever:
		input.Range.Count = nil
		input.Range.Until = nil
	case RecurrenceRangeCount:
		input.Range.Until = nil
		if input.Range.Count == nil || *input.Range.Count < 2 || *input.Range.Count > 500 {
			return domain.ValidationError{Field: "recurrence.range.count", Message: "must be between 2 and 500"}
		}
	case RecurrenceRangeUntil:
		input.Range.Count = nil
		if input.Range.Until == nil {
			return domain.ValidationError{Field: "recurrence.range.until", Message: "is required"}
		}
		until, err := time.Parse("2006-01-02", strings.TrimSpace(*input.Range.Until))
		if err != nil {
			return domain.ValidationError{Field: "recurrence.range.until", Message: "must be an ISO calendar date"}
		}
		anchorDate := time.Date(localAnchor.Year(), localAnchor.Month(), localAnchor.Day(), 0, 0, 0, 0, time.UTC)
		if until.Before(anchorDate) {
			return domain.ValidationError{Field: "recurrence.range.until", Message: "must not be before the first occurrence"}
		}
		value := until.Format("2006-01-02")
		input.Range.Until = &value
	default:
		return domain.ValidationError{Field: "recurrence.range.type", Message: "is unsupported"}
	}
	return nil
}

func weekdaySortIndex(code string) int {
	weekday := weekdayNumber[code]
	if weekday == time.Sunday {
		return 6
	}
	return int(weekday) - 1
}

func recurrenceOccurrences(anchorUTC time.Time, location *time.Location, rule RecurrenceInput, horizonUTC time.Time) []time.Time {
	anchor := anchorUTC.In(location)
	dates := recurrenceOccurrenceDates(anchor, location, rule, horizonUTC)
	result := make([]time.Time, 0, len(dates))
	for _, date := range dates {
		candidate := resolveLocalTime(location, date.Year(), date.Month(), date.Day(), anchor.Hour(), anchor.Minute(), anchor.Second(), anchor.Nanosecond())
		if !candidate.Before(anchorUTC) && !candidate.After(horizonUTC) {
			result = append(result, candidate.UTC())
		}
	}
	return result
}

type indexedRecurrenceDate struct {
	date  time.Time
	index int64
}

// recurrenceOccurrenceDates evaluates a recurrence entirely in local civil
// dates. Returning dates separately from instants lets all-day series derive
// every start and exclusive end boundary independently in the pinned time zone
// instead of adding fixed 24-hour durations across daylight-saving changes.
func recurrenceOccurrenceDates(anchor time.Time, location *time.Location, rule RecurrenceInput, horizonUTC time.Time) []time.Time {
	localAnchor := anchor.In(location)
	lastLocal := horizonUTC.In(location)
	anchorDate := time.Date(localAnchor.Year(), localAnchor.Month(), localAnchor.Day(), 0, 0, 0, 0, location)
	lastDate := time.Date(lastLocal.Year(), lastLocal.Month(), lastLocal.Day(), 0, 0, 0, 0, location)
	indexed := recurrenceOccurrenceDatesBetween(anchor, location, rule, anchorDate, lastDate)
	result := make([]time.Time, 0, len(indexed))
	for _, occurrence := range indexed {
		result = append(result, occurrence.date)
	}
	return result
}

// recurrenceOccurrenceDatesBetween seeks directly to a bounded local civil
// window and returns stable zero-based recurrence ordinals. Daily and weekly
// rules use closed-form calendar arithmetic. Monthly and yearly rules seek by
// cadence unit and use the Gregorian cycle only when invalid calendar dates
// must be skipped, so work is independent of the distance from the anchor.
func recurrenceOccurrenceDatesBetween(anchor time.Time, location *time.Location, rule RecurrenceInput, fromCivil, toCivil time.Time) []indexedRecurrenceDate {
	localAnchor := anchor.In(location)
	anchorDate := civilDate(localAnchor, location)
	fromDate := time.Date(fromCivil.Year(), fromCivil.Month(), fromCivil.Day(), 0, 0, 0, 0, location)
	toDate := time.Date(toCivil.Year(), toCivil.Month(), toCivil.Day(), 0, 0, 0, 0, location)
	if fromDate.Before(anchorDate) {
		fromDate = anchorDate
	}
	if toDate.Before(fromDate) || rule.Interval < 1 {
		return nil
	}
	untilIndex := int(^uint(0) >> 1)
	if rule.Range.Until != nil {
		until, err := time.Parse(time.DateOnly, *rule.Range.Until)
		if err != nil {
			return nil
		}
		untilIndex = civilDayIndex(until)
		if civilDayIndex(fromDate) > untilIndex {
			return nil
		}
	}
	countLimit := int64(-1)
	if rule.Range.Count != nil {
		countLimit = int64(*rule.Range.Count)
	}
	allowed := func(index int64, date time.Time) bool {
		return (countLimit < 0 || index < countLimit) && civilDayIndex(date) <= untilIndex
	}
	result := []indexedRecurrenceDate{}
	switch rule.Frequency {
	case RecurrenceDaily:
		daysFromAnchor := int64(civilDayIndex(fromDate) - civilDayIndex(anchorDate))
		step := int64(rule.Interval)
		occurrenceIndex := ceilDivision(daysFromAnchor, step)
		for {
			date := anchorDate.AddDate(0, 0, int(occurrenceIndex*step))
			if date.After(toDate) || !allowed(occurrenceIndex, date) {
				break
			}
			result = append(result, indexedRecurrenceDate{date: date, index: occurrenceIndex})
			occurrenceIndex++
		}
	case RecurrenceWeekly:
		positions := recurrenceWeekdayPositions(rule, anchorDate.Weekday())
		anchorPosition := weekdaySortIndex(weekdayCode[anchorDate.Weekday()])
		anchorMonday := anchorDate.AddDate(0, 0, -anchorPosition)
		fromMonday := fromDate.AddDate(0, 0, -weekdaySortIndex(weekdayCode[fromDate.Weekday()]))
		weeksFromAnchor := int64(civilDayIndex(fromMonday)-civilDayIndex(anchorMonday)) / 7
		block := int64(0)
		if weeksFromAnchor > 0 {
			block = weeksFromAnchor / int64(rule.Interval)
		}
		firstWeekCount := 0
		for _, position := range positions {
			if position >= anchorPosition {
				firstWeekCount++
			}
		}
		for {
			monday := anchorMonday.AddDate(0, 0, int(block)*rule.Interval*7)
			if monday.After(toDate) {
				break
			}
			for positionIndex, position := range positions {
				if block == 0 && position < anchorPosition {
					continue
				}
				date := monday.AddDate(0, 0, position)
				if date.Before(fromDate) || date.Before(anchorDate) || date.After(toDate) {
					continue
				}
				var occurrenceIndex int64
				if block == 0 {
					occurrenceIndex = int64(positionIndex - (len(positions) - firstWeekCount))
				} else {
					occurrenceIndex = int64(firstWeekCount) + (block-1)*int64(len(positions)) + int64(positionIndex)
				}
				if !allowed(occurrenceIndex, date) {
					return result
				}
				result = append(result, indexedRecurrenceDate{date: date, index: occurrenceIndex})
			}
			block++
		}
	case RecurrenceMonthly, RecurrenceYearly:
		cadence := recurrenceCadenceAtOrBefore(anchorDate, fromDate, rule)
		for {
			date, valid := recurrenceUnitCandidate(anchorDate, localAnchor, rule, cadence)
			if valid && date.After(toDate) {
				break
			}
			if !valid {
				// Even an invalid monthly or yearly candidate has a stable
				// cadence date; stop once its unit is beyond the query.
				if recurrenceUnitAfter(anchorDate, toDate, rule, cadence) {
					break
				}
				cadence++
				continue
			}
			occurrenceIndex := validRecurrenceUnitsBefore(anchorDate, localAnchor, rule, cadence)
			if !date.Before(fromDate) {
				if !allowed(occurrenceIndex, date) {
					break
				}
				result = append(result, indexedRecurrenceDate{date: date, index: occurrenceIndex})
			}
			cadence++
		}
	}
	return result
}

func civilDate(value time.Time, location *time.Location) time.Time {
	return time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, location)
}

func ceilDivision(value, divisor int64) int64 {
	if value <= 0 {
		return 0
	}
	return (value + divisor - 1) / divisor
}

func recurrenceWeekdayPositions(rule RecurrenceInput, fallback time.Weekday) []int {
	unique := map[int]struct{}{}
	for _, code := range rule.Weekdays {
		weekday, ok := weekdayNumber[code]
		if ok {
			unique[weekdaySortIndex(weekdayCode[weekday])] = struct{}{}
		}
	}
	if len(unique) == 0 {
		unique[weekdaySortIndex(weekdayCode[fallback])] = struct{}{}
	}
	positions := make([]int, 0, len(unique))
	for position := range unique {
		positions = append(positions, position)
	}
	sort.Ints(positions)
	return positions
}

func recurrenceCadenceAtOrBefore(anchorDate, targetDate time.Time, rule RecurrenceInput) int64 {
	switch rule.Frequency {
	case RecurrenceMonthly:
		months := int64((targetDate.Year()-anchorDate.Year())*12 + int(targetDate.Month()-anchorDate.Month()))
		if months <= 0 {
			return 0
		}
		return months / int64(rule.Interval)
	case RecurrenceYearly:
		years := int64(targetDate.Year() - anchorDate.Year())
		if years <= 0 {
			return 0
		}
		return years / int64(rule.Interval)
	default:
		return 0
	}
}

func recurrenceUnitCandidate(anchorDate, localAnchor time.Time, rule RecurrenceInput, cadence int64) (time.Time, bool) {
	switch rule.Frequency {
	case RecurrenceMonthly:
		monthStart := time.Date(anchorDate.Year(), anchorDate.Month()+time.Month(cadence*int64(rule.Interval)), 1, 0, 0, 0, 0, anchorDate.Location())
		days := daysInMonth(monthStart.Year(), monthStart.Month(), anchorDate.Location())
		day := localAnchor.Day()
		switch rule.MonthlyMode {
		case MonthlyLastDay:
			day = days
		case MonthlyNthWeekday:
			ordinal := (localAnchor.Day()-1)/7 + 1
			firstWeekday := int(monthStart.Weekday())
			targetWeekday := int(localAnchor.Weekday())
			day = 1 + (targetWeekday-firstWeekday+7)%7 + (ordinal-1)*7
		}
		if day > days {
			return monthStart, false
		}
		return time.Date(monthStart.Year(), monthStart.Month(), day, 0, 0, 0, 0, anchorDate.Location()), true
	case RecurrenceYearly:
		year := anchorDate.Year() + int(cadence)*rule.Interval
		candidate := time.Date(year, localAnchor.Month(), localAnchor.Day(), 0, 0, 0, 0, anchorDate.Location())
		if candidate.Month() != localAnchor.Month() || candidate.Day() != localAnchor.Day() {
			return time.Date(year, localAnchor.Month(), 1, 0, 0, 0, 0, anchorDate.Location()), false
		}
		return candidate, true
	default:
		return time.Time{}, false
	}
}

func recurrenceUnitAfter(anchorDate, toDate time.Time, rule RecurrenceInput, cadence int64) bool {
	switch rule.Frequency {
	case RecurrenceMonthly:
		unit := time.Date(anchorDate.Year(), anchorDate.Month()+time.Month(cadence*int64(rule.Interval)), 1, 0, 0, 0, 0, anchorDate.Location())
		return unit.After(toDate)
	case RecurrenceYearly:
		return anchorDate.Year()+int(cadence)*rule.Interval > toDate.Year()
	default:
		return true
	}
}

func validRecurrenceUnitsBefore(anchorDate, localAnchor time.Time, rule RecurrenceInput, cadence int64) int64 {
	if cadence <= 0 {
		return 0
	}
	if recurrenceUnitAlwaysValid(localAnchor, rule) {
		return cadence
	}
	period := recurrenceUnitPeriod(rule)
	validPerPeriod := int64(0)
	for index := int64(0); index < period; index++ {
		if _, valid := recurrenceUnitCandidate(anchorDate, localAnchor, rule, index); valid {
			validPerPeriod++
		}
	}
	complete := cadence / period
	valid := complete * validPerPeriod
	for index := int64(0); index < cadence%period; index++ {
		if _, ok := recurrenceUnitCandidate(anchorDate, localAnchor, rule, index); ok {
			valid++
		}
	}
	return valid
}

func recurrenceUnitAlwaysValid(localAnchor time.Time, rule RecurrenceInput) bool {
	if rule.Frequency == RecurrenceYearly {
		return localAnchor.Month() != time.February || localAnchor.Day() != 29
	}
	if rule.MonthlyMode == MonthlyLastDay {
		return true
	}
	if rule.MonthlyMode == MonthlyNthWeekday {
		return (localAnchor.Day()-1)/7+1 <= 4
	}
	return localAnchor.Day() <= 28
}

func recurrenceUnitPeriod(rule RecurrenceInput) int64 {
	base := int64(4800)
	if rule.Frequency == RecurrenceYearly {
		base = 400
	}
	return base / greatestCommonDivisor(base, int64(rule.Interval))
}

func greatestCommonDivisor(left, right int64) int64 {
	for right != 0 {
		left, right = right, left%right
	}
	return left
}

func recurrenceDateMatches(anchorDate, candidateDate, localAnchor time.Time, rule RecurrenceInput, weekdays map[time.Weekday]struct{}) bool {
	days := civilDayIndex(candidateDate) - civilDayIndex(anchorDate)
	switch rule.Frequency {
	case RecurrenceDaily:
		return days%rule.Interval == 0
	case RecurrenceWeekly:
		anchorMonday := anchorDate.AddDate(0, 0, -weekdaySortIndex(weekdayCode[anchorDate.Weekday()]))
		candidateMonday := candidateDate.AddDate(0, 0, -weekdaySortIndex(weekdayCode[candidateDate.Weekday()]))
		weeks := (civilDayIndex(candidateMonday) - civilDayIndex(anchorMonday)) / 7
		_, selected := weekdays[candidateDate.Weekday()]
		return weeks >= 0 && weeks%rule.Interval == 0 && selected
	case RecurrenceMonthly:
		months := (candidateDate.Year()-anchorDate.Year())*12 + int(candidateDate.Month()-anchorDate.Month())
		if months < 0 || months%rule.Interval != 0 {
			return false
		}
		switch rule.MonthlyMode {
		case MonthlyLastDay:
			return candidateDate.Day() == daysInMonth(candidateDate.Year(), candidateDate.Month(), candidateDate.Location())
		case MonthlyNthWeekday:
			ordinal := (localAnchor.Day()-1)/7 + 1
			return candidateDate.Weekday() == localAnchor.Weekday() && (candidateDate.Day()-1)/7+1 == ordinal
		default:
			return candidateDate.Day() == localAnchor.Day()
		}
	case RecurrenceYearly:
		years := candidateDate.Year() - anchorDate.Year()
		return years >= 0 && years%rule.Interval == 0 && candidateDate.Month() == localAnchor.Month() && candidateDate.Day() == localAnchor.Day()
	default:
		return false
	}
}

func civilDayIndex(value time.Time) int {
	noonUTC := time.Date(value.Year(), value.Month(), value.Day(), 12, 0, 0, 0, time.UTC)
	return int(noonUTC.Unix() / int64(24*time.Hour/time.Second))
}

func daysInMonth(year int, month time.Month, location *time.Location) int {
	return time.Date(year, month+1, 0, 12, 0, 0, 0, location).Day()
}

// resolveLocalTime returns the earliest instant for an ambiguous wall time and
// advances through a daylight-saving gap to the first valid wall time.
func resolveLocalTime(location *time.Location, year int, month time.Month, day, hour, minute, second, nanosecond int) time.Time {
	nominalUTC := time.Date(year, month, day, hour, minute, second, nanosecond, time.UTC)
	offsets := localOffsetsAroundDate(location, year, month, day)
	if first := earliestMatchingLocal(location, nominalUTC, year, month, day, hour, minute, second, offsets); !first.IsZero() {
		return first.UTC()
	}
	for delta := 1; delta <= 180; delta++ {
		requested := nominalUTC.Add(time.Duration(delta) * time.Minute)
		candidate := earliestMatchingLocal(location, requested, requested.Year(), requested.Month(), requested.Day(), requested.Hour(), requested.Minute(), second, offsets)
		if !candidate.IsZero() {
			return candidate.UTC()
		}
	}
	return time.Date(year, month, day, hour, minute, second, nanosecond, location).UTC()
}

func localOffsetsAroundDate(location *time.Location, year int, month time.Month, day int) []int {
	center := time.Date(year, month, day, 12, 0, 0, 0, location)
	seen := map[int]struct{}{}
	result := []int{}
	for hours := -36; hours <= 36; hours += 3 {
		_, offset := center.Add(time.Duration(hours) * time.Hour).Zone()
		if _, exists := seen[offset]; !exists {
			seen[offset] = struct{}{}
			result = append(result, offset)
		}
	}
	return result
}

func earliestMatchingLocal(location *time.Location, nominalUTC time.Time, year int, month time.Month, day, hour, minute, second int, offsets []int) time.Time {
	var first time.Time
	for _, offsetSeconds := range offsets {
		candidate := nominalUTC.Add(-time.Duration(offsetSeconds) * time.Second)
		local := candidate.In(location)
		if local.Year() == year && local.Month() == month && local.Day() == day && local.Hour() == hour && local.Minute() == minute && local.Second() == second && (first.IsZero() || candidate.Before(first)) {
			first = candidate
		}
	}
	return first
}
