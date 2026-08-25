package exporting

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

const exportTestPassword = "correct-horse-battery-staple"

type completionRecorder struct {
	mu          sync.Mutex
	completions []Completion
}

func (recorder *completionRecorder) ExportCompleted(_ context.Context, completion Completion) error {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	recorder.completions = append(recorder.completions, completion)
	return nil
}

func TestGroupExportProducesSafeCompleteArchive(t *testing.T) {
	ctx := context.Background()
	db, groupID, membershipID, userID := exportFixture(t)
	defer db.Close()
	const invitationSecret = "never-export-this-token-hash"
	const auditPassword = "never-export-this-password"
	now := platform.Timestamp(platform.Now())
	if _, err := db.ExecContext(ctx, `INSERT INTO invitations(
		id,group_id,email,token_hash,expires_at,created_by,created_at
	) VALUES('inv_export','`+groupID+`','invitee@example.test',?,'2099-01-01T00:00:00Z',?,?)`, invitationSecret, userID, now); err != nil {
		t.Fatalf("insert invitation fixture: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO audit_events(
		id,group_id,actor_user_id,actor_membership_id,action,resource_type,metadata_json,occurred_at
	) VALUES('aud_export',?,?,?,'fixture.created','fixture',?,?)`, groupID, userID, membershipID,
		`{"password":"`+auditPassword+`","safe":"retained"}`, now); err != nil {
		t.Fatalf("insert audit fixture: %v", err)
	}

	recorder := &completionRecorder{}
	service := newExportTestService(t, db, recorder)
	job, err := service.Create(ctx, CreateInput{GroupID: groupID, MembershipID: membershipID, UserID: userID,
		Scope: ScopeGroup, CurrentPassword: exportTestPassword, IdempotencyKey: "group-export-key-0001"})
	if err != nil {
		t.Fatalf("create group export: %v", err)
	}
	if job.Status != StatusQueued || job.Progress == nil || job.Progress.Total != len(groupDatasets) {
		t.Fatalf("queued job = %#v", job)
	}
	completed, err := service.ProcessNext(ctx)
	if err != nil {
		t.Fatalf("process group export: %v", err)
	}
	if completed.Status != StatusReady || completed.SHA256 == "" || completed.SizeBytes == "" {
		t.Fatalf("completed job = %#v", completed)
	}
	download, err := service.OpenDownload(ctx, userID, job.ID)
	if err != nil {
		t.Fatalf("open group export: %v", err)
	}
	archiveBytes, err := io.ReadAll(download.Reader)
	download.Reader.Close()
	if err != nil {
		t.Fatalf("read group export: %v", err)
	}
	if bytes.Contains(archiveBytes, []byte(invitationSecret)) || bytes.Contains(archiveBytes, []byte(auditPassword)) || bytes.Contains(archiveBytes, []byte(exportTestPassword)) {
		t.Fatal("archive contains a credential or token")
	}
	entries := readArchiveEntries(t, archiveBytes)
	decompressed := bytes.Join(mapValues(entries), nil)
	if bytes.Contains(decompressed, []byte(invitationSecret)) || bytes.Contains(decompressed, []byte(auditPassword)) || bytes.Contains(decompressed, []byte(exportTestPassword)) {
		t.Fatal("decompressed archive contains a credential or token")
	}
	for _, required := range []string{
		"manifest.json", "schema.json", "data/group.csv", "data/audit_events.csv", "data/payment_attachments.csv",
		"data/public_join_link.csv", "data/public_join_registrations.csv", "data/notifications.csv",
		"data/legacy_membership_roles.csv", "data/legacy_membership_permissions.csv", "data/legacy_category_permissions.csv",
	} {
		if _, found := entries[required]; !found {
			t.Fatalf("archive is missing %s", required)
		}
	}
	if !strings.Contains(string(entries["data/audit_events.csv"]), "retained") {
		t.Fatal("safe audit metadata was not retained")
	}
	if strings.Contains(string(entries["data/audit_events.csv"]), "password") {
		t.Fatal("sensitive audit metadata key was retained")
	}
	if !strings.Contains(string(entries["data/bookings.csv"]), "currency") || !strings.Contains(string(entries["data/payments.csv"]), "currency") {
		t.Fatal("money datasets do not identify their currency")
	}
	if len(recorder.completions) != 1 || recorder.completions[0].Status != StatusReady {
		t.Fatalf("completion callbacks = %#v", recorder.completions)
	}
}

func TestPersonalExportAuthorizationPasswordAndIdempotency(t *testing.T) {
	ctx := context.Background()
	db, groupID, membershipID, userID := exportFixture(t)
	defer db.Close()
	service := newExportTestService(t, db, nil)
	input := CreateInput{GroupID: groupID, MembershipID: membershipID, UserID: userID,
		Scope: ScopePersonal, CurrentPassword: exportTestPassword, IdempotencyKey: "personal-export-key-0001"}
	first, err := service.Create(ctx, input)
	if err != nil {
		t.Fatalf("create personal export: %v", err)
	}
	replayed, err := service.Create(ctx, input)
	if err != nil || replayed.ID != first.ID {
		t.Fatalf("idempotency replay = %#v, %v; want %s", replayed, err, first.ID)
	}
	wrong := input
	wrong.IdempotencyKey = "personal-export-key-wrong"
	wrong.CurrentPassword = "not-the-current-password"
	if _, err := service.Create(ctx, wrong); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("wrong password error = %v, want ErrUnauthenticated", err)
	}
	completed, err := service.ProcessNext(ctx)
	if err != nil || completed.Status != StatusReady {
		t.Fatalf("process personal export = %#v, %v", completed, err)
	}
	download, err := service.OpenDownload(ctx, userID, first.ID)
	if err != nil {
		t.Fatalf("open personal export: %v", err)
	}
	content, err := io.ReadAll(download.Reader)
	download.Reader.Close()
	if err != nil {
		t.Fatal(err)
	}
	entries := readArchiveEntries(t, content)
	if _, found := entries["data/profile.csv"]; !found {
		t.Fatal("personal archive is missing profile.csv")
	}
	if _, found := entries["data/invitations.csv"]; found {
		t.Fatal("personal archive contains group-administrator invitations.csv")
	}
	for _, required := range []string{"data/payment_allocations.csv", "data/period_adjustment_allocations.csv"} {
		if _, found := entries[required]; !found {
			t.Fatalf("personal archive is missing %s", required)
		}
	}
}

func TestGenerateArchiveReportsDatasetProgressInOrder(t *testing.T) {
	ctx := context.Background()
	db, groupID, membershipID, userID := exportFixture(t)
	defer db.Close()
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	progress := make([]int, 0, len(personalDatasets))
	err = generateArchive(ctx, tx, io.Discard, jobRecord{Job: Job{Scope: ScopePersonal}, GroupID: groupID,
		MembershipID: membershipID, UserID: userID}, platform.Now(), DefaultMaxArtifactBytes, func(completed int) error {
		progress = append(progress, completed)
		return nil
	})
	if err != nil {
		t.Fatalf("generate personal archive: %v", err)
	}
	if len(progress) != len(personalDatasets) {
		t.Fatalf("progress updates = %v, want %d updates", progress, len(personalDatasets))
	}
	for index, completed := range progress {
		if completed != index+1 {
			t.Fatalf("progress update %d = %d, want %d", index, completed, index+1)
		}
	}
}

func TestExportValuePreservesNegativeNumbersAndProtectsText(t *testing.T) {
	if got := exportValue("amount_minor", int64(-123)); got != "-123" {
		t.Fatalf("negative amount = %q, want -123", got)
	}
	if got := exportValue("display_name", "-123"); got != "'-123" {
		t.Fatalf("text beginning with a formula marker = %q, want spreadsheet protection", got)
	}
}

func TestGroupExportRequiresCurrentAdministrationPermission(t *testing.T) {
	ctx := context.Background()
	db, groupID, _, _ := exportFixture(t)
	defer db.Close()
	passwordHash, err := auth.HashPassword("ordinary-member-password")
	if err != nil {
		t.Fatal(err)
	}
	now := platform.Timestamp(platform.Now())
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('usr_ordinary','ordinary@example.test','Ordinary',?,?,?)`, []any{passwordHash, now, now}},
		{`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('mem_ordinary',?,'usr_ordinary','ACTIVE',?)`, []any{groupID, now}},
		{`INSERT INTO membership_role_assignments(group_id,membership_id,role_id,assigned_at) VALUES(?,'mem_ordinary',?,'` + now + `')`, []any{groupID, "role:MEMBER:" + groupID}},
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("prepare ordinary member: %v", err)
		}
	}
	service := newExportTestService(t, db, nil)
	_, err = service.Create(ctx, CreateInput{GroupID: groupID, MembershipID: "mem_ordinary", UserID: "usr_ordinary",
		Scope: ScopeGroup, CurrentPassword: "ordinary-member-password", IdempotencyKey: "ordinary-group-export"})
	if !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("group export error = %v, want ErrForbidden", err)
	}
}

