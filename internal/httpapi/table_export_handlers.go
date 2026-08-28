package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/DasLukas/TeamTaler/internal/activities"
	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/exporting/tabular"
	"github.com/DasLukas/TeamTaler/internal/finance"
	"github.com/DasLukas/TeamTaler/internal/media"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
	systemadmin "github.com/DasLukas/TeamTaler/internal/system"
	"github.com/DasLukas/TeamTaler/internal/tablequery"
)

const (
	tableExportPDFRowLimit  = 10_000
	tableExportCSVRowLimit  = 100_000
	tableExportPDFByteLimit = 50 << 20
	tableExportCSVByteLimit = 100 << 20
)

type tableExportCommand struct {
	Table    string          `json:"table"`
	Format   string          `json:"format"`
	TimeZone string          `json:"timeZone"`
	Query    json.RawMessage `json:"query"`
}

type tableExportDefinition struct {
	Title      string
	SystemOnly bool
}

var tableExportDefinitions = map[string]tableExportDefinition{
	"ACTIVITIES":           {Title: "Aktivitäten"},
	"PAYMENTS":             {Title: "Zahlungen"},
	"ACCOUNT_BALANCES":     {Title: "Kontostände"},
	"GROUP_SETTLEMENTS":    {Title: "Abgeschlossene Abrechnungen"},
	"SETTLEMENT_STATEMENT": {Title: "Abgeschlossene Abrechnung"},
	"PERSONAL_SETTLEMENTS": {Title: "Eigene Abrechnungen"},
	"ACTIVE_MEMBERS":       {Title: "Aktive Mitglieder"},
	"ARCHIVED_MEMBERS":     {Title: "Archivierte Mitglieder"},
	"GROUP_AUDIT":          {Title: "Gruppen-Auditprotokoll"},
	"SYSTEM_AUDIT":         {Title: "System-Auditprotokoll", SystemOnly: true},
}

// handleGroupTableExport renders one complete, authorization-scoped group
// table using the same filter and sort contract as its interactive view.
func (s *Server) handleGroupTableExport(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if release, err := s.acquireTableExport(request, principal.UserID); err != nil {
		writeProblem(response, request, err)
		return
	} else {
		defer release()
	}
	var command tableExportCommand
	if err := decodeJSON(response, request, &command); err != nil {
		writeProblem(response, request, err)
		return
	}
	command.Table = strings.ToUpper(strings.TrimSpace(command.Table))
	command.Format = strings.ToUpper(strings.TrimSpace(command.Format))
	definition, location, err := normalizeTableExportCommand(command, false)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	rowLimit, byteLimit, timeout := tableExportLimits(command.Format)
	ctx, cancel := context.WithTimeout(request.Context(), timeout)
	defer cancel()
	activityAccess := ""
	if command.Table == "ACTIVITIES" {
		activityAccess, err = s.activityExportAccess(ctx, membership)
		if err != nil {
			writeProblem(response, request, tableExportError(err, timeout))
			return
		}
	}
	document, err := s.buildGroupTableDocument(ctx, membership, command, definition, location, rowLimit)
	if err != nil {
		writeProblem(response, request, tableExportError(err, timeout))
		return
	}
	artifact, err := renderTableArtifact(ctx, document, command.Format, byteLimit)
	if err != nil {
		writeProblem(response, request, tableExportError(err, timeout))
		return
	}
	defer removeTableArtifact(artifact)
	if command.Table == "ACTIVITIES" {
		currentAccess, accessErr := s.activityExportAccess(ctx, membership)
		if accessErr != nil || currentAccess != activityAccess {
			if accessErr == nil {
				accessErr = domain.ErrForbidden
			}
			writeProblem(response, request, tableExportError(accessErr, timeout))
			return
		}
	}
	if err := s.recordGroupTableExport(ctx, principal, membership, command, len(document.Rows)); err != nil {
		s.logger.Error("record group table export", "error", err, "table", command.Table)
		writeProblem(response, request, err)
		return
	}
	serveTableArtifact(response, request, artifact, definition.Title, command.Format, document.ExportedAt)
}

// handleSystemTableExport renders the instance audit table after a live system
// administrator check. It deliberately exposes no system-wide raw-data export.
func (s *Server) handleSystemTableExport(response http.ResponseWriter, request *http.Request) {
	principal, err := s.systemAdministrator(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if release, err := s.acquireTableExport(request, principal.UserID); err != nil {
		writeProblem(response, request, err)
		return
	} else {
		defer release()
	}
	var command tableExportCommand
	if err := decodeJSON(response, request, &command); err != nil {
		writeProblem(response, request, err)
		return
	}
	command.Table = strings.ToUpper(strings.TrimSpace(command.Table))
	command.Format = strings.ToUpper(strings.TrimSpace(command.Format))
	definition, location, err := normalizeTableExportCommand(command, true)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	rowLimit, byteLimit, timeout := tableExportLimits(command.Format)
	ctx, cancel := context.WithTimeout(request.Context(), timeout)
	defer cancel()
	document, err := s.buildSystemTableDocument(ctx, command, definition, location, rowLimit)
	if err != nil {
		writeProblem(response, request, tableExportError(err, timeout))
		return
	}
	artifact, err := renderTableArtifact(ctx, document, command.Format, byteLimit)
	if err != nil {
		writeProblem(response, request, tableExportError(err, timeout))
		return
	}
	defer removeTableArtifact(artifact)
	if err := s.recordSystemTableExport(ctx, principal, command, len(document.Rows)); err != nil {
		s.logger.Error("record system table export", "error", err, "table", command.Table)
		writeProblem(response, request, err)
		return
	}
	serveTableArtifact(response, request, artifact, definition.Title, command.Format, document.ExportedAt)
}

func normalizeTableExportCommand(command tableExportCommand, system bool) (tableExportDefinition, *time.Location, error) {
	command.Table = strings.ToUpper(strings.TrimSpace(command.Table))
	command.Format = strings.ToUpper(strings.TrimSpace(command.Format))
	definition, exists := tableExportDefinitions[command.Table]
	if !exists || definition.SystemOnly != system {
		return tableExportDefinition{}, nil, domain.ValidationError{Field: "table", Message: "is not available in this export scope"}
	}
	if command.Format != "CSV" && command.Format != "PDF" {
		return tableExportDefinition{}, nil, domain.ValidationError{Field: "format", Message: "must be CSV or PDF"}
	}
	location, err := tableExportLocation(command.TimeZone)
	if err != nil {
		return tableExportDefinition{}, nil, err
	}
	if len(command.Query) == 0 || string(command.Query) == "null" {
		return tableExportDefinition{}, nil, domain.ValidationError{Field: "query", Message: "must be an object"}
	}
	return definition, location, nil
}

func tableExportLocation(name string) (*time.Location, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "UTC"
	}
	if len(name) > 64 || strings.Contains(name, "\\") || strings.Contains(name, "..") || strings.HasPrefix(name, "/") {
		return nil, domain.ValidationError{Field: "timeZone", Message: "is not a valid IANA timezone"}
	}
	location, err := time.LoadLocation(name)
	if err != nil {
		return nil, domain.ValidationError{Field: "timeZone", Message: "is not a valid IANA timezone"}
	}
	return location, nil
}

func tableExportLimits(format string) (int, int64, time.Duration) {
	if format == "PDF" {
		return tableExportPDFRowLimit, tableExportPDFByteLimit, 60 * time.Second
	}
	return tableExportCSVRowLimit, tableExportCSVByteLimit, 120 * time.Second
}

func (s *Server) acquireTableExport(request *http.Request, userID string) (func(), error) {
	if s.tableExportLimiter != nil {
		if !s.tableExportLimiter.allow("table-export:user:"+userID) || !s.tableExportLimiter.allow("table-export:ip:"+s.clientIP(request)) {
			return nil, domain.ErrRateLimited
		}
	}
	if s.tableExportSlots == nil {
		return func() {}, nil
	}
	select {
	case s.tableExportSlots <- struct{}{}:
		return func() { <-s.tableExportSlots }, nil
	default:
		return nil, domain.ErrRateLimited
	}
}

func tableExportError(err error, timeout time.Duration) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%w: table export exceeded its %d-second generation limit", domain.ErrServiceUnavailable, int(timeout.Seconds()))
	}
	return err
}

func (s *Server) activityExportAccess(ctx context.Context, membership domain.Membership) (string, error) {
	policy := authorization.NewPolicy(s.db)
	resource := authorization.GroupResource(membership.GroupID)
	viewAll, err := policy.Can(ctx, membership.GroupID, membership.ID, domain.PermissionViewAllBookingActivity, resource)
	if err != nil {
		return "", err
	}
	financeAccess, err := policy.Can(ctx, membership.GroupID, membership.ID, domain.PermissionFinanceManagement, resource)
	if err != nil {
		return "", err
	}
	return strconv.FormatBool(viewAll) + ":" + strconv.FormatBool(financeAccess), nil
}

func decodeTableQuery(raw json.RawMessage, destination any) error {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return domain.ValidationError{Field: "query", Message: "contains an invalid or unsupported value"}
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return domain.ValidationError{Field: "query", Message: "must contain one JSON object"}
	}
	return nil
}

