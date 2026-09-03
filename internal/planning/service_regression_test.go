package planning

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

type planningServiceFixture struct {
	DB         *sql.DB
	Service    Service
	Principal  domain.Principal
	Membership domain.Membership
}

func openPlanningServiceFixture(t *testing.T) planningServiceFixture {
	t.Helper()
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "planning-service.db"))
	if err != nil {
		t.Fatalf("open planning service fixture: %v", err)
	}
	now := platform.Timestamp(platform.Now())
	if _, err := db.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-admin','admin@example.test','Admin','hash',?,?)`, now, now); err != nil {
		db.Close()
		t.Fatalf("seed fixture administrator: %v", err)
	}
	principal := domain.Principal{UserID: "user-admin", Email: "admin@example.test", DisplayName: "Admin"}
	group, err := (groups.Service{DB: db}).Create(ctx, principal, "Planning regression", "EUR")
	if err != nil {
		db.Close()
		t.Fatalf("create fixture group: %v", err)
	}
	service := Service{DB: db}
	settings, err := service.GetSettings(ctx, group.Membership)
	if err != nil {
		db.Close()
		t.Fatalf("read planning settings: %v", err)
	}
	if _, err := service.UpdateSettings(ctx, principal, group.Membership, true, settings.Version); err != nil {
		db.Close()
		t.Fatalf("enable planning: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return planningServiceFixture{DB: db, Service: service, Principal: principal, Membership: group.Membership}
}

func (fixture planningServiceFixture) addMember(t *testing.T, suffix, displayName string) (domain.Principal, domain.Membership) {
	t.Helper()
	ctx := context.Background()
	userID := "user-" + suffix
	membershipID := "member-" + suffix
	email := suffix + "@example.test"
	now := platform.Timestamp(platform.Now())
	if _, err := fixture.DB.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)`, userID, email, displayName, "hash", now, now); err != nil {
		t.Fatalf("insert member user: %v", err)
	}
	if _, err := fixture.DB.ExecContext(ctx, `INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES(?,?,?,'ACTIVE',?)`, membershipID, fixture.Membership.GroupID, userID, now); err != nil {
		t.Fatalf("insert member: %v", err)
	}
	memberRoleID := authorization.TemplateRoleID(fixture.Membership.GroupID, domain.RoleTemplateMember)
	if _, err := fixture.DB.ExecContext(ctx, `INSERT OR IGNORE INTO membership_role_assignments(group_id,membership_id,role_id,version,assigned_at,assigned_by) VALUES(?,?,?,1,?,?)`, fixture.Membership.GroupID, membershipID, memberRoleID, now, fixture.Principal.UserID); err != nil {
		t.Fatalf("assign member role: %v", err)
	}
	return domain.Principal{UserID: userID, Email: email, DisplayName: displayName}, domain.Membership{ID: membershipID, GroupID: fixture.Membership.GroupID, UserID: userID, Status: "ACTIVE"}
}

func (fixture planningServiceFixture) addRole(t *testing.T, roleID, name string, permission *domain.PermissionKey) {
	t.Helper()
	ctx := context.Background()
	now := platform.Timestamp(platform.Now())
	if _, err := fixture.DB.ExecContext(ctx, `INSERT INTO roles(id,group_id,name,description,name_locked,deletable,version,created_at,updated_at,created_by,updated_by) VALUES(?,?,?,'',0,1,1,?,?,?,?)`, roleID, fixture.Membership.GroupID, name, now, now, fixture.Principal.UserID, fixture.Principal.UserID); err != nil {
		t.Fatalf("insert role: %v", err)
	}
	if permission != nil {
		if _, err := fixture.DB.ExecContext(ctx, `INSERT INTO role_permission_grants(group_id,role_id,permission_key,scope_type,version,created_at,updated_at,created_by,updated_by) VALUES(?,?,?,'GROUP',1,?,?,?,?)`, fixture.Membership.GroupID, roleID, *permission, now, now, fixture.Principal.UserID, fixture.Principal.UserID); err != nil {
			t.Fatalf("grant role permission: %v", err)
		}
	}
}

func (fixture planningServiceFixture) assignRole(t *testing.T, membershipID, roleID string) {
	t.Helper()
	now := platform.Timestamp(platform.Now())
	if _, err := fixture.DB.ExecContext(context.Background(), `INSERT OR IGNORE INTO membership_role_assignments(group_id,membership_id,role_id,version,assigned_at,assigned_by) VALUES(?,?,?,1,?,?)`, fixture.Membership.GroupID, membershipID, roleID, now, fixture.Principal.UserID); err != nil {
		t.Fatalf("assign role: %v", err)
	}
}

func TestPublishedAudienceOnlyExpandsForNewExplicitTargets(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	_, firstMember := fixture.addMember(t, "first", "First member")
	_, secondMember := fixture.addMember(t, "second", "Second member")
	fixture.addRole(t, "role-audience-first", "Audience first", nil)
	fixture.addRole(t, "role-audience-second", "Audience second", nil)
	fixture.assignRole(t, firstMember.ID, "role-audience-first")
	fixture.assignRole(t, secondMember.ID, "role-audience-second")

	start := platform.Timestamp(platform.Now().Add(4 * time.Hour))
	input := EventInput{Title: "Scoped event", EventType: EventAppointment, AudienceType: "SELECTED_ROLES", StartsAt: start, TargetRoleIDs: []string{"role-audience-first"}}
	event, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-audience-expansion-0001", input)
	if err != nil {
		t.Fatalf("create scoped event: %v", err)
	}
	fixture.assignRole(t, secondMember.ID, "role-audience-first")
	input.Title = "Content-only update"
	event, err = fixture.Service.UpdateEvent(ctx, fixture.Principal, fixture.Membership, event.ID, input, event.Version)
	if err != nil {
		t.Fatalf("update published event: %v", err)
	}
	var implicitlyAdded bool
	if err := fixture.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM planning_event_audience WHERE event_id=? AND membership_id=?)`, event.ID, secondMember.ID).Scan(&implicitlyAdded); err != nil {
		t.Fatalf("read audience after content update: %v", err)
	}
	if implicitlyAdded {
		t.Fatal("existing role was re-resolved during a content-only update")
	}

	input.TargetRoleIDs = []string{"role-audience-first", "role-audience-second"}
	event, err = fixture.Service.UpdateEvent(ctx, fixture.Principal, fixture.Membership, event.ID, input, event.Version)
	if err != nil {
		t.Fatalf("explicitly extend published audience: %v", err)
	}
	var explicitlyAdded bool
	if err := fixture.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM planning_event_audience WHERE event_id=? AND membership_id=?)`, event.ID, secondMember.ID).Scan(&explicitlyAdded); err != nil {
		t.Fatalf("read explicitly extended audience: %v", err)
	}
	if !explicitlyAdded {
		t.Fatal("new explicit role target did not extend the audience")
	}
}

func TestEventOwnerCannotMutateAfterCreatePermissionRevocation(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	ownerPrincipal, ownerMembership := fixture.addMember(t, "owner", "Event owner")
	permission := domain.PermissionCreatePlanningEvents
	fixture.addRole(t, "role-event-owner", "Event owner", &permission)
	fixture.assignRole(t, ownerMembership.ID, "role-event-owner")
	input := EventInput{Title: "Owned event", EventType: EventAppointment, AudienceType: "ALL_ACTIVE_MEMBERS", StartsAt: platform.Timestamp(platform.Now().Add(4 * time.Hour))}
	event, err := fixture.Service.CreateEvent(ctx, ownerPrincipal, ownerMembership, "planning-owner-revocation-0001", input)
	if err != nil {
		t.Fatalf("create owned event: %v", err)
	}
	if _, err := fixture.DB.ExecContext(ctx, `DELETE FROM role_permission_grants WHERE group_id=? AND role_id='role-event-owner' AND permission_key='CREATE_PLANNING_EVENTS'`, fixture.Membership.GroupID); err != nil {
		t.Fatalf("revoke create permission: %v", err)
	}
	visible, err := fixture.Service.GetEvent(ctx, ownerMembership, event.ID)
	if err != nil {
		t.Fatalf("read owned event after revocation: %v", err)
	}
	if visible.CanEdit || visible.CanCancel {
		t.Fatalf("revoked owner capabilities edit=%t cancel=%t", visible.CanEdit, visible.CanCancel)
	}
	input.Title = "Forbidden update"
	if _, err := fixture.Service.UpdateEvent(ctx, ownerPrincipal, ownerMembership, event.ID, input, event.Version); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("update after revocation error=%v, want forbidden", err)
	}
	if _, err := fixture.Service.Transition(ctx, ownerPrincipal, ownerMembership, event.ID, "CANCELLED", event.Version); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("cancel after revocation error=%v, want forbidden", err)
	}
}

func TestManualClosePreservesRegistrationAndEarlyCompletionIsRejected(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	firstPrincipal, firstMember := fixture.addMember(t, "registered", "Registered member")
	secondPrincipal, secondMember := fixture.addMember(t, "waiting", "Waiting member")
	start := platform.Now().Add(6 * time.Hour)
	input := EventInput{Title: "Registration", EventType: EventAppointmentRegistration, AudienceType: "ALL_ACTIVE_MEMBERS", StartsAt: platform.Timestamp(start), ResponseDeadlineMinutesBefore: intPointer(180), Capacity: intPointer(1), WaitlistEnabled: true}
	event, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-manual-close-0001", input)
	if err != nil {
		t.Fatalf("create registration: %v", err)
	}
	if _, err := fixture.Service.SetParticipation(ctx, firstPrincipal, firstMember, event.ID, "REGISTERED"); err != nil {
		t.Fatalf("register first member: %v", err)
	}
	if _, err := fixture.Service.SetParticipation(ctx, secondPrincipal, secondMember, event.ID, "REGISTERED"); err != nil {
		t.Fatalf("waitlist second member: %v", err)
	}
	input.StartsAt = platform.Timestamp(start.Add(time.Hour))
	input.ResponseDeadlineMinutesBefore = intPointer(180)
	event, err = fixture.Service.UpdateEvent(ctx, fixture.Principal, fixture.Membership, event.ID, input, event.Version)
	if err != nil {
		t.Fatalf("move registration start: %v", err)
	}
	event, err = fixture.Service.Transition(ctx, fixture.Principal, fixture.Membership, event.ID, "CLOSED", event.Version)
	if err != nil {
		t.Fatalf("manually close registration: %v", err)
	}
	var firstStatus, secondStatus string
	if err := fixture.DB.QueryRowContext(ctx, `SELECT status FROM planning_participations WHERE event_id=? AND membership_id=?`, event.ID, firstMember.ID).Scan(&firstStatus); err != nil {
		t.Fatalf("read preserved registration: %v", err)
	}
	if err := fixture.DB.QueryRowContext(ctx, `SELECT status FROM planning_participations WHERE event_id=? AND membership_id=?`, event.ID, secondMember.ID).Scan(&secondStatus); err != nil {
		t.Fatalf("read waiting registration: %v", err)
	}
	var promotionTaskCount int
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_notification_tasks WHERE event_id=? AND target_membership_id=? AND event_type='PLANNING_WAITLIST_PROMOTED' AND event_revision=?`, event.ID, secondMember.ID, event.Version).Scan(&promotionTaskCount); err != nil {
		t.Fatalf("read promotion task: %v", err)
	}
	if event.Status != "CLOSED" || firstStatus != "REGISTERED" || secondStatus != "WAITLISTED" || promotionTaskCount != 0 {
		t.Fatalf("manual close status=%s first=%s second=%s promotions=%d", event.Status, firstStatus, secondStatus, promotionTaskCount)
	}

	end := platform.Timestamp(platform.Now().Add(5 * time.Hour))
	information := EventInput{Title: "Future information", EventType: EventAppointment, AudienceType: "ALL_ACTIVE_MEMBERS", StartsAt: platform.Timestamp(platform.Now().Add(4 * time.Hour)), EndsAt: &end}
	futureEvent, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-early-complete-0001", information)
	if err != nil {
		t.Fatalf("create future information: %v", err)
	}
	if _, err := fixture.Service.Transition(ctx, fixture.Principal, fixture.Membership, futureEvent.ID, "COMPLETED", futureEvent.Version); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("early completion error=%v, want conflict", err)
	}
}

