import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupSettings, Role, Session } from '@/api/types';
import { ActiveGroupContext } from '@/app/active-group-context';
import i18n from '@/i18n';
import { BehaviorSettingsPanel } from './BehaviorSettingsPanel';

const apiMock = vi.hoisted(() => ({
  getGroupSettings: vi.fn(),
  getRoles: vi.fn(),
  removeGroupLogo: vi.fn(),
  updateGroupSettings: vi.fn(),
  updateGroupName: vi.fn(),
  uploadGroupLogo: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: apiMock }));

const session: Session = {
  user: { id: 'user-a', displayName: 'Admin', email: 'admin@example.test' },
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: 'member-a', roles: ['ADMIN', 'MEMBER'], groupPermissions: [], effectiveGrants: [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }, { permission: 'MEMBER_MANAGEMENT', scope: { type: 'GROUP' } }] } }],
  activeGroupId: 'group-a',
  defaultGroupId: null,
  systemRoles: [],
};

function renderPanel(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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
      { id: 'BANK_TRANSFER', label: 'Banküberweisung' },
      { id: 'CASH', label: 'Bar' },
      { id: 'PAYPAL', label: 'PayPal' },
      { id: 'OTHER', label: 'Sonstige' },
    ],
    bookingReasons: [],
    paymentReasons: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    session.groups[0]!.membership!.effectiveGrants = [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }, { permission: 'MEMBER_MANAGEMENT', scope: { type: 'GROUP' } }];
    apiMock.getGroupSettings.mockResolvedValue(settings);
    apiMock.getRoles.mockResolvedValue(roles);
  });

  it('removes the legacy booking-visibility switch from the new settings UI', async () => {
    renderPanel();
    expect(await screen.findByRole('switch', { name: i18n.t('behaviorSettings.notificationEmailToggle') })).toBeVisible();
    expect(screen.queryByRole('switch', { name: i18n.t('behaviorSettings.bookingVisibilityToggle') })).not.toBeInTheDocument();
  });

  it('places the membership default inside general group settings', async () => {
    renderPanel();

    expect(screen.queryByRole('heading', { level: 2, name: i18n.t('behaviorSettings.title') })).not.toBeInTheDocument();
    expect(await screen.findByRole('region', { name: i18n.t('behaviorSettings.groupSectionTitle') })).toBeVisible();
    expect(await screen.findByRole('region', { name: i18n.t('behaviorSettings.notificationEmailTitle') })).toBeVisible();
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

  it('saves notification email delivery only when SMTP is available', async () => {
    const user = userEvent.setup();
    apiMock.updateGroupSettings.mockResolvedValue({ ...settings, notificationEmailsEnabled: true });
    renderPanel();
    const toggle = await screen.findByRole('switch', { name: i18n.t('behaviorSettings.notificationEmailToggle') });

    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: i18n.t('behaviorSettings.save') }));

    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalledWith('group-a', { notificationEmailsEnabled: true }));
  });

  it('keeps notification email delivery visible but disabled without SMTP', async () => {
    apiMock.getGroupSettings.mockResolvedValue({ ...settings, notificationEmailDeliveryAvailable: false });
    renderPanel();

    expect(await screen.findByRole('switch', { name: i18n.t('behaviorSettings.notificationEmailToggle') })).toBeDisabled();
    expect(screen.getByText(i18n.t('behaviorSettings.notificationEmailUnavailable'))).toBeVisible();
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

  it('shows only the membership default to a pure member manager', async () => {
    session.groups[0]!.membership!.effectiveGrants = [{ permission: 'MEMBER_MANAGEMENT', scope: { type: 'GROUP' } }];
    renderPanel();

    expect(await screen.findByRole('region', { name: i18n.t('behaviorSettings.defaultRoleTitle') })).toBeVisible();
    expect(screen.queryByLabelText(i18n.t('groupSettings.nameLabel'))).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: i18n.t('behaviorSettings.notificationEmailToggle') })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: i18n.t('behaviorSettings.financeSectionTitle') })).not.toBeInTheDocument();
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
        { id: 'BANK_TRANSFER', label: 'Banküberweisung' },
        { id: 'PAYPAL', label: 'PayPal' },
        { id: 'CASH', label: 'Kasse' },
        expect.objectContaining({ label: 'Karte' }),
      ],
    }));
  });
});
