import { describe, expect, it } from 'vitest';
import type { Role } from '@/api/types';
import { roleDisplayName } from './roleDisplayName';

const role = (name: string, presetKey?: Role['presetKey']): Role => ({
  grants: [],
  id: `role-${name}`,
  memberCount: 0,
  name,
  pendingInvitationCount: 0,
  presetKey,
  version: 1,
});

describe('roleDisplayName', () => {
  it('localizes the reserved administrator through its stable preset key', () => {
    expect(roleDisplayName(role('Group administrator', 'GROUP_ADMINISTRATOR'))).toBe('Gruppenadministrator');
  });

  it('preserves administrator-authored role names verbatim', () => {
    expect(roleDisplayName(role('Development administrator'))).toBe('Development administrator');
  });
});
