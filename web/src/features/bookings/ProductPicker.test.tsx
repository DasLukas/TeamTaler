import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { demoCategories } from '@/demo/data';
import i18n from '@/i18n';
import { ProductPicker } from './ProductPicker';

describe('ProductPicker', () => {
  it('selects a product through an accessible button', async () => {
    const user = userEvent.setup();
    const onProductSelect = vi.fn();
    render(
      <ProductPicker
        categories={demoCategories}
        onCategoryChange={vi.fn()}
        onProductSelect={onProductSelect}
        selectedCategoryId="category-drinks"
      />,
    );
    await user.click(screen.getByRole('button', { name: new RegExp(`${demoCategories[0].products[2].name}.*2,00`, 'i') }));
    expect(onProductSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'product-beer' }));
  });

  it('announces the active category as selected', () => {
    render(
      <ProductPicker
        categories={demoCategories}
        onCategoryChange={vi.fn()}
        onProductSelect={vi.fn()}
        selectedCategoryId="category-penalties"
      />,
    );
    expect(screen.getByRole('tab', { name: demoCategories[1].name })).toHaveAttribute('aria-selected', 'true');
  });

  it('excludes archived categories and products and renders an empty state', () => {
    const categories = [
      { ...demoCategories[0], products: demoCategories[0].products.map((product) => ({ ...product, active: false })) },
      { ...demoCategories[1], active: false },
    ];
    render(
      <ProductPicker
        categories={categories}
        onCategoryChange={vi.fn()}
        onProductSelect={vi.fn()}
        selectedCategoryId={categories[0].id}
      />,
    );

    expect(screen.queryByRole('tab', { name: demoCategories[1].name })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp(demoCategories[0].products[2].name, 'i') })).not.toBeInTheDocument();
    expect(screen.getByText(i18n.t('booking.emptyCategory'))).toBeVisible();
  });
});
