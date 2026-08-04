package catalog

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"testing"
)

func TestNormalizeAndStoreImage(t *testing.T) {
	canvas := image.NewRGBA(image.Rect(0, 0, 8, 8))
	canvas.Set(1, 1, color.RGBA{R: 20, G: 120, B: 180, A: 255})
	var source bytes.Buffer
	if err := png.Encode(&source, canvas); err != nil {
		t.Fatalf("encode fixture: %v", err)
	}
	directory := t.TempDir()
	key, created, err := NormalizeAndStoreImage(directory, bytes.NewReader(source.Bytes()))
	if err != nil || !created {
		t.Fatalf("normalize image: key=%q created=%v err=%v", key, created, err)
	}
	path, err := ResolveImage(directory, key)
	if err != nil {
		t.Fatalf("resolve image: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("stored image: %v", err)
	}
	repeatedKey, repeatedCreated, err := NormalizeAndStoreImage(directory, bytes.NewReader(source.Bytes()))
	if err != nil || repeatedKey != key || repeatedCreated {
		t.Fatalf("content-addressed repeat: key=%q created=%v err=%v", repeatedKey, repeatedCreated, err)
	}
}

func TestNormalizeRejectsInvalidImage(t *testing.T) {
	if _, _, err := NormalizeAndStoreImage(t.TempDir(), bytes.NewBufferString("not an image")); err == nil {
		t.Fatal("invalid image was accepted")
	}
	if _, err := ResolveImage(t.TempDir(), "../../etc/passwd"); err == nil {
		t.Fatal("unsafe image key was accepted")
	}
}
