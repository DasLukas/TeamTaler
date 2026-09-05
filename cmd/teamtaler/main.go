// Command teamtaler runs and operates the TeamTaler server.
package main

import (
	"bufio"
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/backup"
	"github.com/DasLukas/TeamTaler/internal/config"
	"github.com/DasLukas/TeamTaler/internal/email"
	"github.com/DasLukas/TeamTaler/internal/exporting"
	"github.com/DasLukas/TeamTaler/internal/exportnotifications"
	"github.com/DasLukas/TeamTaler/internal/httpapi"
	"github.com/DasLukas/TeamTaler/internal/notifications"
	planningservice "github.com/DasLukas/TeamTaler/internal/planning"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
	systemadmin "github.com/DasLukas/TeamTaler/internal/system"
	webpushservice "github.com/DasLukas/TeamTaler/internal/webpush"
	"golang.org/x/term"
)

var (
	version = "dev"
	commit  = "unknown"
	date    = "unknown"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		slog.Error("command failed", "error", err)
		os.Exit(1)
	}
}

func run(arguments []string) error {
	if len(arguments) == 0 {
		return errors.New("usage: teamtaler <serve|version|healthcheck|admin|backup|restore>")
	}
	switch arguments[0] {
	case "serve":
		return serve(arguments[1:])
	case "version":
		if date == "" || date == "unknown" {
			fmt.Printf("TeamTaler %s (commit %s)\n", version, commit)
		} else {
			fmt.Printf("TeamTaler %s (commit %s, built %s)\n", version, commit, date)
		}
		return nil
	case "healthcheck":
		return healthcheck(arguments[1:])
	case "admin":
		return admin(arguments[1:])
	case "backup":
		return backupCommand(arguments[1:])
	case "restore":
		return restoreCommand(arguments[1:])
	default:
		return fmt.Errorf("unknown command %q", arguments[0])
	}
}

