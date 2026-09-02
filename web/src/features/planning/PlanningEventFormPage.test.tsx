import { StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api/client';
import type { PlanningEvent, PlanningSeries, PlanningSettings } from '@/api/types';
import i18n from '@/i18n';
import { PlanningEventFormPage } from './PlanningEventFormPage';
import { planningKeys } from './planningQueryKeys';

const eventId = 'event-cached-series';
const seriesId = 'series-cached';
vi.mock('@/app/permissions', () => ({ can: () => true }));
vi.mock('@/app/useActiveGroup', () => ({
  useActiveGroup: () => ({ activeGroupId: 'group-1', activeGroup: { membership: { effectiveGrants: [] } } }),
}));

const event: PlanningEvent = {
  id: eventId, version: 2, eventType: 'APPOINTMENT_POLL', status: 'PUBLISHED', title: 'Cached lunch poll', description: 'Who joins?', location: 'Kitchen', allDay: false, timeZone: 'Europe/Berlin', startsAt: '2026-08-31T12:00:00+02:00', endsAt: '2026-08-31T13:00:00+02:00', responseDeadlineMinutesBefore: 120, waitlistEnabled: false, confirmationRevision: 1, audience: { type: 'ALL_ACTIVE_MEMBERS', roleIds: [], memberIds: [] }, participation: { invited: 3, attending: 0, maybe: 0, declined: 0, unanswered: 3, waitlisted: 0, reconfirmationRequired: 0 }, canEdit: true, canCancel: true, canRespond: false, canViewParticipants: true, seriesId, originalStartAt: '2026-08-31T12:00:00+02:00',
};
const series: PlanningSeries = {
  id: seriesId, version: 1, status: 'PUBLISHED', timeZone: 'Europe/Berlin', eventType: 'APPOINTMENT_POLL', title: event.title, description: event.description, location: event.location, allDay: false, durationMinutes: 60, responseDeadlineMinutesBefore: 120, waitlistEnabled: false, audience: event.audience, recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: ['MO'], range: { type: 'NEVER' } },
};
const settings: PlanningSettings = { enabled: true, version: 1, timeZone: 'Europe/Berlin' };

