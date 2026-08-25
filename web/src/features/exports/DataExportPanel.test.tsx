import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataExportJob } from '@/api/types';
import { DataExportPanel } from './DataExportPanel';

const mocks = vi.hoisted(() => ({
  createGroupDataExport: vi.fn(),
  createPersonalDataExport: vi.fn(),
  deleteDataExport: vi.fn(),
  getDataExportDownloadURL: vi.fn(),
  getDataExports: vi.fn(),
}));
vi.mock('@/api/client', () => ({ api: mocks }));

const readyJob: DataExportJob = {
  id: 'export-a',
  requestedAt: '2026-08-25T12:00:00Z',
  scope: 'PERSONAL',
  status: 'READY',
};

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DataExportPanel groupId="group-a" intro="Eigene Daten sicher exportieren." scope="PERSONAL" title="Eigene Daten exportieren" />
    </QueryClientProvider>,
  );
}

describe('DataExportPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/account');
    mocks.getDataExports.mockResolvedValue([readyJob]);
    mocks.getDataExportDownloadURL.mockReturnValue('/api/v1/exports/export-a/download');
    mocks.createPersonalDataExport.mockResolvedValue({ ...readyJob, id: 'export-b', status: 'QUEUED' });
  });

  it('requires the current password and starts a personal export', async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(await screen.findByText('Persönlicher Export')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Neuen Export erstellen' }));
    await user.type(screen.getByLabelText('Aktuelles Passwort'), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Export erstellen' }));

    await waitFor(() => expect(mocks.createPersonalDataExport).toHaveBeenCalledWith('group-a', 'correct horse', expect.any(String)));
    expect(await screen.findByText('Der Export wurde gestartet. Du kannst diese Seite verlassen.')).toBeVisible();
    expect(screen.queryByLabelText('Aktuelles Passwort')).not.toBeInTheDocument();
  });

  it('streams a ready ZIP through a direct browser download', async () => {
    const user = userEvent.setup();
    let href: string | null = null;
    let download = '';
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function captureDownload(this: HTMLAnchorElement) {
      href = this.getAttribute('href');
      download = this.download;
    });
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'ZIP herunterladen' }));

    expect(mocks.getDataExportDownloadURL).toHaveBeenCalledWith('export-a');
    expect(href).toBe('/api/v1/exports/export-a/download');
    expect(download).toBe('teamtaler-benutzerdaten-2026-08-25.zip');
    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
  });

  it('does not offer destructive actions for terminal jobs without an artifact', async () => {
    mocks.getDataExports.mockResolvedValue([
      { ...readyJob, id: 'failed', status: 'FAILED', errorCode: 'generation_failed' },
      { ...readyJob, id: 'cancelled', status: 'CANCELLED' },
      { ...readyJob, id: 'expired', status: 'EXPIRED' },
    ]);
    renderPanel();

    expect(await screen.findByText('Fehlgeschlagen')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'ZIP herunterladen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export abbrechen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Exportdatei löschen' })).not.toBeInTheDocument();
  });
});
