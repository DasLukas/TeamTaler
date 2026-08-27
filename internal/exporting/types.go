// Package exporting creates privacy-scoped, asynchronous raw-data export archives.
package exporting

import (
	"context"
	"errors"
	"io"
	"time"
)

const (
	// DefaultRetention is the period for which a completed archive remains downloadable.
	DefaultRetention = 24 * time.Hour
	// DefaultLeaseDuration bounds ownership of one worker attempt.
	DefaultLeaseDuration = 11 * time.Minute
	// DefaultGenerationTimeout bounds one consistent database projection.
	DefaultGenerationTimeout = 10 * time.Minute
	// DefaultMaxArtifactBytes prevents unexpectedly large derived copies of sensitive data.
	DefaultMaxArtifactBytes int64 = 512 << 20
	// DefaultHourlyStarts limits repeated expensive export creation per actor and scope.
	DefaultHourlyStarts = 5
)

// Terminal reports whether status represents a completed lifecycle state that
// requires no worker lease. It returns false for queued and running jobs.
func (status Status) Terminal() bool {
	return status == StatusReady || status == StatusFailed || status == StatusCancelled || status == StatusExpired
}

var (
	// ErrNoPendingJob means that a worker currently has no eligible work.
	ErrNoPendingJob = errors.New("no pending export job")
	// ErrArtifactLimit means that archive generation exceeded its configured byte limit.
	ErrArtifactLimit = errors.New("export artifact size limit exceeded")
	// ErrArtifactUnavailable means that a READY job has no readable published artifact.
	ErrArtifactUnavailable = errors.New("export artifact is unavailable")
)

// Scope identifies the authorized data boundary represented by an archive.
type Scope string

const (
	// ScopeGroup contains structured data belonging to one administrated group.
	ScopeGroup Scope = "GROUP"
	// ScopePersonal contains only the requesting user's data in one current group.
	ScopePersonal Scope = "PERSONAL"
)

// Valid reports whether scope is accepted by the raw-data export service.
func (scope Scope) Valid() bool { return scope == ScopeGroup || scope == ScopePersonal }

// Status identifies the durable lifecycle state of one export job.
type Status string

const (
	// StatusQueued is waiting for a worker lease.
	StatusQueued Status = "QUEUED"
	// StatusRunning is owned by a worker until its lease expires.
	StatusRunning Status = "RUNNING"
	// StatusReady has a complete, verified artifact.
	StatusReady Status = "READY"
	// StatusFailed ended without publishing an artifact.
	StatusFailed Status = "FAILED"
	// StatusCancelled was explicitly cancelled or lost authorization.
	StatusCancelled Status = "CANCELLED"
	// StatusExpired had its artifact removed after retention elapsed.
	StatusExpired Status = "EXPIRED"
)

// Progress describes dataset-level generation progress.
type Progress struct {
	Completed int `json:"completed"`
	Total     int `json:"total"`
}

// Job is the safe public representation of one actor-owned export job.
type Job struct {
	ID          string    `json:"id"`
	Scope       Scope     `json:"scope"`
	Status      Status    `json:"status"`
	RequestedAt string    `json:"requestedAt"`
	StartedAt   string    `json:"startedAt,omitempty"`
	CompletedAt string    `json:"completedAt,omitempty"`
	ExpiresAt   string    `json:"expiresAt,omitempty"`
	SizeBytes   string    `json:"sizeBytes,omitempty"`
	SHA256      string    `json:"sha256,omitempty"`
	Progress    *Progress `json:"progress,omitempty"`
	DownloadURL string    `json:"downloadUrl,omitempty"`
	ErrorCode   string    `json:"errorCode,omitempty"`
}

// CreateInput contains a fully authenticated request for a new raw-data archive.
// CurrentPassword is consumed only by PasswordVerifier and is never persisted.
type CreateInput struct {
	GroupID         string
	MembershipID    string
	UserID          string
	Scope           Scope
	CurrentPassword string
	IdempotencyKey  string
}

// PasswordVerifier reauthenticates an active local account before export creation.
type PasswordVerifier interface {
	VerifyCurrentPassword(ctx context.Context, userID, password string) error
}

// Completion describes one terminal worker result for integration with in-app notifications.
type Completion struct {
	JobID        string
	GroupID      string
	MembershipID string
	UserID       string
	Scope        Scope
	Status       Status
	ErrorCode    string
}

// CompletionListener receives READY and FAILED outcomes after their database state commits.
// Implementations must be idempotent because a process can stop after commit but before return.
type CompletionListener interface {
	ExportCompleted(ctx context.Context, completion Completion) error
}

// Download owns a verified archive stream and its response metadata.
type Download struct {
	Reader       io.ReadCloser
	SizeBytes    int64
	SHA256       string
	Filename     string
	LastModified time.Time
}