func TestCreateEventPublishesAtomically(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	start := platform.Timestamp(platform.Now().Add(4 * time.Hour))
	input := EventInput{Title: "Atomic event", EventType: EventAppointment, AudienceType: "ALL_ACTIVE_MEMBERS", StartsAt: start}
	event, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-atomic-create-0001", input)
	if err != nil {
		t.Fatalf("create atomic event command: %v", err)
	}
	if event.Status != "PUBLISHED" || event.Version != 1 {
		t.Fatalf("atomic event status=%s version=%d", event.Status, event.Version)
	}
}

func TestCreateEventIdempotencyReplaysDurableResult(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	key := "planning-durable-replay-0001"
	input := EventInput{
		Title:        "Durable replay",
		EventType:    EventAppointment,
		AudienceType: AudienceAllActive,
		StartsAt:     platform.Timestamp(platform.Now().Add(4 * time.Hour)),
	}
	created, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, key, input)
	if err != nil {
		t.Fatalf("create durable event: %v", err)
	}
	replayed, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, key, input)
	if err != nil {
		t.Fatalf("replay durable event: %v", err)
	}
	if replayed.ID != created.ID || replayed.Status != "PUBLISHED" || replayed.Version != created.Version {
		t.Fatalf("replayed event=%#v, created=%#v", replayed, created)
	}

	var eventCount, resultCount int
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM planning_events WHERE group_id=? AND id=?`, fixture.Membership.GroupID, created.ID).Scan(&eventCount); err != nil {
		t.Fatalf("count replayed events: %v", err)
	}
	if err := fixture.DB.QueryRowContext(ctx, `SELECT count(*) FROM idempotency_results WHERE group_id=? AND actor_user_id=? AND idempotency_key=?`, fixture.Membership.GroupID, fixture.Principal.UserID, key).Scan(&resultCount); err != nil {
		t.Fatalf("count durable idempotency results: %v", err)
	}
	if eventCount != 1 || resultCount != 1 {
		t.Fatalf("durable replay counts events=%d results=%d", eventCount, resultCount)
	}

	conflictingInput := input
	conflictingInput.Title = "Conflicting replay"
	if _, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, key, conflictingInput); !errors.Is(err, domain.ErrIdempotencyReuse) {
		t.Fatalf("conflicting replay error=%v, want idempotency reuse", err)
	}
}

func TestPlanningListsReleaseRowsBeforeBatchHydration(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	start := platform.Timestamp(platform.Now().Add(4 * time.Hour))
	if _, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-bounded-list-0001", EventInput{Title: "Listed event", EventType: EventAppointment, AudienceType: "ALL_ACTIVE_MEMBERS", StartsAt: start}); err != nil {
		t.Fatalf("create listed event: %v", err)
	}
	fixture.DB.SetMaxOpenConns(1)
	bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	events, _, err := fixture.Service.ListEvents(bounded, fixture.Membership, "", "", "", "", 20)
	if err != nil {
		t.Fatalf("list events with one database connection: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("bounded list length events=%d", len(events))
	}
}

func TestGetSettingsAllowsGroupAdministrationWithoutUsePlanning(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	_, administrator := fixture.addMember(t, "settings-admin", "Settings administrator")
	permission := domain.PermissionGroupAdministration
	fixture.addRole(t, "role-settings-admin", "Settings administrator", &permission)
	fixture.assignRole(t, administrator.ID, "role-settings-admin")
	memberRoleID := authorization.TemplateRoleID(fixture.Membership.GroupID, domain.RoleTemplateMember)
	if _, err := fixture.DB.ExecContext(ctx, `DELETE FROM membership_role_assignments WHERE membership_id=? AND role_id=?`, administrator.ID, memberRoleID); err != nil {
		t.Fatalf("remove default member role: %v", err)
	}
	if _, err := fixture.Service.GetSettings(ctx, administrator); err != nil {
		t.Fatalf("group administrator reads planning settings: %v", err)
	}
}

func TestListEventsAppliesStatusFilter(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	start := platform.Timestamp(platform.Now().Add(4 * time.Hour))
	published, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-status-published-0001", EventInput{Title: "Published", EventType: EventAppointment, AudienceType: AudienceAllActive, StartsAt: start})
	if err != nil {
		t.Fatalf("create published event: %v", err)
	}

	if _, _, err := fixture.Service.ListEvents(ctx, fixture.Membership, "", "", "DRAFT", "", 20); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("removed draft status error=%v, want validation", err)
	}
	publishedEvents, _, err := fixture.Service.ListEvents(ctx, fixture.Membership, "", "", "PUBLISHED", "", 20)
	if err != nil {
		t.Fatalf("list published events: %v", err)
	}
	if len(publishedEvents) != 1 || publishedEvents[0].ID != published.ID {
		t.Fatalf("published filter returned %#v", publishedEvents)
	}
	if _, _, err := fixture.Service.ListEvents(ctx, fixture.Membership, "", "", "UNKNOWN", "", 20); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("invalid status error=%v, want validation", err)
	}
}

func TestCombinedAudienceSnapshotsRolesAndMembers(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	_, roleMember := fixture.addMember(t, "combined-role", "Role target")
	_, explicitMember := fixture.addMember(t, "combined-member", "Member target")
	fixture.addRole(t, "role-combined-target", "Combined target", nil)
	fixture.assignRole(t, roleMember.ID, "role-combined-target")
	input := EventInput{
		Title: "Combined audience", EventType: EventAppointment, AudienceType: AudienceSelectedTargets,
		StartsAt: platform.Timestamp(platform.Now().Add(4 * time.Hour)), TargetRoleIDs: []string{"role-combined-target"}, TargetMembershipIDs: []string{explicitMember.ID},
	}
	event, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-combined-audience-0001", input)
	if err != nil {
		t.Fatalf("create combined event: %v", err)
	}
	for _, membershipID := range []string{roleMember.ID, explicitMember.ID} {
		var present bool
		if err := fixture.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM planning_event_audience WHERE event_id=? AND membership_id=?)`, event.ID, membershipID).Scan(&present); err != nil {
			t.Fatalf("read combined audience target: %v", err)
		}
		if !present {
			t.Fatalf("combined audience omitted %s", membershipID)
		}
	}
}

