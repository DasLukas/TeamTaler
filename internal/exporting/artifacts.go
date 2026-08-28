package exporting

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var safeJobID = regexp.MustCompile(`^[A-Za-z0-9_-]{8,160}$`)
var safeAttemptDigest = regexp.MustCompile(`^[0-9a-f]{32}$`)

// ArtifactStore publishes and opens export archives without exposing filesystem paths.
type ArtifactStore interface {
	CreateTemporary(jobID string) (*os.File, error)
	Publish(jobID, leaseToken, temporaryPath string) (string, error)
	Open(artifactName string) (*os.File, error)
	Remove(artifactName string) error
	Reconcile(retained map[string]struct{}, staleBefore time.Time) (int, error)
}

// FileArtifactStore stores export artifacts in a private directory on one filesystem.
type FileArtifactStore struct {
	directory string
}

// NewFileArtifactStore creates a filesystem-backed store rooted below dataDirectory.
// The directory is created with owner-only permissions. It returns a configuration or
// filesystem error. Example: NewFileArtifactStore("data/exports").
func NewFileArtifactStore(dataDirectory string) (*FileArtifactStore, error) {
	dataDirectory = strings.TrimSpace(dataDirectory)
	if dataDirectory == "" {
		return nil, errors.New("artifact directory is required")
	}
	abs, err := filepath.Abs(dataDirectory)
	if err != nil {
		return nil, fmt.Errorf("resolve artifact directory: %w", err)
	}
	if err := os.MkdirAll(abs, 0o700); err != nil {
		return nil, fmt.Errorf("create artifact directory: %w", err)
	}
	if err := os.Chmod(abs, 0o700); err != nil {
		return nil, fmt.Errorf("protect artifact directory: %w", err)
	}
	return &FileArtifactStore{directory: abs}, nil
}

// CreateTemporary creates an owner-readable temporary file for jobID in the publish directory.
func (store *FileArtifactStore) CreateTemporary(jobID string) (*os.File, error) {
	if store == nil || !safeJobID.MatchString(jobID) {
		return nil, errors.New("invalid export job identifier")
	}
	file, err := os.CreateTemp(store.directory, "."+jobID+"-*.tmp")
	if err != nil {
		return nil, fmt.Errorf("create temporary export artifact: %w", err)
	}
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		os.Remove(file.Name())
		return nil, fmt.Errorf("protect temporary export artifact: %w", err)
	}
	return file, nil
}

// Publish atomically renames a completed temporary file to a lease-fenced ZIP
// name. The opaque lease token prevents an obsolete worker from deleting a
// newer attempt's artifact for the same job.
func (store *FileArtifactStore) Publish(jobID, leaseToken, temporaryPath string) (string, error) {
	if store == nil || !safeJobID.MatchString(jobID) || leaseToken == "" {
		return "", errors.New("invalid export job identifier")
	}
	cleanTemporary := filepath.Clean(temporaryPath)
	if filepath.Dir(cleanTemporary) != store.directory {
		return "", errors.New("temporary artifact is outside the export directory")
	}
	name := artifactNameFor(jobID, leaseToken)
	destination := filepath.Join(store.directory, name)
	if err := os.Rename(cleanTemporary, destination); err != nil {
		return "", fmt.Errorf("publish export artifact: %w", err)
	}
	return name, nil
}

// Reconcile removes stale temporary files and unreferenced lease-fenced ZIPs.
// retained contains the exact artifact names of READY jobs. Files newer than
// staleBefore are left untouched so an active publish can finish safely.
func (store *FileArtifactStore) Reconcile(retained map[string]struct{}, staleBefore time.Time) (int, error) {
	if store == nil {
		return 0, errors.New("artifact store is unavailable")
	}
	entries, err := os.ReadDir(store.directory)
	if err != nil {
		return 0, fmt.Errorf("list export artifacts: %w", err)
	}
	removed := 0
	var combined error
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		name := entry.Name()
		candidate := strings.HasSuffix(name, ".tmp") || validArtifactName(name)
		if !candidate {
			continue
		}
		if _, keep := retained[name]; keep {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			combined = errors.Join(combined, infoErr)
			continue
		}
		if !info.ModTime().Before(staleBefore) {
			continue
		}
		if removeErr := os.Remove(filepath.Join(store.directory, name)); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			combined = errors.Join(combined, removeErr)
			continue
		}
		removed++
	}
	return removed, combined
}

// Open opens one published archive after validating its opaque filename.
func (store *FileArtifactStore) Open(artifactName string) (*os.File, error) {
	if store == nil || !validArtifactName(artifactName) {
		return nil, ErrArtifactUnavailable
	}
	file, err := os.Open(filepath.Join(store.directory, artifactName))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrArtifactUnavailable
		}
		return nil, fmt.Errorf("open export artifact: %w", err)
	}
	return file, nil
}

// Remove deletes one published archive. Missing artifacts are treated as already removed.
func (store *FileArtifactStore) Remove(artifactName string) error {
	if store == nil || !validArtifactName(artifactName) {
		return ErrArtifactUnavailable
	}
	err := os.Remove(filepath.Join(store.directory, artifactName))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("remove export artifact: %w", err)
	}
	return nil
}

func validArtifactName(name string) bool {
	if !strings.HasSuffix(name, ".zip") || filepath.Base(name) != name {
		return false
	}
	base := strings.TrimSuffix(name, ".zip")
	separator := strings.LastIndexByte(base, '-')
	if separator < 0 {
		return false
	}
	return safeJobID.MatchString(base[:separator]) && safeAttemptDigest.MatchString(base[separator+1:])
}

func artifactNameFor(jobID, leaseToken string) string {
	digest := sha256.Sum256([]byte(leaseToken))
	return jobID + "-" + hex.EncodeToString(digest[:16]) + ".zip"
}

type limitedWriter struct {
	writer io.Writer
	limit  int64
	wrote  int64
}

func (writer *limitedWriter) Write(value []byte) (int, error) {
	if writer.wrote+int64(len(value)) > writer.limit {
		return 0, ErrArtifactLimit
	}
	written, err := writer.writer.Write(value)
	writer.wrote += int64(written)
	return written, err
}
