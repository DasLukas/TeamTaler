import { render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PlanningEvent } from '@/api/types';
import i18n from '@/i18n';
import { PlanningEventCard } from './PlanningEventCard';

interface LinkMockProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  children: ReactNode;
  params?: { eventId: string };
  search?: unknown;
  to: string;
}

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, params, search, to, ...props }: LinkMockProps) => {
    void search;
    return <a href={to.replace('$eventId', params?.eventId ?? '')} {...props}>{children}</a>;
  },
}));
vi.mock('./ParticipationAction', () => ({ ParticipationAction: () => null }));

const event: PlanningEvent = {
  id: 'registration-series-event',
  version: 1,
  eventType: 'APPOINTMENT_REGISTRATION',
  status: 'PUBLISHED',
  title: 'Planning weekend',
  description: 'A concise preview of the agenda and preparation for the entire weekend.',
  location: 'Clubhouse',
  allDay: true,
  startDate: '2026-09-01',
  endDateExclusive: '2026-09-03',
  timeZone: 'Europe/Berlin',
  startsAt: '2026-08-31T22:00:00Z',
  endsAt: '2026-09-02T22:00:00Z',
  waitlistEnabled: true,
  confirmationRevision: 1,
  audience: { type: 'ALL_ACTIVE_MEMBERS', roleIds: [], memberIds: [] },
  participation: { invited: 8, attending: 3, maybe: 0, declined: 1, unanswered: 4, waitlisted: 0, reconfirmationRequired: 0 },
  canEdit: true,
  canCancel: true,
  canRespond: false,
  canViewParticipants: true,
  seriesId: 'series-1',
};

describe('PlanningEventCard', () => {
  it('prioritizes title and description while rendering compact schedule metadata', () => {
    render(<PlanningEventCard event={event} navigationSearch={{ date: '2026-09-01', view: 'month' }} timeZone="Europe/Berlin" />);

    expect(screen.getByRole('heading', { name: event.title })).toBeVisible();
    expect(screen.getByText(event.description)).toBeVisible();
    expect(screen.getByText(event.location)).toBeVisible();
    expect(screen.getByText(i18n.t('planning.allDay'))).toBeVisible();
    expect(screen.getByText(i18n.t('planning.summary', { attending: 3, open: 4 }))).toBeVisible();
    expect(screen.getByRole('img', { name: i18n.t('planning.types.APPOINTMENT_REGISTRATION') })).toBeVisible();
    expect(screen.getByRole('img', { name: i18n.t('planning.recurrence.series') })).toBeVisible();
    expect(screen.queryByText(i18n.t('planning.types.APPOINTMENT_REGISTRATION'))).not.toBeInTheDocument();
  });

  it('can omit participation controls in passive dashboard previews', () => {
    render(<PlanningEventCard event={event} navigationSearch={{ view: 'week' }} showParticipation={false} timeZone="Europe/Berlin" />);

    expect(screen.getByRole('heading', { name: event.title })).toBeVisible();
    expect(screen.getByRole('link')).toHaveAttribute('href', `/planning/events/${event.id}`);
  });
});