func (s *Server) buildGroupTableDocument(ctx context.Context, membership domain.Membership, command tableExportCommand, definition tableExportDefinition, location *time.Location, rowLimit int) (tabular.Document, error) {
	var columns []tabular.Column
	var rows []tabular.Row
	var subtitle, subjectName string
	var subjectImage []byte
	var err error
	if command.Table == "SETTLEMENT_STATEMENT" {
		if err := authorization.Require(ctx, s.db, membership.GroupID, membership.ID, domain.PermissionFinanceManagement, authorization.GroupResource(membership.GroupID)); err != nil {
			return tabular.Document{}, err
		}
		content, contentErr := s.settlementStatementExportContent(ctx, membership, command.Query, location, rowLimit, command.Format == "PDF")
		if contentErr != nil {
			return tabular.Document{}, contentErr
		}
		columns, rows = content.Columns, content.Rows
		subtitle, subjectName, subjectImage = content.PeriodLabel, content.MemberName, content.MemberImagePNG
	} else {
		columns, rows, err = s.groupTableRows(ctx, membership, command, location, rowLimit)
		if err != nil {
			return tabular.Document{}, err
		}
	}
	groupName, logo, err := s.groupExportBrand(ctx, membership.GroupID)
	if err != nil {
		return tabular.Document{}, err
	}
	return tabular.Document{
		Title: definition.Title, Subtitle: subtitle, GroupName: groupName, SubjectName: subjectName,
		ExportedAt: platform.Now().In(location), LogoPNG: logo, SubjectImagePNG: subjectImage, Columns: columns, Rows: rows,
	}, nil
}

func (s *Server) buildSystemTableDocument(ctx context.Context, command tableExportCommand, definition tableExportDefinition, location *time.Location, rowLimit int) (tabular.Document, error) {
	query, err := parseAuditExportQuery(command.Query)
	if err != nil {
		return tabular.Document{}, err
	}
	items, err := collectSystemAudit(ctx, s.systemAdmin, query, rowLimit)
	if err != nil {
		return tabular.Document{}, err
	}
	columns := auditExportColumns()
	includeMedia := command.Format == "PDF"
	imageLoader := newTableExportImageLoader(s.config.DataDirectory)
	actorImages := map[string]string{}
	if includeMedia {
		actorIDs := make([]string, 0, len(items))
		for _, item := range items {
			if item.ActorUserID != nil {
				actorIDs = append(actorIDs, *item.ActorUserID)
			}
		}
		actorImages, err = loadUserImageKeys(ctx, s.db, actorIDs)
		if err != nil {
			return tabular.Document{}, err
		}
	}
	rows := make([]tabular.Row, 0, len(items))
	for _, item := range items {
		var actorImage []byte
		if includeMedia && item.ActorUserID != nil {
			actorImage, err = imageLoader.loadKey(actorImages[*item.ActorUserID])
			if err != nil {
				return tabular.Document{}, err
			}
		}
		rows = append(rows, tabular.Row{Cells: []tabular.Cell{
			textCell(formatGermanDateTime(item.OccurredAt, location)),
			imageTextCell(fallbackText(item.ActorDisplayName, "System"), actorImage),
			textCell(item.Action), textCell(auditSubject(item.ResourceType, item.ResourceID)), textCell(jsonDisplay(item.Metadata)),
		}})
	}
	return tabular.Document{Title: definition.Title, ExportedAt: platform.Now().In(location), Columns: columns, Rows: rows}, nil
}

func (s *Server) groupTableRows(ctx context.Context, membership domain.Membership, command tableExportCommand, location *time.Location, rowLimit int) ([]tabular.Column, []tabular.Row, error) {
	includeMedia := command.Format == "PDF"
	switch command.Table {
	case "ACTIVITIES":
		return s.activityExportRows(ctx, membership, command.Query, location, rowLimit, includeMedia)
	case "PAYMENTS":
		return s.paymentExportRows(ctx, membership, command.Query, location, rowLimit, includeMedia)
	case "ACCOUNT_BALANCES":
		return s.accountExportRows(ctx, membership, command.Query, rowLimit, includeMedia)
	case "GROUP_SETTLEMENTS":
		if err := authorization.Require(ctx, s.db, membership.GroupID, membership.ID, domain.PermissionFinanceManagement, authorization.GroupResource(membership.GroupID)); err != nil {
			return nil, nil, err
		}
		return s.settlementExportRows(ctx, membership, command.Query, false, rowLimit, includeMedia)
	case "PERSONAL_SETTLEMENTS":
		return s.settlementExportRows(ctx, membership, command.Query, true, rowLimit, includeMedia)
	case "ACTIVE_MEMBERS", "ARCHIVED_MEMBERS":
		if err := authorization.Require(ctx, s.db, membership.GroupID, membership.ID, domain.PermissionMemberManagement, authorization.GroupResource(membership.GroupID)); err != nil {
			return nil, nil, err
		}
		return s.memberExportRows(ctx, membership, command.Query, command.Table == "ACTIVE_MEMBERS", rowLimit, includeMedia)
	case "GROUP_AUDIT":
		return s.groupAuditExportRows(ctx, membership, command.Query, location, rowLimit, includeMedia)
	default:
		return nil, nil, domain.ValidationError{Field: "table", Message: "is not supported"}
	}
}

type activityExportQuery struct {
	Q                  string   `json:"q"`
	Sort               string   `json:"sort"`
	Direction          string   `json:"direction"`
	Kind               []string `json:"kind"`
	TargetMembershipID string   `json:"targetMembershipId"`
	CategoryID         []string `json:"categoryId"`
	ProductID          []string `json:"productId"`
	Status             string   `json:"status"`
	OccurredFrom       string   `json:"occurredFrom"`
	OccurredTo         string   `json:"occurredTo"`
	AmountMin          *string  `json:"amountMin"`
	AmountMax          *string  `json:"amountMax"`
}

func (s *Server) activityExportRows(ctx context.Context, membership domain.Membership, raw json.RawMessage, location *time.Location, limit int, includeMedia bool) ([]tabular.Column, []tabular.Row, error) {
	var wire activityExportQuery
	if err := decodeTableQuery(raw, &wire); err != nil {
		return nil, nil, err
	}
	minimum, err := parseOptionalMinorUnits("amountMin", wire.AmountMin)
	if err != nil {
		return nil, nil, err
	}
	maximum, err := parseOptionalMinorUnits("amountMax", wire.AmountMax)
	if err != nil {
		return nil, nil, err
	}
	query := activities.Query{Search: wire.Q, Sort: wire.Sort, Direction: wire.Direction, Kinds: wire.Kind, TargetMembershipID: wire.TargetMembershipID, CategoryIDs: wire.CategoryID, ProductIDs: wire.ProductID, Status: wire.Status, OccurredFrom: wire.OccurredFrom, OccurredTo: wire.OccurredTo, AmountMin: minimum, AmountMax: maximum}
	items, err := collectActivities(ctx, s.activities, membership, query, limit)
	if err != nil {
		return nil, nil, err
	}
	imageLoader := newTableExportImageLoader(s.config.DataDirectory)
	productImages := map[string]string{}
	if includeMedia {
		productIDs := make([]string, 0, len(items))
		for _, item := range items {
			productIDs = append(productIDs, item.ProductID)
		}
		productImages, err = loadProductImageKeys(ctx, s.db, membership.GroupID, productIDs)
		if err != nil {
			return nil, nil, err
		}
	}
	columns := []tabular.Column{
		{ID: "kind", Header: "Vorgang", Identity: true, WidthMM: 25},
		{ID: "member", Header: "Mitglied", Identity: true, WidthMM: 34},
		{ID: "actor", Header: "Erfasst von", WidthMM: 34},
		{ID: "details", Header: "Details", WidthMM: 55},
		{ID: "category", Header: "Kategorie", WidthMM: 32},
		{ID: "occurred_at", Header: "Zeitpunkt", WidthMM: 34},
		moneyColumn("amount", "Betrag", 31),
		{ID: "status", Header: "Status", WidthMM: 28},
	}
	rows := make([]tabular.Row, 0, len(items))
	for _, item := range items {
		var targetImage, actorImage, productImage []byte
		if includeMedia {
			if targetImage, err = imageLoader.loadURL(item.TargetAvatarURL); err != nil {
				return nil, nil, err
			}
			if actorImage, err = imageLoader.loadURL(item.ActorAvatarURL); err != nil {
				return nil, nil, err
			}
			if productImage, err = imageLoader.loadKey(productImages[item.ProductID]); err != nil {
				return nil, nil, err
			}
		}
		details := item.DetailName
		if item.Quantity > 1 {
			details += " × " + strconv.Itoa(item.Quantity)
		}
		if item.DetailNote != "" {
			details += "\n" + item.DetailNote
		}
		rows = append(rows, tabular.Row{Cells: []tabular.Cell{
			activityKindCell(item.Kind, includeMedia), imageTextCell(item.TargetDisplayName, targetImage), imageTextCell(fallbackText(item.ActorDisplayName, "Kein Akteur hinterlegt"), actorImage),
			imageTextCell(details, productImage), textCell(fallbackText(item.CategoryName, "–")), textCell(formatGermanDateTime(item.OccurredAt, location)),
			activityMoneyCell(item.AmountMinor, item.Currency, item.Kind, includeMedia), activityStatusCell(item.Kind, item.Status, includeMedia),
		}})
	}
	return columns, rows, nil
}

type paymentExportQuery struct {
	Q            string  `json:"q"`
	Sort         string  `json:"sort"`
	Direction    string  `json:"direction"`
	MembershipID string  `json:"membershipId"`
	Method       string  `json:"method"`
	Status       string  `json:"status"`
	ReceivedFrom string  `json:"receivedFrom"`
	ReceivedTo   string  `json:"receivedTo"`
	AmountMin    *string `json:"amountMin"`
	AmountMax    *string `json:"amountMax"`
}