describe('PlanningEventFormPage cached series initialization', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes a calendar slot deep link as a one-hour timed event', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
    client.setQueryData(planningKeys.settings('group-1'), settings);
    client.setQueryData(['roles', 'group-1'], []);
    client.setQueryData(['members', 'group-1'], []);
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const createRouteEntry = createRoute({ getParentRoute: () => rootRoute, path: '/planning/new', component: () => <PlanningEventFormPage mode="create" /> });
    const router = createRouter({ history: createMemoryHistory({ initialEntries: ['/planning/new?date=2026-09-05&time=18%3A30&view=week'] }), routeTree: rootRoute.addChildren([createRouteEntry]) });

    render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);

    expect(await screen.findByRole('switch', { name: i18n.t('planning.fields.allDay') })).not.toBeChecked();
    expect(screen.queryByText('Lege Inhalt, Zeitpunkt und Teilnehmerkreis fest.')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: i18n.t('planning.backToCalendar') })).toHaveAttribute('href', '/planning?date=2026-09-05&view=week');
    expect(screen.getByLabelText(/^Beginn/)).toHaveValue('2026-09-05T18:30');
    expect(screen.getByLabelText(/^Ende/)).toHaveValue('2026-09-05T19:30');
  });

  it('creates an all-day event by default with exclusive date-only API timing', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
    client.setQueryData(planningKeys.settings('group-1'), settings);
    client.setQueryData(['roles', 'group-1'], []);
    client.setQueryData(['members', 'group-1'], []);
    const createEvent = vi.spyOn(api, 'createPlanningEvent').mockResolvedValue({
      ...event,
      id: 'created-all-day',
      eventType: 'APPOINTMENT',
      status: 'PUBLISHED',
      title: 'All-day weekend',
      allDay: true,
      startDate: '2026-09-05',
      endDateExclusive: '2026-09-06',
      startsAt: '2026-09-04T22:00:00Z',
      endsAt: '2026-09-05T22:00:00Z',
      seriesId: undefined,
      originalStartAt: undefined,
    });
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const planningRoute = createRoute({ getParentRoute: () => rootRoute, path: '/planning', component: () => <p>Calendar</p> });
    const createRouteEntry = createRoute({ getParentRoute: () => rootRoute, path: '/planning/new', component: () => <PlanningEventFormPage mode="create" /> });
    const detailRoute = createRoute({ getParentRoute: () => rootRoute, path: '/planning/events/$eventId', component: () => <p>Published detail</p> });
    const router = createRouter({ history: createMemoryHistory({ initialEntries: ['/planning/new?date=2026-09-05&view=month'] }), routeTree: rootRoute.addChildren([planningRoute, createRouteEntry, detailRoute]) });

    render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);

    expect(await screen.findByRole('switch', { name: i18n.t('planning.fields.allDay') })).toBeChecked();
    expect(screen.getByLabelText(/^Startdatum/)).toHaveValue('2026-09-05');
    expect(screen.getByLabelText(/^Enddatum/)).toHaveValue('2026-09-05');
    await user.type(screen.getByRole('textbox', { name: i18n.t('planning.fields.title') }), 'All-day weekend');
    await user.click(screen.getByRole('button', { name: i18n.t('planning.actions.publish') }));

    await waitFor(() => expect(createEvent).toHaveBeenCalled());
    expect(await screen.findByText('Published detail')).toBeInTheDocument();
    expect(createEvent.mock.calls[0][1]).toMatchObject({ allDay: true, startDate: '2026-09-05', endDateExclusive: '2026-09-06', title: 'All-day weekend' });
    expect(createEvent.mock.calls[0][1]).not.toHaveProperty('startsAt');
    expect(createEvent.mock.calls[0][1]).not.toHaveProperty('endsAt');
  });

  it('hydrates cached occurrence and series data during an SPA detail-to-edit transition', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
    client.setQueryData(planningKeys.settings('group-1'), settings);
    client.setQueryData(planningKeys.event('group-1', eventId), event);
    client.setQueryData(planningKeys.series('group-1', seriesId), series);
    client.setQueryData(['roles', 'group-1'], []);
    client.setQueryData(['members', 'group-1'], []);
    const eventRequest = vi.spyOn(api, 'getPlanningEvent');
    const seriesRequest = vi.spyOn(api, 'getPlanningSeries');
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const detailRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/planning/events/$eventId',
      component: () => <Link params={{ eventId }} to="/planning/events/$eventId/edit">Bearbeiten</Link>,
    });
    const editRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/planning/events/$eventId/edit',
      component: () => <PlanningEventFormPage mode="edit" />,
    });
    const router = createRouter({ history: createMemoryHistory({ initialEntries: [`/planning/events/${eventId}`] }), routeTree: rootRoute.addChildren([detailRoute, editRoute]) });

    render(<StrictMode><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></StrictMode>);
    await user.click(await screen.findByRole('link', { name: 'Bearbeiten' }));

    expect(await screen.findByRole('combobox', { name: i18n.t('planning.fields.type') })).toHaveTextContent(i18n.t('planning.types.APPOINTMENT_POLL'));
    expect(screen.getByRole('textbox', { name: i18n.t('planning.fields.title') })).toHaveValue('Cached lunch poll');
    expect(screen.getByLabelText(/^Beginn/)).toHaveValue('2026-08-31T12:00');
    expect(screen.getByRole('spinbutton', { name: i18n.t('planning.fields.deadlineOffset') })).toHaveValue(2);
    expect(screen.getByRole('spinbutton', { name: i18n.t('planning.fields.deadlineOffset') })).not.toBeRequired();
    expect(screen.getByRole('combobox', { name: i18n.t('planning.recurrence.label') })).toHaveTextContent(i18n.t('planning.recurrence.presets.WEEKLY'));
    expect(eventRequest).not.toHaveBeenCalled();
    expect(seriesRequest).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: i18n.t('common.cancel') }));
    await user.click(await screen.findByRole('link', { name: 'Bearbeiten' }));

    expect(await screen.findByRole('textbox', { name: i18n.t('planning.fields.title') })).toHaveValue('Cached lunch poll');
    expect(screen.getByRole('combobox', { name: i18n.t('planning.fields.type') })).toHaveTextContent(i18n.t('planning.types.APPOINTMENT_POLL'));
    expect(screen.getByLabelText(/^Beginn/)).toHaveValue('2026-08-31T12:00');
    expect(screen.getByRole('combobox', { name: i18n.t('planning.recurrence.label') })).toHaveTextContent(i18n.t('planning.recurrence.presets.WEEKLY'));
  });

  it('adopts a complete cached occurrence snapshot after the SPA form already mounted', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
    client.setQueryData(planningKeys.settings('group-1'), settings);
    client.setQueryData(planningKeys.event('group-1', eventId), { ...event, eventType: 'APPOINTMENT', title: '', description: '', location: '', startsAt: '2026-09-01T12:00:00+02:00', endsAt: '2026-09-01T13:00:00+02:00', responseDeadlineMinutesBefore: undefined });
    client.setQueryData(planningKeys.series('group-1', seriesId), series);
    client.setQueryData(['roles', 'group-1'], []);
    client.setQueryData(['members', 'group-1'], []);
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const detailRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/planning/events/$eventId',
      component: () => <Link params={{ eventId }} to="/planning/events/$eventId/edit">Bearbeiten</Link>,
    });
    const editRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/planning/events/$eventId/edit',
      component: () => <PlanningEventFormPage mode="edit" />,
    });
    const router = createRouter({ history: createMemoryHistory({ initialEntries: [`/planning/events/${eventId}`] }), routeTree: rootRoute.addChildren([detailRoute, editRoute]) });

    render(<StrictMode><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></StrictMode>);
    await user.click(await screen.findByRole('link', { name: 'Bearbeiten' }));
    const title = await screen.findByRole('textbox', { name: i18n.t('planning.fields.title') });
    expect(title).toHaveValue('');
    fireEvent.change(title, { target: { value: 'Local edit' } });

    act(() => client.setQueryData(planningKeys.event('group-1', eventId), event));

    expect(await screen.findByRole('textbox', { name: i18n.t('planning.fields.title') })).toHaveValue('Local edit');
    expect(screen.getByRole('combobox', { name: i18n.t('planning.fields.type') })).toHaveTextContent(i18n.t('planning.types.APPOINTMENT_POLL'));
    expect(screen.getByLabelText(/^Beginn/)).toHaveValue('2026-08-31T12:00');
    expect(screen.getByRole('combobox', { name: i18n.t('planning.recurrence.label') })).toHaveTextContent(i18n.t('planning.recurrence.presets.WEEKLY'));
  });
});
