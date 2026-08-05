import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Membership, Session } from '@/api/types';
import { ActiveGroupContext } from '@/app/active-group-context';
import i18n from '@/i18n';
import { ProfileImagePanel } from './ProfileImagePanel';

const apiMock = vi.hoisted(() => ({
  uploadProfileAvatar: vi.fn(),
  removeProfileAvatar: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: apiMock }));

const baseSession: Session = {
  user: { id: 'user-a', displayName: 'Alex Member', email: 'alex@example.test' },
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: 'member-a', roles: ['MEMBER'] } }],
  activeGroupId: 'group-a',
};

function renderProfileImage(session: Session = baseSession): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const member: Membership = {
    id: 'member-a',
    userId: session.user.id,
    displayName: session.user.displayName,
    email: session.user.email,
    initials: 'AM',
    roles: ['MEMBER'],
    categoryPermissions: [],
    active: true,
  };
  queryClient.setQueryData(['session'], session);
  queryClient.setQueryData(['members', 'group-a'], [member]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ActiveGroupContext.Provider value={{ session, activeGroup: session.groups[0], activeGroupId: 'group-a', setActiveGroupId: vi.fn() }}>
        {children}
      </ActiveGroupContext.Provider>
    </QueryClientProvider>
  );
  render(<ProfileImagePanel />, { wrapper });
  return queryClient;
}

describe('ProfileImagePanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uploads a supported image and synchronizes the session and membership caches', async () => {
    const user = userEvent.setup();
    const image = new File(['avatar'], 'alex.png', { type: 'image/png' });
    const avatarUrl = '/api/v1/users/user-a/avatar/avatar.png';
    apiMock.uploadProfileAvatar.mockResolvedValue({ avatarUrl });
    const queryClient = renderProfileImage();

    await user.upload(screen.getByLabelText(i18n.t('account.profileImage.label')), image);
    await user.click(screen.getByRole('button', { name: i18n.t('account.profileImage.save') }));

    await waitFor(() => expect(apiMock.uploadProfileAvatar).toHaveBeenCalledWith(image));
    await waitFor(() => expect(queryClient.getQueryData<Session>(['session'])?.user.avatarUrl).toBe(avatarUrl));
    expect(queryClient.getQueryData<Membership[]>(['members', 'group-a'])?.[0].avatarUrl).toBe(avatarUrl);
    expect(await screen.findByText(i18n.t('account.profileImage.saved'))).toHaveAttribute('role', 'status');
    expect(screen.getByLabelText(i18n.t('account.profileImage.label'))).toHaveValue('');
  });

  it('clears a selected file without uploading it', async () => {
    const user = userEvent.setup();
    const image = new File(['avatar'], 'alex.png', { type: 'image/png' });
    renderProfileImage();

    await user.upload(screen.getByLabelText(i18n.t('account.profileImage.label')), image);
    expect(screen.getByText(image.name)).toBeVisible();
    await user.click(screen.getByRole('button', { name: i18n.t('account.profileImage.clearSelection') }));

    expect(screen.queryByText(image.name)).not.toBeInTheDocument();
    expect(screen.getByLabelText(i18n.t('account.profileImage.label'))).toHaveValue('');
    expect(apiMock.uploadProfileAvatar).not.toHaveBeenCalled();
  });

  it('removes the persisted image from the account', async () => {
    const user = userEvent.setup();
    apiMock.removeProfileAvatar.mockResolvedValue(undefined);
    const session: Session = { ...baseSession, user: { ...baseSession.user, avatarUrl: '/avatar.png' } };
    const queryClient = renderProfileImage(session);

    await user.click(screen.getByRole('button', { name: i18n.t('account.profileImage.remove') }));

    await waitFor(() => expect(apiMock.removeProfileAvatar).toHaveBeenCalled());
    await waitFor(() => expect(queryClient.getQueryData<Session>(['session'])?.user.avatarUrl).toBeUndefined());
    expect(await screen.findByText(i18n.t('account.profileImage.removed'))).toHaveAttribute('role', 'status');
  });

  it('rejects unsupported files before upload', async () => {
    renderProfileImage();
    fireEvent.change(screen.getByLabelText(i18n.t('account.profileImage.label')), {
      target: { files: [new File(['vector'], 'avatar.svg', { type: 'image/svg+xml' })] },
    });

    expect(await screen.findByText(i18n.t('account.profileImage.invalidType'))).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: i18n.t('account.profileImage.save') })).toBeDisabled();
    expect(apiMock.uploadProfileAvatar).not.toHaveBeenCalled();
  });
});
