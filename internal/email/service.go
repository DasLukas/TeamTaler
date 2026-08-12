// Package email delivers security-sensitive transactional email messages.
package email

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"net/url"
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

// InvitationMessage contains the recipient and onboarding data rendered into a
// plain-text TeamTaler invitation. ToName is optional; all other fields are
// required. ExpiresAt is rendered in UTC, and AcceptURL must be an absolute HTTP
// or HTTPS URL. Invalid addresses, header controls, URLs, or zero expiry values
// cause SendInvitation to return a validation error before any network access.
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
}

// SMTP sends invitation and notification messages through one validated SMTP endpoint. Construct
// it with NewSMTP. Its connection uses authenticated STARTTLS or implicit TLS,
// verifies the server certificate, requires TLS 1.2 or newer, and is bounded by
// both the caller context and an internal operation timeout.
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
// SendInvitation or SendNotification is called.
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
	return &SMTP{
		configuration: configuration,
		dialContext:   dialer.DialContext,
		now:           time.Now,
	}, nil
}

// Available reports whether this sender has a complete enabled SMTP
// configuration. It has no parameters, performs no I/O, and cannot fail.
func (s *SMTP) Available() bool {
	return s != nil && s.configuration.Enabled
}

// SendInvitation renders message as UTF-8 plain text and submits it to the
// configured SMTP server. ctx controls dialing, TLS negotiation, authentication,
// SMTP commands, and message upload; message supplies recipient, group, link,
// and expiry data. It returns ErrUnavailable when disabled, a validation error
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

	recipient, payload, err := s.renderInvitation(message)
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
	recipient, payload, err := s.renderJoinVerification(message)
	if err != nil {
		return fmt.Errorf("send join verification: %w", err)
	}
	return s.sendPayload(ctx, "join verification", recipient, payload)
}

// SendPasswordReset validates, renders, and submits a password-reset message.
// It returns ErrUnavailable, validation, context, or SMTP transport errors.
func (s *SMTP) SendPasswordReset(ctx context.Context, message AccountSecurityMessage) error {
	return s.sendAccountSecurity(ctx, message, "password reset", "Reset your TeamTaler password", "Choose a new password:", "If you did not request a password reset, you can ignore this email.")
}

// SendEmailChangeVerification validates, renders, and submits a new-mailbox
// confirmation message. It returns ErrUnavailable, validation, context, or SMTP
// transport errors.
func (s *SMTP) SendEmailChangeVerification(ctx context.Context, message AccountSecurityMessage) error {
	return s.sendAccountSecurity(ctx, message, "email change verification", "Confirm your TeamTaler email address", "Confirm email address:", "If you did not request this email change, you can ignore this email.")
}

func (s *SMTP) sendAccountSecurity(ctx context.Context, message AccountSecurityMessage, operation, subject, instruction, ignored string) error {
	if !s.Available() {
		return fmt.Errorf("%w: SMTP is disabled", ErrUnavailable)
	}
	if ctx == nil {
		return fmt.Errorf("send %s: context is required", operation)
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("send %s: %w", operation, err)
	}
	recipient, payload, err := s.renderAccountSecurity(message, subject, instruction, ignored)
	if err != nil {
		return fmt.Errorf("send %s: %w", operation, err)
	}
	return s.sendPayload(ctx, operation, recipient, payload)
}

// SendNotification validates, renders, and submits message as one UTF-8
// plain-text notification email. ctx bounds dialing, TLS, authentication, and
// upload. It returns ErrUnavailable when SMTP is disabled, validation errors for
// unsafe or incomplete message data, context errors on cancellation, or wrapped
// transport errors. A nil result means the SMTP server accepted the message.
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
	recipient, payload, err := s.renderNotification(message)
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

