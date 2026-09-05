import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceCapabilities } from '@/api/types';
import i18n from '@/i18n';
import { PushPermissionPrompt } from './PushPermissionPrompt';

const mocks = vi.hoisted(() => ({
  currentDeviceId: vi.fn(),
  enable: vi.fn(),
  ios: vi.fn(),
  standalone: vi.fn(),
  supported: vi.fn(),
}));

vi.mock('./webPush', () => ({
  currentWebPushDeviceId: mocks.currentDeviceId,
  enableWebPush: mocks.enable,
  isIOSBrowser: mocks.ios,
  isStandaloneWebApp: mocks.standalone,
  supportsWebPush: mocks.supported,
}));

const capabilities: InstanceCapabilities = {
  attachmentUploadMaxBytes: 10_000_000,
  emailNotificationsAvailable: true,
  instanceName: 'TeamTaler',
  maintenanceMessage: '',
  maintenanceMode: false,
  mediaUploadMaxBytes: 5_000_000,
  publicJoinEnabled: true,
  webPushAvailable: true,
  webPushKeyId: 'key-a',
  webPushPublicKey: 'public-key',
};

function setNotificationPermission(permission: NotificationPermission): void {
  vi.stubGlobal('Notification', { permission });
}

describe('PushPermissionPrompt', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.currentDeviceId.mockReturnValue(null);
    mocks.enable.mockReset();
    mocks.ios.mockReturnValue(false);
    mocks.standalone.mockReturnValue(true);
    mocks.supported.mockReturnValue(true);
    setNotificationPermission('default');
  });

  it('asks only the compact Push question without triggering browser permission on mount', () => {
    render(<PushPermissionPrompt capabilities={capabilities} userId="user-a" />);

    expect(screen.getByRole('region', { name: i18n.t('pushOnboarding.title') })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: i18n.t('pushOnboarding.neverAskAgain') })).not.toBeChecked();
    expect(screen.getByRole('button', { name: i18n.t('pushOnboarding.allow') })).toBeVisible();
    expect(screen.getByRole('button', { name: i18n.t('pushOnboarding.decline') })).toBeVisible();
    expect(mocks.enable).not.toHaveBeenCalled();
  });

  it('registers Push only after the explicit allow action and remembers success', async () => {
    mocks.enable.mockResolvedValue({ device: { id: 'device-a' }, permission: 'granted' });
    const user = userEvent.setup();
    const view = render(<PushPermissionPrompt capabilities={capabilities} userId="user-a" />);

    await user.click(screen.getByRole('button', { name: i18n.t('pushOnboarding.allow') }));

    expect(mocks.enable).toHaveBeenCalledWith(capabilities, 'user-a');
    await waitFor(() => expect(screen.queryByRole('region')).not.toBeInTheDocument());
    view.unmount();
    render(<PushPermissionPrompt capabilities={capabilities} userId="user-a" />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('asks again on a later app start after an unremembered decline', async () => {
    const user = userEvent.setup();
    const view = render(<PushPermissionPrompt capabilities={capabilities} userId="user-a" />);

    await user.click(screen.getByRole('button', { name: i18n.t('pushOnboarding.decline') }));

    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(mocks.enable).not.toHaveBeenCalled();
    view.unmount();
    render(<PushPermissionPrompt capabilities={capabilities} userId="user-a" />);
    expect(screen.getByRole('region', { name: i18n.t('pushOnboarding.title') })).toBeVisible();
  });

  it('does not ask again after a decline with the opt-out selected', async () => {
    const user = userEvent.setup();
    const view = render(<PushPermissionPrompt capabilities={capabilities} userId="user-a" />);

    await user.click(screen.getByRole('checkbox', { name: i18n.t('pushOnboarding.neverAskAgain') }));
    await user.click(screen.getByRole('button', { name: i18n.t('pushOnboarding.decline') }));

    view.unmount();
    render(<PushPermissionPrompt capabilities={capabilities} userId="user-a" />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('shows recovery guidance after native denial', async () => {
    mocks.enable.mockImplementation(async () => {
      setNotificationPermission('denied');
      throw new Error('denied');
    });
    const user = userEvent.setup();
    const view = render(<PushPermissionPrompt capabilities={capabilities} userId="user-a" />);

    await user.click(screen.getByRole('button', { name: i18n.t('pushOnboarding.allow') }));

    expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('pushOnboarding.permissionDenied'));
    await user.click(screen.getByRole('button', { name: i18n.t('pushOnboarding.close') }));
    view.unmount();
    setNotificationPermission('default');
    render(<PushPermissionPrompt capabilities={capabilities} userId="user-a" />);
    expect(screen.getByRole('region', { name: i18n.t('pushOnboarding.title') })).toBeVisible();
  });

  it('remembers a dismissed native request only when the opt-out is selected', async () => {
    mocks.enable.mockRejectedValue(new Error('dismissed'));
    const user = userEvent.setup();
    const view = render(<PushPermissionPrompt capabilities={capabilities} userId="user-a" />);

    await user.click(screen.getByRole('checkbox', { name: i18n.t('pushOnboarding.neverAskAgain') }));
    await user.click(screen.getByRole('button', { name: i18n.t('pushOnboarding.allow') }));

    expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('pushOnboarding.permissionDismissed'));
    expect(screen.getByRole('button', { name: i18n.t('pushOnboarding.close') })).toBeVisible();
    await user.click(screen.getByRole('button', { name: i18n.t('pushOnboarding.close') }));
    view.unmount();
    render(<PushPermissionPrompt capabilities={capabilities} userId="user-a" />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('stays hidden when Push is unavailable or the current browser is already registered', () => {
    const view = render(<PushPermissionPrompt capabilities={{ ...capabilities, webPushAvailable: false }} userId="user-a" />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();

    view.unmount();
    mocks.currentDeviceId.mockReturnValue('device-a');
    render(<PushPermissionPrompt capabilities={capabilities} userId="user-b" />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('stays hidden in an iOS browser until the web app is installed', () => {
    mocks.ios.mockReturnValue(true);
    mocks.standalone.mockReturnValue(false);

    render(<PushPermissionPrompt capabilities={capabilities} userId="user-a" />);

    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});
