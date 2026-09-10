// Package email delivers security-sensitive transactional email messages.
package email

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/mail"
	"net/netip"
	"net/smtp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/DasLukas/TeamTaler/internal/config"
)

const (
	connectionTimeout  = 30 * time.Second
	maximumAddressSize = 254
	maximumURLSize     = 4096
)

// ErrUnavailable classifies attempts to send email while SMTP delivery is
// disabled. Callers may use errors.Is to distinguish this operational state
// from validation, network, authentication, and remote-server failures.
var ErrUnavailable = errors.New("email delivery is unavailable")

// Sender is the transactional-email delivery boundary used by application services.
// Available reports whether delivery was completely configured at startup.
// SendInvitation accepts a context and an InvitationMessage and returns nil only
// after the SMTP server accepts the message; implementations may return
// ErrUnavailable, validation errors, context errors, or transport errors.
//
// Example:
//
//	if sender.Available() {
//		err := sender.SendInvitation(ctx, message)
//	}
type Sender interface {
	// Available reports whether delivery is configured without performing I/O.
	Available() bool
	// SendInvitation submits one invitation or returns a classified failure.
	SendInvitation(context.Context, InvitationMessage) error
	// SendNotification submits one member notification or returns a classified failure.
	SendNotification(context.Context, NotificationMessage) error
}

// InvitationMessage contains the recipient, onboarding data, and resolved
// branding rendered into a multipart TeamTaler invitation. ToName is optional;
// all other content fields are required. ExpiresAt is rendered in UTC, and
// AcceptURL must be an absolute HTTP or HTTPS URL. Invalid addresses, header
// controls, URLs, or zero expiry values cause SendInvitation to return a
// validation error before any network access.
type InvitationMessage struct {
	// ToAddress is the recipient's single ASCII mailbox address.
	ToAddress string
	// ToName is the optional recipient display name.
	ToName string
	// GroupName identifies the group in the subject and body.
	GroupName string
	// AcceptURL is the absolute one-time invitation URL.
	AcceptURL string
	// ExpiresAt identifies when the invitation stops being valid.
	ExpiresAt time.Time
	// Branding contains the resolved group identity and recipient theme.
	Branding BrandingContext
}

// JoinVerificationMessage contains the recipient and one-time mailbox proof
// required before a public-link registration may create an account. All fields
// are required and validated before SMTP network access.
type JoinVerificationMessage struct {
	// ToAddress is the recipient's single ASCII mailbox address.
	ToAddress string
	// ToName is the requested account display name.
	ToName string
	// GroupName identifies the group being joined.
	GroupName string
	// VerifyURL is the absolute one-time mailbox verification URL.
	VerifyURL string
	// ExpiresAt identifies when verification stops being valid.
	ExpiresAt time.Time
	// Branding contains the resolved group identity and default theme.
	Branding BrandingContext
}

// AccountSecurityMessage contains the recipient and one-time account-security
// link for password recovery or email-address confirmation. All fields are
// validated before SMTP network access.
type AccountSecurityMessage struct {
	// ToAddress is the recipient's single ASCII mailbox address.
	ToAddress string
	// ToName is the active account display name.
	ToName string
	// ActionURL is the absolute one-time action URL.
	ActionURL string
	// ExpiresAt identifies when the action stops being valid.
	ExpiresAt time.Time
	// Branding contains system branding; group branding is ignored.
	Branding BrandingContext
}

// NotificationMessage contains the recipient, localized event summary, group,
// and same-origin action URL for one member notification email.
type NotificationMessage struct {
	// ToAddress is the recipient's single ASCII mailbox address.
	ToAddress string
	// ToName is the optional recipient display name.
	ToName string
	// GroupName identifies the group in the subject and body.
	GroupName string
	// Title is the short localized notification subject detail.
	Title string
	// Body is the concise localized event description.
	Body string
	// ActionURL opens the authenticated notification inbox.
	ActionURL string
	// Branding contains either resolved group branding or explicit system branding.
	Branding BrandingContext
}