func (s *SMTP) renderInvitation(message InvitationMessage) (string, []byte, error) {
	recipient, err := parseMailbox(message.ToAddress, "recipient")
	if err != nil {
		return "", nil, err
	}
	if containsHeaderControl(message.ToName) {
		return "", nil, errors.New("recipient name must contain at most 120 characters without control characters")
	}
	toName := strings.TrimSpace(message.ToName)
	if len(toName) > 120 {
		return "", nil, errors.New("recipient name must contain at most 120 characters without control characters")
	}
	if containsHeaderControl(message.GroupName) {
		return "", nil, errors.New("group name must contain 1 to 120 characters without control characters")
	}
	groupName := strings.TrimSpace(message.GroupName)
	if groupName == "" || len(groupName) > 120 {
		return "", nil, errors.New("group name must contain 1 to 120 characters without control characters")
	}
	acceptURL := strings.TrimSpace(message.AcceptURL)
	if acceptURL == "" || len(acceptURL) > maximumURLSize || containsHeaderControl(message.AcceptURL) {
		return "", nil, errors.New("accept URL must be an absolute HTTP(S) URL without credentials")
	}
	parsedURL, err := url.Parse(acceptURL)
	if err != nil || parsedURL.Host == "" || parsedURL.User != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
		return "", nil, errors.New("accept URL must be an absolute HTTP(S) URL without credentials")
	}
	if message.ExpiresAt.IsZero() {
		return "", nil, errors.New("invitation expiry is required")
	}

	greeting := "Hello,"
	if toName != "" {
		greeting = "Hello " + toName + ","
	}
	body := strings.Join([]string{
		greeting,
		"",
		"You have been invited to join " + groupName + " on TeamTaler.",
		"",
		"Accept the invitation:",
		acceptURL,
		"",
		"This invitation expires at " + message.ExpiresAt.UTC().Format(time.RFC1123) + ".",
		"",
		"If you did not expect this invitation, you can ignore this email.",
	}, "\r\n") + "\r\n"

	var encodedBody bytes.Buffer
	quotedPrintable := quotedprintable.NewWriter(&encodedBody)
	if _, err := quotedPrintable.Write([]byte(body)); err != nil {
		return "", nil, fmt.Errorf("encode invitation body: %w", err)
	}
	if err := quotedPrintable.Close(); err != nil {
		return "", nil, fmt.Errorf("finish invitation body: %w", err)
	}

	fromHeader := (&mail.Address{Name: s.configuration.FromName, Address: s.configuration.FromAddress}).String()
	toHeader := (&mail.Address{Name: toName, Address: recipient}).String()
	subject := mime.QEncoding.Encode("utf-8", "Invitation to "+groupName)
	headers := []string{
		"Date: " + s.now().UTC().Format(time.RFC1123Z),
		"From: " + fromHeader,
		"To: " + toHeader,
		"Subject: " + subject,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: quoted-printable",
		"Auto-Submitted: auto-generated",
	}
	payload := []byte(strings.Join(headers, "\r\n") + "\r\n\r\n" + encodedBody.String())
	return recipient, payload, nil
}

func (s *SMTP) renderJoinVerification(message JoinVerificationMessage) (string, []byte, error) {
	recipient, err := parseMailbox(message.ToAddress, "recipient")
	if err != nil {
		return "", nil, err
	}
	toName := strings.TrimSpace(message.ToName)
	groupName := strings.TrimSpace(message.GroupName)
	if containsHeaderControl(message.ToName) || len(toName) > 120 {
		return "", nil, errors.New("recipient name must contain at most 120 characters without control characters")
	}
	if containsHeaderControl(message.GroupName) || groupName == "" || len(groupName) > 120 {
		return "", nil, errors.New("group name must contain 1 to 120 characters without control characters")
	}
	verifyURL := strings.TrimSpace(message.VerifyURL)
	parsedURL, err := url.Parse(verifyURL)
	if err != nil || verifyURL == "" || len(verifyURL) > maximumURLSize || containsHeaderControl(message.VerifyURL) || parsedURL.Host == "" || parsedURL.User != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
		return "", nil, errors.New("verification URL must be an absolute HTTP(S) URL without credentials")
	}
	if message.ExpiresAt.IsZero() {
		return "", nil, errors.New("verification expiry is required")
	}
	greeting := "Hello,"
	if toName != "" {
		greeting = "Hello " + toName + ","
	}
	body := strings.Join([]string{
		greeting,
		"",
		"Confirm your email address to join " + groupName + " on TeamTaler.",
		"",
		"Confirm email address:",
		verifyURL,
		"",
		"This link expires at " + message.ExpiresAt.UTC().Format(time.RFC1123) + ".",
		"",
		"If you did not request this registration, you can ignore this email.",
	}, "\r\n") + "\r\n"
	var encodedBody bytes.Buffer
	quotedPrintable := quotedprintable.NewWriter(&encodedBody)
	if _, err := quotedPrintable.Write([]byte(body)); err != nil {
		return "", nil, fmt.Errorf("encode join verification body: %w", err)
	}
	if err := quotedPrintable.Close(); err != nil {
		return "", nil, fmt.Errorf("finish join verification body: %w", err)
	}
	fromHeader := (&mail.Address{Name: s.configuration.FromName, Address: s.configuration.FromAddress}).String()
	toHeader := (&mail.Address{Name: toName, Address: recipient}).String()
	subject := mime.QEncoding.Encode("utf-8", "Confirm email for "+groupName)
	headers := []string{
		"Date: " + s.now().UTC().Format(time.RFC1123Z),
		"From: " + fromHeader,
		"To: " + toHeader,
		"Subject: " + subject,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: quoted-printable",
		"Auto-Submitted: auto-generated",
	}
	return recipient, []byte(strings.Join(headers, "\r\n") + "\r\n\r\n" + encodedBody.String()), nil
}

