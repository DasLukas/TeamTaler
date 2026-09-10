package email

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/media"
	xdraw "golang.org/x/image/draw"
)

const (
	emailLogoPixels  = 96
	maximumLogoBytes = 10 << 20
)

// BrandingScope identifies whether an email represents TeamTaler itself or a
// specific group. It controls the visible sender identity and subject prefix.
type BrandingScope string

const (
	// BrandingScopeSystem always uses the TeamTaler identity and theme.
	BrandingScopeSystem BrandingScope = "SYSTEM"
	// BrandingScopeGroup uses a group's identity and the recipient's effective theme.
	BrandingScopeGroup BrandingScope = "GROUP"
)

// BrandingContext contains the trusted visual identity rendered into one email.
// LogoPNG is a bounded, metadata-free PNG intended for an inline MIME part.
type BrandingContext struct {
	// Scope distinguishes product-level messages from group-level messages.
	Scope BrandingScope
	// Name is the visible TeamTaler or group name.
	Name string
	// Theme selects one of the supported semantic email palettes.
	Theme domain.ThemeID
	// LogoPNG contains the inline logo image.
	LogoPNG []byte
	// trustedSystemLogo records that LogoPNG came from the system resolver. It
	// prevents a caller from reclassifying group imagery as system branding.
	trustedSystemLogo bool
}

// BrandingResolver resolves current group identity and recipient appearance at
// delivery time. It loads managed group logos defensively and falls back to the
// TeamTaler mark without failing delivery when image data is unavailable.
type BrandingResolver struct {
	db            *sql.DB
	dataDirectory string
	webDirectory  string
	logger        *slog.Logger
	systemOnce    sync.Once
	systemLogo    []byte
}

// NewBrandingResolver constructs the branding resolver used by email workers
// and SMTP test flows.
//
// Parameters:
//   - db: Migrated TeamTaler database used to resolve group identity and themes.
//   - dataDirectory: Root containing normalized managed group images.
//   - webDirectory: Compiled web root containing the public TeamTaler mark.
//   - logger: Optional structured logger; nil selects slog.Default.
//
// Returns a resolver or a validation error. Construction performs no database
// or filesystem I/O.
//
// Example: NewBrandingResolver(db, configuration.DataDirectory, configuration.WebDirectory, logger).
func NewBrandingResolver(db *sql.DB, dataDirectory, webDirectory string, logger *slog.Logger) (*BrandingResolver, error) {
	if db == nil {
		return nil, errors.New("create email branding resolver: database is required")
	}
	if strings.TrimSpace(dataDirectory) == "" || strings.TrimSpace(webDirectory) == "" {
		return nil, errors.New("create email branding resolver: data and web directories are required")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &BrandingResolver{db: db, dataDirectory: dataDirectory, webDirectory: webDirectory, logger: logger}, nil
}

// System returns TeamTaler system branding. It takes no parameters and cannot
// fail. The bundled web mark is normalized on first use; a deterministic
// generated TeamTaler monogram is used if the deployed asset is missing or
// malformed so transactional delivery can proceed.
//
// Example: branding := resolver.System().
func (r *BrandingResolver) System() BrandingContext {
	if r == nil {
		return defaultSystemBranding()
	}
	r.systemOnce.Do(func() {
		path := filepath.Join(r.webDirectory, "brand", "teamtaler-mark.png")
		logo, err := loadAndNormalizeEmailLogo(path)
		if err != nil {
			r.logger.Warn("TeamTaler email logo unavailable; using generated fallback", "error", err)
			logo = generatedTeamTalerLogo()
		}
		r.systemLogo = logo
	})
	return BrandingContext{
		Scope:             BrandingScopeSystem,
		Name:              "TeamTaler",
		Theme:             domain.ThemeTeamTaler,
		LogoPNG:           append([]byte(nil), r.systemLogo...),
		trustedSystemLogo: true,
	}
}

// Group resolves a group's current name, effective recipient theme, and logo.
//
// Parameters:
//   - ctx: Bounds the database and filesystem lookup.
//   - groupID: Group whose current identity is required.
//   - membershipID: Active recipient membership, or empty before joining.
//
// Returns the resolved branding and a database error when group metadata cannot
// be loaded. Logo failures are logged and replaced with the TeamTaler mark.
//
// Example: branding, err := resolver.Group(ctx, groupID, membershipID).
func (r *BrandingResolver) Group(ctx context.Context, groupID, membershipID string) (BrandingContext, error) {
	if r == nil || r.db == nil {
		return BrandingContext{}, errors.New("resolve email group branding: resolver is not configured")
	}
	if ctx == nil {
		return BrandingContext{}, errors.New("resolve email group branding: context is required")
	}
	var name string
	var logoKey sql.NullString
	var theme domain.ThemeID
	err := r.db.QueryRowContext(ctx, `SELECT g.name,g.logo_key,
		coalesce((SELECT m.theme_override FROM memberships m
			WHERE m.id=? AND m.group_id=g.id AND m.status='ACTIVE' AND m.deleted_at IS NULL),
			settings.default_theme,'TEAMTALER')
		FROM groups g LEFT JOIN group_settings settings ON settings.group_id=g.id
		WHERE g.id=?`, membershipID, groupID).Scan(&name, &logoKey, &theme)
	if err != nil {
		return BrandingContext{}, fmt.Errorf("resolve email group branding: %w", err)
	}
	if !theme.Valid() {
		theme = domain.ThemeTeamTaler
	}
	branding := BrandingContext{Scope: BrandingScopeGroup, Name: name, Theme: theme}
	if logoKey.Valid {
		path, pathErr := media.ResolveImage(r.dataDirectory, logoKey.String)
		if pathErr == nil {
			branding.LogoPNG, pathErr = loadAndNormalizeEmailLogo(path)
		}
		if pathErr != nil {
			r.logger.Warn("group email logo unavailable; using TeamTaler fallback", "group_id", groupID, "error", pathErr)
		}
	}
	if len(branding.LogoPNG) == 0 {
		branding.LogoPNG = r.System().LogoPNG
	}
	return branding, nil
}

func defaultSystemBranding() BrandingContext {
	return BrandingContext{Scope: BrandingScopeSystem, Name: "TeamTaler", Theme: domain.ThemeTeamTaler, LogoPNG: generatedTeamTalerLogo(), trustedSystemLogo: true}
}

func loadAndNormalizeEmailLogo(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open email logo: %w", err)
	}
	defer file.Close()
	limited := io.LimitReader(file, maximumLogoBytes+1)
	raw, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("read email logo: %w", err)
	}
	if len(raw) == 0 || len(raw) > maximumLogoBytes {
		return nil, errors.New("email logo is empty or exceeds the size limit")
	}
	source, format, err := image.Decode(bytes.NewReader(raw))
	if err != nil || format != "png" {
		return nil, errors.New("email logo must be a valid normalized PNG")
	}
	return resizeEmailLogo(source)
}

