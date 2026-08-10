import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import modalStyles from '@/components/ui/Modal.module.css';
import i18n from '@/i18n';
import { PublicJoinLinkDialog } from './PublicJoinLinkDialog';
import styles from './PublicJoinLinkDialog.module.css';

const mocks = vi.hoisted(() => ({
  getPublicJoinLink: vi.fn(),
  updatePublicJoinLink: vi.fn(),
  rotatePublicJoinLink: vi.fn(),
  toDataURL: vi.fn(),
  useMediaQuery: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  api: {
    getPublicJoinLink: mocks.getPublicJoinLink,
    updatePublicJoinLink: mocks.updatePublicJoinLink,
    rotatePublicJoinLink: mocks.rotatePublicJoinLink,
  },
}));

vi.mock('qrcode', () => ({ toDataURL: mocks.toDataURL }));

vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => mocks.useMediaQuery() }));

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
    mocks.useMediaQuery.mockReturnValue(false);
    mocks.getPublicJoinLink.mockResolvedValue({ enabled: false, expired: false, expiresAt: null, version: 0, emailVerificationAvailable: true });
  });

  it('uses the full-width sheet variant with a local date-time field on mobile', async () => {
    const user = userEvent.setup();
    mocks.useMediaQuery.mockReturnValue(true);
    mocks.getPublicJoinLink.mockResolvedValue({
      enabled: true,
      expired: false,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      acceptUrl: 'https://teamtaler.example/join#token=join-token',
      version: 1,
      emailVerificationAvailable: true,
    });
    renderDialog();

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveClass(modalStyles.sheet, styles.modal);
    expect(await screen.findByLabelText(i18n.t('publicJoin.customExpiry'))).toHaveAttribute('type', 'datetime-local');
    await user.click(screen.getByRole('combobox', { name: i18n.t('publicJoin.lifetime') }));
    expect(dialog).toContainElement(screen.getByRole('listbox'));
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

  it('keeps the lifetime menu anchored and supports keyboard selection', async () => {
    const user = userEvent.setup();
    renderDialog();

    const lifetime = await screen.findByRole('combobox', { name: i18n.t('publicJoin.lifetime') });
    expect(lifetime.tagName).toBe('BUTTON');
    await user.click(lifetime);
    expect(screen.getByRole('listbox')).toBeVisible();
    expect(screen.getAllByRole('option')).toHaveLength(7);

    await user.keyboard('{End}{Enter}');
    expect(lifetime).toHaveTextContent(i18n.t('publicJoin.lifetimes.unlimited'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(lifetime).toHaveFocus();
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
