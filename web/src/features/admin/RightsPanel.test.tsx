import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@/api/types';
import { RightsPanel } from './RightsPanel';

const mocks = vi.hoisted(() => ({
  getRoles: vi.fn(),
  getPermissionDefinitions: vi.fn(),
  getRoleAssignments: vi.fn(),
  getMembers: vi.fn(),
  getInvitations: vi.fn(),
  getGroupSettings: vi.fn(),
  updateRole: vi.fn(),
  useActiveGroup: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: mocks }));
vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => mocks.useActiveGroup() }));

const baseRole: Role = {
  id: 'role-member',
  presetKey: 'MEMBER',
  name: 'Member',
  description: 'Editable starter role for regular group members.',
  grants: [
    { permission: 'CREATE_OWN_BOOKING', scope: { type: 'GROUP' } },
    { permission: 'VOID_OWN_BOOKING', scope: { type: 'GROUP' } },
  ],
  version: 1,
  memberCount: 1,
  pendingInvitationCount: 0,
};

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  render(<RightsPanel />, { wrapper });
}

describe('RightsPanel role definitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useActiveGroup.mockReturnValue({
      activeGroupId: 'group-a',
      activeGroup: { id: 'group-a', membership: { effectiveGrants: [{ permission: 'ROLE_MANAGEMENT', scope: { type: 'GROUP' } }] } },
    });
    mocks.getRoles.mockResolvedValue([baseRole]);
    mocks.getPermissionDefinitions.mockResolvedValue([{ key: 'VOID_OWN_BOOKING' }]);
    mocks.getGroupSettings.mockResolvedValue({ notificationEmailsEnabled: false, notificationEmailDeliveryAvailable: true, defaultRoleId: 'role-member' });
    mocks.updateRole.mockResolvedValue({ ...baseRole, grants: [], version: 2 });
  });

  it('contains only role definitions and never loads assignment subjects', async () => {
    renderPanel();

    expect(await screen.findByRole('button', { name: 'Rolle anlegen' })).toBeVisible();
    expect(screen.queryByText('Rollenzuweisungen')).not.toBeInTheDocument();
    expect(mocks.getRoleAssignments).not.toHaveBeenCalled();
    expect(mocks.getMembers).not.toHaveBeenCalled();
    expect(mocks.getInvitations).not.toHaveBeenCalled();
  });

  it('keeps assignment counts visible and marks the default role with a labelled icon', async () => {
    mocks.useActiveGroup.mockReturnValue({
      activeGroupId: 'group-a',
      activeGroup: { id: 'group-a', membership: { effectiveGrants: [{ permission: 'ROLE_MANAGEMENT', scope: { type: 'GROUP' } }, { permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }] } },
    });
    mocks.getRoles.mockResolvedValue([{ ...baseRole, memberCount: 3, pendingInvitationCount: 2 }]);
    renderPanel();

    const roleButton = await screen.findByRole('button', { name: /Mitglied/ });
    expect(within(roleButton).getByText('3 Mitglieder · 2 Einladungen')).toBeVisible();
    expect(within(roleButton).getByRole('img', { name: 'Standardrolle für neue Mitglieder' })).toHaveAttribute('title', 'Standardrolle für neue Mitglieder');
  });

  it('localizes an unchanged preset description in the editor', async () => {
    renderPanel();

    expect(await screen.findByLabelText('Beschreibung')).toHaveValue('Bearbeitbare Startrolle für reguläre Gruppenmitglieder.');
    expect(screen.queryByText('Vordefiniert')).not.toBeInTheDocument();
  });

  it('uses concise descriptions for booking and balance permissions', async () => {
    mocks.getPermissionDefinitions.mockResolvedValue([
      { key: 'VIEW_GROUP_STATISTICS' },
      { key: 'RECORD_OWN_PAYMENT' },
      { key: 'CREATE_OWN_BOOKING' },
      { key: 'VOID_OWN_BOOKING' },
      { key: 'BOOK_FOR_OTHERS' },
      { key: 'BOOK_FOR_GUESTS' },
    ]);
    renderPanel();

    expect(await screen.findByText('Zeigt die Buchungssummen der Gruppe.')).toBeVisible();
    expect(screen.getByText('Erlaubt Einzahlungen auf das eigene Konto.')).toBeVisible();
    expect(screen.getByText('Erlaubt Buchungen auf das eigene Konto.')).toBeVisible();
    expect(screen.getByText('Erlaubt Stornos von selbst erstellten oder dem eigenen Konto zugewiesenen Buchungen.')).toBeVisible();
    expect(screen.getByText('Buchungen für andere Mitglieder.')).toBeVisible();
    expect(screen.getByText('Buchungen für Gäste ohne eigenes Konto.')).toBeVisible();
  });

  it('starts a copied role from the duplicate action in the editor title row', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Duplizieren' }));

    expect(screen.getByRole('heading', { name: 'Mitglied (Kopie)' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Duplizieren' })).not.toBeInTheDocument();
  });

  it('communicates a locked administrator name through the disabled input alone', async () => {
    mocks.getRoles.mockResolvedValue([{ ...baseRole, id: 'role-admin', presetKey: 'GROUP_ADMINISTRATOR', name: 'Group administrator', nameLocked: true }]);
    renderPanel();

    expect(await screen.findByLabelText('Rollenname')).toBeDisabled();
    expect(screen.queryByText('Der Name dieser Sicherheitsrolle ist unveränderlich.')).not.toBeInTheDocument();
    expect(screen.queryByText('Vordefiniert')).not.toBeInTheDocument();
  });

  it('keeps computed implications without the redundant arbitrary-void explanation', async () => {
    mocks.getRoles.mockResolvedValue([{ ...baseRole, grants: [{ permission: 'VOID_ANY_BOOKING', scope: { type: 'GROUP' } }] }]);
    mocks.getPermissionDefinitions.mockResolvedValue([
      { key: 'VIEW_ALL_BOOKING_ACTIVITY' },
      { key: 'VOID_OWN_BOOKING' },
      { key: 'VOID_ANY_BOOKING' },
    ]);
    renderPanel();

    expect(await screen.findByRole('switch', { name: 'Recht „Stornierung fremde Buchung“ umschalten' })).toBeChecked();
    expect(screen.getAllByText('Automatisch enthalten')).toHaveLength(2);
    expect(screen.queryByText('Enthält automatisch Eigenstorno und Gesamt-Aktivitäten.')).not.toBeInTheDocument();
  });

  it('saves permission changes directly without technical guidance or a second confirmation', async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(await screen.findByRole('button', { name: 'Speichern' })).toBeDisabled();
    expect(screen.queryByText(/Datenmodell.*Kategorie- und Produktbereiche/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Rechte werden additiv über alle zugewiesenen Rollen kombiniert.')).not.toBeInTheDocument();
    expect(screen.queryByText('Gesamte Gruppe')).not.toBeInTheDocument();
    expect(screen.queryByText('Enthält automatisch Eigenstorno und Gesamt-Aktivitäten.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Recht „Stornierung eigene Buchung“ umschalten' }));
    await user.click(screen.getByRole('button', { name: 'Speichern' }));

    expect(screen.queryByText('Diese Änderung wirkt sofort')).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.updateRole).toHaveBeenCalledWith('group-a', 'role-member', {
      name: 'Member',
      description: 'Editable starter role for regular group members.',
      grants: [{ permission: 'CREATE_OWN_BOOKING', scope: { type: 'GROUP' } }],
    }, 1));
  });
});
