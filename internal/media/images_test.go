package media

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/png"
	"os"
	"testing"
)

func TestNormalizeAndStoreImage(t *testing.T) {
	canvas := image.NewRGBA(image.Rect(0, 0, 8, 8))
	canvas.Set(0, 0, color.RGBA{R: 12, G: 34, B: 56, A: 255})
	var source bytes.Buffer
	if err := png.Encode(&source, canvas); err != nil {
		t.Fatalf("encode fixture: %v", err)
	}
	directory := t.TempDir()
	key, created, err := NormalizeAndStoreImage(directory, &source)
	if err != nil || !created || !ValidImageKey(key) {
		t.Fatalf("normalize image: key=%q created=%v err=%v", key, created, err)
	}
	path, err := ResolveImage(directory, key)
	if err != nil {
		t.Fatalf("resolve image: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("stored image: %v", err)
	}
}

func TestRejectsInvalidImageAndKey(t *testing.T) {
	if _, _, err := NormalizeAndStoreImage(t.TempDir(), bytes.NewBufferString("not an image")); err == nil {
		t.Fatal("invalid image was accepted")
	}
	if ValidImageKey("../unsafe.png") {
		t.Fatal("unsafe image key was accepted")
	}
	if _, err := ResolveImage(t.TempDir(), "../unsafe.png"); err == nil {
		t.Fatal("unsafe image key was resolved")
	}
}

func TestNormalizeAndStoreImageWithLimitReportsOversize(t *testing.T) {
	_, _, err := NormalizeAndStoreImageWithLimit(t.TempDir(), bytes.NewReader(make([]byte, 33)), 32)
	if !errors.Is(err, ErrImageTooLarge) {
		t.Fatalf("error = %v, want ErrImageTooLarge", err)
	}
}
