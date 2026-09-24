import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Category, Product } from '@/api/types';
import i18n from '@/i18n';
import { PosterProductComposer } from './PosterProductComposer';

const coffee: Product = {
  id: 'coffee', categoryId: 'drinks', name: 'Club coffee', pricingMode: 'FIXED',
  currency: 'EUR', price: { minorUnits: '150', currency: 'EUR' }, active: true,
  sortOrder: 0, version: 1,
};
const cake: Product = {
  id: 'cake', categoryId: 'snacks', name: 'Sheet cake', pricingMode: 'FIXED',
  currency: 'EUR', price: { minorUnits: '250', currency: 'EUR' }, active: true,
  sortOrder: 0, version: 1,
};
const categories: Category[] = [
  { id: 'drinks', version: 1, name: 'Drinks', icon: 'drink', active: true, sortOrder: 0, products: [coffee] },
  { id: 'snacks', version: 1, name: 'Snacks', icon: 'food', active: true, sortOrder: 1, products: [cake] },
];

describe('PosterProductComposer', () => {
  it('shows only the product picker when no products are selected', () => {
    render(<PosterProductComposer categories={categories} onChange={vi.fn()} productIds={[]} />);

    expect(screen.getByRole('button', { name: i18n.t('kiosk.composerAdd') })).toBeInTheDocument();
  });

  it('searches available products by category and adds one in order', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PosterProductComposer categories={categories} onChange={onChange} productIds={['coffee']} />);

    await user.click(screen.getByRole('button', { name: i18n.t('kiosk.composerAdd') }));
    expect(screen.getByRole('heading', { name: 'Snacks' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Drinks' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: i18n.t('kiosk.composerSearch') }), 'sheet');
    const snacks = screen.getByRole('heading', { name: 'Snacks' }).closest('section');
    expect(snacks).not.toBeNull();
    await user.click(within(snacks!).getByRole('button', { name: /Sheet cake/ }));

    expect(onChange).toHaveBeenCalledWith(['coffee', 'cake']);
  });

  it('retains stale products with remove above drag and no movement buttons', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PosterProductComposer categories={categories} onChange={onChange} productIds={['coffee', 'deleted']} />);

    expect(screen.getByText(i18n.t('kiosk.unavailableProduct'))).toBeInTheDocument();
    const staleCard = screen.getByText(i18n.t('kiosk.deletedProduct')).closest('article');
    expect(staleCard).not.toBeNull();
    expect(within(staleCard!).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      i18n.t('kiosk.removeProduct', { name: i18n.t('kiosk.deletedProduct') }),
      i18n.t('kiosk.composerDrag', { name: i18n.t('kiosk.deletedProduct') }),
    ]);
    await user.click(within(staleCard!).getByRole('button', { name: i18n.t('kiosk.removeProduct', { name: i18n.t('kiosk.deletedProduct') }) }));
    expect(onChange).toHaveBeenCalledWith(['coffee']);
  });

  it('excludes archived products and categories from the add picker', async () => {
    const user = userEvent.setup();
    const archivedCategories: Category[] = [
      { ...categories[0], products: [{ ...coffee, active: false }] },
      { ...categories[1], active: false },
    ];
    render(<PosterProductComposer categories={archivedCategories} onChange={vi.fn()} productIds={[]} />);

    await user.click(screen.getByRole('button', { name: i18n.t('kiosk.composerAdd') }));
    expect(screen.getByText(i18n.t('kiosk.composerNoMatches'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Club coffee|Sheet cake/ })).not.toBeInTheDocument();
  });

  it('displays the current price without tile numbering or a QR preview', () => {
    render(<PosterProductComposer categories={categories} onChange={vi.fn()} productIds={['coffee']} />);

    expect(screen.getByText(/1,50/)).toBeInTheDocument();
    expect(screen.queryByText('01')).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /QR-Code/ })).not.toBeInTheDocument();
  });
});
