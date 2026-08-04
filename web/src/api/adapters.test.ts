import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { adaptLedger, adaptNotification, adaptProduct, adaptSettlement } from './adapters';

describe('API adapters', () => {
  it('adapts fixed and user-defined product pricing without inventing a custom price', () => {
    expect(adaptProduct({ id: 'fixed', name: 'Water', categoryId: 'drinks', pricingMode: 'FIXED', priceMinor: '100', currency: 'EUR' })).toMatchObject({
      pricingMode: 'FIXED', currency: 'EUR', price: { minorUnits: '100', currency: 'EUR' },
    });
    expect(adaptProduct({ id: 'custom', name: 'Donation', categoryId: 'other', pricingMode: 'USER_DEFINED', currency: 'EUR' })).toMatchObject({
      pricingMode: 'USER_DEFINED', currency: 'EUR', price: undefined,
    });
  });

  it('reconstructs ledger balances without losing integer precision', () => {
    const entries = adaptLedger({
      balanceMinor: '9007199254740993123',
      currency: 'EUR',
      recentEntries: [{
        id: 'entry-1',
        createdAt: '2026-08-04T12:00:00Z',
        amountMinor: '123',
        description: 'Precision check',
        bookingId: 'booking-1',
      }],
    });

    expect(entries[0]?.balance.minorUnits).toBe('9007199254740993123');
    expect(entries[0]?.amount.minorUnits).toBe('123');
  });

  it('localizes a received payment while preserving its reference', () => {
    const [entry] = adaptLedger({
      balanceMinor: '-1250',
      currency: 'EUR',
      recentEntries: [{
        id: 'entry-payment',
        paymentId: 'payment-1',
        createdAt: '2026-08-04T12:00:00Z',
        amountMinor: '-1250',
        description: 'Payment received: Advance installment',
      }],
    });

    expect(entry?.description).toBe(i18n.t('ledger.paymentReceivedWithReference', { reference: 'Advance installment' }));
    expect(entry?.kind).toBe('PAYMENT');
  });

  it('localizes payment and booking reversals without backend English labels', () => {
    const entries = adaptLedger({
      balanceMinor: '0',
      currency: 'EUR',
      recentEntries: [
        {
          id: 'entry-payment-reversal',
          paymentId: 'payment-1',
          reversalOf: 'entry-payment',
          createdAt: '2026-08-04T13:00:00Z',
          amountMinor: '1250',
          description: 'Reversal: Payment received: Advance installment',
        },
        {
          id: 'entry-booking-reversal',
          bookingId: 'booking-1',
          reversalOf: 'entry-booking',
          createdAt: '2026-08-04T14:00:00Z',
          amountMinor: '-200',
          description: 'Reversal: 2 x Water (Drinks)',
        },
      ],
    });

    expect(entries[0]?.description).toBe(i18n.t('ledger.paymentReversedWithReference', { reference: 'Advance installment' }));
    expect(entries[1]?.description).toBe(i18n.t('ledger.bookingReversed', { description: '2 × Water (Drinks)' }));
    expect(entries.every((entry) => !entry.description.includes('Payment received') && !entry.description.includes('Reversal:'))).toBe(true);
  });

  it('localizes structured backend notifications by event type', () => {
    const notification = adaptNotification({
      id: 'notification-1',
      type: 'PAYMENT_RECORDED',
      title: 'Payment recorded',
      body: 'A payment was recorded.',
      createdAt: '2026-08-04T12:00:00Z',
    });

    expect(notification.title).toBe(i18n.t('notifications.fallback.paymentTitle'));
    expect(notification.message).toBe(i18n.t('notifications.fallback.paymentMessage'));
  });

  it('includes cross-period corrections in settlement obligations and payments', () => {
    const settlement = adaptSettlement({
      id: 'statement-1',
      periodId: 'period-1',
      membershipId: 'member-1',
      displayName: 'Mara Becker',
      chargesMinor: '150',
      paymentsAllocatedMinor: '25',
      adjustmentsAppliedMinor: '75',
      adjustmentsProvidedMinor: '50',
      amountDueMinor: '100',
      currency: 'EUR',
      status: 'PARTIAL',
    }, [{ id: 'period-1', label: 'July 2026', status: 'CLOSED', startsAt: '2026-07-01', dueAt: '2026-08-15' }]);

    expect(settlement.amount.minorUnits).toBe('200');
    expect(settlement.paidAmount.minorUnits).toBe('100');
    expect(settlement.openAmount?.minorUnits).toBe('100');
  });
});
