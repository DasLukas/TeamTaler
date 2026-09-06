import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useState } from 'react';
import { ClientUpdateNotice } from '@/components/layout/ClientUpdateNotice';
import { FloatingNoticeProvider } from '@/components/layout/FloatingNoticeRegion';
import { AppearanceProvider } from './AppearanceProvider';
import { router } from './router';

/**
 * Composes the root application with stable query and router providers.
 *
 * @returns The complete TeamTaler React application tree.
 */
export function App() {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 20_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: 0 },
    },
  }));

  return (
    <AppearanceProvider>
      <QueryClientProvider client={queryClient}>
        <FloatingNoticeProvider>
          <RouterProvider router={router} />
          <ClientUpdateNotice />
        </FloatingNoticeProvider>
      </QueryClientProvider>
    </AppearanceProvider>
  );
}
