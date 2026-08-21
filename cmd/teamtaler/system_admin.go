package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/config"
	"github.com/DasLukas/TeamTaler/internal/email"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
	systemadmin "github.com/DasLukas/TeamTaler/internal/system"
	webpushservice "github.com/DasLukas/TeamTaler/internal/webpush"
	push "github.com/marknefedov/go-webpush/v2"
	"golang.org/x/term"
)

type localSystemRuntime struct {
	configuration     config.Config
	database          *sql.DB
	service           systemadmin.Service
	tokenBox          *platform.SecretBox
	pushSubscriptions *webpushservice.SubscriptionService
	pushSender        *webpushservice.Sender
}

type localGroupInvitationResult struct {
	Group               systemadmin.ManagedGroup `json:"group"`
	AcceptURL           string                   `json:"acceptUrl,omitempty"`
	EmailDeliveryStatus string                   `json:"emailDeliveryStatus,omitempty"`
}

func (runtime *localSystemRuntime) groupInvitationResult(item systemadmin.ManagedGroup) localGroupInvitationResult {
	result := localGroupInvitationResult{Group: item}
	if item.InvitationToken == "" {
		return result
	}
	result.AcceptURL = strings.TrimSuffix(runtime.configuration.PublicURL.String(), "/") + "/invite#token=" + url.QueryEscape(item.InvitationToken)
	result.EmailDeliveryStatus = string(item.InvitationEmailDeliveryStatus)
	return result
}

func openLocalSystemRuntime(ctx context.Context) (*localSystemRuntime, error) {
	configuration, err := config.Load()
	if err != nil {
		return nil, err
	}
	database, err := storage.Open(ctx, configuration.DatabasePath)
	if err != nil {
		return nil, err
	}
	var passwordCipher systemadmin.PasswordCipher
	var tokenBox *platform.SecretBox
	if len(configuration.EmailTokenKey) == 32 {
		passwordCipher, err = systemadmin.NewSMTPPasswordCipher(configuration.EmailTokenKey)
		if err == nil {
			box, boxErr := platform.NewSecretBox(configuration.EmailTokenKey)
			err = boxErr
			tokenBox = &box
		}
		if err != nil {
			database.Close()
			return nil, err
		}
	}
	var systemOptions []systemadmin.ServiceOption
	var pushSubscriptions *webpushservice.SubscriptionService
	var pushSender *webpushservice.Sender
	if len(configuration.PushStorageKey) == 32 {
		pushSecrets, pushErr := webpushservice.NewSecrets(configuration.PushStorageKey)
		if pushErr != nil {
			database.Close()
			return nil, pushErr
		}
		systemOptions = append(systemOptions, systemadmin.WithWebPushSecretCipher(pushSecrets))
		pushSubscriptions, pushErr = webpushservice.NewSubscriptionService(database, pushSecrets, nil)
		if pushErr != nil {
			database.Close()
			return nil, pushErr
		}
		pushSender = webpushservice.NewSender(nil)
	}
	service, err := systemadmin.NewService(database, systemadmin.DefaultsFromConfig(configuration), passwordCipher, systemOptions...)
	if err != nil {
		database.Close()
		return nil, err
	}
	return &localSystemRuntime{configuration: configuration, database: database, service: service, tokenBox: tokenBox,
		pushSubscriptions: pushSubscriptions, pushSender: pushSender}, nil
}

func (runtime *localSystemRuntime) close() { _ = runtime.database.Close() }

