import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { demoSession } from '@/demo/data';
import i18n from '@/i18n';
import { PlanningPage } from './PlanningPage';
import { PLANNING_VIEW_STORAGE_KEY } from './planningViewPreference';
import styles from './Planning.module.css';

const mocks = vi.hoisted(() => ({
  getPlanningEvents: vi.fn(),
  getPlanningSettings: vi.fn(),
  navigate: vi.fn(),
  useMediaQuery: vi.fn(),
  useActiveGroup: vi.fn(),
  useSearch: vi.fn(),
}));

interface LinkMockProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  children: ReactNode;
  search?: { date?: string; view?: string };
  to: string;
}

vi.mock('@/api/client', () => ({ api: { getPlanningEvents: mocks.getPlanningEvents, getPlanningSettings: mocks.getPlanningSettings } }));
vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => mocks.useActiveGroup() }));
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: (query: string) => mocks.useMediaQuery(query) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, search, to, ...props }: LinkMockProps) => <a data-search-date={search?.date} href={to} {...props}>{children}</a>,
  useNavigate: () => mocks.navigate,
  useSearch: () => mocks.useSearch(),
}));

function renderPage(): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><PlanningPage /></QueryClientProvider>);
}

describe('PlanningPage calendar actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPlanningSettings.mockResolvedValue({ enabled: true, timeZone: 'Europe/Berlin', version: 1 });
    mocks.getPlanningEvents.mockResolvedValue({ items: [] });
    mocks.useActiveGroup.mockReturnValue({ activeGroupId: demoSession.activeGroupId, activeGroup: demoSession.groups[0], session: demoSession });
    mocks.useMediaQuery.mockReturnValue(false);
    mocks.useSearch.mockReturnValue({ date: '2026-08-13', view: 'month' });
    window.localStorage.clear();
  });

  it('keeps the document scroll position while selecting a calendar date', async () => {
    const user = userEvent.setup();
    renderPage();

    const targetCell = await screen.findByRole('gridcell', { name: /Mittwoch, 5\. August 2026/ });
    await user.click(within(targetCell).getByRole('button'));

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({
      replace: true,
      resetScroll: false,
      to: '/planning',
    })));
    const navigation = mocks.navigate.mock.calls.at(-1)?.[0] as { search: (current: { date: string; view: string }) => { date: string; view: string } };
    expect(navigation.search({ date: '2026-08-13', view: 'month' })).toEqual({ date: '2026-08-05', view: 'month' });
  });

  it('turns the selected day into a date-aware create action', async () => {
    const user = userEvent.setup();
    renderPage();

    const calendar = await screen.findByRole('region', { name: i18n.t('planning.month') });
    expect(within(calendar).getByText('Donnerstag, 13. August')).toBeVisible();
    expect(within(calendar).queryByText('Ausgewählter Tag')).not.toBeInTheDocument();
    const selectedDay = within(calendar).getByRole('gridcell', { name: i18n.t('planning.selectedDayLabel', { date: 'Donnerstag, 13. August 2026', count: 0 }) });
    expect(selectedDay.querySelector('svg')).toBeNull();

    await user.click(within(selectedDay).getByRole('button'));

    expect(mocks.navigate).toHaveBeenLastCalledWith({
      search: { date: '2026-08-13', view: 'month' },
      to: '/planning/new',
    });
  });

  it('exposes one date-aware header create action on tablet and desktop', async () => {
    renderPage();

    const createLink = await screen.findByRole('link', { name: i18n.t('planning.create') });
    expect(createLink).toHaveAttribute('href', '/planning/new');
    expect(createLink).toHaveAttribute('data-search-date', '2026-08-13');
    expect(createLink).toHaveAttribute('title', i18n.t('planning.create'));
    expect(createLink).toHaveClass(styles.buttonLink);
    expect(createLink).toHaveTextContent(i18n.t('planning.actions.createShort'));
    expect(mocks.useMediaQuery).toHaveBeenCalledWith('(max-width: 767px)');
  });

  it('exposes only the compact floating create action on phones', async () => {
    mocks.useMediaQuery.mockReturnValue(true);
    renderPage();

    const createLink = await screen.findByRole('link', { name: i18n.t('planning.create') });
    expect(createLink).toHaveAttribute('href', '/planning/new');
    expect(createLink).toHaveAttribute('data-search-date', '2026-08-13');
    expect(createLink).toHaveClass(styles.floatingCreateButton);
    expect(createLink).toHaveTextContent(i18n.t('planning.create'));
  });

  it('expands all-day events across month cells and lists them before timed events', async () => {
    mocks.getPlanningEvents.mockResolvedValue({ items: [
      { id: 'timed', version: 1, eventType: 'APPOINTMENT', status: 'PUBLISHED', title: 'Evening', description: '', location: '', allDay: false, timeZone: 'Europe/Berlin', startsAt: '2026-08-13T16:00:00Z', endsAt: '2026-08-13T17:00:00Z', waitlistEnabled: false, confirmationRevision: 1, audience: { type: 'ALL_ACTIVE_MEMBERS', roleIds: [], memberIds: [] }, participation: { invited: 0, attending: 0, maybe: 0, declined: 0, unanswered: 0, waitlisted: 0, reconfirmationRequired: 0 }, canEdit: false, canCancel: false, canRespond: false, canViewParticipants: false },
      { id: 'all-day', version: 1, eventType: 'APPOINTMENT', status: 'PUBLISHED', title: 'Camp', description: '', location: '', allDay: true, startDate: '2026-08-12', endDateExclusive: '2026-08-15', timeZone: 'Europe/Berlin', startsAt: '2026-08-11T22:00:00Z', endsAt: '2026-08-14T22:00:00Z', waitlistEnabled: false, confirmationRevision: 1, audience: { type: 'ALL_ACTIVE_MEMBERS', roleIds: [], memberIds: [] }, participation: { invited: 0, attending: 0, maybe: 0, declined: 0, unanswered: 0, waitlisted: 0, reconfirmationRequired: 0 }, canEdit: false, canCancel: false, canRespond: false, canViewParticipants: false },
    ] });
    renderPage();

    const selected = await screen.findByRole('gridcell', { name: /Donnerstag, 13\. August 2026, 2 Termine/ });
    expect(selected.querySelector('svg')).toBeNull();
    expect(selected.querySelector('[data-segment="middle"]')).not.toBeNull();
    expect(screen.getByRole('gridcell', { name: /Mittwoch, 12\. August 2026, 1 Termine/ }).querySelector('[data-segment="start"]')).not.toBeNull();
    const agenda = screen.getByRole('region', { name: i18n.t('planning.agenda') });
    expect(agenda.textContent?.indexOf(i18n.t('planning.allDay'))).toBeLessThan(agenda.textContent?.indexOf('18:00') ?? -1);
  });

  it('prefers the URL over storage and defaults missing state to week on every viewport', async () => {
    window.localStorage.setItem(PLANNING_VIEW_STORAGE_KEY, JSON.stringify({ version: 1, view: 'agenda' }));
    const firstView = renderPage();
    expect(await screen.findByRole('button', { name: i18n.t('planning.month'), pressed: true })).toBeVisible();
    firstView.unmount();

    mocks.useSearch.mockReturnValue({ date: '2026-08-13' });
    window.localStorage.clear();
    renderPage();
    expect(await screen.findByRole('button', { name: i18n.t('planning.week'), pressed: true })).toBeVisible();
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
    const canonical = mocks.navigate.mock.calls.at(-1)?.[0] as { search: (current: { date: string }) => unknown };
    expect(canonical.search({ date: '2026-08-13' })).toEqual({ date: '2026-08-13', view: 'week' });
  });

  it('persists only an explicit view selection and requests its bounded civil range', async () => {
    const user = userEvent.setup();
    mocks.useSearch.mockReturnValue({ date: '2026-08-13', view: 'week' });
    renderPage();
    await screen.findByRole('region', { name: i18n.t('planning.timeGrid') });
    expect(mocks.getPlanningEvents).toHaveBeenCalledWith(demoSession.activeGroupId, expect.objectContaining({ fromDate: '2026-08-10', toDateExclusive: '2026-08-17' }));

    await user.click(screen.getByRole('button', { name: i18n.t('planning.day') }));
    expect(JSON.parse(window.localStorage.getItem(PLANNING_VIEW_STORAGE_KEY) ?? '')).toEqual({ version: 1, view: 'day' });
    const navigation = mocks.navigate.mock.calls.at(-1)?.[0] as { search: (current: { date: string }) => unknown };
    expect(navigation.search({ date: '2026-08-13' })).toEqual({ date: '2026-08-13', view: 'day' });
  });
});
