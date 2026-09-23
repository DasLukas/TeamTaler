/** Stable group-scoped React Query keys for the external-account module. */
export const externalAccountKeys = {
  all: (groupId: string) => ['external-accounts', groupId] as const,
  list: (groupId: string) => ['external-accounts', groupId, 'list'] as const,
  links: (groupId: string) => ['external-accounts', groupId, 'links'] as const,
  transactions: (groupId: string) => ['external-accounts', groupId, 'transactions'] as const,
  transactionCollection: (groupId: string, query: object) => ['external-accounts', groupId, 'transactions', query] as const,
};
