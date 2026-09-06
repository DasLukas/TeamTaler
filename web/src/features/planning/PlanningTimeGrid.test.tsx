import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanningEvent, PlanningEventBase } from '@/api/types';
import i18n from '@/i18n';
import { PlanningTimeGrid } from './PlanningTimeGrid';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode; params?: unknown; search?: unknown; to?: string }) => <a href={to}>{children}</a>,
}));

const base: PlanningEventBase = {
  id: 'event', version: 1, eventType: 'APPOINTMENT', status: 'PUBLISHED', title: 'Event', description: '', location: '', startsAt: '', waitlistEnabled: false, confirmationRevision: 1, audience: { type: 'ALL_ACTIVE_MEMBERS', roleIds: [], memberIds: [] }, participation: { invited: 0, attending: 0, maybe: 0, declined: 0, unanswered: 0, waitlisted: 0, reconfirmationRequired: 0 }, canEdit: false, canCancel: false, canRespond: false, canViewParticipants: false,
};

const commonProps = {
  navigationSearch: { date: '2027-09-06', view: 'week' as const },
  onCreate: vi.fn(),
  onNavigateDate: vi.fn(),
  timeZone: 'Europe/Berlin',
  todayKey: '2027-09-01',
  view: 'week' as const,
};

describe('PlanningTimeGrid', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('creates from an empty slot by click or Enter and uses roving arrow focus', async () => {
    const user = userEvent.setup();
    render(<PlanningTimeGrid {...commonProps} dateKeys={['2027-09-06', '2027-09-07']} events={[]} />);
    const eight = document.querySelector<HTMLButtonElement>('button[data-planning-slot="2027-09-06-480"]');
    const eightThirty = document.querySelector<HTMLButtonElement>('button[data-planning-slot="2027-09-06-510"]');
    expect(eight).toHaveAttribute('tabindex', '0');
    eight?.focus();
    await user.keyboard('{ArrowDown}');
    expect(eightThirty).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(commonProps.onCreate).toHaveBeenCalledWith({ date: '2027-09-06', time: '08:30', view: 'week' });
    await user.click(document.querySelector<HTMLButtonElement>('button[data-planning-slot="2027-09-07-600"]')!);
    expect(commonProps.onCreate).toHaveBeenLastCalledWith({ date: '2027-09-07', time: '10:00', view: 'week' });
  });

  it('renders one spanning all-day item and overlapping timed events', () => {
    const allDay: PlanningEvent = { ...base, id: 'all-day', title: 'Conference', allDay: true, startDate: '2027-09-06', endDateExclusive: '2027-09-08', timeZone: 'Europe/Berlin', startsAt: '2027-09-05T22:00:00Z', endsAt: '2027-09-07T22:00:00Z' };
    const first: PlanningEvent = { ...base, id: 'first', title: 'First', allDay: false, timeZone: 'Europe/Berlin', startsAt: '2027-09-06T07:00:00Z', endsAt: '2027-09-06T09:00:00Z' };
    const second: PlanningEvent = { ...base, id: 'second', title: 'Second', allDay: false, timeZone: 'Europe/Berlin', startsAt: '2027-09-06T08:00:00Z', endsAt: '2027-09-06T10:00:00Z' };
    render(<PlanningTimeGrid {...commonProps} dateKeys={['2027-09-06', '2027-09-07']} events={[allDay, first, second]} />);
    expect(screen.getAllByText('Conference')).toHaveLength(1);
    expect(screen.getByRole('link', { name: /First/ })).toBeVisible();
    expect(screen.getByRole('link', { name: /Second/ })).toBeVisible();
    expect(document.querySelector<HTMLButtonElement>('button[data-planning-slot="2027-09-06-600"]')).toBeDisabled();
  });

  it('keeps the header and internally scrollable day body on one horizontal position', () => {
    render(<PlanningTimeGrid {...commonProps} dateKeys={['2027-09-06', '2027-09-07']} events={[]} />);
    const header = document.querySelector<HTMLDivElement>('[data-planning-scroll="header"]')!;
    const body = document.querySelector<HTMLDivElement>('[data-planning-scroll="body"]')!;

    body.scrollLeft = 180;
    fireEvent.scroll(body);
    expect(header.scrollLeft).toBe(180);

    header.scrollLeft = 64;
    fireEvent.scroll(header);
    expect(body.scrollLeft).toBe(64);
  });

  it('disables ambiguous fold slots and exposes the current-time line', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T01:15:00Z'));
    render(<PlanningTimeGrid {...commonProps} dateKeys={['2026-10-25']} events={[]} navigationSearch={{ date: '2026-10-25', view: 'day' }} todayKey="2026-10-25" view="day" />);
    expect(document.querySelector('[data-planning-scroll="header"]')?.className).toContain('dayTimeGridScroll');
    expect(document.querySelector('[data-planning-scroll="body"]')?.className).toContain('dayTimeGridScroll');
    expect(document.querySelector<HTMLButtonElement>('button[data-planning-slot="2026-10-25-150"]')).toBeDisabled();
    expect(document.querySelector<HTMLButtonElement>('button[data-planning-slot="2026-10-25-150"]')).toHaveAttribute('title', i18n.t('planning.dstFoldUnavailable'));
    expect(screen.getByRole('img', { name: i18n.t('planning.currentTime') })).toBeVisible();
  });
});
