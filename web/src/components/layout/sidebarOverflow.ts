/**
 * Returns the number of module links that fit before reserving an overflow slot.
 *
 * @param total - Number of available module destinations.
 * @param availableHeight - Height available to the module navigation in pixels.
 * @param itemHeight - Height of one module destination in pixels.
 * @param gap - Vertical gap between module destinations in pixels.
 * @returns The number of destinations rendered directly in the sidebar.
 */
export function visibleSidebarItemCount(total: number, availableHeight: number, itemHeight: number, gap: number): number {
  if (total <= 0 || availableHeight <= 0) return total;
  const slots = Math.max(1, Math.floor((availableHeight + gap) / (itemHeight + gap)));
  return slots >= total ? total : Math.max(0, slots - 1);
}