func systemAdministratorCommand(arguments []string) error {
	if len(arguments) == 0 {
		return errors.New("usage: teamtaler admin system-admin <list|grant|revoke>")
	}
	ctx := context.Background()
	runtime, err := openLocalSystemRuntime(ctx)
	if err != nil {
		return err
	}
	defer runtime.close()
	switch arguments[0] {
	case "list":
		flags := flag.NewFlagSet("admin system-admin list", flag.ContinueOnError)
		jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		items, err := runtime.service.ListAdministrators(ctx)
		if err != nil {
			return err
		}
		if *jsonOutput {
			return writeCommandJSON(items)
		}
		for _, item := range items {
			fmt.Printf("%s\t%s\t%s\n", item.Email, item.DisplayName, item.GrantedAt)
		}
		return nil
	case "grant", "revoke":
		flags := flag.NewFlagSet("admin system-admin "+arguments[0], flag.ContinueOnError)
		emailAddress := flags.String("email", "", "existing account email address")
		jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		if arguments[0] == "grant" {
			assignment, err := runtime.service.GrantAdministratorByEmail(ctx, *emailAddress, "")
			if err != nil {
				return err
			}
			if *jsonOutput {
				return writeCommandJSON(assignment)
			}
			fmt.Printf("SYSTEM_ADMINISTRATOR granted to %s.\n", assignment.Email)
			return nil
		}
		if err := runtime.service.RevokeAdministratorByEmail(ctx, *emailAddress, ""); err != nil {
			return err
		}
		if *jsonOutput {
			return writeCommandJSON(map[string]any{"email": strings.ToLower(strings.TrimSpace(*emailAddress)), "revoked": true})
		}
		fmt.Printf("SYSTEM_ADMINISTRATOR revoked from %s.\n", strings.ToLower(strings.TrimSpace(*emailAddress)))
		return nil
	default:
		return fmt.Errorf("unknown system-admin command %q", arguments[0])
	}
}

func systemCommand(arguments []string) error {
	if len(arguments) < 2 {
		return errors.New("usage: teamtaler admin system <settings|smtp|web-push|groups> <command>")
	}
	ctx := context.Background()
	runtime, err := openLocalSystemRuntime(ctx)
	if err != nil {
		return err
	}
	defer runtime.close()
	switch arguments[0] {
	case "settings":
		return systemSettingsCommand(ctx, runtime, arguments[1:])
	case "smtp":
		return systemSMTPCommand(ctx, runtime, arguments[1:])
	case "web-push":
		return systemWebPushCommand(ctx, runtime, arguments[1:])
	case "groups":
		return systemGroupsCommand(ctx, runtime, arguments[1:])
	default:
		return fmt.Errorf("unknown system command %q", arguments[0])
	}
}

