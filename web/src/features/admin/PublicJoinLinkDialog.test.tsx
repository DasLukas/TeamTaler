import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { PublicJoinLinkDialog } from './PublicJoinLinkDialog';

const mocks = vi.hoisted(() => ({
  getPublicJoinLink: vi.fn(),
  updatePublicJoinLink: vi.fn(),
  rotatePublicJoinLink: vi.fn(),
  toDataURL: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  api: {
    getPublicJoinLink: mocks.getPublicJoinLink,
    updatePublicJoinLink: mocks.updatePublicJoinLink,
    rotatePublicJoinLink: mocks.rotatePublicJoinLink,
  },
}));

vi.mock('qrcode', () => ({ toDataURL: mocks.toDataURL }));

vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));

function renderDialog(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  render(<PublicJoinLinkDialog groupId="group-a" onClose={vi.fn()} />, { wrapper });
}

describe('PublicJoinLinkDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    mocks.toDataURL.mockResolvedValue('data:image/png;base64,qr');
    mocks.getPublicJoinLink.mockResolvedValue({ enabled: false, expired: false, expiresAt: null, version: 0, emailVerificationAvailable: true });
  });

  it('creates the default one-day link and generates its QR code locally', async () => {
    const user = userEvent.setup();
    const activeLink = {
      enabled: true,
      expired: false,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      acceptUrl: 'https://teamtaler.example/join#token=join-token',
      version: 1,
      emailVerificationAvailable: true,
    };
    mocks.updatePublicJoinLink.mockResolvedValue(activeLink);
    renderDialog();

    await user.click(await screen.findByRole('button', { name: i18n.t('publicJoin.create') }));

    await waitFor(() => expect(mocks.updatePublicJoinLink).toHaveBeenCalledOnce());
    const [, update, version] = mocks.updatePublicJoinLink.mock.calls[0] as [string, { enabled: boolean; expiresAt: string | null }, number];
    expect(version).toBe(0);
    expect(update.enabled).toBe(true);
    expect(Date.parse(update.expiresAt ?? '')).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1_000);
    expect(await screen.findByAltText(i18n.t('publicJoin.qrAlt'))).toHaveAttribute('src', 'data:image/png;base64,qr');
    expect(mocks.toDataURL).toHaveBeenCalledWith(activeLink.acceptUrl, expect.objectContaining({ errorCorrectionLevel: 'M' }));

    await user.click(screen.getByRole('button', { name: i18n.t('common.copy') }));
	expect(await navigator.clipboard.readText()).toBe(activeLink.acceptUrl);
    expect(await screen.findByRole('button', { name: i18n.t('common.copied') })).toBeVisible();
  });

  it('requires confirmation before rotation and sends the current version', async () => {
    const user = userEvent.setup();
    const activeLink = {
      enabled: true,
      expired: false,
      expiresAt: null,
      acceptUrl: 'https://teamtaler.example/join#token=join-token',
      version: 4,
      emailVerificationAvailable: true,
    };
    mocks.getPublicJoinLink.mockResolvedValue(activeLink);
    mocks.rotatePublicJoinLink.mockResolvedValue({ ...activeLink, acceptUrl: 'https://teamtaler.example/join#token=rotated', version: 5 });
    renderDialog();

    await user.click(await screen.findByRole('button', { name: i18n.t('publicJoin.rotate') }));
    expect(mocks.rotatePublicJoinLink).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: i18n.t('common.confirm') }));

    await waitFor(() => expect(mocks.rotatePublicJoinLink).toHaveBeenCalledWith('group-a', 4));
  });

  it('explains why public joining cannot be enabled without email delivery', async () => {
    mocks.getPublicJoinLink.mockResolvedValue({ enabled: false, expired: false, expiresAt: null, version: 0, emailVerificationAvailable: false });
    renderDialog();

    expect(await screen.findByRole('heading', { name: i18n.t('publicJoin.unavailableTitle') })).toBeVisible();
    expect(screen.queryByRole('button', { name: i18n.t('publicJoin.create') })).not.toBeInTheDocument();
  });
});
