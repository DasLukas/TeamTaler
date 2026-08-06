import type { CatalogOrderCommand, Category } from '@/api/types';

const CATEGORY_PREFIX = 'category:';
const PRODUCT_PREFIX = 'product:';

/**
 * Creates a globally unique drag identifier for a category.
 *
 * @param categoryId - Persisted category identifier.
 * @returns A namespaced sortable identifier.
 */
export function categorySortableId(categoryId: string): string {
  return `${CATEGORY_PREFIX}${categoryId}`;
}

/**
 * Creates a globally unique drag identifier for a product.
 *
 * @param productId - Persisted product identifier.
 * @returns A namespaced sortable identifier.
 */
export function productSortableId(productId: string): string {
  return `${PRODUCT_PREFIX}${productId}`;
}

function moveItem<T>(items: T[], from: number, to: number): T[] {
  const reordered = [...items];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);
  return reordered;
}

function categoryForProduct(categories: Category[], productId: string): Category | undefined {
  return categories.find((category) => category.products.some((product) => product.id === productId));
}

/**
 * Applies one category or same-category product drag result immutably.
 * Cross-category product drops are intentionally ignored.
 *
 * @param categories - Current catalog in display order.
 * @param activeSortableId - Identifier of the dragged item.
 * @param overSortableId - Identifier of the closest drop target.
 * @returns The reordered catalog, or undefined when the drop changes nothing.
 */
export function moveCatalogItem(categories: Category[], activeSortableId: string, overSortableId: string): Category[] | undefined {
  if (activeSortableId === overSortableId) return undefined;
  if (activeSortableId.startsWith(CATEGORY_PREFIX)) {
    const activeCategoryId = activeSortableId.slice(CATEGORY_PREFIX.length);
    const overCategoryId = overSortableId.startsWith(CATEGORY_PREFIX)
      ? overSortableId.slice(CATEGORY_PREFIX.length)
      : overSortableId.startsWith(PRODUCT_PREFIX)
        ? categoryForProduct(categories, overSortableId.slice(PRODUCT_PREFIX.length))?.id
        : undefined;
    const from = categories.findIndex((category) => category.id === activeCategoryId);
    const to = categories.findIndex((category) => category.id === overCategoryId);
    if (from < 0 || to < 0 || from === to) return undefined;
    return moveItem(categories, from, to).map((category, sortOrder) => ({ ...category, sortOrder }));
  }

  if (!activeSortableId.startsWith(PRODUCT_PREFIX) || !overSortableId.startsWith(PRODUCT_PREFIX)) return undefined;
  const activeProductId = activeSortableId.slice(PRODUCT_PREFIX.length);
  const overProductId = overSortableId.slice(PRODUCT_PREFIX.length);
  const category = categoryForProduct(categories, activeProductId);
  if (!category || categoryForProduct(categories, overProductId)?.id !== category.id) return undefined;
  const from = category.products.findIndex((product) => product.id === activeProductId);
  const to = category.products.findIndex((product) => product.id === overProductId);
  if (from < 0 || to < 0 || from === to) return undefined;
  const products = moveItem(category.products, from, to).map((product, sortOrder) => ({ ...product, sortOrder }));
  return categories.map((entry) => entry.id === category.id ? { ...entry, products } : entry);
}

/**
 * Serializes a displayed catalog into the API's complete atomic order command.
 *
 * @param categories - Catalog in the desired category and product order.
 * @returns Every category identifier and the ordered product identifiers it owns.
 */
export function catalogOrderCommand(categories: Category[]): CatalogOrderCommand {
  return {
    categoryIds: categories.map((category) => category.id),
    productIdsByCategory: Object.fromEntries(categories.map((category) => [category.id, category.products.map((product) => product.id)])),
  };
}