func TestGenerationLimitFailsAtomicallyAndNotifies(t *testing.T) {
	ctx := context.Background()
	db, groupID, membershipID, userID := exportFixture(t)
	defer db.Close()
	store, err := NewFileArtifactStore(filepath.Join(t.TempDir(), "exports"))
	if err != nil {
		t.Fatal(err)
	}
	recorder := &completionRecorder{}
	service, err := NewService(db, store, Options{MaxArtifactBytes: 1, CompletionListener: recorder})
	if err != nil {
		t.Fatal(err)
	}
	queued, err := service.Create(ctx, CreateInput{GroupID: groupID, MembershipID: membershipID, UserID: userID,
		Scope: ScopePersonal, CurrentPassword: exportTestPassword, IdempotencyKey: "limited-personal-export"})
	if err != nil {
		t.Fatal(err)
	}
	failed, processErr := service.ProcessNext(ctx)
	if processErr == nil || failed.Status != StatusFailed || failed.ErrorCode != "artifact_limit_exceeded" {
		t.Fatalf("failed job = %#v, error = %v", failed, processErr)
	}
	stored, err := service.Get(ctx, userID, queued.ID)
	if err != nil || stored.Status != StatusFailed {
		t.Fatalf("stored failed job = %#v, %v", stored, err)
	}
	if _, err := service.OpenDownload(ctx, userID, queued.ID); !errors.Is(err, domain.ErrPrecondition) {
		t.Fatalf("failed download error = %v, want ErrPrecondition", err)
	}
	if len(recorder.completions) != 1 || recorder.completions[0].Status != StatusFailed {
		t.Fatalf("failure callbacks = %#v", recorder.completions)
	}
	redispatched, err := service.DispatchPendingCompletions(ctx, 10)
	if err != nil || redispatched != 0 {
		t.Fatalf("acknowledged callback dispatch = %d, %v", redispatched, err)
	}
}

