package email

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"html/template"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"net/textproto"
	"net/url"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/domain"
)

const emailLogoContentID = "teamtaler-brand-logo"

type emailPalette struct {
	Canvas     template.CSS
	Surface    template.CSS
	Text       template.CSS
	Muted      template.CSS
	Brand      template.CSS
	OnBrand    template.CSS
	Border     template.CSS
	Header     template.CSS
	HeaderText template.CSS
}

type emailTheme struct {
	Light emailPalette
	Dark  emailPalette
}

type emailDocument struct {
	ToAddress  string
	ToName     string
	Subject    string
	Preheader  string
	Title      string
	Greeting   string
	Paragraphs []string
	ActionURL  string
	ActionText string
	Footer     string
	Branding   BrandingContext
	Theme      emailTheme
}

var visualEmailTemplate = template.Must(template.New("email").Parse(`<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>{{.Subject}}</title>
  <style>
    @media (prefers-color-scheme: dark) {
      .email-body { background-color: {{.Theme.Dark.Canvas}} !important; }
      .email-card { background-color: {{.Theme.Dark.Surface}} !important; border-color: {{.Theme.Dark.Border}} !important; }
      .email-header { background-color: {{.Theme.Dark.Header}} !important; }
	  .email-footer { border-color: {{.Theme.Dark.Border}} !important; }
      .email-heading, .email-copy { color: {{.Theme.Dark.Text}} !important; }
      .email-muted { color: {{.Theme.Dark.Muted}} !important; }
      .email-button { background-color: {{.Theme.Dark.Brand}} !important; color: {{.Theme.Dark.OnBrand}} !important; }
      .email-link { color: {{.Theme.Dark.Brand}} !important; }
    }
    @media only screen and (max-width: 640px) {
      .email-shell { width: 100% !important; }
      .email-card-cell { padding: 16px !important; }
      .email-content { padding: 24px 20px !important; }
      .email-button { display: block !important; text-align: center !important; }
    }
  </style>
</head>
<body class="email-body" style="margin:0;padding:0;background-color:{{.Theme.Light.Canvas}};color:{{.Theme.Light.Text}};font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">{{.Preheader}}</div>
  <table class="email-body" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;background-color:{{.Theme.Light.Canvas}};">
    <tr>
      <td class="email-card-cell" align="center" style="padding:32px 16px;">
        <table class="email-shell email-card" role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:600px;max-width:600px;border:1px solid {{.Theme.Light.Border}};border-radius:16px;border-collapse:separate;overflow:hidden;background-color:{{.Theme.Light.Surface}};">
          <tr>
            <td class="email-header" style="padding:24px 28px;background-color:{{.Theme.Light.Header}};">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;">
                <tr>
                  <td width="72" valign="middle" style="width:72px;vertical-align:middle;">
                    <img src="cid:` + emailLogoContentID + `" width="56" alt="{{.Branding.Name}} Logo" style="display:block;width:56px;height:auto;max-height:56px;border:0;border-radius:12px;">
                  </td>
                  <td valign="middle" style="vertical-align:middle;color:{{.Theme.Light.HeaderText}};font-size:20px;font-weight:700;line-height:1.3;">{{.Branding.Name}}</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="email-content" style="padding:34px 36px;">
              <p class="email-copy" style="margin:0 0 18px;color:{{.Theme.Light.Text}};font-size:16px;line-height:1.6;">{{.Greeting}}</p>
              <h1 class="email-heading" style="margin:0 0 20px;color:{{.Theme.Light.Text}};font-size:26px;line-height:1.25;">{{.Title}}</h1>
              {{range .Paragraphs}}<p class="email-copy" style="margin:0 0 18px;color:{{$.Theme.Light.Text}};font-size:16px;line-height:1.6;">{{.}}</p>{{end}}
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:26px 0 22px;border-collapse:separate;">
                <tr>
                  <td style="border-radius:10px;background-color:{{.Theme.Light.Brand}};">
                    <a class="email-button" href="{{.ActionURL}}" style="display:inline-block;padding:14px 22px;border-radius:10px;background-color:{{.Theme.Light.Brand}};color:{{.Theme.Light.OnBrand}};font-size:16px;font-weight:700;line-height:1.2;text-decoration:none;">{{.ActionText}}</a>
                  </td>
                </tr>
              </table>
              <p class="email-muted" style="margin:0 0 8px;color:{{.Theme.Light.Muted}};font-size:13px;line-height:1.5;">Falls der Button nicht funktioniert, öffne diesen Link:</p>
              <p style="margin:0;overflow-wrap:anywhere;font-size:13px;line-height:1.5;word-break:break-word;"><a class="email-link" href="{{.ActionURL}}" style="color:{{.Theme.Light.Brand}};text-decoration:underline;">{{.ActionURL}}</a></p>
            </td>
          </tr>
          <tr>
            <td class="email-muted email-footer" style="padding:20px 28px;border-top:1px solid {{.Theme.Light.Border}};color:{{.Theme.Light.Muted}};font-size:12px;line-height:1.5;text-align:center;">{{.Footer}}</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`))

