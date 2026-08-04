// Package httpapi exposes TeamTaler's versioned same-origin HTTP/JSON API.
package httpapi

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/bookings"
	"github.com/DasLukas/TeamTaler/internal/catalog"
	"github.com/DasLukas/TeamTaler/internal/config"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/finance"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/notifications"
	"github.com/DasLukas/TeamTaler/internal/periods"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

const (
	sessionCookieName = "teamtaler_session"
	csrfCookieName    = "teamtaler_csrf"
)

type contextKey string

const principalKey contextKey = "principal"

// Server composes versioned HTTP handlers with application services.
// Use New to construct it; fields intentionally remain private so middleware and
// authorization cannot be bypassed by external packages.
type Server struct {
	config        config.Config
	db            *sql.DB
	auth          auth.Service
	groups        groups.Service
	catalog       catalog.Service
	bookings      bookings.Service
	finance       finance.Service
	periods       periods.Service
	notifications notifications.Service
	loginLimiter  *loginLimiter
	passwordSlots chan struct{}
	logger        *slog.Logger
}

// New builds a hardened same-origin handler from cfg, db, and an optional logger.
// It returns an http.Handler and does not start network listeners. A nil logger
// selects slog.Default; callers must provide a migrated database. Example:
// http.ListenAndServe(cfg.ListenAddress, New(cfg, db, nil)).
func New(cfg config.Config, db *sql.DB, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	groupService := groups.Service{DB: db}
	server := &Server{
		config:        cfg,
		db:            db,
		auth:          auth.Service{DB: db, SessionLifetime: cfg.SessionLifetime},
		groups:        groupService,
		catalog:       catalog.Service{DB: db},
		bookings:      bookings.Service{DB: db, Groups: groupService},
		finance:       finance.Service{DB: db},
		periods:       periods.Service{DB: db},
		notifications: notifications.Service{DB: db},
		loginLimiter:  newLoginLimiter(),
		passwordSlots: make(chan struct{}, 2),
		logger:        logger,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", server.handleLive)
	mux.HandleFunc("GET /health/ready", server.handleReady)
	mux.HandleFunc("POST /api/v1/auth/login", server.handleLogin)
	mux.HandleFunc("POST /api/v1/auth/logout", server.handleLogout)
	mux.HandleFunc("GET /api/v1/session", server.handleSession)
	mux.HandleFunc("GET /api/v1/me", server.handleSession)
	mux.HandleFunc("POST /api/v1/invitations/accept", server.handleAcceptInvitation)
	mux.HandleFunc("GET /api/v1/groups", server.handleListGroups)
	mux.HandleFunc("POST /api/v1/groups", server.handleCreateGroup)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/dashboard", server.handleDashboard)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/members", server.handleListMembers)
	mux.HandleFunc("PATCH /api/v1/groups/{groupID}/members/{membershipID}/permissions", server.handleUpdatePermissions)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/invitations", server.handleListInvitations)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/invitations", server.handleCreateInvitation)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/categories", server.handleListCategories)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/categories", server.handleCreateCategory)
	mux.HandleFunc("PATCH /api/v1/groups/{groupID}/categories/{categoryID}", server.handleUpdateCategory)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/categories/{categoryID}/products", server.handleCreateProduct)
	mux.HandleFunc("PATCH /api/v1/groups/{groupID}/products/{productID}", server.handleUpdateProduct)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/products/{productID}/image", server.handleProductImage)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/images/{imageKey}", server.handleImage)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/bookings", server.handleListBookings)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/bookings", server.handleCreateBooking)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/bookings/{bookingID}/void", server.handleVoidBooking)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/accounts/me", server.handleOwnAccount)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/accounts/{membershipID}", server.handleMemberAccount)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/payments", server.handleListPayments)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/payments", server.handleCreatePayment)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/payments/{paymentID}/reverse", server.handleReversePayment)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/periods", server.handleListPeriods)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/periods/{periodID}/close", server.handleClosePeriod)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/periods/{periodID}/statements", server.handleStatements)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/settlements", server.handleSettlements)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/notifications", server.handleListNotifications)
	mux.HandleFunc("PATCH /api/v1/groups/{groupID}/notifications/{notificationID}", server.handleUpdateNotification)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/audit", server.handleAudit)
	mux.HandleFunc("/api/", func(response http.ResponseWriter, request *http.Request) {
		writeProblem(response, request, domain.ErrNotFound)
	})
	mux.Handle("/", spaHandler(cfg.WebDirectory))
	return server.recover(server.securityHeaders(server.requestContext(server.originCheck(server.sessionContext(server.csrfCheck(server.limitBody(mux)))))))
}