func (s *Server) paymentExportRows(ctx context.Context, membership domain.Membership, raw json.RawMessage, location *time.Location, limit int, includeMedia bool) ([]tabular.Column, []tabular.Row, error) {
	var wire paymentExportQuery
	if err := decodeTableQuery(raw, &wire); err != nil {
		return nil, nil, err
	}
	minimum, err := parseOptionalMinorUnits("amountMin", wire.AmountMin)
	if err != nil {
		return nil, nil, err
	}
	maximum, err := parseOptionalMinorUnits("amountMax", wire.AmountMax)
	if err != nil {
		return nil, nil, err
	}
	query := finance.PaymentQuery{Search: wire.Q, Sort: wire.Sort, Direction: wire.Direction, MembershipID: wire.MembershipID, Method: wire.Method, Status: wire.Status, ReceivedFrom: wire.ReceivedFrom, ReceivedTo: wire.ReceivedTo, AmountMin: minimum, AmountMax: maximum}
	items, err := collectPayments(ctx, s.finance, membership, query, limit)
	if err != nil {
		return nil, nil, err
	}
	columns := []tabular.Column{
		{ID: "received_at", Header: "Datum", Identity: true, WidthMM: 28},
		{ID: "member", Header: "Mitglied", Identity: true, WidthMM: 43},
		{ID: "method", Header: "Zahlungsart", WidthMM: 35},
		{ID: "reference", Header: "Verwendungszweck", WidthMM: 70},
		moneyColumn("amount", "Betrag", 36),
		{ID: "status", Header: "Status", WidthMM: 30},
	}
	rows := make([]tabular.Row, 0, len(items))
	imageLoader := newTableExportImageLoader(s.config.DataDirectory)
	for _, item := range items {
		var memberImage []byte
		if includeMedia {
			memberImage, err = imageLoader.loadURL(item.MemberAvatarURL)
			if err != nil {
				return nil, nil, err
			}
		}
		member := item.MemberName
		if item.MemberStatus == domain.MembershipStatusDeleted {
			member += " (Gelöscht)"
		}
		rows = append(rows, tabular.Row{Cells: []tabular.Cell{
			textCell(formatGermanDate(item.ReceivedAt, location)), imageTextCell(member, memberImage), textCell(paymentMethodLabel(item.Method, item.MethodLabel)),
			textCell(fallbackText(item.Reference, "–")), tonedMoneyCell(item.AmountMinor, item.Currency, transactionTone(item.Status), includeMedia),
			tonedTextCell(transactionStatusLabel(item.Status), transactionTone(item.Status), includeMedia),
		}})
	}
	return columns, rows, nil
}

type accountExportQuery struct {
	Q                string   `json:"q"`
	Sort             string   `json:"sort"`
	Direction        string   `json:"direction"`
	MembershipID     string   `json:"membershipId"`
	MembershipStatus []string `json:"membershipStatus"`
	BalanceState     []string `json:"balanceState"`
	AmountMin        *string  `json:"amountMin"`
	AmountMax        *string  `json:"amountMax"`
}

func (s *Server) accountExportRows(ctx context.Context, membership domain.Membership, raw json.RawMessage, limit int, includeMedia bool) ([]tabular.Column, []tabular.Row, error) {
	var query accountExportQuery
	if err := decodeTableQuery(raw, &query); err != nil {
		return nil, nil, err
	}
	var err error
	query.Q, err = tablequery.NormalizeSearch(query.Q)
	if err != nil {
		return nil, nil, err
	}
	query.Sort, query.Direction, err = tablequery.NormalizeSort(query.Sort, query.Direction, "memberName", "asc", stringSet("memberName", "membershipStatus", "balanceState", "amount"))
	if err != nil {
		return nil, nil, err
	}
	query.MembershipID, err = normalizeExportIdentifier("membershipId", query.MembershipID)
	if err != nil {
		return nil, nil, err
	}
	query.MembershipStatus, err = normalizeExportSet("membershipStatus", query.MembershipStatus, stringSet("ACTIVE", "ARCHIVED", "DELETED"))
	if err != nil {
		return nil, nil, err
	}
	query.BalanceState, err = normalizeExportSet("balanceState", query.BalanceState, stringSet("due", "settled", "credit"))
	if err != nil {
		return nil, nil, err
	}
	minimum, err := parseOptionalMinorUnits("amountMin", query.AmountMin)
	if err != nil {
		return nil, nil, err
	}
	maximum, err := parseOptionalMinorUnits("amountMax", query.AmountMax)
	if err != nil {
		return nil, nil, err
	}
	if minimum != nil && maximum != nil && *minimum > *maximum {
		return nil, nil, domain.ValidationError{Field: "amountMax", Message: "must be greater than or equal to amountMin"}
	}
	items, err := s.finance.ListAccountSummaries(ctx, membership)
	if err != nil {
		return nil, nil, err
	}
	filtered := items[:0]
	for index, item := range items {
		if index%256 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, nil, err
			}
		}
		if !matchesFold(item.DisplayName, query.Q) || (query.MembershipID != "" && item.MembershipID != query.MembershipID) ||
			(len(query.MembershipStatus) > 0 && !slices.Contains(query.MembershipStatus, item.Status)) ||
			(len(query.BalanceState) > 0 && !slices.Contains(query.BalanceState, balanceState(item.BalanceMinor))) ||
			(minimum != nil && item.BalanceMinor < *minimum) || (maximum != nil && item.BalanceMinor > *maximum) {
			continue
		}
		filtered = append(filtered, item)
	}
	items = filtered
	if err := sortAccountSummaries(items, query.Sort, query.Direction); err != nil {
		return nil, nil, err
	}
	if err := enforceTableRowLimit(len(items), limit); err != nil {
		return nil, nil, err
	}
	columns := []tabular.Column{
		{ID: "member", Header: "Mitglied", Identity: true, WidthMM: 80},
		{ID: "membership_status", Header: "Mitgliedschaft", WidthMM: 50},
		{ID: "balance_state", Header: "Saldostand", WidthMM: 50},
		moneyColumn("amount", "Saldo", 50),
	}
	rows := make([]tabular.Row, 0, len(items))
	imageLoader := newTableExportImageLoader(s.config.DataDirectory)
	for _, item := range items {
		var memberImage []byte
		if includeMedia {
			memberImage, err = imageLoader.loadURL(item.AvatarURL)
			if err != nil {
				return nil, nil, err
			}
		}
		rows = append(rows, tabular.Row{Cells: []tabular.Cell{
			imageTextCell(item.DisplayName, memberImage), tonedTextCell(membershipStatusLabel(item.Status), membershipTone(item.Status), includeMedia),
			tonedTextCell(balanceStateLabel(item.BalanceMinor), balanceTone(item.BalanceMinor), includeMedia),
			tonedMoneyCell(item.BalanceMinor, item.Currency, balanceTone(item.BalanceMinor), includeMedia),
		}})
	}
	return columns, rows, nil
}

type settlementExportQuery struct {
	Q                string   `json:"q"`
	Sort             string   `json:"sort"`
	Direction        string   `json:"direction"`
	MembershipID     string   `json:"membershipId"`
	MembershipStatus []string `json:"membershipStatus"`
	PeriodID         string   `json:"periodId"`
	DueFrom          string   `json:"dueFrom"`
	DueTo            string   `json:"dueTo"`
	AmountMin        *string  `json:"amountMin"`
	AmountMax        *string  `json:"amountMax"`
	Status           []string `json:"status"`
}

type settlementStatementExportQuery struct {
	MembershipID string `json:"membershipId"`
	PeriodID     string `json:"periodId"`
}

type settlementStatementBooking struct {
	ID, ProductID, ActorName, ActorImageKey, ProductName, CategoryName, Reason, CreatedAt, Currency, VoidReason string
	Quantity, TotalMinor                                                                                        int64
	VoidedAt                                                                                                    sql.NullString
}

type settlementStatementContent struct {
	PeriodLabel, MemberName string
	MemberImagePNG          []byte
	Columns                 []tabular.Column
	Rows                    []tabular.Row
}

