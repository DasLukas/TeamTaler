import type { Category } from '@/api/types';

/**
 * Returns categories and products that can participate in a new booking.
 *
 * Active categories remain visible even when they have no active products so
 * the picker can render an explicit empty state.
 *
 * @param categories - Catalogue categories returned by the API.
 * @returns Active categories containing active products only.
 */
export function getBookableCategories(categories: Category[]): Category[] {
  return categories.filter((category) => category.active).map((category) => ({
    ...category,
    products: category.products.filter((product) => product.active),
  }));
}