func TestPublishedAudienceCanUpgradeToCombinedTargets(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	_, roleMember := fixture.addMember(t, "upgrade-role", "Role target")
	_, explicitMember := fixture.addMember(t, "upgrade-member", "Member target")
	fixture.addRole(t, "role-upgrade-target", "Upgrade target", nil)
	fixture.assignRole(t, roleMember.ID, "role-upgrade-target")
	input := EventInput{Title: "Role audience", EventType: EventAppointment, AudienceType: AudienceSelectedRoles, StartsAt: platform.Timestamp(platform.Now().Add(4 * time.Hour)), TargetRoleIDs: []string{"role-upgrade-target"}}
	event, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-upgrade-audience-0001", input)
	if err != nil {
		t.Fatalf("create role event: %v", err)
	}
	input.AudienceType = AudienceSelectedTargets
	input.TargetMembershipIDs = []string{explicitMember.ID}
	event, err = fixture.Service.UpdateEvent(ctx, fixture.Principal, fixture.Membership, event.ID, input, event.Version)
	if err != nil {
		t.Fatalf("upgrade audience: %v", err)
	}
	if event.AudienceType != AudienceSelectedTargets || len(event.TargetRoleIDs) != 1 || len(event.TargetMembershipIDs) != 1 {
		t.Fatalf("upgraded audience=%#v", event)
	}
}