// SMTP sends invitations, verification messages, account-security actions,
// notifications, and system tests through one validated SMTP endpoint.
// Construct it with NewSMTP. Its connection uses authenticated STARTTLS or
// implicit TLS, verifies the server certificate, requires TLS 1.2 or newer,
// and is bounded by both the caller context and an internal operation timeout.
type SMTP struct {
	configuration config.SMTPConfig
	dialContext   func(context.Context, string, string) (net.Conn, error)
	rootCAs       *x509.CertPool
	now           func() time.Time
}

var _ Sender = (*SMTP)(nil)

// NewSMTP constructs an SMTP transactional-email sender from configuration. Disabled
// zero configuration returns a valid sender whose Available method is false.
// Enabled configuration must contain a host, port, credentials, sender address,
// and one of the mandatory TLS modes; malformed or internally inconsistent
// values return an error. The returned sender performs no network access until
// a send method is called.
//
// Example:
//
//	sender, err := email.NewSMTP(configuration.SMTP)
func NewSMTP(configuration config.SMTPConfig) (*SMTP, error) {
	if err := validateConfiguration(configuration); err != nil {
		return nil, err
	}
	configuration.FromAddress = strings.TrimSpace(configuration.FromAddress)
	configuration.FromName = strings.TrimSpace(configuration.FromName)
	dialer := &net.Dialer{Timeout: connectionTimeout, KeepAlive: 30 * time.Second}
	sender := &SMTP{
		configuration: configuration,
		now:           time.Now,
	}
	sender.dialContext = sender.policyDialContext(dialer)
	return sender, nil
}

func (s *SMTP) policyDialContext(dialer *net.Dialer) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, endpoint string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(endpoint)
		if err != nil {
			return nil, fmt.Errorf("parse SMTP endpoint: %w", err)
		}
		addresses, err := resolveSMTPAddresses(ctx, host)
		if err != nil {
			return nil, err
		}
		allowedPrivatePort := strconv.Itoa(s.configuration.AllowedPrivatePort)
		allowRestricted := s.configuration.AllowPrivateNetwork ||
			(strings.EqualFold(host, s.configuration.AllowedPrivateHost) && port == allowedPrivatePort)
		attempted := false
		var dialErrors []error
		for _, address := range addresses {
			if isRestrictedSMTPAddress(address) && !allowRestricted {
				continue
			}
			attempted = true
			connection, err := dialer.DialContext(ctx, network, net.JoinHostPort(address.String(), port))
			if err == nil {
				return connection, nil
			}
			dialErrors = append(dialErrors, err)
			if ctx.Err() != nil {
				break
			}
		}
		if !attempted {
			return nil, fmt.Errorf("%w: SMTP target is blocked by the immutable host network policy", ErrUnavailable)
		}
		return nil, errors.Join(dialErrors...)
	}
}

func resolveSMTPAddresses(ctx context.Context, host string) ([]netip.Addr, error) {
	if address, err := netip.ParseAddr(host); err == nil {
		return []netip.Addr{address.Unmap()}, nil
	}
	addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, fmt.Errorf("resolve SMTP host: %w", err)
	}
	if len(addresses) == 0 {
		return nil, errors.New("resolve SMTP host: no addresses returned")
	}
	for index := range addresses {
		addresses[index] = addresses[index].Unmap()
	}
	return addresses, nil
}

