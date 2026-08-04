package email

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"math/big"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/config"
)

func TestSMTPDeliversInvitationOverSecureTransports(t *testing.T) {
	for _, mode := range []config.SMTPTLSMode{config.SMTPTLSModeStartTLS, config.SMTPTLSModeTLS} {
		t.Run(string(mode), func(t *testing.T) {
			server := startSMTPTestServer(t, mode)
			sender, err := NewSMTP(testSMTPConfiguration(mode, server.port))
			if err != nil {
				t.Fatalf("NewSMTP: %v", err)
			}
			sender.rootCAs = server.rootCAs
			sender.now = func() time.Time { return time.Date(2026, time.August, 4, 12, 0, 0, 0, time.UTC) }

			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			err = sender.SendInvitation(ctx, InvitationMessage{
				ToAddress: "member@example.test",
				ToName:    "Alex Member",
				GroupName: "Alpha Team",
				AcceptURL: "https://teamtaler.example.test/invite#token=one-time-token",
				ExpiresAt: time.Date(2026, time.August, 11, 12, 0, 0, 0, time.UTC),
			})
			if err != nil {
				t.Fatalf("SendInvitation: %v", err)
			}

			rawMessage := <-server.messages
			if err := <-server.done; err != nil {
				t.Fatalf("SMTP test server: %v", err)
			}
			parsedMessage, err := mail.ReadMessage(strings.NewReader(rawMessage))
			if err != nil {
				t.Fatalf("parse delivered message: %v", err)
			}
			subject, err := new(mime.WordDecoder).DecodeHeader(parsedMessage.Header.Get("Subject"))
			if err != nil || subject != "Invitation to Alpha Team" {
				t.Fatalf("subject = %q err=%v", subject, err)
			}
			from, err := mail.ParseAddress(parsedMessage.Header.Get("From"))
			if err != nil || from.Name != "TeamTaler" || from.Address != "teamtaler@example.test" {
				t.Fatalf("From = %#v, err = %v", from, err)
			}
			to, err := mail.ParseAddress(parsedMessage.Header.Get("To"))
			if err != nil || to.Name != "Alex Member" || to.Address != "member@example.test" {
				t.Fatalf("To = %#v, err = %v", to, err)
			}
			body, err := io.ReadAll(quotedprintable.NewReader(parsedMessage.Body))
			if err != nil {
				t.Fatalf("decode delivered body: %v", err)
			}
			for _, expected := range []string{"Hello Alex Member,", "join Alpha Team", "https://teamtaler.example.test/invite#token=one-time-token", "11 Aug 2026"} {
				if !bytes.Contains(body, []byte(expected)) {
					t.Fatalf("delivered body does not contain %q: %q", expected, body)
				}
			}
		})
	}
}

func TestSendInvitationRejectsHeaderInjectionBeforeDialing(t *testing.T) {
	sender, err := NewSMTP(testSMTPConfiguration(config.SMTPTLSModeStartTLS, 587))
	if err != nil {
		t.Fatalf("NewSMTP: %v", err)
	}
	dialed := false
	sender.dialContext = func(context.Context, string, string) (net.Conn, error) {
		dialed = true
		return nil, errors.New("unexpected dial")
	}
	valid := InvitationMessage{
		ToAddress: "member@example.test",
		ToName:    "Alex Member",
		GroupName: "Alpha Team",
		AcceptURL: "https://teamtaler.example.test/invite#token=one-time-token",
		ExpiresAt: time.Now().Add(24 * time.Hour),
	}
	tests := []struct {
		name   string
		mutate func(*InvitationMessage)
	}{
		{name: "recipient", mutate: func(message *InvitationMessage) {
			message.ToAddress = "member@example.test\r\nBcc: attacker@example.test"
		}},
		{name: "recipient name", mutate: func(message *InvitationMessage) { message.ToName = "Alex\r\nBcc: attacker@example.test" }},
		{name: "subject data", mutate: func(message *InvitationMessage) { message.GroupName = "Alpha\r\nBcc: attacker@example.test" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			message := valid
			test.mutate(&message)
			if err := sender.SendInvitation(context.Background(), message); err == nil {
				t.Fatal("header injection was accepted")
			}
		})
	}
	if dialed {
		t.Fatal("invalid invitation caused network access")
	}
}

