import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupSettings, KioskPoster, Session } from '@/api/types';
import i18n from '@/i18n';
import { KioskSettingsSection } from './KioskSettingsSection';

const mocks = vi.hoisted(() => ({
  getKioskPosters: vi.fn(),
  getCategories: vi.fn(),
  updateGroupSettings: vi.fn(),
  createKioskPoster: vi.fn(),
  updateKioskPoster: vi.fn(),
  deleteKioskPoster: vi.fn(),
  getKioskPosterPdf: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: mocks }));
vi.mock('@/features/shared/exportDownload', () => ({ downloadExportBlob: vi.fn() }));

const session: Session = {
  user: { id: 'admin', displayName: 'Admin', email: 'admin@example.test' },
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', defaultTheme: 'TEAMTALER', statisticsEnabled: false, kioskEnabled: false }],
  activeGroupId: 'group-a', defaultGroupId: null, colorMode: 'SYSTEM', systemRoles: [],
};
const settings = { kioskEnabled: false } as GroupSettings;
const standard: KioskPoster = { id: 'standard', name: 'Standard', text: '', productIds: [], isDefault: true, version: 1 };

function renderSection(overrides?: Partial<GroupSettings>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  queryClient.setQueryData(['session'], session);
  const view = render(<QueryClientProvider client={queryClient}><KioskSettingsSection groupId="group-a" settings={{ ...settings, ...overrides }} /></QueryClientProvider>);
  return {
    queryClient,
    rerenderSection: (next: Partial<GroupSettings>) => view.rerender(<QueryClientProvider client={queryClient}><KioskSettingsSection groupId="group-a" settings={{ ...settings, ...next }} /></QueryClientProvider>),
  };
}

describe('KioskSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getKioskPosters.mockResolvedValue([standard]);
    mocks.getCategories.mockResolvedValue([]);
    mocks.updateGroupSettings.mockResolvedValue({ ...settings, kioskEnabled: true });
    mocks.updateKioskPoster.mockResolvedValue({ ...standard, text: 'Welcome', version: 2 });
    mocks.createKioskPoster.mockResolvedValue({ id: 'poster-a', name: 'Bar', text: 'Enjoy', productIds: ['coffee'], isDefault: false, version: 1 });
  });

  it('updates the group master switch and session projection', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderSection();
    await user.click(await screen.findByRole('switch', { name: i18n.t('kiosk.enable') }));
    await waitFor(() => expect(mocks.updateGroupSettings).toHaveBeenCalledWith('group-a', { kioskEnabled: true }));
    expect(queryClient.getQueryData<Session>(['session'])?.groups[0]?.kioskEnabled).toBe(true);
  });

  it('shows poster management only while Scan and Go is enabled', async () => {
    const { rerenderSection } = renderSection();
    expect(screen.getByRole('switch', { name: i18n.t('kiosk.enable') })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: i18n.t('kiosk.postersTitle') })).not.toBeInTheDocument();
    expect(mocks.getKioskPosters).not.toHaveBeenCalled();
    expect(mocks.getCategories).not.toHaveBeenCalled();

    rerenderSection({ kioskEnabled: true });
    expect(await screen.findByRole('heading', { name: i18n.t('kiosk.postersTitle') })).toBeInTheDocument();
    expect(await screen.findByDisplayValue('Standard')).toBeInTheDocument();
    expect(mocks.getKioskPosters).toHaveBeenCalledTimes(1);
    expect(mocks.getCategories).toHaveBeenCalledTimes(1);

    rerenderSection({ kioskEnabled: false });
    expect(screen.queryByRole('heading', { name: i18n.t('kiosk.postersTitle') })).not.toBeInTheDocument();
  });

  it('preselects Standard and only allows changing its free text', async () => {
    const user = userEvent.setup();
    renderSection({ kioskEnabled: true });
    expect(await screen.findByDisplayValue('Standard')).toHaveAttribute('readonly');
    expect(screen.getByText(i18n.t('kiosk.standardPosterHint'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: i18n.t('kiosk.composerAdd') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: i18n.t('common.delete') })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(i18n.t('kiosk.posterText')), 'Welcome');
    await user.click(screen.getByRole('button', { name: i18n.t('common.save') }));
    await waitFor(() => expect(mocks.updateKioskPoster).toHaveBeenCalledWith('group-a', 'standard', 1, { name: 'Standard', text: 'Welcome', productIds: [] }));
  });

  it('requires a product and reserves Standard when creating another poster', async () => {
    const user = userEvent.setup();
    mocks.getCategories.mockResolvedValue([{ id: 'drinks', name: 'Drinks', icon: 'drink', active: true, sortOrder: 0, version: 1, products: [{ id: 'coffee', categoryId: 'drinks', name: 'Club coffee', pricingMode: 'FIXED', currency: 'EUR', price: { minorUnits: '150', currency: 'EUR' }, active: true, sortOrder: 0, version: 1 }] }]);
    renderSection({ kioskEnabled: true });
    await user.click(await screen.findByRole('button', { name: i18n.t('kiosk.newPoster') }));
    expect(screen.getByText(i18n.t('kiosk.posterNeedsProducts'))).toBeInTheDocument();
    await user.type(screen.getByLabelText(i18n.t('kiosk.posterName')), 'Standard');
    expect(screen.getByText(i18n.t('kiosk.posterReservedName'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: i18n.t('common.save') })).toBeDisabled();
    await user.clear(screen.getByLabelText(i18n.t('kiosk.posterName')));
    await user.type(screen.getByLabelText(i18n.t('kiosk.posterName')), 'Bar');
    await user.type(screen.getByLabelText(i18n.t('kiosk.posterText')), 'Enjoy');
    await user.click(screen.getByRole('button', { name: i18n.t('kiosk.composerAdd') }));
    await user.click(await screen.findByRole('button', { name: /Club coffee/ }));
    await user.click(screen.getByRole('button', { name: i18n.t('common.save') }));
    await waitFor(() => expect(mocks.createKioskPoster).toHaveBeenCalledWith('group-a', { name: 'Bar', text: 'Enjoy', productIds: ['coffee'] }));
  });

  it('blocks printing a legacy product poster until a product is added', async () => {
    const user = userEvent.setup();
    mocks.getKioskPosters.mockResolvedValue([standard, { id: 'legacy', name: 'Legacy', text: '', productIds: [], isDefault: false, version: 1 }]);
    renderSection({ kioskEnabled: true });
    await user.click(await screen.findByRole('button', { name: 'Legacy' }));
    expect(screen.getByText(i18n.t('kiosk.posterNeedsProducts'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: i18n.t('kiosk.downloadPdf') })).toBeDisabled();
    expect(screen.getByRole('button', { name: i18n.t('common.save') })).toBeDisabled();
  });
});
