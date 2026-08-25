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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exportGroupTable.mockResolvedValue(new Blob(['csv'], { type: 'text/csv' }));
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:export') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });

  it('exports the complete current group query as CSV', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: 'Exportieren' }));
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
});