func systemSettingsCommand(ctx context.Context, runtime *localSystemRuntime, arguments []string) error {
	if len(arguments) == 0 {
		return errors.New("usage: teamtaler admin system settings <show|set|reset>")
	}
	switch arguments[0] {
	case "show":
		flags := flag.NewFlagSet("admin system settings show", flag.ContinueOnError)
		jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		settings, err := runtime.service.GetSettings(ctx)
		if err != nil {
			return err
		}
		if *jsonOutput {
			return writeCommandJSON(settings)
		}
		fmt.Printf("Revision: %d\nInstance name: %s (%s)\nDefault currency: %s (%s)\nMedia upload bytes: %d (%s; allowed maximum %d)\nAttachment upload bytes: %d (%s; allowed maximum %d)\nPublic join: %t\nMaintenance: %t\n",
			settings.Revision, settings.InstanceName.Value, settings.InstanceName.Source,
			settings.DefaultCurrency.Value, settings.DefaultCurrency.Source,
			settings.MediaUploadMaxBytes.Value, settings.MediaUploadMaxBytes.Source, settings.MediaUploadHardLimitBytes,
			settings.AttachmentUploadMaxBytes.Value, settings.AttachmentUploadMaxBytes.Source, settings.AttachmentUploadHardLimitBytes,
			settings.PublicJoinEnabled.Value, settings.MaintenanceMode.Value)
		return nil
	case "set":
		flags := flag.NewFlagSet("admin system settings set", flag.ContinueOnError)
		revision := flags.Int64("revision", 0, "expected settings revision (defaults to current)")
		instanceName := flags.String("instance-name", "", "instance display name")
		currency := flags.String("default-currency", "", "default three-letter currency")
		mediaBytes := flags.Int64("media-upload-max-bytes", 0, "whole-MiB raw media limit in bytes (1048576 through 26214400)")
		attachmentBytes := flags.Int64("attachment-upload-max-bytes", 0, "whole-MiB receipt limit in bytes (1048576 through 52428800)")
		publicJoin := flags.String("public-join-enabled", "", "true or false")
		maintenance := flags.String("maintenance-mode", "", "true or false")
		maintenanceMessage := flags.String("maintenance-message", "", "short maintenance notice")
		jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		visited := visitedFlags(flags)
		patch := systemadmin.SettingsPatch{}
		if visited["instance-name"] {
			patch.InstanceName = instanceName
		}
		if visited["default-currency"] {
			patch.DefaultCurrency = currency
		}
		if visited["media-upload-max-bytes"] {
			patch.MediaUploadMaxBytes = mediaBytes
		}
		if visited["attachment-upload-max-bytes"] {
			patch.AttachmentUploadMaxBytes = attachmentBytes
		}
		if visited["public-join-enabled"] {
			value, err := strconv.ParseBool(*publicJoin)
			if err != nil {
				return fmt.Errorf("public-join-enabled must be true or false")
			}
			patch.PublicJoinEnabled = &value
		}
		if visited["maintenance-mode"] {
			value, err := strconv.ParseBool(*maintenance)
			if err != nil {
				return fmt.Errorf("maintenance-mode must be true or false")
			}
			patch.MaintenanceMode = &value
		}
		if visited["maintenance-message"] {
			patch.MaintenanceMessage = maintenanceMessage
		}
		if patch.InstanceName == nil && patch.DefaultCurrency == nil && patch.MediaUploadMaxBytes == nil && patch.AttachmentUploadMaxBytes == nil &&
			patch.PublicJoinEnabled == nil && patch.MaintenanceMode == nil && patch.MaintenanceMessage == nil {
			return errors.New("at least one system setting flag is required")
		}
		expected, err := effectiveCLIRevision(ctx, runtime.service, *revision)
		if err != nil {
			return err
		}
		settings, err := runtime.service.UpdateSettingsLocally(ctx, expected, patch)
		if err != nil {
			return err
		}
		if *jsonOutput {
			return writeCommandJSON(settings)
		}
		fmt.Printf("System settings updated to revision %d.\n", settings.Revision)
		return nil
	case "reset":
		flags := flag.NewFlagSet("admin system settings reset", flag.ContinueOnError)
		revision := flags.Int64("revision", 0, "expected settings revision (defaults to current)")
		var keys settingKeyList
		flags.Var(&keys, "key", "setting key to reset (repeatable)")
		jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		if len(keys) == 0 {
			return errors.New("at least one --key is required")
		}
		expected, err := effectiveCLIRevision(ctx, runtime.service, *revision)
		if err != nil {
			return err
		}
		settings, err := runtime.service.ResetSettingsLocally(ctx, expected, keys)
		if err != nil {
			return err
		}
		if *jsonOutput {
			return writeCommandJSON(settings)
		}
		fmt.Printf("System settings reset to revision %d.\n", settings.Revision)
		return nil
	default:
		return fmt.Errorf("unknown system settings command %q", arguments[0])
	}
}