func TestRunContinuesAfterAJobFails(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	db, groupID, membershipID, userID := exportFixture(t)
	defer db.Close()
	store, err := NewFileArtifactStore(filepath.Join(t.TempDir(), "exports"))
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(db, store, Options{MaxArtifactBytes: 1})
	if err != nil {
		t.Fatal(err)
	}
	for _, request := range []CreateInput{
		{GroupID: groupID, MembershipID: membershipID, UserID: userID, Scope: ScopePersonal,
			CurrentPassword: exportTestPassword, IdempotencyKey: "failed-personal-export"},
		{GroupID: groupID, MembershipID: membershipID, UserID: userID, Scope: ScopeGroup,
			CurrentPassword: exportTestPassword, IdempotencyKey: "failed-group-export"},
	} {
		if _, err := service.Create(ctx, request); err != nil {
			t.Fatal(err)
		}
	}
	done := make(chan error, 1)
	go func() { done <- service.Run(ctx, time.Millisecond) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var failed int
		if err := db.QueryRow(`SELECT count(*) FROM export_jobs WHERE status='FAILED'`).Scan(&failed); err != nil {
			t.Fatal(err)
		}
		if failed == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("worker did not continue to the second job after the first job failed")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() error = %v, want context cancellation", err)
	}
}

