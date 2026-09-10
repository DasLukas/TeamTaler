package email

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/media"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestBrandingResolverUsesRecipientThemeAndSafeLogoFallback(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	dataDirectory := t.TempDir()
	db, err := storage.Open(ctx, filepath.Join(dataDirectory, "branding.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	const now = "2026-09-10T12:00:00Z"
	for _, statement := range []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-brand','member@example.test','Member','hash','2026-09-10T12:00:00Z','2026-09-10T12:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-brand','Brand Group','EUR','2026-09-10T12:00:00Z','2026-09-10T12:00:00Z')`,
		`INSERT INTO group_settings(group_id,members_can_view_all_bookings,default_theme,updated_at) VALUES('group-brand',0,'NRW','2026-09-10T12:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,theme_override,joined_at) VALUES('member-brand','group-brand','user-brand','FIRE','2026-09-10T12:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed branding data: %v", err)
		}
	}
	imageKey := storeEmailTestLogo(t, dataDirectory)
	if _, err := db.ExecContext(ctx, `UPDATE groups SET logo_key=?,updated_at=? WHERE id='group-brand'`, imageKey, now); err != nil {
		t.Fatalf("attach group logo: %v", err)
	}
	resolver, err := NewBrandingResolver(db, dataDirectory, t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("create resolver: %v", err)
	}

	memberBranding, err := resolver.Group(ctx, "group-brand", "member-brand")
	if err != nil {
		t.Fatalf("resolve member branding: %v", err)
	}
	if memberBranding.Scope != BrandingScopeGroup || memberBranding.Name != "Brand Group" || memberBranding.Theme != domain.ThemeFire {
		t.Fatalf("member branding=%#v", memberBranding)
	}
	assertEmailLogoDimensions(t, memberBranding.LogoPNG)

	defaultBranding, err := resolver.Group(ctx, "group-brand", "")
	if err != nil || defaultBranding.Theme != domain.ThemeNRW {
		t.Fatalf("default branding=%#v err=%v", defaultBranding, err)
	}

	logoPath, err := media.ResolveImage(dataDirectory, imageKey)
	if err != nil {
		t.Fatalf("resolve logo path: %v", err)
	}
	if err := os.Remove(logoPath); err != nil {
		t.Fatalf("remove test logo: %v", err)
	}
	fallbackBranding, err := resolver.Group(ctx, "group-brand", "member-brand")
	if err != nil {
		t.Fatalf("resolve fallback branding: %v", err)
	}
	systemBranding := resolver.System()
	if !bytes.Equal(fallbackBranding.LogoPNG, systemBranding.LogoPNG) || systemBranding.Theme != domain.ThemeTeamTaler || systemBranding.Name != "TeamTaler" {
		t.Fatalf("fallback/system branding mismatch: fallback=%#v system=%#v", fallbackBranding, systemBranding)
	}
}

func storeEmailTestLogo(t *testing.T, dataDirectory string) string {
	t.Helper()
	fixture := image.NewNRGBA(image.Rect(0, 0, 240, 120))
	for index := range fixture.Pix {
		fixture.Pix[index] = 0x66
	}
	fixture.Set(0, 0, color.NRGBA{R: 0, G: 145, B: 54, A: 255})
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, fixture); err != nil {
		t.Fatalf("encode test logo: %v", err)
	}
	key, _, err := media.NormalizeAndStoreImage(dataDirectory, bytes.NewReader(encoded.Bytes()))
	if err != nil {
		t.Fatalf("store test logo: %v", err)
	}
	return key
}

func assertEmailLogoDimensions(t *testing.T, raw []byte) {
	t.Helper()
	configuration, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || format != "png" || configuration.Width > emailLogoPixels || configuration.Height > emailLogoPixels {
		t.Fatalf("email logo format=%q dimensions=%dx%d err=%v", format, configuration.Width, configuration.Height, err)
	}
}