func systemSMTPCommand(ctx context.Context, runtime *localSystemRuntime, arguments []string) error {
	if len(arguments) == 0 {
		return errors.New("usage: teamtaler admin system smtp <show|set|test|reset>")
	}
	switch arguments[0] {
	case "show":
		flags := flag.NewFlagSet("admin system smtp show", flag.ContinueOnError)
		jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		settings, err := runtime.service.GetSettings(ctx)
		if err != nil {
			return err
		}
		if *jsonOutput {
			return writeCommandJSON(settings.SMTP)
		}
		fmt.Printf("SMTP revision: %d\nEnabled: %t\nActive: %t\nHost: %s:%d\nTLS: %s\nUsername: %s\nPassword configured: %t\nFrom: %s (%s)\nRequires test: %t\n",
			settings.SMTP.Revision, settings.SMTP.Enabled.Value, settings.SMTP.Active,
			settings.SMTP.Host.Value, settings.SMTP.Port.Value, settings.SMTP.TLSMode.Value,
			settings.SMTP.Username.Value, settings.SMTP.Password.Configured,
			settings.SMTP.FromAddress.Value, settings.SMTP.FromName.Value, settings.SMTP.RequiresTest)
		return nil
	case "set":
		flags := flag.NewFlagSet("admin system smtp set", flag.ContinueOnError)
		revision := flags.Int64("revision", 0, "expected settings revision (defaults to current)")
		enabled := flags.String("enabled", "", "true or false")
		host := flags.String("host", "", "SMTP host")
		port := flags.Int("port", 0, "SMTP port")
		tlsMode := flags.String("tls-mode", "", "starttls or tls")
		username := flags.String("username", "", "SMTP username")
		fromAddress := flags.String("from-address", "", "sender mailbox")
		fromName := flags.String("from-name", "", "sender display name")
		passwordStdin := flags.Bool("password-stdin", false, "read SMTP password from stdin or TTY")
		jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		visited := visitedFlags(flags)
		patch := systemadmin.SMTPPatch{}
		if visited["enabled"] {
			value, err := strconv.ParseBool(*enabled)
			if err != nil {
				return fmt.Errorf("enabled must be true or false")
			}
			patch.Enabled = &value
		}
		if visited["host"] {
			patch.Host = host
		}
		if visited["port"] {
			patch.Port = port
		}
		if visited["tls-mode"] {
			value := systemadmin.SMTPTLSMode(*tlsMode)
			patch.TLSMode = &value
		}
		if visited["username"] {
			patch.Username = username
		}
		if visited["from-address"] {
			patch.FromAddress = fromAddress
		}
		if visited["from-name"] {
			patch.FromName = fromName
		}
		password := ""
		if *passwordStdin {
			secret, readErr := readAdminSecret(os.Stdin, os.Stderr, "SMTP password: ")
			if readErr != nil {
				return readErr
			}
			password = secret
		}
		if password != "" {
			patch.Password = &password
		}
		if patch.Enabled == nil && patch.Host == nil && patch.Port == nil && patch.TLSMode == nil &&
			patch.Username == nil && patch.Password == nil && patch.FromAddress == nil && patch.FromName == nil {
			return errors.New("at least one SMTP setting flag is required")
		}
		expected, err := effectiveCLIRevision(ctx, runtime.service, *revision)
		if err != nil {
			return err
		}
		settings, err := runtime.service.UpdateSettingsLocally(ctx, expected, systemadmin.SettingsPatch{SMTP: &patch})
		if err != nil {
			return err
		}
		if *jsonOutput {
			return writeCommandJSON(settings.SMTP)
		}
		fmt.Printf("SMTP settings updated at system revision %d; active=%t, requiresTest=%t.\n", settings.Revision, settings.SMTP.Active, settings.SMTP.RequiresTest)
		return nil
	case "test":
		flags := flag.NewFlagSet("admin system smtp test", flag.ContinueOnError)
		recipient := flags.String("email", "", "active system-administrator recipient email")
		jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		administrator, err := localSystemActor(ctx, runtime.service, *recipient)
		if err != nil {
			return err
		}
		settings, configuration, err := runtime.service.ResolveRuntime(ctx)
		if err != nil {
			return err
		}
		if !settings.SMTP.ConfigurationValid {
			return errors.New("SMTP configuration is incomplete or invalid")
		}
		configuration.Enabled = true
		sender, err := email.NewSMTP(cliSMTPConfig(configuration))
		if err == nil {
			err = sender.SendNotification(ctx, email.NotificationMessage{
				ToAddress: administrator.Email, GroupName: settings.InstanceName.Value,
				Title: "SMTP configuration test", Body: "This message confirms the current TeamTaler SMTP configuration.",
				ActionURL: strings.TrimSuffix(runtime.configuration.PublicURL.String(), "/") + "/admin",
			})
		}
		if err != nil {
			if settings.SMTP.RequiresTest {
				_, stateErr := runtime.service.MarkSMTPTestFailedLocally(ctx, settings.Revision, settings.SMTP.Revision)
				return errors.Join(err, stateErr)
			}
			return err
		}
		if !settings.SMTP.RequiresTest {
			if *jsonOutput {
				return writeCommandJSON(settings.SMTP)
			}
			fmt.Println("Host-default SMTP configuration tested successfully.")
			return nil
		}
		settings, err = runtime.service.MarkSMTPTestedLocally(ctx, settings.Revision, settings.SMTP.Revision)
		if err != nil {
			return err
		}
		if *jsonOutput {
			return writeCommandJSON(settings.SMTP)
		}
		fmt.Printf("SMTP revision %d tested successfully.\n", settings.SMTP.Revision)
		return nil
	case "reset":
		settings, err := runtime.service.GetSettings(ctx)
		if err != nil {
			return err
		}
		keys := []systemadmin.SettingKey{
			systemadmin.SettingSMTPEnabled, systemadmin.SettingSMTPHost, systemadmin.SettingSMTPPort,
			systemadmin.SettingSMTPTLSMode, systemadmin.SettingSMTPUsername, systemadmin.SettingSMTPPassword,
			systemadmin.SettingSMTPFromAddress, systemadmin.SettingSMTPFromName,
		}
		updated, err := runtime.service.ResetSettingsLocally(ctx, settings.Revision, keys)
		if err != nil {
			return err
		}
		fmt.Printf("SMTP settings reset at system revision %d.\n", updated.Revision)
		return nil
	default:
		return fmt.Errorf("unknown system smtp command %q", arguments[0])
	}
}

