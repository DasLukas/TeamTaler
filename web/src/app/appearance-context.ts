import { createContext } from 'react';
import type { ColorMode, ThemeId } from '@/api/types';

/** Color scheme after resolving an explicit or operating-system preference. */
export type ResolvedColorScheme = 'light' | 'dark';

/** Public, read-only appearance state exposed to feature components. */
export interface AppearanceState {
  colorMode: ColorMode;
  effectiveTheme: ThemeId;
  resolvedColorScheme: ResolvedColorScheme;
}

/** Appearance state plus the private synchronization methods used by app providers. */
export interface AppearanceController extends AppearanceState {
  applyColorMode: (colorMode: ColorMode) => void;
  applyEffectiveTheme: (theme: ThemeId) => void;
}

/** Internal context shared by the root provider and authenticated synchronizers. */
export const AppearanceContext = createContext<AppearanceController | null>(null);

/** Media query used to resolve the `SYSTEM` color-mode preference. */
export const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

/** Theme applied outside authenticated group routes. */
export const PUBLIC_THEME: ThemeId = 'TEAMTALER';

const THEME_COLORS: Record<ThemeId, Record<ResolvedColorScheme, string>> = {
  TEAMTALER: { light: '#03182f', dark: '#03101f' },
  NRW: { light: '#006d32', dark: '#06351c' },
  TIEF_IM_WESTEN: { light: '#0f2864', dark: '#07183a' },
  FIRE: { light: '#962a27', dark: '#2c0d0b' },
};

/**
 * Resolves an application color mode against the operating-system preference.
 *
 * @param colorMode - Stored account preference.
 * @param systemPrefersDark - Current system media-query result.
 * @returns Concrete scheme used by CSS and browser chrome.
 */
export function resolveColorScheme(colorMode: ColorMode, systemPrefersDark: boolean): ResolvedColorScheme {
  if (colorMode === 'DARK') return 'dark';
  if (colorMode === 'LIGHT') return 'light';
  return systemPrefersDark ? 'dark' : 'light';
}

/**
 * Applies a complete appearance snapshot to the document in one layout phase.
 *
 * @param appearance - Theme, configured mode, and concrete scheme to apply.
 * @param documentTarget - Browser document to update.
 */
export function applyAppearanceToDocument(
  appearance: AppearanceState,
  documentTarget: Document = document,
): void {
  const root = documentTarget.documentElement;
  root.dataset.theme = appearance.effectiveTheme;
  root.dataset.colorMode = appearance.colorMode;
  root.dataset.colorScheme = appearance.resolvedColorScheme;
  root.style.colorScheme = appearance.resolvedColorScheme;

  const computedThemeColor = documentTarget.defaultView?.getComputedStyle(root).getPropertyValue('--color-navigation').trim();
  const themeColor = computedThemeColor || THEME_COLORS[appearance.effectiveTheme][appearance.resolvedColorScheme];
  documentTarget.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', themeColor);
  documentTarget.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]')
    ?.setAttribute('content', appearance.resolvedColorScheme === 'dark' ? 'black-translucent' : 'default');
}
