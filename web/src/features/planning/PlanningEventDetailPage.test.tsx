import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanningEvent, PlanningEventBase, PlanningParticipant, PlanningTimedEventTiming } from '@/api/types';
import i18n from '@/i18n';
import { PlanningEventDetailPage } from './PlanningEventDetailPage';
import styles from './Planning.module.css';

const mocks = vi.hoisted(() => ({ getPlanningEvent: vi.fn(), getPlanningParticipants: vi.fn(), getPlanningSeries: vi.fn(), getPlanningSettings: vi.fn(), updatePlanningParticipation: vi.fn() }));

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

vi.mock('@/api/client', () => ({ ApiError: class ApiError extends Error {}, api: { getPlanningEvent: mocks.getPlanningEvent, getPlanningParticipants: mocks.getPlanningParticipants, getPlanningSeries: mocks.getPlanningSeries, getPlanningSettings: mocks.getPlanningSettings, updatePlanningParticipation: mocks.updatePlanningParticipation } }));
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
    mocks.getPlanningParticipants.mockResolvedValue({ items: [] });
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
    expect(document.querySelector(`.${styles.detailLayout}`)).toHaveClass(styles.detailLayoutSingle);
  });

  it('uses the shared detail layout and lists appointment invitees alphabetically', async () => {
    mocks.getPlanningEvent.mockResolvedValue(planningEvent({ canViewParticipants: true }));
    mocks.getPlanningParticipants.mockResolvedValue({ items: [
      { membershipId: 'zora', displayName: 'Zora Zusage', confirmedRevision: 0, version: 1 },
      { membershipId: 'anton', displayName: 'Anton Einladung', confirmedRevision: 0, version: 1 },
    ] satisfies PlanningParticipant[] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><PlanningEventDetailPage /></QueryClientProvider>);

    const participantsHeading = await screen.findByRole('heading', { name: i18n.t('planning.participants') });
    const participantsCard = participantsHeading.closest('section') as HTMLElement;
    const invitedHeading = await within(participantsCard).findByRole('heading', { level: 3 });
    const detailLayout = participantsCard.parentElement?.parentElement;
    expect(detailLayout).toHaveClass(styles.detailLayout);
    expect(detailLayout).not.toHaveClass(styles.detailLayoutSingle);
    expect(invitedHeading).toHaveTextContent(`${i18n.t('planning.participantsInvited')}2`);
    expect(within(participantsCard).getAllByRole('img').map((image) => image.getAttribute('aria-label'))).toEqual([
      'Anton Einladung',
      'Zora Zusage',
    ]);
    expect(screen.queryByRole('heading', { name: i18n.t('planning.counts.title') })).not.toBeInTheDocument();
    expect(mocks.getPlanningParticipants).toHaveBeenCalledWith('group-1', 'all-day-event', undefined, 100);
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
    expect(responseSummary?.querySelector('fieldset > p')).toBeNull();
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

  it('shows registration availability, occupancy, and waitlist status', async () => {
    mocks.getPlanningEvent.mockResolvedValue(planningEvent({
      canRespond: true,
      eventType: 'APPOINTMENT_REGISTRATION',
      capacity: 8,
      waitlistEnabled: true,
      participation: { invited: 9, attending: 3, maybe: 0, declined: 0, unanswered: 5, waitlisted: 1, reconfirmationRequired: 0 },
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><PlanningEventDetailPage /></QueryClientProvider>);

    expect(await screen.findByText('5 frei')).toBeVisible();
    expect(screen.getByText('3 von 8 belegt')).toBeVisible();
    expect(screen.getByText('Warteliste · 1')).toBeVisible();
    const progress = screen.getByRole('progressbar', { name: '3 von 8 Plätzen belegt' });
    expect(progress).toHaveAttribute('value', '3');
    expect(progress).toHaveAttribute('max', '8');
    expect(progress).toHaveAttribute('data-tone', 'low');
  });

  it('replaces an unavailable waitlist count with unlimited capacity', async () => {
    mocks.getPlanningEvent.mockResolvedValue(planningEvent({ canRespond: true, eventType: 'APPOINTMENT_REGISTRATION' }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><PlanningEventDetailPage /></QueryClientProvider>);

    expect(await screen.findByText(i18n.t('planning.participation.unlimitedCapacity'))).toBeVisible();
    expect(screen.getByText(i18n.t('planning.participation.places'))).toBeVisible();
    expect(screen.queryByText(i18n.t('planning.counts.waitlisted'))).not.toBeInTheDocument();
  });

  it('uses the waitlist tile as the registration action when capacity is full', async () => {
    const event = planningEvent({
      canRespond: true,
      eventType: 'APPOINTMENT_REGISTRATION',
      capacity: 2,
      waitlistEnabled: true,
      participation: { invited: 3, attending: 2, maybe: 0, declined: 0, unanswered: 1, waitlisted: 0, reconfirmationRequired: 0 },
    });
    mocks.getPlanningEvent.mockResolvedValue(event);
    mocks.updatePlanningParticipation.mockResolvedValue({
      ...event,
      participation: { ...event.participation, waitlisted: 1 },
      viewerParticipation: { status: 'WAITLISTED' },
    } satisfies PlanningEvent);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();

    render(<QueryClientProvider client={client}><PlanningEventDetailPage /></QueryClientProvider>);

    expect(await screen.findByText('0 frei')).toBeVisible();
    expect(screen.getByText('2 von 2 belegt')).toBeVisible();
    expect(screen.getByText('Warteliste · 0')).toBeVisible();
    expect(screen.getByRole('progressbar')).toHaveAttribute('data-tone', 'high');
    const waitlistChoice = screen.getByRole('checkbox', { name: i18n.t('planning.participation.joinWaitlist') });
    expect(screen.queryByRole('checkbox', { name: new RegExp(i18n.t('planning.participation.attending')) })).not.toBeInTheDocument();
    await user.click(waitlistChoice.closest('label') as HTMLElement);

    expect(mocks.updatePlanningParticipation).toHaveBeenCalledWith('group-1', event.id, 'APPOINTMENT_REGISTRATION', 'ATTENDING');
    await waitFor(() => expect(screen.getByRole('checkbox', { name: i18n.t('planning.participation.leaveWaitlist') })).toBeChecked());
  });

  it('keeps a full registration without a waitlist informational', async () => {
    mocks.getPlanningEvent.mockResolvedValue(planningEvent({
      canRespond: true,
      eventType: 'APPOINTMENT_REGISTRATION',
      capacity: 2,
      waitlistEnabled: false,
      participation: { invited: 2, attending: 2, maybe: 0, declined: 0, unanswered: 0, waitlisted: 0, reconfirmationRequired: 0 },
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><PlanningEventDetailPage /></QueryClientProvider>);

    expect(await screen.findByText('0 frei')).toBeVisible();
    expect(screen.getByText('2 von 2 belegt')).toBeVisible();
    expect(screen.getByText(i18n.t('planning.participation.noWaitlist'))).toBeVisible();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('uses a warning progress tone as registration capacity fills', async () => {
    mocks.getPlanningEvent.mockResolvedValue(planningEvent({
      canRespond: true,
      eventType: 'APPOINTMENT_REGISTRATION',
      capacity: 10,
      waitlistEnabled: true,
      participation: { invited: 10, attending: 7, maybe: 0, declined: 0, unanswered: 3, waitlisted: 0, reconfirmationRequired: 0 },
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><PlanningEventDetailPage /></QueryClientProvider>);

    expect(await screen.findByText('3 frei')).toBeVisible();
    expect(screen.getByText('7 von 10 belegt')).toBeVisible();
    expect(screen.getByRole('progressbar')).toHaveAttribute('data-tone', 'medium');
  });

  it('sorts participants by response and alphabetically within each response', async () => {
    const participant = (membershipId: string, displayName: string, effectiveStatus?: PlanningParticipant['effectiveStatus']): PlanningParticipant => ({ membershipId, displayName, effectiveStatus, confirmedRevision: 1, version: 1 });
    mocks.getPlanningEvent.mockResolvedValue(planningEvent({ canViewParticipants: true, eventType: 'APPOINTMENT_REGISTRATION' }));
    mocks.getPlanningParticipants.mockResolvedValue({ items: [
      participant('open', 'Otto Offen'),
      participant('attending-z', 'Zora Zusage', 'ATTENDING'),
      participant('withdrawn', 'Ava Abgemeldet', 'WITHDRAWN'),
      participant('waitlisted', 'Wanda Warteliste', 'WAITLISTED'),
      participant('attending-a', 'Anton Zusage', 'ATTENDING'),
      participant('declined', 'Nora Absage', 'DECLINED'),
      participant('maybe', 'Mia Vielleicht', 'MAYBE'),
    ] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><PlanningEventDetailPage /></QueryClientProvider>);

    const responseHeadings = await screen.findAllByRole('heading', { level: 3 });
    const responseGroups = responseHeadings.map((heading) => heading.closest('section')).filter((group): group is HTMLElement => group !== null);
    expect(responseHeadings.map((heading) => heading.textContent)).toEqual([
      'Dabei2',
      'Vielleicht1',
      'Warteliste1',
      'Nicht dabei1',
      'Offen1',
      'Abgemeldet1',
    ]);
    expect(responseGroups.flatMap((group) => within(group).getAllByRole('img')).map((image) => image.getAttribute('aria-label'))).toEqual([
      'Anton Zusage',
      'Zora Zusage',
      'Mia Vielleicht',
      'Wanda Warteliste',
      'Nora Absage',
      'Otto Offen',
      'Ava Abgemeldet',
    ]);
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
    const recurrenceSeparator = recurrencePattern.parentElement?.querySelector(`.${styles.seriesSummarySeparator}`);
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
    expect(recurrenceSeparator?.nextElementSibling).toBe(recurrenceRange);
  });

  it('keeps a completed event deadline as the leftmost response-footer item', async () => {
    mocks.getPlanningEvent.mockResolvedValue(planningEvent({
      eventType: 'APPOINTMENT_REGISTRATION',
      status: 'COMPLETED',
      responseDeadline: '2026-09-08T22:00:00+02:00',
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><PlanningEventDetailPage /></QueryClientProvider>);

    const deadlineLabel = await screen.findByText(i18n.t('planning.fields.deadline'));
    const deadlineList = deadlineLabel.closest('dl');
    const footer = deadlineList?.parentElement;
    expect(footer).toHaveClass(styles.detailCountsActions);
    expect(footer?.children).toHaveLength(1);
    expect(footer?.firstElementChild).toBe(deadlineList);
    expect(screen.queryByRole('button', { name: i18n.t('planning.actions.close') })).not.toBeInTheDocument();
  });
});
