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
		Type: TypeBookingAssigned, Category: "BOOKINGS", Label: "Booking assigned",
		Description: "A booking was assigned to the member account.", Route: "/notifications", PushTitle: "Booking activity", PushBody: "A booking was assigned in your group.", PushTTLSeconds: 21600, PushUrgency: "normal", DefaultEnabled: true,
	},
	TypeBookingReversed: {
		Type: TypeBookingReversed, Category: "BOOKINGS", Label: "Booking reversed",
		Description: "A booking on the member account was reversed.", Route: "/notifications", PushTitle: "Booking activity", PushBody: "A booking was reversed in your group.", PushTTLSeconds: 21600, PushUrgency: "normal", DefaultEnabled: true,
	},
	TypePaymentRecorded: {
		Type: TypePaymentRecorded, Category: "PAYMENTS", Label: "Payment recorded",
		Description: "A payment was recorded for the member account.", Route: "/notifications", PushTitle: "Payment activity", PushBody: "A payment was recorded in your group.", PushTTLSeconds: 21600, PushUrgency: "normal", DefaultEnabled: true,
	},
	TypePaymentReversed: {
		Type: TypePaymentReversed, Category: "PAYMENTS", Label: "Payment reversed",
		Description: "A payment on the member account was reversed.", Route: "/notifications", PushTitle: "Payment activity", PushBody: "A payment was reversed in your group.", PushTTLSeconds: 21600, PushUrgency: "normal", DefaultEnabled: true,
	},
	TypeSettlementCreated: {
		Type: TypeSettlementCreated, Category: "SETTLEMENTS", Label: "Settlement created",
		Description: "A new settlement is available for the member.", Route: "/notifications", PushTitle: "Settlement available", PushBody: "A settlement is available in your group.", PushTTLSeconds: 86400, PushUrgency: "normal", DefaultEnabled: true,
	},
	TypeSettlementDueSoon: {
		Type: TypeSettlementDueSoon, Category: "SETTLEMENTS", Label: "Settlement due soon",
		Description: "An unpaid settlement is approaching its due date.", Route: "/notifications", PushTitle: "Settlement reminder", PushBody: "A settlement in your group is due soon.", PushTTLSeconds: 86400, PushUrgency: "normal", Reminder: true,
	},
	TypeSettlementOverdue: {
		Type: TypeSettlementOverdue, Category: "SETTLEMENTS", Label: "Settlement overdue",
		Description: "A settlement remains unpaid after its due date.", Route: "/notifications", PushTitle: "Settlement reminder", PushBody: "A settlement in your group is overdue.", PushTTLSeconds: 86400, PushUrgency: "high", Reminder: true,
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
