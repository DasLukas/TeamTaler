import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupSettings, GroupSettingsUpdateInput, Role, Session } from '@/api/types';
import { ActiveGroupContext } from '@/app/active-group-context';
import i18n from '@/i18n';
import { BehaviorSettingsPanel } from './BehaviorSettingsPanel';

const apiMock = vi.hoisted(() => ({
  archiveExternalAccount: vi.fn(),
  deleteExternalAccount: vi.fn(),
  getExternalAccountLinks: vi.fn(),
  getExternalAccounts: vi.fn(),
  getGroupSettings: vi.fn(),
  getPlanningSettings: vi.fn(),
  getRoles: vi.fn(),
  getTransactionSettings: vi.fn(),
  removeGroupLogo: vi.fn(),
  reactivateExternalAccount: vi.fn(),
  updateGroupSettings: vi.fn(),
  updateExternalAccountLinks: vi.fn(),
  updatePlanningSettings: vi.fn(),
  updateGroupName: vi.fn(),
  uploadGroupLogo: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: apiMock }));

const session: Session = {
  user: { id: 'user-a', displayName: 'Admin', email: 'admin@example.test' },
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', defaultTheme: 'TEAMTALER', statisticsEnabled: false, membership: { id: 'member-a', roles: ['ADMIN', 'MEMBER'], groupPermissions: [], effectiveGrants: [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }, { permission: 'MEMBER_MANAGEMENT', scope: { type: 'GROUP' } }, { permission: 'ROLE_MANAGEMENT', scope: { type: 'GROUP' } }, { permission: 'FINANCE_MANAGEMENT', scope: { type: 'GROUP' } }], themeOverride: null } }],
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
    statisticsEnabled: false,
    externalAccountsEnabled: false,
    settlementsEnabled: false,
    settlementDueSoonDays: 3,
    settlementOverdueRepeatDays: 7,
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
  beforeEach(() => {
    vi.clearAllMocks();
    session.groups[0]!.currency = 'EUR';
    session.groups[0]!.externalAccountsEnabled = false;
    session.groups[0]!.membership!.effectiveGrants = [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }, { permission: 'MEMBER_MANAGEMENT', scope: { type: 'GROUP' } }, { permission: 'ROLE_MANAGEMENT', scope: { type: 'GROUP' } }, { permission: 'FINANCE_MANAGEMENT', scope: { type: 'GROUP' } }];
    apiMock.getGroupSettings.mockResolvedValue(settings);
    apiMock.getExternalAccounts.mockResolvedValue({ items: [], version: 1 });
    apiMock.getExternalAccountLinks.mockResolvedValue({ links: settings.paymentMethods.map((method) => ({ paymentMethodId: method.id, externalAccountId: null })), version: 1 });
    apiMock.archiveExternalAccount.mockResolvedValue({ items: [], version: 2 });
    apiMock.reactivateExternalAccount.mockResolvedValue({ items: [], version: 2 });
    apiMock.deleteExternalAccount.mockResolvedValue(undefined);
    apiMock.getTransactionSettings.mockResolvedValue({ ...settings });
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
    expect(await screen.findByRole('region', { name: i18n.t('behaviorSettings.groupSectionTitle') })).toBeVisible();
    expect(screen.queryByRole('switch', { name: i18n.t('behaviorSettings.bookingVisibilityToggle') })).not.toBeInTheDocument();
  });

  it('places the membership default inside general group settings', async () => {
    renderPanel();

    expect(screen.queryByRole('heading', { level: 2, name: i18n.t('behaviorSettings.title') })).not.toBeInTheDocument();
    expect(await screen.findByRole('region', { name: i18n.t('behaviorSettings.groupSectionTitle') })).toBeVisible();
    expect(screen.queryByText(i18n.t('notifications.preferences.title'))).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: i18n.t('behaviorSettings.rolesMembersSectionTitle') })).not.toBeInTheDocument();
    const defaultRoleRegion = await screen.findByRole('region', { name: i18n.t('behaviorSettings.defaultRoleTitle') });
    const planningRegion = screen.getByRole('region', { name: i18n.t('behaviorSettings.planning.title') });
    expect(defaultRoleRegion).toBeVisible();
    expect(defaultRoleRegion.compareDocumentPosition(planningRegion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('combobox', { name: i18n.t('behaviorSettings.defaultRoleFieldLabel') })).toHaveTextContent('Member');
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
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['statistics', 'group-a'] });
    expect(removeQueries).toHaveBeenCalledWith({ queryKey: ['notification-preferences', 'group-a'] });
  });

  it('places statistics directly below settlements in the finance section without a save button', async () => {
    renderPanel();

    const groupRegion = await screen.findByRole('region', { name: i18n.t('behaviorSettings.groupSectionTitle') });
    const financeRegion = screen.getByRole('region', { name: i18n.t('behaviorSettings.financeSectionTitle') });
    const settlementsRegion = within(financeRegion).getByRole('region', { name: i18n.t('behaviorSettings.settlementsTitle') });
    const statisticsRegion = within(financeRegion).getByRole('region', { name: i18n.t('behaviorSettings.statisticsTitle') });

    expect(within(groupRegion).queryByRole('region', { name: i18n.t('behaviorSettings.statisticsTitle') })).not.toBeInTheDocument();
    expect(settlementsRegion.compareDocumentPosition(statisticsRegion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(statisticsRegion).queryByRole('button')).not.toBeInTheDocument();
  });

  it('persists reminder cadence from the settlement section', async () => {
    const user = userEvent.setup();
    apiMock.getGroupSettings.mockResolvedValue({ ...settings, settlementsEnabled: true });
    apiMock.updateGroupSettings.mockResolvedValue({ ...settings, settlementsEnabled: true, settlementDueSoonDays: 5, settlementOverdueRepeatDays: 10 });
    renderPanel();

    await user.clear(await screen.findByLabelText(i18n.t('behaviorSettings.settlementDueSoonDays')));
    await user.type(screen.getByLabelText(i18n.t('behaviorSettings.settlementDueSoonDays')), '5');
    await user.clear(screen.getByLabelText(i18n.t('behaviorSettings.settlementOverdueRepeatDays')));
    await user.type(screen.getByLabelText(i18n.t('behaviorSettings.settlementOverdueRepeatDays')), '10');
    await user.click(screen.getByRole('button', { name: i18n.t('behaviorSettings.save') }));

    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalledWith('group-a', { settlementDueSoonDays: 5, settlementOverdueRepeatDays: 10 }));
  });

  it('persists the statistics master switch and clears the cached statistics snapshot', async () => {
    const user = userEvent.setup();
    apiMock.updateGroupSettings.mockResolvedValue({ ...settings, statisticsEnabled: true });
    const queryClient = renderPanel();
    const removeQueries = vi.spyOn(queryClient, 'removeQueries');
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    const statisticsRegion = await screen.findByRole('region', { name: i18n.t('behaviorSettings.statisticsTitle') });

    await user.click(within(statisticsRegion).getByRole('switch', { name: i18n.t('behaviorSettings.statisticsToggle') }));

    expect(screen.queryByRole('dialog', { name: i18n.t('behaviorSettings.statisticsDisableTitle') })).not.toBeInTheDocument();
    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalledWith('group-a', { statisticsEnabled: true }));
    expect(removeQueries).toHaveBeenCalledWith({ queryKey: ['statistics', 'group-a'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['dashboard', 'group-a'] });
    expect(queryClient.getQueryData<Session>(['session'])?.groups[0]?.statisticsEnabled).toBe(true);
  });

  it('enables external accounts immediately and projects the flag into the session cache', async () => {
    const user = userEvent.setup();
    apiMock.updateGroupSettings.mockResolvedValue({ ...settings, externalAccountsEnabled: true });
    const queryClient = renderPanel();

    await user.click(await screen.findByRole('switch', { name: i18n.t('behaviorSettings.externalAccountsToggle') }));

    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalledWith('group-a', { externalAccountsEnabled: true }));
    expect(queryClient.getQueryData<Session>(['session'])?.groups[0]?.externalAccountsEnabled).toBe(true);
  });

  it('keeps the external-account switch disabled until finance edits are saved', async () => {
    const user = userEvent.setup();
    apiMock.updateGroupSettings.mockImplementation(async (_groupId: string, update: GroupSettingsUpdateInput) => ({ ...settings, ...update }));
    renderPanel();

    const cash = await screen.findByDisplayValue('Bar');
    await user.type(cash, 'kasse');
    const featureSwitch = screen.getByRole('switch', { name: i18n.t('behaviorSettings.externalAccountsToggle') });
    expect(featureSwitch).toBeDisabled();
    expect(screen.getByText(i18n.t('behaviorSettings.saveBeforeSwitchingExternalAccounts'))).toBeVisible();
    await user.click(screen.getByRole('button', { name: i18n.t('behaviorSettings.save') }));

    await waitFor(() => expect(screen.getByRole('switch', { name: i18n.t('behaviorSettings.externalAccountsToggle') })).toBeEnabled());
    expect(apiMock.updateGroupSettings).toHaveBeenCalledWith('group-a', { paymentMethods: expect.arrayContaining([expect.objectContaining({ id: 'CASH', label: 'Barkasse' })]) });
  });

  it('places external-account creation and linking inside finance settings', async () => {
    const user = userEvent.setup();
    session.groups[0]!.externalAccountsEnabled = true;
    apiMock.getGroupSettings.mockResolvedValue({ ...settings, externalAccountsEnabled: true });
    apiMock.getExternalAccounts.mockResolvedValue({
      items: [
        { id: 'account-bank', name: 'Club account', type: 'BANK', status: 'ACTIVE', currency: 'EUR', balance: { currency: 'EUR', minorUnits: '137700' }, details: { type: 'BANK', recipientName: 'Club', iban: '••••3000' }, linkedPaymentMethodIds: ['BANK_TRANSFER', 'CASH'], sortOrder: 0, version: 1, hasTransactions: true, canChangeType: false, canDelete: false, canArchive: true, canReactivate: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
        { id: 'account-cash', name: 'Old cash box', type: 'CASH', status: 'ARCHIVED', currency: 'EUR', balance: { currency: 'EUR', minorUnits: '0' }, details: null, linkedPaymentMethodIds: [], sortOrder: 1, version: 1, hasTransactions: true, canChangeType: false, canDelete: false, canArchive: false, canReactivate: true, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
        { id: 'account-reserve', name: 'Reserve cash box', type: 'CASH', status: 'ACTIVE', currency: 'EUR', balance: { currency: 'EUR', minorUnits: '0' }, details: null, linkedPaymentMethodIds: [], sortOrder: 2, version: 1, hasTransactions: false, canChangeType: true, canDelete: true, canArchive: true, canReactivate: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
      ],
      version: 1,
    });
    apiMock.getExternalAccountLinks.mockResolvedValue({
      links: settings.paymentMethods.map((method) => ({ paymentMethodId: method.id, externalAccountId: ['BANK_TRANSFER', 'CASH'].includes(method.id) ? 'account-bank' : null })),
      version: 1,
    });
    const queryClient = renderPanel();
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');

    const financeRegion = await screen.findByRole('region', { name: i18n.t('behaviorSettings.financeSectionTitle') });
    const paymentMethodsRegion = within(financeRegion).getByRole('region', { name: i18n.t('behaviorSettings.paymentMethods') });
    const externalAccountsRegion = within(financeRegion).getByRole('region', { name: i18n.t('behaviorSettings.externalAccountsTitle') });
    const configuredAccountsRegion = within(externalAccountsRegion).getByRole('region', { name: i18n.t('externalAccounts.configuredAccounts') });
    const createAccount = within(externalAccountsRegion).getByRole('button', { name: i18n.t('externalAccounts.createAccount') });
    expect(createAccount).toBeVisible();
    expect(within(externalAccountsRegion).getByRole('switch', { name: i18n.t('behaviorSettings.externalAccountsToggle') })).toBeVisible();
    const activeAccountsRegion = within(configuredAccountsRegion).getByRole('region', { name: i18n.t('externalAccounts.activeAccounts') });
    const archivedAccountsRegion = within(configuredAccountsRegion).getByRole('region', { name: i18n.t('externalAccounts.archivedAccountsTitle') });
    const memberCreditNote = within(configuredAccountsRegion).getByRole('note', { name: i18n.t('externalAccounts.unlinkedPaymentMethods') });
    expect(within(activeAccountsRegion).getByLabelText(i18n.t('externalAccounts.accountGroupCount', { count: 2 }))).toHaveTextContent('2');
    expect(within(archivedAccountsRegion).getByLabelText(i18n.t('externalAccounts.accountGroupCount', { count: 1 }))).toHaveTextContent('1');
    expect(within(activeAccountsRegion).getByText('Club account')).toBeVisible();
    expect(within(activeAccountsRegion).getByText('Reserve cash box')).toBeVisible();
    expect(within(activeAccountsRegion).queryByText('Old cash box')).not.toBeInTheDocument();
    expect(within(activeAccountsRegion).getAllByRole('button', { name: i18n.t('common.edit') })).toHaveLength(2);
    expect(within(archivedAccountsRegion).getByText('Old cash box')).toBeVisible();
    expect(within(archivedAccountsRegion).queryByText('Club account')).not.toBeInTheDocument();
    expect(within(archivedAccountsRegion).queryByRole('button', { name: i18n.t('common.edit') })).not.toBeInTheDocument();
    expect(within(archivedAccountsRegion).getByRole('button', { name: i18n.t('externalAccounts.reactivate') })).toBeVisible();
    expect(within(activeAccountsRegion).queryByText(i18n.t('externalAccounts.unlinkedPaymentMethods'))).not.toBeInTheDocument();
    expect(within(archivedAccountsRegion).queryByText(i18n.t('externalAccounts.unlinkedPaymentMethods'))).not.toBeInTheDocument();
    expect(activeAccountsRegion.compareDocumentPosition(memberCreditNote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(memberCreditNote.compareDocumentPosition(archivedAccountsRegion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(configuredAccountsRegion).getByText('Club account')).toBeVisible();
    expect(within(configuredAccountsRegion).getByText('Old cash box')).toBeVisible();
    expect(within(configuredAccountsRegion).getByText('Reserve cash box')).toBeVisible();
    expect(within(configuredAccountsRegion).getByText(i18n.t('externalAccounts.statuses.ARCHIVED'))).toBeVisible();
    expect(within(configuredAccountsRegion).getAllByText(`${i18n.t('externalAccounts.accountTypeLabel')}:`)).toHaveLength(3);
    expect(within(configuredAccountsRegion).getAllByText(i18n.t('externalAccounts.linkedPaymentMethods'))).toHaveLength(3);
    expect(within(paymentMethodsRegion).getAllByRole('combobox')).toHaveLength(settings.paymentMethods.length);
    expect(within(paymentMethodsRegion).queryByRole('combobox', { name: 'Zahlungsanweisung' })).not.toBeInTheDocument();
    expect(within(configuredAccountsRegion).getByText('Banküberweisung')).toBeVisible();
    expect(within(configuredAccountsRegion).getByText(i18n.t('externalAccounts.unlinkedPaymentMethods'))).toBeVisible();
    expect(within(configuredAccountsRegion).getByText(i18n.t('externalAccounts.unlinkedPaymentMethodsHint'))).toBeVisible();
    expect(memberCreditNote).toHaveTextContent('Gutschrift nur auf dem Mitgliedskonto');
    expect(memberCreditNote).toHaveTextContent('Jede Einzahlung wird dem Mitgliedskonto gutgeschrieben.');
    expect(memberCreditNote).toHaveTextContent('Bei diesen nicht zugewiesenen Zahlungsarten wird kein externes Konto zusätzlich bebucht.');
    expect(within(configuredAccountsRegion).getByText('Bar')).toBeVisible();
    expect(within(configuredAccountsRegion).getByText('PayPal')).toBeVisible();
    expect(within(configuredAccountsRegion).getByText('Sonstige')).toBeVisible();
    expect(within(configuredAccountsRegion).getAllByRole('button', { name: i18n.t('externalAccounts.archive') })).toHaveLength(2);
    expect(within(configuredAccountsRegion).getByRole('button', { name: i18n.t('externalAccounts.reactivate') })).toBeVisible();
    expect(within(configuredAccountsRegion).getByRole('button', { name: i18n.t('externalAccounts.deleteAccount') })).toBeVisible();

    await user.click(createAccount);
    expect(screen.getByRole('dialog', { name: i18n.t('externalAccounts.createAccount') })).toBeVisible();
    await user.click(screen.getByRole('button', { name: i18n.t('common.cancel') }));
    await user.click(within(configuredAccountsRegion).getAllByRole('button', { name: i18n.t('common.edit') })[0]!);
    const editDialog = screen.getByRole('dialog', { name: i18n.t('externalAccounts.editAccount') });
    expect(within(editDialog).getByRole('button', { name: i18n.t('externalAccounts.linkedPaymentMethods') })).toBeVisible();
    expect(editDialog).toHaveTextContent('Bei Bank und PayPal sehen Mitglieder die Zahlungsdaten bei eigener Einzahlung.');
    await user.click(within(editDialog).getByRole('button', { name: i18n.t('common.cancel') }));
    const linkedAccountRow = within(configuredAccountsRegion).getByText('Club account').closest('li');
    expect(linkedAccountRow).not.toBeNull();
    await user.click(within(linkedAccountRow!).getByRole('button', { name: i18n.t('externalAccounts.archive') }));
    const archiveDialog = screen.getByRole('dialog', { name: i18n.t('externalAccounts.lifecycle.archiveTitle') });
    expect(within(archiveDialog).getByText(i18n.t('externalAccounts.lifecycle.archiveLinkedMessage', {
      name: 'Club account',
      count: 2,
      paymentMethods: 'Banküberweisung, Bar',
    }))).toBeVisible();
    expect(archiveDialog).toHaveTextContent('Die Zahlungsarten Banküberweisung, Bar werden von diesem Konto entkoppelt.');
    await user.click(within(archiveDialog).getByRole('button', { name: i18n.t('externalAccounts.archive') }));
    await waitFor(() => expect(apiMock.archiveExternalAccount).toHaveBeenCalledWith('group-a', 'account-bank', 1));
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['group-settings', 'group-a'] }));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['transaction-settings', 'group-a'] });
  });

  it('names the single payment method that archival disconnects from its account', async () => {
    const user = userEvent.setup();
    session.groups[0]!.externalAccountsEnabled = true;
    apiMock.getGroupSettings.mockResolvedValue({ ...settings, externalAccountsEnabled: true });
    apiMock.getExternalAccounts.mockResolvedValue({
      items: [{ id: 'account-cash', name: 'Club cash box', type: 'CASH', status: 'ACTIVE', currency: 'EUR', balance: { currency: 'EUR', minorUnits: '5200' }, details: null, linkedPaymentMethodIds: ['CASH'], sortOrder: 0, version: 1, hasTransactions: true, canChangeType: false, canDelete: false, canArchive: true, canReactivate: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }],
      version: 1,
    });
    apiMock.getExternalAccountLinks.mockResolvedValue({
      links: settings.paymentMethods.map((method) => ({ paymentMethodId: method.id, externalAccountId: method.id === 'CASH' ? 'account-cash' : null })),
      version: 1,
    });
    renderPanel();

    const accountRow = (await screen.findByText('Club cash box')).closest('li');
    expect(accountRow).not.toBeNull();
    await user.click(within(accountRow!).getByRole('button', { name: i18n.t('externalAccounts.archive') }));
    const archiveDialog = screen.getByRole('dialog', { name: i18n.t('externalAccounts.lifecycle.archiveTitle') });
    expect(archiveDialog).toHaveTextContent('Die Zahlungsart „Bar“ wird von diesem Konto entkoppelt.');
    expect(archiveDialog).toHaveTextContent('Bereits erfasste Buchungen bleiben unverändert.');
  });

  it('sends changed legacy targets without clearing unrelated account links', async () => {
    const user = userEvent.setup();
    apiMock.getGroupSettings.mockResolvedValue({ ...settings, paymentMethods: [
      { id: 'BANK_TRANSFER', label: 'Banküberweisung', attachmentMode: 'OFF', externalAccountId: 'account-bank', paymentTarget: { type: 'SEPA_TRANSFER', recipientName: 'Main club', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' } },
      { id: 'CASH', label: 'Bar', attachmentMode: 'OFF', externalAccountId: 'account-cash', paymentTarget: null },
      { id: 'PAYPAL', label: 'PayPal', attachmentMode: 'OFF', externalAccountId: null, paymentTarget: null },
    ] });
    renderPanel();

    const recipient = await screen.findByLabelText(i18n.t('behaviorSettings.sepaRecipient'));
    await user.clear(recipient);
    await user.type(recipient, 'Youth club');
    const targets = screen.getAllByRole('combobox', { name: i18n.t('behaviorSettings.paymentTargetLabel') });
    await user.click(targets[2]!);
    await user.click(screen.getByRole('option', { name: i18n.t('behaviorSettings.paymentTargetPaypal') }));
    await user.type(screen.getByLabelText(i18n.t('behaviorSettings.paypalMeHandle')), 'Club123');
    await user.click(screen.getByRole('button', { name: i18n.t('behaviorSettings.save') }));

    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalled());
    const update = apiMock.updateGroupSettings.mock.calls[0]?.[1] as GroupSettingsUpdateInput;
    expect(update.paymentMethods?.find((method) => method.id === 'BANK_TRANSFER')).toEqual({
      id: 'BANK_TRANSFER', label: 'Banküberweisung', attachmentMode: 'OFF',
      paymentTarget: { type: 'SEPA_TRANSFER', recipientName: 'Youth club', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' },
    });
    expect(update.paymentMethods?.find((method) => method.id === 'PAYPAL')).toEqual({
      id: 'PAYPAL', label: 'PayPal', attachmentMode: 'OFF', paymentTarget: { type: 'PAYPAL_ME', paypalMeHandle: 'Club123' },
    });
    expect(update.paymentMethods?.find((method) => method.id === 'CASH')?.externalAccountId).toBe('account-cash');
  });

  it('shows only external-account finance settings to a dedicated account manager', async () => {
    session.groups[0]!.externalAccountsEnabled = true;
    session.groups[0]!.membership!.effectiveGrants = [{ permission: 'MANAGE_EXTERNAL_ACCOUNTS', scope: { type: 'GROUP' } }];
    renderPanel();

    const financeRegion = await screen.findByRole('region', { name: i18n.t('behaviorSettings.financeSectionTitle') });
    expect(within(financeRegion).getByRole('button', { name: i18n.t('externalAccounts.createAccount') })).toBeVisible();
    expect(within(financeRegion).getByRole('button', { name: i18n.t('externalAccounts.createAccount') })).toBeVisible();
    expect(screen.queryByRole('region', { name: i18n.t('behaviorSettings.settlementsTitle') })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: i18n.t('behaviorSettings.bookingTitle') })).not.toBeInTheDocument();
    expect(apiMock.getGroupSettings).not.toHaveBeenCalled();
    expect(apiMock.getTransactionSettings).toHaveBeenCalledWith('group-a');
  });

  it('confirms before immediately disabling the statistics dashboard', async () => {
    const user = userEvent.setup();
    apiMock.getGroupSettings.mockResolvedValue({ ...settings, statisticsEnabled: true });
    apiMock.updateGroupSettings.mockResolvedValue({ ...settings, statisticsEnabled: false });
    renderPanel();

    const statisticsRegion = await screen.findByRole('region', { name: i18n.t('behaviorSettings.statisticsTitle') });
    const toggle = within(statisticsRegion).getByRole('switch', { name: i18n.t('behaviorSettings.statisticsToggle') });
    expect(toggle).toBeChecked();

    await user.click(toggle);
    const dialog = screen.getByRole('dialog', { name: i18n.t('behaviorSettings.statisticsDisableTitle') });
    expect(dialog).toBeVisible();
    expect(toggle).toBeChecked();
    expect(apiMock.updateGroupSettings).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: i18n.t('common.cancel') }));
    expect(screen.queryByRole('dialog', { name: i18n.t('behaviorSettings.statisticsDisableTitle') })).not.toBeInTheDocument();
    expect(toggle).toBeChecked();

    await user.click(toggle);
    await user.click(within(screen.getByRole('dialog', { name: i18n.t('behaviorSettings.statisticsDisableTitle') })).getByRole('button', { name: i18n.t('behaviorSettings.statisticsDisable') }));

    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalledWith('group-a', { statisticsEnabled: false }));
    await waitFor(() => expect(screen.getByRole('switch', { name: i18n.t('behaviorSettings.statisticsToggle') })).not.toBeChecked());
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
    await user.click(within(defaultRoleRegion).getByRole('combobox', { name: i18n.t('behaviorSettings.defaultRoleFieldLabel') }));
    await user.click(screen.getByRole('option', { name: 'Finance' }));
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
    expect(screen.queryByRole('region', { name: i18n.t('behaviorSettings.statisticsTitle') })).not.toBeInTheDocument();
    expect(apiMock.getRoles).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: i18n.t('behaviorSettings.save') })).toBeVisible();
  });

  it('orders finance settings as payment methods, external accounts, settlements, and statistics', async () => {
    renderPanel();

    const financeRegion = await screen.findByRole('region', { name: i18n.t('behaviorSettings.financeSectionTitle') });
    const paymentMethodsRegion = within(financeRegion).getByRole('region', { name: i18n.t('behaviorSettings.paymentMethods') });
    const externalAccountsRegion = within(financeRegion).getByRole('region', { name: i18n.t('behaviorSettings.externalAccountsTitle') });
    const settlementsRegion = within(financeRegion).getByRole('region', { name: i18n.t('behaviorSettings.settlementsTitle') });
    const statisticsRegion = within(financeRegion).getByRole('region', { name: i18n.t('behaviorSettings.statisticsTitle') });
    const bookingRegion = screen.getByRole('region', { name: i18n.t('behaviorSettings.bookingTitle') });

    for (const [current, next] of [
      [paymentMethodsRegion, externalAccountsRegion],
      [externalAccountsRegion, settlementsRegion],
      [settlementsRegion, statisticsRegion],
    ]) {
      expect(current.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(within(bookingRegion).queryByRole('region', { name: i18n.t('behaviorSettings.paymentMethods') })).not.toBeInTheDocument();
  });

  it('shows only the membership default to a pure role manager', async () => {
    session.groups[0]!.membership!.effectiveGrants = [{ permission: 'ROLE_MANAGEMENT', scope: { type: 'GROUP' } }];
    renderPanel();

    expect(await screen.findByRole('region', { name: i18n.t('behaviorSettings.defaultRoleTitle') })).toBeVisible();
    expect(screen.queryByLabelText(i18n.t('groupSettings.nameLabel'))).not.toBeInTheDocument();
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

  it('edits, reorders, and adds configured payment methods', async () => {
    const user = userEvent.setup();
    apiMock.updateGroupSettings.mockImplementation(async (_groupId: string, update: Partial<GroupSettings>) => ({ ...settings, ...update }));
    renderPanel();

    const cash = await screen.findByDisplayValue('Bar');
    await user.clear(cash);
    await user.type(cash, 'Kasse');
    await user.click(screen.getByRole('button', { name: i18n.t('behaviorSettings.moveUp', { name: 'PayPal' }) }));
    await user.type(screen.getByRole('textbox', { name: i18n.t('behaviorSettings.addPaymentMethod') }), 'Karte');
    await user.click(screen.getByRole('button', { name: i18n.t('behaviorSettings.addPaymentMethod') }));
    await user.click(screen.getByRole('button', { name: i18n.t('behaviorSettings.save') }));

    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalledWith('group-a', {
      paymentMethods: [
        { id: 'BANK_TRANSFER', label: 'Banküberweisung', attachmentMode: 'OFF', paymentTarget: null },
        { id: 'PAYPAL', label: 'PayPal', attachmentMode: 'OFF', paymentTarget: null },
        { id: 'CASH', label: 'Kasse', attachmentMode: 'OFF', paymentTarget: null },
        { id: 'OTHER', label: 'Sonstige', attachmentMode: 'OFF', paymentTarget: null },
        expect.objectContaining({ label: 'Karte', attachmentMode: 'OFF', paymentTarget: null }),
      ],
    }));
  });

  it.each([true, false])('deletes a linked payment method immediately when external accounts enabled is %s', async (externalAccountsEnabled) => {
    const user = userEvent.setup();
    let currentSettings: GroupSettings = {
      ...settings,
      externalAccountsEnabled,
      paymentMethods: [...settings.paymentMethods, { id: 'CARD', label: 'Karte', attachmentMode: 'OFF', externalAccountId: 'account-bank', paymentTarget: null }],
    };
    session.groups[0]!.externalAccountsEnabled = externalAccountsEnabled;
    session.groups[0]!.membership!.effectiveGrants = [
      ...(session.groups[0]!.membership!.effectiveGrants ?? []),
      { permission: 'VIEW_EXTERNAL_ACCOUNTS', scope: { type: 'GROUP' } },
      { permission: 'MANAGE_EXTERNAL_ACCOUNTS', scope: { type: 'GROUP' } },
    ];
    apiMock.getGroupSettings.mockImplementation(async () => currentSettings);
    apiMock.getExternalAccounts.mockResolvedValue({
      items: [{ id: 'account-bank', name: 'Club account', type: 'BANK', status: 'ACTIVE', currency: 'EUR', balance: { currency: 'EUR', minorUnits: '1000' }, details: { type: 'BANK', recipientName: 'Club', iban: '••••3000' }, linkedPaymentMethodIds: ['CARD'], sortOrder: 0, version: 1, hasTransactions: true, canChangeType: false, canDelete: false, canArchive: true, canReactivate: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }],
      version: 1,
    });
    apiMock.getExternalAccountLinks.mockImplementation(async () => ({ links: currentSettings.paymentMethods.map((method) => ({ paymentMethodId: method.id, externalAccountId: method.externalAccountId ?? null })), version: 1 }));
    apiMock.updateGroupSettings.mockImplementation(async (_groupId: string, update: GroupSettingsUpdateInput) => {
      currentSettings = { ...currentSettings, ...update, paymentMethods: (update.paymentMethods ?? currentSettings.paymentMethods) as GroupSettings['paymentMethods'] };
      return currentSettings;
    });
    renderPanel();

    const remove = await screen.findByRole('button', { name: i18n.t('behaviorSettings.removeOption', { name: 'Karte' }) });
    if (externalAccountsEnabled) {
      const accountRow = screen.getByText('Club account').closest('li');
      expect(accountRow).not.toBeNull();
      expect(within(accountRow!).getByText('Karte')).toBeVisible();
    }
    await user.click(remove);
    const dialog = screen.getByRole('dialog', { name: i18n.t('behaviorSettings.removePaymentMethodTitle') });
    expect(dialog).toHaveTextContent('„Karte“ ist mit einem externen Konto verknüpft.');
    expect(dialog).toHaveTextContent('Beim Löschen wird die Zahlungsart sofort entkoppelt.');
    expect(screen.getByDisplayValue('Karte')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: i18n.t('behaviorSettings.save') })).toBeDisabled();

    await user.click(within(dialog).getByRole('button', { name: i18n.t('common.cancel') }));
    expect(screen.getByDisplayValue('Karte')).toBeInTheDocument();
    expect(apiMock.updateGroupSettings).not.toHaveBeenCalled();
    await user.click(remove);
    await user.click(within(screen.getByRole('dialog', { name: i18n.t('behaviorSettings.removePaymentMethodTitle') })).getByRole('button', { name: i18n.t('behaviorSettings.removePaymentMethodConfirm') }));
    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalled());
    const update = apiMock.updateGroupSettings.mock.calls[0]?.[1] as GroupSettingsUpdateInput;
    expect(update.paymentMethods?.map((method) => method.id)).not.toContain('CARD');
    await waitFor(() => expect(screen.queryByDisplayValue('Karte')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: i18n.t('behaviorSettings.save') })).toBeDisabled();
    if (externalAccountsEnabled) {
      const accountRow = screen.getByText('Club account').closest('li');
      expect(accountRow).not.toBeNull();
      expect(within(accountRow!).queryByText('Karte')).not.toBeInTheDocument();
    }

    cleanup();
    renderPanel();
    expect(await screen.findByRole('region', { name: i18n.t('behaviorSettings.paymentMethods') })).not.toHaveTextContent('Karte');
    if (externalAccountsEnabled) {
      const accountRow = screen.getByText('Club account').closest('li');
      expect(accountRow).not.toBeNull();
      expect(within(accountRow!).queryByText('Karte')).not.toBeInTheDocument();
    }
  });

  it('deletes an unlinked persisted payment method without a separate settings save', async () => {
    const user = userEvent.setup();
    let currentSettings = settings;
    apiMock.getGroupSettings.mockImplementation(async () => currentSettings);
    apiMock.updateGroupSettings.mockImplementation(async (_groupId: string, update: GroupSettingsUpdateInput) => {
      currentSettings = { ...currentSettings, paymentMethods: update.paymentMethods as GroupSettings['paymentMethods'] };
      return currentSettings;
    });
    renderPanel();

    await user.click(await screen.findByRole('button', { name: i18n.t('behaviorSettings.removeOption', { name: 'Sonstige' }) }));
    const dialog = screen.getByRole('dialog', { name: i18n.t('behaviorSettings.removePaymentMethodTitle') });
    expect(dialog).toHaveTextContent('„Sonstige“ wird sofort gelöscht.');
    await user.click(within(dialog).getByRole('button', { name: i18n.t('behaviorSettings.removePaymentMethodConfirm') }));

    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalledOnce());
    expect((apiMock.updateGroupSettings.mock.calls[0]?.[1] as GroupSettingsUpdateInput).paymentMethods?.map((method) => method.id)).not.toContain('OTHER');
    await waitFor(() => expect(screen.queryByDisplayValue('Sonstige')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: i18n.t('behaviorSettings.save') })).toBeDisabled();
  });

  it('keeps a payment method visible and reports a failed immediate deletion', async () => {
    const user = userEvent.setup();
    apiMock.updateGroupSettings.mockRejectedValue(new Error('Unavailable'));
    renderPanel();

    await user.click(await screen.findByRole('button', { name: i18n.t('behaviorSettings.removeOption', { name: 'Sonstige' }) }));
    await user.click(within(screen.getByRole('dialog', { name: i18n.t('behaviorSettings.removePaymentMethodTitle') })).getByRole('button', { name: i18n.t('behaviorSettings.removePaymentMethodConfirm') }));

    expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('behaviorSettings.removePaymentMethodError'));
    expect(screen.getByDisplayValue('Sonstige')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: i18n.t('behaviorSettings.removePaymentMethodTitle') })).toBeVisible();
  });

  it('warns that deleting a persisted method discards other unsaved edits', async () => {
    const user = userEvent.setup();
    renderPanel();

    const cash = await screen.findByDisplayValue('Bar');
    await user.clear(cash);
    await user.type(cash, 'Kasse');
    await user.click(screen.getByRole('button', { name: i18n.t('behaviorSettings.removeOption', { name: 'Sonstige' }) }));

    const dialog = screen.getByRole('dialog', { name: i18n.t('behaviorSettings.removePaymentMethodTitle') });
    expect(dialog).toHaveTextContent(i18n.t('behaviorSettings.removePaymentMethodUnsavedWarning'));
    await user.click(within(dialog).getByRole('button', { name: i18n.t('common.cancel') }));
    expect(screen.getByDisplayValue('Kasse')).toBeInTheDocument();
    expect(apiMock.updateGroupSettings).not.toHaveBeenCalled();
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

    const targets = await screen.findAllByRole('combobox', { name: i18n.t('behaviorSettings.paymentTargetLabel') });
    await user.click(targets[2]);
    await user.click(screen.getByRole('option', { name: i18n.t('behaviorSettings.paymentTargetPaypal') }));
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

  it('shows payment-target icons and supports keyboard selection with restored focus', async () => {
    const user = userEvent.setup();
    renderPanel();

    const target = (await screen.findAllByRole('combobox', { name: i18n.t('behaviorSettings.paymentTargetLabel') }))[0]!;
    expect(target).toHaveAccessibleName('Zahlungsanweisung');
    expect(target).toHaveTextContent('Keine Zahlungsanweisung');
    expect(screen.getByText(i18n.t('behaviorSettings.paymentTargetDescription'))).toHaveTextContent('Jede erfasste Einzahlung mindert den Mitgliedssaldo');
    expect(target.tagName).toBe('BUTTON');
    await user.click(target);
    expect(target).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('listbox', { name: i18n.t('behaviorSettings.paymentTargetLabel') })).toBeVisible();
    expect(screen.getByRole('option', { name: 'Keine Zahlungsanweisung' })).toBeVisible();
    expect(screen.getByRole('option', { name: i18n.t('behaviorSettings.paymentTargetPaypal') }).querySelector('svg.lucide-badge-dollar-sign')).not.toBeNull();
    expect(screen.getByRole('option', { name: i18n.t('behaviorSettings.paymentTargetSepa') }).querySelector('svg.lucide-landmark')).not.toBeNull();

    await user.keyboard('{ArrowDown}{Enter}');
    expect(target).toHaveTextContent(i18n.t('behaviorSettings.paymentTargetPaypal'));
    expect(target).toHaveFocus();
    await user.keyboard('{ArrowDown}{Escape}');
    expect(target).toHaveAttribute('aria-expanded', 'false');
    expect(target).toHaveFocus();
  });

  it('validates and persists normalized SEPA account data for EUR groups', async () => {
    const user = userEvent.setup();
    apiMock.updateGroupSettings.mockImplementation(async (_groupId: string, update: Partial<GroupSettings>) => ({ ...settings, ...update }));
    renderPanel();

    const targets = await screen.findAllByRole('combobox', { name: i18n.t('behaviorSettings.paymentTargetLabel') });
    await user.click(targets[0]);
    await user.click(screen.getByRole('option', { name: i18n.t('behaviorSettings.paymentTargetSepa') }));
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
