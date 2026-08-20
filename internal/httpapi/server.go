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
	"io/fs"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"path"
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
	systemadmin "github.com/DasLukas/TeamTaler/internal/system"
	webpushservice "github.com/DasLukas/TeamTaler/internal/webpush"
)

const (
	sessionCookieName = "teamtaler_session"
	csrfCookieName    = "teamtaler_csrf"
)

type contextKey string

const principalKey contextKey = "principal"
const systemSettingsKey contextKey = "system-settings"

// Server composes versioned HTTP handlers with application services.
// Use New to construct it; fields intentionally remain private so middleware and
// authorization cannot be bypassed by external packages.
type Server struct {
	config            config.Config
	db                *sql.DB
	auth              auth.Service
	groups            groups.Service
	catalog           catalog.Service
	bookings          bookings.Service
	finance           finance.Service
	periods           periods.Service
	notifications     notifications.Service
	systemAdmin       systemadmin.Service
	pushSubscriptions *webpushservice.SubscriptionService
	pushSender        *webpushservice.Sender
	systemConfigured  bool
	loginLimiter      *loginLimiter
	passwordSlots     chan struct{}
	logger            *slog.Logger
}

// New builds a hardened same-origin handler from cfg, db, and an optional logger.
// It returns an http.Handler and does not start network listeners. A nil logger
// selects slog.Default; callers must provide a migrated database. Example:
// http.ListenAndServe(cfg.ListenAddress, New(cfg, db, nil)).
func New(cfg config.Config, db *sql.DB, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	var tokenSealer groups.TokenSealer
	var tokenOpener groups.TokenOpener
	if len(cfg.EmailTokenKey) == 32 {
		box, err := platform.NewSecretBox(cfg.EmailTokenKey)
		if err != nil {
			logger.Error("invitation email token encryption is unavailable", "error", err)
		} else {
			tokenSealer = box
			tokenOpener = box
		}
	}
	var smtpPasswordCipher systemadmin.PasswordCipher
	if len(cfg.EmailTokenKey) == 32 {
		cipher, err := systemadmin.NewSMTPPasswordCipher(cfg.EmailTokenKey)
		if err != nil {
			panic(fmt.Sprintf("configure SMTP password encryption: %v", err))
		}
		smtpPasswordCipher = cipher
	}
	var pushSecrets *webpushservice.Secrets
	var systemOptions []systemadmin.ServiceOption
	if len(cfg.PushStorageKey) == 32 {
		secrets, err := webpushservice.NewSecrets(cfg.PushStorageKey)
		if err != nil {
			panic(fmt.Sprintf("configure Web Push secret encryption: %v", err))
		}
		pushSecrets = secrets
		systemOptions = append(systemOptions, systemadmin.WithWebPushSecretCipher(secrets))
	}
	systemService, err := systemadmin.NewService(db, systemadmin.DefaultsFromConfig(cfg), smtpPasswordCipher, systemOptions...)
	if err != nil {
		panic(fmt.Sprintf("configure system administration: %v", err))
	}
	emailInfrastructureAvailable := len(cfg.EmailTokenKey) == 32
	groupService := groups.Service{DB: db, TokenSealer: tokenSealer, TokenOpener: tokenOpener, EmailDeliveryAvailable: emailInfrastructureAvailable}
	notificationService := notifications.Service{
		DB: db, EmailDeliveryAvailable: emailInfrastructureAvailable, PushDeliveryAvailable: pushSecrets != nil,
	}
	notificationService.ResolveChannelAvailability = func(ctx context.Context, tx *sql.Tx) (notifications.ChannelAvailability, error) {
		availability, err := systemService.ResolveNotificationChannelsTx(ctx, tx)
		if err != nil {
			return notifications.ChannelAvailability{}, err
		}
		return notifications.ChannelAvailability{
			EmailAvailable: emailInfrastructureAvailable && availability.EmailActive,
			PushAvailable:  pushSecrets != nil && availability.WebPushActive,
			PushKeyID:      availability.WebPushKeyID,
		}, nil
	}
	var pushSubscriptions *webpushservice.SubscriptionService
	var pushSender *webpushservice.Sender
	if pushSecrets != nil {
		pushSubscriptions, err = webpushservice.NewSubscriptionService(db, pushSecrets, nil)
		if err != nil {
			panic(fmt.Sprintf("configure Web Push subscriptions: %v", err))
		}
		pushSender = webpushservice.NewSender(nil)
	}
	server := &Server{
		config:            cfg,
		db:                db,
		auth:              auth.Service{DB: db, SessionLifetime: cfg.SessionLifetime, TokenSealer: tokenSealer, EmailDeliveryAvailable: emailInfrastructureAvailable},
		groups:            groupService,
		catalog:           catalog.Service{DB: db},
		bookings:          bookings.Service{DB: db, Groups: groupService, Notifications: notificationService},
		finance:           finance.Service{DB: db, Notifications: notificationService},
		periods:           periods.Service{DB: db, Notifications: notificationService},
		notifications:     notificationService,
		systemAdmin:       systemService,
		pushSubscriptions: pushSubscriptions,
		pushSender:        pushSender,
		systemConfigured:  true,
		loginLimiter:      newLoginLimiter(),
		passwordSlots:     make(chan struct{}, 2),
		logger:            logger,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", server.handleLive)
	mux.HandleFunc("GET /health/ready", server.handleReady)
	mux.HandleFunc("GET /api/v1/instance/capabilities", server.handleInstanceCapabilities)
	mux.HandleFunc("POST /api/v1/auth/login", server.handleLogin)
	mux.HandleFunc("POST /api/v1/auth/logout", server.handleLogout)
	mux.HandleFunc("GET /api/v1/auth/capabilities", server.handleAccountCapabilities)
	mux.HandleFunc("POST /api/v1/auth/password-reset/request", server.handlePasswordResetRequest)
	mux.HandleFunc("POST /api/v1/auth/password-reset/confirm", server.handlePasswordResetConfirm)
	mux.HandleFunc("POST /api/v1/auth/email-change/confirm", server.handleEmailChangeConfirm)
	mux.HandleFunc("GET /api/v1/session", server.handleSession)
	mux.HandleFunc("GET /api/v1/me", server.handleSession)
	mux.HandleFunc("PATCH /api/v1/me/profile", server.handleUpdateProfile)
	mux.HandleFunc("PUT /api/v1/me/group-preference", server.handleUpdateDefaultGroup)
	mux.HandleFunc("PUT /api/v1/me/group-preference/last-used", server.handleRecordLastUsedGroup)
	mux.HandleFunc("GET /api/v1/me/notifications/{notificationID}/destination", server.handleResolveNotificationDestination)
	mux.HandleFunc("PUT /api/v1/me/password", server.handleChangePassword)
	mux.HandleFunc("POST /api/v1/me/email-change", server.handleStartEmailChange)
	mux.HandleFunc("GET /api/v1/permission-definitions", server.handlePermissionDefinitions)
	mux.HandleFunc("POST /api/v1/me/avatar", server.handleProfileAvatar)
	mux.HandleFunc("DELETE /api/v1/me/avatar", server.handleRemoveProfileAvatar)
	mux.HandleFunc("GET /api/v1/me/push-subscriptions", server.handleListPushSubscriptions)
	mux.HandleFunc("POST /api/v1/me/push-subscriptions", server.handleRegisterPushSubscription)
	mux.HandleFunc("PATCH /api/v1/me/push-subscriptions/{subscriptionID}", server.handleRenamePushSubscription)
	mux.HandleFunc("DELETE /api/v1/me/push-subscriptions/{subscriptionID}", server.handleDeletePushSubscription)
	mux.HandleFunc("GET /api/v1/users/{userID}/avatar/{imageKey}", server.handleUserAvatar)
	mux.HandleFunc("POST /api/v1/invitations/preview", server.handlePreviewInvitation)
	mux.HandleFunc("POST /api/v1/invitations/accept", server.handleAcceptInvitation)
	mux.HandleFunc("POST /api/v1/public-join-links/preview", server.handlePreviewPublicJoinLink)
	mux.HandleFunc("POST /api/v1/public-join-links/registrations", server.handleStartPublicJoinRegistration)
	mux.HandleFunc("POST /api/v1/public-join-links/registrations/resend", server.handleResendPublicJoinVerification)
	mux.HandleFunc("POST /api/v1/public-join-links/registrations/confirm", server.handleConfirmPublicJoinRegistration)
	mux.HandleFunc("POST /api/v1/public-join-links/accept", server.handleAcceptPublicJoinLink)
	mux.HandleFunc("GET /api/v1/groups", server.handleListGroups)
	mux.HandleFunc("POST /api/v1/groups", server.handleCreateGroup)
	mux.HandleFunc("GET /api/v1/system/settings", server.handleSystemSettings)
	mux.HandleFunc("PATCH /api/v1/system/settings", server.handleUpdateSystemSettings)
	mux.HandleFunc("POST /api/v1/system/settings/reset", server.handleResetSystemSettings)
	mux.HandleFunc("PUT /api/v1/system/settings/smtp", server.handleUpdateSystemSMTP)
	mux.HandleFunc("DELETE /api/v1/system/settings/smtp", server.handleResetSystemSMTP)
	mux.HandleFunc("POST /api/v1/system/settings/smtp/test", server.handleTestSystemSMTP)
	mux.HandleFunc("PUT /api/v1/system/settings/web-push", server.handleUpdateSystemWebPush)
	mux.HandleFunc("DELETE /api/v1/system/settings/web-push", server.handleResetSystemWebPush)
	mux.HandleFunc("POST /api/v1/system/settings/web-push/generate-key", server.handleGenerateSystemWebPushKey)
	mux.HandleFunc("POST /api/v1/system/settings/web-push/test", server.handleTestSystemWebPush)
	mux.HandleFunc("GET /api/v1/system/administrators", server.handleListSystemAdministrators)
	mux.HandleFunc("GET /api/v1/system/accounts", server.handleSearchSystemAccounts)
	mux.HandleFunc("GET /api/v1/system/groups", server.handleListSystemGroups)
	mux.HandleFunc("POST /api/v1/system/groups", server.handleCreateSystemGroup)
	mux.HandleFunc("GET /api/v1/system/groups/{groupID}/logo", server.handleSystemGroupLogo)
	mux.HandleFunc("GET /api/v1/system/groups/{groupID}/deletion-impact", server.handleSystemGroupDeletionImpact)
	mux.HandleFunc("POST /api/v1/system/groups/{groupID}/archive", server.handleArchiveSystemGroup)
	mux.HandleFunc("POST /api/v1/system/groups/{groupID}/restore", server.handleRestoreSystemGroup)
	mux.HandleFunc("POST /api/v1/system/groups/{groupID}/invitation/resend", server.handleResendSystemGroupInvitation)
	mux.HandleFunc("POST /api/v1/system/groups/{groupID}/purge", server.handlePurgeSystemGroup)
	mux.HandleFunc("GET /api/v1/system/audit", server.handleSystemAudit)
	mux.HandleFunc("GET /api/v1/system/audit/filter-options", server.handleSystemAuditFilterOptions)
	mux.HandleFunc("PATCH /api/v1/groups/{groupID}", server.handleUpdateGroup)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/settings", server.handleGetGroupSettings)
	mux.HandleFunc("PATCH /api/v1/groups/{groupID}/settings", server.handleUpdateGroupSettings)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/notification-settings", server.handleGetGroupNotificationSettings)
	mux.HandleFunc("PUT /api/v1/groups/{groupID}/notification-settings", server.handleUpdateGroupNotificationSettings)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/notification-preferences", server.handleGetNotificationPreferences)
	mux.HandleFunc("PUT /api/v1/groups/{groupID}/notification-preferences", server.handleUpdateNotificationPreferences)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/transaction-settings", server.handleGetTransactionSettings)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/logo", server.handleGroupLogo)
	mux.HandleFunc("DELETE /api/v1/groups/{groupID}/logo", server.handleRemoveGroupLogo)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/dashboard", server.handleDashboard)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/members", server.handleListMembers)
	mux.HandleFunc("PATCH /api/v1/groups/{groupID}/members/{membershipID}", server.handleRenameTemporaryGuest)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/members/{membershipID}/claim-invitation", server.handleCreateTemporaryGuestClaimInvitation)
	mux.HandleFunc("PATCH /api/v1/groups/{groupID}/members/{membershipID}/permissions", server.handleUpdatePermissions)
	mux.HandleFunc("PUT /api/v1/groups/{groupID}/members/{membershipID}/roles", server.handleReplaceMemberRoles)
	mux.HandleFunc("DELETE /api/v1/groups/{groupID}/members/{membershipID}", server.handleArchiveMember)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/members/{membershipID}/reactivate", server.handleReactivateMember)
	mux.HandleFunc("DELETE /api/v1/groups/{groupID}/members/{membershipID}/permanent", server.handlePermanentlyDeleteMember)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/public-join-link", server.handleGetPublicJoinLink)
	mux.HandleFunc("PUT /api/v1/groups/{groupID}/public-join-link", server.handlePutPublicJoinLink)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/public-join-link/rotate", server.handleRotatePublicJoinLink)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/invitations", server.handleListInvitations)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/invitations", server.handleCreateInvitation)
	mux.HandleFunc("PATCH /api/v1/groups/{groupID}/invitations/{invitationID}", server.handleUpdateInvitation)
	mux.HandleFunc("PUT /api/v1/groups/{groupID}/invitations/{invitationID}/roles", server.handleReplaceInvitationRoles)
	mux.HandleFunc("DELETE /api/v1/groups/{groupID}/invitations/{invitationID}", server.handleRevokeInvitation)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/invitations/import", server.handleImportInvitations)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/invitations/{invitationID}/email/retry", server.handleRetryInvitationEmail)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/invitations/{invitationID}/email/resend", server.handleResendInvitationEmail)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/roles", server.handleListRoles)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/roles", server.handleCreateRole)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/roles/{roleID}", server.handleGetRole)
	mux.HandleFunc("PUT /api/v1/groups/{groupID}/roles/{roleID}", server.handleUpdateRole)
	mux.HandleFunc("DELETE /api/v1/groups/{groupID}/roles/{roleID}", server.handleDeleteRole)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/role-assignments", server.handleListRoleAssignments)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/categories", server.handleListCategories)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/categories", server.handleCreateCategory)
	mux.HandleFunc("PUT /api/v1/groups/{groupID}/catalog/order", server.handleReorderCatalog)
	mux.HandleFunc("PATCH /api/v1/groups/{groupID}/categories/{categoryID}", server.handleUpdateCategory)
	mux.HandleFunc("DELETE /api/v1/groups/{groupID}/categories/{categoryID}", server.handleDeleteCategory)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/categories/{categoryID}/products", server.handleCreateProduct)
	mux.HandleFunc("PATCH /api/v1/groups/{groupID}/products/{productID}", server.handleUpdateProduct)
	mux.HandleFunc("DELETE /api/v1/groups/{groupID}/products/{productID}", server.handleDeleteProduct)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/products/{productID}/image", server.handleProductImage)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/images/{imageKey}", server.handleImage)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/bookings", server.handleListBookings)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/booking-context", server.handleBookingContext)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/bookings", server.handleCreateBooking)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/bookings/batch", server.handleCreateBookingBatch)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/bookings/bulk", server.handleCreateBookingBulk)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/bookings/{bookingID}/void", server.handleVoidBooking)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/accounts", server.handleListAccounts)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/accounts/me/movements", server.handleOwnAccountMovements)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/accounts/me", server.handleOwnAccount)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/accounts/{membershipID}", server.handleMemberAccount)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/payments", server.handleListPayments)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/payments", server.handleCreatePayment)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/payments/self", server.handleCreateOwnPayment)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/payments/{paymentID}/reverse", server.handleReversePayment)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/periods", server.handleListPeriods)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/periods/{periodID}/close", server.handleClosePeriod)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/periods/{periodID}/statements", server.handleStatements)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/settlements", server.handleSettlements)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/notifications", server.handleListNotifications)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/notifications/summary", server.handleNotificationSummary)
	mux.HandleFunc("PATCH /api/v1/groups/{groupID}/notifications/read", server.handleMarkNotificationsRead)
	mux.HandleFunc("PATCH /api/v1/groups/{groupID}/notifications/{notificationID}", server.handleUpdateNotification)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/audit", server.handleAudit)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/audit/filter-options", server.handleAuditFilterOptions)
	mux.HandleFunc("/api/", func(response http.ResponseWriter, request *http.Request) {
		writeProblem(response, request, domain.ErrNotFound)
	})
	mux.Handle("/", spaHandler(cfg.WebDirectory))
	return server.recover(server.securityHeaders(server.requestContext(server.originCheck(server.sessionContext(server.runtimeSettings(server.maintenanceGate(server.csrfCheck(server.limitBody(mux)))))))))
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

