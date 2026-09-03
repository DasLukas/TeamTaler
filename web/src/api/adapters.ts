import type {
  AccountSummary,
  AppearancePreference,
  ActivityEntry,
  AuditEntry,
  Booking,
  BookingContext,
  BookingTarget,
  Category,
  ConfigurableItem,
  ConfigurableNotificationEventType,
  Dashboard,
  EmailDeliveryStatus,
  Group,
  GroupNotificationSettings,
  GroupSettings,
  GroupRole,
  InstanceCapabilities,
  LedgerEntry,
  Membership,
  MemberStatistics,
  Notification,
  NotificationChannel,
  NotificationDestination,
  NotificationEventDefinition,
  NotificationPreferences,
  PermissionDefinition,
  PermissionGrant,
  Payment,
  PaymentAttachmentSummary,
  PaymentMethod,
  PaymentTarget,
  PlanningAudience,
  PlanningEvent,
  PlanningEventBase,
  PlanningEventPage,
  PlanningParticipant,
  PlanningParticipantPage,
  PlanningParticipationStatus,
  PlanningRecurrenceInput,
  PlanningSeries,
  PlanningSeriesBase,
  PlanningSeriesResult,
  PlanningSettings,
  PlanningWeekday,
  Period,
  Product,
  PushSubscriptionDevice,
  Role,
  RoleAssignment,
  ReasonMode,
  Session,
  Settlement,
  StatisticsBucket,
  StatisticsDashboard,
  StatisticsMeta,
  SmtpTlsMode,
  SystemAccount,
  SystemAuditEntry,
  SystemGroup,
  SystemGroupInvitationResult,
  SystemGroupDeletionImpact,
  SystemGroupImpact,
  SystemSetting,
  SystemSettingSource,
  SystemSettings,
  SystemSmtpSettings,
  SystemWebPushSettings,
  TransactionSettings,
  ThemePreference,
  User,
} from './types';
import { DEFAULT_ATTACHMENT_UPLOAD_MAX_BYTES, DEFAULT_MEDIA_UPLOAD_MAX_BYTES, isCategoryIcon, isColorMode, isPermissionKey, isStatisticsRange, isThemeId, type FinanceStatistics } from './types';
import { formatMoney } from './money';
import i18n from '@/i18n';
import { defaultPaymentMethods, historicalPaymentMethodLabel, localizedPaymentMethodLabel } from '@/features/finance/paymentMethods';
import { isPaymentTargetValid, isPaypalMeHandle, normalizeBic, normalizeIban } from '@/features/finance/paymentTargets';
import { formatGermanDate } from '@/features/shared/dateFormat';

type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord => value as JsonRecord;
const money = (minorUnits: unknown, currency: unknown) => ({ minorUnits: String(minorUnits ?? 0), currency: String(currency || 'EUR') });
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
const categoryIcon = (value: unknown): Category['icon'] => isCategoryIcon(value) ? value : 'other';
const memberName = (membershipId: string, members?: Membership[], fallback = i18n.t('common.member')) => members?.find((member) => member.id === membershipId)?.displayName ?? fallback;
const memberAvatarUrl = (membershipId: string, members?: Membership[]) => members?.find((member) => member.id === membershipId)?.avatarUrl;
const PAYMENT_DESCRIPTION_PREFIX = 'Payment received';
const REVERSAL_DESCRIPTION_PREFIX = 'Reversal: ';
const NOTIFICATION_EVENT_TYPES: Notification['eventType'][] = [
  'BOOKING_ASSIGNED',
  'BOOKING_REVERSED',
  'PAYMENT_RECORDED',
  'PAYMENT_REVERSED',
  'SETTLEMENT_CREATED',
  'SETTLEMENT_DUE_SOON',
  'SETTLEMENT_OVERDUE',
  'PLANNING_EVENT_PUBLISHED',
  'PLANNING_EVENT_UPDATED',
  'PLANNING_EVENT_CANCELLED',
  'PLANNING_WAITLIST_PROMOTED',
  'DATA_EXPORT_READY',
  'DATA_EXPORT_FAILED',
];
const CONFIGURABLE_NOTIFICATION_EVENT_TYPES: ConfigurableNotificationEventType[] = [
  'BOOKING_ASSIGNED',
  'BOOKING_REVERSED',
  'PAYMENT_RECORDED',
  'PAYMENT_REVERSED',
  'SETTLEMENT_CREATED',
  'SETTLEMENT_DUE_SOON',
  'SETTLEMENT_OVERDUE',
  'PLANNING_EVENT_PUBLISHED',
  'PLANNING_EVENT_UPDATED',
  'PLANNING_EVENT_CANCELLED',
  'PLANNING_WAITLIST_PROMOTED',
];

const participationStatus = (value: unknown): PlanningParticipationStatus | undefined => {
  if (value === 'YES' || value === 'ATTENDING' || value === 'REGISTERED') return 'ATTENDING';
  if (value === 'MAYBE') return 'MAYBE';
  if (value === 'NO' || value === 'DECLINED') return 'DECLINED';
  if (value === 'WAITLISTED') return 'WAITLISTED';
  return undefined;
};
const participationWireStatus = (value: unknown) => value === 'YES' || value === 'MAYBE' || value === 'NO' || value === 'REGISTERED' || value === 'WAITLISTED' || value === 'WITHDRAWN' ? value : undefined;

function planningDateKey(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10) === value ? value : undefined;
}

function nextPlanningDate(key: string): string {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
function settingSource(value: unknown): SystemSettingSource {
  const normalized = String(value ?? '').toUpperCase();
  if (normalized === 'ENV' || normalized === 'ENVIRONMENT') return 'ENVIRONMENT';
  if (normalized === 'DB' || normalized === 'DATABASE' || normalized === 'OVERRIDE') return 'DATABASE';
  return 'CODE';
}

function setting<T>(input: unknown, fallback: T, coerce: (value: unknown) => T): SystemSetting<T> {
  const source = input && typeof input === 'object' ? asRecord(input) : undefined;
  const value = source && 'value' in source ? source.value : input;
  return {
    value: value === undefined || value === null ? fallback : coerce(value),
    source: settingSource(source?.source),
    overrideVersion: Number.isFinite(Number(source?.overrideVersion)) ? Number(source?.overrideVersion) : null,
    updatedAt: typeof source?.updatedAt === 'string' ? source.updatedAt : null,
  };
}

const stringSetting = (input: unknown, fallback = '') => setting(input, fallback, (value) => String(value));
const booleanSetting = (input: unknown, fallback = false) => setting(input, fallback, (value) => value === true || String(value).toLowerCase() === 'true');
const numberSetting = (input: unknown, fallback = 0) => setting(input, fallback, (value) => Number(value));
const DEFAULT_SMTP_PORT = 587;

function paymentAttachmentSummary(input: unknown): PaymentAttachmentSummary | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const source = asRecord(input);
  const fileName = typeof source.fileName === 'string' ? source.fileName : '';
  const mediaType = typeof source.mediaType === 'string' ? source.mediaType : '';
  const sizeBytes = Number(source.sizeBytes);
  const url = typeof source.url === 'string' ? source.url : '';
  if (!fileName || !mediaType || !Number.isFinite(sizeBytes) || sizeBytes < 0 || !url) return undefined;
  return { fileName, mediaType, sizeBytes, url };
}

/**
 * Adapts the public instance-capabilities document with safe deployment defaults.
 *
 * @param input - Response from `GET /api/v1/instance/capabilities`.
 * @returns Non-sensitive instance behavior used by public and authenticated UI.
 */
export function adaptInstanceCapabilities(input: unknown): InstanceCapabilities {
  const source = asRecord(input);
  const webPush = source.webPush && typeof source.webPush === 'object' ? asRecord(source.webPush) : {};
  return {
    instanceName: typeof source.instanceName === 'string' && source.instanceName.trim() ? source.instanceName : 'TeamTaler',
    maintenanceMode: source.maintenanceMode === true,
    maintenanceMessage: typeof source.maintenanceMessage === 'string' ? source.maintenanceMessage : '',
    publicJoinEnabled: source.publicJoinEnabled !== false,
    mediaUploadMaxBytes: Number.isFinite(Number(source.mediaUploadMaxBytes)) && Number(source.mediaUploadMaxBytes) > 0
      ? Number(source.mediaUploadMaxBytes)
      : DEFAULT_MEDIA_UPLOAD_MAX_BYTES,
    attachmentUploadMaxBytes: Number.isFinite(Number(source.attachmentUploadMaxBytes)) && Number(source.attachmentUploadMaxBytes) > 0
      ? Number(source.attachmentUploadMaxBytes)
      : DEFAULT_ATTACHMENT_UPLOAD_MAX_BYTES,
    emailNotificationsAvailable: source.emailNotificationsAvailable === true || source.emailAvailable === true,
    webPushAvailable: source.webPushAvailable === true || webPush.available === true,
    webPushPublicKey: typeof source.webPushPublicKey === 'string' && source.webPushPublicKey
      ? source.webPushPublicKey
      : typeof webPush.publicKey === 'string' && webPush.publicKey ? webPush.publicKey : null,
    webPushKeyId: typeof source.webPushKeyId === 'string' && source.webPushKeyId
      ? source.webPushKeyId
      : typeof webPush.keyId === 'string' && webPush.keyId ? webPush.keyId : null,
  };
}

/**
 * Adapts the versioned system-settings response while preserving value provenance.
 *
 * @param input - Response from `GET /api/v1/system/settings`, either direct or under `settings`.
 * @returns Canonical settings with a redacted SMTP secret state.
 */
