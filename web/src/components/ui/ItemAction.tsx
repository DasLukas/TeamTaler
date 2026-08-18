import type { ButtonProps } from './Button';
import { Button } from './Button';

/** Properties accepted by a contextual action attached to one list or card item. */
export type ItemActionProps = Omit<ButtonProps, 'collapseLabelAt' | 'size' | 'variant'>;

/**
 * Renders a compact, link-style action for one item in a list, table, or card.
 *
 * The visible icon and label remain available at every viewport. Destructive
 * consequences belong in the subsequent confirmation dialog, not on the row
 * trigger itself.
 *
 * @param props - Native button properties, a semantic icon, and a visible label.
 * @returns A small borderless TeamTaler action button.
 *
 * @example
 * <ItemAction leadingIcon={<Archive size={16} />} onClick={archiveGroup}>
 *   Archive
 * </ItemAction>
 */
export function ItemAction(props: ItemActionProps) {
  return <Button {...props} size="small" variant="ghost" />;
}