// systemWebPushCommand manages redacted VAPID configuration and trusted test
// deliveries. Private keys are accepted only from stdin and are never printed.
func systemWebPushCommand(ctx context.Context, runtime *localSystemRuntime, arguments []string) error {
	if len(arguments) == 0 {
		return errors.New("usage: teamtaler admin system web-push <show|set|generate|test|reset>")
	}
	switch arguments[0] {
	case "show":
		flags := flag.NewFlagSet("admin system web-push show", flag.ContinueOnError)
		jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		settings, err := runtime.service.GetSettings(ctx)
		if err != nil {
			return err
		}
		if *jsonOutput {
			return writeCommandJSON(settings.WebPush)
		}
		fmt.Printf("Web Push revision: %d\nEnabled: %t\nActive: %t\nSubject: %s\nPrivate key configured: %t\nStorage key configured: %t\nPublic key: %s\nKey ID: %s\n",
			settings.WebPush.Revision, settings.WebPush.Enabled.Value, settings.WebPush.Active,
			settings.WebPush.Subject.Value, settings.WebPush.VAPIDPrivateKey.Configured,
			settings.WebPush.StorageKeyConfigured, settings.WebPush.PublicKey, settings.WebPush.KeyID)
		return nil
	case "set":
		flags := flag.NewFlagSet("admin system web-push set", flag.ContinueOnError)
		revision := flags.Int64("revision", 0, "expected settings revision (defaults to current)")
		enabled := flags.String("enabled", "", "true or false")
		subject := flags.String("subject", "", "HTTPS or mailto VAPID subject")
		privateKeyStdin := flags.Bool("private-key-stdin", false, "read the VAPID private key from stdin or TTY")
		confirmRotation := flags.Bool("confirm-rotation", false, "confirm replacing an existing VAPID key")
		jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		visited := visitedFlags(flags)
		patch := systemadmin.WebPushPatch{}
		checkedRevision := int64(0)
		if visited["enabled"] {
			value, err := strconv.ParseBool(*enabled)
			if err != nil {
				return fmt.Errorf("enabled must be true or false")
			}
			patch.Enabled = &value
		}
		if visited["subject"] {
			patch.Subject = subject
		}
		if *privateKeyStdin {
			current, currentErr := runtime.service.GetSettings(ctx)
			if currentErr != nil {
				return currentErr
			}
			if current.WebPush.VAPIDPrivateKey.Configured && !*confirmRotation {
				return errors.New("--confirm-rotation is required to replace the existing VAPID key")
			}
			checkedRevision = current.Revision
			privateKey, err := readAdminSecret(os.Stdin, os.Stderr, "VAPID private key: ")
			if err != nil {
				return err
			}
			patch.VAPIDPrivateKey = &privateKey
		}
		if patch.Enabled == nil && patch.Subject == nil && patch.VAPIDPrivateKey == nil {
			return errors.New("at least one Web Push setting flag is required")
		}
		expected := *revision
		if expected <= 0 && checkedRevision > 0 {
			expected = checkedRevision
		} else if expected <= 0 {
			var revisionErr error
			expected, revisionErr = effectiveCLIRevision(ctx, runtime.service, expected)
			if revisionErr != nil {
				return revisionErr
			}
		}
		settings, err := runtime.service.UpdateSettingsLocally(ctx, expected, systemadmin.SettingsPatch{WebPush: &patch})
		if err != nil {
			return err
		}
		if *jsonOutput {
			return writeCommandJSON(settings.WebPush)
		}
		fmt.Printf("Web Push settings updated at system revision %d; active=%t.\n", settings.Revision, settings.WebPush.Active)
		return nil
	case "generate":
		flags := flag.NewFlagSet("admin system web-push generate", flag.ContinueOnError)
		revision := flags.Int64("revision", 0, "expected settings revision (defaults to current)")
		confirmRotation := flags.Bool("confirm-rotation", false, "confirm replacing an existing VAPID key")
		jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		current, err := runtime.service.GetSettings(ctx)
		if err != nil {
			return err
		}
		if current.WebPush.VAPIDPrivateKey.Configured && !*confirmRotation {
			return errors.New("--confirm-rotation is required to replace the existing VAPID key")
		}
		privateKey, _, _, err := webpushservice.GenerateVAPIDKey()
		if err != nil {
			return err
		}
		expected := *revision
		if expected <= 0 {
			expected = current.Revision
		}
		settings, err := runtime.service.UpdateSettingsLocally(ctx, expected, systemadmin.SettingsPatch{
			WebPush: &systemadmin.WebPushPatch{VAPIDPrivateKey: &privateKey},
		})
		if err != nil {
			return err
		}
		if *jsonOutput {
			return writeCommandJSON(settings.WebPush)
		}
		fmt.Printf("VAPID key generated at Web Push revision %d. Public key: %s\nKey ID: %s\n",
			settings.WebPush.Revision, settings.WebPush.PublicKey, settings.WebPush.KeyID)
		return nil
	case "test":
		flags := flag.NewFlagSet("admin system web-push test", flag.ContinueOnError)
		emailAddress := flags.String("email", "", "active system-administrator account owning the browser subscription")
		subscriptionID := flags.String("subscription-id", "", "specific owned device ID (defaults to most recently used)")
		jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		if runtime.pushSubscriptions == nil || runtime.pushSender == nil {
			return errors.New("Web Push storage is unavailable; configure TEAMTALER_PUSH_STORAGE_KEY")
		}
		administrator, err := localSystemActor(ctx, runtime.service, *emailAddress)
		if err != nil {
			return err
		}
		settings, configuration, err := runtime.service.ResolveWebPush(ctx)
		if err != nil {
			return err
		}
		if !configuration.Enabled {
			return errors.New("Web Push configuration is not active")
		}
		subscriptions, err := runtime.pushSubscriptions.ListActiveForUser(ctx, administrator.UserID, configuration.KeyID)
		if err != nil {
			return err
		}
		var selected *webpushservice.StoredSubscription
		for index := range subscriptions {
			if *subscriptionID == "" || subscriptions[index].ID == *subscriptionID {
				selected = &subscriptions[index]
				break
			}
		}
		if selected == nil {
			return errors.New("no matching active Web Push subscription exists for that administrator")
		}
		payload, _ := json.Marshal(map[string]string{
			"groupName": settings.InstanceName.Value, "eventLabel": "Web Push test notification", "route": "/account",
		})
		if err := runtime.pushSender.Send(ctx, payload, selected.Subscription, configuration.Subject,
			configuration.VAPIDPrivateKey, 5*time.Minute, push.UrgencyNormal); err != nil {
			return err
		}
		if err := runtime.pushSubscriptions.MarkUsed(ctx, selected.ID); err != nil {
			return err
		}
		if *jsonOutput {
			return writeCommandJSON(map[string]any{"delivered": true, "subscriptionId": selected.ID})
		}
		fmt.Printf("Web Push test delivered to subscription %s.\n", selected.ID)
		return nil
	case "reset":
		flags := flag.NewFlagSet("admin system web-push reset", flag.ContinueOnError)
		revision := flags.Int64("revision", 0, "expected settings revision (defaults to current)")
		jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		expected, err := effectiveCLIRevision(ctx, runtime.service, *revision)
		if err != nil {
			return err
		}
		settings, err := runtime.service.ResetSettingsLocally(ctx, expected, []systemadmin.SettingKey{
			systemadmin.SettingWebPushEnabled, systemadmin.SettingWebPushSubject, systemadmin.SettingWebPushVAPIDPrivateKey,
		})
		if err != nil {
			return err
		}
		if *jsonOutput {
			return writeCommandJSON(settings.WebPush)
		}
		fmt.Printf("Web Push settings reset at system revision %d.\n", settings.Revision)
		return nil
	default:
		return fmt.Errorf("unknown system web-push command %q", arguments[0])
	}
}

