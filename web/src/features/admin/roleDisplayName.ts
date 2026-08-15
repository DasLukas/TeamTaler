import type { Role } from '@/api/types';
import i18n from '@/i18n';

const CANONICAL_ADMINISTRATOR_DESCRIPTIONS: readonly string[] = ['Required administrator role with full group access.', 'Standardrolle für Administratorrolle mit vollständigem Zugriff auf die Gruppe'];

/**
 * Returns the persisted role name verbatim for every UI surface.
 *
 * Role names are group-owned content. Translating canonical-looking values
 * would make the editor disagree with role pickers and assignment summaries.
 *
 * @param role - Group-owned role returned by the API.
 * @returns The exact name stored for the role.
 */
export function roleDisplayName(role: Role): string {
  return role.name;
}

/**
 * Localizes unchanged seeded role descriptions while preserving administrator
 * authored descriptions verbatim.
 *
 * @param role - Group-owned role returned by the API.
 * @returns A localized preset description or the stored custom description.
 */
export function roleDisplayDescription(role: Role): string {
  if (role.presetKey !== 'GROUP_ADMINISTRATOR' || !CANONICAL_ADMINISTRATOR_DESCRIPTIONS.includes(role.description ?? '')) return role.description ?? '';
  return i18n.t('roleManagement.presetDescriptions.GROUP_ADMINISTRATOR');
}
