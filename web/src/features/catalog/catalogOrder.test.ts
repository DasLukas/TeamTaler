import { describe, expect, it } from 'vitest';
import type { Category } from '@/api/types';
import { catalogOrderCommand, categorySortableId, moveCatalogItem, productSortableId } from './catalogOrder';

const categories: Category[] = [
  {
    id: 'category-a', version: 1, name: 'A', icon: 'drink', active: true, sortOrder: 0,
    products: [
      { id: 'product-a1', categoryId: 'category-a', version: 1, name: 'A1', pricingMode: 'FIXED', currency: 'EUR', price: { minorUnits: '100', currency: 'EUR' }, active: true, sortOrder: 0 },
      { id: 'product-a2', categoryId: 'category-a', version: 1, name: 'A2', pricingMode: 'FIXED', currency: 'EUR', price: { minorUnits: '200', currency: 'EUR' }, active: true, sortOrder: 1 },
    ],
  },
  {
    id: 'category-b', version: 1, name: 'B', icon: 'food', active: true, sortOrder: 1,
    products: [{ id: 'product-b1', categoryId: 'category-b', version: 1, name: 'B1', pricingMode: 'FIXED', currency: 'EUR', price: { minorUnits: '300', currency: 'EUR' }, active: true, sortOrder: 0 }],
  },
];

describe('catalog order helpers', () => {
  it('moves categories and normalizes their positions', () => {
    const result = moveCatalogItem(categories, categorySortableId('category-b'), categorySortableId('category-a'));
    expect(result?.map((category) => [category.id, category.sortOrder])).toEqual([['category-b', 0], ['category-a', 1]]);
  });

  it('moves products only within their owning category', () => {
    const result = moveCatalogItem(categories, productSortableId('product-a2'), productSortableId('product-a1'));
    expect(result?.[0].products.map((product) => [product.id, product.sortOrder])).toEqual([['product-a2', 0], ['product-a1', 1]]);
    expect(moveCatalogItem(categories, productSortableId('product-a1'), productSortableId('product-b1'))).toBeUndefined();
  });

  it('serializes every visible category and product in display order', () => {
    expect(catalogOrderCommand(categories)).toEqual({
      categoryIds: ['category-a', 'category-b'],
      productIdsByCategory: { 'category-a': ['product-a1', 'product-a2'], 'category-b': ['product-b1'] },
    });
  });
});
