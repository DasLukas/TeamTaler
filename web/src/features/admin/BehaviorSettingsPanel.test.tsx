import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupNotificationSettings, GroupSettings, Role, Session } from '@/api/types';
import { ActiveGroupContext } from '@/app/active-group-context';
import i18n from '@/i18n';
import { BehaviorSettingsPanel } from './BehaviorSettingsPanel';

const apiMock = vi.hoisted(() => ({
  getGroupSettings: vi.fn(),
  getGroupNotificationSettings: vi.fn(),
  getPlanningSettings: vi.fn(),
  getRoles: vi.fn(),
  removeGroupLogo: vi.fn(),
  updateGroupSettings: vi.fn(),
  updateGroupNotificationSettings: vi.fn(),
  updatePlanningSettings: vi.fn(),
  updateGroupName: vi.fn(),
  uploadGroupLogo: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: apiMock }));

const session: Session = {
  user: { id: 'user-a', displayName: 'Admin', email: 'admin@example.test' },
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', defaultTheme: 'TEAMTALER', membership: { id: 'member-a', roles: ['ADMIN', 'MEMBER'], groupPermissions: [], effectiveGrants: [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }, { permission: 'MEMBER_MANAGEMENT', scope: { type: 'GROUP' } }, { permission: 'ROLE_MANAGEMENT', scope: { type: 'GROUP' } }, { permission: 'FINANCE_MANAGEMENT', scope: { type: 'GROUP' } }], themeOverride: null } }],
  activeGroupId: 'group-a',
  defaultGroupId: null,
  colorMode: 'SYSTEM',
  systemRoles: [],
};

function renderPanel(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  queryClient.setQueryData(['session'], session);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ActiveGroupContext.Provider value={{ session, activeGroup: session.groups[0], activeGroupId: 'group-a', setActiveGroupId: vi.fn() }}>
        {children}
      </ActiveGroupContext.Provider>
    </QueryClientProvider>
  );
  render(<BehaviorSettingsPanel />, { wrapper });
  return queryClient;
}

