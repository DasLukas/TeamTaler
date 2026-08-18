package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/config"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
	systemadmin "github.com/DasLukas/TeamTaler/internal/system"
)

func TestReadBootstrapPasswordFromNonTerminal(t *testing.T) {
	input, err := os.CreateTemp(t.TempDir(), "bootstrap-stdin-*")
	if err != nil {
		t.Fatalf("create input: %v", err)
	}
	defer input.Close()
	if _, err := input.WriteString("pipe-safe-password-long\nignored\n"); err != nil {
		t.Fatalf("write input: %v", err)
	}
	if _, err := input.Seek(0, 0); err != nil {
		t.Fatalf("rewind input: %v", err)
	}
	var output bytes.Buffer
	password, err := readBootstrapPassword(input, &output)
	if err != nil {
		t.Fatalf("readBootstrapPassword: %v", err)
	}
	if password != "pipe-safe-password-long" {
		t.Fatalf("password = %q", password)
	}
	if output.Len() != 0 {
		t.Fatalf("non-terminal prompt output = %q", output.String())
	}
}

func TestReadAdminSecretPreservesSignificantWhitespace(t *testing.T) {
	input, err := os.CreateTemp(t.TempDir(), "secret-stdin-*")
	if err != nil {
		t.Fatalf("create input: %v", err)
	}
	defer input.Close()
	if _, err := input.WriteString(" leading-and-trailing-secret \r\n"); err != nil {
		t.Fatalf("write input: %v", err)
	}
	if _, err := input.Seek(0, 0); err != nil {
		t.Fatalf("rewind input: %v", err)
	}
	secret, err := readAdminSecret(input, &bytes.Buffer{}, "Secret: ")
	if err != nil {
		t.Fatalf("readAdminSecret: %v", err)
	}
	if secret != " leading-and-trailing-secret " {
		t.Fatalf("secret = %q", secret)
	}
}

func TestAdminBootstrapRejectsPasswordArgument(t *testing.T) {
	err := adminBootstrap([]string{"--password", "must-not-appear-in-process-arguments"})
	if err == nil || !strings.Contains(err.Error(), "flag provided but not defined") {
		t.Fatalf("adminBootstrap error=%v, want rejected password flag", err)
	}
}

func TestLocalSystemActorRequiresSelectionWhenMultipleAdministratorsExist(t *testing.T) {
	ctx := context.Background()
	database, err := storage.Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer database.Close()
	authentication := auth.Service{DB: database, SessionLifetime: 24 * time.Hour}
	if err := authentication.Bootstrap(ctx, "first@example.test", "First", "correct-horse-battery-staple", "Initial", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	secondHash, err := auth.HashPassword("another-correct-password")
	if err != nil {
		t.Fatalf("hash second password: %v", err)
	}
	secondID, _ := platform.NewID("usr")
	now := platform.Timestamp(platform.Now())
	if _, err := database.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)`, secondID, "second@example.test", "Second", secondHash, now, now); err != nil {
		t.Fatalf("insert second administrator account: %v", err)
	}
	service, err := systemadmin.NewService(database, systemadmin.Defaults{
		InstanceName: "TeamTaler", DefaultCurrency: "EUR", MediaUploadMaxBytes: config.DefaultMediaUploadBytes,
		PublicJoinEnabled: true, MaxRequestBytes: 6 << 20,
	}, nil)
	if err != nil {
		t.Fatalf("new system service: %v", err)
	}
	var firstID string
	if err := database.QueryRowContext(ctx, `SELECT id FROM users WHERE email='first@example.test'`).Scan(&firstID); err != nil {
		t.Fatalf("load first administrator: %v", err)
	}
	if _, err := service.GrantAdministratorByEmail(ctx, "second@example.test", firstID); err != nil {
		t.Fatalf("grant second administrator: %v", err)
	}
	if _, err := localSystemActor(ctx, service, ""); err == nil || !strings.Contains(err.Error(), "multiple active") {
		t.Fatalf("ambiguous local actor error=%v", err)
	}
	selected, err := localSystemActor(ctx, service, "SECOND@example.test")
	if err != nil {
		t.Fatalf("select explicit local actor: %v", err)
	}
	if selected.UserID != secondID {
		t.Fatalf("selected user=%q, want %q", selected.UserID, secondID)
	}
}

func TestAdminBootstrapGrantsSystemAdministratorAndCLIListsIt(t *testing.T) {
	directory := t.TempDir()
	databasePath := filepath.Join(directory, "teamtaler.db")
	t.Setenv("TEAMTALER_DATA_DIR", directory)
	t.Setenv("TEAMTALER_DATABASE_PATH", databasePath)
	t.Setenv("TEAMTALER_WEB_DIR", directory)
	t.Setenv("TEAMTALER_PUBLIC_URL", "http://localhost:8080")
	t.Setenv("TEAMTALER_MAX_REQUEST_BYTES", "6291456")
	for _, name := range []string{
		"TEAMTALER_SMTP_HOST", "TEAMTALER_SMTP_PORT", "TEAMTALER_SMTP_USERNAME", "TEAMTALER_SMTP_PASSWORD",
		"TEAMTALER_SMTP_FROM_ADDRESS", "TEAMTALER_SMTP_FROM_NAME", "TEAMTALER_SMTP_TLS_MODE", "TEAMTALER_EMAIL_TOKEN_KEY",
	} {
		t.Setenv(name, "")
	}
	passwordInput, err := os.CreateTemp(t.TempDir(), "bootstrap-password-*")
	if err != nil {
		t.Fatalf("create password input: %v", err)
	}
	defer passwordInput.Close()
	if _, err := passwordInput.WriteString("correct-horse-battery-staple\n"); err != nil {
		t.Fatalf("write password input: %v", err)
	}
	if _, err := passwordInput.Seek(0, 0); err != nil {
		t.Fatalf("rewind password input: %v", err)
	}
	previousInput := os.Stdin
	os.Stdin = passwordInput
	defer func() { os.Stdin = previousInput }()
	if err := adminBootstrap([]string{"--email", "admin@example.test", "--display-name", "Admin", "--group", "Initial"}); err != nil {
		t.Fatalf("admin bootstrap: %v", err)
	}
	database, err := storage.Open(context.Background(), databasePath)
	if err != nil {
		t.Fatalf("open bootstrapped database: %v", err)
	}
	var assignments int
	if err := database.QueryRow(`SELECT count(*) FROM system_role_assignments WHERE role='SYSTEM_ADMINISTRATOR'`).Scan(&assignments); err != nil {
		database.Close()
		t.Fatalf("count system administrators: %v", err)
	}
	database.Close()
	if assignments != 1 {
		t.Fatalf("system administrator assignments=%d", assignments)
	}

	output, err := os.CreateTemp(t.TempDir(), "admin-list-*.json")
	if err != nil {
		t.Fatalf("create output: %v", err)
	}
	defer output.Close()
	previousOutput := os.Stdout
	os.Stdout = output
	defer func() { os.Stdout = previousOutput }()
	if err := systemAdministratorCommand([]string{"list", "--json"}); err != nil {
		t.Fatalf("system-admin list: %v", err)
	}
	if _, err := output.Seek(0, 0); err != nil {
		t.Fatalf("rewind output: %v", err)
	}
	encoded, err := os.ReadFile(output.Name())
	if err != nil {
		t.Fatalf("read output: %v", err)
	}
	if !strings.Contains(string(encoded), "SYSTEM_ADMINISTRATOR") || !strings.Contains(string(encoded), "admin@example.test") {
		t.Fatalf("unexpected JSON output: %s", encoded)
	}
}
