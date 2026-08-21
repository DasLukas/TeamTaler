import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuditEventTable } from './AuditEventTable';

describe('AuditEventTable', () => {
  it('renders the shared audit columns and normalized event content', () => {
    render(<AuditEventTable
      emptyMessage="No events"
      entries={[{
        action: 'group.updated',
        actor: 'Ada Admin',
        details: 'Name changed',
        id: 'evt-1',
        occurredAt: '2026-08-16T18:03:00Z',
        subject: 'group · grp-1',
      }]}
      filterDefinitions={[]}
      tableState={{ filters: {}, onFiltersChange: vi.fn(), onSearchChange: vi.fn(), onSortingChange: vi.fn(), searchValue: '', sorting: [] }}
      title="Audit"
    />);

    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Zeitpunkt', 'Akteur', 'Aktion', 'Betroffen', 'Details']);
    const row = within(table).getAllByRole('row')[1];
    expect(row).toHaveTextContent('Ada Admin');
    expect(row).toHaveTextContent('group.updated');
    expect(row).toHaveTextContent('group · grp-1');
    expect(row).toHaveTextContent('Name changed');
    expect(row.querySelector('time')).toHaveAttribute('datetime', '2026-08-16T18:03:00Z');
  });
});
