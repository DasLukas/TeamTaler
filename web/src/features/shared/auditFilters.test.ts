import { describe, expect, it } from 'vitest';
import type { AuditFilterOptions } from '@/api/types';
import i18n from '@/i18n';
import { createAuditFilterDefinitions, mergeAuditFilterOptions } from './auditFilters';

const serverOptions: AuditFilterOptions = {
  actions: ['booking.created', 'shared.updated'],
  resourceTypes: ['booking', 'product'],
  actionResourceTypes: {
    'booking.created': ['booking'],
    'shared.updated': ['booking', 'product'],
  },
};

describe('audit filters', () => {
  it('places resource types before their dependent actions', () => {
    const definitions = createAuditFilterDefinitions(i18n.t, serverOptions);

    expect(definitions.map((definition) => definition.id)).toEqual(['resourceType', 'action', 'occurredAt']);
    const actionDefinition = definitions[1];
    expect(actionDefinition.kind).toBe('multi-select');
    if (actionDefinition.kind !== 'multi-select') throw new Error('Expected action multi-select definition.');
    expect(actionDefinition.dependsOn).toBe('resourceType');
    expect(actionDefinition.options).toEqual([
      { label: 'booking.created', parentValues: ['booking'], value: 'booking.created' },
      { label: 'shared.updated', parentValues: ['booking', 'product'], value: 'shared.updated' },
    ]);
  });

  it('merges loaded event relationships without duplicating server values', () => {
    expect(mergeAuditFilterOptions(serverOptions, [
      { action: 'booking.created', resourceType: 'booking' },
      { action: 'payment.created', resourceType: 'payment' },
    ])).toEqual({
      actions: ['booking.created', 'payment.created', 'shared.updated'],
      resourceTypes: ['booking', 'payment', 'product'],
      actionResourceTypes: {
        'booking.created': ['booking'],
        'shared.updated': ['booking', 'product'],
        'payment.created': ['payment'],
      },
    });
  });

  it('keeps older flat server catalogs safe during rolling upgrades', () => {
    const definitions = createAuditFilterDefinitions(i18n.t, {
      actions: ['legacy.updated'],
      resourceTypes: ['legacy'],
    });
    const actionDefinition = definitions[1];

    expect(actionDefinition.kind).toBe('multi-select');
    if (actionDefinition.kind !== 'multi-select') throw new Error('Expected action multi-select definition.');
    expect(actionDefinition.options[0]?.parentValues).toEqual([]);
  });
});