func systemGroupsCommand(ctx context.Context, runtime *localSystemRuntime, arguments []string) error {
	if len(arguments) == 0 {
		return errors.New("usage: teamtaler admin system groups <list|create|archive|restore|purge>")
	}
	switch arguments[0] {
	case "list":
		flags := flag.NewFlagSet("admin system groups list", flag.ContinueOnError)
		actorEmail := flags.String("actor-email", "", "active system administrator performing the command")
		jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		actor, err := localSystemActor(ctx, runtime.service, *actorEmail)
		if err != nil {
			return err
		}
		items, err := runtime.service.ListGroups(ctx, actor.UserID)
		if err != nil {
			return err
		}
		if *jsonOutput {
			return writeCommandJSON(items)
		}
		for _, item := range items {
			fmt.Printf("%s\t%s\t%s\tv%d\n", item.ID, item.Name, item.Status, item.Version)
		}
		return nil
	case "create":
		flags := flag.NewFlagSet("admin system groups create", flag.ContinueOnError)
		actorEmail := flags.String("actor-email", "", "active system administrator performing the command")
		name := flags.String("name", "", "group name")
		currency := flags.String("currency", "", "three-letter currency (defaults to instance setting)")
		administratorEmail := flags.String("initial-admin-email", "", "initial group administrator email")
		jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		actor, err := localSystemActor(ctx, runtime.service, *actorEmail)
		if err != nil {
			return err
		}
		if *currency == "" {
			settings, err := runtime.service.GetSettings(ctx)
			if err != nil {
				return err
			}
			*currency = settings.DefaultCurrency.Value
		}
		item, err := runtime.service.CreateGroup(ctx, actor.UserID, systemadmin.CreateGroupInput{Name: *name, Currency: *currency, InitialAdministratorEmail: *administratorEmail}, runtime.tokenBox)
		if err != nil {
			return err
		}
		result := runtime.groupInvitationResult(item)
		if *jsonOutput {
			return writeCommandJSON(result)
		}
		fmt.Printf("Group %s created with status %s.\n", item.ID, item.Status)
		if result.AcceptURL != "" {
			fmt.Printf("Invitation link: %s\n", result.AcceptURL)
			if result.EmailDeliveryStatus == "PENDING" {
				fmt.Println("Email delivery queued.")
			} else {
				fmt.Println("Email delivery was not requested; share the invitation link manually.")
			}
		}
		return nil
	case "archive", "restore":
		flags := flag.NewFlagSet("admin system groups "+arguments[0], flag.ContinueOnError)
		actorEmail := flags.String("actor-email", "", "active system administrator performing the command")
		groupID := flags.String("id", "", "group identifier")
		revision := flags.Int64("revision", 0, "expected group version")
		jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		actor, err := localSystemActor(ctx, runtime.service, *actorEmail)
		if err != nil {
			return err
		}
		var item systemadmin.ManagedGroup
		if arguments[0] == "archive" {
			item, err = runtime.service.ArchiveGroup(ctx, actor.UserID, *groupID, *revision)
		} else {
			item, err = runtime.service.RestoreGroup(ctx, actor.UserID, *groupID, *revision)
		}
		if err != nil {
			return err
		}
		if *jsonOutput {
			return writeCommandJSON(item)
		}
		fmt.Printf("Group %s is now %s (version %d).\n", item.ID, item.Status, item.Version)
		return nil
	case "purge":
		flags := flag.NewFlagSet("admin system groups purge", flag.ContinueOnError)
		actorEmail := flags.String("actor-email", "", "active system administrator performing the command")
		groupID := flags.String("id", "", "group identifier")
		revision := flags.Int64("revision", 0, "expected group version")
		confirmName := flags.String("confirm-name", "", "exact group name for noninteractive use")
		jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		actor, err := localSystemActor(ctx, runtime.service, *actorEmail)
		if err != nil {
			return err
		}
		if *confirmName == "" && term.IsTerminal(int(os.Stdin.Fd())) {
			fmt.Fprint(os.Stderr, "Exact group name: ")
			line, _ := bufio.NewReader(io.LimitReader(os.Stdin, 1024)).ReadString('\n')
			*confirmName = strings.TrimSpace(line)
		}
		impact, err := runtime.service.PurgeGroupLocally(ctx, actor.UserID, *groupID, systemadmin.PurgeGroupInput{
			ExpectedVersion: *revision, GroupName: *confirmName,
		})
		var maintenanceWarning *systemadmin.PurgePostCommitWarning
		if err != nil && !errors.As(err, &maintenanceWarning) {
			return err
		}
		if maintenanceWarning != nil {
			fmt.Fprintf(os.Stderr, "Warning: %v\n", maintenanceWarning)
		}
		_, _ = runtime.service.RunMediaGarbageCollection(ctx, runtime.configuration.DataDirectory, 1000)
		if *jsonOutput {
			return writeCommandJSON(impact)
		}
		fmt.Printf("Group %s (%s) permanently purged.\n", impact.GroupID, impact.GroupName)
		return nil
	default:
		return fmt.Errorf("unknown system groups command %q", arguments[0])
	}
}

