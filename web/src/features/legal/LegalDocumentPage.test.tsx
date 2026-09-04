import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImprintPage, PrivacyPolicyPage } from './LegalDocumentPage';

const apiMock = vi.hoisted(() => ({ getPublicLegalDocuments: vi.fn() }));

vi.mock('@/api/client', () => ({ api: apiMock }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
}));

function renderPage(page: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queryClient}>{page}</QueryClientProvider>);
}

describe('public legal document pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getPublicLegalDocuments.mockResolvedValue({
      imprint: '# Operator\n\nExample operator\n\n<script>alert("unsafe")</script>',
      privacyPolicy: '# Controller\n\nExample controller',
    });
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
});
