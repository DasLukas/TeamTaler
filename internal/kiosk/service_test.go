package kiosk

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestPosterLifecycleAndPDFUseCurrentProducts(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	db, err := storage.Open(ctx, filepath.Join(directory, "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "poster-admin@example.test", "Poster Admin", "poster-password-long", "Poster Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := authService.Login(ctx, "poster-admin@example.test", "poster-password-long")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	groups, err := (groups.Service{DB: db}).List(ctx, session.Principal.UserID)
	if err != nil || len(groups) != 1 {
		t.Fatalf("list groups: count=%d error=%v", len(groups), err)
	}
	admin := groups[0].Membership
	service := Service{DB: db, DataDirectory: directory, PublicURL: "https://teamtaler.example.test"}
	initial, err := service.List(ctx, admin)
	if err != nil || len(initial) != 1 || !initial[0].IsDefault || initial[0].Name != "Standard" || len(initial[0].ProductIDs) != 0 {
		t.Fatalf("initial standard poster=%#v error=%v", initial, err)
	}
	standard := initial[0]
	if _, err := db.ExecContext(ctx, `INSERT INTO categories(id,group_id,name,created_at,updated_at) VALUES('poster-cat',?,'Drinks','2026-09-23T00:00:00Z','2026-09-23T00:00:00Z')`, admin.GroupID); err != nil {
		t.Fatalf("insert category: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO products(id,group_id,category_id,name,price_minor,created_at,updated_at) VALUES('poster-product',?,'poster-cat','Mineralwasser',125,'2026-09-23T00:00:00Z','2026-09-23T00:00:00Z')`, admin.GroupID); err != nil {
		t.Fatalf("insert product: %v", err)
	}
	if _, err := service.Create(ctx, session.Principal, admin, PosterInput{Name: "Duplicate", ProductIDs: []string{"poster-product", "poster-product"}}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("duplicate product error=%v, want validation", err)
	}
	for _, invalid := range []PosterInput{
		{Name: "No products"},
		{Name: "standard", ProductIDs: []string{"poster-product"}},
	} {
		if _, err := service.Create(ctx, session.Principal, admin, invalid); !errors.Is(err, domain.ErrValidation) {
			t.Fatalf("invalid custom poster %#v error=%v, want validation", invalid, err)
		}
	}
	for _, invalid := range []PosterInput{
		{Name: "Bad\nTitle"},
		{Name: "Bad\u0000Title"},
		{Name: "Bad\u202eTitle"},
		{Name: "Valid", Text: "Bad\u0000text"},
		{Name: "Valid", Text: "Bad\ttext"},
	} {
		if _, err := service.Create(ctx, session.Principal, admin, invalid); !errors.Is(err, domain.ErrValidation) {
			t.Fatalf("invalid poster %#v error=%v, want validation", invalid, err)
		}
	}
	if _, err := service.Create(ctx, session.Principal, admin, PosterInput{Name: "Foreign", ProductIDs: []string{"another-group-product"}}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("unknown product error=%v, want conflict", err)
	}
	created, err := service.Create(ctx, session.Principal, admin, PosterInput{Name: "Drinks", Text: "Enjoy your drink", ProductIDs: []string{"poster-product"}})
	if err != nil || created.Version != 1 || created.ID == "" {
		t.Fatalf("create poster=%#v error=%v", created, err)
	}
	items, err := service.List(ctx, admin)
	if err != nil || len(items) != 2 || items[0].ID != standard.ID || !items[0].IsDefault || items[1].IsDefault || len(items[1].ProductIDs) != 1 || items[1].ProductIDs[0] != "poster-product" {
		t.Fatalf("list posters=%#v error=%v", items, err)
	}
	if _, err := service.PDF(ctx, admin, created.ID); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("PDF while disabled error=%v, want conflict", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE group_settings SET kiosk_enabled=1 WHERE group_id=?`, admin.GroupID); err != nil {
		t.Fatalf("enable kiosk: %v", err)
	}
	pdf, err := service.PDF(ctx, admin, created.ID)
	if err != nil || !bytes.HasPrefix(pdf, []byte("%PDF-")) || len(pdf) < 1000 {
		t.Fatalf("render PDF: size=%d error=%v", len(pdf), err)
	}
	if output := os.Getenv("TEAMTALER_POSTER_PDF_TEST_OUTPUT"); output != "" {
		if err := os.WriteFile(output, pdf, 0o600); err != nil {
			t.Fatalf("write PDF preview: %v", err)
		}
	}
	if _, err := service.Update(ctx, session.Principal, admin, created.ID, 2, PosterInput{Name: "Stale", ProductIDs: []string{"poster-product"}}); !errors.Is(err, domain.ErrPrecondition) {
		t.Fatalf("stale update error=%v, want precondition", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE products SET active=0 WHERE group_id=? AND id='poster-product'`, admin.GroupID); err != nil {
		t.Fatalf("archive product: %v", err)
	}
	if _, err := service.PDF(ctx, admin, created.ID); !errors.Is(err, domain.ErrConflict) || !strings.Contains(err.Error(), "update the poster template") {
		t.Fatalf("archived product PDF error=%v, want actionable conflict", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO kiosk_posters(id,group_id,name,text,created_at,updated_at)
		VALUES('old-empty-poster',?,'Old empty','','2026-09-23T00:00:00Z','2026-09-23T00:00:00Z')`, admin.GroupID); err != nil {
		t.Fatalf("insert legacy empty poster: %v", err)
	}
	if _, err := service.PDF(ctx, admin, "old-empty-poster"); !errors.Is(err, domain.ErrConflict) || !strings.Contains(err.Error(), "has no products") {
		t.Fatalf("legacy empty PDF error=%v, want actionable conflict", err)
	}
	if _, err := service.Update(ctx, session.Principal, admin, created.ID, 1, PosterInput{Name: "Group only", Text: "Scan to book", ProductIDs: []string{}}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("empty custom poster update=%v, want validation", err)
	}
	if _, err := service.Update(ctx, session.Principal, admin, standard.ID, 1, PosterInput{Name: "Changed", Text: "Scan to book"}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("standard rename=%v, want validation", err)
	}
	if _, err := service.Update(ctx, session.Principal, admin, standard.ID, 1, PosterInput{Name: "Standard", ProductIDs: []string{"poster-product"}}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("standard product addition=%v, want validation", err)
	}
	updated, err := service.Update(ctx, session.Principal, admin, standard.ID, 1, PosterInput{Name: "Standard", Text: "Scan to book", ProductIDs: []string{}})
	if err != nil || updated.Version != 2 {
		t.Fatalf("update standard template=%#v error=%v", updated, err)
	}
	groupPDF, err := service.PDF(ctx, admin, standard.ID)
	if err != nil {
		t.Fatalf("render group-only poster: %v", err)
	}
	if output := os.Getenv("TEAMTALER_GROUP_POSTER_PDF_TEST_OUTPUT"); output != "" {
		if err := os.WriteFile(output, groupPDF, 0o600); err != nil {
			t.Fatalf("write group-only PDF preview: %v", err)
		}
	}
	if err := service.Delete(ctx, session.Principal, admin, standard.ID, 2); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("delete standard poster=%v, want conflict", err)
	}
	if err := service.Delete(ctx, session.Principal, admin, created.ID, 2); !errors.Is(err, domain.ErrPrecondition) {
		t.Fatalf("stale delete error=%v, want precondition", err)
	}
	if err := service.Delete(ctx, session.Principal, admin, created.ID, 1); err != nil {
		t.Fatalf("delete template: %v", err)
	}
	if _, err := service.PDF(ctx, admin, created.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("deleted PDF error=%v, want not found", err)
	}
}

func TestPosterInputNormalizesAllowedLineBreaks(t *testing.T) {
	input, err := validateInput(PosterInput{Name: "  Summer drinks  ", Text: "Line one\r\nLine two"})
	if err != nil {
		t.Fatalf("validate line breaks: %v", err)
	}
	if input.Name != "Summer drinks" || input.Text != "Line one\nLine two" {
		t.Fatalf("normalized poster input=%#v", input)
	}
}
