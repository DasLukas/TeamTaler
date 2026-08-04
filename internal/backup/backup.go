// Package backup creates and restores consistent, checksummed TeamTaler archives.
package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/migrations"
	_ "modernc.org/sqlite"
)

const maxRestoreBytes int64 = 2 << 30

// Manifest records the archive format, creation timestamp, and SHA-256 checksum
// for every payload file. It is serialized as manifest.json inside the archive.
type Manifest struct {
	FormatVersion int               `json:"formatVersion"`
	CreatedAt     string            `json:"createdAt"`
	Files         map[string]string `json:"files"`
}

// Create writes a consistent online SQLite snapshot and referenced images.
// The context bounds SQLite work; db is the live database, dataDirectory owns
// images, and outputPath is a new tar.gz file. It returns an error for snapshot,
// missing-image, checksum, or output failures and never replaces an existing file.
func Create(ctx context.Context, db *sql.DB, dataDirectory, outputPath string) error {
	if _, err := os.Stat(outputPath); err == nil {
		return fmt.Errorf("backup output already exists: %s", outputPath)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(dataDirectory, 0o750); err != nil {
		return fmt.Errorf("prepare data directory: %w", err)
	}
	working, err := os.MkdirTemp(dataDirectory, ".backup-staging-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(working)
	databaseSnapshot := filepath.Join(working, "teamtaler.db")
	if _, err := db.ExecContext(ctx, `VACUUM INTO ?`, databaseSnapshot); err != nil {
		return fmt.Errorf("create SQLite snapshot: %w", err)
	}
	files := map[string]string{"teamtaler.db": databaseSnapshot}
	snapshotDB, err := sql.Open("sqlite", "file:"+filepath.ToSlash(databaseSnapshot)+"?mode=ro")
	if err != nil {
		return fmt.Errorf("open SQLite snapshot for image inventory: %w", err)
	}
	imageRows, err := snapshotDB.QueryContext(ctx, `SELECT DISTINCT image_key FROM products WHERE image_key IS NOT NULL`)
	if err != nil {
		snapshotDB.Close()
		return fmt.Errorf("read referenced image inventory: %w", err)
	}
	var imageKeys []string
	for imageRows.Next() {
		var key string
		if err := imageRows.Scan(&key); err != nil {
			imageRows.Close()
			snapshotDB.Close()
			return err
		}
		if filepath.Base(key) != key || strings.Contains(key, "..") {
			imageRows.Close()
			snapshotDB.Close()
			return errors.New("database contains an unsafe image key")
		}
		imageKeys = append(imageKeys, key)
	}
	if err := imageRows.Close(); err != nil {
		snapshotDB.Close()
		return err
	}
	if err := snapshotDB.Close(); err != nil {
		return err
	}
	for _, key := range imageKeys {
		path := filepath.Join(dataDirectory, "images", key)
		if _, err := os.Stat(path); err != nil {
			return fmt.Errorf("referenced image %s is unavailable: %w", key, err)
		}
		files[filepath.ToSlash(filepath.Join("images", key))] = path
	}
	manifest := Manifest{FormatVersion: 1, CreatedAt: platform.Timestamp(platform.Now()), Files: map[string]string{}}
	for name, path := range files {
		digest, err := fileDigest(path)
		if err != nil {
			return err
		}
		manifest.Files[name] = digest
	}
	manifestBody, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o750); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(outputPath), ".teamtaler-backup-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	gzipWriter := gzip.NewWriter(temporary)
	tarWriter := tar.NewWriter(gzipWriter)
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if err := addFile(tarWriter, name, files[name]); err != nil {
			tarWriter.Close()
			gzipWriter.Close()
			temporary.Close()
			return err
		}
	}
	if err := addBytes(tarWriter, "manifest.json", manifestBody, 0o640); err != nil {
		return err
	}
	if err := tarWriter.Close(); err != nil {
		return err
	}
	if err := gzipWriter.Close(); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Chmod(temporaryPath, 0o600); err != nil {
		return err
	}
	return os.Rename(temporaryPath, outputPath)
}

