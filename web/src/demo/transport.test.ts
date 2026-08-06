import { describe, expect, it } from 'vitest';
import type { AccountSummary, Booking, Category, Dashboard, Group, GroupSettings, InvitationImportResult, InvitationMetadata, LedgerEntry, Membership, Payment, Product, Session } from '@/api/types';
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

describe('DemoTransport group settings', () => {
  it('persists a normalized group name in the demo session', async () => {
    const transport = new DemoTransport();
    await expect(transport.request<{ name: string }>('/groups/group-sv-adler', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '  Renamed Group  ' }),
    })).resolves.toEqual({ name: 'Renamed Group' });

    const groups = await transport.request<Group[]>('/groups');
    expect(groups.find((group) => group.id === 'group-sv-adler')?.name).toBe('Renamed Group');
  });

  it('persists typed behavior settings', async () => {
    const transport = new DemoTransport();
    await expect(transport.request<GroupSettings>('/groups/group-sv-adler/settings')).resolves.toEqual({ membersCanViewAllBookings: false, notificationEmailsEnabled: false, notificationEmailDeliveryAvailable: true });
    await expect(transport.request<GroupSettings>('/groups/group-sv-adler/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ membersCanViewAllBookings: true, notificationEmailsEnabled: true }),
    })).resolves.toEqual({ membersCanViewAllBookings: true, notificationEmailsEnabled: true, notificationEmailDeliveryAvailable: true });
    await expect(transport.request<GroupSettings>('/groups/group-sv-adler/settings')).resolves.toEqual({ membersCanViewAllBookings: true, notificationEmailsEnabled: true, notificationEmailDeliveryAvailable: true });
  });
});

describe('DemoTransport catalog order', () => {
  it('persists category and product positions across catalog and dashboard reads', async () => {
    const transport = new DemoTransport();
    const reordered = await transport.request<Category[]>('/groups/group-sv-adler/catalog/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        categoryIds: ['category-penalties', 'category-drinks'],
        productIdsByCategory: {
          'category-penalties': ['product-kit', 'product-late'],
          'category-drinks': ['product-beer', 'product-water', 'product-spezi'],
        },
      }),
    });
    const catalog = await transport.request<Category[]>('/groups/group-sv-adler/categories');
    const dashboard = await transport.request<Dashboard>('/groups/group-sv-adler/dashboard');

    expect(reordered.map((category) => category.id)).toEqual(['category-penalties', 'category-drinks']);
    expect(catalog[0].products.map((product) => product.id)).toEqual(['product-kit', 'product-late']);
    expect(catalog[1].products.map((product) => product.id)).toEqual(['product-beer', 'product-water', 'product-spezi']);
    expect(dashboard.categoryTotals.map((total) => total.categoryId)).toEqual(['category-penalties', 'category-drinks']);
    expect(dashboard.groupCategoryTotals.map((total) => total.categoryId)).toEqual(['category-penalties', 'category-drinks']);
  });

  it('rejects incomplete orders without changing the catalog', async () => {
    const transport = new DemoTransport();
    await expect(transport.request<Category[]>('/groups/group-sv-adler/catalog/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryIds: ['category-drinks'], productIdsByCategory: { 'category-drinks': [] } }),
    })).rejects.toThrow();

    const catalog = await transport.request<Category[]>('/groups/group-sv-adler/categories');
    expect(catalog.map((category) => category.id)).toEqual(['category-drinks', 'category-penalties']);
  });
});

describe('DemoTransport finance accounts', () => {
  it('lists active and archived summaries and applies booking movements', async () => {
    const transport = new DemoTransport();
    const before = await transport.request<AccountSummary[]>('/groups/group-sv-adler/accounts');
    const lukasBefore = before.find((account) => account.membershipId === 'member-lukas');
    expect(before.some((account) => account.status === 'ARCHIVED')).toBe(true);

    await transport.request<Booking>('/groups/group-sv-adler/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: 'product-water', productVersion: 1, expectedPeriodId: 'period-august', quantity: 1 }),
    });
    const after = await transport.request<AccountSummary[]>('/groups/group-sv-adler/accounts');
    const lukasAfter = after.find((account) => account.membershipId === 'member-lukas');

    expect(BigInt(lukasAfter?.balance.minorUnits ?? '0') - BigInt(lukasBefore?.balance.minorUnits ?? '0')).toBe(100n);
  });

  it('posts an authorized own payment to the session membership and exposes resulting credit', async () => {
    const transport = new DemoTransport();
    const before = await transport.request<Dashboard>('/groups/group-sv-adler/dashboard');

    const payment = await transport.request<Payment>('/groups/group-sv-adler/payments/self', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountMinor: 3000, receivedAt: '2026-08-06T00:00:00.000Z', method: 'PAYPAL', reference: 'PayPal advance' }),
    });
    const after = await transport.request<Dashboard>('/groups/group-sv-adler/dashboard');
    const ledger = await transport.request<LedgerEntry[]>('/groups/group-sv-adler/accounts/me');

    expect(payment).toMatchObject({ membershipId: 'member-lukas', method: 'PAYPAL', reference: 'PayPal advance', status: 'POSTED' });
    expect(BigInt(after.openBalance.minorUnits)).toBe(BigInt(before.openBalance.minorUnits) - 3000n);
    expect(after.openBalance.minorUnits).toBe('-660');
    expect(ledger[0]).toMatchObject({ kind: 'PAYMENT', referenceId: payment.id, balance: { minorUnits: '-660', currency: 'EUR' } });
  });
});

