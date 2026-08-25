import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ColorMode, ThemeId } from '@/api/types';
import {
  AppearanceContext,
  PUBLIC_THEME,
  SYSTEM_DARK_QUERY,
  applyAppearanceToDocument,
  resolveColorScheme,
  type AppearanceController,
  type AppearanceState,
} from './appearance-context';
import { readStoredColorMode, writeStoredColorMode } from './appearance-storage';

/**
 * Provides live document appearance while keeping server state authoritative.
 *
 * @param props - Descendants that may synchronize session and group appearance.
 * @returns Appearance context and DOM synchronization for the application tree.
 */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [colorMode, setColorMode] = useState<ColorMode>(readStoredColorMode);
  const [effectiveTheme, setEffectiveTheme] = useState<ThemeId>(PUBLIC_THEME);
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => globalThis.window?.matchMedia(SYSTEM_DARK_QUERY).matches ?? false);

  useEffect(() => {
    const mediaQuery = window.matchMedia(SYSTEM_DARK_QUERY);
    const synchronizeSystemScheme = (event?: MediaQueryListEvent) => setSystemPrefersDark(event?.matches ?? mediaQuery.matches);
    synchronizeSystemScheme();
    mediaQuery.addEventListener('change', synchronizeSystemScheme);
    return () => mediaQuery.removeEventListener('change', synchronizeSystemScheme);
  }, []);

  const resolvedColorScheme = resolveColorScheme(colorMode, systemPrefersDark);
  const state = useMemo<AppearanceState>(() => ({ colorMode, effectiveTheme, resolvedColorScheme }), [colorMode, effectiveTheme, resolvedColorScheme]);
  const applyColorMode = useCallback((nextColorMode: ColorMode) => {
    writeStoredColorMode(nextColorMode);
    setColorMode(nextColorMode);
  }, []);
  const applyEffectiveTheme = useCallback((nextTheme: ThemeId) => setEffectiveTheme(nextTheme), []);

  useLayoutEffect(() => applyAppearanceToDocument(state), [state]);

  const value = useMemo<AppearanceController>(() => ({
    ...state,
    applyColorMode,
    applyEffectiveTheme,
  }), [applyColorMode, applyEffectiveTheme, state]);

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}