func serve(arguments []string) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	processContext, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	db, err := storage.Open(processContext, cfg.DatabasePath)
	if err != nil {
		return err
	}
	defer db.Close()
	var smtpPasswordCipher systemadmin.PasswordCipher
	if len(cfg.EmailTokenKey) == 32 {
		smtpPasswordCipher, err = systemadmin.NewSMTPPasswordCipher(cfg.EmailTokenKey)
		if err != nil {
			return fmt.Errorf("configure SMTP password encryption: %w", err)
		}
	}
	var systemOptions []systemadmin.ServiceOption
	var pushSecrets *webpushservice.Secrets
	if len(cfg.PushStorageKey) == 32 {
		var pushErr error
		pushSecrets, pushErr = webpushservice.NewSecrets(cfg.PushStorageKey)
		if pushErr != nil {
			return fmt.Errorf("configure Web Push secret encryption: %w", pushErr)
		}
		systemOptions = append(systemOptions, systemadmin.WithWebPushSecretCipher(pushSecrets))
	}
	systemService, err := systemadmin.NewService(db, systemadmin.DefaultsFromConfig(cfg), smtpPasswordCipher, systemOptions...)
	if err != nil {
		return fmt.Errorf("configure system administration: %w", err)
	}
	go runMediaGarbageCollector(processContext, systemService, cfg.DataDirectory, slog.Default())

	emailInfrastructureAvailable := len(cfg.EmailTokenKey) == 32
	pushInfrastructureAvailable := pushSecrets != nil
	notificationService := notifications.Service{DB: db, EmailDeliveryAvailable: emailInfrastructureAvailable, PushDeliveryAvailable: pushInfrastructureAvailable}
	notificationService.ResolveTimeZone = systemService.ResolveTimeZoneTx
	notificationService.ResolveChannelAvailability = func(ctx context.Context, tx *sql.Tx) (notifications.ChannelAvailability, error) {
		availability, err := systemService.ResolveNotificationChannelsTx(ctx, tx)
		if err != nil {
			return notifications.ChannelAvailability{}, err
		}
		return notifications.ChannelAvailability{
			EmailAvailable: emailInfrastructureAvailable && availability.EmailActive,
			PushAvailable:  pushInfrastructureAvailable && availability.WebPushActive,
			PushKeyID:      availability.WebPushKeyID,
		}, nil
	}
	reminderWorker, err := notifications.NewReminderWorker(db, notificationService, slog.Default())
	if err != nil {
		return fmt.Errorf("configure settlement reminder worker: %w", err)
	}
	planningWorker, err := notifications.NewPlanningWorker(db, notificationService, slog.Default())
	if err != nil {
		return fmt.Errorf("configure planning notification worker: %w", err)
	}
	planningLifecycleWorker, err := planningservice.NewLifecycleWorker(db, slog.Default())
	if err != nil {
		return fmt.Errorf("configure planning lifecycle worker: %w", err)
	}
	planningSeriesWorker, err := planningservice.NewSeriesMaterializationWorker(db, slog.Default())
	if err != nil {
		return fmt.Errorf("configure planning series materialization worker: %w", err)
	}
	backgroundRunners := []backgroundRunner{
		{name: "settlement reminders", run: reminderWorker.Run},
		{name: "planning notifications", run: planningWorker.Run},
		{name: "planning lifecycle", run: planningLifecycleWorker.Run},
		{name: "planning series materialization", run: planningSeriesWorker.Run},
	}
	exportStore, err := exporting.NewFileArtifactStore(filepath.Join(cfg.DataDirectory, "exports"))
	if err != nil {
		return fmt.Errorf("configure data export artifact store: %w", err)
	}
	exportService, err := exporting.NewService(db, exportStore, exporting.Options{
		CompletionListener: exportnotifications.Listener{DB: db},
	})
	if err != nil {
		return fmt.Errorf("configure data export service: %w", err)
	}
	backgroundRunners = append(backgroundRunners,
		backgroundRunner{name: "data export generation", run: func(ctx context.Context) error { return runDataExportWorker(ctx, exportService) }},
		backgroundRunner{name: "data export cleanup", run: func(ctx context.Context) error { return runDataExportCleanup(ctx, exportService, slog.Default()) }},
	)

	if len(cfg.EmailTokenKey) == 32 {
		sender, err := email.NewDynamicSender(func(ctx context.Context) (config.SMTPConfig, bool, error) {
			settings, resolved, err := systemService.ResolveRuntime(ctx)
			if err != nil {
				return config.SMTPConfig{}, true, err
			}
			configuration := cliSMTPConfig(resolved)
			return configuration, settings.MaintenanceMode.Value || !settings.SMTP.Active, nil
		})
		if err != nil {
			return fmt.Errorf("configure dynamic SMTP sender: %w", err)
		}
		tokenBox, err := platform.NewSecretBox(cfg.EmailTokenKey)
		if err != nil {
			return fmt.Errorf("configure invitation token encryption: %w", err)
		}
		dispatcher, err := email.NewDispatcher(db, sender, tokenBox, cfg.PublicURL, slog.Default())
		if err != nil {
			return err
		}
		notificationDispatcher, err := email.NewNotificationDispatcher(db, sender, cfg.PublicURL, slog.Default())
		if err != nil {
			return err
		}
		publicJoinDispatcher, err := email.NewPublicJoinDispatcher(db, sender, tokenBox, cfg.PublicURL, slog.Default())
		if err != nil {
			return err
		}
		accountSecurityDispatcher, err := email.NewAccountSecurityDispatcher(db, sender, tokenBox, cfg.PublicURL, slog.Default())
		if err != nil {
			return err
		}
		backgroundRunners = append(backgroundRunners,
			backgroundRunner{name: "invitation email delivery", run: dispatcher.Run},
			backgroundRunner{name: "notification email delivery", run: notificationDispatcher.Run},
			backgroundRunner{name: "public-join email delivery", run: publicJoinDispatcher.Run},
			backgroundRunner{name: "account-security email delivery", run: accountSecurityDispatcher.Run},
		)
	}
	if pushSecrets != nil {
		pushSubscriptions, err := webpushservice.NewSubscriptionService(db, pushSecrets, nil)
		if err != nil {
			return fmt.Errorf("configure Web Push subscriptions: %w", err)
		}
		pushDispatcher, err := webpushservice.NewNotificationDispatcher(db, pushSubscriptions, webpushservice.NewSender(nil),
			func(ctx context.Context) (webpushservice.RuntimeConfiguration, error) {
				settings, resolved, err := systemService.ResolveWebPush(ctx)
				if err != nil {
					return webpushservice.RuntimeConfiguration{}, err
				}
				return webpushservice.RuntimeConfiguration{
					Enabled: resolved.Enabled && !settings.MaintenanceMode.Value, Subject: resolved.Subject,
					PrivateKey: resolved.VAPIDPrivateKey, KeyID: resolved.KeyID,
				}, nil
			}, slog.Default())
		if err != nil {
			return fmt.Errorf("configure Web Push dispatcher: %w", err)
		}
		backgroundRunners = append(backgroundRunners, backgroundRunner{name: "Web Push delivery", run: pushDispatcher.Run})
	}
	workerErrors := superviseBackgroundRunners(processContext, backgroundRunners)
	server := &http.Server{
		Addr:              cfg.ListenAddress,
		Handler:           httpapi.New(cfg, db, httpapi.NewBuildInformation(version, commit), slog.Default()),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	errChannel := make(chan error, 1)
	go func() {
		slog.Info("TeamTaler listening", "address", cfg.ListenAddress, "public_url", cfg.PublicURL.String(), "smtp_enabled", cfg.SMTP.Enabled)
		errChannel <- server.ListenAndServe()
	}()
	var serveErr error
	workersStopped := false
	select {
	case listenErr := <-errChannel:
		if !errors.Is(listenErr, http.ErrServerClosed) {
			serveErr = fmt.Errorf("serve HTTP: %w", listenErr)
		}
	case workerErr := <-workerErrors:
		workersStopped = true
		if workerErr != nil {
			serveErr = fmt.Errorf("background workers stopped: %w", workerErr)
		} else if processContext.Err() == nil {
			serveErr = errors.New("background workers stopped unexpectedly")
		}
	case <-processContext.Done():
	}

	stop()
	shutdownContext, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if shutdownErr := server.Shutdown(shutdownContext); shutdownErr != nil {
		serveErr = errors.Join(serveErr, fmt.Errorf("shut down HTTP server: %w", shutdownErr))
	}
	if !workersStopped {
		recordWorkerError := func(workerErr error) {
			if workerErr != nil {
				serveErr = errors.Join(serveErr, fmt.Errorf("shut down background workers: %w", workerErr))
			}
		}
		select {
		case workerErr := <-workerErrors:
			recordWorkerError(workerErr)
		case <-shutdownContext.Done():
			select {
			case workerErr := <-workerErrors:
				recordWorkerError(workerErr)
			default:
				serveErr = errors.Join(serveErr, errors.New("background workers did not stop before the shutdown deadline"))
			}
		}
	}
	return serveErr
}

