package media

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestNormalizeAndStoreImage(t *testing.T) {
	canvas := image.NewRGBA(image.Rect(0, 0, 512, 256))
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
	for _, width := range imageVariantWidths {
		variantPath, err := EnsureImageVariant(directory, key, width)
		if err != nil {
			t.Fatalf("ensure %d-pixel variant: %v", width, err)
		}
		file, err := os.Open(variantPath)
		if err != nil {
			t.Fatalf("open %d-pixel variant: %v", width, err)
		}
		configuration, format, decodeErr := image.DecodeConfig(file)
		file.Close()
		if decodeErr != nil || format != "webp" || configuration.Width != width || configuration.Height != width/2 {
			t.Fatalf("variant %d configuration=%#v format=%q err=%v", width, configuration, format, decodeErr)
		}
	}
}

func TestEnsureImageVariantLazilyRepairsMissingDerivative(t *testing.T) {
	canvas := image.NewRGBA(image.Rect(0, 0, 512, 512))
	var source bytes.Buffer
	if err := png.Encode(&source, canvas); err != nil {
		t.Fatalf("encode fixture: %v", err)
	}
	directory := t.TempDir()
	key, _, err := NormalizeAndStoreImage(directory, &source)
	if err != nil {
		t.Fatalf("normalize image: %v", err)
	}
	variantPath, err := resolveImageVariant(directory, key, 256)
	if err != nil {
		t.Fatalf("resolve variant: %v", err)
	}
	if err := os.Remove(variantPath); err != nil {
		t.Fatalf("remove eager variant: %v", err)
	}
	if _, err := EnsureImageVariant(directory, key, 256); err != nil {
		t.Fatalf("repair variant: %v", err)
	}
	if _, err := os.Stat(variantPath); err != nil {
		t.Fatalf("repaired variant: %v", err)
	}
}

func TestRemoveImageArtifactsDeletesMasterAndVariants(t *testing.T) {
	canvas := image.NewRGBA(image.Rect(0, 0, 64, 64))
	var source bytes.Buffer
	if err := png.Encode(&source, canvas); err != nil {
		t.Fatalf("encode fixture: %v", err)
	}
	directory := t.TempDir()
	key, _, err := NormalizeAndStoreImage(directory, &source)
	if err != nil {
		t.Fatalf("normalize image: %v", err)
	}
	if err := RemoveImageArtifacts(directory, key); err != nil {
		t.Fatalf("remove artifacts: %v", err)
	}
	if _, err := os.Stat(filepath.Join(directory, "images", key)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("master still exists or stat failed unexpectedly: %v", err)
	}
	for _, width := range imageVariantWidths {
		variantPath, _ := resolveImageVariant(directory, key, width)
		if _, err := os.Stat(variantPath); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("variant %d still exists or stat failed unexpectedly: %v", width, err)
		}
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
	if ValidImageVariantWidth(200) {
		t.Fatal("unsupported image variant width was accepted")
	}
	if _, err := EnsureImageVariant(t.TempDir(), string(make([]byte, 68)), 256); err == nil {
		t.Fatal("invalid image variant key was accepted")
	}
}

func TestNormalizeAndStoreImageWithLimitReportsOversize(t *testing.T) {
	_, _, err := NormalizeAndStoreImageWithLimit(t.TempDir(), bytes.NewReader(make([]byte, 33)), 32)
	if !errors.Is(err, ErrImageTooLarge) {
		t.Fatalf("error = %v, want ErrImageTooLarge", err)
	}
}
