package notifications

import "sort"

// EventType identifies a stable notification-producing domain event.
type EventType string

const (
	// TypeBookingAssigned identifies a booking created for another membership.
	TypeBookingAssigned EventType = "BOOKING_ASSIGNED"
	// TypeBookingReversed identifies an externally reversed booking.
	TypeBookingReversed EventType = "BOOKING_REVERSED"
	// TypePaymentRecorded identifies an externally recorded payment.
	TypePaymentRecorded EventType = "PAYMENT_RECORDED"
	// TypePaymentReversed identifies an externally reversed payment.
	TypePaymentReversed EventType = "PAYMENT_REVERSED"
	// TypeSettlementCreated identifies a newly generated period statement.
	TypeSettlementCreated EventType = "SETTLEMENT_CREATED"
	// TypeSettlementDueSoon identifies a statement approaching its due date.
	TypeSettlementDueSoon EventType = "SETTLEMENT_DUE_SOON"
	// TypeSettlementOverdue identifies a statement that remains unpaid after its due date.
	TypeSettlementOverdue EventType = "SETTLEMENT_OVERDUE"
)

// Channel identifies an optional external delivery mechanism. In-app delivery
// is canonical and deliberately is not represented as a configurable channel.
type Channel string

const (
	// ChannelEmail delivers a notification to the membership account address.
	ChannelEmail Channel = "EMAIL"
	// ChannelPush delivers a privacy-safe notification to an enrolled browser.
	ChannelPush Channel = "PUSH"
)

// EventDefinition describes one supported notification event for APIs and
// channel renderers. Copy is intentionally generic and contains no member,
// amount, item, or deadline information.
type EventDefinition struct {
	Type              EventType `json:"type"`
	Category          string    `json:"category"`
	Label             string    `json:"label"`
	Description       string    `json:"description"`
	Route             string    `json:"route"`
	PushTitle         string    `json:"-"`
	PushBody          string    `json:"-"`
	PushTTLSeconds    int       `json:"pushTtlSeconds"`
	PushUrgency       string    `json:"pushUrgency"`
	DefaultEnabled    bool      `json:"defaultEnabled"`
	Reminder          bool      `json:"reminder"`
	SupportedChannels []Channel `json:"supportedChannels"`
}

var eventCatalog = map[EventType]EventDefinition{
	TypeBookingAssigned: {
		Type: TypeBookingAssigned, Category: "BOOKINGS", Label: "Neue Buchung",
		Description: "Eine andere Person bucht etwas auf das Mitgliedskonto.", Route: "/notifications", PushTitle: "Neue Buchung", PushBody: "In deiner Gruppe wurde etwas auf dein Konto gebucht.", PushTTLSeconds: 21600, PushUrgency: "normal", DefaultEnabled: true,
	},
	TypeBookingReversed: {
		Type: TypeBookingReversed, Category: "BOOKINGS", Label: "Buchung storniert",
		Description: "Eine Buchung auf dem Mitgliedskonto wird storniert.", Route: "/notifications", PushTitle: "Buchung storniert", PushBody: "In deiner Gruppe wurde eine Buchung auf deinem Konto storniert.", PushTTLSeconds: 21600, PushUrgency: "normal", DefaultEnabled: true,
	},
	TypePaymentRecorded: {
		Type: TypePaymentRecorded, Category: "PAYMENTS", Label: "Zahlung eingegangen",
		Description: "Eine Zahlung wird dem Mitgliedskonto gutgeschrieben.", Route: "/notifications", PushTitle: "Zahlung eingegangen", PushBody: "In deiner Gruppe wurde deinem Konto eine Zahlung gutgeschrieben.", PushTTLSeconds: 21600, PushUrgency: "normal", DefaultEnabled: true,
	},
	TypePaymentReversed: {
		Type: TypePaymentReversed, Category: "PAYMENTS", Label: "Zahlung storniert",
		Description: "Eine Zahlung auf dem Mitgliedskonto wird storniert.", Route: "/notifications", PushTitle: "Zahlung storniert", PushBody: "In deiner Gruppe wurde eine Zahlung auf deinem Konto storniert.", PushTTLSeconds: 21600, PushUrgency: "normal", DefaultEnabled: true,
	},
	TypeSettlementCreated: {
		Type: TypeSettlementCreated, Category: "SETTLEMENTS", Label: "Neue Abrechnung",
		Description: "Für das Mitglied wurde eine neue Abrechnung erstellt.", Route: "/notifications", PushTitle: "Neue Abrechnung", PushBody: "In deiner Gruppe ist eine neue Abrechnung für dich verfügbar.", PushTTLSeconds: 86400, PushUrgency: "normal", DefaultEnabled: true,
	},
	TypeSettlementDueSoon: {
		Type: TypeSettlementDueSoon, Category: "SETTLEMENTS", Label: "Abrechnung bald fällig",
		Description: "Eine offene Abrechnung ist bald fällig.", Route: "/notifications", PushTitle: "Abrechnung bald fällig", PushBody: "Eine offene Abrechnung in deiner Gruppe ist bald fällig.", PushTTLSeconds: 86400, PushUrgency: "normal", Reminder: true,
	},
	TypeSettlementOverdue: {
		Type: TypeSettlementOverdue, Category: "SETTLEMENTS", Label: "Abrechnung überfällig",
		Description: "Eine offene Abrechnung ist überfällig.", Route: "/notifications", PushTitle: "Abrechnung überfällig", PushBody: "Eine offene Abrechnung in deiner Gruppe ist überfällig.", PushTTLSeconds: 86400, PushUrgency: "high", Reminder: true,
	},
}

func init() {
	for eventType, definition := range eventCatalog {
		definition.SupportedChannels = []Channel{ChannelEmail, ChannelPush}
		eventCatalog[eventType] = definition
	}
}

// Catalog returns every supported event in stable category and type order.
// The returned definitions contain independent channel slices and are safe for
// callers to modify.
func Catalog() []EventDefinition {
	result := make([]EventDefinition, 0, len(eventCatalog))
	for _, definition := range eventCatalog {
		definition.SupportedChannels = append([]Channel(nil), definition.SupportedChannels...)
		result = append(result, definition)
	}
	sort.Slice(result, func(left, right int) bool {
		if result[left].Category != result[right].Category {
			return result[left].Category < result[right].Category
		}
		return result[left].Type < result[right].Type
	})
	return result
}

// Definition returns the immutable catalog definition for eventType and
// reports whether the event is supported by this binary.
func Definition(eventType EventType) (EventDefinition, bool) {
	definition, found := eventCatalog[eventType]
	if found {
		definition.SupportedChannels = append([]Channel(nil), definition.SupportedChannels...)
	}
	return definition, found
}
