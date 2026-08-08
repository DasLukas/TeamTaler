import type { Role, RolePresetKey } from '@/api/types';
import i18n from '@/i18n';

const CANONICAL_PRESET_NAMES: Readonly<Record<RolePresetKey, string>> = {
  GROUP_ADMINISTRATOR: 'Group administrator',
  MEMBER: 'Member',
  FINANCE_MANAGER: 'Finance manager',
  CATALOG_MANAGER: 'Catalog manager',
};

const CANONICAL_PRESET_DESCRIPTIONS: Readonly<Record<RolePresetKey, string>> = {
  GROUP_ADMINISTRATOR: 'Required administrator role with full group access.',
  MEMBER: 'Editable starter role for regular group members.',
  FINANCE_MANAGER: 'Seeded role for financial management.',
  CATALOG_MANAGER: 'Seeded role for catalog management.',
};

/**
 * Localizes unchanged seeded role names without hiding administrator renames.
 *
 * @param role - Group-owned role returned by the API.
 * @returns A localized preset name or the administrator-defined role name.
 */
export function roleDisplayName(role: Role): string {
  if (!role.presetKey || role.name !== CANONICAL_PRESET_NAMES[role.presetKey]) return role.name;
  return i18n.t(`roleManagement.presetNames.${role.presetKey}`);
}

/**
 * Localizes unchanged seeded role descriptions while preserving administrator
 * authored descriptions verbatim.
 *
 * @param role - Group-owned role returned by the API.
 * @returns A localized preset description or the stored custom description.
 */
export function roleDisplayDescription(role: Role): string {
  if (!role.presetKey || role.description !== CANONICAL_PRESET_DESCRIPTIONS[role.presetKey]) return role.description ?? '';
  return i18n.t(`roleManagement.presetDescriptions.${role.presetKey}`);
}
