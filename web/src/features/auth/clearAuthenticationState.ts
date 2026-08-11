import type { QueryClient } from '@tanstack/react-query';
import { clearAuthenticatedClientState } from '@/api/client';

/**
 * Drops all server-derived queries, mutation records, and browser-owned
 * mutation reservations so credentials and one-time proofs do not remain in
 * process memory after an authentication boundary changes.
 *
 * @param queryClient - Application query cache associated with the old session.
 * @returns Nothing.
 */
export function clearAuthenticationState(queryClient: QueryClient): void {
  clearAuthenticatedClientState();
  queryClient.getMutationCache().clear();
  queryClient.removeQueries();
}
