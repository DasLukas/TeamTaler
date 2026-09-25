import { describe, expect, it } from 'vitest';
import type { ExternalAccount, ExternalAccountTransaction } from '@/api/types';
import { projectTransactionAccounts } from './externalAccountProjection';

const account = (id: string, name: string): ExternalAccount => ({
  id, name, type: 'CASH', status: 'ACTIVE', currency: 'EUR', balance: { minorUnits: '0', currency: 'EUR' }, details: null,
  linkedPaymentMethodIds: [], sortOrder: 0, version: 1, hasTransactions: true, canChangeType: false, canDelete: false,
  canArchive: true, canReactivate: false, createdAt: '', updatedAt: '',
});

describe('projectTransactionAccounts', () => {
  it('preserves the authoritative counterparty direction of a transfer reversal', () => {
    const source = account('exa-source', 'Cash');
    const destination = account('exa-destination', 'Bank');
    const reversal: ExternalAccountTransaction = {
      id: 'ext-reversal', kind: 'REVERSAL', source: 'MANUAL', occurredAt: '2026-09-13', createdAt: '2026-09-13', reason: 'Reversal',
      amount: { minorUnits: '1000', currency: 'EUR' }, primaryAccountId: source.id, counterpartyAccountId: destination.id,
      sourceAccount: { id: destination.id, name: destination.name, type: destination.type },
      destinationAccount: { id: source.id, name: source.name, type: source.type }, impacts: [], actor: { id: 'mem-a', displayName: 'Alex' },
      status: 'POSTED', canReverse: false,
    };

    const projected = projectTransactionAccounts(reversal, [source, destination]);

    expect(projected.sourceAccount?.id).toBe(destination.id);
    expect(projected.destinationAccount?.id).toBe(source.id);
  });
});
