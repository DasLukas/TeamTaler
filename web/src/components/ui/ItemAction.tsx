import { Link, type AnyRouter, type CreateLinkProps, useRouter } from '@tanstack/react-router';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import type { ButtonProps } from './Button';
import { Button } from './Button';
import buttonStyles from './Button.module.css';

/** Properties accepted by a contextual action attached to one list or card item. */
export type ItemActionButtonProps = Omit<ButtonProps, 'collapseLabelAt' | 'iconOnly' | 'size' | 'variant'> & { to?: never };

/** Router-link properties accepted by a navigational item action. */
export type ItemActionLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children' | 'href'>
  & Omit<CreateLinkProps, 'children'>
  & { children: ReactNode; leadingIcon: ReactNode; to: string };

/** Button or semantic router-link properties accepted by an item action. */
export type ItemActionProps = ItemActionButtonProps | ItemActionLinkProps;

function isLinkAction(props: ItemActionProps): props is ItemActionLinkProps {
  return typeof props.to === 'string';
}

function fallbackLinkHref(to: string, search: CreateLinkProps['search']): string {
  if (!search || typeof search === 'function') return to;
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value !== undefined && value !== null) values.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  const query = values.toString();
  return query ? `${to}?${query}` : to;
}

/**
 * Renders a compact, link-style action for one item in a list, table, or card.
 *
 * The visible icon and label remain available at every viewport. Destructive
 * consequences belong in the subsequent confirmation dialog, not on the row
 * trigger itself.
 *
 * @param props - Native button or router-link properties, a semantic icon, and a visible label.
 * @returns A small borderless TeamTaler action rendered as a button or a real link.
 *
 * @example
 * <ItemAction leadingIcon={<Archive size={16} />} onClick={archiveGroup}>
 *   Archive
 * </ItemAction>
 */
export function ItemAction(props: ItemActionProps) {
  const router = useRouter({ warn: false }) as AnyRouter | undefined;
  if (isLinkAction(props)) {
    const { children, className = '', leadingIcon, ...linkProps } = props;
    const content = <><span aria-hidden="true" className={buttonStyles.icon}>{leadingIcon}</span><span className={buttonStyles.label}>{children}</span></>;
    const presentation = `${buttonStyles.button} ${buttonStyles.small} ${buttonStyles.ghost} ${className}`;
    if (!router) {
      const { search, to, ...anchorProps } = linkProps;
      return <a {...anchorProps} className={presentation} href={fallbackLinkHref(to, search)}>{content}</a>;
    }
    return (
      <Link {...linkProps} className={presentation}>{content}</Link>
    );
  }
  return <Button {...props} size="small" variant="ghost" />;
}