describe('BehaviorSettingsPanel', () => {
  const roles: Role[] = [
    { id: 'role-admin', presetKey: 'GROUP_ADMINISTRATOR', name: 'Group administrator', grants: [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }, { permission: 'MEMBER_MANAGEMENT', scope: { type: 'GROUP' } }], version: 1, memberCount: 1, pendingInvitationCount: 0 },
    { id: 'role-member', name: 'Member', grants: [], version: 1, memberCount: 1, pendingInvitationCount: 0 },
    { id: 'role-finance', name: 'Finance', grants: [{ permission: 'FINANCE_MANAGEMENT', scope: { type: 'GROUP' } }], version: 1, memberCount: 0, pendingInvitationCount: 0 },
  ];
  const settings: GroupSettings = {
    defaultTheme: 'TEAMTALER',
    settlementsEnabled: false,
    notificationEmailsEnabled: false,
    notificationEmailDeliveryAvailable: true,
    defaultRoleId: 'role-member',
    ownBookingReasonMode: 'OFF',
    foreignBookingReasonMode: 'REQUIRED',
    ownPaymentReasonMode: 'REQUIRED',
    otherPaymentReasonMode: 'OPTIONAL',
    foreignBookingReasonRequired: true,
    ownPaymentReasonRequired: true,
    otherPaymentReasonRequired: false,
    paymentMethods: [
      { id: 'BANK_TRANSFER', label: 'Banküberweisung', attachmentMode: 'OFF', paymentTarget: null },
      { id: 'CASH', label: 'Bar', attachmentMode: 'OFF', paymentTarget: null },
      { id: 'PAYPAL', label: 'PayPal', attachmentMode: 'OFF', paymentTarget: null },
      { id: 'OTHER', label: 'Sonstige', attachmentMode: 'OFF', paymentTarget: null },
    ],
    bookingReasons: [],
    paymentReasons: [],
  };
  const notificationSettings: GroupNotificationSettings = {
    version: 1,
    timezone: 'Europe/Berlin',
    dueSoonLeadDays: 3,
    overdueRepeatDays: 7,
    channels: { email: true, push: false },
    events: [{
      eventType: 'BOOKING_ASSIGNED',
      category: 'booking',
      name: 'Booking assigned',
      description: 'A booking was assigned.',
      supportedChannels: ['EMAIL', 'PUSH'],
      enabled: true,
    }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    session.groups[0]!.currency = 'EUR';
    session.groups[0]!.membership!.effectiveGrants = [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }, { permission: 'MEMBER_MANAGEMENT', scope: { type: 'GROUP' } }, { permission: 'ROLE_MANAGEMENT', scope: { type: 'GROUP' } }, { permission: 'FINANCE_MANAGEMENT', scope: { type: 'GROUP' } }];
    apiMock.getGroupSettings.mockResolvedValue(settings);
    apiMock.getGroupNotificationSettings.mockResolvedValue(notificationSettings);
    apiMock.getPlanningSettings.mockResolvedValue({ enabled: false, version: 1, timeZone: 'Europe/Berlin' });
    apiMock.getRoles.mockResolvedValue(roles);
  });

  it('uses the planning toggle as the only activation control', async () => {
    renderPanel();

    const planningRegion = await screen.findByRole('region', { name: i18n.t('behaviorSettings.planning.title') });
    expect(within(planningRegion).getByRole('switch', { name: i18n.t('behaviorSettings.planning.toggle') })).toBeVisible();
    expect(within(planningRegion).queryByRole('button')).not.toBeInTheDocument();
  });

  it('refreshes member notification preferences when planning is disabled', async () => {
    const user = userEvent.setup();
    apiMock.getPlanningSettings.mockResolvedValue({ enabled: true, version: 1, timeZone: 'Europe/Berlin' });
    apiMock.updatePlanningSettings.mockResolvedValue({ enabled: false, version: 2, timeZone: 'Europe/Berlin' });
    const queryClient = renderPanel();
    const removeQueries = vi.spyOn(queryClient, 'removeQueries');

    const planningRegion = await screen.findByRole('region', { name: i18n.t('behaviorSettings.planning.title') });
    await user.click(within(planningRegion).getByRole('switch', { name: i18n.t('behaviorSettings.planning.toggle') }));
    await user.click(await screen.findByRole('button', { name: i18n.t('behaviorSettings.planning.disable') }));

    await waitFor(() => expect(apiMock.updatePlanningSettings).toHaveBeenCalledWith('group-a', false, 1));
    expect(removeQueries).toHaveBeenCalledWith({ queryKey: ['notification-preferences', 'group-a'] });
  });

  it('removes the legacy booking-visibility switch from the new settings UI', async () => {
    renderPanel();
    expect(await screen.findByRole('switch', { name: i18n.t('behaviorSettings.notifications.enableEvent', { event: i18n.t('notifications.preferences.events.bookingAssigned.label') }) })).toBeVisible();
    expect(screen.queryByRole('switch', { name: i18n.t('behaviorSettings.bookingVisibilityToggle') })).not.toBeInTheDocument();
  });

  it('places the membership default inside general group settings', async () => {
    renderPanel();

    expect(screen.queryByRole('heading', { level: 2, name: i18n.t('behaviorSettings.title') })).not.toBeInTheDocument();
    expect(await screen.findByRole('region', { name: i18n.t('behaviorSettings.groupSectionTitle') })).toBeVisible();
    expect(await screen.findByRole('region', { name: i18n.t('behaviorSettings.notifications.title') })).toBeVisible();
    expect(screen.queryByRole('region', { name: i18n.t('behaviorSettings.rolesMembersSectionTitle') })).not.toBeInTheDocument();
    expect(await screen.findByRole('region', { name: i18n.t('behaviorSettings.defaultRoleTitle') })).toBeVisible();
    expect(screen.getByLabelText(i18n.t('behaviorSettings.defaultRoleFieldLabel'))).toHaveValue('role-member');
    expect(screen.getByLabelText(i18n.t('groupSettings.nameLabel'))).toHaveValue('Group A');
    expect(screen.getByLabelText(i18n.t('groupSettings.imageLabel'))).toBeVisible();
  });

  it('renders a dedicated finance section and persists the settlement feature flag', async () => {
    const user = userEvent.setup();
    apiMock.updateGroupSettings.mockResolvedValue({ ...settings, settlementsEnabled: true });
    const queryClient = renderPanel();
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    const removeQueries = vi.spyOn(queryClient, 'removeQueries');

    expect(await screen.findByRole('region', { name: i18n.t('behaviorSettings.financeSectionTitle') })).toBeVisible();
    const toggle = screen.getByRole('switch', { name: i18n.t('behaviorSettings.settlementsToggle') });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: i18n.t('behaviorSettings.save') }));

    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalledWith('group-a', { settlementsEnabled: true }));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['booking-context', 'group-a'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['transaction-settings', 'group-a'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['dashboard', 'group-a'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['periods', 'group-a'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['settlements', 'group-a'] });
    expect(removeQueries).toHaveBeenCalledWith({ queryKey: ['notification-preferences', 'group-a'] });
  });

  it('confirms before staging settlement deactivation', async () => {
    const user = userEvent.setup();
    apiMock.getGroupSettings.mockResolvedValue({ ...settings, settlementsEnabled: true });
    apiMock.updateGroupSettings.mockResolvedValue({ ...settings, settlementsEnabled: false });
    renderPanel();

    const toggle = await screen.findByRole('switch', { name: i18n.t('behaviorSettings.settlementsToggle') });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    const dialog = screen.getByRole('dialog', { name: i18n.t('behaviorSettings.settlementsDisableTitle') });
    expect(dialog).toBeVisible();
    expect(toggle).toBeChecked();
    expect(apiMock.updateGroupSettings).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: i18n.t('common.cancel') }));
    expect(screen.queryByRole('dialog', { name: i18n.t('behaviorSettings.settlementsDisableTitle') })).not.toBeInTheDocument();
    expect(toggle).toBeChecked();

    await user.click(toggle);
    await user.click(within(screen.getByRole('dialog', { name: i18n.t('behaviorSettings.settlementsDisableTitle') })).getByRole('button', { name: i18n.t('behaviorSettings.settlementsDisable') }));
    expect(toggle).not.toBeChecked();

    await user.click(screen.getByRole('button', { name: i18n.t('behaviorSettings.save') }));
    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalledWith('group-a', { settlementsEnabled: false }));
  });

  it('persists each reason context through an accessible three-state control', async () => {
    const user = userEvent.setup();
    apiMock.updateGroupSettings.mockResolvedValue({ ...settings, ownBookingReasonMode: 'OPTIONAL' });
    renderPanel();

    const ownBookingGroup = await screen.findByRole('group', { name: i18n.t('behaviorSettings.ownBookingReason') });
    expect(within(ownBookingGroup).getByRole('radio', { name: i18n.t('behaviorSettings.reasonModeOff') })).toBeChecked();
    await user.click(within(ownBookingGroup).getByRole('radio', { name: i18n.t('behaviorSettings.reasonModeOptional') }));
    await user.click(screen.getByRole('button', { name: i18n.t('behaviorSettings.save') }));

    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalledWith('group-a', { ownBookingReasonMode: 'OPTIONAL' }));
  });

  it('saves the group event policy independently from channel availability', async () => {
    const user = userEvent.setup();
    apiMock.updateGroupNotificationSettings.mockResolvedValue({ ...notificationSettings, events: [{ ...notificationSettings.events[0], enabled: false }] });
    renderPanel();
    const toggle = await screen.findByRole('switch', { name: i18n.t('behaviorSettings.notifications.enableEvent', { event: i18n.t('notifications.preferences.events.bookingAssigned.label') }) });

    await user.click(toggle);
    await user.click(within(screen.getByRole('region', { name: i18n.t('behaviorSettings.notifications.title') })).getByRole('button', { name: i18n.t('common.save') }));

    await waitFor(() => expect(apiMock.updateGroupNotificationSettings).toHaveBeenCalledWith('group-a', {
      version: 1,
      timezone: 'Europe/Berlin',
      dueSoonLeadDays: 3,
      overdueRepeatDays: 7,
      events: [{ eventType: 'BOOKING_ASSIGNED', enabled: false }],
    }));
  });

  it('groups notification events by their server-owned topic metadata', async () => {
    apiMock.getGroupNotificationSettings.mockResolvedValue({
      ...notificationSettings,
      events: [
        notificationSettings.events[0],
        { eventType: 'PAYMENT_RECORDED', category: 'PAYMENTS', name: 'Payment recorded', description: 'A payment was recorded.', supportedChannels: ['EMAIL', 'PUSH'], enabled: true },
        { eventType: 'PLANNING_EVENT_PUBLISHED', category: 'PLANNING', name: 'Planning event published', description: 'A planning event was published.', supportedChannels: ['EMAIL', 'PUSH'], enabled: true },
        { eventType: 'SETTLEMENT_CREATED', category: 'SETTLEMENTS', name: 'Settlement created', description: 'A settlement was created.', supportedChannels: ['EMAIL', 'PUSH'], enabled: true },
      ],
    });
    renderPanel();

    const notificationRegion = await screen.findByRole('region', { name: i18n.t('behaviorSettings.notifications.title') });
    expect(within(notificationRegion).getAllByRole('heading', { level: 5 }).map((heading) => heading.textContent)).toEqual([
      i18n.t('behaviorSettings.notifications.categories.BOOKINGS'),
      i18n.t('behaviorSettings.notifications.categories.PAYMENTS'),
      i18n.t('behaviorSettings.notifications.categories.PLANNING'),
      i18n.t('behaviorSettings.notifications.categories.SETTLEMENTS'),
    ]);
    const planningCategory = i18n.t('behaviorSettings.notifications.categories.PLANNING');
    expect(within(within(notificationRegion).getByRole('region', { name: i18n.t('behaviorSettings.notifications.categoryLabel', { category: planningCategory }) })).getByRole('switch', {
      name: i18n.t('behaviorSettings.notifications.enableEvent', { event: i18n.t('notifications.preferences.events.planningPublished.label') }),
    })).toBeVisible();
  });

  it('keeps event policy editable while unavailable channels are explained', async () => {
    apiMock.getGroupNotificationSettings.mockResolvedValue({ ...notificationSettings, channels: { email: false, push: false } });
    renderPanel();

    expect(await screen.findByRole('switch', { name: i18n.t('behaviorSettings.notifications.enableEvent', { event: i18n.t('notifications.preferences.events.bookingAssigned.label') }) })).toBeEnabled();
    expect(screen.getByText(i18n.t('behaviorSettings.notifications.emailUnavailable'))).toBeVisible();
    expect(screen.getByText(i18n.t('behaviorSettings.notifications.pushUnavailable'))).toBeVisible();
  });

  it('shows a localized error when settings cannot be loaded', async () => {
    apiMock.getGroupSettings.mockRejectedValue(new Error('denied'));
    renderPanel();
    expect(await screen.findByText(i18n.t('behaviorSettings.loadError'))).toBeVisible();
  });

  it('persists the membership default from general settings', async () => {
    const user = userEvent.setup();
    apiMock.updateGroupSettings.mockResolvedValue({ ...settings, defaultRoleId: 'role-finance' });
    renderPanel();

    const defaultRoleRegion = await screen.findByRole('region', { name: i18n.t('behaviorSettings.defaultRoleTitle') });
    await user.selectOptions(within(defaultRoleRegion).getByLabelText(i18n.t('behaviorSettings.defaultRoleFieldLabel')), 'role-finance');
    await user.click(within(defaultRoleRegion).getByRole('button', { name: i18n.t('common.save') }));

    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalledWith('group-a', { defaultRoleId: 'role-finance' }));
  });

  it('persists the group default theme only after explicit save and refreshes the session projection', async () => {
    const user = userEvent.setup();
    apiMock.updateGroupSettings.mockResolvedValue({ ...settings, defaultTheme: 'FIRE' });
    const queryClient = renderPanel();

    const defaultThemeRegion = await screen.findByRole('region', { name: i18n.t('behaviorSettings.defaultThemeTitle') });
    await user.click(within(defaultThemeRegion).getByRole('radio', { name: i18n.t('appearance.themes.FIRE') }));
    expect(apiMock.updateGroupSettings).not.toHaveBeenCalled();
    await user.click(within(defaultThemeRegion).getByRole('button', { name: i18n.t('common.save') }));

    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalledWith('group-a', { defaultTheme: 'FIRE' }));
    expect(queryClient.getQueryData<Session>(['session'])?.groups[0]?.defaultTheme).toBe('FIRE');
  });

  it('hides the membership default from a pure member manager', async () => {
    session.groups[0]!.membership!.effectiveGrants = [{ permission: 'MEMBER_MANAGEMENT', scope: { type: 'GROUP' } }];
    renderPanel();

    await waitFor(() => expect(apiMock.getGroupSettings).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: i18n.t('behaviorSettings.defaultRoleTitle') })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(i18n.t('groupSettings.nameLabel'))).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: i18n.t('behaviorSettings.notificationEmailToggle') })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: i18n.t('behaviorSettings.financeSectionTitle') })).not.toBeInTheDocument();
    expect(apiMock.getRoles).not.toHaveBeenCalled();
  });

  it('shows group, finance, and booking settings to a pure group administrator', async () => {
    session.groups[0]!.membership!.effectiveGrants = [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }];
    renderPanel();

    expect(await screen.findByLabelText(i18n.t('groupSettings.nameLabel'))).toBeVisible();
    expect(await screen.findByRole('region', { name: i18n.t('behaviorSettings.defaultRoleTitle') })).toBeVisible();
    expect(screen.getByRole('region', { name: i18n.t('behaviorSettings.financeSectionTitle') })).toBeVisible();
    expect(screen.getByRole('region', { name: i18n.t('behaviorSettings.bookingTitle') })).toBeVisible();
    expect(apiMock.getRoles).toHaveBeenCalled();
  });

  it('shows only finance and booking settings to a pure finance manager', async () => {
    session.groups[0]!.membership!.effectiveGrants = [{ permission: 'FINANCE_MANAGEMENT', scope: { type: 'GROUP' } }];
    renderPanel();

    expect(await screen.findByRole('region', { name: i18n.t('behaviorSettings.financeSectionTitle') })).toBeVisible();
    expect(await screen.findByRole('region', { name: i18n.t('behaviorSettings.bookingTitle') })).toBeVisible();
    expect(screen.queryByLabelText(i18n.t('groupSettings.nameLabel'))).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: i18n.t('behaviorSettings.defaultRoleTitle') })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: i18n.t('behaviorSettings.notificationEmailToggle') })).not.toBeInTheDocument();
    expect(apiMock.getRoles).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: i18n.t('behaviorSettings.save') })).toBeVisible();
  });

  it('shows only the membership default to a pure role manager', async () => {
    session.groups[0]!.membership!.effectiveGrants = [{ permission: 'ROLE_MANAGEMENT', scope: { type: 'GROUP' } }];
    renderPanel();

    expect(await screen.findByRole('region', { name: i18n.t('behaviorSettings.defaultRoleTitle') })).toBeVisible();
    expect(screen.queryByLabelText(i18n.t('groupSettings.nameLabel'))).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: i18n.t('behaviorSettings.notificationEmailToggle') })).not.toBeInTheDocument();
    expect(apiMock.getRoles).toHaveBeenCalled();
  });

  it('renders compact icon-only add controls with accessible names', async () => {
    renderPanel();

    const paymentMethodButton = await screen.findByRole('button', { name: i18n.t('behaviorSettings.addPaymentMethod') });
    const reasonButtons = screen.getAllByRole('button', { name: /Grund hinzufügen/ });
    expect(paymentMethodButton).toHaveTextContent('');
    expect(reasonButtons).toHaveLength(2);
    reasonButtons.forEach((button) => expect(button).toHaveTextContent(''));
  });

  it('edits, reorders, adds, and removes configured payment methods while retaining one', async () => {
    const user = userEvent.setup();
    apiMock.updateGroupSettings.mockImplementation(async (_groupId: string, update: Partial<GroupSettings>) => ({ ...settings, ...update }));
    renderPanel();

    const cash = await screen.findByDisplayValue('Bar');
    await user.clear(cash);
    await user.type(cash, 'Kasse');
    await user.click(screen.getByRole('button', { name: i18n.t('behaviorSettings.moveUp', { name: 'PayPal' }) }));
    await user.click(screen.getByRole('button', { name: i18n.t('behaviorSettings.removeOption', { name: 'Sonstige' }) }));
    await user.type(screen.getByRole('textbox', { name: i18n.t('behaviorSettings.addPaymentMethod') }), 'Karte');
    await user.click(screen.getByRole('button', { name: i18n.t('behaviorSettings.addPaymentMethod') }));
    await user.click(screen.getByRole('button', { name: i18n.t('behaviorSettings.save') }));

    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalledWith('group-a', {
      paymentMethods: [
        { id: 'BANK_TRANSFER', label: 'Banküberweisung', attachmentMode: 'OFF', paymentTarget: null },
        { id: 'PAYPAL', label: 'PayPal', attachmentMode: 'OFF', paymentTarget: null },
        { id: 'CASH', label: 'Kasse', attachmentMode: 'OFF', paymentTarget: null },
        expect.objectContaining({ label: 'Karte', attachmentMode: 'OFF', paymentTarget: null }),
      ],
    }));
  });

  it('persists the receipt policy per payment method', async () => {
    const user = userEvent.setup();
    renderPanel();

    const receiptPolicy = await screen.findByRole('combobox', { name: `${i18n.t('behaviorSettings.attachmentModeLabel')}: Bar` });
    expect(screen.getByText(i18n.t('behaviorSettings.attachmentModeDescription'))).toBeVisible();
    await user.click(receiptPolicy);
    const modeOptions = [
      screen.getByRole('option', { name: i18n.t('behaviorSettings.attachmentModeOff') }),
      screen.getByRole('option', { name: i18n.t('behaviorSettings.attachmentModeOptional') }),
      screen.getByRole('option', { name: i18n.t('behaviorSettings.attachmentModeRequired') }),
    ];
    modeOptions.forEach((option) => expect(option.querySelector('svg')).toBeInTheDocument());
    await user.click(modeOptions[2]);
    await user.click(screen.getByRole('button', { name: i18n.t('behaviorSettings.save') }));

    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalledWith('group-a', {
      paymentMethods: expect.arrayContaining([{ id: 'CASH', label: 'Bar', attachmentMode: 'REQUIRED', paymentTarget: null }]),
    }));
  });

  it('normalizes and persists a complete PayPal.Me link as a handle', async () => {
    const user = userEvent.setup();
    apiMock.updateGroupSettings.mockImplementation(async (_groupId: string, update: Partial<GroupSettings>) => ({ ...settings, ...update }));
    renderPanel();

    const targets = await screen.findAllByLabelText(i18n.t('behaviorSettings.paymentTargetLabel'));
    await user.selectOptions(targets[2], 'PAYPAL_ME');
    const handle = screen.getByLabelText(i18n.t('behaviorSettings.paypalMeHandle'));
    await user.type(handle, 'https://paypal.me/TeamTaler42');
    expect(screen.getByRole('button', { name: i18n.t('behaviorSettings.save') })).toBeEnabled();
    await user.tab();
    expect(handle).toHaveValue('TeamTaler42');
    expect(screen.getByRole('link', { name: 'https://paypal.me/TeamTaler42' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: i18n.t('behaviorSettings.save') }));

    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalledWith('group-a', {
      paymentMethods: expect.arrayContaining([
        expect.objectContaining({ id: 'PAYPAL', paymentTarget: { type: 'PAYPAL_ME', paypalMeHandle: 'TeamTaler42' } }),
      ]),
    }));
  });

  it('validates and persists normalized SEPA account data for EUR groups', async () => {
    const user = userEvent.setup();
    apiMock.updateGroupSettings.mockImplementation(async (_groupId: string, update: Partial<GroupSettings>) => ({ ...settings, ...update }));
    renderPanel();

    const targets = await screen.findAllByLabelText(i18n.t('behaviorSettings.paymentTargetLabel'));
    await user.selectOptions(targets[0], 'SEPA_TRANSFER');
    const save = screen.getByRole('button', { name: i18n.t('behaviorSettings.save') });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText(i18n.t('behaviorSettings.sepaRecipient')), 'TeamTaler Club');
    await user.type(screen.getByLabelText(i18n.t('behaviorSettings.sepaIban')), 'de89 3704 0044 0532 0130 00');
    await user.type(screen.getByLabelText(i18n.t('behaviorSettings.sepaBic')), 'cobadeffxxx');
    await user.tab();
    expect(screen.getByLabelText(i18n.t('behaviorSettings.sepaIban'))).toHaveValue('DE89370400440532013000');
    expect(screen.getByLabelText(i18n.t('behaviorSettings.sepaBic'))).toHaveValue('COBADEFFXXX');
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalledWith('group-a', {
      paymentMethods: expect.arrayContaining([
        expect.objectContaining({ id: 'BANK_TRANSFER', paymentTarget: { type: 'SEPA_TRANSFER', recipientName: 'TeamTaler Club', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' } }),
      ]),
    }));
  });

  it('omits SEPA configuration outside EUR groups and lets finance managers save', async () => {
    const user = userEvent.setup();
    session.groups[0]!.currency = 'USD';
    session.groups[0]!.membership!.effectiveGrants = [{ permission: 'FINANCE_MANAGEMENT', scope: { type: 'GROUP' } }];
    apiMock.updateGroupSettings.mockImplementation(async (_groupId: string, update: Partial<GroupSettings>) => ({ ...settings, ...update }));
    renderPanel();

    await screen.findByRole('region', { name: i18n.t('behaviorSettings.bookingTitle') });
    expect(screen.queryByRole('option', { name: i18n.t('behaviorSettings.paymentTargetSepa') })).not.toBeInTheDocument();
    const cash = screen.getByDisplayValue('Bar');
    await user.clear(cash);
    await user.type(cash, 'Kasse');
    await user.click(screen.getByRole('button', { name: i18n.t('behaviorSettings.save') }));
    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalledWith('group-a', {
      paymentMethods: expect.arrayContaining([expect.objectContaining({ id: 'CASH', label: 'Kasse' })]),
    }));
  });
});