func isRestrictedSMTPAddress(address netip.Addr) bool {
	if !address.IsValid() || !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() || address.IsUnspecified() {
		return true
	}
	for _, prefix := range restrictedSMTPPrefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

var restrictedSMTPPrefixes = []netip.Prefix{
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
}

// Available reports whether this sender has a complete enabled SMTP
// configuration. It has no parameters, performs no I/O, and cannot fail.
func (s *SMTP) Available() bool {
	return s != nil && s.configuration.Enabled
}

// SendInvitation renders message as UTF-8 multipart/related with plain-text and
// HTML alternatives plus an inline logo, then submits it to the configured SMTP
// server. ctx controls dialing, TLS negotiation, authentication, SMTP commands,
// and message upload; message supplies recipient, group, link, expiry, and
// branding data. It returns ErrUnavailable when disabled, a validation error
// before dialing for unsafe input, context.Canceled or context.DeadlineExceeded
// when canceled, or a wrapped TLS, authentication, network, or SMTP error. A nil
// result means the remote server accepted the complete message.
//
// Example:
//
//	err := sender.SendInvitation(ctx, email.InvitationMessage{
//		ToAddress: "member@example.com",
//		GroupName: "Example Team",
//		AcceptURL: "https://teamtaler.example/invite#token=secret",
//		ExpiresAt: time.Now().Add(7 * 24 * time.Hour),
//	})
func (s *SMTP) SendInvitation(ctx context.Context, message InvitationMessage) error {
	if !s.Available() {
		return fmt.Errorf("%w: SMTP is disabled", ErrUnavailable)
	}
	if ctx == nil {
		return errors.New("send invitation: context is required")
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("send invitation: %w", err)
	}

	recipient, payload, err := s.renderDesignedInvitation(message)
	if err != nil {
		return fmt.Errorf("send invitation: %w", err)
	}
	return s.sendPayload(ctx, "invitation", recipient, payload)
}

// SendJoinVerification renders and submits one public-registration mailbox
// verification message. It returns ErrUnavailable when SMTP is disabled,
// validation errors before dialing, context errors, or a wrapped transport
// failure. A nil result means the SMTP relay accepted the complete message.
func (s *SMTP) SendJoinVerification(ctx context.Context, message JoinVerificationMessage) error {
	if !s.Available() {
		return fmt.Errorf("%w: SMTP is disabled", ErrUnavailable)
	}
	if ctx == nil {
		return errors.New("send join verification: context is required")
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("send join verification: %w", err)
	}
	recipient, payload, err := s.renderDesignedJoinVerification(message)
	if err != nil {
		return fmt.Errorf("send join verification: %w", err)
	}
	return s.sendPayload(ctx, "join verification", recipient, payload)
}

// SendPasswordReset validates, renders, and submits a password-reset message.
// It returns ErrUnavailable, validation, context, or SMTP transport errors.
func (s *SMTP) SendPasswordReset(ctx context.Context, message AccountSecurityMessage) error {
	return s.sendAccountSecurity(ctx, message, "password reset", "Passwort zurücksetzen", "Passwort zurücksetzen", "Über den folgenden Link kannst du ein neues Passwort für dein TeamTaler-Konto festlegen.", "Wenn du das Zurücksetzen nicht angefordert hast, kannst du diese E-Mail ignorieren.", "Passwort zurücksetzen")
}

// SendEmailChangeVerification validates, renders, and submits a new-mailbox
// confirmation message. It returns ErrUnavailable, validation, context, or SMTP
// transport errors.
func (s *SMTP) SendEmailChangeVerification(ctx context.Context, message AccountSecurityMessage) error {
	return s.sendAccountSecurity(ctx, message, "email change verification", "E-Mail-Adresse bestätigen", "E-Mail-Adresse bestätigen", "Bestätige über den folgenden Link deine neue E-Mail-Adresse für TeamTaler.", "Wenn du diese Änderung nicht angefordert hast, kannst du diese E-Mail ignorieren.", "E-Mail-Adresse bestätigen")
}

func (s *SMTP) sendAccountSecurity(ctx context.Context, message AccountSecurityMessage, operation, subject, title, body, ignored, actionText string) error {
	if !s.Available() {
		return fmt.Errorf("%w: SMTP is disabled", ErrUnavailable)
	}
	if ctx == nil {
		return fmt.Errorf("send %s: context is required", operation)
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("send %s: %w", operation, err)
	}
	recipient, payload, err := s.renderDesignedAccountSecurity(message, subject, title, body, ignored, actionText)
	if err != nil {
		return fmt.Errorf("send %s: %w", operation, err)
	}
	return s.sendPayload(ctx, operation, recipient, payload)
}

// SendNotification validates, renders, and submits message as one UTF-8
// multipart notification email with plain-text and HTML alternatives. ctx bounds
// dialing, TLS, authentication, and upload. It returns ErrUnavailable when SMTP
// is disabled, validation errors for unsafe or incomplete message data, context
// errors on cancellation, or wrapped transport errors. A nil result means the
// SMTP server accepted the message.
//
// Example:
//
//	err := sender.SendNotification(ctx, email.NotificationMessage{
//		ToAddress: "member@example.com",
//		GroupName: "Example Team",
//		Title: "Neue Buchung",
//		Body: "Alex hat dir eine Buchung zugewiesen.",
//		ActionURL: "https://teamtaler.example/notifications",
//	})
func (s *SMTP) SendNotification(ctx context.Context, message NotificationMessage) error {
	if !s.Available() {
		return fmt.Errorf("%w: SMTP is disabled", ErrUnavailable)
	}
	if ctx == nil {
		return errors.New("send notification: context is required")
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("send notification: %w", err)
	}
	recipient, payload, err := s.renderDesignedNotification(message)
	if err != nil {
		return fmt.Errorf("send notification: %w", err)
	}
	return s.sendPayload(ctx, "notification", recipient, payload)
}

func (s *SMTP) sendPayload(ctx context.Context, operation, recipient string, payload []byte) error {
	endpoint := net.JoinHostPort(s.configuration.Host, strconv.Itoa(s.configuration.Port))
	connection, err := s.dialContext(ctx, "tcp", endpoint)
	if err != nil {
		return fmt.Errorf("send %s: connect to SMTP server: %w", operation, contextualError(ctx, err))
	}
	defer connection.Close()
	if err := applyDeadline(ctx, connection, time.Now()); err != nil {
		return fmt.Errorf("send %s: set SMTP deadline: %w", operation, err)
	}
	stopWatching := watchCancellation(ctx, connection)
	defer stopWatching()

	client, err := s.secureClient(ctx, connection)
	if err != nil {
		return fmt.Errorf("send %s: %w", operation, contextualError(ctx, err))
	}
	defer client.Close()

	authentication := smtp.PlainAuth("", s.configuration.Username, s.configuration.Password, s.configuration.Host)
	if err := client.Auth(authentication); err != nil {
		return fmt.Errorf("send %s: authenticate with SMTP server: %w", operation, contextualError(ctx, err))
	}
	if err := client.Mail(s.configuration.FromAddress); err != nil {
		return fmt.Errorf("send %s: set SMTP sender: %w", operation, contextualError(ctx, err))
	}
	if err := client.Rcpt(recipient); err != nil {
		return fmt.Errorf("send %s: set SMTP recipient: %w", operation, contextualError(ctx, err))
	}
	writer, err := client.Data()
	if err != nil {
		return fmt.Errorf("send %s: begin SMTP message: %w", operation, contextualError(ctx, err))
	}
	if _, err := writer.Write(payload); err != nil {
		_ = writer.Close()
		return fmt.Errorf("send %s: upload SMTP message: %w", operation, contextualError(ctx, err))
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("send %s: finish SMTP message: %w", operation, contextualError(ctx, err))
	}
	// DATA completion is the SMTP acceptance boundary. A subsequent QUIT failure
	// must not cause an outbox retry and duplicate an already accepted message.
	_ = client.Quit()
	return nil
}

func (s *SMTP) secureClient(ctx context.Context, connection net.Conn) (*smtp.Client, error) {
	tlsConfiguration := &tls.Config{
		MinVersion: tls.VersionTLS12,
		ServerName: s.configuration.Host,
		RootCAs:    s.rootCAs,
	}
	if s.configuration.TLSMode == config.SMTPTLSModeTLS {
		tlsConnection := tls.Client(connection, tlsConfiguration)
		if err := tlsConnection.HandshakeContext(ctx); err != nil {
			return nil, fmt.Errorf("establish implicit TLS: %w", err)
		}
		client, err := smtp.NewClient(tlsConnection, s.configuration.Host)
		if err != nil {
			return nil, fmt.Errorf("read SMTP greeting over TLS: %w", err)
		}
		return client, nil
	}

	client, err := smtp.NewClient(connection, s.configuration.Host)
	if err != nil {
		return nil, fmt.Errorf("read SMTP greeting: %w", err)
	}
	if supported, _ := client.Extension("STARTTLS"); !supported {
		_ = client.Close()
		return nil, errors.New("SMTP server does not advertise required STARTTLS")
	}
	if err := client.StartTLS(tlsConfiguration); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("establish STARTTLS: %w", err)
	}
	if state, ok := client.TLSConnectionState(); !ok || !state.HandshakeComplete {
		_ = client.Close()
		return nil, errors.New("SMTP STARTTLS handshake did not establish a secure connection")
	}
	return client, nil
}

