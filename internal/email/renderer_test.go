package email

import (
	"bytes"
	"fmt"
	"math"
	"mime"
	"net/mail"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/config"
	"github.com/DasLukas/TeamTaler/internal/domain"
)

func TestVisualEmailEscapesContentAndForcesSystemBranding(t *testing.T) {
	t.Parallel()
	sender, err := NewSMTP(testSMTPConfiguration(config.SMTPTLSModeTLS, 465))
	if err != nil {
		t.Fatalf("create sender: %v", err)
	}
	sender.now = func() time.Time { return time.Date(2026, time.September, 10, 12, 0, 0, 0, time.UTC) }
	_, payload, err := sender.renderDesignedNotification(NotificationMessage{
		ToAddress: "member@example.test",
		ToName:    "Alex & Sam",
		GroupName: "Injected Group",
		Title:     "SMTP-Test <bereit>",
		Body:      `Das ist <script>alert("unsafe")</script> & bleibt Text.`,
		ActionURL: "https://teamtaler.example.test/admin?value=<unsafe>",
		Branding: BrandingContext{
			Scope: BrandingScopeSystem, Name: "Injected Group", Theme: domain.ThemeFire,
		},
	})
	if err != nil {
		t.Fatalf("render system notification: %v", err)
	}
	message, err := mail.ReadMessage(bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("parse message: %v", err)
	}
	subject, err := new(mime.WordDecoder).DecodeHeader(message.Header.Get("Subject"))
	if err != nil || subject != "TeamTaler · SMTP-Test <bereit>" {
		t.Fatalf("subject=%q err=%v", subject, err)
	}
	plain, html, _ := parseVisualEmail(t, message)
	if !strings.Contains(plain, `<script>alert("unsafe")</script>`) {
		t.Fatalf("plain text lost literal content: %q", plain)
	}
	if strings.Contains(html, `<script>alert("unsafe")</script>`) || !strings.Contains(html, `&lt;script&gt;alert`) {
		t.Fatalf("HTML content was not safely escaped: %q", html)
	}
	if !strings.Contains(html, ">TeamTaler</td>") || strings.Contains(html, ">Injected Group</td>") {
		t.Fatalf("system identity was not forced: %q", html)
	}
	if !strings.Contains(html, "#007c73") || strings.Contains(html, "#962a27") {
		t.Fatalf("system email did not force TeamTaler theme")
	}
}

func TestEmailThemeCorePairsMeetWCAGAA(t *testing.T) {
	t.Parallel()
	for _, themeID := range []domain.ThemeID{domain.ThemeTeamTaler, domain.ThemeNRW, domain.ThemeTiefImWesten, domain.ThemeFire} {
		theme := themeFor(themeID)
		for scheme, colors := range map[string]emailPalette{"light": theme.Light, "dark": theme.Dark} {
			pairs := [][3]string{
				{"text", string(colors.Text), string(colors.Surface)},
				{"muted", string(colors.Muted), string(colors.Surface)},
				{"button", string(colors.OnBrand), string(colors.Brand)},
				{"header", string(colors.HeaderText), string(colors.Header)},
			}
			for _, pair := range pairs {
				if ratio := contrastRatio(pair[1], pair[2]); ratio < 4.5 {
					t.Fatalf("%s/%s %s contrast=%.2f, want >=4.5", themeID, scheme, pair[0], ratio)
				}
			}
		}
	}
}

