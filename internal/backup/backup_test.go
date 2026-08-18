package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/catalog"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

type testArchiveEntry struct {
	name string
	body []byte
}

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
	groupService := groups.Service{DB: db}
	groupItems, err := groupService.List(ctx, session.Principal.UserID)
	if err != nil || len(groupItems) != 1 {
		t.Fatalf("list backup group: groups=%d err=%v", len(groupItems), err)
	}
	membership := groupItems[0].Membership
	roleIDs := append(append([]string(nil), membership.RoleIDs...), authorization.TemplateRoleID(membership.GroupID, domain.RoleTemplateCatalog))
	if _, err := groupService.ReplaceMemberRoles(ctx, session.Principal, membership, membership.ID, roleIDs, membership.RoleAssignmentsVersion); err != nil {
		t.Fatalf("assign backup catalog role: %v", err)
	}
	membership, err = groupService.MembershipForUser(ctx, membership.GroupID, membership.UserID)
	if err != nil {
		t.Fatalf("reload backup membership: %v", err)
	}
	categoryService := catalog.Service{DB: db}
	category, err := categoryService.CreateCategory(ctx, session.Principal, membership, catalog.CreateCategoryInput{Name: "Drinks", Icon: domain.CategoryIconDrink})
	if err != nil {
		t.Fatalf("create backup category: %v", err)
	}
	priceMinor := int64(100)
	product, err := categoryService.CreateProduct(ctx, session.Principal, membership, "backup-product-one", category.ID, catalog.CreateProductInput{Name: "Water", PriceMinor: &priceMinor})
	if err != nil {
		t.Fatalf("create backup product: %v", err)
	}
	imageDigest := sha256.Sum256([]byte("fixture"))
	imageKey := hex.EncodeToString(imageDigest[:]) + ".png"
	if _, err := db.ExecContext(ctx, `UPDATE products SET image_key=? WHERE id=?`, imageKey, product.ID); err != nil {
		t.Fatalf("reference backup image: %v", err)
	}
	logoDigest := sha256.Sum256([]byte("logo-fixture"))
	logoKey := hex.EncodeToString(logoDigest[:]) + ".png"
	if _, err := db.ExecContext(ctx, `UPDATE groups SET logo_key=? WHERE id=?`, logoKey, groupItems[0].ID); err != nil {
		t.Fatalf("reference backup logo: %v", err)
	}
	avatarDigest := sha256.Sum256([]byte("avatar-fixture"))
	avatarKey := hex.EncodeToString(avatarDigest[:]) + ".png"
	if _, err := db.ExecContext(ctx, `UPDATE users SET avatar_key=? WHERE id=?`, avatarKey, session.Principal.UserID); err != nil {
		t.Fatalf("reference backup avatar: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(sourceDirectory, "images"), 0o750); err != nil {
		t.Fatalf("create image directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sourceDirectory, "images", imageKey), []byte("fixture"), 0o640); err != nil {
		t.Fatalf("write image fixture: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sourceDirectory, "images", logoKey), []byte("logo-fixture"), 0o640); err != nil {
		t.Fatalf("write logo fixture: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sourceDirectory, "images", avatarKey), []byte("avatar-fixture"), 0o640); err != nil {
		t.Fatalf("write avatar fixture: %v", err)
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
	if body, err := os.ReadFile(filepath.Join(restoreDirectory, "images", logoKey)); err != nil || string(body) != "logo-fixture" {
		t.Fatalf("restored logo=%q err=%v", body, err)
	}
	if body, err := os.ReadFile(filepath.Join(restoreDirectory, "images", avatarKey)); err != nil || string(body) != "avatar-fixture" {
		t.Fatalf("restored avatar=%q err=%v", body, err)
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

func TestValidateArchiveEntryName(t *testing.T) {
	contentAddress := strings.Repeat("a", 64)
	validNames := []string{
		databaseEntryName,
		manifestEntryName,
		imagesEntryPrefix + contentAddress + ".png",
		imagesEntryPrefix + strings.Repeat("0", 64) + ".png",
	}
	for _, name := range validNames {
		t.Run("valid_"+strings.ReplaceAll(name, "/", "_"), func(t *testing.T) {
			if err := validateArchiveEntryName(name); err != nil {
				t.Fatalf("validate canonical archive entry %q: %v", name, err)
			}
		})
	}

	invalidNames := []string{
		"",
		".",
		"./" + databaseEntryName,
		"/" + databaseEntryName,
		"../" + databaseEntryName,
		"images/../" + databaseEntryName,
		"images\\" + contentAddress + ".png",
		"images/nested/" + contentAddress + ".png",
		"images//" + contentAddress + ".png",
		imagesEntryPrefix + strings.Repeat("A", 64) + ".png",
		imagesEntryPrefix + strings.Repeat("a", 63) + ".png",
		imagesEntryPrefix + contentAddress + ".jpg",
	}
	for _, name := range invalidNames {
		t.Run("invalid_"+strings.ReplaceAll(name, "/", "_"), func(t *testing.T) {
			if err := validateArchiveEntryName(name); err == nil {
				t.Fatalf("archive entry %q unexpectedly passed validation", name)
			}
		})
	}
}

func TestArchiveDestinationPathAcceptsCanonicalEntries(t *testing.T) {
	destination := t.TempDir()
	name := imagesEntryPrefix + strings.Repeat("b", 64) + ".png"
	actual, err := archiveDestinationPath(destination, name)
	if err != nil {
		t.Fatalf("resolve canonical archive entry: %v", err)
	}
	expected := filepath.Join(destination, "images", strings.Repeat("b", 64)+".png")
	if actual != expected {
		t.Fatalf("archive destination=%q, want %q", actual, expected)
	}
}

func TestExtractValidatedRejectsUnsafeArchivePaths(t *testing.T) {
	contentAddress := strings.Repeat("c", 64)
	tests := []struct {
		name      string
		entryName func(root string) string
	}{
		{name: "traversal", entryName: func(string) string { return "../traversal-escape" }},
		{name: "absolute", entryName: func(root string) string { return filepath.Join(root, "absolute-escape") }},
		{name: "backslash", entryName: func(string) string { return "images\\" + contentAddress + ".png" }},
		{name: "nested image", entryName: func(string) string { return "images/nested/" + contentAddress + ".png" }},
		{name: "non-canonical traversal", entryName: func(string) string { return "images/../" + databaseEntryName }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			destination := filepath.Join(root, "extracted")
			if err := os.MkdirAll(destination, 0o750); err != nil {
				t.Fatalf("create extraction directory: %v", err)
			}
			archivePath := writeTestArchive(t, []testArchiveEntry{{name: test.entryName(root), body: []byte("malicious")}})
			if err := extractValidated(archivePath, destination); err == nil || !strings.Contains(err.Error(), "unsafe path") {
				t.Fatalf("extract unsafe archive: err=%v", err)
			}
			for _, escapedPath := range []string{filepath.Join(root, "traversal-escape"), filepath.Join(root, "absolute-escape")} {
				if _, err := os.Stat(escapedPath); !os.IsNotExist(err) {
					t.Fatalf("unsafe archive created %q: %v", escapedPath, err)
				}
			}
		})
	}
}

func TestExtractValidatedRejectsDuplicateEntries(t *testing.T) {
	archivePath := writeTestArchive(t, []testArchiveEntry{
		{name: databaseEntryName, body: []byte("first")},
		{name: databaseEntryName, body: []byte("second")},
	})
	err := extractValidated(archivePath, t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "duplicate entry") {
		t.Fatalf("extract duplicate archive entries: err=%v", err)
	}
}

// writeTestArchive creates a gzip-compressed tar fixture with the provided
// entry order preserved. It returns the fixture path and fails the current test
// when header, payload, compression, or file finalization cannot complete.
func writeTestArchive(t *testing.T, entries []testArchiveEntry) string {
	t.Helper()
	archivePath := filepath.Join(t.TempDir(), "fixture.tar.gz")
	file, err := os.Create(archivePath)
	if err != nil {
		t.Fatalf("create archive fixture: %v", err)
	}
	gzipWriter := gzip.NewWriter(file)
	tarWriter := tar.NewWriter(gzipWriter)
	for _, entry := range entries {
		header := &tar.Header{Name: entry.name, Mode: 0o640, Size: int64(len(entry.body))}
		if err := tarWriter.WriteHeader(header); err != nil {
			t.Fatalf("write archive header %q: %v", entry.name, err)
		}
		if _, err := tarWriter.Write(entry.body); err != nil {
			t.Fatalf("write archive body %q: %v", entry.name, err)
		}
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatalf("close tar fixture: %v", err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatalf("close gzip fixture: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close archive fixture: %v", err)
	}
	return archivePath
}