// runtimeSettings resolves one consistent instance-settings snapshot for each
// API request. Downstream handlers and gates reuse it instead of issuing
// independent queries that could observe different revisions.
func (s *Server) runtimeSettings(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if !strings.HasPrefix(request.URL.Path, "/api/") || strings.HasPrefix(request.URL.Path, "/api/v1/instance/capabilities") {
			next.ServeHTTP(response, request)
			return
		}
		settings, err := s.systemAdmin.GetSettings(request.Context())
		if err != nil {
			s.logger.Error("load runtime system settings", "error", err)
			writeProblem(response, request, domain.ErrServiceUnavailable)
			return
		}
		request = request.WithContext(context.WithValue(request.Context(), systemSettingsKey, settings))
		next.ServeHTTP(response, request)
	})
}

func effectiveSystemSettings(request *http.Request) (systemadmin.Settings, bool) {
	settings, ok := request.Context().Value(systemSettingsKey).(systemadmin.Settings)
	return settings, ok
}

func (s *Server) maintenanceGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		settings, loaded := effectiveSystemSettings(request)
		if !loaded || !settings.MaintenanceMode.Value || request.Method == http.MethodGet || request.Method == http.MethodHead || request.Method == http.MethodOptions || maintenanceMutationAllowed(request.URL.Path) {
			next.ServeHTTP(response, request)
			return
		}
		writeProblem(response, request, fmt.Errorf("%w: the instance is in maintenance mode", domain.ErrServiceUnavailable))
	})
}

