import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemSettings } from '@/api/types';
import { SystemSettingsPanel } from './SystemSettingsPanel';

const apiMock = vi.hoisted(() => ({
  getSystemSettings: vi.fn(),
  updateSystemSettings: vi.fn(),
  resetSystemSettings: vi.fn(),
  updateSystemSmtp: vi.fn(),
  resetSystemSmtp: vi.fn(),
  testSystemSmtp: vi.fn(),
  getSystemAdministrators: vi.fn(),
  searchSystemAccounts: vi.fn(),
  getSystemGroups: vi.fn(),
  createSystemGroup: vi.fn(),
  archiveSystemGroup: vi.fn(),
  restoreSystemGroup: vi.fn(),
  resendSystemGroupInvitation: vi.fn(),
  getSystemGroupDeletionImpact: vi.fn(),
  purgeSystemGroup: vi.fn(),
  getSystemAuditPage: vi.fn(),
  getSystemAuditFilterOptions: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: apiMock }));

const value = <T,>(settingValue: T, source: 'CODE' | 'ENVIRONMENT' | 'DATABASE' = 'CODE') => ({ value: settingValue, source, overrideVersion: source === 'DATABASE' ? 1 : null, updatedAt: source === 'DATABASE' ? '2026-08-15T10:00:00Z' : null });

const settings: SystemSettings = {
  revision: 4,
  instanceName: value('TeamTaler'),
  defaultCurrency: value('EUR'),
  mediaUploadMaxBytes: value(5 * 1024 * 1024),
  mediaUploadHardLimitBytes: 25 * 1024 * 1024,
  publicJoinEnabled: value(true),
  maintenanceMode: value(false),
  maintenanceMessage: value(''),
  smtp: {
    enabled: value(false),
    host: value('smtp.example.test'),
    port: value(587),
    tlsMode: value('starttls'),
    username: value('mailer'),
    fromAddress: value('mail@example.test'),
    fromName: value('TeamTaler'),
    passwordConfigured: true,
    passwordSource: 'DATABASE',
    passwordUpdatedAt: '2026-08-15T10:00:00Z',
    testStatus: 'VERIFIED',
    testedRevision: 2,
    testedAt: '2026-08-15T10:00:00Z',
    revision: 2,
    requiresTest: true,
    configurationValid: true,
    active: false,
  },
  updatedAt: '2026-08-15T10:00:00Z',
  updatedByUserId: 'system-user',
};

const archivedGroup = {
  id: 'group-a',
  name: 'Group A',
  currency: 'EUR',
  status: 'ARCHIVED' as const,
  version: 4,
  administratorEmail: null,
  archivedAt: '2026-08-15T10:00:00Z',
  createdAt: '2026-08-01T10:00:00Z',
  impact: { members: 2, invitations: 1, bookings: 4, financialRecords: 3, auditEntries: 5, mediaFiles: 1 },
};

const provisioningGroup = {
  ...archivedGroup,
  id: 'group-p',
  name: 'Group Pending',
  status: 'PROVISIONING' as const,
  version: 2,
  administratorEmail: 'pending@example.test',
  archivedAt: null,
};

const secondArchivedGroup = {
  ...archivedGroup,
  id: 'group-b',
  name: 'Group B',
  version: 7,
};

function renderPanel(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  render(<SystemSettingsPanel />, { wrapper });
}