func resizeEmailLogo(source image.Image) ([]byte, error) {
	bounds := source.Bounds()
	if bounds.Dx() < 1 || bounds.Dy() < 1 {
		return nil, errors.New("email logo has invalid dimensions")
	}
	width, height := emailLogoPixels, emailLogoPixels
	if bounds.Dx() > bounds.Dy() {
		height = max(1, emailLogoPixels*bounds.Dy()/bounds.Dx())
	} else if bounds.Dy() > bounds.Dx() {
		width = max(1, emailLogoPixels*bounds.Dx()/bounds.Dy())
	}
	destination := image.NewNRGBA(image.Rect(0, 0, width, height))
	xdraw.CatmullRom.Scale(destination, destination.Bounds(), source, bounds, draw.Over, nil)
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, destination); err != nil {
		return nil, fmt.Errorf("encode email logo: %w", err)
	}
	return encoded.Bytes(), nil
}

func generatedTeamTalerLogo() []byte {
	canvas := image.NewNRGBA(image.Rect(0, 0, emailLogoPixels, emailLogoPixels))
	draw.Draw(canvas, canvas.Bounds(), &image.Uniform{C: color.NRGBA{R: 3, G: 24, B: 47, A: 255}}, image.Point{}, draw.Src)
	center := image.Point{X: emailLogoPixels / 2, Y: emailLogoPixels / 2}
	for y := 10; y < emailLogoPixels-10; y++ {
		for x := 10; x < emailLogoPixels-10; x++ {
			dx, dy := x-center.X, y-center.Y
			distance := dx*dx + dy*dy
			if distance <= 36*36 && distance >= 31*31 {
				canvas.Set(x, y, color.NRGBA{R: 255, G: 184, B: 35, A: 255})
			}
		}
	}
	gold := &image.Uniform{C: color.NRGBA{R: 255, G: 184, B: 35, A: 255}}
	for _, rectangle := range []image.Rectangle{
		image.Rect(25, 28, 50, 34), image.Rect(34, 28, 40, 63),
		image.Rect(47, 42, 72, 48), image.Rect(56, 42, 62, 70),
	} {
		draw.Draw(canvas, rectangle, gold, image.Point{}, draw.Src)
	}
	var encoded bytes.Buffer
	_ = png.Encode(&encoded, canvas)
	return encoded.Bytes()
}