func (s *SMTP) renderDesignedInvitation(message InvitationMessage) (string, []byte, error) {
	branding := normalizeGroupBranding(message.Branding, message.GroupName)
	document, err := newEmailDocument(message.ToAddress, message.ToName, branding,
		branding.Name+" · Einladung", "Einladung zu "+branding.Name,
		[]string{
			"Du wurdest eingeladen, der Gruppe „" + branding.Name + "“ bei TeamTaler beizutreten.",
			"Diese Einladung ist bis zum " + formatGermanDateTime(message.ExpiresAt) + " gültig.",
			"Wenn du diese Einladung nicht erwartet hast, kannst du diese E-Mail ignorieren.",
		}, "Einladung annehmen", message.AcceptURL)
	if err != nil {
		return "", nil, err
	}
	if message.ExpiresAt.IsZero() {
		return "", nil, errors.New("invitation expiry is required")
	}
	return s.renderVisualEmail(document)
}

func (s *SMTP) renderDesignedJoinVerification(message JoinVerificationMessage) (string, []byte, error) {
	branding := normalizeGroupBranding(message.Branding, message.GroupName)
	document, err := newEmailDocument(message.ToAddress, message.ToName, branding,
		branding.Name+" · E-Mail-Adresse bestätigen", "E-Mail-Adresse bestätigen",
		[]string{
			"Bestätige deine E-Mail-Adresse, um der Gruppe „" + branding.Name + "“ bei TeamTaler beizutreten.",
			"Dieser Link ist bis zum " + formatGermanDateTime(message.ExpiresAt) + " gültig.",
			"Wenn du diese Registrierung nicht angefordert hast, kannst du diese E-Mail ignorieren.",
		}, "E-Mail-Adresse bestätigen", message.VerifyURL)
	if err != nil {
		return "", nil, err
	}
	if message.ExpiresAt.IsZero() {
		return "", nil, errors.New("verification expiry is required")
	}
	return s.renderVisualEmail(document)
}

func (s *SMTP) renderDesignedNotification(message NotificationMessage) (string, []byte, error) {
	branding := message.Branding
	if branding.Scope == BrandingScopeSystem {
		branding = normalizeSystemBranding(branding)
	} else {
		branding = normalizeGroupBranding(branding, message.GroupName)
	}
	title := strings.TrimSpace(message.Title)
	body := strings.TrimSpace(message.Body)
	if title == "" || len(title) > 160 || body == "" || len(body) > 2000 || containsHeaderControl(title) || containsHeaderControl(body) {
		return "", nil, errors.New("notification title and body must be present, bounded, and free of control characters")
	}
	document, err := newEmailDocument(message.ToAddress, message.ToName, branding,
		branding.Name+" · "+title, title, []string{body}, "In TeamTaler öffnen", message.ActionURL)
	if err != nil {
		return "", nil, err
	}
	return s.renderVisualEmail(document)
}

func (s *SMTP) renderDesignedAccountSecurity(message AccountSecurityMessage, subject, title, body, ignored, actionText string) (string, []byte, error) {
	branding := normalizeSystemBranding(message.Branding)
	document, err := newEmailDocument(message.ToAddress, message.ToName, branding,
		"TeamTaler · "+subject, title,
		[]string{body, "Dieser Link ist bis zum " + formatGermanDateTime(message.ExpiresAt) + " gültig.", ignored}, actionText, message.ActionURL)
	if err != nil {
		return "", nil, err
	}
	if message.ExpiresAt.IsZero() {
		return "", nil, errors.New("account action expiry is required")
	}
	return s.renderVisualEmail(document)
}