func TestSMTPRejectsSTARTTLSDowngrade(t *testing.T) {
	clientConnection, serverConnection := net.Pipe()
	defer serverConnection.Close()
	serverDone := make(chan error, 1)
	go func() {
		reader := bufio.NewReader(serverConnection)
		if _, err := io.WriteString(serverConnection, "220 smtp.example.test ESMTP\r\n"); err != nil {
			serverDone <- err
			return
		}
		line, err := reader.ReadString('\n')
		if err != nil {
			serverDone <- err
			return
		}
		if !strings.HasPrefix(strings.ToUpper(line), "EHLO ") {
			serverDone <- fmt.Errorf("first command = %q, want EHLO", line)
			return
		}
		_, err = io.WriteString(serverConnection, "250 smtp.example.test\r\n")
		serverDone <- err
	}()

	sender, err := NewSMTP(testSMTPConfiguration(config.SMTPTLSModeStartTLS, 587))
	if err != nil {
		t.Fatalf("NewSMTP: %v", err)
	}
	sender.dialContext = func(context.Context, string, string) (net.Conn, error) { return clientConnection, nil }
	err = sender.SendInvitation(context.Background(), testInvitationMessage())
	if err == nil || !strings.Contains(err.Error(), "does not advertise required STARTTLS") {
		t.Fatalf("downgrade error = %v", err)
	}
	if serverErr := <-serverDone; serverErr != nil {
		t.Fatalf("fake SMTP server: %v", serverErr)
	}
}

func TestSendInvitationHonorsContextCancellationDuringSMTP(t *testing.T) {
	clientConnection, serverConnection := net.Pipe()
	defer serverConnection.Close()
	sender, err := NewSMTP(testSMTPConfiguration(config.SMTPTLSModeStartTLS, 587))
	if err != nil {
		t.Fatalf("NewSMTP: %v", err)
	}
	sender.dialContext = func(context.Context, string, string) (net.Conn, error) { return clientConnection, nil }
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := sender.SendInvitation(ctx, testInvitationMessage()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cancellation error = %v, want deadline exceeded", err)
	}
}

func TestDisabledSMTPReportsUnavailable(t *testing.T) {
	sender, err := NewSMTP(config.SMTPConfig{})
	if err != nil {
		t.Fatalf("NewSMTP: %v", err)
	}
	if sender.Available() {
		t.Fatal("disabled SMTP sender reported available")
	}
	if err := sender.SendInvitation(context.Background(), testInvitationMessage()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("disabled sender error = %v, want ErrUnavailable", err)
	}
}

func testSMTPConfiguration(mode config.SMTPTLSMode, port int) config.SMTPConfig {
	return config.SMTPConfig{
		Enabled:     true,
		Host:        "127.0.0.1",
		Port:        port,
		Username:    "smtp-user",
		Password:    "smtp-password",
		FromAddress: "teamtaler@example.test",
		FromName:    "TeamTaler",
		TLSMode:     mode,
	}
}

func testInvitationMessage() InvitationMessage {
	return InvitationMessage{
		ToAddress: "member@example.test",
		ToName:    "Alex Member",
		GroupName: "Alpha Team",
		AcceptURL: "https://teamtaler.example.test/invite#token=one-time-token",
		ExpiresAt: time.Now().Add(24 * time.Hour),
	}
}

type smtpTestServer struct {
	port     int
	rootCAs  *x509.CertPool
	messages chan string
	done     chan error
}

func startSMTPTestServer(t *testing.T, mode config.SMTPTLSMode) smtpTestServer {
	t.Helper()
	certificate, rootCAs := createTestCertificate(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen for SMTP test server: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	_, portText, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatalf("parse SMTP test address: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("parse SMTP test port: %v", err)
	}
	messages := make(chan string, 1)
	done := make(chan error, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			done <- err
			return
		}
		done <- serveSMTPConnection(connection, mode, certificate, messages)
	}()
	return smtpTestServer{port: port, rootCAs: rootCAs, messages: messages, done: done}
}

