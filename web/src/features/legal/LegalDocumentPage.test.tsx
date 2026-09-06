import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppearanceProvider } from '@/app/AppearanceProvider';
import { ImprintPage, PrivacyPolicyPage } from './LegalDocumentPage';

const apiMock = vi.hoisted(() => ({ getPublicLegalDocuments: vi.fn(), getSession: vi.fn() }));

vi.mock('@/api/client', () => ({ api: apiMock }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
}));

function renderPage(page: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<AppearanceProvider><QueryClientProvider client={queryClient}>{page}</QueryClientProvider></AppearanceProvider>);
}

describe('public legal document pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.removeAttribute('data-theme');
    apiMock.getPublicLegalDocuments.mockResolvedValue({
      imprint: '# Operator\n\nExample operator\n\n<script>alert("unsafe")</script>',
      privacyPolicy: '# Controller\n\nExample controller',
    });
    apiMock.getSession.mockRejectedValue(new Error('Unauthenticated'));
  });

  it('renders Markdown without executing or mounting raw HTML', async () => {
    renderPage(<ImprintPage />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Impressum' })).toBeVisible();
    expect(await screen.findByRole('heading', { level: 2, name: 'Operator' })).toBeVisible();
    expect(screen.getByText('Example operator')).toBeVisible();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText(/<script>alert\("unsafe"\)<\/script>/)).toBeVisible();
  });

  it('keeps both legal destinations available from either document', async () => {
    renderPage(<PrivacyPolicyPage />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Datenschutz' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Impressum' })).toHaveAttribute('href', '/impressum');
    expect(screen.getByRole('link', { name: 'Datenschutz' })).toHaveAttribute('href', '/datenschutz');
  });

  it('uses the signed-in account theme and keeps TeamTaler as the public fallback', async () => {
    apiMock.getSession.mockResolvedValue({
      user: { id: 'user-a', displayName: 'Alex', email: 'alex@example.test' },
      groups: [{
        id: 'group-a',
        name: 'Group A',
        currency: 'EUR',
        defaultTheme: 'NRW',
        statisticsEnabled: false,
        membership: { id: 'member-a', roles: [], groupPermissions: [], themeOverride: 'FIRE' },
      }],
      activeGroupId: 'group-a',
      defaultGroupId: null,
      colorMode: 'DARK',
      systemRoles: [],
    });

    renderPage(<ImprintPage />);

    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'FIRE'));
    expect(document.documentElement).toHaveAttribute('data-color-mode', 'DARK');
  });

  it('uses the TeamTaler theme when no authenticated session exists', async () => {
    renderPage(<PrivacyPolicyPage />);

    await waitFor(() => expect(apiMock.getSession).toHaveBeenCalled());
    expect(document.documentElement).toHaveAttribute('data-theme', 'TEAMTALER');
  });
});