export function adaptSystemSettings(input: unknown): SystemSettings {
  const envelope = asRecord(input);
  const source = envelope.settings && typeof envelope.settings === 'object' ? asRecord(envelope.settings) : envelope;
  const smtpSource = source.smtp && typeof source.smtp === 'object' ? asRecord(source.smtp) : {};
  const webPushSource = source.webPush && typeof source.webPush === 'object' ? asRecord(source.webPush) : {};
  const tlsModeSetting = setting<SmtpTlsMode>(smtpSource.tlsMode, 'starttls', (value) => {
    const normalized = String(value).toLowerCase();
    return normalized === 'tls' ? 'tls' : 'starttls';
  });
  const passwordSource = smtpSource.password && typeof smtpSource.password === 'object' ? asRecord(smtpSource.password) : {};
  const smtpRevision = Number(smtpSource.revision ?? 0);
  const testedRevision = Number.isFinite(Number(smtpSource.testedRevision)) ? Number(smtpSource.testedRevision) : null;
  const exactRevisionTested = smtpRevision > 0 && testedRevision === smtpRevision;
  const smtpPort = numberSetting(smtpSource.port, DEFAULT_SMTP_PORT);
  if (!Number.isInteger(smtpPort.value) || smtpPort.value < 1 || smtpPort.value > 65535) smtpPort.value = DEFAULT_SMTP_PORT;
  const smtp: SystemSmtpSettings = {
    enabled: booleanSetting(smtpSource.enabled),
    host: stringSetting(smtpSource.host),
    port: smtpPort,
    tlsMode: tlsModeSetting,
    username: stringSetting(smtpSource.username),
    fromAddress: stringSetting(smtpSource.fromAddress),
    fromName: stringSetting(smtpSource.fromName, 'TeamTaler'),
    passwordConfigured: smtpSource.passwordConfigured === true || passwordSource.configured === true,
    passwordSource: settingSource(passwordSource.source),
    passwordUpdatedAt: typeof passwordSource.updatedAt === 'string' ? passwordSource.updatedAt : null,
    testStatus: smtpSource.testStatus === 'FAILED' ? 'FAILED' : smtpSource.active === true || exactRevisionTested ? 'VERIFIED' : 'UNTESTED',
    testedRevision,
    testedAt: typeof smtpSource.testedAt === 'string' ? smtpSource.testedAt : null,
    revision: smtpRevision,
    requiresTest: smtpSource.requiresTest === true,
    configurationValid: smtpSource.configurationValid === true,
    active: smtpSource.active === true,
  };
  const vapidPrivateKey = webPushSource.vapidPrivateKey ?? webPushSource.privateKey;
  const privateKeySource = vapidPrivateKey && typeof vapidPrivateKey === 'object'
    ? asRecord(vapidPrivateKey)
    : {};
  const webPush: SystemWebPushSettings = {
    enabled: booleanSetting(webPushSource.enabled),
    subject: stringSetting(webPushSource.subject),
    privateKeyConfigured: webPushSource.privateKeyConfigured === true || privateKeySource.configured === true,
    privateKeySource: settingSource(privateKeySource.source ?? webPushSource.privateKeySource),
    privateKeyUpdatedAt: typeof privateKeySource.updatedAt === 'string'
      ? privateKeySource.updatedAt
      : typeof webPushSource.privateKeyUpdatedAt === 'string' ? webPushSource.privateKeyUpdatedAt : null,
    storageKeyConfigured: webPushSource.storageKeyConfigured === true || webPushSource.configurationValid === true,
    publicKey: typeof webPushSource.publicKey === 'string' && webPushSource.publicKey ? webPushSource.publicKey : null,
    keyId: typeof webPushSource.keyId === 'string' && webPushSource.keyId ? webPushSource.keyId : null,
    configurationValid: webPushSource.configurationValid === true,
    active: webPushSource.active === true,
    revision: Number(webPushSource.revision ?? 0),
  };
  return {
    revision: Number(source.revision ?? envelope.revision ?? 1),
    instanceName: stringSetting(source.instanceName, 'TeamTaler'),
    defaultCurrency: stringSetting(source.defaultCurrency, 'EUR'),
    mediaUploadMaxBytes: numberSetting(source.mediaUploadMaxBytes, DEFAULT_MEDIA_UPLOAD_MAX_BYTES),
    attachmentUploadMaxBytes: numberSetting(source.attachmentUploadMaxBytes, DEFAULT_ATTACHMENT_UPLOAD_MAX_BYTES),
    publicJoinEnabled: booleanSetting(source.publicJoinEnabled, true),
    maintenanceMode: booleanSetting(source.maintenanceMode),
    maintenanceMessage: stringSetting(source.maintenanceMessage),
    smtp,
    webPush,
    mediaUploadHardLimitBytes: Number(source.mediaUploadHardLimitBytes ?? envelope.mediaUploadHardLimitBytes ?? 0),
    attachmentUploadHardLimitBytes: Number(source.attachmentUploadHardLimitBytes ?? envelope.attachmentUploadHardLimitBytes ?? 50 * 1024 * 1024),
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
    updatedByUserId: typeof source.updatedByUserId === 'string' ? source.updatedByUserId : null,
  };
}

function configurableNotificationEventType(value: unknown): ConfigurableNotificationEventType | undefined {
  return CONFIGURABLE_NOTIFICATION_EVENT_TYPES.find((eventType) => eventType === value);
}

function notificationChannels(input: unknown): NotificationChannel[] {
  if (!Array.isArray(input)) return ['EMAIL', 'PUSH'];
  return input.flatMap((value) => value === 'EMAIL' || value === 'PUSH' ? [value] : []);
}

function notificationChannelAvailability(source: JsonRecord) {
  const channels = source.channels && typeof source.channels === 'object' ? asRecord(source.channels) : {};
  const availableChannels = Array.isArray(source.availableChannels) ? notificationChannels(source.availableChannels) : undefined;
  return {
    email: availableChannels ? availableChannels.includes('EMAIL') : channels.email === true || source.emailAvailable === true,
    push: availableChannels ? availableChannels.includes('PUSH') : channels.push === true || source.pushAvailable === true,
  };
}

function notificationEventDefinition(input: unknown, fallbackType?: unknown): NotificationEventDefinition | undefined {
  const source = input && typeof input === 'object' ? asRecord(input) : {};
  const eventType = configurableNotificationEventType(source.eventType ?? source.type ?? fallbackType ?? input);
  if (!eventType) return undefined;
  return {
    eventType,
    category: typeof source.category === 'string' ? source.category : eventType.split('_')[0].toLowerCase(),
    name: typeof source.name === 'string' ? source.name : typeof source.label === 'string' ? source.label : eventType,
    description: typeof source.description === 'string' ? source.description : '',
    supportedChannels: notificationChannels(source.supportedChannels ?? source.channels),
  };
}

function notificationEventEntries(source: JsonRecord): unknown[] {
  if (Array.isArray(source.events)) return source.events;
  if (Array.isArray(source.catalog)) return source.catalog;
  return CONFIGURABLE_NOTIFICATION_EVENT_TYPES;
}

/**
 * Normalizes the versioned group notification policy and its event catalog.
 *
 * @param input - Direct or enveloped response from the group notification-settings endpoint.
 * @returns A stable policy model with explicit channel availability.
 */
export function adaptGroupNotificationSettings(input: unknown): GroupNotificationSettings {
  const envelope = asRecord(input);
  const source = envelope.notificationSettings && typeof envelope.notificationSettings === 'object'
    ? asRecord(envelope.notificationSettings)
    : envelope.settings && typeof envelope.settings === 'object' ? asRecord(envelope.settings) : envelope;
  const enabledEvents = new Set(Array.isArray(source.enabledEvents) ? source.enabledEvents.map(String) : []);
  const events = notificationEventEntries(source).flatMap((entry) => {
    const definition = notificationEventDefinition(entry);
    if (!definition) return [];
    const event = entry && typeof entry === 'object' ? asRecord(entry) : {};
    return [{ ...definition, enabled: event.enabled === true || enabledEvents.has(definition.eventType) }];
  });
  return {
    version: Number(source.version ?? envelope.version ?? 1),
    timezone: typeof source.timezone === 'string' && source.timezone ? source.timezone : 'Europe/Berlin',
    dueSoonLeadDays: Number(source.dueSoonLeadDays ?? 3),
    overdueRepeatDays: Number(source.overdueRepeatDays ?? 7),
    channels: notificationChannelAvailability(source),
    events,
  };
}

/**
 * Normalizes the current member's per-event notification preference matrix.
 *
 * @param input - Direct or enveloped response from the notification-preferences endpoint.
 * @returns Effective group policy and independent Email/Push selections.
 */
export function adaptNotificationPreferences(input: unknown): NotificationPreferences {
  const envelope = asRecord(input);
  const source = envelope.notificationPreferences && typeof envelope.notificationPreferences === 'object'
    ? asRecord(envelope.notificationPreferences)
    : envelope.preferences && !Array.isArray(envelope.preferences) && typeof envelope.preferences === 'object'
      ? asRecord(envelope.preferences)
      : envelope;
  const channels = notificationChannelAvailability(source);
  const rawEvents = Array.isArray(source.events)
    ? source.events
    : Array.isArray(source.preferences) ? source.preferences : CONFIGURABLE_NOTIFICATION_EVENT_TYPES;
  const events = rawEvents.flatMap((entry) => {
    const definition = notificationEventDefinition(entry);
    if (!definition) return [];
    const event = entry && typeof entry === 'object' ? asRecord(entry) : {};
    const selectedChannels = Array.isArray(event.channels) ? notificationChannels(event.channels) : [];
    const enabled = event.enabled !== false && event.groupEnabled !== false;
    return [{
      ...definition,
      enabled,
      email: event.email === true || selectedChannels.includes('EMAIL'),
      push: event.push === true || selectedChannels.includes('PUSH'),
      emailAvailable: enabled && (event.emailAvailable === true || channels.email) && definition.supportedChannels.includes('EMAIL'),
      pushAvailable: enabled && (event.pushAvailable === true || channels.push) && definition.supportedChannels.includes('PUSH'),
    }];
  });
  return { version: Number(source.version ?? envelope.version ?? 1), channels, events };
}

/**
 * Adapts the privacy-minimized destination for an owned notification.
 *
 * @param input - Direct or enveloped response from the account destination endpoint.
 * @returns The active group that owns the opaque notification.
 * @throws Error when the response omits a non-empty group identifier.
 */
export function adaptNotificationDestination(input: unknown): NotificationDestination {
  const envelope = input && typeof input === 'object' ? asRecord(input) : {};
  const source = envelope.destination && typeof envelope.destination === 'object'
    ? asRecord(envelope.destination)
    : envelope;
  const groupId = typeof source.groupId === 'string' ? source.groupId.trim() : '';
  if (!groupId) throw new Error('Notification destination response is missing groupId.');
  return { groupId };
}

/**
 * Removes subscription secrets and normalizes device metadata returned to account UI.
 *
 * @param input - Direct array or `{ items }` response from the device endpoint.
 * @returns Safe account-owned device projections.
 */
export function adaptPushSubscriptions(input: unknown): PushSubscriptionDevice[] {
  const envelope = asRecord(input);
  const entries = Array.isArray(input) ? input : Array.isArray(envelope.items) ? envelope.items : [];
  return entries.map((entry) => {
    const source = asRecord(entry);
    return {
      id: String(source.id ?? ''),
      label: typeof source.deviceLabel === 'string' && source.deviceLabel
        ? source.deviceLabel
        : typeof source.label === 'string' && source.label ? source.label : 'Browser',
      createdAt: typeof source.createdAt === 'string' ? source.createdAt : '',
      lastUsedAt: typeof source.lastUsedAt === 'string' ? source.lastUsedAt : null,
      keyId: typeof source.keyId === 'string' ? source.keyId : '',
      current: source.current === true,
    };
  });
}

/** Adapts the system account-search response. */
export function adaptSystemAccounts(input: unknown): SystemAccount[] {
  const source = asRecord(input);
  const entries = Array.isArray(input) ? input : Array.isArray(source.items) ? source.items : Array.isArray(source.accounts) ? source.accounts : [];
  return entries.map((entry) => {
    const account = asRecord(entry);
    return { id: String(account.id ?? account.userId ?? ''), displayName: String(account.displayName ?? ''), email: String(account.email ?? ''), active: account.active !== false };
  });
}

/** Adapts deletion-impact counters from a managed group or impact endpoint. */
export function adaptSystemGroupImpact(input: unknown): SystemGroupImpact {
  const source = input && typeof input === 'object' ? asRecord(input) : {};
  return {
    members: Number(source.members ?? source.memberCount ?? 0),
    invitations: Number(source.invitations ?? source.invitationCount ?? source.pendingInvitationCount ?? 0),
    bookings: Number(source.bookings ?? source.bookingCount ?? 0),
    financialRecords: Number(source.financialRecords ?? source.financialRecordCount ?? 0),
    auditEntries: Number(source.auditEntries ?? source.auditEventCount ?? 0),
    mediaFiles: Number(source.mediaFiles ?? source.mediaCount ?? 0),
  };
}

