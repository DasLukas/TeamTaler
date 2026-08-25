import type { MemberFilterOption as MemberFilterIdentity } from '@/api/types';
import { Avatar } from '@/components/ui/Avatar';
import type { DataTableFilterOption } from './DataTable';

/**
 * Converts a privacy-minimized member identity into a visual table-filter option.
 *
 * @param member - Stable membership ID, current display name, and optional avatar URL.
 * @returns A single-value filter option with the shared avatar and initials fallback.
 */
export function createMemberFilterOption(member: MemberFilterIdentity): DataTableFilterOption {
  return {
    label: member.displayName,
    value: member.membershipId,
    visual: <Avatar decorative name={member.displayName} size="small" src={member.avatarUrl} />,
  };
}