func (s *Server) principal(request *http.Request) (domain.Principal, error) {
	principal, ok := request.Context().Value(principalKey).(domain.Principal)
	if !ok || principal.UserID == "" {
		return domain.Principal{}, domain.ErrUnauthenticated
	}
	return principal, nil
}

func (s *Server) membership(request *http.Request) (domain.Principal, domain.Membership, error) {
	principal, err := s.principal(request)
	if err != nil {
		return domain.Principal{}, domain.Membership{}, err
	}
	membership, err := s.groups.MembershipForUser(request.Context(), request.PathValue("groupID"), principal.UserID)
	return principal, membership, err
}

func (s *Server) sessionContext(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		sessionCookie, err := request.Cookie(sessionCookieName)
		if err == nil {
			csrfCookie, _ := request.Cookie(csrfCookieName)
			csrf := ""
			if csrfCookie != nil {
				csrf = csrfCookie.Value
			}
			principal, authErr := s.auth.Authenticate(request.Context(), sessionCookie.Value, csrf)
			if authErr == nil {
				request = request.WithContext(context.WithValue(request.Context(), principalKey, principal))
			}
		}
		next.ServeHTTP(response, request)
	})
}

func (s *Server) csrfCheck(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodGet || request.Method == http.MethodHead || request.Method == http.MethodOptions || request.URL.Path == "/api/v1/auth/login" || request.URL.Path == "/api/v1/invitations/accept" {
			next.ServeHTTP(response, request)
			return
		}
		principal, ok := request.Context().Value(principalKey).(domain.Principal)
		if !ok || principal.UserID == "" {
			writeProblem(response, request, domain.ErrUnauthenticated)
			return
		}
		header := request.Header.Get("X-CSRF-Token")
		if principal.CSRFToken == "" || subtle.ConstantTimeCompare([]byte(header), []byte(principal.CSRFToken)) != 1 {
			writeProblem(response, request, fmt.Errorf("%w: invalid CSRF token", domain.ErrForbidden))
			return
		}
		next.ServeHTTP(response, request)
	})
}

func (s *Server) originCheck(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet && request.Method != http.MethodHead && request.Method != http.MethodOptions {
			origin := strings.TrimSuffix(request.Header.Get("Origin"), "/")
			expected := strings.TrimSuffix(s.config.PublicURL.Scheme+"://"+s.config.PublicURL.Host, "/")
			if origin != "" && origin != expected {
				writeProblem(response, request, fmt.Errorf("%w: cross-origin requests are not accepted", domain.ErrForbidden))
				return
			}
		}
		next.ServeHTTP(response, request)
	})
}

func (s *Server) limitBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		request.Body = http.MaxBytesReader(response, request.Body, s.config.MaxRequestBytes)
		next.ServeHTTP(response, request)
	})
}

func (s *Server) requestContext(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requestID, _ := platform.NewID("req")
		response.Header().Set("X-Request-ID", requestID)
		started := time.Now()
		next.ServeHTTP(response, request)
		s.logger.Info("http request", "method", request.Method, "path", request.URL.Path, "request_id", requestID, "duration_ms", time.Since(started).Milliseconds())
	})
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if strings.HasPrefix(request.URL.Path, "/api/") {
			response.Header().Set("Cache-Control", "no-store")
			response.Header().Add("Vary", "Cookie")
		}
		response.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")
		response.Header().Set("Referrer-Policy", "no-referrer")
		response.Header().Set("X-Content-Type-Options", "nosniff")
		response.Header().Set("X-Frame-Options", "DENY")
		response.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
		if s.config.SecureCookies {
			response.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(response, request)
	})
}

func (s *Server) recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				s.logger.Error("panic in HTTP handler", "error", recovered, "stack", string(debug.Stack()))
				writeProblem(response, request, errors.New("internal server error"))
			}
		}()
		next.ServeHTTP(response, request)
	})
}

func decodeJSON(response http.ResponseWriter, request *http.Request, target any) error {
	if mediaType, _, _ := mime.ParseMediaType(request.Header.Get("Content-Type")); mediaType != "application/json" {
		return domain.ValidationError{Message: "Content-Type must be application/json"}
	}
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return domain.ValidationError{Message: "request body must be valid JSON: " + err.Error()}
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return domain.ValidationError{Message: "request body must contain exactly one JSON value"}
	}
	return nil
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

type problem struct {
	Type     string `json:"type"`
	Title    string `json:"title"`
	Status   int    `json:"status"`
	Detail   string `json:"detail"`
	Instance string `json:"instance"`
}

