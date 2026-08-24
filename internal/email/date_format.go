package email

import "time"

// formatGermanCalendarDate converts an ISO calendar date to DD.MM.YYYY for
// user-facing email copy. Invalid legacy input is returned as sanitized inline
// text so an existing outbox record can still be delivered.
func formatGermanCalendarDate(value string) string {
	inline := safeInline(value)
	date, err := time.Parse("2006-01-02", inline)
	if err != nil {
		return inline
	}
	return date.Format("02.01.2006")
}

// formatGermanDateTime formats an expiry timestamp in UTC for user-facing
// email copy. UTC remains explicit so recipients can interpret the exact expiry
// instant without depending on the mail client's locale or timezone.
func formatGermanDateTime(value time.Time) string {
	return value.UTC().Format("02.01.2006, 15:04 UTC")
}