/** Adapts the versioned group-deletion impact endpoint. */
export function adaptSystemGroupDeletionImpact(input: unknown): SystemGroupDeletionImpact {
  const source = asRecord(input);
  return {
    groupId: String(source.groupId ?? ''),
    groupName: String(source.groupName ?? ''),
    version: Number(source.version ?? 0),
    openBalance: money(source.openBalanceMinor, source.currency),
    ...adaptSystemGroupImpact(source),
  };
}

/** Adapts the global group-management response and deletion-impact counts. */
export function adaptSystemGroups(input: unknown): SystemGroup[] {
  const source = asRecord(input);
  const entries = Array.isArray(input) ? input : Array.isArray(source.items) ? source.items : Array.isArray(source.groups) ? source.groups : [];
  return entries.map((entry) => {
    const group = asRecord(entry);
    const status = group.status === 'PROVISIONING' || group.status === 'ARCHIVED' ? group.status : 'ACTIVE';
    return {
      id: String(group.id ?? ''),
      name: String(group.name ?? ''),
      currency: String(group.currency ?? 'EUR'),
      status,
      version: Number(group.version ?? 1),
      administratorEmail: typeof group.administratorEmail === 'string' ? group.administratorEmail : null,
      archivedAt: typeof group.archivedAt === 'string' ? group.archivedAt : null,
      createdAt: typeof group.createdAt === 'string' ? group.createdAt : '',
      logoUrl: typeof group.logoUrl === 'string' && group.logoUrl ? group.logoUrl : undefined,
      impact: adaptSystemGroupImpact(group.impact ?? group),
    };
  });
}

/** Adapts the immediate system-group invitation result without retaining a plaintext token. */
export function adaptSystemGroupInvitationResult(input: unknown): SystemGroupInvitationResult {
  const source = asRecord(input);
  const group = adaptSystemGroups([source.group ?? source])[0];
  const status = String(source.emailDeliveryStatus ?? '');
  const validStatus: EmailDeliveryStatus | null = ['NOT_REQUESTED', 'PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED'].includes(status)
    ? status as EmailDeliveryStatus
    : null;
  return {
    group,
    acceptUrl: typeof source.acceptUrl === 'string' && source.acceptUrl ? source.acceptUrl : null,
    emailDeliveryStatus: validStatus,
    expiresAt: typeof source.expiresAt === 'string' && source.expiresAt ? source.expiresAt : null,
  };
}

/** Adapts the immutable global system-audit response. */
export function adaptSystemAudit(input: unknown): SystemAuditEntry[] {
  const source = asRecord(input);
  const entries = Array.isArray(input) ? input : Array.isArray(source.items) ? source.items : Array.isArray(source.entries) ? source.entries : [];
  return entries.map((entry) => {
    const audit = asRecord(entry);
    return {
      id: String(audit.id ?? ''),
      action: String(audit.action ?? ''),
      actorUserId: String(audit.actorUserId ?? ''),
      actorDisplayName: String(audit.actorDisplayName ?? audit.actorUserId ?? i18n.t('common.system')),
      targetType: String(audit.targetType ?? audit.resourceType ?? ''),
      targetId: typeof audit.targetId === 'string' ? audit.targetId : typeof audit.resourceId === 'string' ? audit.resourceId : null,
      summary: typeof audit.summary === 'string' ? audit.summary : audit.metadata && typeof audit.metadata === 'object' ? JSON.stringify(audit.metadata) : '',
      createdAt: String(audit.createdAt ?? audit.occurredAt ?? ''),
    };
  });
}

/** Normalizes a reason mode while retaining safe defaults for legacy servers. */
const reasonMode = (value: unknown, legacyRequired: unknown, fallback: ReasonMode): ReasonMode => {
  if (value === 'OFF' || value === 'OPTIONAL' || value === 'REQUIRED') return value;
  if (typeof legacyRequired === 'boolean') return legacyRequired ? 'REQUIRED' : 'OPTIONAL';
  return fallback;
};

/**
 * Adapts administrator-managed group settings and applies safe feature defaults.
 *
 * @param input - Group-settings response from the API.
 * @returns Complete canonical settings.
 */
export function adaptGroupSettings(input: unknown): GroupSettings {
  const source = asRecord(input);
  const paymentMethods = adaptPaymentMethods(source.paymentMethods);
  const ownBookingReasonMode = reasonMode(source.ownBookingReasonMode, undefined, 'OFF');
  const foreignBookingReasonMode = reasonMode(source.foreignBookingReasonMode, source.foreignBookingReasonRequired, 'REQUIRED');
  const ownPaymentReasonMode = reasonMode(source.ownPaymentReasonMode, source.ownPaymentReasonRequired, 'REQUIRED');
  const otherPaymentReasonMode = reasonMode(source.otherPaymentReasonMode, source.otherPaymentReasonRequired, 'OPTIONAL');
  return {
    defaultTheme: isThemeId(source.defaultTheme) ? source.defaultTheme : 'TEAMTALER',
    statisticsEnabled: source.statisticsEnabled === true,
    settlementsEnabled: source.settlementsEnabled === true,
    notificationEmailsEnabled: source.notificationEmailsEnabled === true,
    notificationEmailDeliveryAvailable: source.notificationEmailDeliveryAvailable === true,
    defaultRoleId: typeof source.defaultRoleId === 'string' && source.defaultRoleId ? source.defaultRoleId : null,
    ownBookingReasonMode,
    foreignBookingReasonMode,
    ownPaymentReasonMode,
    otherPaymentReasonMode,
    foreignBookingReasonRequired: foreignBookingReasonMode === 'REQUIRED',
    ownPaymentReasonRequired: ownPaymentReasonMode === 'REQUIRED',
    otherPaymentReasonRequired: otherPaymentReasonMode === 'REQUIRED',
    paymentMethods: paymentMethods.length > 0 ? paymentMethods : defaultPaymentMethods(),
    bookingReasons: adaptConfigurableItems(source.bookingReasons),
    paymentReasons: adaptConfigurableItems(source.paymentReasons),
  };
}

/** Adapts one ordered configurable option collection. */
export function adaptConfigurableItems(input: unknown, localizePaymentMethods = false): ConfigurableItem[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((entry) => {
    const source = asRecord(entry);
    return typeof source.id === 'string' && typeof source.label === 'string' && source.id && source.label
      ? [{ id: source.id, label: localizePaymentMethods ? localizedPaymentMethodLabel(source.id, source.label) : source.label }]
      : [];
  });
}

/**
 * Adapts a nullable external payment destination from an untrusted wire value.
 *
 * @param input - Candidate nested payment-target object.
 * @returns A canonical safe target, or `null` for legacy and malformed values.
 */
export function adaptPaymentTarget(input: unknown): PaymentTarget | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const source = asRecord(input);
  if (source.type === 'PAYPAL_ME' && typeof source.paypalMeHandle === 'string') {
    if (!Object.keys(source).every((key) => key === 'type' || key === 'paypalMeHandle')) return null;
    const paypalMeHandle = source.paypalMeHandle.trim();
    return isPaypalMeHandle(paypalMeHandle) ? { type: 'PAYPAL_ME', paypalMeHandle } : null;
  }
  if (source.type === 'SEPA_TRANSFER' && typeof source.recipientName === 'string' && typeof source.iban === 'string') {
    if (!Object.keys(source).every((key) => key === 'type' || key === 'recipientName' || key === 'iban' || key === 'bic')) return null;
    if ('bic' in source && typeof source.bic !== 'string') return null;
    const recipientName = source.recipientName.trim();
    const iban = normalizeIban(source.iban);
    const bic = typeof source.bic === 'string' ? normalizeBic(source.bic) : '';
    const target: PaymentTarget = { type: 'SEPA_TRANSFER', recipientName, iban, ...(bic ? { bic } : {}) };
    return isPaymentTargetValid(target, 'EUR') ? target : null;
  }
  return null;
}

/** Adapts payment methods while defaulting legacy receipt policies and targets safely. */
export function adaptPaymentMethods(input: unknown): PaymentMethod[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((entry) => {
    const source = asRecord(entry);
    if (typeof source.id !== 'string' || typeof source.label !== 'string' || !source.id || !source.label) return [];
    const attachmentMode = source.attachmentMode === 'OPTIONAL' || source.attachmentMode === 'REQUIRED' ? source.attachmentMode : 'OFF';
    return [{ id: source.id, label: localizedPaymentMethodLabel(source.id, source.label), attachmentMode, paymentTarget: adaptPaymentTarget(source.paymentTarget) }];
  });
}

/** Adapts member-visible feature state and payment destinations for transaction surfaces. */
export function adaptTransactionSettings(input: unknown): TransactionSettings {
  const source = asRecord(input);
  const paymentMethods = adaptPaymentMethods(source.paymentMethods);
  const ownBookingReasonMode = reasonMode(source.ownBookingReasonMode, undefined, 'OFF');
  const foreignBookingReasonMode = reasonMode(source.foreignBookingReasonMode, source.foreignBookingReasonRequired, 'REQUIRED');
  const ownPaymentReasonMode = reasonMode(source.ownPaymentReasonMode, source.ownPaymentReasonRequired, 'REQUIRED');
  const otherPaymentReasonMode = reasonMode(source.otherPaymentReasonMode, source.otherPaymentReasonRequired, 'OPTIONAL');
  return {
    settlementsEnabled: source.settlementsEnabled === true,
    ownBookingReasonMode,
    foreignBookingReasonMode,
    ownPaymentReasonMode,
    otherPaymentReasonMode,
    foreignBookingReasonRequired: foreignBookingReasonMode === 'REQUIRED',
    ownPaymentReasonRequired: ownPaymentReasonMode === 'REQUIRED',
    otherPaymentReasonRequired: otherPaymentReasonMode === 'REQUIRED',
    paymentMethods: paymentMethods.length > 0 ? paymentMethods : defaultPaymentMethods(),
    bookingReasons: adaptConfigurableItems(source.bookingReasons),
    paymentReasons: adaptConfigurableItems(source.paymentReasons),
  };
}

/**
 * Adapts allow grants and drops unsupported scopes or permission keys.
 *
 * @param input - Grant array returned by session, role, or membership endpoints.
 * @returns Unique, group-scoped permission grants.
 */
export function adaptPermissionGrants(input: unknown): PermissionGrant[] {
  if (!Array.isArray(input)) return [];
  const permissions = new Set<PermissionGrant['permission']>();
  for (const entry of input) {
    if (typeof entry !== 'string' && (!entry || typeof entry !== 'object')) continue;
    const source = typeof entry === 'string' ? { permission: entry } : asRecord(entry);
    const permission = source.permission ?? source.permissionKey ?? source.key;
    const scope = source.scope && typeof source.scope === 'object' ? asRecord(source.scope) : undefined;
    const scopeType = scope?.type ?? source.scopeType ?? 'GROUP';
    if (scopeType === 'GROUP'
      && source.categoryId === undefined
      && source.productId === undefined
      && scope?.categoryId === undefined
      && scope?.productId === undefined
      && isPermissionKey(permission)) permissions.add(permission);
  }
  return [...permissions].map((permission) => ({ permission, scope: { type: 'GROUP' } }));
}

