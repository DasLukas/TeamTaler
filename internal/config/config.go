// Package config loads and validates TeamTaler runtime configuration.
package config

import (
	"fmt"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config contains validated, immutable process-level configuration.
// Construct it with Load rather than populating fields directly so URL,
// request-size, and proxy trust constraints are enforced.
type Config struct {
	ListenAddress     string
	DatabasePath      string
	DataDirectory     string
	WebDirectory      string
	PublicURL         *url.URL
	TrustedProxyCIDRs []netip.Prefix
	SecureCookies     bool
	SessionLifetime   time.Duration
	MaxRequestBytes   int64
}

// Load reads TEAMTALER_* environment variables and applies secure local defaults.
// It takes no parameters and returns a complete Config. It returns an error for
// malformed URLs, proxy CIDRs, or request limits. Example: set
// TEAMTALER_PUBLIC_URL=https://teamtaler.example before calling Load.
func Load() (Config, error) {
	dataDir := env("TEAMTALER_DATA_DIR", "./data")
	databasePath := env("TEAMTALER_DATABASE_PATH", filepath.Join(dataDir, "teamtaler.db"))
	absoluteDataDir, err := filepath.Abs(dataDir)
	if err != nil {
		return Config{}, fmt.Errorf("resolve TEAMTALER_DATA_DIR: %w", err)
	}
	absoluteDatabasePath, err := filepath.Abs(databasePath)
	if err != nil {
		return Config{}, fmt.Errorf("resolve TEAMTALER_DATABASE_PATH: %w", err)
	}
	if filepath.Dir(absoluteDatabasePath) != absoluteDataDir {
		return Config{}, fmt.Errorf("TEAMTALER_DATABASE_PATH must be a direct child of TEAMTALER_DATA_DIR")
	}
	publicRaw := env("TEAMTALER_PUBLIC_URL", "http://127.0.0.1:8080")
	publicURL, err := url.ParseRequestURI(publicRaw)
	if err != nil || publicURL.Host == "" || (publicURL.Scheme != "http" && publicURL.Scheme != "https") || publicURL.User != nil || publicURL.RawQuery != "" || publicURL.Fragment != "" || (publicURL.Path != "" && publicURL.Path != "/") {
		return Config{}, fmt.Errorf("TEAMTALER_PUBLIC_URL must be an absolute root HTTP(S) URL without credentials, query, or fragment")
	}
	if publicURL.Scheme == "http" && !isLoopbackHost(publicURL.Hostname()) {
		return Config{}, fmt.Errorf("TEAMTALER_PUBLIC_URL must use HTTPS unless its host is loopback")
	}

	maxRequestBytes, err := strconv.ParseInt(env("TEAMTALER_MAX_REQUEST_BYTES", "6291456"), 10, 64)
	if err != nil || maxRequestBytes < 1024 {
		return Config{}, fmt.Errorf("TEAMTALER_MAX_REQUEST_BYTES must be at least 1024")
	}

	trusted, err := parsePrefixes(os.Getenv("TEAMTALER_TRUSTED_PROXY_CIDRS"))
	if err != nil {
		return Config{}, err
	}

	return Config{
		ListenAddress:     env("TEAMTALER_LISTEN", "127.0.0.1:8080"),
		DatabasePath:      databasePath,
		DataDirectory:     dataDir,
		WebDirectory:      env("TEAMTALER_WEB_DIR", "./web/dist"),
		PublicURL:         publicURL,
		TrustedProxyCIDRs: trusted,
		SecureCookies:     publicURL.Scheme == "https",
		SessionLifetime:   30 * 24 * time.Hour,
		MaxRequestBytes:   maxRequestBytes,
	}, nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	address, err := netip.ParseAddr(host)
	return err == nil && address.IsLoopback()
}

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func parsePrefixes(raw string) ([]netip.Prefix, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var prefixes []netip.Prefix
	for _, value := range strings.Split(raw, ",") {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(value))
		if err != nil {
			return nil, fmt.Errorf("TEAMTALER_TRUSTED_PROXY_CIDRS: %w", err)
		}
		prefixes = append(prefixes, prefix)
	}
	return prefixes, nil
}