func (s *Server) settlementStatementExportContent(ctx context.Context, membership domain.Membership, raw json.RawMessage, location *time.Location, limit int, includeMedia bool) (settlementStatementContent, error) {
	var query settlementStatementExportQuery
	if err := decodeTableQuery(raw, &query); err != nil {
		return settlementStatementContent{}, err
	}
	var err error
	query.MembershipID, err = normalizeExportIdentifier("membershipId", query.MembershipID)
	if err != nil {
		return settlementStatementContent{}, err
	}
	query.PeriodID, err = normalizeExportIdentifier("periodId", query.PeriodID)
	if err != nil {
		return settlementStatementContent{}, err
	}
	if query.MembershipID == "" {
		return settlementStatementContent{}, domain.ValidationError{Field: "membershipId", Message: "must not be empty"}
	}
	if query.PeriodID == "" {
		return settlementStatementContent{}, domain.ValidationError{Field: "periodId", Message: "must not be empty"}
	}

	content := settlementStatementContent{}
	var memberImageKey string
	if err := s.db.QueryRowContext(ctx, `SELECT period.label,statement.display_name,coalesce(user.avatar_key,'')
		FROM period_statements statement
		JOIN periods period ON period.group_id=statement.group_id AND period.id=statement.period_id
		JOIN memberships membership ON membership.group_id=statement.group_id AND membership.id=statement.membership_id
		JOIN users user ON user.id=membership.user_id
		WHERE statement.group_id=? AND statement.period_id=? AND statement.membership_id=?`, membership.GroupID, query.PeriodID, query.MembershipID).
		Scan(&content.PeriodLabel, &content.MemberName, &memberImageKey); errors.Is(err, sql.ErrNoRows) {
		return settlementStatementContent{}, domain.ErrNotFound
	} else if err != nil {
		return settlementStatementContent{}, err
	}

	bookingRows, err := s.db.QueryContext(ctx, `SELECT booking.id,booking.product_id,actor.display_name,coalesce(actor.avatar_key,''),
		booking.quantity,booking.total_minor,team.currency,booking.product_name,booking.category_name,coalesce(booking.reason,''),
		booking.created_at,booking.voided_at,coalesce(booking.void_reason,'')
		FROM bookings booking
		JOIN groups team ON team.id=booking.group_id
		JOIN memberships actor_membership ON actor_membership.group_id=booking.group_id AND actor_membership.id=booking.actor_membership_id
		JOIN users actor ON actor.id=actor_membership.user_id
		WHERE booking.group_id=? AND booking.period_id=? AND booking.target_membership_id=?
		ORDER BY booking.created_at,booking.id LIMIT ?`, membership.GroupID, query.PeriodID, query.MembershipID, limit+1)
	if err != nil {
		return settlementStatementContent{}, err
	}
	defer bookingRows.Close()
	items := make([]settlementStatementBooking, 0)
	for bookingRows.Next() {
		var item settlementStatementBooking
		if err := bookingRows.Scan(&item.ID, &item.ProductID, &item.ActorName, &item.ActorImageKey, &item.Quantity, &item.TotalMinor, &item.Currency,
			&item.ProductName, &item.CategoryName, &item.Reason, &item.CreatedAt, &item.VoidedAt, &item.VoidReason); err != nil {
			return settlementStatementContent{}, err
		}
		items = append(items, item)
	}
	if err := bookingRows.Err(); err != nil {
		return settlementStatementContent{}, err
	}
	if err := enforceTableRowLimit(len(items), limit); err != nil {
		return settlementStatementContent{}, err
	}

	content.Columns = []tabular.Column{
		{ID: "kind", Header: "Vorgang", Identity: true, WidthMM: 25},
		{ID: "actor", Header: "Erfasst von", Identity: true, WidthMM: 42},
		{ID: "details", Header: "Details", WidthMM: 72},
		{ID: "category", Header: "Kategorie", WidthMM: 36},
		{ID: "occurred_at", Header: "Zeitpunkt", WidthMM: 36},
		moneyColumn("amount", "Betrag", 32),
		{ID: "status", Header: "Status", WidthMM: 30},
	}
	imageLoader := newTableExportImageLoader(s.config.DataDirectory)
	productImages := map[string]string{}
	if includeMedia {
		productIDs := make([]string, 0, len(items))
		for _, item := range items {
			productIDs = append(productIDs, item.ProductID)
		}
		productImages, err = loadProductImageKeys(ctx, s.db, membership.GroupID, productIDs)
		if err != nil {
			return settlementStatementContent{}, err
		}
		content.MemberImagePNG, err = imageLoader.loadKey(memberImageKey)
		if err != nil {
			return settlementStatementContent{}, err
		}
	}
	content.Rows = make([]tabular.Row, 0, len(items))
	for _, item := range items {
		var actorImage, productImage []byte
		if includeMedia {
			actorImage, err = imageLoader.loadKey(item.ActorImageKey)
			if err != nil {
				return settlementStatementContent{}, err
			}
			productImage, err = imageLoader.loadKey(productImages[item.ProductID])
			if err != nil {
				return settlementStatementContent{}, err
			}
		}
		details := item.ProductName
		if item.Quantity > 1 {
			details += " × " + strconv.FormatInt(item.Quantity, 10)
		}
		if item.Reason != "" {
			details += "\n" + item.Reason
		}
		status := "POSTED"
		if item.VoidedAt.Valid {
			status = "REVERSED"
			if item.VoidReason != "" {
				details += "\nStornogrund: " + item.VoidReason
			}
		}
		content.Rows = append(content.Rows, tabular.Row{Cells: []tabular.Cell{
			activityKindCell(activities.KindBooking, includeMedia), imageTextCell(item.ActorName, actorImage), imageTextCell(details, productImage),
			textCell(fallbackText(item.CategoryName, "–")), textCell(formatGermanDateTime(item.CreatedAt, location)),
			activityMoneyCell(item.TotalMinor, item.Currency, activities.KindBooking, includeMedia), activityStatusCell(activities.KindBooking, status, includeMedia),
		}})
	}
	return content, nil
}

type settlementExportItem struct {
	ID, PeriodID, PeriodLabel, MembershipID, MembershipStatus, MemberName, Email, DueAt, Currency, Status string
	AmountMinor, PaidMinor, OpenMinor                                                                     int64
}

func (s *Server) settlementExportRows(ctx context.Context, membership domain.Membership, raw json.RawMessage, personal bool, limit int, includeMedia bool) ([]tabular.Column, []tabular.Row, error) {
	var query settlementExportQuery
	if err := decodeTableQuery(raw, &query); err != nil {
		return nil, nil, err
	}
	if personal && (query.MembershipID != "" || len(query.MembershipStatus) > 0 || query.AmountMin != nil || query.AmountMax != nil) {
		return nil, nil, domain.ValidationError{Field: "query", Message: "contains filters unavailable for personal settlements"}
	}
	var err error
	query.Q, err = tablequery.NormalizeSearch(query.Q)
	if err != nil {
		return nil, nil, err
	}
	allowedSorts := stringSet("periodLabel", "dueAt", "amount", "paidAmount", "status", "memberName", "membershipStatus")
	if personal {
		allowedSorts = stringSet("periodLabel", "dueAt", "amount", "paidAmount", "openAmount", "status")
	}
	query.Sort, query.Direction, err = tablequery.NormalizeSort(query.Sort, query.Direction, "dueAt", "desc", allowedSorts)
	if err != nil {
		return nil, nil, err
	}
	query.MembershipID, err = normalizeExportIdentifier("membershipId", query.MembershipID)
	if err != nil {
		return nil, nil, err
	}
	query.PeriodID, err = normalizeExportIdentifier("periodId", query.PeriodID)
	if err != nil {
		return nil, nil, err
	}
	query.DueFrom, err = normalizeExportDate("dueFrom", query.DueFrom)
	if err != nil {
		return nil, nil, err
	}
	query.DueTo, err = normalizeExportDate("dueTo", query.DueTo)
	if err != nil {
		return nil, nil, err
	}
	if query.DueFrom != "" && query.DueTo != "" && query.DueFrom > query.DueTo {
		return nil, nil, domain.ValidationError{Field: "dueTo", Message: "must be on or after dueFrom"}
	}
	query.Status, err = normalizeExportSet("status", query.Status, stringSet("OPEN", "PARTIAL", "PAID", "CREDIT"))
	if err != nil {
		return nil, nil, err
	}
	query.MembershipStatus, err = normalizeExportSet("membershipStatus", query.MembershipStatus, stringSet(domain.MembershipStatusActive, domain.MembershipStatusArchived, domain.MembershipStatusDeleted))
	if err != nil {
		return nil, nil, err
	}
	minimum, err := parseOptionalMinorUnits("amountMin", query.AmountMin)
	if err != nil {
		return nil, nil, err
	}
	maximum, err := parseOptionalMinorUnits("amountMax", query.AmountMax)
	if err != nil {
		return nil, nil, err
	}
	if minimum != nil && maximum != nil && *minimum > *maximum {
		return nil, nil, domain.ValidationError{Field: "amountMax", Message: "must be greater than or equal to amountMin"}
	}
	statements, err := s.periods.Statements(ctx, membership, query.PeriodID)
	if err != nil {
		return nil, nil, err
	}
	periodItems, err := s.periods.List(ctx, membership.GroupID)
	if err != nil {
		return nil, nil, err
	}
	periodByID := make(map[string]domain.Period, len(periodItems))
	for _, period := range periodItems {
		periodByID[period.ID] = period
	}
	items := make([]settlementExportItem, 0, len(statements))
	for index, statement := range statements {
		if index%256 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, nil, err
			}
		}
		if personal && statement.MembershipID != membership.ID {
			continue
		}
		period := periodByID[statement.PeriodID]
		email := ""
		if statement.Email != nil {
			email = *statement.Email
		}
		item := settlementExportItem{ID: statement.ID, PeriodID: statement.PeriodID, PeriodLabel: fallbackText(period.Label, "Unbekannte Periode"), MembershipID: statement.MembershipID, MembershipStatus: statement.MembershipStatus, MemberName: statement.DisplayName, Email: email, Currency: statement.Currency, Status: statement.Status, AmountMinor: statement.ChargesMinor + statement.AdjustmentsProvidedMinor, PaidMinor: statement.PaymentsAllocatedMinor + statement.AdjustmentsAppliedMinor, OpenMinor: statement.AmountDueMinor}
		if period.DueAt != nil {
			item.DueAt = *period.DueAt
		}
		if (query.MembershipID != "" && item.MembershipID != query.MembershipID) ||
			(len(query.MembershipStatus) > 0 && !slices.Contains(query.MembershipStatus, item.MembershipStatus)) ||
			(query.DueFrom != "" && item.DueAt < query.DueFrom) || (query.DueTo != "" && item.DueAt > query.DueTo) ||
			(minimum != nil && item.AmountMinor < *minimum) || (maximum != nil && item.AmountMinor > *maximum) ||
			(len(query.Status) > 0 && !slices.Contains(query.Status, item.Status)) {
			continue
		}
		searchable := item.PeriodLabel
		if !personal {
			searchable += " " + item.MemberName + " " + item.Email
		}
		if !matchesFold(searchable, query.Q) {
			continue
		}
		items = append(items, item)
	}
	if err := sortSettlements(items, query.Sort, query.Direction, personal); err != nil {
		return nil, nil, err
	}
	if err := enforceTableRowLimit(len(items), limit); err != nil {
		return nil, nil, err
	}
	columns := []tabular.Column{{ID: "period", Header: "Periode", Identity: true, WidthMM: 42}}
	if !personal {
		columns = append(columns,
			tabular.Column{ID: "member", Header: "Mitglied", Identity: true, WidthMM: 50},
			tabular.Column{ID: "membership_status", Header: "Mitgliedschaft", WidthMM: 36},
		)
	}
	columns = append(columns,
		tabular.Column{ID: "due_at", Header: "Fällig", WidthMM: 28},
		moneyColumn("amount", "Forderung", 32), moneyColumn("paid", "Bezahlt", 32),
	)
	if personal {
		columns = append(columns, moneyColumn("open", "Offen", 34))
	}
	columns = append(columns, tabular.Column{ID: "status", Header: "Status", WidthMM: 28})
	imageLoader := newTableExportImageLoader(s.config.DataDirectory)
	membershipImages := map[string]string{}
	if includeMedia && !personal {
		membershipIDs := make([]string, 0, len(items))
		for _, item := range items {
			membershipIDs = append(membershipIDs, item.MembershipID)
		}
		membershipImages, err = loadMembershipImageKeys(ctx, s.db, membership.GroupID, membershipIDs)
		if err != nil {
			return nil, nil, err
		}
	}
	rows := make([]tabular.Row, 0, len(items))
	for _, item := range items {
		cells := []tabular.Cell{textCell(item.PeriodLabel)}
		if !personal {
			var memberImage []byte
			if includeMedia {
				memberImage, err = imageLoader.loadKey(membershipImages[item.MembershipID])
				if err != nil {
					return nil, nil, err
				}
			}
			cells = append(cells, imageTextCell(item.MemberName, memberImage), tonedTextCell(membershipStatusLabel(item.MembershipStatus), membershipTone(item.MembershipStatus), includeMedia))
		}
		cells = append(cells, textCell(formatGermanDate(item.DueAt, time.UTC)),
			tonedMoneyCell(item.AmountMinor, item.Currency, balanceTone(item.AmountMinor), includeMedia),
			tonedMoneyCell(item.PaidMinor, item.Currency, paidAmountTone(item.PaidMinor), includeMedia))
		if personal {
			cells = append(cells, tonedMoneyCell(item.OpenMinor, item.Currency, balanceTone(item.OpenMinor), includeMedia))
		}
		cells = append(cells, tonedTextCell(settlementStatusLabel(item.Status), settlementTone(item.Status), includeMedia))
		rows = append(rows, tabular.Row{Cells: cells})
	}
	return columns, rows, nil
}

