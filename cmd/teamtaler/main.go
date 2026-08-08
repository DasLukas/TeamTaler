// Command teamtaler runs and operates the TeamTaler server.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/backup"
	"github.com/DasLukas/TeamTaler/internal/config"
	"github.com/DasLukas/TeamTaler/internal/email"
	"github.com/DasLukas/TeamTaler/internal/httpapi"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
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

	var emailWorkerErrors <-chan error
	if cfg.SMTP.Enabled {
		sender, err := email.NewSMTP(cfg.SMTP)
		if err != nil {
			return fmt.Errorf("configure SMTP sender: %w", err)
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
		workerErrors := make(chan error, 1)
		emailWorkerErrors = workerErrors
		go func() {
			dispatchContext, cancelDispatch := context.WithCancel(processContext)
			defer cancelDispatch()
			results := make(chan error, 3)
			go func() { results <- dispatcher.Run(dispatchContext) }()
			go func() { results <- notificationDispatcher.Run(dispatchContext) }()
			go func() { results <- publicJoinDispatcher.Run(dispatchContext) }()
			first := <-results
			cancelDispatch()
			second := <-results
			third := <-results
			workerErrors <- errors.Join(first, second, third)
		}()
	}
	server := &http.Server{
		Addr:              cfg.ListenAddress,
		Handler:           httpapi.New(cfg, db, slog.Default()),
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
	emailWorkerStopped := false
	select {
	case listenErr := <-errChannel:
		if !errors.Is(listenErr, http.ErrServerClosed) {
			serveErr = fmt.Errorf("serve HTTP: %w", listenErr)
		}
	case workerErr := <-emailWorkerErrors:
		emailWorkerStopped = true
		if workerErr != nil {
			serveErr = fmt.Errorf("email dispatchers stopped: %w", workerErr)
		} else if processContext.Err() == nil {
			serveErr = errors.New("email dispatchers stopped unexpectedly")
		}
	case <-processContext.Done():
	}

	stop()
	shutdownContext, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if shutdownErr := server.Shutdown(shutdownContext); shutdownErr != nil {
		serveErr = errors.Join(serveErr, fmt.Errorf("shut down HTTP server: %w", shutdownErr))
	}
	if emailWorkerErrors != nil && !emailWorkerStopped {
		recordWorkerError := func(workerErr error) {
			if workerErr != nil {
				serveErr = errors.Join(serveErr, fmt.Errorf("shut down email dispatchers: %w", workerErr))
			}
		}
		select {
		case workerErr := <-emailWorkerErrors:
			recordWorkerError(workerErr)
		case <-shutdownContext.Done():
			select {
			case workerErr := <-emailWorkerErrors:
				recordWorkerError(workerErr)
			default:
				serveErr = errors.Join(serveErr, errors.New("email dispatchers did not stop before the shutdown deadline"))
			}
		}
	}
	return serveErr
}

func admin(arguments []string) error {
	if len(arguments) == 0 || arguments[0] != "bootstrap" {
		return errors.New("usage: teamtaler admin bootstrap --email EMAIL --display-name NAME --group GROUP [--currency EUR]")
	}
	flags := flag.NewFlagSet("admin bootstrap", flag.ContinueOnError)
	email := flags.String("email", "", "administrator email address")
	displayName := flags.String("display-name", "", "administrator display name")
	groupName := flags.String("group", "", "initial group name")
	currency := flags.String("currency", "EUR", "three-letter group currency")
	password := flags.String("password", "", "password (prefer TEAMTALER_BOOTSTRAP_PASSWORD or stdin)")
	if err := flags.Parse(arguments[1:]); err != nil {
		return err
	}
	if *password == "" {
		*password = os.Getenv("TEAMTALER_BOOTSTRAP_PASSWORD")
	}
	if *password == "" {
		value, err := readBootstrapPassword(os.Stdin, os.Stderr)
		if err != nil {
			return err
		}
		*password = value
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
	if err := service.Bootstrap(context.Background(), *email, *displayName, *password, *groupName, *currency); err != nil {
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
	value = strings.TrimSpace(value)
	if value == "" {
		return "", errors.New("password is required through TEAMTALER_BOOTSTRAP_PASSWORD, --password, or stdin")
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
