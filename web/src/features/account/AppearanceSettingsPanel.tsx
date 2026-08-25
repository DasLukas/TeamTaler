import { useMutation, useQueryClient } from '@tanstack/react-query';
import Monitor from 'lucide-react/dist/esm/icons/monitor';
import Moon from 'lucide-react/dist/esm/icons/moon';
import Sun from 'lucide-react/dist/esm/icons/sun';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { ColorMode, Session, ThemeId } from '@/api/types';
import { useOptionalActiveGroup } from '@/app/useActiveGroup';
import { useSession } from '@/app/useSession';
import { ThemePicker } from '@/features/appearance/ThemePicker';
import styles from './AppearanceSettingsPanel.module.css';

const COLOR_MODE_OPTIONS: ReadonlyArray<{ icon: ReactNode; value: ColorMode }> = [
  { icon: <Monitor size={20} />, value: 'SYSTEM' },
  { icon: <Sun size={20} />, value: 'LIGHT' },
  { icon: <Moon size={20} />, value: 'DARK' },
];

function updateSessionColorMode(session: Session | undefined, colorMode: ColorMode): Session | undefined {
  return session ? { ...session, colorMode } : session;
}

function updateSessionThemeOverride(session: Session | undefined, groupId: string, themeOverride: ThemeId | null): Session | undefined {
  return session ? {
    ...session,
    groups: session.groups.map((group) => group.id === groupId && group.membership
      ? { ...group, membership: { ...group.membership, themeOverride } }
      : group),
  } : session;
}

/**
 * Renders persisted account color-mode and active-group theme preferences.
 *
 * @returns Optimistic appearance controls, limited to color mode for group-less administrators.
 */
export function AppearanceSettingsPanel() {
  const { t } = useTranslation();
  const session = useSession();
  const activeGroupContext = useOptionalActiveGroup();
  const activeGroup = activeGroupContext?.activeGroup;
  const queryClient = useQueryClient();
  const colorModeName = useId();

  const colorModeMutation = useMutation({
    mutationFn: (colorMode: ColorMode) => api.updateAppearance(colorMode),
    onMutate: async (colorMode) => {
      await queryClient.cancelQueries({ queryKey: ['session'] });
      const previousColorMode = queryClient.getQueryData<Session>(['session'])?.colorMode ?? session.colorMode;
      queryClient.setQueryData<Session>(['session'], (current) => updateSessionColorMode(current ?? session, colorMode));
      return { previousColorMode };
    },
    onError: (_error, _colorMode, context) => {
      if (context) queryClient.setQueryData<Session>(['session'], (current) => updateSessionColorMode(current ?? session, context.previousColorMode));
    },
    onSuccess: (preference) => {
      queryClient.setQueryData<Session>(['session'], (current) => updateSessionColorMode(current ?? session, preference.colorMode));
    },
  });

  const themeMutation = useMutation({
    mutationFn: ({ groupId, themeOverride }: { groupId: string; themeOverride: ThemeId | null }) => api.updateThemePreference(groupId, themeOverride),
    onMutate: async ({ groupId, themeOverride }) => {
      await queryClient.cancelQueries({ queryKey: ['session'] });
      const current = queryClient.getQueryData<Session>(['session']) ?? session;
      const previousThemeOverride = current.groups.find((group) => group.id === groupId)?.membership?.themeOverride ?? null;
      queryClient.setQueryData<Session>(['session'], (cached) => updateSessionThemeOverride(cached ?? session, groupId, themeOverride));
      return { groupId, previousThemeOverride };
    },
    onError: (_error, _variables, context) => {
      if (context) queryClient.setQueryData<Session>(['session'], (current) => updateSessionThemeOverride(current ?? session, context.groupId, context.previousThemeOverride));
    },
    onSuccess: (preference, variables) => {
      queryClient.setQueryData<Session>(['session'], (current) => updateSessionThemeOverride(current ?? session, variables.groupId, preference.themeOverride));
    },
  });

  return (
    <section aria-labelledby="appearance-settings-title" className={styles.card}>
      <div className={styles.heading}>
        <h2 id="appearance-settings-title">{t('appearance.title')}</h2>
        <p>{t('appearance.description')}</p>
      </div>

      <fieldset className={styles.colorMode} disabled={colorModeMutation.isPending}>
        <legend>{t('appearance.colorModeLabel')}</legend>
        <div className={styles.colorModeOptions}>
          {COLOR_MODE_OPTIONS.map((option) => (
            <label key={option.value}>
              <input
                checked={session.colorMode === option.value}
                name={colorModeName}
                onChange={() => colorModeMutation.mutate(option.value)}
                type="radio"
                value={option.value}
              />
              <span><span aria-hidden="true">{option.icon}</span>{t(`appearance.colorModes.${option.value}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {colorModeMutation.isError ? <p className={styles.error} role="alert">{t('appearance.colorModeSaveError')}</p> : null}
      {colorModeMutation.isSuccess ? <p className={styles.success} role="status">{t('appearance.colorModeSaved')}</p> : null}

      {activeGroup?.membership ? (
        <div className={styles.themeSection}>
          <ThemePicker
            defaultTheme={activeGroup.defaultTheme}
            disabled={themeMutation.isPending}
            includeGroupDefault
            label={t('appearance.themeLabel')}
            onChange={(themeOverride) => themeMutation.mutate({ groupId: activeGroup.id, themeOverride })}
            value={activeGroup.membership.themeOverride}
          />
          <p className={styles.hint}>{t('appearance.themeHint', { group: activeGroup.name })}</p>
          {themeMutation.isError ? <p className={styles.error} role="alert">{t('appearance.themeSaveError')}</p> : null}
          {themeMutation.isSuccess ? <p className={styles.success} role="status">{t('appearance.themeSaved')}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