type memberExportQuery struct {
	Sort      string `json:"sort"`
	Direction string `json:"direction"`
}

func (s *Server) memberExportRows(ctx context.Context, membership domain.Membership, raw json.RawMessage, active bool, limit int, includeMedia bool) ([]tabular.Column, []tabular.Row, error) {
	var query memberExportQuery
	if err := decodeTableQuery(raw, &query); err != nil {
		return nil, nil, err
	}
	allowedSorts := stringSet("displayName", "email")
	if active {
		allowedSorts["roles"] = struct{}{}
	}
	var err error
	query.Sort, query.Direction, err = tablequery.NormalizeSort(query.Sort, query.Direction, "displayName", "asc", allowedSorts)
	if err != nil {
		return nil, nil, err
	}
	items, err := s.groups.ListMembers(ctx, membership)
	if err != nil {
		return nil, nil, err
	}
	wantedStatus := domain.MembershipStatusArchived
	if active {
		wantedStatus = domain.MembershipStatusActive
	}
	items = slices.DeleteFunc(items, func(item domain.Membership) bool { return item.Status != wantedStatus })
	roleNames := map[string]map[string]string{}
	if active {
		roleNames, err = membershipRoleNames(ctx, s.db, membership.GroupID)
		if err != nil {
			return nil, nil, err
		}
	}
	if err := sortMemberships(items, roleNames, query.Sort, query.Direction); err != nil {
		return nil, nil, err
	}
	if err := enforceTableRowLimit(len(items), limit); err != nil {
		return nil, nil, err
	}
	columns := []tabular.Column{{ID: "member", Header: "Mitglied", Identity: true, WidthMM: 90}, {ID: "email", Header: "E-Mail", WidthMM: 90}}
	if active {
		columns = append(columns, tabular.Column{ID: "roles", Header: "Rollen", WidthMM: 90})
	}
	rows := make([]tabular.Row, 0, len(items))
	imageLoader := newTableExportImageLoader(s.config.DataDirectory)
	for _, item := range items {
		var memberImage []byte
		if includeMedia {
			memberImage, err = imageLoader.loadURL(item.AvatarURL)
			if err != nil {
				return nil, nil, err
			}
		}
		name := item.DisplayName
		if item.IsTemporaryGuest {
			name += " (Temporärer Gast)"
		}
		email := ""
		if item.Email != nil {
			email = *item.Email
		}
		cells := []tabular.Cell{imageTextCell(name, memberImage), textCell(fallbackText(email, "–"))}
		if active {
			cells = append(cells, textCell(strings.Join(resolvedRoleNames(item, roleNames), ", ")))
		}
		rows = append(rows, tabular.Row{Cells: cells})
	}
	return columns, rows, nil
}

func (s *Server) groupAuditExportRows(ctx context.Context, membership domain.Membership, raw json.RawMessage, location *time.Location, limit int, includeMedia bool) ([]tabular.Column, []tabular.Row, error) {
	if err := authorization.Require(ctx, s.db, membership.GroupID, membership.ID, domain.PermissionGroupAdministration, authorization.GroupResource(membership.GroupID)); err != nil {
		return nil, nil, err
	}
	query, err := parseAuditExportQuery(raw)
	if err != nil {
		return nil, nil, err
	}
	items, err := collectGroupAudit(ctx, s.db, membership.GroupID, query, limit)
	if err != nil {
		return nil, nil, err
	}
	columns := auditExportColumns()
	imageLoader := newTableExportImageLoader(s.config.DataDirectory)
	actorImages := map[string]string{}
	if includeMedia {
		actorIDs := make([]string, 0, len(items))
		for _, item := range items {
			if item.ActorUserID != nil {
				actorIDs = append(actorIDs, *item.ActorUserID)
			}
		}
		actorImages, err = loadUserImageKeys(ctx, s.db, actorIDs)
		if err != nil {
			return nil, nil, err
		}
	}
	rows := make([]tabular.Row, 0, len(items))
	for _, item := range items {
		var actorImage []byte
		if includeMedia && item.ActorUserID != nil {
			actorImage, err = imageLoader.loadKey(actorImages[*item.ActorUserID])
			if err != nil {
				return nil, nil, err
			}
		}
		rows = append(rows, tabular.Row{Cells: []tabular.Cell{
			textCell(formatGermanDateTime(item.OccurredAt, location)), imageTextCell(fallbackText(item.ActorDisplayName, "System"), actorImage), textCell(item.Action),
			textCell(auditSubject(item.ResourceType, item.ResourceID)), textCell(jsonDisplay(item.Metadata)),
		}})
	}
	return columns, rows, nil
}

type auditExportQuery struct {
	Q                 string   `json:"q"`
	ActorUserID       string   `json:"actorUserId"`
	ActorMembershipID string   `json:"actorMembershipId"`
	Action            []string `json:"action"`
	ResourceType      []string `json:"resourceType"`
	OccurredFrom      string   `json:"occurredFrom"`
	OccurredTo        string   `json:"occurredTo"`
	Sort              string   `json:"sort"`
	Direction         string   `json:"direction"`
}

func parseAuditExportQuery(raw json.RawMessage) (tablequery.AuditQuery, error) {
	var wire auditExportQuery
	if err := decodeTableQuery(raw, &wire); err != nil {
		return tablequery.AuditQuery{}, err
	}
	return tablequery.AuditQuery{Search: wire.Q, ActorUserID: wire.ActorUserID, ActorMembershipID: wire.ActorMembershipID, Actions: wire.Action, ResourceTypes: wire.ResourceType, OccurredFrom: wire.OccurredFrom, OccurredTo: wire.OccurredTo, Sort: wire.Sort, Direction: wire.Direction}, nil
}

func collectActivities(ctx context.Context, service activities.Service, membership domain.Membership, query activities.Query, limit int) ([]activities.Entry, error) {
	items := make([]activities.Entry, 0)
	seen := make(map[string]struct{})
	for {
		query.Limit = 200
		page, err := service.QueryEntries(ctx, membership, query)
		if err != nil {
			return nil, err
		}
		items = append(items, page.Items...)
		if err := enforceTableRowLimit(len(items), limit); err != nil {
			return nil, err
		}
		if page.NextCursor == "" {
			return items, nil
		}
		if _, duplicate := seen[page.NextCursor]; duplicate {
			return nil, errors.New("activity export pagination returned a duplicate cursor")
		}
		seen[page.NextCursor] = struct{}{}
		query.Cursor = page.NextCursor
	}
}

