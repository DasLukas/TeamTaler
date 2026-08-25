import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@/api/types';
import { useActiveGroup } from './useActiveGroup';
import { GroupProvider } from './GroupContext';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  recordLastUsedGroup: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/api/client', () => ({ api: { recordLastUsedGroup: mocks.recordLastUsedGroup } }));

const session: Session = {
  user: { id: 'user-a', displayName: 'Alex', email: 'alex@example.test' },
  groups: [
    { id: 'group-a', name: 'Group A', currency: 'EUR', defaultTheme: 'TEAMTALER', membership: { id: 'member-a', roles: ['MEMBER'], groupPermissions: [], themeOverride: null } },
    { id: 'group-b', name: 'Group B', currency: 'EUR', defaultTheme: 'TEAMTALER', membership: { id: 'member-b', roles: ['MEMBER'], groupPermissions: [], themeOverride: null } },
  ],
  activeGroupId: 'group-a',
  defaultGroupId: null,
  colorMode: 'SYSTEM',
  systemRoles: [],
};

function GroupSelectionProbe() {
  const { activeGroupId, setActiveGroupId } = useActiveGroup();
  return (
    <div>
      <output aria-label="Active group">{activeGroupId}</output>
      <button onClick={() => setActiveGroupId('group-a')} type="button">Select A</button>
      <button onClick={() => setActiveGroupId('group-b')} type="button">Select B</button>
      <button onClick={() => setActiveGroupId('group-b', { preserveRoute: true })} type="button">Select B in place</button>
    </div>
  );
}

describe('GroupProvider', () => {
  it('updates navigation immediately and records rapid group switches in order', async () => {
    const user = userEvent.setup();
    mocks.navigate.mockReset().mockResolvedValue(undefined);
    mocks.recordLastUsedGroup.mockReset()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(undefined);
    render(<GroupProvider session={session}><GroupSelectionProbe /></GroupProvider>);

    await user.click(screen.getByRole('button', { name: 'Select B' }));
    expect(screen.getByLabelText('Active group')).toHaveTextContent('group-b');
    await user.click(screen.getByRole('button', { name: 'Select A' }));
    expect(screen.getByLabelText('Active group')).toHaveTextContent('group-a');

    await waitFor(() => expect(mocks.recordLastUsedGroup).toHaveBeenCalledTimes(2));
    expect(mocks.recordLastUsedGroup.mock.calls).toEqual([['group-b'], ['group-a']]);
    expect(mocks.navigate).toHaveBeenCalledTimes(2);
  });

  it('preserves the current route for a notification-owned group switch', async () => {
    const user = userEvent.setup();
    mocks.navigate.mockReset().mockResolvedValue(undefined);
    mocks.recordLastUsedGroup.mockReset().mockResolvedValue(undefined);
    render(<GroupProvider session={session}><GroupSelectionProbe /></GroupProvider>);

    await user.click(screen.getByRole('button', { name: 'Select B in place' }));

    expect(screen.getByLabelText('Active group')).toHaveTextContent('group-b');
    await waitFor(() => expect(mocks.recordLastUsedGroup).toHaveBeenCalledWith('group-b'));
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
