import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanningEvent, PlanningEventBase, PlanningTimedEventTiming } from '@/api/types';
import i18n from '@/i18n';
import { PlanningEventDetailPage } from './PlanningEventDetailPage';
import styles from './Planning.module.css';

const mocks = vi.hoisted(() => ({ getPlanningEvent: vi.fn(), getPlanningSeries: vi.fn(), getPlanningSettings: vi.fn(), updatePlanningParticipation: vi.fn() }));

/**
 * Creates a complete planning-event projection for detail-page tests.
 *
 * @param overrides - Event properties that differ from the default appointment.
 * @returns A planning event suitable for rendering the detail page.
 */
function planningEvent(overrides: Partial<PlanningEventBase & PlanningTimedEventTiming> = {}): PlanningEvent {
  return {
    id: 'all-day-event',
    version: 1,
    eventType: 'APPOINTMENT',
    status: 'PUBLISHED',
    title: 'Team evening',
    description: 'Weekly planning',
    location: 'Clubhouse',
    allDay: false,
    timeZone: 'Europe/Berlin',
    startsAt: '2026-09-09T09:00:00+02:00',
    endsAt: '2026-09-09T10:00:00+02:00',
    waitlistEnabled: false,
    confirmationRevision: 1,
    audience: { type: 'ALL_ACTIVE_MEMBERS', roleIds: [], memberIds: [] },
    participation: { invited: 0, attending: 0, maybe: 0, declined: 0, unanswered: 0, waitlisted: 0, reconfirmationRequired: 0 },
    canEdit: true,
    canCancel: true,
    canRespond: false,
    canViewParticipants: false,
    ...overrides,
  };
}

vi.mock('@/api/client', () => ({ ApiError: class ApiError extends Error {}, api: { getPlanningEvent: mocks.getPlanningEvent, getPlanningSeries: mocks.getPlanningSeries, getPlanningSettings: mocks.getPlanningSettings, updatePlanningParticipation: mocks.updatePlanningParticipation } }));
vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => ({ activeGroupId: 'group-1', activeGroup: { membership: { effectiveGrants: [] } } }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, params, search, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode; params?: unknown; search?: unknown; to: string }) => {
    void params;
    void search;
    return <a href={to} {...props}>{children}</a>;
  },
  useParams: () => ({ eventId: 'all-day-event' }),
  useSearch: () => ({ view: 'month', date: '2026-09-05' }),
}));