func cliSMTPConfig(value systemadmin.SMTPConfiguration) config.SMTPConfig {
	return config.SMTPConfig{
		Enabled: value.Enabled, Host: value.Host, Port: value.Port, Username: value.Username,
		Password: value.Password, FromAddress: value.FromAddress, FromName: value.FromName,
		TLSMode:             config.SMTPTLSMode(value.TLSMode),
		AllowPrivateNetwork: value.AllowPrivateNetwork, AllowedPrivateHost: value.AllowedPrivateHost,
		AllowedPrivatePort: value.AllowedPrivatePort,
	}
}

func localSystemActor(ctx context.Context, service systemadmin.Service, requestedEmail string) (systemadmin.RoleAssignment, error) {
	items, err := service.ListAdministrators(ctx)
	if err != nil {
		return systemadmin.RoleAssignment{}, err
	}
	requestedEmail = strings.ToLower(strings.TrimSpace(requestedEmail))
	active := make([]systemadmin.RoleAssignment, 0, len(items))
	for _, item := range items {
		if !item.Active {
			continue
		}
		active = append(active, item)
		if requestedEmail != "" && strings.EqualFold(item.Email, requestedEmail) {
			return item, nil
		}
	}
	if requestedEmail != "" {
		return systemadmin.RoleAssignment{}, fmt.Errorf("active system administrator %q was not found", requestedEmail)
	}
	if len(active) == 1 {
		return active[0], nil
	}
	if len(active) == 0 {
		return systemadmin.RoleAssignment{}, errors.New("no active system administrator exists; grant one first")
	}
	return systemadmin.RoleAssignment{}, errors.New("multiple active system administrators exist; select one with --actor-email (or --email for smtp test)")
}

