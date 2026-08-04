import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Category, Product, Session } from '@/api/types';
import { ActiveGroupContext } from '@/app/active-group-context';
import i18n from '@/i18n';
import { CatalogPanel } from './CatalogPanel';

const apiMock = vi.hoisted(() => ({
  getCategories: vi.fn(),
  createCategory: vi.fn(),
  createProduct: vi.fn(),
  uploadProductImage: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: apiMock }));

const category: Category = {
  id: 'category-a',
  name: 'Drinks',
  type: 'STANDARD',
  icon: 'drink',
  active: true,
  products: [],
};

const createdProduct: Product = {
  id: 'product-created',
  categoryId: category.id,
  version: 1,
  name: 'Water',
  price: { minorUnits: '100', currency: 'EUR' },
  active: true,
  sortOrder: 0,
};

const session: Session = {
  user: { id: 'user-a', displayName: 'Alex', email: 'alex@example.test' },
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: 'member-a', roles: ['CATALOG_MANAGER', 'MEMBER'] } }],
  activeGroupId: 'group-a',
};

function renderCatalog(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ActiveGroupContext.Provider value={{ session, activeGroup: session.groups[0], activeGroupId: 'group-a', setActiveGroupId: vi.fn() }}>
        {children}
      </ActiveGroupContext.Provider>
    </QueryClientProvider>
  );
  render(<CatalogPanel />, { wrapper });
}

describe('CatalogPanel product image recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getCategories.mockResolvedValue([category]);
    apiMock.createProduct.mockResolvedValue(createdProduct);
  });

  it('keeps the created product and retries only its image after upload failure', async () => {
    const user = userEvent.setup();
    const firstImage = new File(['first'], 'first.webp', { type: 'image/webp' });
    const replacementImage = new File(['replacement'], 'replacement.png', { type: 'image/png' });
    apiMock.uploadProductImage
      .mockRejectedValueOnce(new Error('upload failed'))
      .mockResolvedValueOnce({ imageUrl: '/api/v1/groups/group-a/products/product-created/image' });
    renderCatalog();

    await screen.findByText(i18n.t('catalog.title'));
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.productAction') }));
    await user.type(screen.getByLabelText(i18n.t('catalog.productName')), createdProduct.name);
    await user.type(screen.getByLabelText(i18n.t('catalog.price', { currency: 'EUR' })), '1,00');
    await user.upload(screen.getByLabelText(i18n.t('catalog.image')), firstImage);
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.createProductAction') }));

    expect(await screen.findByText(i18n.t('catalog.partialSuccessTitle'))).toBeVisible();
    expect(await screen.findByText(/upload failed/)).toHaveAttribute('role', 'alert');
    expect(apiMock.createProduct).toHaveBeenCalledTimes(1);
    expect(apiMock.uploadProductImage).toHaveBeenNthCalledWith(1, 'group-a', createdProduct.id, firstImage);

    await user.upload(screen.getByLabelText(i18n.t('catalog.image')), replacementImage);
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.retryImage') }));

    await waitFor(() => expect(screen.queryByText(i18n.t('catalog.partialSuccessTitle'))).not.toBeInTheDocument());
    expect(apiMock.createProduct).toHaveBeenCalledTimes(1);
    expect(apiMock.uploadProductImage).toHaveBeenCalledTimes(2);
    expect(apiMock.uploadProductImage).toHaveBeenNthCalledWith(2, 'group-a', createdProduct.id, replacementImage);
  });
});
