// Package media validates, normalizes, stores, and resolves uploaded images.
package media

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/deepteams/webp"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
	_ "image/jpeg"
)

const (
	defaultImageBytes   = 5 << 20
	maxImagePixels      = 8_000_000
	maxImageDimension   = 4096
	maxNormalizedBytes  = 10 << 20
	imageVariantVersion = 1
	imageVariantQuality = 82
)

var (
	imageKeyPattern    = regexp.MustCompile(`\A[0-9a-f]{64}\.png\z`)
	imageVariantWidths = [...]int{128, 256, 384}
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
	created, err := publishFile(directory, ".upload-*.png", path, normalized.Bytes())
	if err != nil {
		release()
		return "", false, nil, fmt.Errorf("publish normalized image: %w", err)
	}
	if err := storeImageVariants(dataDirectory, key, decoded); err != nil {
		release()
		return "", false, nil, err
	}
	return key, created, release, nil
}

// ValidImageVariantWidth reports whether width is one of the bounded display
// variants generated for managed images. It performs no I/O and cannot fail.
func ValidImageVariantWidth(width int) bool {
	for _, candidate := range imageVariantWidths {
		if candidate == width {
			return true
		}
	}
	return false
}

// EnsureImageVariant resolves or atomically creates a metadata-free WebP
// display variant for a canonical managed image. The original PNG remains the
// authoritative backup and export source. Invalid keys or widths and missing
// or malformed masters return an error.
func EnsureImageVariant(dataDirectory, key string, width int) (string, error) {
	path, err := resolveImageVariant(dataDirectory, key, width)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(path); err == nil {
		return path, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("inspect image variant: %w", err)
	}

	release := LockManagedImages()
	defer release()
	if _, err := os.Stat(path); err == nil {
		return path, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("inspect image variant: %w", err)
	}
	masterPath, err := ResolveImage(dataDirectory, key)
	if err != nil {
		return "", err
	}
	master, err := os.Open(masterPath)
	if err != nil {
		return "", fmt.Errorf("open managed image: %w", err)
	}
	defer master.Close()
	decoded, _, err := image.Decode(master)
	if err != nil {
		return "", fmt.Errorf("decode managed image: %w", err)
	}
	if err := storeImageVariant(dataDirectory, key, width, decoded); err != nil {
		return "", err
	}
	return path, nil
}

// ImageVariantETag returns the strong validator for a deterministic display
// variant. Bumping the internal encoder version invalidates existing browser
// and filesystem variants without changing database image keys.
func ImageVariantETag(key string, width int) (string, error) {
	if !ValidImageKey(key) || !ValidImageVariantWidth(width) {
		return "", errors.New("invalid image variant")
	}
	return `"` + strings.TrimSuffix(key, ".png") + "-w" + strconv.Itoa(width) + "-webp-v" + strconv.Itoa(imageVariantVersion) + `"`, nil
}

// RemoveImageArtifacts removes a managed master and every derived display
// variant. The caller must hold the managed-image lease across its final
// database reference check and this operation. Missing artifacts are ignored;
// other filesystem failures are joined and returned.
func RemoveImageArtifacts(dataDirectory, key string) error {
	masterPath, err := ResolveImage(dataDirectory, key)
	if err != nil {
		return err
	}
	paths := []string{masterPath}
	for _, width := range imageVariantWidths {
		variantPath, variantErr := resolveImageVariant(dataDirectory, key, width)
		if variantErr != nil {
			return variantErr
		}
		paths = append(paths, variantPath)
	}
	var failures []error
	for _, path := range paths {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func storeImageVariants(dataDirectory, key string, source image.Image) error {
	for _, width := range imageVariantWidths {
		if err := storeImageVariant(dataDirectory, key, width, source); err != nil {
			return err
		}
	}
	return nil
}

func storeImageVariant(dataDirectory, key string, width int, source image.Image) error {
	path, err := resolveImageVariant(dataDirectory, key, width)
	if err != nil {
		return err
	}
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect image variant: %w", err)
	}
	body, err := encodeImageVariant(source, width)
	if err != nil {
		return err
	}
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o750); err != nil {
		return fmt.Errorf("create image variant directory: %w", err)
	}
	if _, err := publishFile(directory, ".variant-*.webp", path, body); err != nil {
		return fmt.Errorf("publish image variant: %w", err)
	}
	return nil
}

func encodeImageVariant(source image.Image, maximumDimension int) ([]byte, error) {
	bounds := source.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width < 1 || height < 1 {
		return nil, errors.New("managed image dimensions must be positive")
	}
	if width >= height && width > maximumDimension {
		height = max(1, height*maximumDimension/width)
		width = maximumDimension
	} else if height > maximumDimension {
		width = max(1, width*maximumDimension/height)
		height = maximumDimension
	}
	resized := image.NewNRGBA(image.Rect(0, 0, width, height))
	xdraw.CatmullRom.Scale(resized, resized.Bounds(), source, bounds, draw.Src, nil)
	options := webp.DefaultOptions()
	options.Quality = imageVariantQuality
	options.Method = 4
	options.UseSharpYUV = true
	options.AlphaQuality = 100
	options.AlphaFiltering = 2
	if !resized.Opaque() {
		options.Lossless = true
		options.UseSharpYUV = false
	}
	var encoded bytes.Buffer
	if err := webp.Encode(&encoded, resized, options); err != nil {
		return nil, fmt.Errorf("encode image variant: %w", err)
	}
	return encoded.Bytes(), nil
}

func resolveImageVariant(dataDirectory, key string, width int) (string, error) {
	if !ValidImageKey(key) || !ValidImageVariantWidth(width) {
		return "", errors.New("invalid image variant")
	}
	name := strings.TrimSuffix(key, ".png") + "-w" + strconv.Itoa(width) + "-v" + strconv.Itoa(imageVariantVersion) + ".webp"
	return filepath.Join(dataDirectory, "image-variants", name), nil
}

func publishFile(directory, pattern, destination string, body []byte) (bool, error) {
	if _, err := os.Stat(destination); err == nil {
		return false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	temporary, err := os.CreateTemp(directory, pattern)
	if err != nil {
		return false, err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o640); err == nil {
		_, err = temporary.Write(body)
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return false, err
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		return false, err
	}
	return true, nil
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