/**
 * Adapts one server-owned permission definition.
 *
 * @param input - Permission registry entry from the API.
 * @returns Canonical metadata for the role editor.
 * @throws TypeError when the entry contains an unknown permission key.
 */
export function adaptPermissionDefinition(input: unknown): PermissionDefinition {
  const source = asRecord(input);
  const key = source.key ?? source.permission;
  if (!isPermissionKey(key)) throw new TypeError(`Unsupported permission definition: ${String(key)}`);
  const implied = source.impliedPermissions ?? source.implies;
  const allowedScopes = Array.isArray(source.allowedScopes)
    ? source.allowedScopes.filter((scope): scope is 'GROUP' | 'CATEGORY' | 'PRODUCT' => scope === 'GROUP' || scope === 'CATEGORY' || scope === 'PRODUCT')
    : undefined;
  return {
    key,
    name: typeof source.name === 'string' && source.name ? source.name : undefined,
    description: typeof source.description === 'string' && source.description ? source.description : undefined,
    impliedPermissions: Array.isArray(implied) ? implied.filter(isPermissionKey) : [],
    allowedScopes,
  };
}

/**
 * Adapts one group-owned role and its assignment counters.
 *
 * @param input - Role response from the API.
 * @returns Canonical role used by role management.
 */
export function adaptRole(input: unknown): Role {
  const source = asRecord(input);
  return {
    id: String(source.id ?? ''),
    groupId: typeof source.groupId === 'string' ? source.groupId : undefined,
    presetKey: typeof source.presetKey === 'string' ? source.presetKey as Role['presetKey'] : undefined,
    name: typeof source.name === 'string' ? source.name : '',
    description: typeof source.description === 'string' && source.description ? source.description : undefined,
    nameLocked: typeof source.nameLocked === 'boolean' ? source.nameLocked : undefined,
    deletable: typeof source.deletable === 'boolean' ? source.deletable : undefined,
    grants: adaptPermissionGrants(source.grants),
    version: Number(source.version ?? 1),
    memberCount: Number(source.memberCount ?? 0),
    pendingInvitationCount: Number(source.pendingInvitationCount ?? 0),
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : undefined,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : undefined,
  };
}

/**
 * Adapts one role assignment for a member or pending invitation.
 *
 * @param input - Assignment response from the API.
 * @returns Canonical role assignment with optimistic-concurrency metadata.
 */
export function adaptRoleAssignment(input: unknown): RoleAssignment {
  const source = asRecord(input);
  return {
    subjectType: source.subjectType === 'INVITATION' ? 'INVITATION' : 'MEMBERSHIP',
    subjectId: String(source.subjectId ?? source.membershipId ?? source.invitationId ?? ''),
    roleIds: Array.isArray(source.roleIds) ? source.roleIds.map(String) : [],
    version: Number(source.version ?? 1),
    etag: typeof source.etag === 'string' ? source.etag : undefined,
  };
}

/**
 * Extracts the user-provided reference from a structured payment description.
 *
 * @param description - Backend ledger description for a payment or its reversal.
 * @returns The preserved payment reference, or `undefined` when none is present.
 */
function paymentReference(description: string): string | undefined {
  const original = description.startsWith(REVERSAL_DESCRIPTION_PREFIX)
    ? description.slice(REVERSAL_DESCRIPTION_PREFIX.length)
    : description;
  const referencePrefix = `${PAYMENT_DESCRIPTION_PREFIX}: `;
  return original.startsWith(referencePrefix) ? original.slice(referencePrefix.length).trim() || undefined : undefined;
}

/**
 * Produces localized copy for a structured backend ledger movement.
 *
 * Product, category, and payment-reference values remain untouched because they
 * are group-authored business data; backend-owned English labels are replaced.
 *
 * @param wire - Untrusted ledger wire entry.
 * @returns A localized description suitable for the account table and CSV export.
 */
function ledgerDescription(wire: JsonRecord): string {
  const description = String(wire.description ?? '');
  const reversed = Boolean(wire.reversalOf);
  if (wire.paymentId) {
    const reference = paymentReference(description);
    if (reversed) {
      return reference
        ? i18n.t('ledger.paymentReversedWithReference', { reference })
        : i18n.t('ledger.paymentReversed');
    }
    return reference
      ? i18n.t('ledger.paymentReceivedWithReference', { reference })
      : i18n.t('ledger.paymentReceived');
  }
  if (wire.bookingId) {
    const original = description.startsWith(REVERSAL_DESCRIPTION_PREFIX)
      ? description.slice(REVERSAL_DESCRIPTION_PREFIX.length)
      : description;
    const localized = original.replace(/^(\d+)\s+x\s+/, '$1 × ');
    return reversed ? i18n.t('ledger.bookingReversed', { description: localized }) : localized;
  }
  return reversed ? i18n.t('ledger.reversal') : i18n.t('ledger.adjustment');
}

/**
 * Adapts the session wire model to the stable frontend session.
 *
 * @param input - Untrusted session response from `/api/v1/session` or authentication.
 * @returns A session with a nullable active group and validated global roles.
 */
export function adaptSession(input: unknown): Session {
  const source = asRecord(input);
  const groups = (source.groups as unknown[] ?? []).map((entry) => {
    const group = asRecord(entry);
    const membership = group.membership && typeof group.membership === 'object' ? asRecord(group.membership) : undefined;
    return {
      id: String(group.id),
      name: String(group.name),
      currency: String(group.currency || 'EUR'),
      logoUrl: typeof group.logoUrl === 'string' ? group.logoUrl : undefined,
      defaultTheme: isThemeId(group.defaultTheme) ? group.defaultTheme : 'TEAMTALER',
      statisticsEnabled: group.statisticsEnabled === true,
      planningEnabled: group.planningEnabled === true,
      membership: membership ? {
        id: String(membership.id),
        roles: [...(membership.roles as GroupRole[] ?? []), 'MEMBER'],
        groupPermissions: (membership.groupPermissions as Membership['groupPermissions'] | undefined) ?? [],
        roleIds: Array.isArray(membership.roleIds) ? membership.roleIds.map(String) : [],
        effectiveGrants: adaptPermissionGrants(membership.effectiveGrants),
        roleAssignmentsVersion: Number(membership.roleAssignmentsVersion ?? 1),
        themeOverride: isThemeId(membership.themeOverride) ? membership.themeOverride : null,
      } : undefined,
    } satisfies Group;
  });
  return {
    user: adaptUser(source.user),
    groups,
    activeGroupId: typeof source.activeGroupId === 'string' && groups.some((group) => group.id === source.activeGroupId)
      ? source.activeGroupId
      : groups[0]?.id ?? null,
    defaultGroupId: typeof source.defaultGroupId === 'string' ? source.defaultGroupId : null,
    colorMode: isColorMode(source.colorMode) ? source.colorMode : 'SYSTEM',
    systemRoles: Array.isArray(source.systemRoles) && source.systemRoles.includes('SYSTEM_ADMINISTRATOR') ? ['SYSTEM_ADMINISTRATOR'] : [],
    demo: source.demo === true,
  };
}

/** Adapts the group-owned planning feature switch. */
export function adaptPlanningSettings(input: unknown): PlanningSettings {
  const source = asRecord(input);
  return {
    enabled: source.enabled === true,
    version: Number(source.version ?? 1),
    timeZone: typeof source.timeZone === 'string' && source.timeZone ? source.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : undefined,
  };
}

function adaptPlanningAudience(source: JsonRecord): PlanningAudience {
  const type = source.audienceType === 'SELECTED_ROLES' || source.audienceType === 'SELECTED_MEMBERS' || source.audienceType === 'SELECTED_TARGETS'
    ? source.audienceType
    : 'ALL_ACTIVE_MEMBERS';
  return {
    type,
    roleIds: Array.isArray(source.targetRoleIds) ? source.targetRoleIds.map(String) : [],
    memberIds: Array.isArray(source.targetMembershipIds) ? source.targetMembershipIds.map(String) : [],
  };
}

