package paymentattachments

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"strings"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
)

func TestStoreNormalizesImageAndFilename(t *testing.T) {
	canvas := image.NewNRGBA(image.Rect(0, 0, 3, 2))
	canvas.SetNRGBA(0, 0, color.NRGBA{R: 255, A: 255})
	var source bytes.Buffer
	if err := jpeg.Encode(&source, canvas, nil); err != nil {
		t.Fatalf("encode JPEG: %v", err)
	}
	store := Store{DataDirectory: t.TempDir()}
	stored, created, release, err := store.Save(bytes.NewReader(source.Bytes()), `..\unsafe/receipt.jpg`, 1<<20)
	if err != nil {
		t.Fatalf("save image: %v", err)
	}
	defer release()
	if !created || stored.FileName != "receipt.jpg" || stored.MediaType != "image/jpeg" || !strings.HasSuffix(stored.StorageKey, ".jpg") || stored.SizeBytes < 1 {
		t.Fatalf("stored=%#v created=%t", stored, created)
	}
	path, err := store.Resolve(stored.StorageKey)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	body, err := os.ReadFile(path)
	if err != nil || !bytes.HasPrefix(body, []byte("\xff\xd8\xff")) {
		t.Fatalf("normalized body prefix=%x err=%v", body[:min(len(body), 3)], err)
	}
}

func TestStorePreservesFilenameLimitAfterChangingExtension(t *testing.T) {
	canvas := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	var source bytes.Buffer
	if err := jpeg.Encode(&source, canvas, nil); err != nil {
		t.Fatalf("encode JPEG: %v", err)
	}
	store := Store{DataDirectory: t.TempDir()}
	stored, _, release, err := store.Save(bytes.NewReader(source.Bytes()), strings.Repeat("ä", 240), 1<<20)
	if err != nil {
		t.Fatalf("save long filename: %v", err)
	}
	defer release()
	if got := len([]rune(stored.FileName)); got != 240 || !strings.HasSuffix(stored.FileName, ".jpg") {
		t.Fatalf("stored filename has %d runes and value %q", got, stored.FileName)
	}
}

func TestStoreAdaptivelyBoundsReencodedPhonePhoto(t *testing.T) {
	canvas := image.NewNRGBA(image.Rect(0, 0, 1600, 1200))
	for y := 0; y < canvas.Bounds().Dy(); y++ {
		for x := 0; x < canvas.Bounds().Dx(); x++ {
			canvas.SetNRGBA(x, y, color.NRGBA{R: uint8(x*y + y), G: uint8(x*7 + y*3), B: uint8(x + y*11), A: 255})
		}
	}
	var source bytes.Buffer
	if err := jpeg.Encode(&source, canvas, &jpeg.Options{Quality: 18}); err != nil {
		t.Fatalf("encode compressed phone photo: %v", err)
	}
	limit := int64(source.Len())
	store := Store{DataDirectory: t.TempDir()}
	stored, _, release, err := store.Save(bytes.NewReader(source.Bytes()), "phone-photo.jpg", limit)
	if err != nil {
		t.Fatalf("adaptively normalize compressed phone photo: %v", err)
	}
	defer release()
	if stored.SizeBytes > limit || stored.MediaType != "image/jpeg" {
		t.Fatalf("stored photo size=%d media=%q, limit=%d", stored.SizeBytes, stored.MediaType, limit)
	}
}

func TestStoreRejectsUnsupportedOversizedAndMalformedPDF(t *testing.T) {
	store := Store{DataDirectory: t.TempDir()}
	if _, _, _, err := store.Save(strings.NewReader("plain text"), "receipt.txt", 1<<20); !errors.Is(err, domain.ErrUnsupportedMediaType) {
		t.Fatalf("unsupported media error=%v", err)
	}
	if _, _, _, err := store.Save(bytes.NewReader(make([]byte, 1025)), "receipt.png", 1024); !errors.Is(err, domain.ErrPayloadTooLarge) {
		t.Fatalf("oversized error=%v", err)
	}
	if _, _, _, err := store.Save(strings.NewReader("%PDF-1.7\nmissing eof"), "receipt.pdf", 1<<20); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("malformed PDF error=%v", err)
	}
}

func TestStoreAcceptsStructurallyValidOpaquePDF(t *testing.T) {
	store := Store{DataDirectory: t.TempDir()}
	stored, _, release, err := store.Save(bytes.NewReader(testPDF()), "receipt.pdf", 1<<20)
	if err != nil {
		t.Fatalf("save valid PDF: %v", err)
	}
	defer release()
	if stored.MediaType != "application/pdf" || stored.FileName != "receipt.pdf" || !strings.HasSuffix(stored.StorageKey, ".pdf") {
		t.Fatalf("stored PDF=%#v", stored)
	}
}

func testPDF() []byte {
	prefix := "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"
	return []byte(fmt.Sprintf("%sxref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", prefix, len(prefix)))
}
