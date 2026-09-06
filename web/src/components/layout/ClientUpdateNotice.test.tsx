import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientUpdateNotice } from './ClientUpdateNotice';

const mocks = vi.hoisted(() => ({ useQuery: vi.fn() }));

vi.mock('@tanstack/react-query', () => ({ useQuery: mocks.useQuery }));
vi.mock('@/api/client', () => ({ api: { getBuildInformation: vi.fn() } }));
vi.mock('@/app/clientBuild', () => ({ clientBuildId: '1.2.0@client' }));

describe('ClientUpdateNotice', () => {
  beforeEach(() => mocks.useQuery.mockReset());

  it('stays hidden while the loaded client matches the deployed build', () => {
    mocks.useQuery.mockReturnValue({ data: { buildId: '1.2.0@client' } });

    render(<ClientUpdateNotice />);

    expect(screen.queryByText('Eine neue Version ist verfügbar.')).not.toBeInTheDocument();
  });

  it('offers a deliberate reload when a newer client build is deployed', () => {
    const reload = vi.fn();
    mocks.useQuery.mockReturnValue({ data: { buildId: '1.3.0@server' } });

    render(<ClientUpdateNotice reload={reload} />);

    expect(screen.getByRole('status')).toHaveTextContent('Eine neue Version ist verfügbar.');
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt neu laden' }));
    expect(reload).toHaveBeenCalledOnce();
    expect(mocks.useQuery).toHaveBeenCalledWith(expect.objectContaining({
      refetchInterval: 300_000,
      refetchIntervalInBackground: false,
      refetchOnReconnect: true,
      refetchOnWindowFocus: 'always',
      retry: false,
    }));
  });
});
