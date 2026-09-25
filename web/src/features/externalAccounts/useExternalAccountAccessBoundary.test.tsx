import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { externalAccountKeys } from './externalAccountQueryKeys';
import { useExternalAccountAccessBoundary } from './useExternalAccountAccessBoundary';

function problem(status: number): ApiError {
  return new ApiError({ status, title: 'Access changed', type: 'about:blank' });
}

describe('useExternalAccountAccessBoundary', () => {
  it.each([403, 409])('clears all group-scoped caches and freezes queries after %s', (status) => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(externalAccountKeys.list('group-a'), { secret: 'accounts' });
    queryClient.setQueryData(externalAccountKeys.links('group-a'), { secret: 'links' });
    queryClient.setQueryData(externalAccountKeys.transactions('group-a'), { secret: 'history' });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useExternalAccountAccessBoundary('group-a'), { wrapper });

    act(() => { expect(result.current.handleError(problem(status))).toBe(true); });

    expect(result.current.accessRevoked).toBe(true);
    expect(queryClient.getQueriesData({ queryKey: externalAccountKeys.all('group-a') })).toEqual([]);
  });

  it('preserves caches for ordinary validation failures', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(externalAccountKeys.list('group-a'), { safe: true });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useExternalAccountAccessBoundary('group-a'), { wrapper });

    act(() => { expect(result.current.handleError(problem(422))).toBe(false); });

    expect(result.current.accessRevoked).toBe(false);
    expect(queryClient.getQueryData(externalAccountKeys.list('group-a'))).toEqual({ safe: true });
  });
});