describe('DemoTransport profile images', () => {
  it('propagates upload and removal between session and memberships', async () => {
    const transport = new DemoTransport();
    const form = new FormData();
    form.set('image', new File(['avatar'], 'avatar.png', { type: 'image/png' }));

    const uploaded = await transport.request<{ avatarUrl: string }>('/me/avatar', { method: 'POST', body: form });
    const session = await transport.request<Session>('/session');
    const members = await transport.request<Membership[]>('/groups/group-sv-adler/members');
    expect(uploaded.avatarUrl).toMatch(/^blob:/);
    expect(session.user.avatarUrl).toBe(uploaded.avatarUrl);
    expect(members.find((member) => member.userId === session.user.id)?.avatarUrl).toBe(uploaded.avatarUrl);

    await transport.request<void>('/me/avatar', { method: 'DELETE' });
    const removedSession = await transport.request<Session>('/session');
    const removedMembers = await transport.request<Membership[]>('/groups/group-sv-adler/members');
    expect(removedSession.user.avatarUrl).toBeUndefined();
    expect(removedMembers.find((member) => member.userId === session.user.id)?.avatarUrl).toBeUndefined();
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
      body: JSON.stringify({ name: 'Refreshments', icon: 'event', active: false, sortOrder: 5, version: 1 }),
    });
    const product = await transport.request<Product>('/groups/group-sv-adler/products/product-water', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
      body: JSON.stringify({ name: 'Still water', pricingMode: 'USER_DEFINED', active: false, sortOrder: 4, version: 1 }),
    });

    expect(category).toMatchObject({ name: 'Refreshments', icon: 'event', active: false, sortOrder: 5, version: 2 });
    expect(product).toMatchObject({ name: 'Still water', pricingMode: 'USER_DEFINED', price: undefined, active: false, sortOrder: 4, version: 2 });
  });

  it('deletes only archived and unused catalog entries', async () => {
    const transport = new DemoTransport();
    const category = await transport.request<Category>('/groups/group-sv-adler/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Temporary', icon: 'other', sortOrder: 0 }),
    });
    const product = await transport.request<Product>(`/groups/group-sv-adler/categories/${category.id}/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Temporary item', pricingMode: 'FIXED', priceMinor: 100, sortOrder: 0 }),
    });

    await expect(transport.request<void>(`/groups/group-sv-adler/products/${product.id}`, { method: 'DELETE', headers: { 'If-Match': `"v${product.version}"` } })).rejects.toThrow();
    const archivedProduct = await transport.request<Product>(`/groups/group-sv-adler/products/${product.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: product.name, pricingMode: product.pricingMode, priceMinor: 100, active: false, sortOrder: product.sortOrder, version: product.version }),
    });
    await transport.request<void>(`/groups/group-sv-adler/products/${archivedProduct.id}`, { method: 'DELETE', headers: { 'If-Match': `"v${archivedProduct.version}"` } });
    const archivedCategory = await transport.request<Category>(`/groups/group-sv-adler/categories/${category.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: category.name, icon: category.icon, active: false, sortOrder: category.sortOrder, version: category.version }),
    });
    await transport.request<void>(`/groups/group-sv-adler/categories/${archivedCategory.id}`, { method: 'DELETE', headers: { 'If-Match': `"v${archivedCategory.version}"` } });

    const catalog = await transport.request<Category[]>('/groups/group-sv-adler/categories');
    expect(catalog.some((entry) => entry.id === category.id)).toBe(false);
  });
});
