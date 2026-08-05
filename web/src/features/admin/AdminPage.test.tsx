import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminPage } from './AdminPage';

const mocks = vi.hoisted(() => ({ useActiveGroup: vi.fn() }));

vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => mocks.useActiveGroup() }));
vi.mock('./AuditPanel', () => ({ AuditPanel: () => <div>audit-panel</div> }));
vi.mock('./GroupSettingsPanel', () => ({ GroupSettingsPanel: () => <div>group-panel</div> }));
vi.mock('./MembersPanel', () => ({ MembersPanel: () => <div>members-panel</div> }));
vi.mock('./RightsPanel', () => ({ RightsPanel: () => <div>rights-panel</div> }));

describe('AdminPage workspace separation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useActiveGroup.mockReturnValue({ activeGroup: { membership: { roles: ['ADMIN', 'MEMBER'] } } });
  });

  it('contains neither catalog nor finance tabs', () => {
    render(<AdminPage />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Gruppe', 'Mitglieder', 'Rollen & Rechte', 'Audit']);
    expect(screen.queryByRole('tab', { name: 'Katalog' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Finanzen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Abrechnungen' })).not.toBeInTheDocument();
  });

  it('denies the administration workspace to a pure finance manager', () => {
    mocks.useActiveGroup.mockReturnValue({ activeGroup: { membership: { roles: ['FINANCE_MANAGER', 'MEMBER'] } } });
    render(<AdminPage />);
    expect(screen.getByText('Kein Zugriff')).toBeVisible();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('denies the administration workspace to a pure catalog manager', () => {
    mocks.useActiveGroup.mockReturnValue({ activeGroup: { membership: { roles: ['CATALOG_MANAGER', 'MEMBER'] } } });
    render(<AdminPage />);
    expect(screen.getByText('Kein Zugriff')).toBeVisible();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});