func TestCancelledClaimCannotBecomeReadyOrFailed(t *testing.T) {
	ctx := context.Background()
	db, groupID, membershipID, userID := exportFixture(t)
	defer db.Close()
	service := newExportTestService(t, db, nil)
	queued, err := service.Create(ctx, CreateInput{GroupID: groupID, MembershipID: membershipID, UserID: userID,
		Scope: ScopePersonal, CurrentPassword: exportTestPassword, IdempotencyKey: "cancel-running-export"})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := service.claimNext(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Remove(ctx, userID, queued.ID); err != nil {
		t.Fatal(err)
	}
	claimed.ArtifactName = artifactNameFor(claimed.ID, claimed.LeaseToken)
	claimed.SHA256 = strings.Repeat("a", 64)
	claimed.SizeBytes = 1
	completed, err := service.completeClaim(ctx, claimed)
	if err != nil || completed.Status != StatusCancelled {
		t.Fatalf("complete cancelled claim = %#v, %v", completed.Job, err)
	}
	failed, err := service.failClaim(ctx, claimed, "generation_failed", errors.New("obsolete worker"))
	if err != nil || failed.Status != StatusCancelled {
		t.Fatalf("fail cancelled claim = %#v, %v", failed, err)
	}
}

func TestRemoveReadyExportDeletesArtifactAndJob(t *testing.T) {
	ctx := context.Background()
	db, groupID, membershipID, userID := exportFixture(t)
	defer db.Close()
	service := newExportTestService(t, db, nil)
	queued, err := service.Create(ctx, CreateInput{GroupID: groupID, MembershipID: membershipID, UserID: userID,
		Scope: ScopePersonal, CurrentPassword: exportTestPassword, IdempotencyKey: "delete-ready-export"})
	if err != nil {
		t.Fatal(err)
	}
	completed, err := service.ProcessNext(ctx)
	if err != nil || completed.Status != StatusReady {
		t.Fatalf("process export = %#v, %v", completed, err)
	}
	record, err := service.getRecord(ctx, userID, queued.ID)
	if err != nil || record.ArtifactName == "" {
		t.Fatalf("ready export record = %#v, %v", record, err)
	}
	artifact, err := service.artifacts.Open(record.ArtifactName)
	if err != nil {
		t.Fatalf("open ready artifact: %v", err)
	}
	artifact.Close()

	if err := service.Remove(ctx, userID, queued.ID); err != nil {
		t.Fatalf("remove ready export: %v", err)
	}
	if _, err := service.Get(ctx, userID, queued.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("get deleted export error = %v, want not found", err)
	}
	if _, err := service.artifacts.Open(record.ArtifactName); !errors.Is(err, ErrArtifactUnavailable) {
		t.Fatalf("open deleted artifact error = %v, want unavailable", err)
	}
	var auditCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM audit_events WHERE action='DATA_EXPORT_DELETED' AND resource_id=?`, queued.ID).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatalf("delete audit count = %d, %v", auditCount, err)
	}
}

func TestExpiredTenthAttemptBecomesTerminalFailure(t *testing.T) {
	ctx := context.Background()
	db, groupID, membershipID, userID := exportFixture(t)
	defer db.Close()
	service := newExportTestService(t, db, nil)
	queued, err := service.Create(ctx, CreateInput{GroupID: groupID, MembershipID: membershipID, UserID: userID,
		Scope: ScopePersonal, CurrentPassword: exportTestPassword, IdempotencyKey: "exhausted-export-attempts"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.claimNext(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE export_jobs SET attempt_count=10,lease_until=? WHERE id=?`,
		platform.Timestamp(platform.Now().Add(-time.Minute)), queued.ID); err != nil {
		t.Fatal(err)
	}
	failed, err := service.ProcessNext(ctx)
	if err != nil || failed.Status != StatusFailed || failed.ErrorCode != "attempts_exhausted" {
		t.Fatalf("exhausted job = %#v, %v", failed, err)
	}
}

func TestArtifactPublishIsLeaseFenced(t *testing.T) {
	store, err := NewFileArtifactStore(filepath.Join(t.TempDir(), "exports"))
	if err != nil {
		t.Fatal(err)
	}
	const jobID = "export-job-fence"
	publish := func(lease, content string) string {
		t.Helper()
		file, createErr := store.CreateTemporary(jobID)
		if createErr != nil {
			t.Fatal(createErr)
		}
		if _, writeErr := file.WriteString(content); writeErr != nil {
			t.Fatal(writeErr)
		}
		if closeErr := file.Close(); closeErr != nil {
			t.Fatal(closeErr)
		}
		name, publishErr := store.Publish(jobID, lease, file.Name())
		if publishErr != nil {
			t.Fatal(publishErr)
		}
		return name
	}
	first := publish("lease-one", "old")
	second := publish("lease-two", "new")
	if first == second {
		t.Fatalf("lease-fenced names are equal: %s", first)
	}
	if err := store.Remove(first); err != nil {
		t.Fatal(err)
	}
	file, err := store.Open(second)
	if err != nil {
		t.Fatalf("open newer artifact after removing older attempt: %v", err)
	}
	content, err := io.ReadAll(file)
	file.Close()
	if err != nil || string(content) != "new" {
		t.Fatalf("newer artifact content = %q, %v", content, err)
	}
}