describe('SystemSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/system');
    apiMock.getSystemSettings.mockResolvedValue(settings);
    apiMock.updateSystemSettings.mockResolvedValue(settings);
    apiMock.resetSystemSettings.mockResolvedValue(settings);
    apiMock.updateSystemSmtp.mockResolvedValue(settings);
    apiMock.resetSystemSmtp.mockResolvedValue(settings);
    apiMock.testSystemSmtp.mockResolvedValue(settings);
    apiMock.getSystemAdministrators.mockResolvedValue([{ id: 'system-user', displayName: 'System Admin', email: 'admin@example.test', active: true }]);
    apiMock.searchSystemAccounts.mockResolvedValue([]);
    apiMock.getSystemGroups.mockResolvedValue([archivedGroup]);
    apiMock.createSystemGroup.mockResolvedValue({ group: archivedGroup, acceptUrl: null, emailDeliveryStatus: null, expiresAt: null });
    apiMock.archiveSystemGroup.mockResolvedValue(archivedGroup);
    apiMock.restoreSystemGroup.mockResolvedValue({ ...archivedGroup, status: 'ACTIVE', version: 5 });
    apiMock.resendSystemGroupInvitation.mockResolvedValue({ group: { ...provisioningGroup, version: 3 }, acceptUrl: 'https://teamtaler.example/invite#token=replaced', emailDeliveryStatus: 'NOT_REQUESTED', expiresAt: '2026-08-23T12:00:00Z' });
    apiMock.getSystemGroupDeletionImpact.mockResolvedValue({ groupId: 'group-a', groupName: 'Group A', version: 5, openBalance: { minorUnits: '1234', currency: 'EUR' }, ...archivedGroup.impact });
    apiMock.purgeSystemGroup.mockResolvedValue({ groupId: 'group-a', groupName: 'Group A', version: 5, openBalance: { minorUnits: '1234', currency: 'EUR' }, ...archivedGroup.impact });
    apiMock.getSystemAuditPage.mockResolvedValue({ hasMore: false, items: [], limit: 50 });
    apiMock.getSystemAuditFilterOptions.mockResolvedValue({
      actions: ['system.group.archived', 'system.settings.updated'],
      resourceTypes: ['group', 'system_settings'],
      actionResourceTypes: { 'system.group.archived': ['group'], 'system.settings.updated': ['system_settings'] },
    });
  });

  it('loads all five instance-administration areas in parallel', async () => {
    renderPanel();

    for (const name of ['Allgemein', 'E-Mail (SMTP)', 'Zugriff und Wartung', 'Gruppenverwaltung', 'Systemaktivität']) {
      expect(await screen.findByRole('heading', { name })).toBeVisible();
    }
    expect(screen.getByText('admin@example.test')).toBeVisible();
    expect(screen.getByText('Group A')).toBeVisible();
    const groupCard = screen.getByText('Group A').closest('article');
    if (!groupCard) throw new Error('Missing group card.');
    expect(within(groupCard).getByText('Archiviert')).toBeVisible();
    expect(within(groupCard).queryByText(/EUR/)).not.toBeInTheDocument();
    expect(screen.queryByText('Lege die Identität und die Standardwerte dieser TeamTaler-Instanz fest.')).not.toBeInTheDocument();
    expect(screen.queryByText('Bestehende Konten werden direkt zugewiesen; neue Adressen erhalten eine Einladung.')).not.toBeInTheDocument();
    expect(screen.queryByText(/Quelle:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Geändert:/)).not.toBeInTheDocument();
  });

  it('renders instance activity with the shared audit table columns', async () => {
    apiMock.getSystemAuditPage.mockResolvedValue({ hasMore: false, items: [{
      id: 'audit-1',
      action: 'system.group.archived',
      actorUserId: 'system-user',
      actorDisplayName: 'System Admin',
      targetType: 'group',
      targetId: 'group-a',
      summary: '{"name":"Group A"}',
      createdAt: '2026-08-16T18:55:00Z',
    }], limit: 50 });
    renderPanel();

    const section = (await screen.findByRole('heading', { name: 'Systemaktivität' })).closest('section');
    if (!section) throw new Error('Missing system activity section.');
    const table = await within(section).findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Zeitpunkt', 'Akteur', 'Aktion', 'Betroffen', 'Details']);
    const row = within(table).getAllByRole('row')[1];
    expect(row).toHaveTextContent('System Admin');
    expect(row).toHaveTextContent('system.group.archived');
    expect(row).toHaveTextContent('group · group-a');
    expect(row).toHaveTextContent('{"name":"Group A"}');
  });

  it('filters system audit with searchable multi-select values discovered from the server', async () => {
    const user = userEvent.setup();
    renderPanel();

    const section = (await screen.findByRole('heading', { name: 'Systemaktivität' })).closest('section');
    if (!section) throw new Error('Missing system activity section.');
    await user.click(within(section).getByRole('button', { name: 'Filter' }));
    const filterDialog = screen.getByRole('dialog', { name: 'Ergebnisse filtern' });
    await user.click(within(filterDialog).getByRole('button', { name: 'Ressourcentyp' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Ressourcentyp' })).getByRole('checkbox', { name: 'group' }));
    await user.click(within(filterDialog).getByRole('button', { name: 'Aktion' }));
    const actionMenu = screen.getByRole('dialog', { name: 'Aktion' });
    expect(within(actionMenu).queryByRole('checkbox', { name: 'system.settings.updated' })).not.toBeInTheDocument();
    await user.click(within(actionMenu).getByRole('checkbox', { name: 'system.group.archived' }));
    await user.click(within(filterDialog).getByRole('button', { name: 'Filter anwenden' }));

    await waitFor(() => expect(apiMock.getSystemAuditPage).toHaveBeenLastCalledWith(expect.objectContaining({
      action: ['system.group.archived'],
      resourceType: ['group'],
    })));
  });

  it('patches only changed general settings with the aggregate revision', async () => {
    const user = userEvent.setup();
    renderPanel();
    const heading = await screen.findByRole('heading', { name: 'Allgemein' });
    const section = heading.closest('section');
    if (!section) throw new Error('Missing general settings section.');

    await user.clear(within(section).getByLabelText('Instanzname'));
    await user.type(within(section).getByLabelText('Instanzname'), 'Club Cloud');
    await user.click(within(section).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(apiMock.updateSystemSettings).toHaveBeenCalledWith({ instanceName: 'Club Cloud' }, 4));
  });

  it('places one confirmed reset action directly before save in every settings section', async () => {
    const user = userEvent.setup();
    const overriddenSettings: SystemSettings = {
      ...settings,
      instanceName: value('Club Cloud', 'DATABASE'),
      defaultCurrency: value('USD', 'DATABASE'),
      mediaUploadMaxBytes: value(12 * 1024 * 1024, 'DATABASE'),
      publicJoinEnabled: value(false, 'DATABASE'),
      maintenanceMode: value(true, 'DATABASE'),
      maintenanceMessage: value('Maintenance', 'DATABASE'),
      smtp: { ...settings.smtp, host: value('smtp.override.test', 'DATABASE') },
    };
    apiMock.getSystemSettings.mockResolvedValue(overriddenSettings);
    renderPanel();

    for (const name of ['Allgemein', 'E-Mail (SMTP)', 'Zugriff und Wartung']) {
      const heading = await screen.findByRole('heading', { name });
      const section = heading.closest('section');
      if (!section) throw new Error(`Missing ${name} settings section.`);
      const resetButton = within(section).getByRole('button', { name: 'Zurücksetzen' });
      const saveButton = within(section).getByRole('button', { name: 'Speichern' });
      expect(resetButton.nextElementSibling).toBe(saveButton);
      expect(saveButton.querySelector('svg')).toBeInTheDocument();
    }

    const generalSection = screen.getByRole('heading', { name: 'Allgemein' }).closest('section');
    if (!generalSection) throw new Error('Missing general settings section.');
    await user.click(within(generalSection).getByRole('button', { name: 'Zurücksetzen' }));
    const dialog = screen.getByRole('dialog', { name: 'Allgemein zurücksetzen?' });
    expect(apiMock.resetSystemSettings).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('dialog', { name: 'Allgemein zurücksetzen?' })).not.toBeInTheDocument();
    expect(apiMock.resetSystemSettings).not.toHaveBeenCalled();

    await user.click(within(generalSection).getByRole('button', { name: 'Zurücksetzen' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Allgemein zurücksetzen?' })).getByRole('button', { name: 'Zurücksetzen' }));

    await waitFor(() => expect(apiMock.resetSystemSettings).toHaveBeenCalledWith(
      ['instanceName', 'defaultCurrency', 'mediaUploadMaxBytes'],
      4,
    ));
    expect(within(generalSection).getByLabelText('Instanzname')).toHaveValue('TeamTaler');
  });

  it('requires confirmation before resetting SMTP overrides', async () => {
    const user = userEvent.setup();
    renderPanel();
    const heading = await screen.findByRole('heading', { name: 'E-Mail (SMTP)' });
    const section = heading.closest('section');
    if (!section) throw new Error('Missing SMTP settings section.');

    await user.click(within(section).getByRole('button', { name: 'Zurücksetzen' }));
    const dialog = screen.getByRole('dialog', { name: 'E-Mail (SMTP) zurücksetzen?' });
    expect(apiMock.resetSystemSmtp).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Zurücksetzen' }));

    await waitFor(() => expect(apiMock.resetSystemSmtp).toHaveBeenCalledWith(4));
  });

  it('offers common currencies with symbols and explains the whole-MiB media range', async () => {
    const user = userEvent.setup();
    renderPanel();
    const heading = await screen.findByRole('heading', { name: 'Allgemein' });
    const section = heading.closest('section');
    if (!section) throw new Error('Missing general settings section.');

    const currency = within(section).getByLabelText('Standardwährung für neue Gruppen');
    expect(currency).toHaveRole('combobox');
    expect(within(currency).getByRole('option', { name: 'EUR - €' })).toBeVisible();
    expect(within(currency).getByRole('option', { name: 'USD - $' })).toBeVisible();
    const mediaLimit = within(section).getByLabelText('Maximale Medien-Uploadgröße in MiB');
    expect(mediaLimit).toHaveAttribute('min', '1');
    expect(mediaLimit).toHaveAttribute('max', '25');
    expect(mediaLimit).toHaveAttribute('step', '1');
    expect(within(section).getByText('Einstellbar in ganzen MiB von 1 bis 25.')).toBeVisible();

    await user.selectOptions(currency, 'USD');
    await user.click(within(section).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(apiMock.updateSystemSettings).toHaveBeenCalledWith({ defaultCurrency: 'USD' }, 4));
  });

  it('rejects fractional MiB values and saves whole MiB values', async () => {
    const user = userEvent.setup();
    renderPanel();
    const heading = await screen.findByRole('heading', { name: 'Allgemein' });
    const section = heading.closest('section');
    if (!section) throw new Error('Missing general settings section.');

    const mediaLimit = within(section).getByLabelText('Maximale Medien-Uploadgröße in MiB');
    const save = within(section).getByRole('button', { name: 'Speichern' });
    await user.clear(mediaLimit);
    await user.type(mediaLimit, '24.25');
    expect(save).toBeDisabled();

    await user.clear(mediaLimit);
    await user.type(mediaLimit, '24');
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(apiMock.updateSystemSettings).toHaveBeenCalledWith({ mediaUploadMaxBytes: 24 * 1024 * 1024 }, 4));
  });

  it('creates groups with the instance default currency without a separate currency field', async () => {
    const user = userEvent.setup();
    renderPanel();
    const heading = await screen.findByRole('heading', { name: 'Gruppenverwaltung' });
    const section = heading.closest('section');
    if (!section) throw new Error('Missing group management section.');

    const groupName = await within(section).findByLabelText('Gruppenname');
    expect(within(section).queryByLabelText('Währung')).not.toBeInTheDocument();
    await user.type(groupName, 'New Group');
    await user.type(within(section).getByLabelText('E-Mail des ersten Gruppenadministrators'), 'owner@example.test');
    await user.click(within(section).getByRole('button', { name: 'Gruppe erstellen' }));

    await waitFor(() => expect(apiMock.createSystemGroup).toHaveBeenCalledWith({
      name: 'New Group',
      currency: 'EUR',
      administratorEmail: 'owner@example.test',
    }));
  });

  it('shows and copies a manual first-administrator link when email delivery is not requested', async () => {
    apiMock.createSystemGroup.mockResolvedValue({
      group: { ...provisioningGroup, name: 'New Group', administratorEmail: 'new-account@example.test' },
      acceptUrl: 'https://teamtaler.example/invite#token=manual-token',
      emailDeliveryStatus: 'NOT_REQUESTED',
      expiresAt: '2026-08-23T12:00:00Z',
    });
    const user = userEvent.setup();
    renderPanel();
    const heading = await screen.findByRole('heading', { name: 'Gruppenverwaltung' });
    const section = heading.closest('section');
    if (!section) throw new Error('Missing group management section.');

    await user.type(await within(section).findByLabelText('Gruppenname'), 'New Group');
    await user.type(within(section).getByLabelText('E-Mail des ersten Gruppenadministrators'), 'new-account@example.test');
    await user.click(within(section).getByRole('button', { name: 'Gruppe erstellen' }));

    const dialog = await screen.findByRole('dialog', { name: 'Einladung für „New Group“ ist bereit' });
    expect(within(dialog).getByRole('status')).toHaveTextContent('Einladung ist bereit');
    expect(within(dialog).getByRole('status')).toHaveTextContent('Kopiere den Link und sende ihn an new-account@example.test.');
    expect(within(dialog).queryByText('Du kannst den Link auch direkt teilen.')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Der Link ist einmalig und bis 23.08.2026 gültig.')).toBeVisible();
    expect(within(dialog).getByLabelText('Einladungslink')).toHaveValue('https://teamtaler.example/invite#token=manual-token');
    await user.click(within(dialog).getByRole('button', { name: 'Kopieren' }));
    expect(await navigator.clipboard.readText()).toBe('https://teamtaler.example/invite#token=manual-token');
    expect(within(dialog).getByRole('button', { name: 'Kopiert' })).toBeVisible();
  });

  it('shows a managed group logo and falls back to the first letter', async () => {
    apiMock.getSystemGroups.mockResolvedValue([
      { ...archivedGroup, logoUrl: '/api/v1/system/groups/group-a/logo' },
      secondArchivedGroup,
    ]);
    renderPanel();

    const logoMark = await screen.findByTestId('system-group-mark-group-a');
    expect(logoMark.querySelector('img')).toHaveAttribute('src', '/api/v1/system/groups/group-a/logo');
    const fallbackMark = screen.getByTestId('system-group-mark-group-b');
    expect(fallbackMark).toHaveTextContent('G');
    expect(fallbackMark.querySelector('img')).not.toBeInTheDocument();
  });

  it('shows every group lifecycle micro-action with an icon and visible label', async () => {
    apiMock.getSystemGroups.mockResolvedValue([
      { ...archivedGroup, id: 'group-active', name: 'Active Group', status: 'ACTIVE' },
      provisioningGroup,
      archivedGroup,
    ]);
    renderPanel();

    for (const [accessibleName, visibleLabel] of [
      ['Einladung für Gruppe Group Pending erneuern', 'Einladung erneuern'],
      ['Gruppe Group A reaktivieren', 'Reaktivieren'],
      ['Gruppe Group A endgültig löschen', 'Endgültig löschen'],
    ]) {
      const action = await screen.findByRole('button', { name: accessibleName });
      expect(action.querySelector('svg')).toBeInTheDocument();
      expect(within(action).getByText(visibleLabel)).toBeVisible();
      expect(action.className).toContain('ghost');
      expect(action.className).not.toContain('collapseLabelAt');
    }
    for (const archiveButton of await screen.findAllByRole('button', { name: /^Gruppe .+ archivieren$/ })) {
      expect(archiveButton.querySelector('svg')).toBeInTheDocument();
      expect(within(archiveButton).getByText('Archivieren')).toBeVisible();
      expect(archiveButton.className).toContain('ghost');
    }
  });

  it('archives a group only after confirming in the shared application dialog', async () => {
    const user = userEvent.setup();
    const activeGroup = { ...archivedGroup, id: 'group-active', name: 'Active Group', status: 'ACTIVE' as const, archivedAt: null };
    apiMock.getSystemGroups.mockResolvedValue([activeGroup]);
    apiMock.archiveSystemGroup.mockResolvedValue({ ...activeGroup, status: 'ARCHIVED' });
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Gruppe Active Group archivieren' }));

    const dialog = screen.getByRole('dialog', { name: 'Gruppe archivieren?' });
    expect(within(dialog).getByText('Soll die Gruppe „Active Group“ wirklich archiviert werden? Alle regulären Zugriffe werden sofort gesperrt.')).toBeVisible();
    expect(apiMock.archiveSystemGroup).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Archivieren' }));

    await waitFor(() => expect(apiMock.archiveSystemGroup).toHaveBeenCalledWith('group-active', 4));
    expect(screen.queryByRole('dialog', { name: 'Gruppe archivieren?' })).not.toBeInTheDocument();
  });

  it('enables an exactly tested SMTP revision without resending unchanged connection fields', async () => {
    const user = userEvent.setup();
    renderPanel();
    const heading = await screen.findByRole('heading', { name: 'E-Mail (SMTP)' });
    const section = heading.closest('section');
    if (!section) throw new Error('Missing SMTP settings section.');

    const verifiedStatus = within(section).getByRole('status');
    expect(verifiedStatus).toHaveAttribute('data-status', 'verified');
    expect(within(verifiedStatus).getByText('Erfolgreich geprüft')).toBeVisible();
    expect(verifiedStatus.querySelector('svg')).toBeInTheDocument();
    expect(verifiedStatus.nextElementSibling).toContainElement(within(section).getByRole('button', { name: 'Testmail senden' }));

    await user.click(within(section).getByRole('switch', { name: 'SMTP-Versand aktiviert' }));
    await user.click(within(section).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(apiMock.updateSystemSmtp).toHaveBeenCalledWith({ enabled: true }, 4));
  });

  it('disables SMTP configuration fields while delivery is off and unlocks them with the switch', async () => {
    const user = userEvent.setup();
    apiMock.getSystemSettings.mockResolvedValue({
      ...settings,
      smtp: { ...settings.smtp, configurationValid: false, testStatus: 'UNTESTED', testedAt: null, testedRevision: null },
    });
    renderPanel();
    const heading = await screen.findByRole('heading', { name: 'E-Mail (SMTP)' });
    const section = heading.closest('section');
    if (!section) throw new Error('Missing SMTP settings section.');

    const configurationFields = [
      within(section).getByLabelText('SMTP-Host'),
      within(section).getByLabelText('Port'),
      within(section).getByLabelText('Transportverschlüsselung'),
      within(section).getByLabelText('Benutzername'),
      within(section).getByLabelText('Passwort'),
      within(section).getByLabelText('Absenderadresse'),
      within(section).getByLabelText('Absendername (optional)'),
    ];
    const enabledSwitch = within(section).getByRole('switch', { name: 'SMTP-Versand aktiviert' });
    const untestedStatus = within(section).getByRole('status');
    expect(within(section).getByLabelText('Port')).toHaveValue(587);
    expect(enabledSwitch).toBeEnabled();
    expect(within(untestedStatus).getByText('Noch nicht getestet')).toBeVisible();
    expect(within(untestedStatus).getByText('Sende eine Testmail, um den E-Mail-Versand zu prüfen.')).toBeVisible();
    for (const field of configurationFields) expect(field).toBeDisabled();

    await user.click(enabledSwitch);

    for (const field of configurationFields) expect(field).toBeEnabled();
    const portField = within(section).getByLabelText('Port');
    expect(portField).toHaveValue(587);
    await user.clear(portField);
    expect(portField).toHaveValue(null);
    expect(within(section).getByRole('button', { name: 'Speichern' })).toBeDisabled();
    await user.type(portField, '465');
    expect(portField).toHaveValue(465);
  });

  it('masks a stored SMTP password and only enables saving for a real replacement', async () => {
    const user = userEvent.setup();
    apiMock.getSystemSettings.mockResolvedValue({
      ...settings,
      smtp: { ...settings.smtp, active: true, enabled: value(true) },
    });
    renderPanel();
    const heading = await screen.findByRole('heading', { name: 'E-Mail (SMTP)' });
    const section = heading.closest('section');
    if (!section) throw new Error('Missing SMTP settings section.');

    const password = within(section).getByLabelText('Passwort');
    const save = within(section).getByRole('button', { name: 'Speichern' });
    expect(password).toHaveValue('');
    expect(password).toHaveAttribute('placeholder', '••••••••••••');
    expect(within(section).queryByText('Leer lassen, um das gespeicherte Passwort beizubehalten.')).not.toBeInTheDocument();
    expect(save).toBeDisabled();

    await user.type(password, 'replacement-secret');
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(apiMock.updateSystemSmtp).toHaveBeenCalledWith({ password: 'replacement-secret' }, 4));
  });

  it('saves changed SMTP connection values disabled until their revision is tested', async () => {
    const user = userEvent.setup();
    renderPanel();
    const heading = await screen.findByRole('heading', { name: 'E-Mail (SMTP)' });
    const section = heading.closest('section');
    if (!section) throw new Error('Missing SMTP settings section.');

    await user.click(within(section).getByRole('switch', { name: 'SMTP-Versand aktiviert' }));
    const host = within(section).getByLabelText('SMTP-Host');
    await user.clear(host);
    await user.type(host, 'smtp.changed.test');
    await user.click(within(section).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(apiMock.updateSystemSmtp).toHaveBeenCalledWith({ host: 'smtp.changed.test' }, 4));
  });

  it('allows an empty optional SMTP sender name without rendering setting provenance', async () => {
    const user = userEvent.setup();
    apiMock.getSystemSettings.mockResolvedValue({ ...settings, smtp: { ...settings.smtp, active: true, enabled: value(true) } });
    renderPanel();
    const heading = await screen.findByRole('heading', { name: 'E-Mail (SMTP)' });
    const section = heading.closest('section');
    if (!section) throw new Error('Missing SMTP settings section.');

    const senderName = within(section).getByLabelText('Absendername (optional)');
    expect(within(section).queryByText(/Quelle:/)).not.toBeInTheDocument();
    expect(within(section).queryByText(/Geändert:/)).not.toBeInTheDocument();
    expect(within(section).queryByText('Noch kein Passwort gespeichert.')).not.toBeInTheDocument();
    await user.clear(senderName);
    await user.click(within(section).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(apiMock.updateSystemSmtp).toHaveBeenCalledWith({ fromName: '' }, 4));
  });

  it('reloads SMTP state after a failed test so the persisted failure is visible', async () => {
    const user = userEvent.setup();
    apiMock.getSystemSettings
      .mockResolvedValueOnce(settings)
      .mockResolvedValueOnce({ ...settings, smtp: { ...settings.smtp, testStatus: 'FAILED' } });
    apiMock.testSystemSmtp.mockRejectedValue(new Error('SMTP unavailable'));
    renderPanel();
    const heading = await screen.findByRole('heading', { name: 'E-Mail (SMTP)' });
    const section = heading.closest('section');
    if (!section) throw new Error('Missing SMTP settings section.');

    await user.click(within(section).getByRole('button', { name: 'Testmail senden' }));

    await waitFor(() => expect(apiMock.getSystemSettings).toHaveBeenCalledTimes(2));
    const failedStatus = await within(section).findByRole('alert');
    expect(failedStatus).toHaveAttribute('data-status', 'failed');
    expect(within(failedStatus).getByText('Test fehlgeschlagen')).toBeVisible();
    expect(within(failedStatus).getByText('Die Testmail konnte nicht gesendet werden. Prüfe die SMTP-Daten und versuche es erneut.')).toBeVisible();
    expect(failedStatus.querySelector('svg')).toBeInTheDocument();
  });

  it('shows the current impact and requires only the exact group name before purge', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Gruppe Group A endgültig löschen' }));
    const dialog = screen.getByRole('dialog');
    const purgeButton = within(dialog).getByRole('button', { name: 'Endgültig löschen' });

    await waitFor(() => expect(apiMock.getSystemGroupDeletionImpact).toHaveBeenCalledWith('group-a'));
    expect(within(dialog).getByRole('heading', { name: '„Group A“ endgültig löschen?' })).toBeVisible();
    expect(within(dialog).getByRole('heading', { name: 'Das wird gelöscht' })).toBeVisible();
    expect(within(dialog).getByText('Mitglieder')).toBeVisible();
    expect(within(dialog).getByText('2')).toBeVisible();
    expect(within(dialog).getByText('Offener Gesamtsaldo')).toBeVisible();
    expect(within(dialog).getByText(/12,34\s€/)).toBeVisible();
    expect(within(dialog).queryByText('Einladungen')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Buchungen')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Finanzdatensätze')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Audit-Einträge')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Mediendateien')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Die Eingabe muss exakt mit dem Gruppennamen übereinstimmen.')).not.toBeInTheDocument();
    expect(purgeButton).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Gruppenname zur Bestätigung'), 'group a');
    expect(purgeButton).toBeDisabled();
    await user.clear(within(dialog).getByLabelText('Gruppenname zur Bestätigung'));
    await user.type(within(dialog).getByLabelText('Gruppenname zur Bestätigung'), 'Group A');
    expect(purgeButton).toBeEnabled();
    await user.click(purgeButton);

    await waitFor(() => expect(apiMock.purgeSystemGroup).toHaveBeenCalledWith('group-a', 5, { groupName: 'Group A' }));
  });

  it('clears the group-name confirmation after closing the purge dialog', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Gruppe Group A endgültig löschen' }));
    let dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Gruppenname zur Bestätigung'), 'Group A');
    await user.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));

    await user.click(await screen.findByRole('button', { name: 'Gruppe Group A endgültig löschen' }));
    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Gruppenname zur Bestätigung')).toHaveValue('');
  });

  it('does not carry purge confirmations across groups', async () => {
    const user = userEvent.setup();
    apiMock.getSystemGroups.mockResolvedValue([archivedGroup, secondArchivedGroup]);
    apiMock.getSystemGroupDeletionImpact.mockImplementation((groupId: string) => Promise.resolve({
      groupId,
      groupName: groupId === secondArchivedGroup.id ? secondArchivedGroup.name : archivedGroup.name,
      version: groupId === secondArchivedGroup.id ? secondArchivedGroup.version : archivedGroup.version,
      openBalance: { minorUnits: '1234', currency: 'EUR' },
      ...archivedGroup.impact,
    }));
    renderPanel();
    const purgeButtons = await screen.findAllByRole('button', { name: /^Gruppe Group [AB] endgültig löschen$/ });
    await user.click(purgeButtons[0]);
    let dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Gruppenname zur Bestätigung'), 'Group A');

    await user.click(purgeButtons[1]);

    dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByRole('heading', { name: '„Group B“ endgültig löschen?' })).toBeVisible();
    expect(within(dialog).getByLabelText('Gruppenname zur Bestätigung')).toHaveValue('');
  });

  it('resends only provisioning invitations with the current group revision', async () => {
    const user = userEvent.setup();
    let completeResend: ((result: { group: typeof provisioningGroup; acceptUrl: string; emailDeliveryStatus: 'NOT_REQUESTED'; expiresAt: string }) => void) | undefined;
    apiMock.getSystemGroups.mockResolvedValue([provisioningGroup, archivedGroup]);
    apiMock.resendSystemGroupInvitation.mockImplementation(() => new Promise((resolve) => { completeResend = resolve; }));
    renderPanel();

    const resend = await screen.findByRole('button', { name: 'Einladung für Gruppe Group Pending erneuern' });
    expect(screen.getAllByRole('button', { name: 'Einladung für Gruppe Group Pending erneuern' })).toHaveLength(1);
    await user.click(resend);

    expect(apiMock.resendSystemGroupInvitation).toHaveBeenCalledWith('group-p', 2);
    expect(screen.getByRole('button', { name: 'Einladung für Gruppe Group Pending erneuern' })).toBeDisabled();
    expect(screen.getByText('Einladung wird erneuert …')).toBeVisible();
    completeResend?.({ group: { ...provisioningGroup, version: 3 }, acceptUrl: 'https://teamtaler.example/invite#token=replaced', emailDeliveryStatus: 'NOT_REQUESTED', expiresAt: '2026-08-23T12:00:00Z' });
    await waitFor(() => expect(apiMock.getSystemGroups).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('dialog', { name: 'Einladung für „Group Pending“ ist bereit' })).toBeVisible();
  });

  it('shows an invitation-specific error after a resend failure', async () => {
    const user = userEvent.setup();
    apiMock.getSystemGroups.mockResolvedValue([provisioningGroup]);
    apiMock.resendSystemGroupInvitation.mockRejectedValue(new Error('request failed'));
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Einladung für Gruppe Group Pending erneuern' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Die Einladung konnte nicht erneuert werden.');
    await waitFor(() => expect(apiMock.getSystemGroups).toHaveBeenCalledTimes(2));
  });
});