/** Adapts a structured recurrence rule while rejecting unsupported wire values. */
export function adaptPlanningRecurrence(input: unknown): PlanningRecurrenceInput {
  const source = asRecord(input);
  const frequency = source.frequency === 'DAILY' || source.frequency === 'MONTHLY' || source.frequency === 'YEARLY'
    ? source.frequency
    : 'WEEKLY';
  const weekdayValues = new Set(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
  const weekdays = Array.isArray(source.weekdays)
    ? source.weekdays.map(String).filter((value): value is PlanningWeekday => weekdayValues.has(value))
    : undefined;
  const monthlyMode = source.monthlyMode === 'NTH_WEEKDAY' || source.monthlyMode === 'LAST_DAY' ? source.monthlyMode : 'DAY_OF_MONTH';
  const rawRange = asRecord(source.range);
  const range = rawRange.type === 'COUNT'
    ? { type: 'COUNT' as const, count: Math.max(2, Math.min(500, Number(rawRange.count ?? 2))) }
    : rawRange.type === 'UNTIL' && typeof rawRange.until === 'string'
      ? { type: 'UNTIL' as const, until: rawRange.until }
      : { type: 'NEVER' as const };
  return {
    frequency,
    interval: Math.max(1, Math.min(99, Number(source.interval ?? 1))),
    ...(frequency === 'WEEKLY' && weekdays?.length ? { weekdays } : {}),
    ...(frequency === 'MONTHLY' ? { monthlyMode } : {}),
    range,
  };
}

/** Adapts one planning event and its privacy-safe viewer projection. */
export function adaptPlanningEvent(input: unknown): PlanningEvent {
  const source = asRecord(input);
  const counts = source.counts && typeof source.counts === 'object' ? asRecord(source.counts) : {};
  const myParticipation = source.myParticipation && typeof source.myParticipation === 'object'
    ? asRecord(source.myParticipation)
    : source.myEffectiveStatus || source.myParticipationStatus ? { effectiveStatus: source.myEffectiveStatus, status: source.myParticipationStatus } : undefined;
  const eventType = source.eventType === 'APPOINTMENT_POLL' || source.eventType === 'APPOINTMENT_REGISTRATION' ? source.eventType : 'APPOINTMENT';
  const status = source.status === 'CLOSED' || source.status === 'COMPLETED' || source.status === 'CANCELLED' ? source.status : 'PUBLISHED';
  const effectiveViewerStatus = myParticipation?.effectiveStatus;
  const viewerStatus = myParticipation?.status === 'WITHDRAWN' || effectiveViewerStatus === 'WITHDRAWN'
    ? 'WITHDRAWN'
    : participationStatus(myParticipation?.status ?? effectiveViewerStatus);
  const startsAt = String(source.startsAt ?? '');
  const endsAt = typeof source.endsAt === 'string' ? source.endsAt : undefined;
  const allDay = source.allDay === true;
  const startDate = planningDateKey(source.startDate) ?? planningDateKey(startsAt.slice(0, 10)) ?? '1970-01-01';
  const endDateExclusive = planningDateKey(source.endDateExclusive) ?? planningDateKey(endsAt?.slice(0, 10)) ?? nextPlanningDate(startDate);
  const event: PlanningEventBase = {
    id: String(source.id),
    version: Number(source.version ?? 1),
    eventType,
    status,
    title: String(source.title ?? ''),
    description: String(source.description ?? ''),
    location: String(source.location ?? ''),
    startsAt,
    endsAt,
    responseDeadline: typeof source.responseDeadline === 'string' ? source.responseDeadline : undefined,
    responseDeadlineMinutesBefore: Number.isFinite(Number(source.responseDeadlineMinutesBefore)) ? Number(source.responseDeadlineMinutesBefore) : undefined,
    capacity: Number.isInteger(Number(source.capacity)) && Number(source.capacity) > 0 ? Number(source.capacity) : undefined,
    waitlistEnabled: source.waitlistEnabled === true,
    confirmationRevision: Number(source.confirmationRevision ?? 1),
    audience: adaptPlanningAudience(source),
    participation: {
      invited: Number(counts.invited ?? 0),
      attending: Number(eventType === 'APPOINTMENT_REGISTRATION' ? counts.registered ?? 0 : counts.yes ?? 0),
      maybe: Number(counts.maybe ?? 0),
      declined: Number(counts.no ?? 0),
      unanswered: Number(counts.pending ?? 0),
      waitlisted: Number(counts.waitlisted ?? 0),
      reconfirmationRequired: 0,
      ...(Number.isInteger(Number(source.capacity)) && Number(source.capacity) > 0 ? { capacity: Number(source.capacity) } : {}),
    },
    viewerParticipation: viewerStatus ? { status: viewerStatus, wireStatus: participationWireStatus(myParticipation?.status), updatedAt: typeof myParticipation?.updatedAt === 'string' ? myParticipation.updatedAt : undefined } : undefined,
    createdByName: typeof source.createdByName === 'string' ? source.createdByName : undefined,
    canEdit: source.canEdit === true,
    canCancel: source.canCancel === true,
    canRespond: source.canRespond === true,
    canViewParticipants: source.canViewParticipants === true,
    seriesId: typeof source.seriesId === 'string' && source.seriesId ? source.seriesId : undefined,
    originalStartAt: typeof source.originalStartAt === 'string' && source.originalStartAt ? source.originalStartAt : undefined,
    originalStartDate: planningDateKey(source.originalStartDate),
    isSeriesException: source.isSeriesException === true,
  };
  return allDay
    ? { ...event, allDay: true, startDate, endDateExclusive, timeZone: typeof source.timeZone === 'string' && source.timeZone ? source.timeZone : 'UTC' }
    : { ...event, allDay: false, timeZone: typeof source.timeZone === 'string' && source.timeZone ? source.timeZone : 'UTC' };
}

/** Adapts a cursor-backed planning-event response. */
export function adaptPlanningEventPage(input: unknown): PlanningEventPage {
  const source = Array.isArray(input) ? { items: input } : asRecord(input);
  return {
    items: (source.items as unknown[] ?? []).map(adaptPlanningEvent),
    nextCursor: typeof source.nextCursor === 'string' && source.nextCursor ? source.nextCursor : undefined,
  };
}

/** Adapts one group-owned planning series. */
export function adaptPlanningSeries(input: unknown): PlanningSeries {
  const source = asRecord(input);
  const series: PlanningSeriesBase = {
    id: String(source.id),
    version: Number(source.version ?? 1),
    status: source.status === 'CANCELLED' ? 'CANCELLED' : 'PUBLISHED',
    timeZone: typeof source.timeZone === 'string' && source.timeZone ? source.timeZone : 'UTC',
    eventType: source.eventType === 'APPOINTMENT_POLL' || source.eventType === 'APPOINTMENT_REGISTRATION' ? source.eventType : 'APPOINTMENT',
    title: String(source.title ?? ''),
    description: String(source.description ?? ''),
    location: String(source.location ?? ''),
    responseDeadlineMinutesBefore: Number.isFinite(Number(source.responseDeadlineMinutesBefore)) ? Number(source.responseDeadlineMinutesBefore) : undefined,
    capacity: Number.isInteger(Number(source.capacity)) && Number(source.capacity) > 0 ? Number(source.capacity) : undefined,
    waitlistEnabled: source.waitlistEnabled === true,
    audience: adaptPlanningAudience(source),
    recurrence: adaptPlanningRecurrence(source.recurrence),
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : undefined,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : undefined,
  };
  if (source.allDay === true) return {
    ...series,
    allDay: true,
    startDate: planningDateKey(source.startDate) ?? '1970-01-01',
    durationDays: Math.max(1, Math.round(Number(source.durationDays ?? 1))),
  };
  return { ...series, allDay: false, durationMinutes: Math.max(1, Number(source.durationMinutes ?? 60)) };
}

/** Adapts a series command response and its optionally materialized first occurrence. */
export function adaptPlanningSeriesResult(input: unknown): PlanningSeriesResult {
  const source = asRecord(input);
  return {
    series: adaptPlanningSeries(source.series ?? source),
    firstOccurrence: source.firstOccurrence ? adaptPlanningEvent(source.firstOccurrence) : undefined,
  };
}

/** Adapts a participant without broadening server-projected identity visibility. */
export function adaptPlanningParticipant(input: unknown): PlanningParticipant {
  const source = asRecord(input);
  const effectiveStatus = source.status === 'WITHDRAWN' || source.effectiveStatus === 'WITHDRAWN' ? 'WITHDRAWN' : participationStatus(source.status ?? source.effectiveStatus);
  return {
    membershipId: String(source.membershipId ?? ''),
    displayName: String(source.displayName ?? i18n.t('common.member')),
    avatarUrl: typeof source.avatarUrl === 'string' ? source.avatarUrl : undefined,
    status: source.status === 'WITHDRAWN' ? source.status : participationStatus(source.status),
    effectiveStatus,
    confirmedRevision: Number(source.confirmedRevision ?? 0),
    version: Number(source.version ?? 1),
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : undefined,
  };
}

/** Adapts a cursor-backed participant response. */
export function adaptPlanningParticipantPage(input: unknown): PlanningParticipantPage {
  const source = Array.isArray(input) ? { items: input } : asRecord(input);
  return {
    items: (source.items as unknown[] ?? []).map(adaptPlanningParticipant),
    nextCursor: typeof source.nextCursor === 'string' && source.nextCursor ? source.nextCursor : undefined,
  };
}

/**
 * Adapts the persisted account color-mode response with a safe system fallback.
 *
 * @param input - Untrusted response from the account appearance endpoint.
 * @returns A validated account color-mode preference.
 */
export function adaptAppearancePreference(input: unknown): AppearancePreference {
  const source = asRecord(input);
  return { colorMode: isColorMode(source.colorMode) ? source.colorMode : 'SYSTEM' };
}

/**
 * Adapts the current membership's optional group-theme override.
 *
 * @param input - Untrusted response from the group theme-preference endpoint.
 * @returns A validated theme override or `null` for group inheritance.
 */
export function adaptThemePreference(input: unknown): ThemePreference {
  const source = asRecord(input);
  return { themeOverride: isThemeId(source.themeOverride) ? source.themeOverride : null };
}

/**
 * Adapts a signed-in user returned by profile and session endpoints.
 *
 * @param input - Untrusted user response from the API.
 * @returns A canonical user with optional avatar metadata.
 */
export function adaptUser(input: unknown): User {
  const source = asRecord(input);
  return {
    id: String(source.id),
    displayName: String(source.displayName),
    email: String(source.email),
    avatarUrl: typeof source.avatarUrl === 'string' && source.avatarUrl ? source.avatarUrl : undefined,
  };
}

/**
 * Adapts one catalogue product and its integer minor-unit price.
 *
 * @param input - Product wire or canonical product value.
 * @returns Canonical frontend product.
 */
export function adaptProduct(input: unknown): Product {
  const source = asRecord(input);
  const sourcePrice = source.price && typeof source.price === 'object' ? asRecord(source.price) : undefined;
  const currency = String(source.currency || sourcePrice?.currency || 'EUR');
  const pricingMode = source.pricingMode === 'USER_DEFINED' ? 'USER_DEFINED' : 'FIXED';
  return {
    id: String(source.id),
    categoryId: String(source.categoryId),
    version: Number(source.version ?? 1),
    name: String(source.name),
    pricingMode,
    currency,
    price: pricingMode === 'FIXED' ? sourcePrice ? money(sourcePrice.minorUnits, sourcePrice.currency || currency) : money(source.priceMinor, currency) : undefined,
    imageUrl: typeof source.imageUrl === 'string' && source.imageUrl ? source.imageUrl : undefined,
    active: source.active !== false,
    sortOrder: Number(source.sortOrder ?? 0),
  };
}

/**
 * Adapts catalogue categories and nested products.
 *
 * @param input - Category array returned by the group catalogue endpoint.
 * @returns Canonical categories sorted by the backend.
 */
export function adaptCategories(input: unknown): Category[] {
  return (input as unknown[] ?? []).map((entry) => {
    const source = asRecord(entry);
    const name = String(source.name);
    return {
      id: String(source.id),
      version: Number(source.version ?? 1),
      name,
      icon: categoryIcon(source.icon),
      active: source.active !== false,
      sortOrder: Number(source.sortOrder ?? 0),
      products: (source.products as unknown[] ?? []).map(adaptProduct),
    };
  });
}

/**
 * Adapts member roles and the backend's category-grant map.
 *
 * @param input - Membership wire or canonical membership value.
 * @param etag - Optional strong collection ETag used for optimistic updates.
 * @returns Canonical membership with boolean category permissions.
 */
export function adaptMembership(input: unknown, etag?: string): Membership {
  const source = asRecord(input);
  const status = source.status === 'ARCHIVED' || source.status === 'DELETED' ? source.status : 'ACTIVE';
  if ('categoryPermissions' in source) return {
    ...(source as unknown as Membership),
    userId: String(source.userId ?? ''),
    email: typeof source.email === 'string' && source.email ? source.email : null,
    isTemporaryGuest: source.isTemporaryGuest === true,
    groupPermissions: (source.groupPermissions as Membership['groupPermissions'] | undefined) ?? [],
    roleIds: Array.isArray(source.roleIds) ? source.roleIds.map(String) : [],
    effectiveGrants: adaptPermissionGrants(source.effectiveGrants),
    roleAssignmentsVersion: Number(source.roleAssignmentsVersion ?? 1),
    themeOverride: isThemeId(source.themeOverride) ? source.themeOverride : null,
    status,
    active: status === 'ACTIVE',
    etag: etag ?? source.etag as string | undefined,
  };
  const grants = (source.categoryGrants ?? {}) as Record<string, string[]>;
  const roles = (source.roles as GroupRole[] ?? []).filter((role) => role !== 'MEMBER');
  return {
    id: String(source.id),
    userId: String(source.userId ?? ''),
    displayName: String(source.displayName),
    email: typeof source.email === 'string' && source.email ? source.email : null,
    initials: initials(String(source.displayName)),
    avatarUrl: typeof source.avatarUrl === 'string' && source.avatarUrl ? source.avatarUrl : undefined,
    isTemporaryGuest: source.isTemporaryGuest === true,
    roles: [...roles, 'MEMBER'],
    groupPermissions: (source.groupPermissions as Membership['groupPermissions'] | undefined) ?? [],
    categoryPermissions: Object.entries(grants).map(([categoryId, permissions]) => ({
      categoryId,
      assignToOthers: permissions.includes('ASSIGN_TO_OTHERS'),
      voidBookings: permissions.includes('VOID_BOOKINGS'),
    })),
    roleIds: Array.isArray(source.roleIds) ? source.roleIds.map(String) : [],
    effectiveGrants: adaptPermissionGrants(source.effectiveGrants),
    roleAssignmentsVersion: Number(source.roleAssignmentsVersion ?? 1),
    themeOverride: isThemeId(source.themeOverride) ? source.themeOverride : null,
    status,
    active: status === 'ACTIVE',
    etag,
  };
}

/**
 * Adapts a member collection.
 *
 * @param input - Membership array from the API.
 * @param etag - Shared strong ETag from the collection response.
 * @returns Canonical memberships.
 */
export function adaptMemberships(input: unknown, etag?: string): Membership[] {
  return (input as unknown[] ?? []).map((entry) => adaptMembership(entry, etag));
}

/**
 * Adapts one privacy-reduced booking target.
 *
 * @param input - Target returned by the booking-context endpoint.
 * @returns Stable booking-target identity without member-directory details.
 */
export function adaptBookingTarget(input: unknown): BookingTarget {
  const source = asRecord(input);
  return {
    membershipId: String(source.membershipId ?? source.id ?? ''),
    displayName: String(source.displayName ?? ''),
    avatarUrl: typeof source.avatarUrl === 'string' && source.avatarUrl ? source.avatarUrl : undefined,
    isTemporaryGuest: source.isTemporaryGuest === true,
  };
}

/**
 * Adapts the permission-filtered data required to create product bookings.
 *
 * @param input - Booking-context response from the active group.
 * @param currency - Active group currency used for its minor-unit balance.
 * @returns Canonical booking context with normalized period, balance, and targets.
 */
export function adaptBookingContext(input: unknown, currency: string): BookingContext {
  const source = asRecord(input);
  const ownBookingReasonMode = reasonMode(source.ownBookingReasonMode, undefined, 'OFF');
  const foreignBookingReasonMode = reasonMode(source.foreignBookingReasonMode, source.foreignBookingReasonRequired, 'REQUIRED');
  return {
    openPeriod: adaptPeriod(source.openPeriod),
    ownBalance: money(source.ownBalanceMinor, currency),
    currentMembership: adaptMembership(source.currentMembership),
    targets: (source.targets as unknown[] ?? []).map(adaptBookingTarget),
    canBookForGuests: source.canBookForGuests === true,
    ownBookingReasonMode,
    foreignBookingReasonMode,
    foreignBookingReasonRequired: foreignBookingReasonMode === 'REQUIRED',
    bookingReasons: adaptConfigurableItems(source.bookingReasons),
  };
}

/**
 * Adapts an immutable booking snapshot.
 *
 * @param input - Booking wire or canonical value.
 * @param members - Optional member directory used to resolve display names.
 * @param fallbackMemberName - Name used when the target is the current account.
 * @returns Canonical booking.
 */
export function adaptBooking(input: unknown, members?: Membership[], fallbackMemberName = i18n.t('common.member')): Booking {
  const source = asRecord(input);
  if ('bookedAt' in source) {
    const booking = source as unknown as Booking;
    const target = members?.find((member) => member.id === booking.memberId);
    const actor = members?.find((member) => booking.bookedByMemberId
      ? member.id === booking.bookedByMemberId
      : member.displayName === booking.bookedByName);
    return {
      ...booking,
      memberName: target?.displayName ?? booking.memberName,
      memberAvatarUrl: target?.avatarUrl ?? booking.memberAvatarUrl,
      bookedByName: actor?.displayName ?? booking.bookedByName,
      bookedByAvatarUrl: actor?.avatarUrl ?? booking.bookedByAvatarUrl,
    };
  }
  const targetId = String(source.targetMembershipId ?? '');
  const actorId = String(source.actorMembershipId ?? '');
  const createdAt = String(source.createdAt);
  return {
    id: String(source.id),
    memberId: targetId,
    memberName: typeof source.targetDisplayName === 'string' && source.targetDisplayName
      ? source.targetDisplayName
      : memberName(targetId, members, fallbackMemberName),
    memberStatus: source.targetMembershipStatus === 'ARCHIVED' || source.targetMembershipStatus === 'DELETED' ? source.targetMembershipStatus : 'ACTIVE',
    memberAvatarUrl: typeof source.targetAvatarUrl === 'string' && source.targetAvatarUrl
      ? source.targetAvatarUrl
      : memberAvatarUrl(targetId, members),
    productId: String(source.productId),
    productName: String(source.productName),
    categoryId: String(source.categoryId),
    categoryName: String(source.categoryName),
    quantity: Number(source.quantity ?? 1),
    unitPrice: money(source.unitPriceMinor, source.currency),
    total: money(source.totalMinor, source.currency),
    bookedAt: createdAt,
    bookedByName: typeof source.actorDisplayName === 'string' && source.actorDisplayName
      ? source.actorDisplayName
      : memberName(actorId, members, actorId === targetId ? fallbackMemberName : i18n.t('common.member')),
    bookedByStatus: source.actorMembershipStatus === 'ARCHIVED' || source.actorMembershipStatus === 'DELETED' ? source.actorMembershipStatus : 'ACTIVE',
    bookedByMemberId: actorId || undefined,
    bookedByAvatarUrl: typeof source.actorAvatarUrl === 'string' && source.actorAvatarUrl
      ? source.actorAvatarUrl
      : memberAvatarUrl(actorId, members),
    reason: typeof source.reason === 'string' && source.reason ? source.reason : undefined,
    status: source.voidedAt ? 'REVERSED' : 'POSTED',
    undoUntil: typeof source.voidWithoutReasonUntil === 'string' ? source.voidWithoutReasonUntil : typeof source.undoUntil === 'string' ? source.undoUntil : undefined,
    canVoid: source.canVoid === true,
    voidReasonRequired: source.voidReasonRequired === true,
    voidWithoutReasonUntil: typeof source.voidWithoutReasonUntil === 'string' ? source.voidWithoutReasonUntil : undefined,
  };
}

/**
 * Adapts one normalized server-side account activity without changing its
 * signed member-receivable amount.
 *
 * @param input - Unified activity wire value.
 * @returns Canonical activity used directly by the activities table.
 * @throws {TypeError} When a reversal omits its original transaction kind.
 *
 * @example
 * adaptActivity({ kind: 'REVERSAL', reversalSourceKind: 'BOOKING', amountMinor: -500, currency: 'EUR' });
 */
export function adaptActivity(input: unknown): ActivityEntry {
  const source = asRecord(input);
  const kind = source.kind === 'PAYMENT' || source.kind === 'REVERSAL' || source.kind === 'ADJUSTMENT' ? source.kind : 'BOOKING';
  const reversalSourceKind = source.reversalSourceKind === 'BOOKING' || source.reversalSourceKind === 'PAYMENT'
    ? source.reversalSourceKind
    : undefined;
  if (kind === 'REVERSAL' && !reversalSourceKind) {
    throw new TypeError('Reversal activities require a BOOKING or PAYMENT reversalSourceKind.');
  }
  const attachment = kind === 'PAYMENT' ? paymentAttachmentSummary(source.attachment) : undefined;
  const paymentMethod = (kind === 'PAYMENT' || reversalSourceKind === 'PAYMENT') && typeof source.paymentMethod === 'string' && source.paymentMethod
    ? source.paymentMethod as Payment['method']
    : undefined;
  const detailName = String(source.detailName);
  const targetStatus = source.targetMembershipStatus === 'ARCHIVED' || source.targetMembershipStatus === 'DELETED'
    ? source.targetMembershipStatus
    : 'ACTIVE';
  const actorStatus = source.actorMembershipStatus === 'ARCHIVED' || source.actorMembershipStatus === 'DELETED'
    ? source.actorMembershipStatus
    : source.actorMembershipId ? 'ACTIVE' : undefined;
  return {
    id: String(source.id),
    sourceId: String(source.sourceId),
    periodId: typeof source.periodId === 'string' && source.periodId ? source.periodId : undefined,
    kind,
    targetMembershipId: String(source.targetMembershipId),
    targetDisplayName: String(source.targetDisplayName),
    targetMembershipStatus: targetStatus,
    targetAvatarUrl: typeof source.targetAvatarUrl === 'string' && source.targetAvatarUrl ? source.targetAvatarUrl : undefined,
    actorMembershipId: typeof source.actorMembershipId === 'string' && source.actorMembershipId ? source.actorMembershipId : undefined,
    actorDisplayName: typeof source.actorDisplayName === 'string' && source.actorDisplayName ? source.actorDisplayName : undefined,
    actorMembershipStatus: actorStatus,
    actorAvatarUrl: typeof source.actorAvatarUrl === 'string' && source.actorAvatarUrl ? source.actorAvatarUrl : undefined,
    detailName: paymentMethod ? historicalPaymentMethodLabel(paymentMethod, detailName) : detailName,
    detailNote: typeof source.detailNote === 'string' && source.detailNote ? source.detailNote : undefined,
    paymentMethod,
    categoryId: typeof source.categoryId === 'string' && source.categoryId ? source.categoryId : undefined,
    categoryName: typeof source.categoryName === 'string' && source.categoryName ? source.categoryName : undefined,
    productId: typeof source.productId === 'string' && source.productId ? source.productId : undefined,
    quantity: Number(source.quantity ?? 0) || undefined,
    amount: money(source.amountMinor, source.currency),
    occurredAt: String(source.occurredAt),
    status: kind !== 'REVERSAL' && source.status === 'REVERSED' ? 'REVERSED' : 'POSTED',
    relatedActivityId: typeof source.relatedActivityId === 'string' && source.relatedActivityId ? source.relatedActivityId : undefined,
    reversalSourceKind,
    ...(attachment ? { attachment } : {}),
    canReverse: kind !== 'REVERSAL' && source.canReverse === true,
    reversalReasonRequired: kind !== 'REVERSAL' && source.reversalReasonRequired === true,
    reversalWithoutReasonUntil: kind !== 'REVERSAL' && typeof source.reversalWithoutReasonUntil === 'string' ? source.reversalWithoutReasonUntil : undefined,
  };
}

/**
 * Adapts the grouped dashboard read model.
 *
 * @param input - Dashboard response containing account, period, and recent bookings.
 * @returns Canonical dashboard consumed by dashboard and booking views.
 */
export function adaptDashboard(input: unknown): Dashboard {
  const source = asRecord(input);
  if ('openBalance' in source) {
    const dashboard = source as unknown as Dashboard;
    return {
      ...dashboard,
      planningEnabled: source.planningEnabled === true,
      openPlanningActionCount: Number(source.openPlanningActionCount ?? 0),
      planning: source.nextPlanningEvent ? { event: adaptPlanningEvent(source.nextPlanningEvent), actionRequired: asRecord(source.nextPlanningEvent).actionRequired === true } : undefined,
    };
  }
  const account = asRecord(source.account);
  const currentPeriod = adaptPeriod(source.openPeriod);
  return {
    openBalance: money(account.balanceMinor, account.currency),
    groupOutstanding: source.groupOutstandingMinor === undefined || source.groupOutstandingMinor === null
      ? undefined
      : money(source.groupOutstandingMinor, account.currency),
    currentPeriod,
    categoryTotals: (account.categoryStatistics as unknown[] ?? []).map((entry) => {
      const statistic = asRecord(entry);
      const name = String(statistic.categoryName);
      return { categoryId: String(statistic.categoryId), categoryName: name, icon: categoryIcon(statistic.icon), total: money(statistic.netMinor, account.currency) };
    }),
    groupCategoryTotals: (account.groupCategoryStatistics as unknown[] ?? []).map((entry) => {
      const statistic = asRecord(entry);
      const name = String(statistic.categoryName);
      return { categoryId: String(statistic.categoryId), categoryName: name, icon: categoryIcon(statistic.icon), quantity: Number(statistic.quantity ?? 0), total: money(statistic.netMinor, account.currency) };
    }),
    recentBookings: (source.recentBookings as unknown[] ?? []).map((entry) => adaptBooking(entry)),
    planningEnabled: source.planningEnabled === true,
    openPlanningActionCount: Number(source.openPlanningActionCount ?? 0),
    planning: source.nextPlanningEvent ? { event: adaptPlanningEvent(source.nextPlanningEvent), actionRequired: asRecord(source.nextPlanningEvent).actionRequired === true } : undefined,
  };
}

/** Adapts provenance shared by every section of one statistics snapshot. */
function adaptStatisticsMeta(input: unknown): StatisticsMeta {
  const source = asRecord(input);
  const bucket: StatisticsBucket = source.bucket === 'WEEK' || source.bucket === 'MONTH' || source.bucket === 'YEAR' ? source.bucket : 'DAY';
  return {
    generatedAt: String(source.generatedAt ?? ''),
    timezone: String(source.timezone ?? 'UTC'),
    preset: isStatisticsRange(source.preset) ? source.preset : 'LAST_30_DAYS',
    fromInclusive: String(source.fromInclusive ?? ''),
    toExclusive: String(source.toExclusive ?? ''),
    bucket,
    privacyThresholdApplied: source.privacyThresholdApplied === true,
    currentPeriodAvailable: source.currentPeriodAvailable === true,
  };
}

/** Adapts privacy-aware category and product values without coercing hidden points to zero. */
function adaptMemberBreakdownSeries(input: unknown): MemberStatistics['topCategories']['items'][number]['series'] {
  return (Array.isArray(input) ? input : []).map((entry) => {
    const point = asRecord(entry);
    const value = point.validBookedUnits;
    return {
      periodStart: String(point.periodStart ?? ''),
      validBookedUnits: typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null,
      privacySuppressed: point.privacySuppressed === true,
      isPartial: point.isPartial === true,
    };
  });
}

/**
 * Adapts the member section of the statistics wire contract.
 *
 * @param input - Member statistics section from the group endpoint.
 * @returns Canonical anonymous member activity statistics.
 */
function adaptMemberStatistics(input: unknown): MemberStatistics {
  const source = asRecord(input);
  const memberSnapshot = asRecord(source.memberSnapshot);
  const summary = asRecord(source.summary);
  const topCategories = asRecord(source.topCategories);
  const topProducts = asRecord(source.topProducts);
  return {
    memberSnapshot: {
      regularMembers: Number(memberSnapshot.regularMembers ?? 0),
      temporaryGuests: Number(memberSnapshot.temporaryGuests ?? 0),
      asOf: String(memberSnapshot.asOf ?? ''),
    },
    summary: {
      activeParticipants: Number(summary.activeParticipants ?? 0),
      bookingCount: Number(summary.bookingCount ?? 0),
      validBookedUnits: Number(summary.validBookedUnits ?? 0),
      cancellationRate: typeof summary.cancellationRate === 'number' ? summary.cancellationRate : null,
    },
    activity: (Array.isArray(source.activity) ? source.activity : []).map((entry) => {
      const point = asRecord(entry);
      return {
        periodStart: String(point.periodStart ?? ''),
        postedUnits: Number(point.postedUnits ?? 0),
        reversedUnits: Number(point.reversedUnits ?? 0),
      };
    }),
    topCategories: {
      suppressed: topCategories.suppressed === true,
      items: (Array.isArray(topCategories.items) ? topCategories.items : []).map((entry) => {
        const item = asRecord(entry);
        return {
          categoryId: String(item.categoryId ?? ''),
          categoryName: String(item.categoryName ?? ''),
          icon: categoryIcon(item.icon),
          validBookedUnits: Number(item.validBookedUnits ?? 0),
          isOther: item.isOther === true,
          series: adaptMemberBreakdownSeries(item.series),
        };
      }),
    },
    topProducts: {
      suppressed: topProducts.suppressed === true,
      items: (Array.isArray(topProducts.items) ? topProducts.items : []).map((entry) => {
        const item = asRecord(entry);
        return {
          productId: String(item.productId ?? ''),
          productName: String(item.productName ?? ''),
          categoryId: String(item.categoryId ?? ''),
          categoryName: String(item.categoryName ?? ''),
          validBookedUnits: Number(item.validBookedUnits ?? 0),
          isOther: item.isOther === true,
          series: adaptMemberBreakdownSeries(item.series),
        };
      }),
    },
  };
}

/**
 * Adapts the finance section of the statistics wire contract without converting money
 * to floating-point values.
 *
 * @param input - Finance statistics section from the group endpoint.
 * @returns Canonical aggregate finance statistics with exact money values.
 */
function adaptFinanceStatistics(input: unknown): FinanceStatistics {
  const source = asRecord(input);
  const currency = String(source.currency || 'EUR');
  const snapshot = asRecord(source.receivableSnapshot);
  const flows = asRecord(source.flows);
  const overdue = source.overdue && typeof source.overdue === 'object' ? asRecord(source.overdue) : null;
  return {
    currency,
    receivableSnapshot: {
      asOf: String(snapshot.asOf ?? ''),
      grossReceivable: money(snapshot.grossReceivableMinor, currency),
      memberCredit: money(snapshot.memberCreditMinor, currency),
      netReceivable: money(snapshot.netReceivableMinor, currency),
      openAccountCount: Number(snapshot.openAccountCount ?? 0),
      balancedAccountCount: Number(snapshot.balancedAccountCount ?? 0),
      creditAccountCount: Number(snapshot.creditAccountCount ?? 0),
    },
    flows: {
      openingNetReceivable: money(flows.openingNetReceivableMinor, currency),
      netBookingCharges: money(flows.netBookingChargesMinor, currency),
      netPayments: money(flows.netPaymentsMinor, currency),
      netAdjustments: money(flows.netAdjustmentsMinor, currency),
      closingNetReceivable: money(flows.closingNetReceivableMinor, currency),
    },
    series: (Array.isArray(source.series) ? source.series : []).map((entry) => {
      const point = asRecord(entry);
      return {
        periodStart: String(point.periodStart ?? ''),
        netBookingCharges: money(point.netBookingChargesMinor, currency),
        netPayments: money(point.netPaymentsMinor, currency),
        netAdjustments: money(point.netAdjustmentsMinor, currency),
        closingNetReceivable: money(point.closingNetReceivableMinor, currency),
      };
    }),
    categories: (Array.isArray(source.categories) ? source.categories : []).map((entry) => {
      const item = asRecord(entry);
      return {
        categoryId: String(item.categoryId ?? ''),
        categoryName: String(item.categoryName ?? ''),
        icon: categoryIcon(item.icon),
        netBookingCharges: money(item.netBookingChargesMinor, currency),
        isOther: item.isOther === true,
      };
    }),
    overdue: overdue ? {
      amount: money(overdue.amountMinor, currency),
      accountCount: Number(overdue.accountCount ?? 0),
      periodCount: Number(overdue.periodCount ?? 0),
      asOf: String(overdue.asOf ?? ''),
    } : null,
  };
}

/**
 * Adapts the unified statistics response without weakening exact money values.
 *
 * @param input - Complete response from the group statistics endpoint.
 * @returns Canonical shared metadata plus member and finance sections.
 */
export function adaptStatisticsDashboard(input: unknown): StatisticsDashboard {
  const source = asRecord(input);
  return {
    meta: adaptStatisticsMeta(source.meta),
    members: adaptMemberStatistics(source.members),
    finance: adaptFinanceStatistics(source.finance),
  };
}

/**
 * Adapts one accounting period.
 *
 * @param input - Period wire or canonical value.
 * @returns Canonical period with nullable timestamps normalized to undefined.
 */
export function adaptPeriod(input: unknown): Period {
  const source = asRecord(input);
  return {
    id: String(source.id),
    label: String(source.label),
    status: source.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
    startsAt: String(source.startsAt),
    closedAt: typeof source.closedAt === 'string' ? source.closedAt : undefined,
    dueAt: typeof source.dueAt === 'string' ? source.dueAt : undefined,
  };
}

/**
 * Adapts an account read model into a running ledger statement.
 *
 * @param input - Account response or existing canonical ledger array.
 * @returns Newest-first ledger entries with reconstructed running balances.
 */
export function adaptLedger(input: unknown): LedgerEntry[] {
  if (Array.isArray(input)) return input.map((entry) => {
    const source = asRecord(entry);
    const attachment = paymentAttachmentSummary(source.attachment);
    const canonical = { ...source };
    delete canonical.attachment;
    return { ...canonical as unknown as LedgerEntry, ...(attachment ? { attachment } : {}) };
  });
  const source = asRecord(input);
  let runningBalance = BigInt(String(source.balanceMinor ?? 0));
  const currency = String(source.currency || 'EUR');
  return (source.recentEntries as unknown[] ?? []).map((entry) => {
    const wire = asRecord(entry);
    const attachment = paymentAttachmentSummary(wire.attachment);
    const amountMinor = BigInt(String(wire.amountMinor ?? 0));
    const balance = runningBalance;
    runningBalance -= amountMinor;
    return {
      id: String(wire.id),
      occurredAt: String(wire.createdAt),
      kind: wire.reversalOf ? 'REVERSAL' : wire.paymentId ? 'PAYMENT' : wire.bookingId ? 'BOOKING' : 'CREDIT',
      description: ledgerDescription(wire),
      amount: money(amountMinor.toString(), currency),
      balance: money(balance.toString(), currency),
      referenceId: String(wire.bookingId ?? wire.paymentId ?? wire.id),
      ...(attachment ? { attachment } : {}),
    };
  });
}

/**
 * Adapts consolidated group account balances without numeric precision loss.
 *
 * @param input - Account-summary array returned by the finance endpoint.
 * @returns Canonical account summaries with exact money values.
 */
export function adaptAccountSummaries(input: unknown): AccountSummary[] {
  return (input as unknown[] ?? []).map((entry) => {
    const source = asRecord(entry);
    const sourceBalance = source.balance && typeof source.balance === 'object' ? asRecord(source.balance) : undefined;
    const currency = String(source.currency || sourceBalance?.currency || 'EUR');
    return {
      membershipId: String(source.membershipId),
      displayName: String(source.displayName),
      avatarUrl: typeof source.avatarUrl === 'string' && source.avatarUrl ? source.avatarUrl : undefined,
      isTemporaryGuest: source.isTemporaryGuest === true,
      status: source.status === 'ARCHIVED' || source.status === 'DELETED' ? source.status : 'ACTIVE',
      currency,
      balance: sourceBalance ? money(sourceBalance.minorUnits, sourceBalance.currency || currency) : money(source.balanceMinor, currency),
    };
  });
}

/**
 * Adapts a payment with member display data.
 *
 * @param input - Payment wire or canonical value.
 * @returns Canonical payment.
 */
export function adaptPayment(input: unknown): Payment {
  const source = asRecord(input);
  const sourceAmount = source.amount && typeof source.amount === 'object' ? asRecord(source.amount) : undefined;
  const attachment = paymentAttachmentSummary(source.attachment);
  const memberName = String(source.memberName ?? i18n.t('common.member'));
  const memberStatus = source.membershipStatus === 'ARCHIVED' || source.membershipStatus === 'DELETED' ? source.membershipStatus : 'ACTIVE';
  return {
    id: String(source.id),
    membershipId: String(source.membershipId),
    memberName,
    membershipStatus: memberStatus,
    memberAvatarUrl: typeof source.memberAvatarUrl === 'string' && source.memberAvatarUrl ? source.memberAvatarUrl : undefined,
    actorMembershipId: String(source.actorMembershipId ?? source.membershipId),
    actorName: String(source.actorDisplayName ?? source.actorName ?? memberName),
    actorStatus: source.actorMembershipStatus === 'ARCHIVED' || source.actorMembershipStatus === 'DELETED'
      ? source.actorMembershipStatus
      : source.actorStatus === 'ARCHIVED' || source.actorStatus === 'DELETED' ? source.actorStatus : memberStatus,
    actorAvatarUrl: typeof source.actorAvatarUrl === 'string' && source.actorAvatarUrl ? source.actorAvatarUrl : undefined,
    amount: sourceAmount ? money(sourceAmount.minorUnits, sourceAmount.currency) : money(source.amountMinor, source.currency),
    receivedAt: String(source.receivedAt),
    createdAt: typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : undefined,
    method: source.method as Payment['method'],
    methodLabel: historicalPaymentMethodLabel(
      String(source.method),
      typeof source.methodLabel === 'string' && source.methodLabel ? source.methodLabel : undefined,
    ),
    reference: typeof source.reference === 'string' && source.reference ? source.reference : undefined,
    note: typeof source.note === 'string' && source.note ? source.note : undefined,
    status: source.status === 'REVERSED' || source.reversedAt ? 'REVERSED' : 'POSTED',
    ...(attachment ? { attachment } : {}),
  };
}

/**
 * Adapts an immutable statement into the settlement UI model.
 *
 * @param input - Statement wire or canonical settlement value.
 * @param periods - Periods used to resolve labels and due dates.
 * @returns Canonical settlement.
 */
export function adaptSettlement(input: unknown, periods: Period[]): Settlement {
  const source = asRecord(input);
  const membershipStatus = source.membershipStatus === 'ARCHIVED' || source.membershipStatus === 'DELETED' ? source.membershipStatus : 'ACTIVE';
  if ('periodLabel' in source) return {
    ...source as unknown as Settlement,
    email: typeof source.email === 'string' ? source.email : null,
    membershipStatus,
  };
  const period = periods.find((entry) => entry.id === source.periodId);
  const obligationMinor = (BigInt(String(source.chargesMinor ?? 0)) + BigInt(String(source.adjustmentsProvidedMinor ?? 0))).toString();
  const settledMinor = (BigInt(String(source.paymentsAllocatedMinor ?? 0)) + BigInt(String(source.adjustmentsAppliedMinor ?? 0))).toString();
  return {
    id: String(source.id),
    periodId: String(source.periodId),
    periodLabel: period?.label ?? i18n.t('common.settlementFallback'),
    membershipId: String(source.membershipId),
    membershipStatus,
    memberName: String(source.displayName ?? i18n.t('common.member')),
    email: typeof source.email === 'string' ? source.email : null,
    amount: money(obligationMinor, source.currency),
    paidAmount: money(settledMinor, source.currency),
    openAmount: money(source.amountDueMinor, source.currency),
    dueAt: period?.dueAt ?? '',
    status: source.status as Settlement['status'],
  };
}

/**
 * Adapts an in-app notification.
 *
 * @param input - Notification wire or canonical value.
 * @returns Canonical notification.
 */
export function adaptNotification(input: unknown): Notification {
  const source = asRecord(input);
  const type = String(source.type ?? '').toUpperCase();
  const canonicalKind = typeof source.kind === 'string' ? source.kind : undefined;
  const kind: Notification['kind'] = type.includes('PLANNING') ? 'PLANNING' : type.includes('PAYMENT') ? 'PAYMENT' : type.includes('SETTLEMENT') || type.includes('PERIOD') ? 'SETTLEMENT' : type.includes('BOOK') || type.includes('PENAL') ? 'BOOKING' : 'SYSTEM';
  const eventType: Notification['eventType'] = NOTIFICATION_EVENT_TYPES.includes(type as Notification['eventType']) ? type as Notification['eventType'] : 'SYSTEM';
  const rawContext = source.context && typeof source.context === 'object' ? asRecord(source.context) : {};
  const context: Notification['context'] = {
    actorName: typeof rawContext.actorName === 'string' ? rawContext.actorName : undefined,
    itemName: typeof rawContext.itemName === 'string' ? rawContext.itemName : undefined,
    quantity: typeof rawContext.quantity === 'number' ? rawContext.quantity : undefined,
    amountMinor: typeof rawContext.amountMinor === 'string' || typeof rawContext.amountMinor === 'number' ? String(rawContext.amountMinor) : undefined,
    currency: typeof rawContext.currency === 'string' ? rawContext.currency : undefined,
    periodLabel: typeof rawContext.periodLabel === 'string' ? rawContext.periodLabel : undefined,
    dueAt: typeof rawContext.dueAt === 'string' ? rawContext.dueAt : undefined,
    exportId: typeof rawContext.exportId === 'string' ? rawContext.exportId : undefined,
    exportScope: rawContext.exportScope === 'GROUP' || rawContext.exportScope === 'PERSONAL' ? rawContext.exportScope : undefined,
    planningEventId: typeof rawContext.planningEventId === 'string' ? rawContext.planningEventId : undefined,
  };
  const localizedCopy: Record<Notification['kind'], { title: string; message: string }> = {
    PAYMENT: { title: i18n.t('notifications.fallback.paymentTitle'), message: i18n.t('notifications.fallback.paymentMessage') },
    SETTLEMENT: { title: i18n.t('notifications.fallback.settlementTitle'), message: i18n.t('notifications.fallback.settlementMessage') },
    BOOKING: { title: i18n.t('notifications.fallback.bookingTitle'), message: i18n.t('notifications.fallback.bookingMessage') },
    PLANNING: { title: i18n.t('notifications.fallback.planningTitle'), message: i18n.t('notifications.fallback.planningMessage') },
    SYSTEM: { title: i18n.t('notifications.fallback.systemTitle'), message: i18n.t('notifications.fallback.systemMessage') },
  };
  const amount = context.amountMinor !== undefined && context.currency ? formatMoney({ minorUnits: context.amountMinor, currency: context.currency }) : undefined;
  let copy = localizedCopy[kind];
  if (eventType === 'BOOKING_ASSIGNED' && context.actorName && context.itemName && context.quantity && amount) {
    copy = { title: i18n.t('notifications.events.bookingAssignedTitle'), message: i18n.t('notifications.events.bookingAssignedMessage', { actor: context.actorName, quantity: context.quantity, item: context.itemName, amount }) };
  } else if (eventType === 'BOOKING_REVERSED' && context.actorName && context.itemName && context.quantity && amount) {
    copy = { title: i18n.t('notifications.events.bookingReversedTitle'), message: i18n.t('notifications.events.bookingReversedMessage', { actor: context.actorName, quantity: context.quantity, item: context.itemName, amount }) };
  } else if (eventType === 'PAYMENT_RECORDED' && context.actorName && amount) {
    copy = { title: i18n.t('notifications.events.paymentRecordedTitle'), message: i18n.t('notifications.events.paymentRecordedMessage', { actor: context.actorName, amount }) };
  } else if (eventType === 'PAYMENT_REVERSED' && context.actorName && amount) {
    copy = { title: i18n.t('notifications.events.paymentReversedTitle'), message: i18n.t('notifications.events.paymentReversedMessage', { actor: context.actorName, amount }) };
  } else if (eventType === 'SETTLEMENT_CREATED' && context.periodLabel && context.amountMinor !== undefined && context.currency) {
    const rawAmount = BigInt(context.amountMinor);
    const settlementAmount = formatMoney({ minorUnits: (rawAmount < 0n ? -rawAmount : rawAmount).toString(), currency: context.currency });
    const message = rawAmount > 0n
      ? i18n.t('notifications.events.settlementDueMessage', { period: context.periodLabel, amount: settlementAmount, dueAt: context.dueAt ? formatGermanDate(context.dueAt) : '–' })
      : rawAmount < 0n
        ? i18n.t('notifications.events.settlementCreditMessage', { period: context.periodLabel, amount: settlementAmount })
        : i18n.t('notifications.events.settlementPaidMessage', { period: context.periodLabel });
    copy = { title: i18n.t('notifications.events.settlementTitle'), message };
  } else if (eventType === 'DATA_EXPORT_READY') {
    copy = { title: i18n.t('notifications.events.dataExportReadyTitle'), message: i18n.t('notifications.events.dataExportReadyMessage') };
  } else if (eventType === 'DATA_EXPORT_FAILED') {
    copy = { title: i18n.t('notifications.events.dataExportFailedTitle'), message: i18n.t('notifications.events.dataExportFailedMessage') };
  } else if ('message' in source && typeof source.title === 'string' && typeof source.message === 'string') {
    copy = { title: source.title, message: source.message };
  }
  return { id: String(source.id), ...copy, createdAt: String(source.createdAt), readAt: typeof source.readAt === 'string' ? source.readAt : undefined, kind: (canonicalKind as Notification['kind'] | undefined) ?? kind, eventType, context };
}

/**
 * Adapts an append-only audit event and resolves its actor when possible.
 *
 * @param input - Audit wire or canonical value.
 * @param members - Group directory used for actor names.
 * @returns Canonical audit entry.
 */
export function adaptAuditEntry(input: unknown, members: Membership[]): AuditEntry {
  const source = asRecord(input);
  if ('actorName' in source) return {
    ...(source as unknown as AuditEntry),
    resourceType: String(source.resourceType ?? String(source.subject ?? '').split(' · ')[0]),
  };
  const metadata = source.metadata && typeof source.metadata === 'object' ? JSON.stringify(source.metadata) : '';
  return {
    id: String(source.id),
    occurredAt: String(source.occurredAt),
    actorName: memberName(String(source.actorMembershipId ?? ''), members, i18n.t('common.system')),
    action: String(source.action),
    resourceType: String(source.resourceType ?? ''),
    subject: `${String(source.resourceType ?? '')}${source.resourceId ? ` · ${String(source.resourceId)}` : ''}`,
    details: metadata,
  };
}
