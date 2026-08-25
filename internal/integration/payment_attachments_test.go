package integration_test

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/png"
	"os"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/activities"
	"github.com/DasLukas/TeamTaler/internal/config"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/finance"
	"github.com/DasLukas/TeamTaler/internal/groups"
)

func TestPaymentAttachmentModesStorageIdempotencyAndReads(t *testing.T) {
	fixture := newFixture(t)
	required := []domain.PaymentMethod{{ID: "PURCHASE", Label: "Purchase", AttachmentMode: domain.AttachmentModeRequired}}
	if _, err := fixture.groups.UpdateSettings(fixture.ctx, fixture.admin, fixture.membership, groups.SettingsUpdate{PaymentMethods: &required}); err != nil {
		t.Fatalf("configure payment attachment mode: %v", err)
	}
	command := finance.CreateOwnPaymentInput{AmountMinor: 1250, ReceivedAt: "2026-08-20T10:00:00Z", Method: "PURCHASE", Reference: "Office supplies"}
	if _, err := fixture.finance.CreateOwnPayment(fixture.ctx, fixture.admin, fixture.membership, "required-without-receipt", command); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("required method without attachment error=%v, want validation", err)
	}
	receipt := testReceiptPNG(t, color.NRGBA{R: 240, G: 240, B: 240, A: 255})
	payment, err := fixture.finance.CreateOwnPaymentWithAttachment(fixture.ctx, fixture.admin, fixture.membership, "required-with-receipt", command, &finance.PaymentAttachmentUpload{
		FileName: "../../receipt.jpg", Reader: bytes.NewReader(receipt), MaxBytes: config.DefaultAttachmentUploadBytes,
	})
	if err != nil {
		t.Fatalf("create payment with attachment: %v", err)
	}
	if payment.Attachment == nil || payment.Attachment.FileName != "receipt.png" || payment.Attachment.MediaType != "image/png" || payment.Attachment.SizeBytes < 1 {
		t.Fatalf("payment attachment summary=%#v", payment.Attachment)
	}
	activityPage, err := (activities.Service{DB: fixture.db}).QueryEntries(fixture.ctx, fixture.membership, activities.Query{Kinds: []string{"PAYMENT"}})
	if err != nil || len(activityPage.Items) != 1 || activityPage.Items[0].Attachment == nil ||
		activityPage.Items[0].Attachment.FileName != "receipt.png" || activityPage.Items[0].Attachment.URL != "/api/v1/groups/"+fixture.group.ID+"/payments/"+payment.ID+"/attachment" {
		t.Fatalf("payment activity attachment=%#v err=%v", activityPage.Items, err)
	}
	if _, err := fixture.db.ExecContext(fixture.ctx, `DELETE FROM payment_attachments WHERE payment_id=?`, payment.ID); err == nil {
		t.Fatal("immutable payment attachment was deleted outside group purge")
	}
	item, err := fixture.finance.GetPaymentAttachment(fixture.ctx, fixture.membership, payment.ID)
	if err != nil {
		t.Fatalf("get own payment attachment: %v", err)
	}
	if body, err := os.ReadFile(item.Path); err != nil || int64(len(body)) != item.SizeBytes {
		t.Fatalf("stored attachment size=%d err=%v, want %d", len(body), err, item.SizeBytes)
	}
	replayed, err := fixture.finance.CreateOwnPaymentWithAttachment(fixture.ctx, fixture.admin, fixture.membership, "required-with-receipt", command, &finance.PaymentAttachmentUpload{
		FileName: "receipt.png", Reader: bytes.NewReader(receipt), MaxBytes: config.DefaultAttachmentUploadBytes,
	})
	if err != nil || replayed.ID != payment.ID {
		t.Fatalf("idempotent replay=%#v err=%v", replayed, err)
	}
	different := testReceiptPNG(t, color.NRGBA{R: 10, G: 20, B: 30, A: 255})
	if _, err := fixture.finance.CreateOwnPaymentWithAttachment(fixture.ctx, fixture.admin, fixture.membership, "required-with-receipt", command, &finance.PaymentAttachmentUpload{
		FileName: "different.png", Reader: bytes.NewReader(different), MaxBytes: config.DefaultAttachmentUploadBytes,
	}); !errors.Is(err, domain.ErrIdempotencyReuse) {
		t.Fatalf("idempotency reuse with different attachment error=%v", err)
	}
}

func testReceiptPNG(t *testing.T, fill color.NRGBA) []byte {
	t.Helper()
	canvas := image.NewNRGBA(image.Rect(0, 0, 8, 12))
	for y := 0; y < canvas.Bounds().Dy(); y++ {
		for x := 0; x < canvas.Bounds().Dx(); x++ {
			canvas.SetNRGBA(x, y, fill)
		}
	}
	var body bytes.Buffer
	if err := png.Encode(&body, canvas); err != nil {
		t.Fatalf("encode receipt fixture: %v", err)
	}
	return body.Bytes()
}