func validateConfiguration(configuration config.SMTPConfig) error {
	if !configuration.Enabled {
		if configuration.Host != "" || configuration.Port != 0 || configuration.Username != "" || configuration.Password != "" || configuration.FromAddress != "" || configuration.FromName != "" || configuration.TLSMode != "" {
			return errors.New("disabled SMTP configuration must not contain delivery settings")
		}
		return nil
	}
	if strings.TrimSpace(configuration.Host) == "" || len(configuration.Host) > 253 || strings.ContainsAny(configuration.Host, "\x00\r\n\t /@") {
		return errors.New("SMTP host is required and must not contain control characters, a scheme, path, or port")
	}
	if strings.Contains(configuration.Host, ":") && net.ParseIP(configuration.Host) == nil {
		return errors.New("SMTP host must be a valid hostname or IP address without a port")
	}
	if configuration.Port < 1 || configuration.Port > 65535 {
		return errors.New("SMTP port must be between 1 and 65535")
	}
	if strings.TrimSpace(configuration.Username) == "" || strings.TrimSpace(configuration.Password) == "" {
		return errors.New("SMTP username and password are required")
	}
	if strings.ContainsAny(configuration.Username, "\x00\r\n") || strings.ContainsRune(configuration.Password, '\x00') {
		return errors.New("SMTP credentials must not contain SMTP control characters")
	}
	if _, err := parseMailbox(configuration.FromAddress, "sender"); err != nil {
		return err
	}
	if len(configuration.FromName) > 120 || containsHeaderControl(configuration.FromName) {
		return errors.New("SMTP sender name must contain at most 120 characters without control characters")
	}
	if configuration.TLSMode != config.SMTPTLSModeStartTLS && configuration.TLSMode != config.SMTPTLSModeTLS {
		return errors.New("SMTP TLS mode must be starttls or tls")
	}
	return nil
}

