import type { Role } from '@/api/types';
import i18n from '@/i18n';

const CANONICAL_ADMINISTRATOR_DESCRIPTIONS: readonly string[] = ['Required administrator role with full group access.', 'Standardrolle für Administratorrolle mit vollständigem Zugriff auf die Gruppe'];

/**
 * Returns the localized name of a reserved role or the persisted custom name.
 *
 * Reserved identities are selected exclusively through their stable preset
 * key. Administrator-authored role names remain group-owned content and are
 * never translated heuristically.
 *
 * @param role - Group-owned role returned by the API.
 * @returns The consistent localized or custom display name.
 */
export function roleDisplayName(role: Role): string {
  if (role.presetKey === 'GROUP_ADMINISTRATOR') return i18n.t('roleManagement.presetNames.GROUP_ADMINISTRATOR');
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
