package webpush

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/netip"
	"strings"
	"testing"
)

type staticResolver map[string][]netip.Addr

func (resolver staticResolver) LookupNetIP(_ context.Context, _ string, host string) ([]netip.Addr, error) {
	return append([]netip.Addr(nil), resolver[host]...), nil
}

func TestSecretsUseAuthenticatedPurposeSeparatedEnvelopes(t *testing.T) {
	secrets, err := NewSecrets(bytes.Repeat([]byte{0x42}, 32))
	if err != nil {
		t.Fatalf("NewSecrets: %v", err)
	}
	privateKey, _, _, err := GenerateVAPIDKey()
	if err != nil {
		t.Fatalf("GenerateVAPIDKey: %v", err)
	}
	envelope, err := secrets.SealVAPIDPrivateKey(privateKey)
	if err != nil {
		t.Fatalf("SealVAPIDPrivateKey: %v", err)
	}
	if strings.Contains(envelope, privateKey) {
		t.Fatal("VAPID envelope exposed plaintext")
	}
	opened, err := secrets.OpenVAPIDPrivateKey(envelope)
	if err != nil || opened != privateKey {
		t.Fatalf("OpenVAPIDPrivateKey: opened=%q err=%v", opened, err)
	}
	if _, err := secrets.openSubscription(envelope); err == nil {
		t.Fatal("VAPID envelope opened under subscription purpose")
	}
	decodedEnvelope, err := base64.RawURLEncoding.DecodeString(envelope)
	if err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	decodedEnvelope[len(decodedEnvelope)-1] ^= 0x01
	tampered := base64.RawURLEncoding.EncodeToString(decodedEnvelope)
	if _, err := secrets.OpenVAPIDPrivateKey(tampered); err == nil {
		t.Fatal("tampered VAPID envelope was accepted")
	}
}

func TestSealEnvelopeBoundsAllocationInputs(t *testing.T) {
	secrets, err := NewSecrets(bytes.Repeat([]byte{0x42}, 32))
	if err != nil {
		t.Fatalf("NewSecrets: %v", err)
	}
	if _, err := sealEnvelope(secrets.subscriptionAEAD, bytes.Repeat([]byte{0x24}, maxEnvelopePlaintextBytes), subscriptionEnvelopeAAD); err != nil {
		t.Fatalf("seal maximum supported plaintext: %v", err)
	}
	if _, err := sealEnvelope(secrets.subscriptionAEAD, bytes.Repeat([]byte{0x24}, maxEnvelopePlaintextBytes+1), subscriptionEnvelopeAAD); err == nil {
		t.Fatal("oversized Web Push encryption plaintext was accepted")
	}
}

func TestValidateEndpointRejectsPrivateAndReservedResolution(t *testing.T) {
	ctx := context.Background()
	resolver := staticResolver{
		"push.example.test":    {netip.MustParseAddr("93.184.216.34")},
		"private.example.test": {netip.MustParseAddr("10.0.0.5")},
		"docs.example.test":    {netip.MustParseAddr("192.0.2.10")},
	}
	if _, err := ValidateEndpoint(ctx, "https://push.example.test/send/abc", resolver); err != nil {
		t.Fatalf("public endpoint rejected: %v", err)
	}
	for _, endpoint := range []string{
		"http://push.example.test/send", "https://user:secret@push.example.test/send",
		"https://private.example.test/send", "https://docs.example.test/send", "https://127.0.0.1/send",
		"https://[64:ff9b::a00:1]/send", "https://[2002:a00:1::]/send", "https://[fec0::1]/send",
	} {
		if _, err := ValidateEndpoint(ctx, endpoint, resolver); err == nil {
			t.Fatalf("unsafe endpoint %q was accepted", endpoint)
		}
	}
}

func TestHardenedHTTPClientRevalidatesDNSBeforeConnecting(t *testing.T) {
	ctx := context.Background()
	resolver := staticResolver{"push.example.test": {netip.MustParseAddr("93.184.216.34")}}
	endpoint := "https://push.example.test/send/browser"
	if _, err := ValidateEndpoint(ctx, endpoint, resolver); err != nil {
		t.Fatalf("initial endpoint validation: %v", err)
	}
	resolver["push.example.test"] = []netip.Addr{netip.MustParseAddr("10.0.0.5")}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
	if err != nil {
		t.Fatalf("create request: %v", err)
	}
	response, err := NewHardenedHTTPClient(resolver).Do(request)
	if response != nil {
		_ = response.Body.Close()
	}
	if err == nil || !strings.Contains(err.Error(), "resolution was rejected") {
		t.Fatalf("DNS rebinding request error=%v, want public-address rejection", err)
	}
}

func TestValidatedSubscriptionRejectsOversizedKeyMaterial(t *testing.T) {
	for _, mutate := range []func(*SubscriptionInput){
		func(input *SubscriptionInput) { input.Keys.Auth = strings.Repeat("A", maxAuthKeyTextLength+1) },
		func(input *SubscriptionInput) { input.Keys.P256DH = strings.Repeat("A", maxP256DHTextLength+1) },
	} {
		input := validSubscriptionInput(t)
		mutate(&input)
		if _, err := validatedSubscription(input); err == nil {
			t.Fatal("oversized browser key material was accepted")
		}
	}
}

func validSubscriptionInput(t *testing.T) SubscriptionInput {
	t.Helper()
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate subscription key: %v", err)
	}
	auth := bytes.Repeat([]byte{0x24}, 16)
	return SubscriptionInput{
		Endpoint: "https://push.example.test/send/browser",
		Keys: SubscriptionKeys{
			Auth:   base64.RawURLEncoding.EncodeToString(auth),
			P256DH: base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()),
		},
	}
}