// Restore validates archivePath and installs its database at databasePath plus
// its images below dataDirectory. databasePath must be a direct child of the
// data directory so staging and renames remain on one mounted filesystem. When
// force is true, existing data moves into a timestamped recovery directory. It
// returns that recovery path (or empty string) and an error for unsafe paths or
// archives, checksum/schema/integrity failures, conflicts, and I/O failures.
func Restore(archivePath, dataDirectory, databasePath string, force bool) (string, error) {
	dataDirectory, err := filepath.Abs(dataDirectory)
	if err != nil {
		return "", fmt.Errorf("resolve data directory: %w", err)
	}
	databasePath, err = filepath.Abs(databasePath)
	if err != nil {
		return "", fmt.Errorf("resolve database path: %w", err)
	}
	if filepath.Dir(databasePath) != dataDirectory {
		return "", errors.New("database path must be a direct child of the data directory")
	}
	if _, err := os.Stat(databasePath); err == nil && !force {
		return "", errors.New("database already exists; pass --force to preserve and replace it")
	}
	if err := os.MkdirAll(dataDirectory, 0o750); err != nil {
		return "", err
	}
	working, err := os.MkdirTemp(dataDirectory, ".restore-staging-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(working)
	if err := extractValidated(archivePath, working); err != nil {
		return "", err
	}
	if _, err := os.Stat(filepath.Join(working, "teamtaler.db")); err != nil {
		return "", errors.New("backup does not contain teamtaler.db")
	}
	recovery := ""
	hasExistingData := false
	databaseName := filepath.Base(databasePath)
	existing := []struct {
		path string
		name string
	}{
		{databasePath, databaseName},
		{databasePath + "-wal", databaseName + "-wal"},
		{databasePath + "-shm", databaseName + "-shm"},
		{filepath.Join(dataDirectory, "images"), "images"},
	}
	for _, item := range existing {
		if _, err := os.Stat(item.path); err == nil {
			hasExistingData = true
			break
		}
	}
	if hasExistingData {
		recovery = filepath.Join(dataDirectory, ".restore-backup-"+time.Now().UTC().Format("20060102T150405.000000000Z"))
		if err := os.MkdirAll(recovery, 0o750); err != nil {
			return "", err
		}
		for _, item := range existing {
			if _, err := os.Stat(item.path); err == nil {
				if err := os.Rename(item.path, filepath.Join(recovery, item.name)); err != nil {
					return recovery, err
				}
			}
		}
	}
	if err := os.Rename(filepath.Join(working, "teamtaler.db"), databasePath); err != nil {
		return recovery, err
	}
	if _, err := os.Stat(filepath.Join(working, "images")); err == nil {
		if err := os.Rename(filepath.Join(working, "images"), filepath.Join(dataDirectory, "images")); err != nil {
			return recovery, err
		}
	}
	return recovery, nil
}

func extractValidated(archivePath, destination string) error {
	file, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer file.Close()
	gzipReader, err := gzip.NewReader(io.LimitReader(file, maxRestoreBytes))
	if err != nil {
		return fmt.Errorf("open backup compression: %w", err)
	}
	defer gzipReader.Close()
	tarReader := tar.NewReader(gzipReader)
	var total int64
	extracted := make(map[string]struct{})
	for {
		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("read backup: %w", err)
		}
		if header.Typeflag != tar.TypeReg || header.Size < 0 {
			return errors.New("backup contains an unsupported entry")
		}
		name := filepath.ToSlash(filepath.Clean(header.Name))
		if name == "." || strings.HasPrefix(name, "/") || strings.HasPrefix(name, "../") || (name != "teamtaler.db" && name != "manifest.json" && !strings.HasPrefix(name, "images/")) {
			return fmt.Errorf("backup contains unsafe path %q", header.Name)
		}
		extracted[name] = struct{}{}
		total += header.Size
		if total > maxRestoreBytes {
			return errors.New("expanded backup exceeds 2 GiB")
		}
		path := filepath.Join(destination, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			return err
		}
		output, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o640)
		if err != nil {
			return err
		}
		_, copyErr := io.CopyN(output, tarReader, header.Size)
		closeErr := output.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	manifestBody, err := os.ReadFile(filepath.Join(destination, "manifest.json"))
	if err != nil {
		return errors.New("backup does not contain manifest.json")
	}
	var manifest Manifest
	if err := json.Unmarshal(manifestBody, &manifest); err != nil || manifest.FormatVersion != 1 {
		return errors.New("backup manifest is invalid or unsupported")
	}
	if _, ok := manifest.Files["teamtaler.db"]; !ok {
		return errors.New("backup manifest does not include teamtaler.db")
	}
	if _, err := time.Parse(time.RFC3339Nano, manifest.CreatedAt); err != nil {
		return errors.New("backup manifest creation time is invalid")
	}
	for name := range extracted {
		if name == "manifest.json" {
			continue
		}
		if _, ok := manifest.Files[name]; !ok {
			return fmt.Errorf("backup contains unhashed file %s", name)
		}
	}
	for name, expected := range manifest.Files {
		clean := filepath.ToSlash(filepath.Clean(name))
		if name != clean || name == "manifest.json" || strings.HasPrefix(name, "/") || strings.HasPrefix(name, "../") || (name != "teamtaler.db" && !strings.HasPrefix(name, "images/")) {
			return errors.New("backup manifest contains an unsafe path")
		}
		if _, ok := extracted[name]; !ok {
			return fmt.Errorf("backup manifest references missing file %s", name)
		}
		actual, err := fileDigest(filepath.Join(destination, filepath.FromSlash(name)))
		if err != nil || actual != expected {
			return fmt.Errorf("backup checksum mismatch for %s", name)
		}
		if strings.HasPrefix(name, "images/") {
			base := strings.TrimSuffix(filepath.Base(name), ".png")
			if len(base) != 64 || actual != base {
				return fmt.Errorf("image %s does not match its content address", name)
			}
			if _, err := hex.DecodeString(base); err != nil {
				return fmt.Errorf("image %s has an invalid content address", name)
			}
		}
	}
	return validateRestoredDatabase(destination, manifest)
}