func TestArtifactReconcileRemovesOnlyStaleUnreferencedFiles(t *testing.T) {
	store, err := NewFileArtifactStore(filepath.Join(t.TempDir(), "exports"))
	if err != nil {
		t.Fatal(err)
	}
	const jobID = "export-reconcile"
	makeArtifact := func(lease string) string {
		t.Helper()
		file, createErr := store.CreateTemporary(jobID)
		if createErr != nil {
			t.Fatal(createErr)
		}
		if closeErr := file.Close(); closeErr != nil {
			t.Fatal(closeErr)
		}
		name, publishErr := store.Publish(jobID, lease, file.Name())
		if publishErr != nil {
			t.Fatal(publishErr)
		}
		return name
	}
	retained := makeArtifact("retained-lease")
	orphan := makeArtifact("orphan-lease")
	temporary, err := store.CreateTemporary(jobID)
	if err != nil {
		t.Fatal(err)
	}
	if err := temporary.Close(); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour)
	for _, name := range []string{retained, orphan, filepath.Base(temporary.Name())} {
		if err := os.Chtimes(filepath.Join(store.directory, name), old, old); err != nil {
			t.Fatal(err)
		}
	}
	removed, err := store.Reconcile(map[string]struct{}{retained: {}}, time.Now().Add(-time.Minute))
	if err != nil || removed != 2 {
		t.Fatalf("reconcile removed %d files: %v", removed, err)
	}
	if _, err := store.Open(retained); err != nil {
		t.Fatalf("retained READY artifact was removed: %v", err)
	}
	if _, err := store.Open(orphan); !errors.Is(err, ErrArtifactUnavailable) {
		t.Fatalf("orphan artifact error = %v, want unavailable", err)
	}
}

func TestFileArtifactStoreRejectsPathTraversal(t *testing.T) {
	store, err := NewFileArtifactStore(filepath.Join(t.TempDir(), "exports"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Open("../secret.zip"); !errors.Is(err, ErrArtifactUnavailable) {
		t.Fatalf("path traversal error = %v", err)
	}
	if _, err := store.CreateTemporary("../job"); err == nil {
		t.Fatal("path traversal job ID was accepted")
	}
}

func exportFixture(t *testing.T) (*sql.DB, string, string, string) {
	t.Helper()
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	authService := auth.Service{DB: db}
	if err := authService.Bootstrap(ctx, "export-admin@example.test", "Export Admin", exportTestPassword, "Export Group", "EUR"); err != nil {
		db.Close()
		t.Fatalf("bootstrap: %v", err)
	}
	var groupID, membershipID, userID string
	if err := db.QueryRowContext(ctx, `SELECT membership.group_id,membership.id,membership.user_id FROM memberships membership
		JOIN users user ON user.id=membership.user_id WHERE user.email='export-admin@example.test'`).Scan(&groupID, &membershipID, &userID); err != nil {
		db.Close()
		t.Fatalf("read export fixture: %v", err)
	}
	return db, groupID, membershipID, userID
}

func newExportTestService(t *testing.T, db *sql.DB, listener CompletionListener) *Service {
	t.Helper()
	store, err := NewFileArtifactStore(filepath.Join(t.TempDir(), "exports"))
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(db, store, Options{CompletionListener: listener, Retention: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func readArchiveEntries(t *testing.T, content []byte) map[string][]byte {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(content), int64(len(content)))
	if err != nil {
		t.Fatalf("open zip: %v", err)
	}
	entries := make(map[string][]byte, len(reader.File))
	for _, file := range reader.File {
		stream, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		value, err := io.ReadAll(stream)
		stream.Close()
		if err != nil {
			t.Fatal(err)
		}
		entries[file.Name] = value
	}
	return entries
}

func mapValues(values map[string][]byte) [][]byte {
	result := make([][]byte, 0, len(values))
	for _, value := range values {
		result = append(result, value)
	}
	return result
}