func newEmailDocument(toAddress, toName string, branding BrandingContext, subject, title string, paragraphs []string, actionText, actionURL string) (emailDocument, error) {
	recipient, err := parseMailbox(toAddress, "recipient")
	if err != nil {
		return emailDocument{}, err
	}
	name := strings.TrimSpace(toName)
	if containsHeaderControl(name) || len(name) > 120 {
		return emailDocument{}, errors.New("recipient name must contain at most 120 characters without control characters")
	}
	if containsHeaderControl(branding.Name) || strings.TrimSpace(branding.Name) == "" || len(strings.TrimSpace(branding.Name)) > 120 {
		return emailDocument{}, errors.New("branding name must contain 1 to 120 characters without control characters")
	}
	if containsHeaderControl(subject) || strings.TrimSpace(subject) == "" || len(subject) > 280 {
		return emailDocument{}, errors.New("email subject is invalid")
	}
	normalizedActionURL := strings.TrimSpace(actionURL)
	parsedURL, err := url.Parse(normalizedActionURL)
	if err != nil || parsedURL.Host == "" || parsedURL.User != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") || len(normalizedActionURL) > maximumURLSize || containsHeaderControl(actionURL) {
		return emailDocument{}, errors.New("action URL must be an absolute HTTP(S) URL without credentials")
	}
	if len(branding.LogoPNG) == 0 {
		branding.LogoPNG = generatedTeamTalerLogo()
	}
	greeting := "Hallo,"
	if name != "" {
		greeting = "Hallo " + name + ","
	}
	footer := "Diese E-Mail wurde automatisch von TeamTaler versendet."
	if branding.Scope == BrandingScopeGroup {
		footer = "Diese E-Mail wurde automatisch für die Gruppe „" + branding.Name + "“ über TeamTaler versendet."
	}
	return emailDocument{
		ToAddress: recipient, ToName: name, Subject: subject, Preheader: firstParagraph(paragraphs),
		Title: title, Greeting: greeting, Paragraphs: paragraphs, ActionURL: normalizedActionURL,
		ActionText: actionText, Footer: footer, Branding: branding, Theme: themeFor(branding.Theme),
	}, nil
}

func (s *SMTP) renderVisualEmail(document emailDocument) (string, []byte, error) {
	var htmlBody bytes.Buffer
	if err := visualEmailTemplate.Execute(&htmlBody, document); err != nil {
		return "", nil, fmt.Errorf("render HTML email: %w", err)
	}
	plainBody := renderPlainText(document)
	var body bytes.Buffer
	related := multipart.NewWriter(&body)
	alternativeBoundary := randomBoundary()
	alternativeHeader := make(textproto.MIMEHeader)
	alternativeHeader.Set("Content-Type", mime.FormatMediaType("multipart/alternative", map[string]string{"boundary": alternativeBoundary}))
	alternativePart, err := related.CreatePart(alternativeHeader)
	if err != nil {
		return "", nil, fmt.Errorf("create email alternatives: %w", err)
	}
	alternative := multipart.NewWriter(alternativePart)
	if err := alternative.SetBoundary(alternativeBoundary); err != nil {
		return "", nil, fmt.Errorf("set email alternative boundary: %w", err)
	}
	if err := writeQuotedPrintablePart(alternative, "text/plain; charset=UTF-8", plainBody); err != nil {
		return "", nil, err
	}
	if err := writeQuotedPrintablePart(alternative, "text/html; charset=UTF-8", htmlBody.String()); err != nil {
		return "", nil, err
	}
	if err := alternative.Close(); err != nil {
		return "", nil, fmt.Errorf("close email alternatives: %w", err)
	}
	logoHeader := make(textproto.MIMEHeader)
	logoHeader.Set("Content-Type", "image/png; name=logo.png")
	logoHeader.Set("Content-Transfer-Encoding", "base64")
	logoHeader.Set("Content-Disposition", "inline; filename=logo.png")
	logoHeader.Set("Content-ID", "<"+emailLogoContentID+">")
	logoPart, err := related.CreatePart(logoHeader)
	if err != nil {
		return "", nil, fmt.Errorf("create email logo part: %w", err)
	}
	if err := writeWrappedBase64(logoPart, document.Branding.LogoPNG); err != nil {
		return "", nil, fmt.Errorf("encode email logo: %w", err)
	}
	if err := related.Close(); err != nil {
		return "", nil, fmt.Errorf("close related email body: %w", err)
	}
	fromHeader := (&mail.Address{Name: s.configuration.FromName, Address: s.configuration.FromAddress}).String()
	toHeader := (&mail.Address{Name: document.ToName, Address: document.ToAddress}).String()
	headers := []string{
		"Date: " + s.now().UTC().Format(time.RFC1123Z),
		"From: " + fromHeader,
		"To: " + toHeader,
		"Subject: " + mime.QEncoding.Encode("utf-8", document.Subject),
		"MIME-Version: 1.0",
		"Content-Type: " + mime.FormatMediaType("multipart/related", map[string]string{"boundary": related.Boundary(), "type": "multipart/alternative"}),
		"Auto-Submitted: auto-generated",
	}
	payload := []byte(strings.Join(headers, "\r\n") + "\r\n\r\n" + body.String())
	return document.ToAddress, payload, nil
}

