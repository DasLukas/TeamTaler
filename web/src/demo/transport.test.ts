import { describe, expect, it } from 'vitest';
import type { InvitationImportResult, InvitationMetadata } from '@/api/types';
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