type backgroundRunner struct {
	name string
	run  func(context.Context) error
}

type backgroundResult struct {
	name string
	err  error
}

// superviseBackgroundRunners starts all durable background workers under one
// child context. The first unexpected stop cancels its peers; the returned
// channel receives one joined, worker-labelled result after every runner exits.
func superviseBackgroundRunners(parent context.Context, runners []backgroundRunner) <-chan error {
	completed := make(chan error, 1)
	go func() {
		if len(runners) == 0 {
			completed <- errors.New("no background workers configured")
			return
		}
		ctx, cancel := context.WithCancel(parent)
		defer cancel()
		results := make(chan backgroundResult, len(runners))
		for _, runner := range runners {
			runner := runner
			go func() {
				if runner.run == nil {
					results <- backgroundResult{name: runner.name, err: errors.New("runner is unavailable")}
					return
				}
				results <- backgroundResult{name: runner.name, err: runner.run(ctx)}
			}()
		}
		first := <-results
		unexpectedStop := parent.Err() == nil
		cancel()
		errorsByRunner := make([]error, 0, len(runners))
		if first.err != nil {
			errorsByRunner = append(errorsByRunner, fmt.Errorf("%s: %w", first.name, first.err))
		} else if unexpectedStop {
			errorsByRunner = append(errorsByRunner, fmt.Errorf("%s stopped unexpectedly", first.name))
		}
		for index := 1; index < len(runners); index++ {
			result := <-results
			if result.err != nil {
				errorsByRunner = append(errorsByRunner, fmt.Errorf("%s: %w", result.name, result.err))
			}
		}
		completed <- errors.Join(errorsByRunner...)
	}()
	return completed
}

// runDataExportWorker processes durable raw-data export jobs and treats parent
// cancellation as a clean shutdown.
func runDataExportWorker(ctx context.Context, service *exporting.Service) error {
	err := service.Run(ctx, time.Second)
	if ctx.Err() != nil && errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

// runDataExportCleanup removes expired or newly unauthorized export artifacts
// at startup and every fifteen minutes. Individual cleanup failures are logged
// and retried without stopping the HTTP server.
func runDataExportCleanup(ctx context.Context, service *exporting.Service, logger *slog.Logger) error {
	process := func() {
		if _, err := service.Cleanup(ctx, 100); err != nil && ctx.Err() == nil {
			logger.Error("data export cleanup failed", "error", err)
		}
	}
	process()
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			process()
		}
	}
}

