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
  resetSystemSetting: vi.fn(),
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
  createSystemStepUp: vi.fn(),
  purgeSystemGroup: vi.fn(),
  getSystemAudit: vi.fn(),
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
    apiMock.getSystemSettings.mockResolvedValue(settings);
    apiMock.updateSystemSettings.mockResolvedValue(settings);
    apiMock.resetSystemSetting.mockResolvedValue(settings);
    apiMock.updateSystemSmtp.mockResolvedValue(settings);
    apiMock.resetSystemSmtp.mockResolvedValue(settings);
    apiMock.testSystemSmtp.mockResolvedValue(settings);
    apiMock.getSystemAdministrators.mockResolvedValue([{ id: 'system-user', displayName: 'System Admin', email: 'admin@example.test', active: true }]);
    apiMock.searchSystemAccounts.mockResolvedValue([]);
    apiMock.getSystemGroups.mockResolvedValue([archivedGroup]);
    apiMock.createSystemGroup.mockResolvedValue(archivedGroup);
    apiMock.archiveSystemGroup.mockResolvedValue(archivedGroup);
    apiMock.restoreSystemGroup.mockResolvedValue({ ...archivedGroup, status: 'ACTIVE', version: 5 });
    apiMock.resendSystemGroupInvitation.mockResolvedValue({ ...provisioningGroup, version: 3 });
    apiMock.getSystemGroupDeletionImpact.mockResolvedValue({ groupId: 'group-a', groupName: 'Group A', version: 5, ...archivedGroup.impact });
    apiMock.createSystemStepUp.mockResolvedValue({ stepUpToken: 'one-use-token', expiresAt: '2026-08-15T12:05:00Z' });
    apiMock.purgeSystemGroup.mockResolvedValue({ groupId: 'group-a', groupName: 'Group A', version: 5, ...archivedGroup.impact });
    apiMock.getSystemAudit.mockResolvedValue([]);
  });

  it('loads all five instance-administration areas in parallel', async () => {
    renderPanel();

    for (const name of ['Allgemein', 'E-Mail (SMTP)', 'Zugriff und Wartung', 'Gruppenverwaltung', 'Systemaktivität']) {
      expect(await screen.findByRole('heading', { name })).toBeVisible();
    }
    expect(screen.getByText('admin@example.test')).toBeVisible();
    expect(screen.getByText('Group A')).toBeVisible();
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

  it('enables an exactly tested SMTP revision without resending unchanged connection fields', async () => {
    const user = userEvent.setup();
    renderPanel();
    const heading = await screen.findByRole('heading', { name: 'E-Mail (SMTP)' });
    const section = heading.closest('section');
    if (!section) throw new Error('Missing SMTP settings section.');

    await user.click(within(section).getByRole('switch', { name: 'SMTP-Versand aktiviert' }));
    await user.click(within(section).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(apiMock.updateSystemSmtp).toHaveBeenCalledWith({ enabled: true }, 4));
  });

  it('allows an empty optional SMTP sender name and shows redacted setting provenance', async () => {
    const user = userEvent.setup();
    renderPanel();
    const heading = await screen.findByRole('heading', { name: 'E-Mail (SMTP)' });
    const section = heading.closest('section');
    if (!section) throw new Error('Missing SMTP settings section.');

    const senderName = within(section).getByLabelText('Absendername (optional)');
    expect(within(section).getAllByText('Quelle: Web- oder CLI-Override').length).toBeGreaterThan(0);
    expect(within(section).getAllByText(/Geändert:/).length).toBeGreaterThan(0);
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
    expect(await within(section).findByText('Test fehlgeschlagen')).toBeVisible();
  });

  it('requires current impact, password step-up, exact name, and phrase before purge', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Endgültig löschen' }));
    const dialog = screen.getByRole('dialog');

    await waitFor(() => expect(apiMock.getSystemGroupDeletionImpact).toHaveBeenCalledWith('group-a'));
    await user.type(within(dialog).getByLabelText('Aktuelles Passwort'), 'current-password');
    await user.type(within(dialog).getByLabelText('Exakten Gruppennamen eingeben'), 'Group A');
    await user.type(within(dialog).getByLabelText('Bestätigungsphrase eingeben'), 'ENDGÜLTIG LÖSCHEN');
    await user.click(within(dialog).getByRole('button', { name: 'Endgültig löschen' }));

    await waitFor(() => expect(apiMock.createSystemStepUp).toHaveBeenCalledWith('current-password'));
    expect(apiMock.purgeSystemGroup).toHaveBeenCalledWith('group-a', 5, { stepUpToken: 'one-use-token', groupName: 'Group A', confirmationPhrase: 'ENDGÜLTIG LÖSCHEN' });
  });

  it('clears every purge confirmation after closing and after a failed step-up attempt', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Endgültig löschen' }));
    let dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Aktuelles Passwort'), 'current-password');
    await user.type(within(dialog).getByLabelText('Exakten Gruppennamen eingeben'), 'Group A');
    await user.type(within(dialog).getByLabelText('Bestätigungsphrase eingeben'), 'ENDGÜLTIG LÖSCHEN');
    await user.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));

    await user.click(await screen.findByRole('button', { name: 'Endgültig löschen' }));
    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Aktuelles Passwort')).toHaveValue('');
    expect(within(dialog).getByLabelText('Exakten Gruppennamen eingeben')).toHaveValue('');
    expect(within(dialog).getByLabelText('Bestätigungsphrase eingeben')).toHaveValue('');

    apiMock.createSystemStepUp.mockRejectedValueOnce(new Error('Invalid password'));
    await user.type(within(dialog).getByLabelText('Aktuelles Passwort'), 'wrong-password');
    await user.type(within(dialog).getByLabelText('Exakten Gruppennamen eingeben'), 'Group A');
    await user.type(within(dialog).getByLabelText('Bestätigungsphrase eingeben'), 'ENDGÜLTIG LÖSCHEN');
    await user.click(within(dialog).getByRole('button', { name: 'Endgültig löschen' }));

    expect(await within(dialog).findByRole('alert')).toBeVisible();
    expect(within(dialog).getByLabelText('Aktuelles Passwort')).toHaveValue('');
    expect(within(dialog).getByLabelText('Exakten Gruppennamen eingeben')).toHaveValue('');
    expect(within(dialog).getByLabelText('Bestätigungsphrase eingeben')).toHaveValue('');
  });

  it('does not carry purge confirmations across groups', async () => {
    const user = userEvent.setup();
    apiMock.getSystemGroups.mockResolvedValue([archivedGroup, secondArchivedGroup]);
    apiMock.getSystemGroupDeletionImpact.mockImplementation((groupId: string) => Promise.resolve({
      groupId,
      groupName: groupId === secondArchivedGroup.id ? secondArchivedGroup.name : archivedGroup.name,
      version: groupId === secondArchivedGroup.id ? secondArchivedGroup.version : archivedGroup.version,
      ...archivedGroup.impact,
    }));
    renderPanel();
    const purgeButtons = await screen.findAllByRole('button', { name: 'Endgültig löschen' });
    await user.click(purgeButtons[0]);
    let dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Aktuelles Passwort'), 'current-password');
    await user.type(within(dialog).getByLabelText('Exakten Gruppennamen eingeben'), 'Group A');
    await user.type(within(dialog).getByLabelText('Bestätigungsphrase eingeben'), 'ENDGÜLTIG LÖSCHEN');

    await user.click(purgeButtons[1]);

    dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText('Group B')).toBeVisible();
    expect(within(dialog).getByLabelText('Aktuelles Passwort')).toHaveValue('');
    expect(within(dialog).getByLabelText('Exakten Gruppennamen eingeben')).toHaveValue('');
    expect(within(dialog).getByLabelText('Bestätigungsphrase eingeben')).toHaveValue('');
  });

  it('resends only provisioning invitations with the current group revision', async () => {
    const user = userEvent.setup();
    let completeResend: ((group: typeof provisioningGroup) => void) | undefined;
    apiMock.getSystemGroups.mockResolvedValue([provisioningGroup, archivedGroup]);
    apiMock.resendSystemGroupInvitation.mockImplementation(() => new Promise((resolve) => { completeResend = resolve; }));
    renderPanel();

    const resend = await screen.findByRole('button', { name: 'Einladung erneut senden' });
    expect(screen.getAllByRole('button', { name: 'Einladung erneut senden' })).toHaveLength(1);
    await user.click(resend);

    expect(apiMock.resendSystemGroupInvitation).toHaveBeenCalledWith('group-p', 2);
    expect(screen.getByRole('button', { name: 'Einladung wird gesendet …' })).toBeDisabled();
    completeResend?.({ ...provisioningGroup, version: 3 });
    await waitFor(() => expect(apiMock.getSystemGroups).toHaveBeenCalledTimes(2));
  });

  it('shows an invitation-specific error after a resend failure', async () => {
    const user = userEvent.setup();
    apiMock.getSystemGroups.mockResolvedValue([provisioningGroup]);
    apiMock.resendSystemGroupInvitation.mockRejectedValue(new Error('SMTP unavailable'));
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Einladung erneut senden' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Die Einladung konnte nicht erneut gesendet werden.');
    await waitFor(() => expect(apiMock.getSystemGroups).toHaveBeenCalledTimes(2));
  });
});
