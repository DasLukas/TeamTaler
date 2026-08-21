package webpush

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Resolver resolves hostnames for endpoint validation and DNS-rebinding-safe
// connection setup. net.Resolver satisfies this interface.
type Resolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}

var deniedAddressPrefixes = mustPrefixes(
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
	"169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
	"192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
	"203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
	"::/96", "::1/128", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64",
	"2001::/23", "2001:db8::/32", "2002::/16", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8",
)

// ValidateEndpoint rejects malformed, credential-bearing, non-HTTPS, local,
// private, documentation, multicast, and reserved Web Push endpoints. Hostnames
// are resolved and every returned address must be public. It returns a parsed
// URL safe for hashing/storage or a validation error without echoing the input.
func ValidateEndpoint(ctx context.Context, raw string, resolver Resolver) (*url.URL, error) {
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	if len(raw) < 1 || len(raw) > 2048 || strings.ContainsAny(raw, "\x00\r\n") {
		return nil, fmt.Errorf("Web Push endpoint must contain 1 to 2048 safe characters")
	}
	parsed, err := url.ParseRequestURI(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return nil, fmt.Errorf("Web Push endpoint must be an absolute HTTPS URL without credentials or a fragment")
	}
	if parsed.Port() != "" {
		port, parseErr := strconv.Atoi(parsed.Port())
		if parseErr != nil || port != 443 {
			return nil, fmt.Errorf("Web Push endpoint may use only HTTPS port 443")
		}
	}
	addresses, err := resolvePublicAddresses(ctx, parsed.Hostname(), resolver)
	if err != nil || len(addresses) == 0 {
		return nil, fmt.Errorf("Web Push endpoint host must resolve only to public addresses")
	}
	return parsed, nil
}

// NewHardenedHTTPClient creates an HTTP client that revalidates and pins public
// DNS results on every connection, ignores proxy environment variables, refuses
// redirects, and applies bounded transport timeouts. resolver may be nil to use
// the system resolver. The returned client is safe for untrusted push endpoints.
func NewHardenedHTTPClient(resolver Resolver) *http.Client {
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	dialer := &net.Dialer{Timeout: 8 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy:                 nil,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          32,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   8 * time.Second,
		ResponseHeaderTimeout: 10 * time.Second,
		ExpectContinueTimeout: time.Second,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
	}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, fmt.Errorf("invalid Web Push connection address")
		}
		addresses, err := resolvePublicAddresses(ctx, host, resolver)
		if err != nil || len(addresses) == 0 {
			return nil, fmt.Errorf("Web Push endpoint resolution was rejected")
		}
		var failures []error
		for _, candidate := range addresses {
			connection, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(candidate.String(), port))
			if dialErr == nil {
				return connection, nil
			}
			failures = append(failures, dialErr)
		}
		return nil, fmt.Errorf("connect to Web Push service: %w", failures[len(failures)-1])
	}
	return &http.Client{
		Transport: transport,
		Timeout:   15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return fmt.Errorf("Web Push redirects are not allowed")
		},
	}
}

func resolvePublicAddresses(ctx context.Context, host string, resolver Resolver) ([]netip.Addr, error) {
	if literal, err := netip.ParseAddr(strings.Trim(host, "[]")); err == nil {
		literal = literal.Unmap()
		if !isPublicAddress(literal) {
			return nil, fmt.Errorf("address is not public")
		}
		return []netip.Addr{literal}, nil
	}
	addresses, err := resolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	validated := make([]netip.Addr, 0, len(addresses))
	for _, address := range addresses {
		address = address.Unmap()
		if !isPublicAddress(address) {
			return nil, fmt.Errorf("address is not public")
		}
		validated = append(validated, address)
	}
	return validated, nil
}

func isPublicAddress(address netip.Addr) bool {
	if !address.IsValid() || !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() {
		return false
	}
	for _, prefix := range deniedAddressPrefixes {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}

func mustPrefixes(values ...string) []netip.Prefix {
	prefixes := make([]netip.Prefix, len(values))
	for index, value := range values {
		prefixes[index] = netip.MustParsePrefix(value)
	}
	return prefixes
}
