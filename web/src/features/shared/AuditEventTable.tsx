import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { DataTable, type DataTableColumnDef, type DataTableFilterDefinition } from './DataTable';
import type { AuditEventFilterId } from './auditFilters';
import { useDataTableLabels } from './useDataTableLabels';
import type { DataTableUrlState } from './useDataTableUrlState';
import { formatGermanDateTime } from './dateFormat';

/** One normalized row rendered by the shared audit-event table. */
export interface AuditEventTableEntry {
  action: string;
  actor: string;
  details: string;
  id: string;
  occurredAt: string;
  subject: string;
}

/** Properties accepted by the shared audit-event table. */
export interface AuditEventTableProps {
  emptyMessage: string;
  entries: AuditEventTableEntry[];
  filterDefinitions: readonly DataTableFilterDefinition<AuditEventFilterId>[];
  hasMore?: boolean;
  isLoading?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  tableState: DataTableUrlState<AuditEventFilterId>;
  title: string;
}

/**
 * Renders immutable audit events with server-controlled search, filters, sorting, and pagination.
 *
 * @param props - Normalized events, controlled query state, typed filters, and incremental loading state.
 * @returns A searchable audit table that keeps every column horizontally available on mobile.
 *
 * @example
 * <AuditEventTable title="Audit" entries={events} emptyMessage="No events" filterDefinitions={filters} tableState={tableState} />
 */
export function AuditEventTable({ emptyMessage, entries, filterDefinitions, hasMore, isLoading, isLoadingMore, onLoadMore, tableState, title }: AuditEventTableProps) {
  const { t } = useTranslation();
  const labels = useDataTableLabels();
  const columns = useMemo<DataTableColumnDef<AuditEventTableEntry>[]>(() => [
    {
      accessorKey: 'occurredAt',
      cell: ({ row }) => <time dateTime={row.original.occurredAt}>{formatGermanDateTime(row.original.occurredAt)}</time>,
      enableSorting: true,
      header: t('audit.time'),
      id: 'occurredAt',
      meta: { label: t('audit.time') },
    },
    { accessorKey: 'actor', cell: ({ row }) => <strong>{row.original.actor}</strong>, enableSorting: true, header: t('audit.actor'), id: 'actorName', meta: { label: t('audit.actor') } },
    { accessorKey: 'action', enableSorting: true, header: t('audit.action'), id: 'action', meta: { label: t('audit.action') } },
    { accessorKey: 'subject', enableSorting: true, header: t('audit.subject'), id: 'resourceType', meta: { label: t('audit.subject') } },
    { accessorKey: 'details', enableSorting: false, header: t('common.details'), id: 'details', meta: { label: t('common.details') } },
  ], [t]);

  return (
    <DataTable
      ariaLabel={title}
      columns={columns}
      data={entries}
      emptyContent={emptyMessage}
      filterDefinitions={filterDefinitions}
      getRowId={(entry) => entry.id}
      hasMore={hasMore}
      isLoading={isLoading}
      isLoadingMore={isLoadingMore}
      labels={{ ...labels, searchLabel: t('audit.searchLabel'), searchPlaceholder: t('audit.searchPlaceholder') }}
      minTableWidth="980px"
      onLoadMore={onLoadMore}
      {...tableState}
    />
  );
}
