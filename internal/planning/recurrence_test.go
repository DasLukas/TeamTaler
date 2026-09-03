package planning

import (
	"errors"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/domain"
)

func TestDailyRecurrencePreservesBerlinWallClockAcrossDST(t *testing.T) {
	location, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("load location: %v", err)
	}
	count := 6
	rule := RecurrenceInput{Frequency: RecurrenceDaily, Interval: 1, Range: RecurrenceRangeInput{Type: RecurrenceRangeCount, Count: &count}}
	tests := []struct {
		name   string
		anchor time.Time
	}{
		{name: "spring", anchor: time.Date(2026, time.March, 27, 9, 30, 0, 0, location)},
		{name: "fall", anchor: time.Date(2026, time.October, 23, 9, 30, 0, 0, location)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			occurrences := recurrenceOccurrences(test.anchor.UTC(), location, rule, test.anchor.AddDate(0, 0, 8).UTC())
			if len(occurrences) != count {
				t.Fatalf("occurrence count=%d, want %d", len(occurrences), count)
			}
			for index, occurrence := range occurrences {
				local := occurrence.In(location)
				if local.Hour() != 9 || local.Minute() != 30 {
					t.Fatalf("occurrence %d local time=%s, want 09:30", index, local.Format(time.RFC3339))
				}
				wantDate := test.anchor.AddDate(0, 0, index)
				if local.Year() != wantDate.Year() || local.Month() != wantDate.Month() || local.Day() != wantDate.Day() {
					t.Fatalf("occurrence %d local date=%s, want %s", index, local.Format("2006-01-02"), wantDate.Format("2006-01-02"))
				}
			}
		})
	}
}

func TestWeeklyRecurrenceRequiresAnchorWeekday(t *testing.T) {
	location, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("load location: %v", err)
	}
	count := 2
	rule := RecurrenceInput{Frequency: RecurrenceWeekly, Interval: 1, Weekdays: []string{"TU"}, Range: RecurrenceRangeInput{Type: RecurrenceRangeCount, Count: &count}}
	err = normalizeRecurrence(&rule, time.Date(2026, time.August, 31, 12, 0, 0, 0, location), location)
	var validation domain.ValidationError
	if !errors.As(err, &validation) || validation.Field != "recurrence.weekdays" {
		t.Fatalf("normalization error=%v, want recurrence.weekdays validation", err)
	}
}

func TestMonthlyLastDayRequiresMatchingFirstOccurrence(t *testing.T) {
	location, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("load location: %v", err)
	}
	count := 2
	rule := RecurrenceInput{Frequency: RecurrenceMonthly, Interval: 1, MonthlyMode: MonthlyLastDay, Range: RecurrenceRangeInput{Type: RecurrenceRangeCount, Count: &count}}
	err = normalizeRecurrence(&rule, time.Date(2026, time.August, 30, 12, 0, 0, 0, location), location)
	var validation domain.ValidationError
	if !errors.As(err, &validation) || validation.Field != "recurrence.monthlyMode" {
		t.Fatalf("normalization error=%v, want recurrence.monthlyMode validation", err)
	}
}

func TestResolveLocalTimeUsesDeterministicDSTPolicy(t *testing.T) {
	location, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("load location: %v", err)
	}
	ambiguous := resolveLocalTime(location, 2026, time.October, 25, 2, 30, 0, 0)
	if want := time.Date(2026, time.October, 25, 0, 30, 0, 0, time.UTC); !ambiguous.Equal(want) {
		t.Fatalf("ambiguous wall time=%s, want earliest %s", ambiguous, want)
	}
	missing := resolveLocalTime(location, 2026, time.March, 29, 2, 30, 0, 0)
	localMissing := missing.In(location)
	if localMissing.Hour() != 3 || localMissing.Minute() != 0 {
		t.Fatalf("missing wall time resolved to %s, want first valid local minute 03:00", localMissing.Format(time.RFC3339))
	}
}

func TestBiweeklyRecurrenceUsesCivilWeeksAcrossDST(t *testing.T) {
	location, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("load location: %v", err)
	}
	count := 4
	anchor := time.Date(2026, time.March, 16, 12, 0, 0, 0, location)
	rule := RecurrenceInput{Frequency: RecurrenceWeekly, Interval: 2, Weekdays: []string{"MO"}, Range: RecurrenceRangeInput{Type: RecurrenceRangeCount, Count: &count}}
	occurrences := recurrenceOccurrences(anchor.UTC(), location, rule, anchor.AddDate(0, 0, 60).UTC())
	if len(occurrences) != count {
		t.Fatalf("occurrence count=%d, want %d", len(occurrences), count)
	}
	for index, occurrence := range occurrences {
		want := anchor.AddDate(0, 0, index*14)
		local := occurrence.In(location)
		if local.Year() != want.Year() || local.Month() != want.Month() || local.Day() != want.Day() || local.Hour() != want.Hour() {
			t.Fatalf("occurrence %d=%s, want local %s", index, local.Format(time.RFC3339), want.Format(time.RFC3339))
		}
	}
}