// runMediaGarbageCollector retries durable content-addressed image deletions at
// startup and once per minute until ctx is cancelled. Failures are logged with
// no file keys or paths and remain pending for a later attempt.
func runMediaGarbageCollector(ctx context.Context, service systemadmin.Service, dataDirectory string, logger *slog.Logger) {
	process := func() {
		if err := service.RunPendingWALCheckpoint(ctx); err != nil && ctx.Err() == nil {
			logger.Error("system WAL checkpoint retry failed", "error", err)
		}
		if _, err := service.RunMediaGarbageCollection(ctx, dataDirectory, 100); err != nil && ctx.Err() == nil {
			logger.Error("system media garbage collection failed", "error", err)
		}
	}
	process()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			process()
		}
	}
}

func admin(arguments []string) error {
	if len(arguments) == 0 {
		return errors.New("usage: teamtaler admin <bootstrap|system-admin|system>")
	}
	switch arguments[0] {
	case "bootstrap":
		return adminBootstrap(arguments[1:])
	case "system-admin":
		return systemAdministratorCommand(arguments[1:])
	case "system":
		return systemCommand(arguments[1:])
	default:
		return fmt.Errorf("unknown admin command %q", arguments[0])
	}
}

func adminBootstrap(arguments []string) error {
	flags := flag.NewFlagSet("admin bootstrap", flag.ContinueOnError)
	email := flags.String("email", "", "administrator email address")
	displayName := flags.String("display-name", "", "administrator display name")
	groupName := flags.String("group", "", "initial group name")
	currency := flags.String("currency", "EUR", "three-letter group currency")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	password, err := readBootstrapPassword(os.Stdin, os.Stderr)
	if err != nil {
		return err
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	db, err := storage.Open(context.Background(), cfg.DatabasePath)
	if err != nil {
		return err
	}
	defer db.Close()
	service := auth.Service{DB: db, SessionLifetime: cfg.SessionLifetime}
	if err := service.Bootstrap(context.Background(), *email, *displayName, password, *groupName, *currency); err != nil {
		return err
	}
	fmt.Println("TeamTaler bootstrap completed.")
	return nil
}

func readBootstrapPassword(input *os.File, output io.Writer) (string, error) {
	var value string
	if term.IsTerminal(int(input.Fd())) {
		fmt.Fprint(output, "Bootstrap password: ")
		encoded, err := term.ReadPassword(int(input.Fd()))
		fmt.Fprintln(output)
		if err != nil {
			return "", fmt.Errorf("read bootstrap password: %w", err)
		}
		value = string(encoded)
	} else {
		line, err := bufio.NewReader(io.LimitReader(input, 2049)).ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return "", fmt.Errorf("read bootstrap password: %w", err)
		}
		value = line
	}
	value = strings.TrimSuffix(value, "\n")
	value = strings.TrimSuffix(value, "\r")
	if value == "" {
		return "", errors.New("password is required through the terminal or standard input")
	}
	return value, nil
}

func healthcheck(arguments []string) error {
	flags := flag.NewFlagSet("healthcheck", flag.ContinueOnError)
	url := flags.String("url", "http://127.0.0.1:8080/health/ready", "readiness endpoint")
	timeout := flags.Duration("timeout", 5*time.Second, "request timeout")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	client := &http.Client{Timeout: *timeout, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	request, err := http.NewRequest(http.MethodGet, *url, nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("healthcheck returned %s", response.Status)
	}
	return nil
}

func backupCommand(arguments []string) error {
	if len(arguments) == 0 {
		return errors.New("usage: teamtaler backup <create|restore>")
	}
	if arguments[0] == "restore" {
		return restoreCommand(arguments[1:])
	}
	if arguments[0] != "create" {
		return fmt.Errorf("unknown backup command %q", arguments[0])
	}
	flags := flag.NewFlagSet("backup create", flag.ContinueOnError)
	output := flags.String("output", "", "output .tar.gz path")
	if err := flags.Parse(arguments[1:]); err != nil {
		return err
	}
	if *output == "" {
		return errors.New("--output is required")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	db, err := storage.Open(context.Background(), cfg.DatabasePath)
	if err != nil {
		return err
	}
	defer db.Close()
	if err := backup.Create(context.Background(), db, cfg.DataDirectory, *output); err != nil {
		return err
	}
	fmt.Printf("Backup written to %s\n", *output)
	return nil
}

func restoreCommand(arguments []string) error {
	flags := flag.NewFlagSet("restore", flag.ContinueOnError)
	input := flags.String("input", "", "input .tar.gz path")
	force := flags.Bool("force", false, "preserve and replace existing local data")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if *input == "" {
		return errors.New("--input is required")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	recovery, err := backup.Restore(*input, cfg.DataDirectory, cfg.DatabasePath, *force)
	if err != nil {
		return err
	}
	if recovery != "" {
		fmt.Printf("Restore complete; previous data preserved at %s\n", recovery)
	} else {
		fmt.Println("Restore complete.")
	}
	return nil
}
