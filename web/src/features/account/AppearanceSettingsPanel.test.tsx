import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/api/types';
import { ActiveGroupContext } from '@/app/active-group-context';
import { AppearanceProvider } from '@/app/AppearanceProvider';
import { SessionProvider } from '@/app/SessionContext';
import { DEFAULT_INSTANCE_CAPABILITIES } from '@/app/useSession';
import i18n from '@/i18n';
import { AppearanceSettingsPanel } from './AppearanceSettingsPanel';

const apiMock = vi.hoisted(() => ({ updateAppearance: vi.fn(), updateThemePreference: vi.fn() }));
vi.mock('@/api/client', () => ({ api: apiMock }));

const session: Session = {
  user: { id: 'user-a', displayName: 'Alex', email: 'alex@example.test' },
  groups: [{
    id: 'group-a',
    name: 'Group A',
    currency: 'EUR',
    defaultTheme: 'NRW',
    membership: { id: 'member-a', roles: ['MEMBER'], groupPermissions: [], themeOverride: null },
  }],
  activeGroupId: 'group-a',
  defaultGroupId: null,
  colorMode: 'SYSTEM',
  systemRoles: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function renderPanel(activeSession: Session = session): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  queryClient.setQueryData(['session'], activeSession);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppearanceProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider instanceCapabilities={DEFAULT_INSTANCE_CAPABILITIES} session={activeSession}>
          {activeSession.groups[0] ? (
            <ActiveGroupContext.Provider value={{ session: activeSession, activeGroup: activeSession.groups[0], activeGroupId: activeSession.groups[0].id, setActiveGroupId: vi.fn() }}>
              {children}
            </ActiveGroupContext.Provider>
          ) : children}
        </SessionProvider>
      </QueryClientProvider>
    </AppearanceProvider>
  );
  render(<AppearanceSettingsPanel />, { wrapper });
  return queryClient;
}

describe('AppearanceSettingsPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('optimistically updates color mode and keeps the control disabled while saving', async () => {
    const user = userEvent.setup();
    const request = deferred<{ colorMode: 'DARK' }>();
    apiMock.updateAppearance.mockReturnValue(request.promise);
    const queryClient = renderPanel();

    await user.click(screen.getByRole('radio', { name: i18n.t('appearance.colorModes.DARK') }));

    await waitFor(() => expect(queryClient.getQueryData<Session>(['session'])?.colorMode).toBe('DARK'));
    expect(apiMock.updateAppearance).toHaveBeenCalledWith('DARK');
    expect(screen.getByRole('radio', { name: i18n.t('appearance.colorModes.LIGHT') })).toBeDisabled();
    request.resolve({ colorMode: 'DARK' });
    await screen.findByText(i18n.t('appearance.colorModeSaved'));
  });

  it('rolls back the optimistic color mode after a failed request', async () => {
    const user = userEvent.setup();
    const request = deferred<{ colorMode: 'LIGHT' }>();
    apiMock.updateAppearance.mockReturnValue(request.promise);
    const queryClient = renderPanel();

    await user.click(screen.getByRole('radio', { name: i18n.t('appearance.colorModes.LIGHT') }));
    await waitFor(() => expect(queryClient.getQueryData<Session>(['session'])?.colorMode).toBe('LIGHT'));
    request.reject(new Error('offline'));

    await screen.findByRole('alert');
    expect(queryClient.getQueryData<Session>(['session'])?.colorMode).toBe('SYSTEM');
  });

  it('persists and projects a per-group theme override immediately', async () => {
    const user = userEvent.setup();
    apiMock.updateThemePreference.mockResolvedValue({ themeOverride: 'FIRE' });
    const queryClient = renderPanel();

    await user.click(screen.getByRole('radio', { name: i18n.t('appearance.themes.FIRE') }));

    await waitFor(() => expect(apiMock.updateThemePreference).toHaveBeenCalledWith('group-a', 'FIRE'));
    expect(queryClient.getQueryData<Session>(['session'])?.groups[0]?.membership?.themeOverride).toBe('FIRE');
  });

  it('restores inherited group styling when saving a theme override fails', async () => {
    const user = userEvent.setup();
    const request = deferred<{ themeOverride: 'TIEF_IM_WESTEN' }>();
    apiMock.updateThemePreference.mockReturnValue(request.promise);
    const queryClient = renderPanel();

    await user.click(screen.getByRole('radio', { name: i18n.t('appearance.themes.TIEF_IM_WESTEN') }));
    await waitFor(() => expect(queryClient.getQueryData<Session>(['session'])?.groups[0]?.membership?.themeOverride).toBe('TIEF_IM_WESTEN'));
    request.reject(new Error('offline'));

    await screen.findByText(i18n.t('appearance.themeSaveError'));
    expect(queryClient.getQueryData<Session>(['session'])?.groups[0]?.membership?.themeOverride).toBeNull();
  });

  it('shows only color mode for a group-less system administrator', () => {
    renderPanel({ ...session, groups: [], activeGroupId: null, systemRoles: ['SYSTEM_ADMINISTRATOR'] });

    expect(screen.getByRole('group', { name: i18n.t('appearance.colorModeLabel') })).toBeVisible();
    expect(screen.queryByRole('group', { name: i18n.t('appearance.themeLabel') })).not.toBeInTheDocument();
  });
});
