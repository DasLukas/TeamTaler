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
	"sync"

	_ "golang.org/x/image/webp"
	_ "image/jpeg"
)

const (
	defaultImageBytes  = 5 << 20
	maxImagePixels     = 8_000_000
	maxImageDimension  = 4096
	maxNormalizedBytes = 10 << 20
)

var (
	imageKeyPattern = regexp.MustCompile(`\A[0-9a-f]{64}\.png\z`)
	// ErrImageTooLarge identifies a raw upload that exceeded the caller-supplied
	// byte limit. HTTP callers should translate this error to status 413.
	ErrImageTooLarge = errors.New("image upload exceeds the configured size limit")
	managedImagesMu  sync.Mutex
)

// NormalizeAndStoreImage reads source, validates its size, dimensions, and
// JPEG/PNG/WebP format, strips metadata by re-encoding to PNG, then atomically
// stores it below dataDirectory. It returns the content-addressed key, whether a
// new file was created, and an error for unsafe input or I/O/encoding failures.
func NormalizeAndStoreImage(dataDirectory string, source io.Reader) (string, bool, error) {
	return NormalizeAndStoreImageWithLimit(dataDirectory, source, defaultImageBytes)
}

// NormalizeAndStoreImageWithLimit validates and stores an image like
// NormalizeAndStoreImage while applying maxInputBytes to the raw input. The
// compiled dimension, pixel, and normalized-output ceilings remain unchanged.
// A non-positive limit is rejected and an oversized source returns
// ErrImageTooLarge so transports can consistently report payload-too-large.
func NormalizeAndStoreImageWithLimit(dataDirectory string, source io.Reader, maxInputBytes int64) (string, bool, error) {
	key, created, release, err := NormalizeAndStoreImageWithLimitLeased(dataDirectory, source, maxInputBytes)
	if release != nil {
		release()
	}
	return key, created, err
}

// NormalizeAndStoreImageWithLimitLeased validates and stores an image while
// retaining the process-wide managed-image mutation lease. The caller must
// invoke the returned release function after attaching the key to the database;
// on error the release function is nil. This closes the publish-to-reference
// race with garbage collection in a single TeamTaler process.
func NormalizeAndStoreImageWithLimitLeased(dataDirectory string, source io.Reader, maxInputBytes int64) (string, bool, func(), error) {
	if maxInputBytes < 1 {
		return "", false, nil, errors.New("image byte limit must be positive")
	}
	limited := io.LimitReader(source, maxInputBytes+1)
	raw, err := io.ReadAll(limited)
	if err != nil {
		return "", false, nil, fmt.Errorf("read image: %w", err)
	}
	if len(raw) == 0 {
		return "", false, nil, errors.New("image must not be empty")
	}
	if int64(len(raw)) > maxInputBytes {
		return "", false, nil, ErrImageTooLarge
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || (format != "jpeg" && format != "png" && format != "webp") {
		return "", false, nil, errors.New("image must be a valid JPEG, PNG, or WebP file")
	}
	if config.Width < 1 || config.Height < 1 || config.Width > maxImageDimension || config.Height > maxImageDimension || int64(config.Width)*int64(config.Height) > maxImagePixels {
		return "", false, nil, errors.New("image dimensions exceed 8 megapixels or 4096 pixels per side")
	}
	decoded, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return "", false, nil, errors.New("image data is malformed")
	}
	var normalized bytes.Buffer
	if err := png.Encode(&normalized, decoded); err != nil {
		return "", false, nil, fmt.Errorf("normalize image: %w", err)
	}
	if normalized.Len() > maxNormalizedBytes {
		return "", false, nil, errors.New("normalized image exceeds 10 MiB")
	}
	digest := sha256.Sum256(normalized.Bytes())
	key := hex.EncodeToString(digest[:]) + ".png"
	release := LockManagedImages()
	directory := filepath.Join(dataDirectory, "images")
	if err := os.MkdirAll(directory, 0o750); err != nil {
		release()
		return "", false, nil, fmt.Errorf("create image directory: %w", err)
	}
	path := filepath.Join(directory, key)
	if _, err := os.Stat(path); err == nil {
		return key, false, release, nil
	}
	temporary, err := os.CreateTemp(directory, ".upload-*.png")
	if err != nil {
		release()
		return "", false, nil, fmt.Errorf("create temporary image: %w", err)
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
		release()
		return "", false, nil, fmt.Errorf("write normalized image: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		release()
		return "", false, nil, fmt.Errorf("publish normalized image: %w", err)
	}
	return key, true, release, nil
}

// LockManagedImages acquires the process-wide coordination lease shared by
// upload publication, database attachment, and garbage collection. The
// returned idempotent release function must be called promptly.
func LockManagedImages() func() {
	managedImagesMu.Lock()
	var once sync.Once
	return func() { once.Do(managedImagesMu.Unlock) }
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

// UserAvatarURL builds the protected HTTP path for one persisted profile image.
// userID identifies the account and imageKey is its current content-addressed
// PNG key. It returns an empty string when no image key is present and otherwise
// returns a same-origin API path; it performs no I/O and cannot fail.
func UserAvatarURL(userID, imageKey string) string {
	if imageKey == "" {
		return ""
	}
	return "/api/v1/users/" + userID + "/avatar/" + imageKey
}
