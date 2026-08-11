import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { clearAuthenticationState } from './clearAuthenticationState';

describe('clearAuthenticationState', () => {
  it('removes sensitive mutation variables and cached queries immediately', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['session'], { user: { id: 'user-1' } });
    const observer = new MutationObserver(queryClient, {
      mutationFn: async (variables: { currentPassword: string; newPassword: string }) => variables.newPassword,
    });
    const unsubscribe = observer.subscribe(() => undefined);

    await observer.mutate({ currentPassword: 'old-secret-value', newPassword: 'new-secret-value' });
    clearAuthenticationState(queryClient);

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    unsubscribe();
  });
});