func writeProblem(response http.ResponseWriter, request *http.Request, err error) {
	status, title, problemType := http.StatusInternalServerError, "Internal Server Error", "https://teamtaler.dev/problems/internal"
	switch {
	case errors.Is(err, domain.ErrUnauthenticated):
		status, title, problemType = http.StatusUnauthorized, "Authentication Required", "https://teamtaler.dev/problems/unauthenticated"
	case errors.Is(err, domain.ErrForbidden):
		status, title, problemType = http.StatusForbidden, "Forbidden", "https://teamtaler.dev/problems/forbidden"
	case errors.Is(err, domain.ErrNotFound):
		status, title, problemType = http.StatusNotFound, "Not Found", "https://teamtaler.dev/problems/not-found"
	case errors.Is(err, domain.ErrValidation):
		status, title, problemType = http.StatusUnprocessableEntity, "Validation Failed", "https://teamtaler.dev/problems/validation"
	case errors.Is(err, domain.ErrPrecondition):
		status, title, problemType = http.StatusPreconditionFailed, "Precondition Failed", "https://teamtaler.dev/problems/precondition"
	case errors.Is(err, domain.ErrConflict), errors.Is(err, domain.ErrIdempotencyReuse):
		status, title, problemType = http.StatusConflict, "Conflict", "https://teamtaler.dev/problems/conflict"
	case errors.Is(err, domain.ErrRateLimited):
		status, title, problemType = http.StatusTooManyRequests, "Too Many Requests", "https://teamtaler.dev/problems/rate-limited"
	}
	detail := err.Error()
	if status == http.StatusInternalServerError {
		detail = "The server could not complete the request."
	}
	response.Header().Set("Content-Type", "application/problem+json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(problem{Type: problemType, Title: title, Status: status, Detail: detail, Instance: request.URL.Path})
}

func queryLimit(request *http.Request) int {
	value, _ := strconv.Atoi(request.URL.Query().Get("limit"))
	if value < 1 || value > 200 {
		return 100
	}
	return value
}

func (s *Server) clientIP(request *http.Request) string {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		host = request.RemoteAddr
	}
	peer, err := netip.ParseAddr(strings.Trim(host, "[]"))
	if err != nil || !s.isTrustedProxy(peer) {
		return host
	}
	forwarded := strings.Split(request.Header.Get("X-Forwarded-For"), ",")
	for index := len(forwarded) - 1; index >= 0; index-- {
		candidate, parseErr := netip.ParseAddr(strings.TrimSpace(forwarded[index]))
		if parseErr != nil {
			continue
		}
		if !s.isTrustedProxy(candidate) {
			return candidate.String()
		}
	}
	return peer.String()
}

func (s *Server) isTrustedProxy(address netip.Addr) bool {
	for _, prefix := range s.config.TrustedProxyCIDRs {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func spaHandler(directory string) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet && request.Method != http.MethodHead {
			http.NotFound(response, request)
			return
		}
		root, err := filepath.Abs(directory)
		if err != nil {
			http.NotFound(response, request)
			return
		}
		name := strings.TrimPrefix(filepath.Clean(request.URL.Path), string(filepath.Separator))
		path := filepath.Join(root, name)
		if !strings.HasPrefix(path, root+string(filepath.Separator)) && path != root {
			http.NotFound(response, request)
			return
		}
		info, statErr := os.Stat(path)
		if statErr != nil || info.IsDir() {
			path = filepath.Join(root, "index.html")
		}
		response.Header().Set("Cache-Control", "no-cache")
		if strings.HasPrefix(request.URL.Path, "/assets/") && strings.Contains(filepath.Base(path), ".") {
			response.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else if filepath.Base(path) != "index.html" {
			response.Header().Set("Cache-Control", "public, max-age=3600, must-revalidate")
		}
		http.ServeFile(response, request, path)
	})
}

type attemptBucket struct {
	count int
	reset time.Time
}

type loginLimiter struct {
	mu      sync.Mutex
	buckets map[string]attemptBucket
}

func newLoginLimiter() *loginLimiter { return &loginLimiter{buckets: map[string]attemptBucket{}} }

func (l *loginLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if len(l.buckets) >= 4096 {
		for candidate, existing := range l.buckets {
			if now.After(existing.reset) {
				delete(l.buckets, candidate)
			}
		}
		if len(l.buckets) >= 4096 {
			if _, exists := l.buckets[key]; !exists {
				return false
			}
		}
	}
	bucket := l.buckets[key]
	if now.After(bucket.reset) {
		bucket = attemptBucket{reset: now.Add(15 * time.Minute)}
	}
	if bucket.count >= 10 {
		return false
	}
	bucket.count++
	l.buckets[key] = bucket
	return true
}

func (l *loginLimiter) reset(keys ...string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, key := range keys {
		delete(l.buckets, key)
	}
}