func maintenanceMutationAllowed(requestPath string) bool {
	return requestPath == "/api/v1/auth/login" ||
		requestPath == "/api/v1/auth/logout" ||
		requestPath == "/api/v1/groups" ||
		strings.HasPrefix(requestPath, "/api/v1/system/")
}

func (s *Server) csrfCheck(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodGet || request.Method == http.MethodHead || request.Method == http.MethodOptions || isPublicMutation(request.URL.Path) {
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

func isPublicMutation(requestPath string) bool {
	switch requestPath {
	case "/api/v1/auth/login",
		"/api/v1/auth/password-reset/request",
		"/api/v1/auth/password-reset/confirm",
		"/api/v1/auth/email-change/confirm",
		"/api/v1/invitations/preview",
		"/api/v1/invitations/accept",
		"/api/v1/public-join-links/preview",
		"/api/v1/public-join-links/registrations",
		"/api/v1/public-join-links/registrations/resend",
		"/api/v1/public-join-links/registrations/confirm":
		return true
	default:
		return false
	}
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
		limit := s.config.MaxRequestBytes
		if isMediaUploadRequest(request) {
			if settings, loaded := effectiveSystemSettings(request); loaded {
				limit = settings.MediaUploadMaxBytes.Value + systemadmin.MultipartRequestReserveBytes
			} else {
				limit = config.DefaultMediaUploadBytes + config.MultipartRequestReserve
			}
		}
		request.Body = http.MaxBytesReader(response, request.Body, limit)
		next.ServeHTTP(response, request)
	})
}

