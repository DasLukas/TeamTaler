import { describe, expect, it } from 'vitest';
import type { Booking, Category, InvitationImportResult, InvitationMetadata, Product } from '@/api/types';
import { DemoTransport } from './transport';

describe('DemoTransport invitation import', () => {
  it('accepts raw CSV and advances queued email delivery while listing invitations', async () => {
    const transport = new DemoTransport();
    const result = await transport.request<InvitationImportResult>('/groups/group-demo/invitations/import', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv; charset=utf-8' },
      body: [
        'email,display_name',
        'new.member@example.test,New Member',
        'invalid-address,Invalid Member',
      ].join('\n'),
    });

    expect(result.summary).toEqual({ totalRows: 2, created: 1, invalid: 1, skipped: 0 });
    expect(result.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        email: 'new.member@example.test',
        invitationStatus: 'CREATED',
        emailDeliveryStatus: 'PENDING',
      }),
      expect.objectContaining({
        email: 'invalid-address',
        invitationStatus: 'INVALID',
        code: 'invalid_email',
      }),
    ]));

    const sending = await transport.request<InvitationMetadata[]>('/groups/group-demo/invitations');
    expect(sending).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: 'new.member@example.test', emailDeliveryStatus: 'SENDING' }),
    ]));

    const sent = await transport.request<InvitationMetadata[]>('/groups/group-demo/invitations');
    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: 'new.member@example.test', emailDeliveryStatus: 'SENT' }),
    ]));
  });
});

describe('DemoTransport product pricing', () => {
  it('creates and books a user-defined-price product with production-equivalent totals', async () => {
    const transport = new DemoTransport();
    const product = await transport.request<Product>('/groups/group-sv-adler/categories/category-drinks/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Donation', pricingMode: 'USER_DEFINED', sortOrder: 0 }),
    });

    expect(product).toMatchObject({ pricingMode: 'USER_DEFINED', currency: 'EUR', price: undefined });
    const booking = await transport.request<Booking>('/groups/group-sv-adler/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: product.id, productVersion: 1, expectedPeriodId: 'period-august', quantity: 2, unitPriceMinor: 275 }),
    });

    expect(booking.unitPrice.minorUnits).toBe('275');
    expect(booking.total.minorUnits).toBe('550');
  });

  it('rejects a client price for a fixed-price demo product', async () => {
    const transport = new DemoTransport();
    await expect(transport.request<Booking>('/groups/group-sv-adler/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: 'product-water', productVersion: 1, expectedPeriodId: 'period-august', quantity: 1, unitPriceMinor: 250 }),
    })).rejects.toThrow();
  });

  it('updates categories and products with incremented versions', async () => {
    const transport = new DemoTransport();
    const category = await transport.request<Category>('/groups/group-sv-adler/categories/category-drinks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
      body: JSON.stringify({ name: 'Refreshments', active: false, sortOrder: 5, version: 1 }),
    });
    const product = await transport.request<Product>('/groups/group-sv-adler/products/product-water', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
      body: JSON.stringify({ name: 'Still water', pricingMode: 'USER_DEFINED', active: false, sortOrder: 4, version: 1 }),
    });

    expect(category).toMatchObject({ name: 'Refreshments', active: false, sortOrder: 5, version: 2 });
    expect(product).toMatchObject({ name: 'Still water', pricingMode: 'USER_DEFINED', price: undefined, active: false, sortOrder: 4, version: 2 });
  });
});
