import { useContext, useLayoutEffect } from 'react';
import type { ColorMode, ThemeId } from '@/api/types';
import {
  AppearanceContext,
  PUBLIC_THEME,
  type AppearanceState,
} from './appearance-context';

/**
 * Returns the current resolved application appearance.
 *
 * @returns Read-only color-mode, theme, and resolved-scheme values.
 * @throws Error when called outside `AppearanceProvider`.
 */
export function useAppearance(): AppearanceState {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error('useAppearance must be used inside AppearanceProvider.');
  return value;
}

/**
 * Synchronizes the authenticated account preference with the root provider.
 *
 * @param colorMode - Server-authoritative account color mode.
 */
export function useApplyAuthenticatedColorMode(colorMode: ColorMode): void {
  const controller = useContext(AppearanceContext);
  const applyColorMode = controller?.applyColorMode;
  useLayoutEffect(() => applyColorMode?.(colorMode), [applyColorMode, colorMode]);
}

/**
 * Synchronizes an active group's effective theme and restores the public theme on unmount.
 *
 * @param effectiveTheme - Membership override or group default theme.
 */
export function useApplyEffectiveGroupTheme(effectiveTheme: ThemeId): void {
  const controller = useContext(AppearanceContext);
  const applyEffectiveTheme = controller?.applyEffectiveTheme;
  useLayoutEffect(() => {
    applyEffectiveTheme?.(effectiveTheme);
    return () => applyEffectiveTheme?.(PUBLIC_THEME);
  }, [applyEffectiveTheme, effectiveTheme]);
}
