package notifications

import "testing"

func TestCatalogProvidesCompleteSafeDeliveryMetadata(t *testing.T) {
	definitions := Catalog()
	if len(definitions) != 7 {
		t.Fatalf("catalog events=%d, want 7", len(definitions))
	}
	seen := make(map[EventType]struct{}, len(definitions))
	for index, definition := range definitions {
		if definition.Type == "" || definition.Label == "" || definition.Description == "" || definition.Category == "" {
			t.Fatalf("catalog definition %d has incomplete presentation metadata: %#v", index, definition)
		}
		if definition.Route != "/notifications" || definition.PushTitle == "" || definition.PushBody == "" {
			t.Fatalf("catalog definition %s has incomplete privacy-safe routing metadata: %#v", definition.Type, definition)
		}
		if definition.PushTTLSeconds < 1 || (definition.PushUrgency != "normal" && definition.PushUrgency != "high") {
			t.Fatalf("catalog definition %s has invalid delivery metadata: %#v", definition.Type, definition)
		}
		if len(definition.SupportedChannels) != 2 || definition.SupportedChannels[0] != ChannelEmail || definition.SupportedChannels[1] != ChannelPush {
			t.Fatalf("catalog definition %s channels=%v", definition.Type, definition.SupportedChannels)
		}
		if _, duplicate := seen[definition.Type]; duplicate {
			t.Fatalf("catalog contains duplicate event %s", definition.Type)
		}
		seen[definition.Type] = struct{}{}
	}
	definitions[0].SupportedChannels[0] = ChannelPush
	refetched := Catalog()
	if refetched[0].SupportedChannels[0] != ChannelEmail {
		t.Fatal("catalog returned mutable shared channel metadata")
	}
}

func TestCatalogUsesGermanPushCopy(t *testing.T) {
	definition, ok := Definition(TypeBookingAssigned)
	if !ok {
		t.Fatal("booking-assigned notification definition is missing")
	}
	if definition.PushTitle != "Neue Buchung" || definition.PushBody != "In deiner Gruppe wurde etwas auf dein Konto gebucht." {
		t.Fatalf("booking-assigned push copy=%q/%q", definition.PushTitle, definition.PushBody)
	}
}