func createTestCertificate(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate test certificate key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "TeamTaler SMTP test server"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	encoded, err := x509.CreateCertificate(rand.Reader, template, template, publicKey, privateKey)
	if err != nil {
		t.Fatalf("create test certificate: %v", err)
	}
	parsed, err := x509.ParseCertificate(encoded)
	if err != nil {
		t.Fatalf("parse test certificate: %v", err)
	}
	certificate := tls.Certificate{Certificate: [][]byte{encoded}, PrivateKey: privateKey, Leaf: parsed}
	rootCAs := x509.NewCertPool()
	rootCAs.AddCert(parsed)
	return certificate, rootCAs
}

func serveSMTPConnection(rawConnection net.Conn, mode config.SMTPTLSMode, certificate tls.Certificate, messages chan<- string) error {
	defer rawConnection.Close()
	tlsConfiguration := &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12}
	connection := rawConnection
	secure := false
	if mode == config.SMTPTLSModeTLS {
		tlsConnection := tls.Server(rawConnection, tlsConfiguration)
		if err := tlsConnection.Handshake(); err != nil {
			return fmt.Errorf("implicit TLS handshake: %w", err)
		}
		connection = tlsConnection
		secure = true
	}
	if _, err := io.WriteString(connection, "220 smtp.test ESMTP\r\n"); err != nil {
		return err
	}
	reader := bufio.NewReader(connection)
	authenticated := false
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return err
		}
		command := strings.TrimRight(line, "\r\n")
		upperCommand := strings.ToUpper(command)
		switch {
		case strings.HasPrefix(upperCommand, "EHLO "):
			response := "250-smtp.test\r\n250 AUTH PLAIN\r\n"
			if mode == config.SMTPTLSModeStartTLS && !secure {
				response = "250-smtp.test\r\n250 STARTTLS\r\n"
			}
			if _, err := io.WriteString(connection, response); err != nil {
				return err
			}
		case upperCommand == "STARTTLS":
			if mode != config.SMTPTLSModeStartTLS || secure {
				return errors.New("unexpected STARTTLS command")
			}
			if _, err := io.WriteString(connection, "220 ready for TLS\r\n"); err != nil {
				return err
			}
			tlsConnection := tls.Server(connection, tlsConfiguration)
			if err := tlsConnection.Handshake(); err != nil {
				return fmt.Errorf("STARTTLS handshake: %w", err)
			}
			connection = tlsConnection
			reader = bufio.NewReader(connection)
			secure = true
		case strings.HasPrefix(upperCommand, "AUTH PLAIN "):
			if !secure {
				return errors.New("SMTP authentication was attempted before TLS")
			}
			parts := strings.Fields(command)
			if len(parts) != 3 {
				return fmt.Errorf("AUTH command = %q", command)
			}
			credentials, err := base64.StdEncoding.DecodeString(parts[2])
			if err != nil || !bytes.Equal(credentials, []byte("\x00smtp-user\x00smtp-password")) {
				return fmt.Errorf("unexpected SMTP credentials")
			}
			authenticated = true
			if _, err := io.WriteString(connection, "235 authenticated\r\n"); err != nil {
				return err
			}
		case strings.HasPrefix(upperCommand, "MAIL FROM:"):
			if !secure || !authenticated {
				return errors.New("SMTP envelope was attempted before secure authentication")
			}
			if _, err := io.WriteString(connection, "250 sender accepted\r\n"); err != nil {
				return err
			}
		case strings.HasPrefix(upperCommand, "RCPT TO:"):
			if _, err := io.WriteString(connection, "250 recipient accepted\r\n"); err != nil {
				return err
			}
		case upperCommand == "DATA":
			if _, err := io.WriteString(connection, "354 send message\r\n"); err != nil {
				return err
			}
			var message strings.Builder
			for {
				dataLine, err := reader.ReadString('\n')
				if err != nil {
					return err
				}
				if dataLine == ".\r\n" {
					break
				}
				if strings.HasPrefix(dataLine, "..") {
					dataLine = dataLine[1:]
				}
				message.WriteString(dataLine)
			}
			messages <- message.String()
			if _, err := io.WriteString(connection, "250 message queued\r\n"); err != nil {
				return err
			}
		case upperCommand == "QUIT":
			_, err := io.WriteString(connection, "221 goodbye\r\n")
			return err
		default:
			return fmt.Errorf("unexpected SMTP command %q", command)
		}
	}
}