func (s *SMTP) renderNotification(message NotificationMessage) (string, []byte, error) {
	recipient, err := parseMailbox(message.ToAddress, "recipient")
	if err != nil {
		return "", nil, err
	}
	toName := strings.TrimSpace(message.ToName)
	groupName := strings.TrimSpace(message.GroupName)
	title := strings.TrimSpace(message.Title)
	bodyText := strings.TrimSpace(message.Body)
	for field, value := range map[string]string{"recipient name": toName, "group name": groupName, "title": title, "body": bodyText} {
		if containsHeaderControl(value) {
			return "", nil, fmt.Errorf("%s must not contain control characters", field)
		}
	}
	if len(toName) > 120 || groupName == "" || len(groupName) > 120 || title == "" || len(title) > 160 || bodyText == "" || len(bodyText) > 2000 {
		return "", nil, errors.New("notification names and copy exceed supported bounds")
	}
	actionURL := strings.TrimSpace(message.ActionURL)
	parsedURL, err := url.Parse(actionURL)
	if err != nil || parsedURL.Host == "" || parsedURL.User != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") || len(actionURL) > maximumURLSize || containsHeaderControl(actionURL) {
		return "", nil, errors.New("action URL must be an absolute HTTP(S) URL without credentials")
	}
	greeting := "Hallo,"
	if toName != "" {
		greeting = "Hallo " + toName + ","
	}
	body := strings.Join([]string{
		greeting,
		"",
		bodyText,
		"",
		"Benachrichtigungen in TeamTaler öffnen:",
		actionURL,
		"",
		"Diese E-Mail wurde automatisch für die Gruppe " + groupName + " versendet.",
	}, "\r\n") + "\r\n"

	var encodedBody bytes.Buffer
	quotedPrintable := quotedprintable.NewWriter(&encodedBody)
	if _, err := quotedPrintable.Write([]byte(body)); err != nil {
		return "", nil, fmt.Errorf("encode notification body: %w", err)
	}
	if err := quotedPrintable.Close(); err != nil {
		return "", nil, fmt.Errorf("finish notification body: %w", err)
	}
	fromHeader := (&mail.Address{Name: s.configuration.FromName, Address: s.configuration.FromAddress}).String()
	toHeader := (&mail.Address{Name: toName, Address: recipient}).String()
	subject := mime.QEncoding.Encode("utf-8", "TeamTaler · "+title)
	headers := []string{
		"Date: " + s.now().UTC().Format(time.RFC1123Z),
		"From: " + fromHeader,
		"To: " + toHeader,
		"Subject: " + subject,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: quoted-printable",
		"Auto-Submitted: auto-generated",
	}
	return recipient, []byte(strings.Join(headers, "\r\n") + "\r\n\r\n" + encodedBody.String()), nil
}

func (s *SMTP) renderAccountSecurity(message AccountSecurityMessage, subject, instruction, ignored string) (string, []byte, error) {
	recipient, err := parseMailbox(message.ToAddress, "recipient")
	if err != nil {
		return "", nil, err
	}
	toName := strings.TrimSpace(message.ToName)
	if containsHeaderControl(toName) || len(toName) > 120 {
		return "", nil, errors.New("recipient name must contain at most 120 characters without control characters")
	}
	actionURL := strings.TrimSpace(message.ActionURL)
	parsedURL, err := url.Parse(actionURL)
	if err != nil || actionURL == "" || len(actionURL) > maximumURLSize || containsHeaderControl(actionURL) || parsedURL.Host == "" || parsedURL.User != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
		return "", nil, errors.New("action URL must be an absolute HTTP(S) URL without credentials")
	}
	if message.ExpiresAt.IsZero() {
		return "", nil, errors.New("account action expiry is required")
	}
	greeting := "Hello,"
	if toName != "" {
		greeting = "Hello " + toName + ","
	}
	body := strings.Join([]string{
		greeting,
		"",
		instruction,
		actionURL,
		"",
		"This link expires at " + message.ExpiresAt.UTC().Format(time.RFC1123) + ".",
		"",
		ignored,
	}, "\r\n") + "\r\n"
	var encodedBody bytes.Buffer
	quotedPrintable := quotedprintable.NewWriter(&encodedBody)
	if _, err := quotedPrintable.Write([]byte(body)); err != nil {
		return "", nil, fmt.Errorf("encode account-security body: %w", err)
	}
	if err := quotedPrintable.Close(); err != nil {
		return "", nil, fmt.Errorf("finish account-security body: %w", err)
	}
	fromHeader := (&mail.Address{Name: s.configuration.FromName, Address: s.configuration.FromAddress}).String()
	toHeader := (&mail.Address{Name: toName, Address: recipient}).String()
	headers := []string{
		"Date: " + s.now().UTC().Format(time.RFC1123Z),
		"From: " + fromHeader,
		"To: " + toHeader,
		"Subject: " + mime.QEncoding.Encode("utf-8", subject),
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: quoted-printable",
		"Auto-Submitted: auto-generated",
	}
	return recipient, []byte(strings.Join(headers, "\r\n") + "\r\n\r\n" + encodedBody.String()), nil
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