func TestParticipantsUsesStableKeysetPagination(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	fixture.addMember(t, "participant-z", "Zulu")
	fixture.addMember(t, "participant-a", "Alpha")
	fixture.addMember(t, "participant-m", "Mike")
	event, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-participants-page-0001", EventInput{Title: "Paged audience", EventType: EventAppointment, AudienceType: AudienceAllActive, StartsAt: platform.Timestamp(platform.Now().Add(4 * time.Hour))})
	if err != nil {
		t.Fatalf("create paged event: %v", err)
	}
	first, next, err := fixture.Service.Participants(ctx, fixture.Membership, event.ID, "", 2)
	if err != nil {
		t.Fatalf("first participant page: %v", err)
	}
	if len(first) != 2 || next == "" {
		t.Fatalf("first page length=%d cursor=%q", len(first), next)
	}
	second, finalCursor, err := fixture.Service.Participants(ctx, fixture.Membership, event.ID, next, 2)
	if err != nil {
		t.Fatalf("second participant page: %v", err)
	}
	if len(second) != 2 || finalCursor != "" {
		t.Fatalf("second page length=%d cursor=%q", len(second), finalCursor)
	}
	seen := map[string]bool{}
	for _, participant := range append(first, second...) {
		if seen[participant.MembershipID] {
			t.Fatalf("participant %s appeared twice", participant.MembershipID)
		}
		seen[participant.MembershipID] = true
	}
	if _, _, err := fixture.Service.Participants(ctx, fixture.Membership, event.ID, "missing", 2); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("invalid participant cursor error=%v, want validation", err)
	}
}

