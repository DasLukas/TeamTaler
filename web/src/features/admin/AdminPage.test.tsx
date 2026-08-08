import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminPage } from './AdminPage';

const mocks = vi.hoisted(() => ({ useActiveGroup: vi.fn() }));

vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => mocks.useActiveGroup() }));
vi.mock('./AuditPanel', () => ({ AuditPanel: () => <div>audit-panel</div> }));
vi.mock('./BehaviorSettingsPanel', () => ({ BehaviorSettingsPanel: () => <div>settings-panel</div> }));
vi.mock('./GroupSettingsPanel', () => ({ GroupSettingsPanel: () => <div>group-panel</div> }));
vi.mock('./MembersPanel', () => ({ MembersPanel: () => <div>members-panel</div> }));
vi.mock('./RightsPanel', () => ({ RightsPanel: () => <div>rights-panel</div> }));

describe('AdminPage workspace separation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useActiveGroup.mockReturnValue({ activeGroup: { membership: { effectiveGrants: [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }, { permission: 'ROLE_MANAGEMENT', scope: { type: 'GROUP' } }] } } });
  });

  it('contains neither catalog nor finance tabs', () => {
    render(<AdminPage />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Gruppe', 'Einstellungen', 'Mitglieder', 'Rollen & Rechte', 'Audit']);
    expect(screen.queryByRole('tab', { name: 'Katalog' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Finanzen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Abrechnungen' })).not.toBeInTheDocument();
  });

  it('implements automatic ARIA tab activation with roving keyboard focus', async () => {
    const user = userEvent.setup();
    render(<AdminPage />);
    const groupTab = screen.getByRole('tab', { name: 'Gruppe' });
    const settingsTab = screen.getByRole('tab', { name: 'Einstellungen' });
    const auditTab = screen.getByRole('tab', { name: 'Audit' });

    expect(groupTab).toHaveAttribute('tabindex', '0');
    expect(settingsTab).toHaveAttribute('tabindex', '-1');
    expect(groupTab).toHaveAttribute('aria-controls', screen.getByRole('tabpanel').id);
    groupTab.focus();
    await user.keyboard('{ArrowRight}');

    expect(settingsTab).toHaveFocus();
    expect(settingsTab).toHaveAttribute('aria-selected', 'true');
    expect(settingsTab).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', settingsTab.id);
    expect(screen.getByText('settings-panel')).toBeVisible();

    await user.keyboard('{End}');
    expect(auditTab).toHaveFocus();
    expect(screen.getByText('audit-panel')).toBeVisible();
    await user.keyboard('{Home}');
    expect(groupTab).toHaveFocus();
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

  it('mounts members and role definitions for a role manager without group administration', () => {
    mocks.useActiveGroup.mockReturnValue({ activeGroup: { membership: { effectiveGrants: [{ permission: 'ROLE_MANAGEMENT', scope: { type: 'GROUP' } }] } } });

    render(<AdminPage />);

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Mitglieder', 'Rollen & Rechte']);
    expect(screen.getByText('members-panel')).toBeVisible();
    expect(screen.queryByText('rights-panel')).not.toBeInTheDocument();
    expect(screen.queryByText('settings-panel')).not.toBeInTheDocument();
    expect(screen.queryByText('audit-panel')).not.toBeInTheDocument();
  });

  it('keeps member lifecycle and administrator transfer available without role management', () => {
    mocks.useActiveGroup.mockReturnValue({ activeGroup: { membership: { effectiveGrants: [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }] } } });

    render(<AdminPage />);

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Gruppe', 'Einstellungen', 'Mitglieder', 'Audit']);
    expect(screen.queryByRole('tab', { name: 'Rollen & Rechte' })).not.toBeInTheDocument();
  });
});
