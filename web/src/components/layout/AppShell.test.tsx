import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';

const mocks = vi.hoisted(() => ({ useQuery: vi.fn() }));

vi.mock('@tanstack/react-query', () => ({ useQuery: mocks.useQuery }));
vi.mock('@tanstack/react-router', () => ({
  Navigate: () => <div>redirect</div>,
  Outlet: () => <div>outlet</div>,
}));
vi.mock('@/api/client', () => ({
  ApiError: class ApiError extends Error {},
  api: { getSession: vi.fn() },
  isDevelopmentDemoEnabled: false,
}));

describe('AppShell empty group state', () => {
  beforeEach(() => {
    mocks.useQuery.mockReturnValue({ data: { groups: [] }, isError: false, isLoading: false });
  });

  it('explains why an account may not have an active group', () => {
    render(<AppShell />);

    expect(screen.getByRole('heading', { name: 'Keine aktive Gruppe' })).toBeVisible();
    expect(screen.getByText('Du wurdest noch keiner Gruppe hinzugefügt oder deine Mitgliedschaft wurde archiviert.')).toBeVisible();
    expect(screen.queryByText(/CLI/i)).not.toBeInTheDocument();
  });
});