func TestEventEditPreservesPendingWaitlistPromotion(t *testing.T) {
	fixture := openPlanningServiceFixture(t)
	ctx := context.Background()
	firstPrincipal, firstMember := fixture.addMember(t, "promotion-first", "First registration")
	secondPrincipal, secondMember := fixture.addMember(t, "promotion-second", "Second registration")
	input := EventInput{Title: "Promotion", EventType: EventAppointmentRegistration, AudienceType: AudienceAllActive, StartsAt: platform.Timestamp(platform.Now().Add(4 * time.Hour)), ResponseDeadlineMinutesBefore: intPointer(120), Capacity: intPointer(1), WaitlistEnabled: true}
	event, err := fixture.Service.CreateEvent(ctx, fixture.Principal, fixture.Membership, "planning-promotion-edit-0001", input)
	if err != nil {
		t.Fatalf("create registration: %v", err)
	}
	if _, err := fixture.Service.SetParticipation(ctx, firstPrincipal, firstMember, event.ID, "REGISTERED"); err != nil {
		t.Fatalf("register first member: %v", err)
	}
	if _, err := fixture.Service.SetParticipation(ctx, secondPrincipal, secondMember, event.ID, "REGISTERED"); err != nil {
		t.Fatalf("waitlist second member: %v", err)
	}
	if _, err := fixture.Service.SetParticipation(ctx, firstPrincipal, firstMember, event.ID, "WITHDRAWN"); err != nil {
		t.Fatalf("withdraw first member: %v", err)
	}
	input.Title = "Promotion updated"
	event, err = fixture.Service.UpdateEvent(ctx, fixture.Principal, fixture.Membership, event.ID, input, event.Version)
	if err != nil {
		t.Fatalf("edit registration: %v", err)
	}
	var taskStatus string
	var taskRevision int64
	if err := fixture.DB.QueryRowContext(ctx, `SELECT status,event_revision FROM planning_notification_tasks WHERE event_id=? AND target_membership_id=? AND event_type='PLANNING_WAITLIST_PROMOTED'`, event.ID, secondMember.ID).Scan(&taskStatus, &taskRevision); err != nil {
		t.Fatalf("read promotion task: %v", err)
	}
	if taskStatus != "PENDING" || taskRevision != event.Version {
		t.Fatalf("promotion task status=%s revision=%d, event version=%d", taskStatus, taskRevision, event.Version)
	}
}

func intPointer(value int) *int { return &value }
