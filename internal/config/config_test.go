package config

import (
	"path/filepath"
	"testing"
)

func TestLoadRejectsPublicURLSubpathsAndCredentials(t *testing.T) {
	invalid := []string{
		"https://example.test/teamtaler",
		"https://user:password@example.test/",
		"https://example.test/?tenant=one",
		"https://example.test/#fragment",
		"http://teamtaler.example.test/",
		"http://192.0.2.10:8080/",
	}
	for _, value := range invalid {
		t.Run(value, func(t *testing.T) {
			t.Setenv("TEAMTALER_PUBLIC_URL", value)
			if _, err := Load(); err == nil {
				t.Fatalf("invalid public URL %q was accepted", value)
			}
		})
	}
}

func TestLoadAllowsHTTPOnlyForLoopback(t *testing.T) {
	for _, value := range []string{"http://localhost:8080/", "http://127.0.0.1:8080/", "http://[::1]:8080/"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("TEAMTALER_PUBLIC_URL", value)
			loaded, err := Load()
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if loaded.SecureCookies {
				t.Fatal("loopback HTTP unexpectedly enabled secure cookies")
			}
		})
	}
}

func TestLoadAcceptsRootPublicURL(t *testing.T) {
	t.Setenv("TEAMTALER_PUBLIC_URL", "https://teamtaler.example.test/")
	loaded, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !loaded.SecureCookies {
		t.Fatal("HTTPS public URL did not enable secure cookies")
	}
}

func TestLoadRequiresDatabaseDirectlyInsideDataDirectory(t *testing.T) {
	dataDirectory := t.TempDir()
	t.Setenv("TEAMTALER_DATA_DIR", dataDirectory)
	for _, path := range []string{filepath.Join(dataDirectory, "nested", "teamtaler.db"), filepath.Join(t.TempDir(), "teamtaler.db")} {
		t.Run(path, func(t *testing.T) {
			t.Setenv("TEAMTALER_DATABASE_PATH", path)
			if _, err := Load(); err == nil {
				t.Fatalf("database path %q outside direct data-directory children was accepted", path)
			}
		})
	}
	t.Setenv("TEAMTALER_DATABASE_PATH", filepath.Join(dataDirectory, "custom.sqlite"))
	if _, err := Load(); err != nil {
		t.Fatalf("direct child database path was rejected: %v", err)
	}
}
