import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TableExportMenu } from './TableExportMenu';

const mocks = vi.hoisted(() => ({ exportGroupTable: vi.fn(), exportSystemTable: vi.fn() }));
vi.mock('@/api/client', () => ({ api: mocks }));

function renderMenu() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TableExportMenu groupId="group-a" query={{ direction: 'desc', q: 'wasser', sort: 'occurredAt' }} table="ACTIVITIES" title="Aktivitäten" />
    </QueryClientProvider>,
  );
}

describe('TableExportMenu', () => {
  let previewDocument: Document;
  let previewWindow: Window;
  let replacePreviewLocation: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.exportGroupTable.mockResolvedValue(new Blob(['csv'], { type: 'text/csv' }));
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:export') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    previewDocument = document.implementation.createHTMLDocument('');
    replacePreviewLocation = vi.fn();
    previewWindow = {
      closed: false,
      close: vi.fn(),
      document: previewDocument,
      location: { replace: replacePreviewLocation },
      opener: window,
    } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(previewWindow);
  });

  it('exports the complete current group query as CSV', async () => {
    const user = userEvent.setup();
    renderMenu();

    const trigger = screen.getByRole('button', { name: 'Exportieren' });
    expect(trigger.className).toContain('iconOnly');
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Als CSV herunterladen' }));

    await waitFor(() => expect(mocks.exportGroupTable).toHaveBeenCalledTimes(1));
    expect(mocks.exportGroupTable).toHaveBeenCalledWith('group-a', expect.objectContaining({
      format: 'CSV',
      query: { direction: 'desc', q: 'wasser', sort: 'occurredAt' },
      table: 'ACTIVITIES',
      timeZone: expect.any(String),
    }));
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it('opens a native PDF preview in a synchronously prepared browser tab', async () => {
    const user = userEvent.setup();
    mocks.exportGroupTable.mockResolvedValue(new Blob(['%PDF-preview'], { type: 'application/pdf' }));
    renderMenu();

    await user.click(screen.getByRole('button', { name: 'Exportieren' }));
    await user.click(screen.getByRole('button', { name: 'PDF-Vorschau öffnen' }));

    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(previewDocument.title).toBe('Aktivitäten – PDF-Vorschau');
    expect(previewDocument.body.textContent).toContain('PDF-Vorschau wird erstellt …');
    await waitFor(() => expect(replacePreviewLocation).toHaveBeenCalledWith('blob:export'));
    expect(mocks.exportGroupTable).toHaveBeenCalledWith('group-a', expect.objectContaining({ format: 'PDF' }));
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ name: expect.stringMatching(/^aktivitaten-\d{4}-\d{2}-\d{2}\.pdf$/), type: 'application/pdf' }));
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it('shows a useful error without requesting the PDF when popups are blocked', async () => {
    const user = userEvent.setup();
    vi.mocked(window.open).mockReturnValueOnce(null);
    renderMenu();

    await user.click(screen.getByRole('button', { name: 'Exportieren' }));
    await user.click(screen.getByRole('button', { name: 'PDF-Vorschau öffnen' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Die PDF-Vorschau wurde vom Browser blockiert.');
    expect(mocks.exportGroupTable).not.toHaveBeenCalled();
  });
});