func collectPayments(ctx context.Context, service finance.Service, membership domain.Membership, query finance.PaymentQuery, limit int) ([]domain.Payment, error) {
	items := make([]domain.Payment, 0)
	seen := make(map[string]struct{})
	for {
		query.Limit = 200
		page, err := service.QueryPayments(ctx, membership, query)
		if err != nil {
			return nil, err
		}
		items = append(items, page.Items...)
		if err := enforceTableRowLimit(len(items), limit); err != nil {
			return nil, err
		}
		if page.NextCursor == "" {
			return items, nil
		}
		if _, duplicate := seen[page.NextCursor]; duplicate {
			return nil, errors.New("payment export pagination returned a duplicate cursor")
		}
		seen[page.NextCursor] = struct{}{}
		query.Cursor = page.NextCursor
	}
}

func collectGroupAudit(ctx context.Context, db *sql.DB, groupID string, query tablequery.AuditQuery, limit int) ([]audit.Event, error) {
	items := make([]audit.Event, 0)
	seen := make(map[string]struct{})
	for {
		query.Limit = 200
		page, err := audit.Query(ctx, db, groupID, query)
		if err != nil {
			return nil, err
		}
		items = append(items, page.Items...)
		if err := enforceTableRowLimit(len(items), limit); err != nil {
			return nil, err
		}
		if page.NextCursor == "" {
			return items, nil
		}
		if _, duplicate := seen[page.NextCursor]; duplicate {
			return nil, errors.New("group audit export pagination returned a duplicate cursor")
		}
		seen[page.NextCursor] = struct{}{}
		query.Cursor = page.NextCursor
	}
}

func collectSystemAudit(ctx context.Context, service systemadmin.Service, query tablequery.AuditQuery, limit int) ([]systemadmin.AuditEvent, error) {
	items := make([]systemadmin.AuditEvent, 0)
	seen := make(map[string]struct{})
	for {
		query.Limit = 200
		page, err := service.QueryAudit(ctx, query)
		if err != nil {
			return nil, err
		}
		items = append(items, page.Items...)
		if err := enforceTableRowLimit(len(items), limit); err != nil {
			return nil, err
		}
		if page.NextCursor == "" {
			return items, nil
		}
		if _, duplicate := seen[page.NextCursor]; duplicate {
			return nil, errors.New("system audit export pagination returned a duplicate cursor")
		}
		seen[page.NextCursor] = struct{}{}
		query.Cursor = page.NextCursor
	}
}

func enforceTableRowLimit(count, limit int) error {
	if count > limit {
		return fmt.Errorf("%w: table export exceeds the %d-row limit", domain.ErrPayloadTooLarge, limit)
	}
	return nil
}

func stringSet(values ...string) map[string]struct{} {
	result := make(map[string]struct{}, len(values))
	for _, value := range values {
		result[value] = struct{}{}
	}
	return result
}

func normalizeExportIdentifier(field, value string) (string, error) {
	value = strings.TrimSpace(value)
	if len(value) > 200 {
		return "", domain.ValidationError{Field: field, Message: "must contain at most 200 characters"}
	}
	return value, nil
}

func normalizeExportDate(field, value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	if _, err := time.Parse("2006-01-02", value); err != nil {
		return "", domain.ValidationError{Field: field, Message: "must be an ISO 8601 date"}
	}
	return value, nil
}

func normalizeExportSet(field string, values []string, allowed map[string]struct{}) ([]string, error) {
	if len(values) > 100 {
		return nil, domain.ValidationError{Field: field, Message: "must contain at most 100 values"}
	}
	unique := make(map[string]struct{}, len(values))
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" {
			continue
		}
		if _, exists := allowed[value]; !exists {
			return nil, domain.ValidationError{Field: field, Message: "contains an unsupported value"}
		}
		unique[value] = struct{}{}
	}
	result := make([]string, 0, len(unique))
	for value := range unique {
		result = append(result, value)
	}
	sort.Strings(result)
	return result, nil
}

func parseOptionalMinorUnits(field string, value *string) (*int64, error) {
	if value == nil {
		return nil, nil
	}
	parsed, err := strconv.ParseInt(*value, 10, 64)
	if err != nil || strconv.FormatInt(parsed, 10) != *value {
		return nil, domain.ValidationError{Field: field, Message: "must be a canonical integer minor-unit string"}
	}
	return &parsed, nil
}

type tableExportImageLoader struct {
	dataDirectory string
	cache         map[string][]byte
	loaded        map[string]bool
}

// newTableExportImageLoader creates a request-local, content-keyed media cache.
func newTableExportImageLoader(dataDirectory string) *tableExportImageLoader {
	return &tableExportImageLoader{dataDirectory: dataDirectory, cache: map[string][]byte{}, loaded: map[string]bool{}}
}

// loadURL extracts only a validated managed-image key from an internal URL.
func (loader *tableExportImageLoader) loadURL(value string) ([]byte, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return nil, nil
	}
	return loader.loadKey(path.Base(parsed.Path))
}

// loadKey reads one validated managed image at most once per table export.
func (loader *tableExportImageLoader) loadKey(key string) ([]byte, error) {
	if !media.ValidImageKey(key) {
		return nil, nil
	}
	if loader.loaded[key] {
		return loader.cache[key], nil
	}
	loader.loaded[key] = true
	imagePath, err := media.ResolveImage(loader.dataDirectory, key)
	if err != nil {
		return nil, nil
	}
	content, err := os.ReadFile(imagePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read table export image: %w", err)
	}
	loader.cache[key] = content
	return content, nil
}

// loadProductImageKeys resolves only product IDs already present in authorized rows.
func loadProductImageKeys(ctx context.Context, db *sql.DB, groupID string, productIDs []string) (map[string]string, error) {
	return queryTableExportImageKeys(ctx, db,
		`SELECT id,coalesce(image_key,'') FROM products WHERE group_id=? AND id IN (%s)`, []any{groupID}, productIDs)
}

// loadMembershipImageKeys resolves group-scoped membership avatars in bounded batches.
func loadMembershipImageKeys(ctx context.Context, db *sql.DB, groupID string, membershipIDs []string) (map[string]string, error) {
	return queryTableExportImageKeys(ctx, db,
		`SELECT membership.id,coalesce(user.avatar_key,'') FROM memberships membership JOIN users user ON user.id=membership.user_id WHERE membership.group_id=? AND membership.id IN (%s)`, []any{groupID}, membershipIDs)
}

// loadUserImageKeys resolves actor avatars for already-authorized audit rows.
func loadUserImageKeys(ctx context.Context, db *sql.DB, userIDs []string) (map[string]string, error) {
	return queryTableExportImageKeys(ctx, db,
		`SELECT id,coalesce(avatar_key,'') FROM users WHERE id IN (%s)`, nil, userIDs)
}