func TestEveryEmailKindUsesGermanVisualCopy(t *testing.T) {
	t.Parallel()
	sender, err := NewSMTP(testSMTPConfiguration(config.SMTPTLSModeTLS, 465))
	if err != nil {
		t.Fatalf("create sender: %v", err)
	}
	expires := time.Date(2026, time.September, 11, 12, 0, 0, 0, time.UTC)
	groupBranding := BrandingContext{Scope: BrandingScopeGroup, Name: "Beispielgruppe", Theme: domain.ThemeNRW}
	tests := []struct {
		name        string
		render      func() ([]byte, error)
		wantSubject string
		wantCopy    []string
	}{
		{
			name: "public join",
			render: func() ([]byte, error) {
				_, payload, err := sender.renderDesignedJoinVerification(JoinVerificationMessage{
					ToAddress: "member@example.test", ToName: "Alex", GroupName: "Beispielgruppe",
					VerifyURL: "https://teamtaler.example.test/join/verify#token=secret", ExpiresAt: expires, Branding: groupBranding,
				})
				return payload, err
			},
			wantSubject: "Beispielgruppe · E-Mail-Adresse bestätigen",
			wantCopy:    []string{"Bestätige deine E-Mail-Adresse", "E-Mail-Adresse bestätigen"},
		},
		{
			name: "password reset",
			render: func() ([]byte, error) {
				_, payload, err := sender.renderDesignedAccountSecurity(AccountSecurityMessage{
					ToAddress: "member@example.test", ToName: "Alex", ActionURL: "https://teamtaler.example.test/reset-password#token=secret", ExpiresAt: expires,
				}, "Passwort zurücksetzen", "Passwort zurücksetzen", "Über den folgenden Link kannst du ein neues Passwort für dein TeamTaler-Konto festlegen.", "Wenn du das Zurücksetzen nicht angefordert hast, kannst du diese E-Mail ignorieren.", "Passwort zurücksetzen")
				return payload, err
			},
			wantSubject: "TeamTaler · Passwort zurücksetzen",
			wantCopy:    []string{"neues Passwort", "Passwort zurücksetzen"},
		},
		{
			name: "email change",
			render: func() ([]byte, error) {
				_, payload, err := sender.renderDesignedAccountSecurity(AccountSecurityMessage{
					ToAddress: "member@example.test", ToName: "Alex", ActionURL: "https://teamtaler.example.test/email-change/confirm#token=secret", ExpiresAt: expires,
				}, "E-Mail-Adresse bestätigen", "E-Mail-Adresse bestätigen", "Bestätige über den folgenden Link deine neue E-Mail-Adresse für TeamTaler.", "Wenn du diese Änderung nicht angefordert hast, kannst du diese E-Mail ignorieren.", "E-Mail-Adresse bestätigen")
				return payload, err
			},
			wantSubject: "TeamTaler · E-Mail-Adresse bestätigen",
			wantCopy:    []string{"neue E-Mail-Adresse", "E-Mail-Adresse bestätigen"},
		},
		{
			name: "group notification",
			render: func() ([]byte, error) {
				_, payload, err := sender.renderDesignedNotification(NotificationMessage{
					ToAddress: "member@example.test", ToName: "Alex", GroupName: "Beispielgruppe",
					Title: "Neue Buchung", Body: "Eine neue Buchung wurde erfasst.", ActionURL: "https://teamtaler.example.test/notifications", Branding: groupBranding,
				})
				return payload, err
			},
			wantSubject: "Beispielgruppe · Neue Buchung",
			wantCopy:    []string{"Eine neue Buchung", "In TeamTaler öffnen"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload, err := test.render()
			if err != nil {
				t.Fatalf("render message: %v", err)
			}
			message, err := mail.ReadMessage(bytes.NewReader(payload))
			if err != nil {
				t.Fatalf("parse message: %v", err)
			}
			subject, err := new(mime.WordDecoder).DecodeHeader(message.Header.Get("Subject"))
			if err != nil || subject != test.wantSubject {
				t.Fatalf("subject=%q err=%v", subject, err)
			}
			plain, html, _ := parseVisualEmail(t, message)
			for _, expected := range test.wantCopy {
				if !strings.Contains(plain, expected) || !strings.Contains(html, expected) {
					t.Fatalf("message does not contain %q in both alternatives", expected)
				}
			}
			if strings.Contains(html, `<img src="http`) {
				t.Fatal("HTML email contains a remotely loaded image")
			}
		})
	}
}

func contrastRatio(first, second string) float64 {
	firstLuminance := relativeLuminance(first)
	secondLuminance := relativeLuminance(second)
	return (math.Max(firstLuminance, secondLuminance) + 0.05) / (math.Min(firstLuminance, secondLuminance) + 0.05)
}

func relativeLuminance(value string) float64 {
	if len(value) != 7 || value[0] != '#' {
		panic(fmt.Sprintf("unsupported color %q", value))
	}
	components := make([]float64, 3)
	for index := range components {
		component, err := strconv.ParseUint(value[1+index*2:3+index*2], 16, 8)
		if err != nil {
			panic(err)
		}
		normalized := float64(component) / 255
		if normalized <= 0.04045 {
			components[index] = normalized / 12.92
		} else {
			components[index] = math.Pow((normalized+0.055)/1.055, 2.4)
		}
	}
	return 0.2126*components[0] + 0.7152*components[1] + 0.0722*components[2]
}