describe('PlanningEventDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPlanningSettings.mockResolvedValue({ enabled: true, version: 1, timeZone: 'Europe/Berlin' });
    mocks.getPlanningSeries.mockResolvedValue({
      id: 'series-1', version: 1, status: 'PUBLISHED', timeZone: 'Europe/Berlin', eventType: 'APPOINTMENT_REGISTRATION', title: 'Team evening', description: 'Weekly planning', location: 'Clubhouse', allDay: false, durationMinutes: 60, waitlistEnabled: true, audience: { type: 'ALL_ACTIVE_MEMBERS', roleIds: [], memberIds: [] }, recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: ['WE'], range: { type: 'COUNT', count: 5 } },
    });
  });

  it('shows the inclusive date range and never renders derived midnight instants', async () => {
    const event: PlanningEvent = {
      id: 'all-day-event',
      version: 1,
      eventType: 'APPOINTMENT',
      status: 'PUBLISHED',
      title: 'Team weekend',
      description: '',
      location: '',
      allDay: true,
      startDate: '2026-09-05',
      endDateExclusive: '2026-09-08',
      timeZone: 'Europe/Berlin',
      startsAt: '2026-09-04T22:00:00Z',
      endsAt: '2026-09-07T22:00:00Z',
      waitlistEnabled: false,
      confirmationRevision: 1,
      audience: { type: 'ALL_ACTIVE_MEMBERS', roleIds: [], memberIds: [] },
      participation: { invited: 0, attending: 0, maybe: 0, declined: 0, unanswered: 0, waitlisted: 0, reconfirmationRequired: 0 },
      canEdit: false,
      canCancel: false,
      canRespond: false,
      canViewParticipants: false,
    };
    mocks.getPlanningEvent.mockResolvedValue(event);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><PlanningEventDetailPage /></QueryClientProvider>);

    expect(await screen.findByText('05.09.2026–07.09.2026')).toBeVisible();
    expect(screen.getByText(/Ganztägig/)).toBeVisible();
    expect(screen.queryByText(/00:00/)).not.toBeInTheDocument();
  });

  it('places cancellation before editing and hides closing for appointments', async () => {
    const event = planningEvent();
    mocks.getPlanningEvent.mockResolvedValue(event);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><PlanningEventDetailPage /></QueryClientProvider>);

    const backLink = await screen.findByRole('link', { name: i18n.t('planning.backToCalendar') });
    const editLink = screen.getByRole('link', { name: i18n.t('common.edit') });
    expect(backLink.parentElement).toHaveClass(styles.detailNavigation);
    expect(backLink.parentElement).toContainElement(editLink.parentElement);
    expect(editLink).toHaveClass(styles.detailEditLink);
    expect(editLink).toHaveAttribute('title', i18n.t('common.edit'));

    expect(screen.queryByRole('button', { name: i18n.t('planning.actions.close') })).not.toBeInTheDocument();
    const cancelButton = screen.getByRole('button', { name: i18n.t('planning.actions.cancel') });
    const navigationActions = editLink.parentElement;
    expect(navigationActions).toHaveClass(styles.detailNavigationActions);
    expect(navigationActions).toContainElement(cancelButton);
    expect(cancelButton.nextElementSibling).toBe(editLink);
    expect(cancelButton).toHaveAttribute('title', i18n.t('planning.actions.cancel'));
  });

  it.each(['APPOINTMENT_POLL', 'APPOINTMENT_REGISTRATION'] as const)('keeps closing available for %s events', async (eventType) => {
    mocks.getPlanningEvent.mockResolvedValue(planningEvent({ canRespond: true, eventType }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><PlanningEventDetailPage /></QueryClientProvider>);

    const closeButton = await screen.findByRole('button', { name: i18n.t('planning.actions.close') });
    const cancelButton = screen.getByRole('button', { name: i18n.t('planning.actions.cancel') });
    const editLink = screen.getByRole('link', { name: i18n.t('common.edit') });
    const responseSummary = screen.getByRole('heading', { name: i18n.t('planning.counts.title') }).closest('section');
    const choiceRole = eventType === 'APPOINTMENT_POLL' ? 'radio' : 'checkbox';
    const attendingChoice = screen.getByRole(choiceRole, { name: new RegExp(i18n.t('planning.participation.attending')) });
    expect(closeButton.parentElement).toHaveClass(styles.detailCountsActions);
    expect(responseSummary).toContainElement(attendingChoice);
    expect(responseSummary).toContainElement(closeButton);
    expect(screen.queryByRole('heading', { name: i18n.t('planning.participation.title') })).not.toBeInTheDocument();
    expect(attendingChoice.closest('label')).toHaveClass(styles.countChoice);
    expect(document.querySelectorAll(`section.${styles.detailCard}`)).toHaveLength(2);
    expect(cancelButton.parentElement).toHaveClass(styles.detailNavigationActions);
    expect(cancelButton.nextElementSibling).toBe(editLink);
  });

  it('omits personal response controls when the event cannot be answered', async () => {
    mocks.getPlanningEvent.mockResolvedValue(planningEvent({ canRespond: false, eventType: 'APPOINTMENT_POLL' }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><PlanningEventDetailPage /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: i18n.t('planning.counts.title') })).toBeVisible();
    expect(screen.queryByRole('radio', { name: new RegExp(i18n.t('planning.participation.attending')) })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: new RegExp(i18n.t('planning.participation.attending')) })).not.toBeInTheDocument();
    expect(screen.getByText(i18n.t('planning.counts.attending'))).toBeVisible();
  });

  it('updates the selected poll count after choosing its aggregate tile', async () => {
    const event = planningEvent({
      canRespond: true,
      eventType: 'APPOINTMENT_POLL',
      participation: { invited: 3, attending: 0, maybe: 0, declined: 0, unanswered: 3, waitlisted: 0, reconfirmationRequired: 0 },
    });
    mocks.getPlanningEvent.mockResolvedValue(event);
    mocks.updatePlanningParticipation.mockResolvedValue({
      ...event,
      participation: { ...event.participation, attending: 1, unanswered: 2 },
      viewerParticipation: { status: 'ATTENDING' },
    } satisfies PlanningEvent);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();

    render(<QueryClientProvider client={client}><PlanningEventDetailPage /></QueryClientProvider>);

    const attendingChoice = await screen.findByRole('radio', { name: new RegExp(i18n.t('planning.participation.attending')) });
    const attendingTile = attendingChoice.closest('label') as HTMLElement;
    expect(within(attendingTile).getByText('0')).toBeVisible();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getAllByRole('radio').map((choice) => choice.getAttribute('name'))).toEqual([`participation-${event.id}`, `participation-${event.id}`, `participation-${event.id}`]);
    await user.click(attendingTile);

    expect(mocks.updatePlanningParticipation).toHaveBeenCalledWith('group-1', event.id, 'APPOINTMENT_POLL', 'ATTENDING');
    await waitFor(() => {
      const selectedChoice = screen.getByRole('radio', { name: new RegExp(i18n.t('planning.participation.attending')) });
      expect(selectedChoice).toBeChecked();
      expect(within(selectedChoice.closest('label') as HTMLElement).getByText('1')).toBeVisible();
      expect(within(screen.getByText(i18n.t('planning.counts.unanswered')).parentElement as HTMLElement).getByText('2')).toBeVisible();
    });
  });

  it('withdraws a registration by selecting its active aggregate tile again', async () => {
    const event = planningEvent({
      canRespond: true,
      eventType: 'APPOINTMENT_REGISTRATION',
      participation: { invited: 3, attending: 1, maybe: 0, declined: 0, unanswered: 0, waitlisted: 0, reconfirmationRequired: 0 },
      viewerParticipation: { status: 'ATTENDING' },
    });
    mocks.getPlanningEvent.mockResolvedValue(event);
    mocks.updatePlanningParticipation.mockResolvedValue({
      ...event,
      participation: { ...event.participation, attending: 0 },
      viewerParticipation: { status: 'WITHDRAWN' },
    } satisfies PlanningEvent);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();

    render(<QueryClientProvider client={client}><PlanningEventDetailPage /></QueryClientProvider>);

    const attendingChoice = await screen.findByRole('checkbox', { name: new RegExp(i18n.t('planning.participation.attending')) });
    const attendingTile = attendingChoice.closest('label') as HTMLElement;
    expect(attendingChoice).toBeChecked();
    await user.click(attendingTile);

    expect(mocks.updatePlanningParticipation).toHaveBeenCalledWith('group-1', event.id, 'APPOINTMENT_REGISTRATION', 'WITHDRAWN');
    await waitFor(() => {
      const availableChoice = screen.getByRole('checkbox', { name: new RegExp(i18n.t('planning.participation.attending')) });
      expect(availableChoice).not.toBeChecked();
      expect(within(availableChoice.closest('label') as HTMLElement).getByText('0')).toBeVisible();
    });
  });

  it('keeps the event-detail order and places the response deadline in the response footer', async () => {
    const description = 'Registration with capacity and waitlist.';
    mocks.getPlanningEvent.mockResolvedValue(planningEvent({
      eventType: 'APPOINTMENT_REGISTRATION',
      description,
      responseDeadline: '2026-09-08T22:00:00+02:00',
      seriesId: 'series-1',
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><PlanningEventDetailPage /></QueryClientProvider>);

    const locationLabel = await screen.findByText(i18n.t('planning.fields.location'));
    const descriptionText = screen.getByText(description);
    const startLabel = screen.getByText(i18n.t('planning.fields.start'));
    const deadlineLabel = screen.getByText(i18n.t('planning.fields.deadline'));
    const deadlineList = deadlineLabel.closest('dl');
    const closeButton = screen.getByRole('button', { name: i18n.t('planning.actions.close') });
    const responseSummary = screen.getByRole('heading', { name: i18n.t('planning.counts.title') }).closest('section');
    const recurrencePattern = screen.getByText('Wöchentlich am Mi');
    const recurrenceRange = screen.getByText('endet nach 5 Terminen');
    const recurrenceSeparator = screen.getByText('·');
    expect(locationLabel.compareDocumentPosition(descriptionText) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(descriptionText.compareDocumentPosition(startLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(startLabel.compareDocumentPosition(recurrencePattern) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(recurrencePattern.compareDocumentPosition(deadlineLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(deadlineList).toHaveClass(styles.responseDeadline);
    expect(deadlineList?.parentElement).toHaveClass(styles.detailCountsActions);
    expect(responseSummary).toContainElement(deadlineList);
    expect(deadlineList?.nextElementSibling).toBe(closeButton);
    expect(screen.queryByText(i18n.t('planning.recurrence.series'))).not.toBeInTheDocument();
    expect(recurrencePattern.tagName).toBe('SPAN');
    expect(recurrenceRange.tagName).toBe('SPAN');
    expect(recurrencePattern.nextElementSibling).toBe(recurrenceSeparator);
    expect(recurrenceSeparator).toHaveAttribute('aria-hidden', 'true');
    expect(recurrenceSeparator.nextElementSibling).toBe(recurrenceRange);
  });
});
