import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { CatalogPage } from './CatalogPage';

const mocks = vi.hoisted(() => ({ useActiveGroup: vi.fn() }));

vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => mocks.useActiveGroup() }));
vi.mock('./CatalogPanel', () => ({ CatalogPanel: () => <div>catalog-editor</div> }));

describe('CatalogPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['CATALOG_MANAGER', 'ADMIN'] as const)('mounts the editor for %s memberships', (role) => {
    mocks.useActiveGroup.mockReturnValue({ activeGroup: { membership: { roles: [role, 'MEMBER'] } } });
    render(<CatalogPage />);

    expect(screen.getByText('catalog-editor')).toBeVisible();
  });

  it('does not mount the editor without catalog rights', () => {
    mocks.useActiveGroup.mockReturnValue({ activeGroup: { membership: { roles: ['FINANCE_MANAGER', 'MEMBER'] } } });
    render(<CatalogPage />);

    expect(screen.getByText(i18n.t('catalog.noAccessTitle'))).toBeVisible();
    expect(screen.queryByText('catalog-editor')).not.toBeInTheDocument();
  });
});
