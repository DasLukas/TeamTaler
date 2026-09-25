import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { GroupSettings, GroupSettingsUpdateInput } from '@/api/types';
import { externalAccountKeys } from '@/features/externalAccounts/externalAccountQueryKeys';
import { notificationKeys } from '@/features/notifications/notificationQueryKeys';

/**
 * Identifies the TanStack mutation queue for one group's settings document.
 *
 * @param groupId - Group owning the settings document.
 * @returns A stable mutation scope shared by every group-settings control.
 * @throws No exceptions.
 */
export function groupSettingsMutationScope(groupId: string) {
  return { id: `group-settings:${groupId}` };
}

/**
 * Refreshes read models affected by a committed group-settings patch.
 *
 * @param queryClient - Shared query cache.
 * @param groupId - Group whose settings changed.
 * @returns A promise resolved after dependent queries are invalidated.
 * @throws If an underlying query invalidation fails.
 */
export async function invalidateGroupSettingsConsumers(queryClient: QueryClient, groupId: string): Promise<void> {
  queryClient.removeQueries({ queryKey: notificationKeys.preferences(groupId) });
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['booking-context', groupId] }),
    queryClient.invalidateQueries({ queryKey: ['transaction-settings', groupId] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard', groupId] }),
    queryClient.invalidateQueries({ queryKey: ['periods', groupId] }),
    queryClient.invalidateQueries({ queryKey: ['settlements', groupId] }),
    queryClient.invalidateQueries({ queryKey: ['roles', groupId] }),
    queryClient.invalidateQueries({ queryKey: ['members', groupId] }),
    queryClient.invalidateQueries({ queryKey: ['statistics', groupId] }),
    queryClient.invalidateQueries({ queryKey: externalAccountKeys.all(groupId) }),
  ]);
}

/**
 * Creates a scoped partial-patch mutation for an independently edited settings card.
 *
 * @param groupId - Group whose settings are being edited.
 * @returns A mutation that accepts a partial settings update and refreshes its consumers.
 * @throws The API mutation error is exposed through the returned mutation state.
 */
export function useGroupSettingsPatch(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: groupSettingsMutationScope(groupId),
    mutationFn: (update: GroupSettingsUpdateInput) => api.updateGroupSettings(groupId, update),
    onSuccess: async (persisted) => {
      queryClient.setQueryData<GroupSettings>(['group-settings', groupId], persisted);
      await invalidateGroupSettingsConsumers(queryClient, groupId);
    },
  });
}