// queryTableExportImageKeys deduplicates identifiers and stays below SQLite's bind limit.
func queryTableExportImageKeys(ctx context.Context, db *sql.DB, queryTemplate string, scopeArguments []any, identifiers []string) (map[string]string, error) {
	const batchSize = 200
	unique := make(map[string]struct{}, len(identifiers))
	for _, identifier := range identifiers {
		if identifier = strings.TrimSpace(identifier); identifier != "" {
			unique[identifier] = struct{}{}
		}
	}
	ordered := make([]string, 0, len(unique))
	for identifier := range unique {
		ordered = append(ordered, identifier)
	}
	sort.Strings(ordered)
	result := make(map[string]string, len(ordered))
	for start := 0; start < len(ordered); start += batchSize {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		end := min(start+batchSize, len(ordered))
		batch := ordered[start:end]
		arguments := append([]any(nil), scopeArguments...)
		placeholders := make([]string, len(batch))
		for index, identifier := range batch {
			placeholders[index] = "?"
			arguments = append(arguments, identifier)
		}
		rows, err := db.QueryContext(ctx, fmt.Sprintf(queryTemplate, strings.Join(placeholders, ",")), arguments...)
		if err != nil {
			return nil, fmt.Errorf("load table export image keys: %w", err)
		}
		for rows.Next() {
			var identifier, imageKey string
			if err := rows.Scan(&identifier, &imageKey); err != nil {
				rows.Close()
				return nil, err
			}
			if media.ValidImageKey(imageKey) {
				result[identifier] = imageKey
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func (s *Server) groupExportBrand(ctx context.Context, groupID string) (string, []byte, error) {
	var groupName string
	var imageKey sql.NullString
	if err := s.db.QueryRowContext(ctx, `SELECT name,logo_key FROM groups WHERE id=?`, groupID).Scan(&groupName, &imageKey); errors.Is(err, sql.ErrNoRows) {
		return "", nil, domain.ErrNotFound
	} else if err != nil {
		return "", nil, err
	}
	if !imageKey.Valid || imageKey.String == "" {
		return groupName, nil, nil
	}
	imagePath, err := media.ResolveImage(s.config.DataDirectory, imageKey.String)
	if err != nil {
		return groupName, nil, nil
	}
	content, err := os.ReadFile(imagePath)
	if errors.Is(err, os.ErrNotExist) {
		return groupName, nil, nil
	}
	if err != nil {
		return "", nil, err
	}
	return groupName, content, nil
}

func (s *Server) recordGroupTableExport(ctx context.Context, principal domain.Principal, membership domain.Membership, command tableExportCommand, rowCount int) error {
	fingerprint := sha256.Sum256(command.Query)
	return storage.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		permission := tableExportPermission(command.Table)
		if permission != "" {
			if err := authorization.Require(ctx, tx, membership.GroupID, membership.ID, permission, authorization.GroupResource(membership.GroupID)); err != nil {
				return err
			}
		} else {
			var current int
			if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM memberships WHERE id=? AND group_id=? AND user_id=? AND status='ACTIVE' AND deleted_at IS NULL`, membership.ID, membership.GroupID, principal.UserID).Scan(&current); err != nil {
				return err
			}
			if current != 1 {
				return domain.ErrForbidden
			}
		}
		return audit.Record(ctx, tx, membership.GroupID, principal.UserID, membership.ID, "table.exported", "table", strings.ToLower(command.Table), map[string]any{
			"format": command.Format, "rowCount": rowCount, "queryFingerprint": hex.EncodeToString(fingerprint[:]),
		})
	})
}

func tableExportPermission(table string) domain.PermissionKey {
	switch table {
	case "PAYMENTS", "ACCOUNT_BALANCES", "GROUP_SETTLEMENTS", "SETTLEMENT_STATEMENT":
		return domain.PermissionFinanceManagement
	case "GROUP_AUDIT":
		return domain.PermissionGroupAdministration
	case "ACTIVE_MEMBERS", "ARCHIVED_MEMBERS":
		return domain.PermissionMemberManagement
	default:
		return ""
	}
}

func (s *Server) recordSystemTableExport(ctx context.Context, principal domain.Principal, command tableExportCommand, rowCount int) error {
	fingerprint := sha256.Sum256(command.Query)
	return storage.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		if err := s.systemAdmin.RequireAdministrator(ctx, principal.UserID); err != nil {
			return err
		}
		return systemadmin.RecordAudit(ctx, tx, principal.UserID, "table.exported", "system_table", strings.ToLower(command.Table), map[string]any{
			"format": command.Format, "rowCount": rowCount, "queryFingerprint": hex.EncodeToString(fingerprint[:]),
		})
	})
}

type tableArtifact struct {
	File        *os.File
	ContentType string
	Extension   string
}

func renderTableArtifact(ctx context.Context, document tabular.Document, format string, byteLimit int64) (tableArtifact, error) {
	file, err := os.CreateTemp("", "teamtaler-table-export-*")
	if err != nil {
		return tableArtifact{}, err
	}
	artifact := tableArtifact{File: file}
	limited := &tableArtifactWriter{Writer: file, Remaining: byteLimit}
	if format == "PDF" {
		artifact.ContentType, artifact.Extension = "application/pdf", "pdf"
		err = tabular.WritePDFContext(ctx, limited, document)
	} else {
		artifact.ContentType, artifact.Extension = "text/csv; charset=utf-8", "csv"
		err = tabular.WriteCSVContext(ctx, limited, document)
	}
	if err == nil {
		err = file.Sync()
	}
	if err == nil {
		_, err = file.Seek(0, io.SeekStart)
	}
	if err != nil {
		removeTableArtifact(artifact)
		if errors.Is(err, errTableArtifactTooLarge) {
			return tableArtifact{}, fmt.Errorf("%w: rendered table export exceeds the %d-byte limit", domain.ErrPayloadTooLarge, byteLimit)
		}
		return tableArtifact{}, err
	}
	return artifact, nil
}

var errTableArtifactTooLarge = errors.New("table artifact exceeds its byte limit")

type tableArtifactWriter struct {
	Writer    io.Writer
	Remaining int64
}

func (writer *tableArtifactWriter) Write(content []byte) (int, error) {
	if int64(len(content)) > writer.Remaining {
		return 0, errTableArtifactTooLarge
	}
	written, err := writer.Writer.Write(content)
	writer.Remaining -= int64(written)
	return written, err
}

func removeTableArtifact(artifact tableArtifact) {
	if artifact.File == nil {
		return
	}
	name := artifact.File.Name()
	_ = artifact.File.Close()
	_ = os.Remove(name)
}

func serveTableArtifact(response http.ResponseWriter, request *http.Request, artifact tableArtifact, title, format string, exportedAt time.Time) {
	metadata, err := artifact.File.Stat()
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	filename := tableArtifactFilename(title, format, artifact.Extension, exportedAt)
	response.Header().Set("Content-Type", artifact.ContentType)
	response.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
	response.Header().Set("Content-Length", strconv.FormatInt(metadata.Size(), 10))
	response.Header().Set("Cache-Control", "private, no-store")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	_ = http.NewResponseController(response).SetWriteDeadline(time.Now().Add(2 * time.Minute))
	http.ServeContent(response, request, filename, exportedAt, artifact.File)
}

func tableArtifactFilename(title, format, extension string, exportedAt time.Time) string {
	stem := safeTableExportFilename(title)
	date := exportedAt.Format("2006-01-02")
	if format == "PDF" {
		return date + "_" + stem + "." + extension
	}
	return stem + "-" + date + "." + extension
}

func safeTableExportFilename(title string) string {
	var builder strings.Builder
	separatorPending := false
	for _, character := range strings.TrimSpace(title) {
		if unicode.IsLetter(character) || unicode.IsDigit(character) {
			if separatorPending && builder.Len() > 0 {
				builder.WriteByte('_')
			}
			builder.WriteRune(character)
			separatorPending = false
		} else if builder.Len() > 0 {
			separatorPending = true
		}
	}
	if builder.Len() == 0 {
		return "Export"
	}
	return builder.String()
}

func textCell(value string) tabular.Cell { return tabular.Cell{Text: value} }

func imageTextCell(value string, imagePNG []byte) tabular.Cell {
	return tabular.Cell{Text: value, ImagePNG: imagePNG, ImageSlot: true}
}

func activityKindCell(kind activities.Kind, decorate bool) tabular.Cell {
	return tonedTextCell(activityKindLabel(kind), activityTone(kind), decorate)
}

func activityMoneyCell(amount int64, currency string, kind activities.Kind, decorate bool) tabular.Cell {
	return tonedMoneyCell(amount, currency, activityTone(kind), decorate)
}

func activityStatusCell(kind activities.Kind, status string, decorate bool) tabular.Cell {
	tone := activityTone(kind)
	if status == "REVERSED" {
		tone = tabular.ToneDanger
	}
	return tonedTextCell(activityStatusLabel(kind, status), tone, decorate)
}

func activityTone(kind activities.Kind) tabular.CellTone {
	switch kind {
	case activities.KindBooking:
		return tabular.ToneWarning
	case activities.KindPayment:
		return tabular.ToneSuccess
	case activities.KindReversal:
		return tabular.ToneDanger
	default:
		return tabular.ToneInfo
	}
}

func transactionTone(status string) tabular.CellTone {
	if status == "REVERSED" {
		return tabular.ToneDanger
	}
	return tabular.ToneSuccess
}

func membershipTone(status string) tabular.CellTone {
	switch status {
	case domain.MembershipStatusActive:
		return tabular.ToneSuccess
	case domain.MembershipStatusArchived:
		return tabular.ToneWarning
	default:
		return tabular.ToneDanger
	}
}

func balanceTone(amount int64) tabular.CellTone {
	if amount > 0 {
		return tabular.ToneDanger
	}
	return tabular.ToneSuccess
}

func settlementTone(status string) tabular.CellTone {
	switch status {
	case "PAID", "CREDIT":
		return tabular.ToneSuccess
	case "PARTIAL":
		return tabular.ToneWarning
	default:
		return tabular.ToneDanger
	}
}

func paidAmountTone(_ int64) tabular.CellTone {
	return tabular.ToneSuccess
}

func tonedTextCell(value string, tone tabular.CellTone, decorate bool) tabular.Cell {
	cell := textCell(value)
	if decorate {
		cell.Tone = tone
	}
	return cell
}

func tonedMoneyCell(amount int64, currency string, tone tabular.CellTone, decorate bool) tabular.Cell {
	cell := moneyCell(amount, currency)
	if decorate {
		cell.Tone = tone
	}
	return cell
}

func moneyCell(amount int64, currency string) tabular.Cell {
	return tabular.Cell{Money: &tabular.Money{MinorUnits: strconv.FormatInt(amount, 10), Currency: strings.ToUpper(currency), DecimalPlaces: platform.CurrencyExponent(currency)}}
}

func moneyColumn(id, header string, width float64) tabular.Column {
	return tabular.Column{ID: id, Header: header, Kind: tabular.MoneyColumn, Alignment: tabular.AlignRight, WidthMM: width}
}

func auditExportColumns() []tabular.Column {
	return []tabular.Column{
		{ID: "occurred_at", Header: "Zeitpunkt", Identity: true, WidthMM: 36}, {ID: "actor", Header: "Akteur", Identity: true, WidthMM: 42},
		{ID: "action", Header: "Aktion", WidthMM: 48}, {ID: "subject", Header: "Betreff", WidthMM: 57}, {ID: "details", Header: "Details", WidthMM: 90},
	}
}

func formatGermanDateTime(value string, location *time.Location) string {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return value
	}
	return parsed.In(location).Format("02.01.2006, 15:04")
}

func formatGermanDate(value string, location *time.Location) string {
	if value == "" {
		return "–"
	}
	if parsed, err := time.Parse("2006-01-02", value); err == nil {
		return parsed.Format("02.01.2006")
	}
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed.In(location).Format("02.01.2006")
	}
	return value
}

func activityKindLabel(kind activities.Kind) string {
	switch kind {
	case activities.KindBooking:
		return "Buchung"
	case activities.KindPayment:
		return "Einzahlung"
	case activities.KindReversal:
		return "Stornierung"
	default:
		return "Korrektur"
	}
}

func activityStatusLabel(kind activities.Kind, status string) string {
	if status == "REVERSED" {
		return "Storniert"
	}
	switch kind {
	case activities.KindBooking:
		return "Gebucht"
	case activities.KindPayment:
		return "Eingezahlt"
	default:
		return "Verbucht"
	}
}

func transactionStatusLabel(status string) string {
	if status == "REVERSED" {
		return "Storniert"
	}
	return "Gebucht"
}

func paymentMethodLabel(id, label string) string {
	defaults := map[string]string{"BANK_TRANSFER": "Bank transfer", "SHOPPING": "Shopping", "CASH": "Cash", "PAYPAL": "PayPal", "OTHER": "Other"}
	localized := map[string]string{"BANK_TRANSFER": "Überweisung", "SHOPPING": "Einkauf", "CASH": "Bar", "PAYPAL": "PayPal", "OTHER": "Sonstige"}
	if label == "" || defaults[id] == label {
		if value := localized[id]; value != "" {
			return value
		}
	}
	return fallbackText(label, id)
}

func membershipStatusLabel(status string) string {
	switch status {
	case domain.MembershipStatusActive:
		return "Aktiv"
	case domain.MembershipStatusArchived:
		return "Ehemalig"
	default:
		return "Gelöscht"
	}
}

func balanceState(amount int64) string {
	if amount > 0 {
		return "due"
	}
	if amount < 0 {
		return "credit"
	}
	return "settled"
}

func balanceStateLabel(amount int64) string {
	switch balanceState(amount) {
	case "due":
		return "Offen"
	case "credit":
		return "Guthaben"
	default:
		return "Ausgeglichen"
	}
}

func settlementStatusLabel(status string) string {
	switch status {
	case "PAID":
		return "Bezahlt"
	case "PARTIAL":
		return "Teilweise bezahlt"
	case "CREDIT":
		return "Guthaben"
	default:
		return "Offen"
	}
}

func fallbackText(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func matchesFold(value, search string) bool {
	return search == "" || strings.Contains(strings.ToLower(value), strings.ToLower(search))
}

func descending(direction string) (bool, error) {
	if direction == "" || strings.EqualFold(direction, "asc") {
		return false, nil
	}
	if strings.EqualFold(direction, "desc") {
		return true, nil
	}
	return false, domain.ValidationError{Field: "direction", Message: "must be asc or desc"}
}

func compareText(left, right string) int {
	leftRunes := []rune(normalizeGermanCollation(left))
	rightRunes := []rune(normalizeGermanCollation(right))
	for leftIndex, rightIndex := 0, 0; leftIndex < len(leftRunes) && rightIndex < len(rightRunes); {
		if unicode.IsDigit(leftRunes[leftIndex]) && unicode.IsDigit(rightRunes[rightIndex]) {
			leftEnd, rightEnd := leftIndex, rightIndex
			for leftEnd < len(leftRunes) && unicode.IsDigit(leftRunes[leftEnd]) {
				leftEnd++
			}
			for rightEnd < len(rightRunes) && unicode.IsDigit(rightRunes[rightEnd]) {
				rightEnd++
			}
			leftNumber := strings.TrimLeft(string(leftRunes[leftIndex:leftEnd]), "0")
			rightNumber := strings.TrimLeft(string(rightRunes[rightIndex:rightEnd]), "0")
			if leftNumber == "" {
				leftNumber = "0"
			}
			if rightNumber == "" {
				rightNumber = "0"
			}
			if len(leftNumber) != len(rightNumber) {
				if len(leftNumber) < len(rightNumber) {
					return -1
				}
				return 1
			}
			if comparison := strings.Compare(leftNumber, rightNumber); comparison != 0 {
				return comparison
			}
			leftIndex, rightIndex = leftEnd, rightEnd
			continue
		}
		if leftRunes[leftIndex] != rightRunes[rightIndex] {
			if leftRunes[leftIndex] < rightRunes[rightIndex] {
				return -1
			}
			return 1
		}
		leftIndex++
		rightIndex++
	}
	return compareInt64(int64(len(leftRunes)), int64(len(rightRunes)))
}

func normalizeGermanCollation(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	return strings.NewReplacer("ä", "a", "ö", "o", "ü", "u", "ß", "ss").Replace(value)
}

func compareInt64(left, right int64) int {
	if left < right {
		return -1
	}
	if left > right {
		return 1
	}
	return 0
}

func sortAccountSummaries(items []finance.AccountSummary, field, direction string) error {
	if field == "" {
		field = "memberName"
	}
	if !slices.Contains([]string{"memberName", "membershipStatus", "balanceState", "amount"}, field) {
		return domain.ValidationError{Field: "sort", Message: "is not supported"}
	}
	reverse, err := descending(direction)
	if err != nil {
		return err
	}
	sort.SliceStable(items, func(i, j int) bool {
		comparison := 0
		switch field {
		case "membershipStatus":
			comparison = compareText(items[i].Status, items[j].Status)
		case "balanceState":
			comparison = compareText(balanceState(items[i].BalanceMinor), balanceState(items[j].BalanceMinor))
		case "amount":
			comparison = compareInt64(items[i].BalanceMinor, items[j].BalanceMinor)
		default:
			comparison = compareText(items[i].DisplayName, items[j].DisplayName)
		}
		if comparison == 0 {
			comparison = compareText(items[i].MembershipID, items[j].MembershipID)
		}
		return (comparison < 0) != reverse
	})
	return nil
}

func sortSettlements(items []settlementExportItem, field, direction string, personal bool) error {
	if field == "" {
		field = "dueAt"
	}
	allowed := []string{"periodLabel", "dueAt", "amount", "paidAmount", "status"}
	if personal {
		allowed = append(allowed, "openAmount")
	} else {
		allowed = append(allowed, "memberName", "membershipStatus")
	}
	if !slices.Contains(allowed, field) {
		return domain.ValidationError{Field: "sort", Message: "is not supported"}
	}
	reverse, err := descending(direction)
	if err != nil {
		return err
	}
	sort.SliceStable(items, func(i, j int) bool {
		comparison := 0
		switch field {
		case "periodLabel":
			comparison = compareText(items[i].PeriodLabel, items[j].PeriodLabel)
		case "memberName":
			comparison = compareText(items[i].MemberName, items[j].MemberName)
		case "membershipStatus":
			comparison = compareText(items[i].MembershipStatus, items[j].MembershipStatus)
		case "amount":
			comparison = compareInt64(items[i].AmountMinor, items[j].AmountMinor)
		case "paidAmount":
			comparison = compareInt64(items[i].PaidMinor, items[j].PaidMinor)
		case "openAmount":
			comparison = compareInt64(items[i].OpenMinor, items[j].OpenMinor)
		case "status":
			comparison = compareText(items[i].Status, items[j].Status)
		default:
			comparison = compareText(items[i].DueAt, items[j].DueAt)
		}
		if comparison == 0 {
			comparison = compareText(items[i].ID, items[j].ID)
		}
		return (comparison < 0) != reverse
	})
	return nil
}

func membershipRoleNames(ctx context.Context, db *sql.DB, groupID string) (map[string]map[string]string, error) {
	rows, err := db.QueryContext(ctx, `SELECT assignment.membership_id,role.id,role.name
		FROM membership_role_assignments assignment
		JOIN roles role ON role.id=assignment.role_id AND role.group_id=assignment.group_id
		WHERE assignment.group_id=?`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]map[string]string)
	for rows.Next() {
		var membershipID, roleID, name string
		if err := rows.Scan(&membershipID, &roleID, &name); err != nil {
			return nil, err
		}
		if result[membershipID] == nil {
			result[membershipID] = make(map[string]string)
		}
		result[membershipID][roleID] = name
	}
	return result, rows.Err()
}

func resolvedRoleNames(membership domain.Membership, roleNames map[string]map[string]string) []string {
	resolved := make([]string, 0, len(membership.RoleIDs))
	for _, roleID := range membership.RoleIDs {
		if name := roleNames[membership.ID][roleID]; name != "" {
			resolved = append(resolved, name)
		}
	}
	sort.Slice(resolved, func(i, j int) bool { return compareText(resolved[i], resolved[j]) < 0 })
	return resolved
}

func sortMemberships(items []domain.Membership, roleNames map[string]map[string]string, field, direction string) error {
	if field == "" {
		field = "displayName"
	}
	if !slices.Contains([]string{"displayName", "email", "roles"}, field) {
		return domain.ValidationError{Field: "sort", Message: "is not supported"}
	}
	reverse, err := descending(direction)
	if err != nil {
		return err
	}
	sort.SliceStable(items, func(i, j int) bool {
		left, right := items[i].DisplayName, items[j].DisplayName
		if field == "email" {
			left, right = "", ""
			if items[i].Email != nil {
				left = *items[i].Email
			}
			if items[j].Email != nil {
				right = *items[j].Email
			}
		} else if field == "roles" {
			left, right = strings.Join(resolvedRoleNames(items[i], roleNames), ", "), strings.Join(resolvedRoleNames(items[j], roleNames), ", ")
		}
		comparison := compareText(left, right)
		if comparison == 0 {
			comparison = compareText(items[i].ID, items[j].ID)
		}
		return (comparison < 0) != reverse
	})
	return nil
}

func auditSubject(resourceType string, resourceID *string) string {
	if resourceID == nil || *resourceID == "" {
		return fallbackText(resourceType, "–")
	}
	return resourceType + " · " + *resourceID
}

func jsonDisplay(value map[string]any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(encoded)
}
