package email

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/DasLukas/TeamTaler/internal/config"
)

// ConfigurationResolver loads the effective SMTP configuration and reports
// whether delivery is temporarily paused. Implementations should resolve
// persisted settings on every call so CLI and web changes become effective
// without restarting the process. Returned errors must not contain secrets.
type ConfigurationResolver func(context.Context) (configuration config.SMTPConfig, paused bool, err error)

// DynamicSender resolves the effective SMTP settings before availability
// checks and sends. It reuses an SMTP client only while the complete effective
// configuration is unchanged and never exposes the configured password.
type DynamicSender struct {
	resolver ConfigurationResolver
	mu       sync.Mutex
	current  config.SMTPConfig
	sender   *SMTP
}

var (
	_ Sender                 = (*DynamicSender)(nil)
	_ JoinVerificationSender = (*DynamicSender)(nil)
	_ AccountSecuritySender  = (*DynamicSender)(nil)
)

// NewDynamicSender constructs a hot-reloadable transactional sender. resolver
// is invoked before every job claim and again immediately before a send. The
// function performs no I/O and returns an error when resolver is nil.
func NewDynamicSender(resolver ConfigurationResolver) (*DynamicSender, error) {
	if resolver == nil {
		return nil, errors.New("create dynamic email sender: configuration resolver is required")
	}
	return &DynamicSender{resolver: resolver}, nil
}

// Available reports whether the current effective configuration is enabled,
// tested, and not paused. Resolver failures safely make delivery unavailable.
func (s *DynamicSender) Available() bool {
	_, err := s.resolve(context.Background())
	return err == nil
}

// SendInvitation delivers one invitation using the latest effective settings.
func (s *DynamicSender) SendInvitation(ctx context.Context, message InvitationMessage) error {
	sender, err := s.resolve(ctx)
	if err != nil {
		return err
	}
	return sender.SendInvitation(ctx, message)
}

// SendNotification delivers one notification using the latest effective settings.
func (s *DynamicSender) SendNotification(ctx context.Context, message NotificationMessage) error {
	sender, err := s.resolve(ctx)
	if err != nil {
		return err
	}
	return sender.SendNotification(ctx, message)
}

// SendJoinVerification delivers one public-join verification using the latest settings.
func (s *DynamicSender) SendJoinVerification(ctx context.Context, message JoinVerificationMessage) error {
	sender, err := s.resolve(ctx)
	if err != nil {
		return err
	}
	return sender.SendJoinVerification(ctx, message)
}

// SendPasswordReset delivers one password-reset message using the latest settings.
func (s *DynamicSender) SendPasswordReset(ctx context.Context, message AccountSecurityMessage) error {
	sender, err := s.resolve(ctx)
	if err != nil {
		return err
	}
	return sender.SendPasswordReset(ctx, message)
}

// SendEmailChangeVerification delivers one email-change verification using the latest settings.
func (s *DynamicSender) SendEmailChangeVerification(ctx context.Context, message AccountSecurityMessage) error {
	sender, err := s.resolve(ctx)
	if err != nil {
		return err
	}
	return sender.SendEmailChangeVerification(ctx, message)
}

func (s *DynamicSender) resolve(ctx context.Context) (*SMTP, error) {
	if s == nil || s.resolver == nil {
		return nil, fmt.Errorf("%w: dynamic sender is not configured", ErrUnavailable)
	}
	configuration, paused, err := s.resolver(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: effective SMTP settings could not be loaded", ErrUnavailable)
	}
	if paused || !configuration.Enabled {
		return nil, fmt.Errorf("%w: SMTP delivery is disabled or paused", ErrUnavailable)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sender != nil && s.current == configuration {
		return s.sender, nil
	}
	sender, err := NewSMTP(configuration)
	if err != nil {
		return nil, fmt.Errorf("%w: effective SMTP settings are invalid", ErrUnavailable)
	}
	s.current = configuration
	s.sender = sender
	return sender, nil
}
