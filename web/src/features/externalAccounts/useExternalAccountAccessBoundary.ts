import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { ApiError } from '@/api/client';
import { externalAccountKeys } from './externalAccountQueryKeys';

/** Shared access-boundary controls for sensitive external-account operations. */
export interface ExternalAccountAccessBoundary {
  accessRevoked: boolean;
  guard: <T>(load: () => Promise<T>) => Promise<T>;
  handleError: (error: unknown) => boolean;
}

/**
 * Removes group-scoped external-account data after access or feature-state conflicts.
 *
 * @param groupId - Active group owning the sensitive query cache.
 * @returns Stable guards for queries, mutations, and the revoked-state fallback.
 * @example `const { guard, handleError } = useExternalAccountAccessBoundary(groupId);`
 */
export function useExternalAccountAccessBoundary(groupId: string): ExternalAccountAccessBoundary {
  const queryClient = useQueryClient();
  const [accessRevoked, setAccessRevoked] = useState(false);
  const handleError = useCallback((error: unknown): boolean => {
    if (!(error instanceof ApiError) || error.problem.status !== 403 && error.problem.status !== 409) return false;
    queryClient.removeQueries({ queryKey: externalAccountKeys.all(groupId) });
    setAccessRevoked(true);
    return true;
  }, [groupId, queryClient]);
  const guard = useCallback(async <T,>(load: () => Promise<T>): Promise<T> => {
    try {
      return await load();
    } catch (error) {
      handleError(error);
      throw error;
    }
  }, [handleError]);
  return { accessRevoked, guard, handleError };
}
