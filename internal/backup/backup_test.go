package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/catalog"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestCreateAndRestore(t *testing.T) {
	ctx := context.Background()
	sourceDirectory := filepath.Join(t.TempDir(), "source")
	db, err := storage.Open(ctx, filepath.Join(sourceDirectory, "teamtaler.db"))
	if err != nil {
		t.Fatalf("open source database: %v", err)
	}
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "backup@example.test", "Backup Admin", "backup-test-password-long", "Backup Group", "EUR"); err != nil {
		t.Fatalf("bootstrap backup fixture: %v", err)
	}
	session, err := authService.Login(ctx, "backup@example.test", "backup-test-password-long")
	if err != nil {
		t.Fatalf("login backup fixture: %v", err)
	}
	groupItems, err := (groups.Service{DB: db}).List(ctx, session.Principal.UserID)
	if err != nil || len(groupItems) != 1 {
		t.Fatalf("list backup group: groups=%d err=%v", len(groupItems), err)
	}
	categoryService := catalog.Service{DB: db}
	category, err := categoryService.CreateCategory(ctx, session.Principal, groupItems[0].Membership, catalog.CreateCategoryInput{Name: "Drinks", Type: domain.CategoryStandard})
	if err != nil {
		t.Fatalf("create backup category: %v", err)
	}
	product, err := categoryService.CreateProduct(ctx, session.Principal, groupItems[0].Membership, "backup-product-one", category.ID, catalog.CreateProductInput{Name: "Water", PriceMinor: 100})
	if err != nil {
		t.Fatalf("create backup product: %v", err)
	}
	imageDigest := sha256.Sum256([]byte("fixture"))
	imageKey := hex.EncodeToString(imageDigest[:]) + ".png"
	if _, err := db.ExecContext(ctx, `UPDATE products SET image_key=? WHERE id=?`, imageKey, product.ID); err != nil {
		t.Fatalf("reference backup image: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(sourceDirectory, "images"), 0o750); err != nil {
		t.Fatalf("create image directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sourceDirectory, "images", imageKey), []byte("fixture"), 0o640); err != nil {
		t.Fatalf("write image fixture: %v", err)
	}
	archive := filepath.Join(t.TempDir(), "backup.tar.gz")
	if err := Create(ctx, db, sourceDirectory, archive); err != nil {
		db.Close()
		t.Fatalf("create backup: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close source database: %v", err)
	}
	restoreDirectory := filepath.Join(t.TempDir(), "restored")
	restoredDatabase := filepath.Join(restoreDirectory, "custom.sqlite")
	if _, err := Restore(archive, restoreDirectory, filepath.Join(t.TempDir(), "outside.sqlite"), false); err == nil {
		t.Fatal("restore accepted a database path outside the data directory")
	}
	if recovery, err := Restore(archive, restoreDirectory, restoredDatabase, false); err != nil || recovery != "" {
		t.Fatalf("restore: recovery=%q err=%v", recovery, err)
	}
	restored, err := storage.Open(ctx, restoredDatabase)
	if err != nil {
		t.Fatalf("open restored database: %v", err)
	}
	var migrations int
	if err := restored.QueryRowContext(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&migrations); err != nil || migrations == 0 {
		t.Fatalf("restored migration count=%d err=%v", migrations, err)
	}
	if body, err := os.ReadFile(filepath.Join(restoreDirectory, "images", imageKey)); err != nil || string(body) != "fixture" {
		t.Fatalf("restored image=%q err=%v", body, err)
	}
	if err := restored.Close(); err != nil {
		t.Fatalf("close restored database: %v", err)
	}
	parent := filepath.Dir(restoreDirectory)
	if err := os.Chmod(parent, 0o550); err != nil {
		t.Fatalf("make data parent read-only: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(parent, 0o750) })
	recovery, err := Restore(archive, restoreDirectory, restoredDatabase, true)
	if err != nil {
		t.Fatalf("force restore with read-only parent: %v", err)
	}
	if !strings.HasPrefix(recovery, restoreDirectory+string(filepath.Separator)) {
		t.Fatalf("recovery directory %q is not inside data directory %q", recovery, restoreDirectory)
	}
}
