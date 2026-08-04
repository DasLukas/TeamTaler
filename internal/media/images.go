// Package media validates, normalizes, stores, and resolves uploaded images.
package media

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"regexp"

	_ "golang.org/x/image/webp"
	_ "image/jpeg"
)

const (
	maxImageBytes      = 5 << 20
	maxImagePixels     = 8_000_000
	maxImageDimension  = 4096
	maxNormalizedBytes = 10 << 20
)

var imageKeyPattern = regexp.MustCompile(`\A[0-9a-f]{64}\.png\z`)

// NormalizeAndStoreImage reads source, validates its size, dimensions, and
// JPEG/PNG/WebP format, strips metadata by re-encoding to PNG, then atomically
// stores it below dataDirectory. It returns the content-addressed key, whether a
// new file was created, and an error for unsafe input or I/O/encoding failures.
func NormalizeAndStoreImage(dataDirectory string, source io.Reader) (string, bool, error) {
	limited := io.LimitReader(source, maxImageBytes+1)
	raw, err := io.ReadAll(limited)
	if err != nil {
		return "", false, fmt.Errorf("read image: %w", err)
	}
	if len(raw) == 0 || len(raw) > maxImageBytes {
		return "", false, errors.New("image must be between 1 byte and 5 MiB")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || (format != "jpeg" && format != "png" && format != "webp") {
		return "", false, errors.New("image must be a valid JPEG, PNG, or WebP file")
	}
	if config.Width < 1 || config.Height < 1 || config.Width > maxImageDimension || config.Height > maxImageDimension || int64(config.Width)*int64(config.Height) > maxImagePixels {
		return "", false, errors.New("image dimensions exceed 8 megapixels or 4096 pixels per side")
	}
	decoded, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return "", false, errors.New("image data is malformed")
	}
	var normalized bytes.Buffer
	if err := png.Encode(&normalized, decoded); err != nil {
		return "", false, fmt.Errorf("normalize image: %w", err)
	}
	if normalized.Len() > maxNormalizedBytes {
		return "", false, errors.New("normalized image exceeds 10 MiB")
	}
	digest := sha256.Sum256(normalized.Bytes())
	key := hex.EncodeToString(digest[:]) + ".png"
	directory := filepath.Join(dataDirectory, "images")
	if err := os.MkdirAll(directory, 0o750); err != nil {
		return "", false, fmt.Errorf("create image directory: %w", err)
	}
	path := filepath.Join(directory, key)
	if _, err := os.Stat(path); err == nil {
		return key, false, nil
	}
	temporary, err := os.CreateTemp(directory, ".upload-*.png")
	if err != nil {
		return "", false, fmt.Errorf("create temporary image: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o640); err == nil {
		_, err = temporary.Write(normalized.Bytes())
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", false, fmt.Errorf("write normalized image: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return "", false, fmt.Errorf("publish normalized image: %w", err)
	}
	return key, true, nil
}

// ResolveImage validates key as a TeamTaler content-addressed PNG and returns its
// local path below dataDirectory. Invalid keys return an error; the function
// does not access the filesystem or guarantee that the file exists.
func ResolveImage(dataDirectory, key string) (string, error) {
	if !ValidImageKey(key) {
		return "", errors.New("invalid image key")
	}
	return filepath.Join(dataDirectory, "images", key), nil
}

// ValidImageKey reports whether key is a canonical SHA-256-addressed PNG name.
// It performs no filesystem access and cannot fail.
func ValidImageKey(key string) bool {
	return imageKeyPattern.MatchString(key)
}