func effectiveCLIRevision(ctx context.Context, service systemadmin.Service, revision int64) (int64, error) {
	if revision > 0 {
		return revision, nil
	}
	settings, err := service.GetSettings(ctx)
	return settings.Revision, err
}

func visitedFlags(flags *flag.FlagSet) map[string]bool {
	visited := make(map[string]bool)
	flags.Visit(func(item *flag.Flag) { visited[item.Name] = true })
	return visited
}

type settingKeyList []systemadmin.SettingKey

func (values *settingKeyList) String() string {
	items := make([]string, len(*values))
	for index, item := range *values {
		items[index] = string(item)
	}
	return strings.Join(items, ",")
}

func (values *settingKeyList) Set(value string) error {
	*values = append(*values, systemadmin.SettingKey(strings.TrimSpace(value)))
	return nil
}

func writeCommandJSON(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func readAdminSecret(input *os.File, output io.Writer, prompt string) (string, error) {
	var value string
	if term.IsTerminal(int(input.Fd())) {
		fmt.Fprint(output, prompt)
		encoded, err := term.ReadPassword(int(input.Fd()))
		fmt.Fprintln(output)
		if err != nil {
			return "", fmt.Errorf("read secret: %w", err)
		}
		value = string(encoded)
	} else {
		line, err := bufio.NewReader(io.LimitReader(input, 4097)).ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return "", fmt.Errorf("read secret: %w", err)
		}
		value = line
	}
	value = strings.TrimSuffix(value, "\n")
	value = strings.TrimSuffix(value, "\r")
	if value == "" {
		return "", errors.New("secret input is required")
	}
	return value, nil
}
