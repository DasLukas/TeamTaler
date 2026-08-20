// Package paymentattachments validates and stores immutable payment receipts.
package paymentattachments

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/DasLukas/TeamTaler/internal/domain"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const (
	maxImagePixels    = 20_000_000
	maxImageDimension = 8192
)

var (
	storageKeyPattern = regexp.MustCompile(`\A[0-9a-f]{64}\.(jpg|png|pdf)\z`)
	pdfVersionPattern = regexp.MustCompile(`\A(?:1\.[0-7]|2\.0)\z`)
	storeMu           sync.Mutex
)

// Stored describes one normalized, content-addressed receipt prepared for a
// payment transaction. StorageKey is private persistence metadata.
type Stored struct {
	StorageKey string
	FileName   string
	MediaType  string
	SizeBytes  int64
	SHA256     string
}

// Store owns payment receipt files below one trusted TeamTaler data directory.
type Store struct {
	DataDirectory string
}

// Save validates and normalizes source, publishes it atomically, and retains a
// process-wide lease until release is called. Images are re-encoded without
// metadata and adaptively bounded; PDF bytes remain opaque after structural checks.
func (s Store) Save(source io.Reader, fileName string, maxInputBytes int64) (stored Stored, created bool, release func(), err error) {
	if strings.TrimSpace(s.DataDirectory) == "" {
		return Stored{}, false, nil, errors.New("payment attachment data directory is not configured")
	}
	if maxInputBytes < 1 {
		return Stored{}, false, nil, errors.New("payment attachment byte limit must be positive")
	}
	raw, err := io.ReadAll(io.LimitReader(source, maxInputBytes+1))
	if err != nil {
		return Stored{}, false, nil, fmt.Errorf("read payment attachment: %w", err)
	}
	if len(raw) == 0 {
		return Stored{}, false, nil, domain.ValidationError{Field: "attachment", Message: "must not be empty"}
	}
	if int64(len(raw)) > maxInputBytes {
		return Stored{}, false, nil, fmt.Errorf("%w: attachment exceeds the configured %d-byte limit", domain.ErrPayloadTooLarge, maxInputBytes)
	}
	fileName = normalizeFileName(fileName)
	if fileName == "" {
		fileName = "receipt"
	}

	body, mediaType, extension, err := normalize(raw, maxInputBytes)
	if err != nil {
		return Stored{}, false, nil, err
	}
	if int64(len(body)) > maxInputBytes {
		return Stored{}, false, nil, fmt.Errorf("%w: normalized attachment exceeds the configured %d-byte limit", domain.ErrPayloadTooLarge, maxInputBytes)
	}
	fileName = normalizeStoredFileName(fileName, extension)
	digest := sha256.Sum256(body)
	hash := hex.EncodeToString(digest[:])
	key := hash + extension
	stored = Stored{StorageKey: key, FileName: fileName, MediaType: mediaType, SizeBytes: int64(len(body)), SHA256: hash}

	release = lockStore()
	directory := filepath.Join(s.DataDirectory, "attachments")
	if err := os.MkdirAll(directory, 0o750); err != nil {
		release()
		return Stored{}, false, nil, fmt.Errorf("create payment attachment directory: %w", err)
	}
	target := filepath.Join(directory, key)
	if _, err := os.Stat(target); err == nil {
		return stored, false, release, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		release()
		return Stored{}, false, nil, err
	}
	temporary, err := os.CreateTemp(directory, ".upload-*")
	if err != nil {
		release()
		return Stored{}, false, nil, fmt.Errorf("create payment attachment temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err = temporary.Chmod(0o640); err == nil {
		_, err = temporary.Write(body)
	}
	if syncErr := temporary.Sync(); err == nil {
		err = syncErr
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		release()
		return Stored{}, false, nil, fmt.Errorf("write payment attachment: %w", err)
	}
	if err := os.Rename(temporaryPath, target); err != nil {
		release()
		return Stored{}, false, nil, fmt.Errorf("publish payment attachment: %w", err)
	}
	return stored, true, release, nil
}

// Resolve validates storageKey and returns its canonical path without touching
// the filesystem.
func (s Store) Resolve(storageKey string) (string, error) {
	if strings.TrimSpace(s.DataDirectory) == "" || !storageKeyPattern.MatchString(storageKey) {
		return "", errors.New("invalid payment attachment storage key")
	}
	return filepath.Join(s.DataDirectory, "attachments", storageKey), nil
}

// Remove removes a canonical attachment key while its caller owns the store
// lease. Missing files are treated as success.
func (s Store) Remove(storageKey string) error {
	path, err := s.Resolve(storageKey)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// LockStore serializes receipt publication and garbage collection. The
// returned function is idempotent.
func LockStore() func() { return lockStore() }

func lockStore() func() {
	storeMu.Lock()
	var once sync.Once
	return func() { once.Do(storeMu.Unlock) }
}

func normalize(raw []byte, maxOutputBytes int64) ([]byte, string, string, error) {
	if bytes.Contains(raw[:min(len(raw), 1024)], []byte("%PDF-")) {
		if !validPDFStructure(raw) {
			return nil, "", "", domain.ValidationError{Field: "attachment", Message: "must be a structurally valid PDF document"}
		}
		return raw, "application/pdf", ".pdf", nil
	}
	configuration, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || (format != "jpeg" && format != "png" && format != "webp") {
		return nil, "", "", fmt.Errorf("%w: attachment must be JPEG, PNG, WebP, or PDF", domain.ErrUnsupportedMediaType)
	}
	if configuration.Width < 1 || configuration.Height < 1 || configuration.Width > maxImageDimension || configuration.Height > maxImageDimension || int64(configuration.Width)*int64(configuration.Height) > maxImagePixels {
		return nil, "", "", domain.ValidationError{Field: "attachment", Message: "image dimensions exceed 20 megapixels or 8192 pixels per side"}
	}
	decoded, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, "", "", domain.ValidationError{Field: "attachment", Message: "image data is malformed"}
	}
	if format == "jpeg" {
		decoded = applyOrientation(decoded, jpegOrientation(raw))
	}
	if format == "png" {
		var normalized bytes.Buffer
		if err := png.Encode(&normalized, decoded); err != nil {
			return nil, "", "", fmt.Errorf("normalize payment attachment image: %w", err)
		}
		if int64(normalized.Len()) <= maxOutputBytes {
			return normalized.Bytes(), "image/png", ".png", nil
		}
	}
	body, err := encodeJPEGWithinLimit(decoded, maxOutputBytes)
	if err != nil {
		return nil, "", "", err
	}
	return body, "image/jpeg", ".jpg", nil
}

func validPDFStructure(raw []byte) bool {
	headerWindow := raw[:min(len(raw), 1024)]
	headerOffset := bytes.Index(headerWindow, []byte("%PDF-"))
	if headerOffset < 0 || headerOffset+8 > len(raw) {
		return false
	}
	version := string(raw[headerOffset+5 : headerOffset+8])
	if !pdfVersionPattern.MatchString(version) {
		return false
	}
	trimmed := bytes.TrimSpace(raw)
	if !bytes.HasSuffix(trimmed, []byte("%%EOF")) {
		return false
	}
	eofOffset := bytes.LastIndex(trimmed, []byte("%%EOF"))
	startOffset := bytes.LastIndex(trimmed[:eofOffset], []byte("startxref"))
	if startOffset < 0 || !bytes.Contains(trimmed[:startOffset], []byte("endobj")) {
		return false
	}
	fields := bytes.Fields(trimmed[startOffset+len("startxref") : eofOffset])
	if len(fields) != 1 {
		return false
	}
	xrefOffset, err := strconv.ParseInt(string(fields[0]), 10, 64)
	if err != nil || xrefOffset < 0 || xrefOffset >= int64(startOffset) {
		return false
	}
	xref := trimmed[xrefOffset:]
	if bytes.HasPrefix(xref, []byte("xref")) {
		return bytes.Contains(xref[:min(len(xref), 4096)], []byte("trailer")) && bytes.Contains(xref, []byte("/Root"))
	}
	objectFields := bytes.Fields(xref[:min(len(xref), 64)])
	return len(objectFields) >= 3 && objectFields[2][0] == 'o' && bytes.Equal(objectFields[2], []byte("obj")) &&
		bytes.Contains(xref[:min(len(xref), 4096)], []byte("/Type /XRef")) && bytes.Contains(xref, []byte("/Root"))
}

func encodeJPEGWithinLimit(source image.Image, limit int64) ([]byte, error) {
	current := compositeOnWhite(source)
	for {
		for _, quality := range []int{88, 78, 68} {
			var encoded bytes.Buffer
			if err := jpeg.Encode(&encoded, current, &jpeg.Options{Quality: quality}); err != nil {
				return nil, fmt.Errorf("normalize payment attachment image: %w", err)
			}
			if int64(encoded.Len()) <= limit {
				return encoded.Bytes(), nil
			}
		}
		bounds := current.Bounds()
		if bounds.Dx() <= 320 || bounds.Dy() <= 320 {
			break
		}
		width, height := max(1, bounds.Dx()*4/5), max(1, bounds.Dy()*4/5)
		resized := image.NewNRGBA(image.Rect(0, 0, width, height))
		xdraw.CatmullRom.Scale(resized, resized.Bounds(), current, bounds, draw.Over, nil)
		current = resized
	}
	return nil, fmt.Errorf("%w: normalized attachment exceeds the configured %d-byte limit", domain.ErrPayloadTooLarge, limit)
}

func compositeOnWhite(source image.Image) *image.NRGBA {
	bounds := source.Bounds()
	destination := image.NewNRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	draw.Draw(destination, destination.Bounds(), image.NewUniform(image.White), image.Point{}, draw.Src)
	draw.Draw(destination, destination.Bounds(), source, bounds.Min, draw.Over)
	return destination
}

func normalizeStoredFileName(fileName, extension string) string {
	base := strings.TrimSuffix(fileName, filepath.Ext(fileName))
	if strings.TrimSpace(base) == "" {
		base = "receipt"
	}
	maximumBaseRunes := 240 - utf8.RuneCountInString(extension)
	runes := []rune(base)
	if len(runes) > maximumBaseRunes {
		base = string(runes[:maximumBaseRunes])
	}
	return strings.TrimSpace(base) + extension
}

func normalizeFileName(value string) string {
	value = strings.ReplaceAll(value, "\\", "/")
	value = filepath.Base(value)
	value = strings.Map(func(character rune) rune {
		if unicode.IsControl(character) || character == '/' || character == '\\' {
			return -1
		}
		return character
	}, strings.TrimSpace(value))
	if utf8.RuneCountInString(value) > 240 {
		runes := []rune(value)
		value = string(runes[:240])
	}
	return strings.TrimSpace(value)
}

func jpegOrientation(raw []byte) int {
	for offset := 2; offset+4 <= len(raw) && raw[offset] == 0xff; {
		marker := raw[offset+1]
		if marker == 0xd9 || marker == 0xda {
			break
		}
		length := int(binary.BigEndian.Uint16(raw[offset+2 : offset+4]))
		if length < 2 || offset+2+length > len(raw) {
			break
		}
		segment := raw[offset+4 : offset+2+length]
		if marker == 0xe1 && len(segment) >= 14 && string(segment[:6]) == "Exif\x00\x00" {
			if orientation := tiffOrientation(segment[6:]); orientation != 0 {
				return orientation
			}
		}
		offset += 2 + length
	}
	return 1
}

func tiffOrientation(data []byte) int {
	if len(data) < 8 {
		return 0
	}
	var order binary.ByteOrder
	switch string(data[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 0
	}
	if order.Uint16(data[2:4]) != 42 {
		return 0
	}
	offset := int(order.Uint32(data[4:8]))
	if offset < 0 || offset+2 > len(data) {
		return 0
	}
	count := int(order.Uint16(data[offset : offset+2]))
	for index := 0; index < count; index++ {
		entry := offset + 2 + index*12
		if entry+12 > len(data) {
			return 0
		}
		if order.Uint16(data[entry:entry+2]) == 0x0112 && order.Uint16(data[entry+2:entry+4]) == 3 && order.Uint32(data[entry+4:entry+8]) >= 1 {
			return int(order.Uint16(data[entry+8 : entry+10]))
		}
	}
	return 0
}

func applyOrientation(source image.Image, orientation int) image.Image {
	bounds := source.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	destinationWidth, destinationHeight := width, height
	if orientation >= 5 && orientation <= 8 {
		destinationWidth, destinationHeight = height, width
	}
	destination := image.NewNRGBA(image.Rect(0, 0, destinationWidth, destinationHeight))
	if orientation == 1 {
		draw.Draw(destination, destination.Bounds(), source, bounds.Min, draw.Src)
		return destination
	}
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			var targetX, targetY int
			switch orientation {
			case 2:
				targetX, targetY = width-1-x, y
			case 3:
				targetX, targetY = width-1-x, height-1-y
			case 4:
				targetX, targetY = x, height-1-y
			case 5:
				targetX, targetY = y, x
			case 6:
				targetX, targetY = height-1-y, x
			case 7:
				targetX, targetY = height-1-y, width-1-x
			case 8:
				targetX, targetY = y, width-1-x
			default:
				targetX, targetY = x, y
			}
			destination.Set(targetX, targetY, source.At(bounds.Min.X+x, bounds.Min.Y+y))
		}
	}
	return destination
}