func TestAllDayRecurrenceReturnsCivilDatesAcrossBerlinDST(t *testing.T) {
	location, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("load location: %v", err)
	}
	count := 5
	anchor := time.Date(2026, time.October, 23, 0, 0, 0, 0, location)
	rule := RecurrenceInput{Frequency: RecurrenceDaily, Interval: 1, Range: RecurrenceRangeInput{Type: RecurrenceRangeCount, Count: &count}}
	dates := recurrenceOccurrenceDates(anchor, location, rule, anchor.AddDate(0, 0, 7).UTC())
	if len(dates) != count {
		t.Fatalf("occurrence count=%d, want %d", len(dates), count)
	}
	for index, date := range dates {
		want := anchor.AddDate(0, 0, index).Format("2006-01-02")
		if got := date.Format("2006-01-02"); got != want {
			t.Fatalf("date %d=%s, want %s", index, got, want)
		}
	}
	start := resolveLocalTime(location, 2026, time.October, 25, 0, 0, 0, 0)
	end := resolveLocalTime(location, 2026, time.October, 26, 0, 0, 0, 0)
	if duration := end.Sub(start); duration != 25*time.Hour {
		t.Fatalf("DST-crossing all-day duration=%s, want 25h from independent local boundaries", duration)
	}
}

func TestRecurrenceWindowSeekSupportsDistantRulesAndRangeLimits(t *testing.T) {
	location, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatal(err)
	}
	anchor := time.Date(2026, time.March, 27, 9, 30, 0, 0, location)
	never := RecurrenceRangeInput{Type: RecurrenceRangeNever}

	daily := RecurrenceInput{Frequency: RecurrenceDaily, Interval: 2, Range: never}
	from := time.Date(2036, time.March, 28, 0, 0, 0, 0, time.UTC)
	to := from.AddDate(0, 0, 8)
	dailyDates := recurrenceOccurrenceDatesBetween(anchor, location, daily, from, to)
	if len(dailyDates) < 4 {
		t.Fatalf("distant daily dates=%v", dailyDates)
	}
	wantDailyIndex := ceilDivision(int64(civilDayIndex(from)-civilDayIndex(anchor)), 2)
	if dailyDates[0].index != wantDailyIndex {
		t.Fatalf("daily index=%d, want %d", dailyDates[0].index, wantDailyIndex)
	}

	weekly := RecurrenceInput{Frequency: RecurrenceWeekly, Interval: 3, Weekdays: []string{"FR", "MO"}, Range: never}
	weeklyDates := recurrenceOccurrenceDatesBetween(anchor, location, weekly, from, to.AddDate(0, 0, 30))
	if len(weeklyDates) == 0 || weeklyDates[0].index < 300 {
		t.Fatalf("distant weekly dates=%v", weeklyDates)
	}
	for _, occurrence := range weeklyDates {
		if occurrence.date.Weekday() != time.Monday && occurrence.date.Weekday() != time.Friday {
			t.Fatalf("weekly occurrence weekday=%s", occurrence.date.Weekday())
		}
	}

	monthlyAnchor := time.Date(2026, time.January, 31, 8, 0, 0, 0, location)
	monthly := RecurrenceInput{Frequency: RecurrenceMonthly, Interval: 1, MonthlyMode: MonthlyDayOfMonth, Range: never}
	monthlyDates := recurrenceOccurrenceDatesBetween(monthlyAnchor, location, monthly,
		time.Date(2400, time.January, 1, 0, 0, 0, 0, time.UTC), time.Date(2400, time.December, 31, 0, 0, 0, 0, time.UTC))
	if len(monthlyDates) != 7 || monthlyDates[0].date.Format(time.DateOnly) != "2400-01-31" || monthlyDates[0].index < 2500 {
		t.Fatalf("distant monthly dates=%v", monthlyDates)
	}
	for index := 1; index < len(monthlyDates); index++ {
		if monthlyDates[index].index != monthlyDates[index-1].index+1 {
			t.Fatalf("monthly indices are not contiguous: %v", monthlyDates)
		}
	}

	yearlyAnchor := time.Date(2028, time.February, 29, 8, 0, 0, 0, location)
	yearly := RecurrenceInput{Frequency: RecurrenceYearly, Interval: 1, Range: never}
	yearlyDates := recurrenceOccurrenceDatesBetween(yearlyAnchor, location, yearly,
		time.Date(2424, time.January, 1, 0, 0, 0, 0, time.UTC), time.Date(2424, time.December, 31, 0, 0, 0, 0, time.UTC))
	if len(yearlyDates) != 1 || yearlyDates[0].date.Format(time.DateOnly) != "2424-02-29" {
		t.Fatalf("distant yearly dates=%v", yearlyDates)
	}
	wantYearlyIndex := int64(leapYearsThrough(2423) - leapYearsThrough(2027))
	if yearlyDates[0].index != wantYearlyIndex {
		t.Fatalf("yearly index=%d, want %d", yearlyDates[0].index, wantYearlyIndex)
	}

	count := 2
	yearly.Range = RecurrenceRangeInput{Type: RecurrenceRangeCount, Count: &count}
	if limited := recurrenceOccurrenceDatesBetween(yearlyAnchor, location, yearly, from, to.AddDate(400, 0, 0)); len(limited) != 0 {
		t.Fatalf("COUNT range leaked distant occurrences=%v", limited)
	}
	until := "2032-12-31"
	yearly.Range = RecurrenceRangeInput{Type: RecurrenceRangeUntil, Until: &until}
	if limited := recurrenceOccurrenceDatesBetween(yearlyAnchor, location, yearly, from, to.AddDate(400, 0, 0)); len(limited) != 0 {
		t.Fatalf("UNTIL range leaked distant occurrences=%v", limited)
	}
}

func leapYearsThrough(year int) int {
	return year/4 - year/100 + year/400
}
