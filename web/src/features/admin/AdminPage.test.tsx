import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminPage } from './AdminPage';

const mocks = vi.hoisted(() => ({ useActiveGroup: vi.fn(), session: { systemRoles: [] as string[] } }));

vi.mock('@/app/useActiveGroup', () => ({ useOptionalActiveGroup: () => mocks.useActiveGroup() }));
vi.mock('@/app/useSession', () => ({ useSession: () => mocks.session, isSystemAdministrator: (session: { systemRoles?: string[] }) => session.systemRoles?.includes('SYSTEM_ADMINISTRATOR') === true }));
vi.mock('./AuditPanel', () => ({ AuditPanel: () => <div>audit-panel</div> }));
vi.mock('./BehaviorSettingsPanel', () => ({ BehaviorSettingsPanel: () => <div>settings-panel</div> }));
vi.mock('./MembersPanel', () => ({ MembersPanel: () => <div>members-panel</div> }));
vi.mock('./RightsPanel', () => ({ RightsPanel: () => <div>rights-panel</div> }));
vi.mock('./SystemSettingsPanel', () => ({ SystemSettingsPanel: () => <div>system-panel</div> }));

describe('AdminPage workspace separation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.systemRoles = [];
    mocks.useActiveGroup.mockReturnValue({ activeGroup: { membership: { effectiveGrants: [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }, { permission: 'MEMBER_MANAGEMENT', scope: { type: 'GROUP' } }, { permission: 'ROLE_MANAGEMENT', scope: { type: 'GROUP' } }] } } });
  });

  it('contains neither catalog nor finance tabs', () => {
    render(<AdminPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Allgemein', 'Mitglieder', 'Rollen & Rechte', 'Audit']);
    expect(screen.queryByRole('tab', { name: 'Katalog' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Finanzen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Abrechnungen' })).not.toBeInTheDocument();
  });

  it('implements automatic ARIA tab activation with roving keyboard focus', async () => {
    const user = userEvent.setup();
    render(<AdminPage />);
    const settingsTab = screen.getByRole('tab', { name: 'Allgemein' });
    const membersTab = screen.getByRole('tab', { name: 'Mitglieder' });
    const auditTab = screen.getByRole('tab', { name: 'Audit' });

    expect(settingsTab).toHaveAttribute('tabindex', '0');
    expect(membersTab).toHaveAttribute('tabindex', '-1');
    expect(settingsTab).toHaveAttribute('aria-controls', screen.getByRole('tabpanel').id);
    settingsTab.focus();
    await user.keyboard('{ArrowRight}');

    expect(membersTab).toHaveFocus();
    expect(membersTab).toHaveAttribute('aria-selected', 'true');
    expect(membersTab).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', membersTab.id);
    expect(screen.getByText('members-panel')).toBeVisible();

    await user.keyboard('{End}');
    expect(auditTab).toHaveFocus();
    expect(screen.getByText('audit-panel')).toBeVisible();
    await user.keyboard('{Home}');
    expect(settingsTab).toHaveFocus();
    expect(screen.getByText('settings-panel')).toBeVisible();
    await user.keyboard('{ArrowLeft}');
    expect(auditTab).toHaveFocus();
  });

  it('denies the administration workspace to a pure finance manager', () => {
    mocks.useActiveGroup.mockReturnValue({ activeGroup: { membership: { effectiveGrants: [{ permission: 'FINANCE_MANAGEMENT', scope: { type: 'GROUP' } }] } } });
    render(<AdminPage />);
    expect(screen.getByText('Kein Zugriff')).toBeVisible();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('denies the administration workspace to a pure catalog manager', () => {
    mocks.useActiveGroup.mockReturnValue({ activeGroup: { membership: { effectiveGrants: [{ permission: 'CATALOG_MANAGEMENT', scope: { type: 'GROUP' } }] } } });
    render(<AdminPage />);
    expect(screen.getByText('Kein Zugriff')).toBeVisible();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('does not mount the protected member directory for a role manager without directory access', () => {
    mocks.useActiveGroup.mockReturnValue({ activeGroup: { membership: { effectiveGrants: [{ permission: 'ROLE_MANAGEMENT', scope: { type: 'GROUP' } }] } } });

    render(<AdminPage />);

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Rollen & Rechte']);
    expect(screen.getByText('rights-panel')).toBeVisible();
    expect(screen.queryByText('members-panel')).not.toBeInTheDocument();
    expect(screen.queryByText('settings-panel')).not.toBeInTheDocument();
    expect(screen.queryByText('audit-panel')).not.toBeInTheDocument();
  });

  it('keeps the legacy directory grant hidden from a role manager', () => {
    mocks.useActiveGroup.mockReturnValue({ activeGroup: { membership: { effectiveGrants: [{ permission: 'ROLE_MANAGEMENT', scope: { type: 'GROUP' } }, { permission: 'VIEW_MEMBER_DIRECTORY', scope: { type: 'GROUP' } }] } } });

    render(<AdminPage />);

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Rollen & Rechte']);
    expect(screen.queryByText('members-panel')).not.toBeInTheDocument();
  });

  it('keeps group configuration independent from member management', () => {
    mocks.useActiveGroup.mockReturnValue({ activeGroup: { membership: { effectiveGrants: [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }] } } });

    render(<AdminPage />);

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Allgemein', 'Audit']);
    expect(screen.queryByRole('tab', { name: 'Mitglieder' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Rollen & Rechte' })).not.toBeInTheDocument();
  });

  it('mounts general defaults and members for pure member management', () => {
    mocks.useActiveGroup.mockReturnValue({ activeGroup: { membership: { effectiveGrants: [{ permission: 'MEMBER_MANAGEMENT', scope: { type: 'GROUP' } }] } } });

    render(<AdminPage />);

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Allgemein', 'Mitglieder']);
    expect(screen.getByText('settings-panel')).toBeVisible();
    expect(screen.queryByText('members-panel')).not.toBeInTheDocument();
  });

  it('places the system workspace first for a system administrator with a group', async () => {
    mocks.session.systemRoles = ['SYSTEM_ADMINISTRATOR'];

    render(<AdminPage />);

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['System', 'Allgemein', 'Mitglieder', 'Rollen & Rechte', 'Audit']);
    expect(await screen.findByText('system-panel')).toBeVisible();
    expect(screen.queryByText('settings-panel')).not.toBeInTheDocument();
  });

  it('mounts only the system workspace without a group context', async () => {
    mocks.session.systemRoles = ['SYSTEM_ADMINISTRATOR'];
    mocks.useActiveGroup.mockReturnValue(null);

    render(<AdminPage />);

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['System']);
    expect(await screen.findByText('system-panel')).toBeVisible();
    expect(screen.queryByText('members-panel')).not.toBeInTheDocument();
  });
});