func validateRestoredDatabase(destination string, manifest Manifest) error {
	path := filepath.Join(destination, "teamtaler.db")
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro&_pragma=foreign_keys(1)")
	if err != nil {
		return err
	}
	defer db.Close()
	var integrity string
	if err := db.QueryRow(`PRAGMA integrity_check`).Scan(&integrity); err != nil {
		return fmt.Errorf("restored database integrity check failed: %w", err)
	}
	if integrity != "ok" {
		return fmt.Errorf("restored database integrity check failed: %s", integrity)
	}
	foreignKeys, err := db.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		return fmt.Errorf("restored database foreign-key check failed: %w", err)
	}
	if foreignKeys.Next() {
		foreignKeys.Close()
		return errors.New("restored database contains foreign-key violations")
	}
	if err := foreignKeys.Close(); err != nil {
		return err
	}
	embeddedEntries, err := migrations.Files.ReadDir(".")
	if err != nil {
		return err
	}
	embedded := make(map[string]struct{})
	for _, entry := range embeddedEntries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			embedded[entry.Name()] = struct{}{}
		}
	}
	migrationRows, err := db.Query(`SELECT version FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("restored database has no compatible migration history: %w", err)
	}
	for migrationRows.Next() {
		var version string
		if err := migrationRows.Scan(&version); err != nil {
			migrationRows.Close()
			return err
		}
		if _, ok := embedded[version]; !ok {
			migrationRows.Close()
			return fmt.Errorf("restored database migration %q is not supported by this binary", version)
		}
	}
	if err := migrationRows.Close(); err != nil {
		return err
	}
	referenced := make(map[string]struct{})
	imageRows, err := db.Query(`SELECT DISTINCT image_key FROM products WHERE image_key IS NOT NULL`)
	if err != nil {
		return err
	}
	for imageRows.Next() {
		var key string
		if err := imageRows.Scan(&key); err != nil {
			imageRows.Close()
			return err
		}
		name := "images/" + key
		if _, ok := manifest.Files[name]; !ok {
			imageRows.Close()
			return fmt.Errorf("referenced image %s is missing from backup manifest", key)
		}
		referenced[name] = struct{}{}
	}
	if err := imageRows.Close(); err != nil {
		return err
	}
	for name := range manifest.Files {
		if strings.HasPrefix(name, "images/") {
			if _, ok := referenced[name]; !ok {
				return fmt.Errorf("backup contains unreferenced image %s", name)
			}
		}
	}
	return nil
}

func addFile(writer *tar.Writer, name, path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0o640, Size: info.Size(), ModTime: time.Unix(0, 0)}); err != nil {
		return err
	}
	_, err = io.Copy(writer, file)
	return err
}

func addBytes(writer *tar.Writer, name string, body []byte, mode int64) error {
	if err := writer.WriteHeader(&tar.Header{Name: name, Mode: mode, Size: int64(len(body)), ModTime: time.Unix(0, 0)}); err != nil {
		return err
	}
	_, err := writer.Write(body)
	return err
}

func fileDigest(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}