func parseMailbox(value, field string) (string, error) {
	if containsHeaderControl(value) {
		return "", fmt.Errorf("%s address must be one ASCII mailbox address without control characters", field)
	}
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maximumAddressSize || containsHeaderControl(value) || !isASCII(value) || !strings.Contains(value, "@") {
		return "", fmt.Errorf("%s address must be one ASCII mailbox address", field)
	}
	parsed, err := mail.ParseAddress(value)
	if err != nil || parsed.Name != "" || parsed.Address != value {
		return "", fmt.Errorf("%s address must be one ASCII mailbox address without a display name", field)
	}
	return parsed.Address, nil
}

func containsHeaderControl(value string) bool {
	for _, character := range value {
		if character < 32 || character == 127 {
			return true
		}
	}
	return false
}

func isASCII(value string) bool {
	for _, character := range value {
		if character > 127 {
			return false
		}
	}
	return true
}

func applyDeadline(ctx context.Context, connection net.Conn, now time.Time) error {
	deadline := now.Add(connectionTimeout)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	return connection.SetDeadline(deadline)
}

func watchCancellation(ctx context.Context, connection net.Conn) func() {
	stopped := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = connection.SetDeadline(time.Now())
			_ = connection.Close()
		case <-stopped:
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() { close(stopped) })
	}
}

func contextualError(ctx context.Context, err error) error {
	if contextError := ctx.Err(); contextError != nil {
		return contextError
	}
	var networkError net.Error
	if deadline, ok := ctx.Deadline(); ok && !time.Now().Before(deadline) && errors.As(err, &networkError) && networkError.Timeout() {
		return context.DeadlineExceeded
	}
	return err
}