func writeQuotedPrintablePart(writer *multipart.Writer, contentType, content string) error {
	header := make(textproto.MIMEHeader)
	header.Set("Content-Type", contentType)
	header.Set("Content-Transfer-Encoding", "quoted-printable")
	part, err := writer.CreatePart(header)
	if err != nil {
		return fmt.Errorf("create %s email part: %w", contentType, err)
	}
	encoded := quotedprintable.NewWriter(part)
	if _, err := encoded.Write([]byte(content)); err != nil {
		return fmt.Errorf("encode %s email part: %w", contentType, err)
	}
	if err := encoded.Close(); err != nil {
		return fmt.Errorf("close %s email part: %w", contentType, err)
	}
	return nil
}

func writeWrappedBase64(writer interface{ Write([]byte) (int, error) }, source []byte) error {
	encoded := base64.StdEncoding.EncodeToString(source)
	for len(encoded) > 0 {
		length := min(76, len(encoded))
		if _, err := writer.Write([]byte(encoded[:length] + "\r\n")); err != nil {
			return err
		}
		encoded = encoded[length:]
	}
	return nil
}

func renderPlainText(document emailDocument) string {
	lines := []string{document.Greeting, "", document.Title, ""}
	for _, paragraph := range document.Paragraphs {
		lines = append(lines, paragraph, "")
	}
	lines = append(lines, document.ActionText+":", document.ActionURL, "", document.Footer)
	return strings.Join(lines, "\r\n") + "\r\n"
}

func normalizeGroupBranding(branding BrandingContext, groupName string) BrandingContext {
	branding.Scope = BrandingScopeGroup
	if strings.TrimSpace(branding.Name) == "" {
		branding.Name = strings.TrimSpace(groupName)
	}
	if !branding.Theme.Valid() {
		branding.Theme = domain.ThemeTeamTaler
	}
	if len(branding.LogoPNG) == 0 {
		branding.LogoPNG = generatedTeamTalerLogo()
	}
	return branding
}

func normalizeSystemBranding(branding BrandingContext) BrandingContext {
	branding.Scope = BrandingScopeSystem
	branding.Name = "TeamTaler"
	branding.Theme = domain.ThemeTeamTaler
	if !branding.trustedSystemLogo || len(branding.LogoPNG) == 0 {
		branding.LogoPNG = generatedTeamTalerLogo()
	}
	branding.trustedSystemLogo = true
	return branding
}

func firstParagraph(paragraphs []string) string {
	if len(paragraphs) == 0 {
		return "Neue Nachricht von TeamTaler"
	}
	return paragraphs[0]
}

func randomBoundary() string {
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	boundary := writer.Boundary()
	_ = writer.Close()
	return boundary
}

func themeFor(theme domain.ThemeID) emailTheme {
	teamTaler := emailTheme{
		Light: palette("#f8fafc", "#ffffff", "#101725", "#5a6473", "#007c73", "#ffffff", "#d6dce4", "#03182f", "#ffffff"),
		Dark:  palette("#07111f", "#0d1b2e", "#e5ebf2", "#b0bbc8", "#62ddd4", "#03182f", "#2b3b4e", "#03101f", "#ffffff"),
	}
	switch theme {
	case domain.ThemeNRW:
		return emailTheme{
			Light: palette("#f8fafc", "#ffffff", "#101725", "#5a6473", "#007a38", "#ffffff", "#d6dce4", "#064622", "#ffffff"),
			Dark:  palette("#08120d", "#0d1b13", "#e5eee8", "#afbeb4", "#62dc91", "#062214", "#2c4435", "#06351c", "#ffffff"),
		}
	case domain.ThemeTiefImWesten:
		return emailTheme{
			Light: palette("#f8fafc", "#ffffff", "#101725", "#5a6473", "#0f2864", "#ffffff", "#d6dce4", "#0f2864", "#ffffff"),
			Dark:  palette("#050b18", "#0a1628", "#e6edf7", "#afbed0", "#58ceff", "#071b32", "#29415d", "#07183a", "#ffffff"),
		}
	case domain.ThemeFire:
		return emailTheme{
			Light: palette("#f8fafc", "#ffffff", "#101725", "#5a6473", "#962a27", "#ffffff", "#d6dce4", "#4a1210", "#ffffff"),
			Dark:  palette("#120d0d", "#1c1414", "#eee7e6", "#c2b4b1", "#ff837d", "#2a0908", "#493331", "#2c0d0b", "#ffffff"),
		}
	default:
		return teamTaler
	}
}

func palette(canvas, surface, text, muted, brand, onBrand, border, header, headerText string) emailPalette {
	return emailPalette{
		Canvas: template.CSS(canvas), Surface: template.CSS(surface), Text: template.CSS(text), Muted: template.CSS(muted),
		Brand: template.CSS(brand), OnBrand: template.CSS(onBrand), Border: template.CSS(border), Header: template.CSS(header), HeaderText: template.CSS(headerText),
	}
}
