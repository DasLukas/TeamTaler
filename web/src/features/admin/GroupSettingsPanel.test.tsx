import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/api/types';
import { ActiveGroupContext } from '@/app/active-group-context';
import i18n from '@/i18n';
import { GroupSettingsPanel } from './GroupSettingsPanel';

const apiMock = vi.hoisted(() => ({
  uploadGroupLogo: vi.fn(),
  removeGroupLogo: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: apiMock }));

const baseSession: Session = {
  user: { id: 'user-a', displayName: 'Alex', email: 'alex@example.test' },
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: 'member-a', roles: ['ADMIN', 'MEMBER'] } }],
  activeGroupId: 'group-a',
};

function renderSettings(session: Session = baseSession): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  queryClient.setQueryData(['session'], session);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ActiveGroupContext.Provider value={{ session, activeGroup: session.groups[0], activeGroupId: 'group-a', setActiveGroupId: vi.fn() }}>
        {children}
      </ActiveGroupContext.Provider>
    </QueryClientProvider>
  );
  render(<GroupSettingsPanel />, { wrapper });
  return queryClient;
}

describe('GroupSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:logo-preview') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });

  it('previews and saves a supported group logo in the shared session cache', async () => {
    const user = userEvent.setup();
    const logo = new File(['logo'], 'club.png', { type: 'image/png' });
    apiMock.uploadGroupLogo.mockResolvedValue({ logoUrl: '/api/v1/groups/group-a/images/logo.png' });
    const queryClient = renderSettings();

    await user.upload(screen.getByLabelText(i18n.t('groupSettings.imageLabel')), logo);
    expect(screen.getByAltText(i18n.t('groupSettings.previewAlt', { group: 'Group A' }))).toHaveAttribute('src', 'blob:logo-preview');
    await user.click(screen.getByRole('button', { name: i18n.t('groupSettings.save') }));

    await waitFor(() => expect(apiMock.uploadGroupLogo).toHaveBeenCalledWith('group-a', logo));
    await waitFor(() => expect((queryClient.getQueryData<Session>(['session'])?.groups[0].logoUrl)).toBe('/api/v1/groups/group-a/images/logo.png'));
    expect(await screen.findByText(i18n.t('groupSettings.saved'))).toHaveAttribute('role', 'status');
    expect(screen.getByLabelText(i18n.t('groupSettings.imageLabel'))).toHaveValue('');
  });

  it('restores the TeamTaler mark by removing the custom group logo', async () => {
    const user = userEvent.setup();
    apiMock.removeGroupLogo.mockResolvedValue(undefined);
    const session: Session = { ...baseSession, groups: [{ ...baseSession.groups[0], logoUrl: '/custom-logo.png' }] };
    const queryClient = renderSettings(session);

    await user.click(screen.getByRole('button', { name: i18n.t('groupSettings.restoreDefault') }));

    await waitFor(() => expect(apiMock.removeGroupLogo).toHaveBeenCalledWith('group-a'));
    await waitFor(() => expect(queryClient.getQueryData<Session>(['session'])?.groups[0].logoUrl).toBeUndefined());
    expect(await screen.findByText(i18n.t('groupSettings.removed'))).toHaveAttribute('role', 'status');
  });

  it('rejects unsupported logo formats before starting an upload', async () => {
    renderSettings();

    fireEvent.change(screen.getByLabelText(i18n.t('groupSettings.imageLabel')), {
      target: { files: [new File(['vector'], 'club.svg', { type: 'image/svg+xml' })] },
    });

    expect(await screen.findByText(i18n.t('groupSettings.invalidType'))).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: i18n.t('groupSettings.save') })).toBeDisabled();
    expect(apiMock.uploadGroupLogo).not.toHaveBeenCalled();
  });
});
