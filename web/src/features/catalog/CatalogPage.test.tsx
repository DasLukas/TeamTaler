import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { CatalogPage } from './CatalogPage';

const mocks = vi.hoisted(() => ({ useActiveGroup: vi.fn() }));

vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => mocks.useActiveGroup() }));
vi.mock('./CatalogPanel', () => ({ CatalogPanel: () => <div>catalog-editor</div> }));

describe('CatalogPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts the editor with the catalog-management grant', () => {
    mocks.useActiveGroup.mockReturnValue({ activeGroup: { membership: { effectiveGrants: [{ permission: 'CATALOG_MANAGEMENT', scope: { type: 'GROUP' } }] } } });
    render(<CatalogPage />);

    expect(screen.getByText('catalog-editor')).toBeVisible();
  });

  it('does not mount the editor without catalog rights', () => {
    mocks.useActiveGroup.mockReturnValue({ activeGroup: { membership: { effectiveGrants: [{ permission: 'FINANCE_MANAGEMENT', scope: { type: 'GROUP' } }] } } });
    render(<CatalogPage />);

    expect(screen.getByText(i18n.t('catalog.noAccessTitle'))).toBeVisible();
    expect(screen.queryByText('catalog-editor')).not.toBeInTheDocument();
  });
});