// isMediaUploadRequest identifies the three multipart routes whose request
// ceiling follows the live instance media setting instead of the general JSON
// request ceiling.
func isMediaUploadRequest(request *http.Request) bool {
	if request.Method != http.MethodPost {
		return false
	}
	if request.URL.Path == "/api/v1/me/avatar" {
		return true
	}
	segments := strings.Split(strings.Trim(request.URL.Path, "/"), "/")
	if len(segments) == 5 {
		return segments[0] == "api" && segments[1] == "v1" && segments[2] == "groups" && segments[4] == "logo"
	}
	return len(segments) == 7 && segments[0] == "api" && segments[1] == "v1" && segments[2] == "groups" &&
		segments[4] == "products" && segments[6] == "image"
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
		response.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")
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
	Type                   string `json:"type"`
	Title                  string `json:"title"`
	Status                 int    `json:"status"`
	Detail                 string `json:"detail"`
	Instance               string `json:"instance"`
	MemberCount            *int64 `json:"memberCount,omitempty"`
	PendingInvitationCount *int64 `json:"pendingInvitationCount,omitempty"`
	ExistingMembershipID   string `json:"existingMembershipId,omitempty"`
}

func writeProblem(response http.ResponseWriter, request *http.Request, err error) {
	status, title, problemType := http.StatusInternalServerError, "Internal Server Error", "https://teamtaler.dev/problems/internal"
	switch {
	case errors.Is(err, auth.ErrInvitationAccountStateChanged):
		status, title, problemType = http.StatusConflict, "Invitation Account State Changed", "https://teamtaler.dev/problems/invitation-account-state-changed"
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
	case errors.Is(err, domain.ErrServiceUnavailable):
		status, title, problemType = http.StatusServiceUnavailable, "Service Unavailable", "https://teamtaler.dev/problems/service-unavailable"
	case errors.Is(err, domain.ErrUnsupportedMediaType):
		status, title, problemType = http.StatusUnsupportedMediaType, "Unsupported Media Type", "https://teamtaler.dev/problems/unsupported-media-type"
	case errors.Is(err, domain.ErrPayloadTooLarge):
		status, title, problemType = http.StatusRequestEntityTooLarge, "Content Too Large", "https://teamtaler.dev/problems/content-too-large"
	}
	detail := err.Error()
	if status == http.StatusInternalServerError {
		detail = "The server could not complete the request."
	}
	response.Header().Set("Content-Type", "application/problem+json; charset=utf-8")
	response.WriteHeader(status)
	item := problem{Type: problemType, Title: title, Status: status, Detail: detail, Instance: request.URL.Path}
	if memberCount, invitationCount, ok := roleConflictCounts(err); ok {
		item.MemberCount = &memberCount
		item.PendingInvitationCount = &invitationCount
	}
	if membershipID, ok := temporaryGuestConflictMembershipID(err); ok {
		item.ExistingMembershipID = membershipID
	}
	_ = json.NewEncoder(response).Encode(item)
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

// spaFileSystem confines static reads to an http.Dir and falls back to the SPA
// shell only for extensionless client-side routes. Missing asset requests remain
// ordinary 404 responses instead of receiving index.html.
type spaFileSystem struct {
	root http.FileSystem
}

// Open resolves name through the hardened http.Dir implementation. It returns
// index.html for missing extensionless routes, the requested regular file when
// present, and an error for missing assets, directories below /assets, or I/O
// failures. The caller owns and closes every returned file.
func (filesystem spaFileSystem) Open(name string) (http.File, error) {
	file, err := filesystem.root.Open(name)
	if err == nil {
		info, statErr := file.Stat()
		if statErr != nil {
			_ = file.Close()
			return nil, statErr
		}
		if !info.IsDir() {
			return file, nil
		}
		if name == "/" {
			return file, nil
		}
		_ = file.Close()
		err = fs.ErrNotExist
	}
	if path.Ext(name) != "" || strings.HasPrefix(name, "/assets/") {
		return nil, err
	}
	return filesystem.root.Open("/index.html")
}

// spaHandler serves build assets from directory through net/http's constrained
// file-server abstraction and returns index.html for extensionless React routes.
// Only GET and HEAD are accepted. Hashed /assets files receive immutable caching,
// other concrete files revalidate hourly, and the SPA shell and root-scoped
// service worker are never cached.
func spaHandler(directory string) http.Handler {
	files := http.FileServer(spaFileSystem{root: http.Dir(directory)})
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet && request.Method != http.MethodHead {
			http.NotFound(response, request)
			return
		}
		response.Header().Set("Cache-Control", "no-cache")
		if request.URL.Path == "/service-worker.js" {
			response.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
			response.Header().Set("Service-Worker-Allowed", "/")
		} else if strings.HasPrefix(request.URL.Path, "/assets/") && path.Ext(request.URL.Path) != "" {
			response.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else if path.Ext(request.URL.Path) != "" && path.Base(request.URL.Path) != "index.html" {
			response.Header().Set("Cache-Control", "public, max-age=3600, must-revalidate")
		}
		files.ServeHTTP(response, request)
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
