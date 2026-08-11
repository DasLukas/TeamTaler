import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
  reorderCatalog: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  deleteProduct: vi.fn(),
  uploadProductImage: vi.fn(),
}));
const imageUploadMock = vi.hoisted(() => ({ prepareSquareImage: vi.fn() }));

vi.mock('@/api/client', () => ({ api: apiMock }));
vi.mock('@/components/media/imageUpload', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/components/media/imageUpload')>(),
  prepareSquareImage: imageUploadMock.prepareSquareImage,
}));

const category: Category = {
  id: 'category-a',
  version: 3,
  name: 'Drinks',
  icon: 'drink',
  active: true,
  sortOrder: 2,
  products: [],
};

const createdProduct: Product = {
  id: 'product-created',
  categoryId: category.id,
  version: 1,
  name: 'Water',
  pricingMode: 'FIXED',
  currency: 'EUR',
  price: { minorUnits: '100', currency: 'EUR' },
  active: true,
  sortOrder: 0,
};

const session: Session = {
  user: { id: 'user-a', displayName: 'Alex', email: 'alex@example.test' },
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: 'member-a', roles: ['CATALOG_MANAGER', 'MEMBER'], groupPermissions: [] } }],
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

describe('CatalogPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:product-preview') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    imageUploadMock.prepareSquareImage.mockImplementation(async (file: File) => file);
    apiMock.getCategories.mockResolvedValue([category]);
    apiMock.createCategory.mockResolvedValue(category);
    apiMock.createProduct.mockResolvedValue(createdProduct);
    apiMock.updateCategory.mockResolvedValue({ ...category, version: 4 });
    apiMock.reorderCatalog.mockResolvedValue([category]);
    apiMock.updateProduct.mockResolvedValue({ ...createdProduct, version: 2 });
    apiMock.deleteCategory.mockResolvedValue(undefined);
    apiMock.deleteProduct.mockResolvedValue(undefined);
  });

  it('shows the product initial when no image is available', async () => {
    apiMock.getCategories.mockResolvedValue([{ ...category, products: [createdProduct] }]);
    renderCatalog();

    expect(await screen.findByText('W')).toBeVisible();
    expect(screen.getByText(createdProduct.name)).toHaveAttribute('title', createdProduct.name);
  });

  it('marks only archived products with an image overlay instead of status labels', async () => {
    const archivedProduct = { ...createdProduct, id: 'product-archived', name: 'Archived water', active: false };
    apiMock.getCategories.mockResolvedValue([{ ...category, products: [createdProduct, archivedProduct] }]);
    renderCatalog();

    const activeCard = (await screen.findByText(createdProduct.name)).closest('article');
    const archivedCard = screen.getByText(archivedProduct.name).closest('article');
    expect(activeCard).not.toBeNull();
    expect(archivedCard).not.toBeNull();
    expect(activeCard).toHaveAttribute('data-state', 'active');
    expect(archivedCard).toHaveAttribute('data-state', 'archived');
    expect(within(activeCard!).queryByText(i18n.t('common.active'))).not.toBeInTheDocument();
    expect(within(archivedCard!).queryByText(i18n.t('common.archived'))).not.toBeInTheDocument();
    expect(within(archivedCard!).queryByText(archivedProduct.name.slice(0, 1))).not.toBeInTheDocument();
    expect(within(activeCard!).queryByRole('img', { name: i18n.t('common.archived') })).not.toBeInTheDocument();
    expect(within(archivedCard!).getByRole('img', { name: i18n.t('common.archived') })).toBeVisible();
  });

  it('creates a category with a selected icon', async () => {
    const user = userEvent.setup();
    renderCatalog();

    await screen.findByRole('button', { name: i18n.t('catalog.categoryAction') });
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.categoryAction') }));

    expect(within(screen.getByRole('dialog')).queryByRole('combobox')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(i18n.t('common.name')), 'Team events');
    const eventIconButton = screen.getByRole('button', { name: i18n.t('catalog.categoryIcons.event') });
    expect(eventIconButton).toHaveAttribute('title', i18n.t('catalog.categoryIcons.event'));
    expect(eventIconButton).not.toHaveTextContent(i18n.t('catalog.categoryIcons.event'));
    await user.click(eventIconButton);
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.createCategoryAction') }));

    await waitFor(() => expect(apiMock.createCategory).toHaveBeenCalledWith('group-a', { name: 'Team events', icon: 'event' }));
  });

  it('keeps the created product and retries only its image after upload failure', async () => {
    const user = userEvent.setup();
    const firstImage = new File(['first'], 'first.webp', { type: 'image/webp' });
    const replacementImage = new File(['replacement'], 'replacement.png', { type: 'image/png' });
    apiMock.uploadProductImage
      .mockRejectedValueOnce(new Error('upload failed'))
      .mockResolvedValueOnce({ imageUrl: '/api/v1/groups/group-a/products/product-created/image' });
    renderCatalog();

    await screen.findByRole('button', { name: i18n.t('catalog.categoryAction') });
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

  it('applies the selected move and scale transform before creating a product image', async () => {
    const user = userEvent.setup();
    const image = new File(['source'], 'source.webp', { type: 'image/webp' });
    const preparedImage = new File(['prepared'], 'source.png', { type: 'image/png' });
    imageUploadMock.prepareSquareImage.mockResolvedValue(preparedImage);
    apiMock.uploadProductImage.mockResolvedValue({ imageUrl: '/api/v1/groups/group-a/products/product-created/image' });
    renderCatalog();

    await screen.findByRole('button', { name: i18n.t('catalog.productAction') });
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.productAction') }));
    await user.type(screen.getByLabelText(i18n.t('catalog.productName')), createdProduct.name);
    await user.type(screen.getByLabelText(i18n.t('catalog.price', { currency: 'EUR' })), '1,00');
    await user.upload(screen.getByLabelText(i18n.t('catalog.image')), image);
    const preview = screen.getByRole('img', { name: i18n.t('catalog.imagePreviewAlt') });
    expect(preview.querySelector('img')).toHaveAttribute('src', 'blob:product-preview');
    fireEvent.wheel(preview, { deltaY: -279.807894 });
    fireEvent.keyDown(preview, { key: 'ArrowRight' });
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.createProductAction') }));

    await waitFor(() => expect(imageUploadMock.prepareSquareImage).toHaveBeenCalledWith(image, {
      x: 0.05,
      y: 0,
      zoom: expect.closeTo(1.75, 5),
    }));
    await waitFor(() => expect(apiMock.uploadProductImage).toHaveBeenCalledWith('group-a', createdProduct.id, preparedImage));
  });

  it('removes a selected image from the product form before creation', async () => {
    const user = userEvent.setup();
    const image = new File(['selected'], 'selected.png', { type: 'image/png' });
    renderCatalog();

    await screen.findByRole('button', { name: i18n.t('catalog.categoryAction') });
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.productAction') }));
    await user.upload(screen.getByLabelText(i18n.t('catalog.image')), image);

    expect(screen.getByLabelText(i18n.t('catalog.image'))).toHaveValue('C:\\fakepath\\selected.png');
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.removeSelectedImage') }));
    expect(screen.getByLabelText(i18n.t('catalog.image'))).toHaveValue('');
    expect(screen.queryByRole('button', { name: i18n.t('catalog.removeSelectedImage') })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(i18n.t('catalog.productName')), createdProduct.name);
    await user.type(screen.getByLabelText(i18n.t('catalog.price', { currency: 'EUR' })), '1,00');
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.createProductAction') }));

    await waitFor(() => expect(apiMock.createProduct).toHaveBeenCalledTimes(1));
    expect(apiMock.uploadProductImage).not.toHaveBeenCalled();
  });

  it('clears the native file input before another product is created', async () => {
    const user = userEvent.setup();
    const image = new File(['first'], 'first.png', { type: 'image/png' });
    apiMock.uploadProductImage.mockResolvedValue({ imageUrl: '/api/v1/groups/group-a/products/product-created/image' });
    renderCatalog();

    await screen.findByRole('button', { name: i18n.t('catalog.categoryAction') });
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.productAction') }));
    await user.type(screen.getByLabelText(i18n.t('catalog.productName')), createdProduct.name);
    await user.type(screen.getByLabelText(i18n.t('catalog.price', { currency: 'EUR' })), '1,00');
    await user.upload(screen.getByLabelText(i18n.t('catalog.image')), image);
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.createProductAction') }));

    await waitFor(() => expect(apiMock.uploadProductImage).toHaveBeenCalledWith('group-a', createdProduct.id, image));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.productAction') }));

    expect(screen.getByLabelText(i18n.t('catalog.image'))).toHaveValue('');
    expect(screen.queryByRole('button', { name: i18n.t('catalog.removeSelectedImage') })).not.toBeInTheDocument();
  });

  it('creates a user-defined-price product without a catalog price', async () => {
    const user = userEvent.setup();
    apiMock.createProduct.mockResolvedValue({ ...createdProduct, pricingMode: 'USER_DEFINED', price: undefined });
    renderCatalog();

    await screen.findByRole('button', { name: i18n.t('catalog.categoryAction') });
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.productAction') }));
    await user.type(screen.getByLabelText(i18n.t('catalog.productName')), 'Donation');
    await user.selectOptions(screen.getByLabelText(i18n.t('catalog.pricingMode')), 'USER_DEFINED');

    expect(screen.queryByLabelText(i18n.t('catalog.price', { currency: 'EUR' }))).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.createProductAction') }));

    await waitFor(() => expect(apiMock.createProduct).toHaveBeenCalledWith('group-a', {
      categoryId: category.id,
      name: 'Donation',
      pricingMode: 'USER_DEFINED',
      price: undefined,
    }));
  });

  it('edits a category with its current version and preserves its sort order', async () => {
    const user = userEvent.setup();
    renderCatalog();

    await screen.findByRole('button', { name: i18n.t('catalog.categoryAction') });
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.editCategory', { name: category.name }) }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: i18n.t('catalog.categoryIcons.drink') })).toHaveAttribute('aria-pressed', 'true');
    const name = within(dialog).getByLabelText(i18n.t('common.name'));
    await user.clear(name);
    await user.type(name, 'Team drinks');
    await user.click(within(dialog).getByRole('button', { name: i18n.t('catalog.categoryIcons.sport') }));
    await user.selectOptions(within(dialog).getByLabelText(i18n.t('common.status')), 'archived');
    await user.click(within(dialog).getByRole('button', { name: i18n.t('common.save') }));

    await waitFor(() => expect(apiMock.updateCategory).toHaveBeenCalledWith('group-a', category.id, {
      name: 'Team drinks',
      icon: 'sport',
      active: false,
      sortOrder: 2,
      version: 3,
    }));
  });

  it('edits a fixed-price product with an exact prefilled amount', async () => {
    const user = userEvent.setup();
    const existingProduct = { ...createdProduct, id: 'product-existing', version: 6, sortOrder: 4 };
    apiMock.getCategories.mockResolvedValue([{ ...category, products: [existingProduct] }]);
    apiMock.updateProduct.mockResolvedValue({ ...existingProduct, name: 'Mineral water', version: 7 });
    renderCatalog();

    await screen.findByText(existingProduct.name);
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.editProduct', { name: existingProduct.name }) }));
    expect(screen.getByLabelText(i18n.t('catalog.price', { currency: 'EUR' }))).toHaveValue('1,00');
    expect(screen.getByLabelText(i18n.t('common.category'))).toBeDisabled();
    const name = screen.getByLabelText(i18n.t('catalog.productName'));
    await user.clear(name);
    await user.type(name, 'Mineral water');
    await user.click(screen.getByRole('button', { name: i18n.t('common.save') }));

    await waitFor(() => expect(apiMock.updateProduct).toHaveBeenCalledWith('group-a', existingProduct.id, {
      name: 'Mineral water',
      pricingMode: 'FIXED',
      price: { minorUnits: '100', currency: 'EUR' },
      active: true,
      sortOrder: 4,
      version: 6,
    }));
  });

  it('uses the crop editor when replacing an image while editing a product', async () => {
    const user = userEvent.setup();
    const existingProduct = { ...createdProduct, id: 'product-existing', version: 6, sortOrder: 4, imageUrl: '/product.png' };
    const replacementImage = new File(['replacement'], 'replacement.png', { type: 'image/png' });
    const preparedImage = new File(['prepared'], 'replacement.png', { type: 'image/png' });
    apiMock.getCategories.mockResolvedValue([{ ...category, products: [existingProduct] }]);
    apiMock.updateProduct.mockResolvedValue({ ...existingProduct, version: 7 });
    apiMock.uploadProductImage.mockResolvedValue({ imageUrl: '/api/v1/groups/group-a/products/product-existing/image' });
    imageUploadMock.prepareSquareImage.mockResolvedValue(preparedImage);
    renderCatalog();

    await screen.findByText(existingProduct.name);
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.editProduct', { name: existingProduct.name }) }));
    await user.upload(screen.getByLabelText(i18n.t('catalog.image')), replacementImage);
    const preview = screen.getByRole('img', { name: i18n.t('catalog.imagePreviewAlt') });
    fireEvent.wheel(preview, { deltaY: -202.732554 });
    fireEvent.keyDown(preview, { key: 'ArrowDown' });
    await user.click(screen.getByRole('button', { name: i18n.t('common.save') }));

    await waitFor(() => expect(imageUploadMock.prepareSquareImage).toHaveBeenCalledWith(replacementImage, {
      x: 0,
      y: 0.05,
      zoom: expect.closeTo(1.5, 5),
    }));
    await waitFor(() => expect(apiMock.uploadProductImage).toHaveBeenCalledWith('group-a', existingProduct.id, preparedImage));
  });

  it('offers contextual create tiles and preselects their category', async () => {
    const user = userEvent.setup();
    const secondProduct: Product = { ...createdProduct, categoryId: 'category-b' };
    const secondCategory: Category = { ...category, id: 'category-b', name: 'Snacks', sortOrder: 3, products: [secondProduct] };
    apiMock.getCategories.mockResolvedValue([category, secondCategory]);
    renderCatalog();

    await screen.findByRole('button', { name: i18n.t('catalog.categoryAction') });
    expect(screen.getByRole('button', { name: i18n.t('catalog.addCategoryAfterList') })).toBeVisible();
    const addProductButton = screen.getByRole('button', { name: i18n.t('catalog.addProductToCategory', { name: secondCategory.name }) });
    const productCard = screen.getByText(secondProduct.name).closest('article');
    expect(addProductButton.parentElement?.parentElement).toBe(productCard?.parentElement);
    await user.click(addProductButton);

    expect(screen.getByLabelText(i18n.t('common.category'))).toHaveValue(secondCategory.id);
  });

  it('exposes localized keyboard drag handles for categories and products', async () => {
    apiMock.getCategories.mockResolvedValue([{ ...category, products: [createdProduct] }]);
    renderCatalog();

    expect(await screen.findByRole('button', { name: i18n.t('catalog.moveCategory', { name: category.name }) })).toBeVisible();
    expect(screen.getByRole('button', { name: i18n.t('catalog.moveProduct', { name: createdProduct.name }) })).toBeVisible();
  });

  it('offers permanent deletion only after a product is archived and confirmed', async () => {
    const user = userEvent.setup();
    const archivedProduct = { ...createdProduct, active: false, version: 5 };
    apiMock.getCategories.mockResolvedValue([{ ...category, products: [archivedProduct] }]);
    renderCatalog();

    await screen.findByText(archivedProduct.name);
    expect(screen.queryByRole('button', { name: i18n.t('catalog.deletePermanently') })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.editProduct', { name: archivedProduct.name }) }));
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.deletePermanently') }));

    expect(screen.getByText(i18n.t('catalog.deleteProductExplanation', { name: archivedProduct.name }))).toBeVisible();
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.confirmDelete') }));
    await waitFor(() => expect(apiMock.deleteProduct).toHaveBeenCalledWith('group-a', archivedProduct.id, archivedProduct.version));
  });

  it('does not offer permanent deletion while a category is active', async () => {
    const user = userEvent.setup();
    renderCatalog();

    await screen.findByText(category.name);
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.editCategory', { name: category.name }) }));

    expect(screen.queryByRole('button', { name: i18n.t('catalog.deletePermanently') })).not.toBeInTheDocument();
  });

  it('deletes an archived empty category only after confirmation', async () => {
    const user = userEvent.setup();
    const archivedCategory = { ...category, active: false, version: 6 };
    apiMock.getCategories.mockResolvedValue([archivedCategory]);
    renderCatalog();

    await screen.findByText(archivedCategory.name);
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.editCategory', { name: archivedCategory.name }) }));
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.deletePermanently') }));
    await user.click(screen.getByRole('button', { name: i18n.t('catalog.confirmDelete') }));

    await waitFor(() => expect(apiMock.deleteCategory).toHaveBeenCalledWith('group-a', archivedCategory.id, archivedCategory.version));
  });
});
