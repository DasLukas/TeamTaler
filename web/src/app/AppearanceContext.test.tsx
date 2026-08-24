import { act, render, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColorMode, ThemeId } from '@/api/types';
import {
  resolveColorScheme,
} from './appearance-context';
import { AppearanceProvider } from './AppearanceProvider';
import {
  useAppearance,
  useApplyAuthenticatedColorMode,
  useApplyEffectiveGroupTheme,
} from './useAppearance';
import { APPEARANCE_STORAGE_KEY } from './appearance-storage';

interface ControllableMediaQuery extends MediaQueryList {
  setMatches: (matches: boolean) => void;
}

function createMediaQuery(initialMatches: boolean): ControllableMediaQuery {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  return {
    get matches() { return matches; },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === 'function') listeners.add(listener as (event: MediaQueryListEvent) => void);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === 'function') listeners.delete(listener as (event: MediaQueryListEvent) => void);
    },
    addListener: (listener: ((event: MediaQueryListEvent) => void) | null) => {
      if (listener) listeners.add(listener);
    },
    removeListener: (listener: ((event: MediaQueryListEvent) => void) | null) => {
      if (listener) listeners.delete(listener);
    },
    dispatchEvent: () => true,
    setMatches(nextMatches) {
      matches = nextMatches;
      const event = { matches } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
  };
}

function AppearanceProbe() {
  const appearance = useAppearance();
  return <output aria-label="appearance">{`${appearance.colorMode}:${appearance.effectiveTheme}:${appearance.resolvedColorScheme}`}</output>;
}

function AuthenticatedAppearance({ colorMode, theme }: { colorMode: ColorMode; theme: ThemeId }) {
  useApplyAuthenticatedColorMode(colorMode);
  useApplyEffectiveGroupTheme(theme);
  return <AppearanceProbe />;
}

function ProviderHarness({ children }: { children: ReactNode }) {
  return <AppearanceProvider>{children}</AppearanceProvider>;
}

describe('AppearanceProvider', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-color-mode');
    document.documentElement.removeAttribute('data-color-scheme');
    document.documentElement.removeAttribute('style');
    document.head.querySelector('meta[name="theme-color"]')?.remove();
    const themeColor = document.createElement('meta');
    themeColor.name = 'theme-color';
    document.head.append(themeColor);
  });

  it('resolves explicit and system color modes', () => {
    expect(resolveColorScheme('LIGHT', true)).toBe('light');
    expect(resolveColorScheme('DARK', false)).toBe('dark');
    expect(resolveColorScheme('SYSTEM', true)).toBe('dark');
    expect(resolveColorScheme('SYSTEM', false)).toBe('light');
  });

  it('uses versioned storage before authenticated state is available', () => {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ colorMode: 'DARK', version: 1 }));
    vi.spyOn(window, 'matchMedia').mockReturnValue(createMediaQuery(false));

    render(<AppearanceProbe />, { wrapper: ProviderHarness });

    expect(screen.getByLabelText('appearance')).toHaveTextContent('DARK:TEAMTALER:dark');
    expect(document.documentElement).toHaveAttribute('data-color-scheme', 'dark');
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#03182f');
  });

  it('reacts live to system scheme changes only while system mode is active', () => {
    const mediaQuery = createMediaQuery(false);
    vi.spyOn(window, 'matchMedia').mockReturnValue(mediaQuery);
    render(<AppearanceProbe />, { wrapper: ProviderHarness });

    expect(screen.getByLabelText('appearance')).toHaveTextContent('SYSTEM:TEAMTALER:light');
    act(() => mediaQuery.setMatches(true));
    expect(screen.getByLabelText('appearance')).toHaveTextContent('SYSTEM:TEAMTALER:dark');
  });

  it('tracks system changes behind an explicit mode so returning to system does not flash', () => {
    const mediaQuery = createMediaQuery(false);
    vi.spyOn(window, 'matchMedia').mockReturnValue(mediaQuery);

    function Harness() {
      const [colorMode, setColorMode] = useState<ColorMode>('LIGHT');
      return (
        <AppearanceProvider>
          <button onClick={() => setColorMode('SYSTEM')} type="button">Use system</button>
          <AuthenticatedAppearance colorMode={colorMode} theme="TEAMTALER" />
        </AppearanceProvider>
      );
    }

    render(<Harness />);
    act(() => mediaQuery.setMatches(true));
    expect(screen.getByLabelText('appearance')).toHaveTextContent('LIGHT:TEAMTALER:light');

    act(() => screen.getByRole('button', { name: 'Use system' }).click());
    expect(screen.getByLabelText('appearance')).toHaveTextContent('SYSTEM:TEAMTALER:dark');
  });

  it('applies authenticated state, switches group themes, and restores the public theme', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue(createMediaQuery(false));

    function Harness() {
      const [theme, setTheme] = useState<ThemeId>('NRW');
      const [authenticated, setAuthenticated] = useState(true);
      return (
        <AppearanceProvider>
          <button onClick={() => setTheme('TIEF_IM_WESTEN')} type="button">Switch group</button>
          <button onClick={() => setAuthenticated(false)} type="button">Sign out</button>
          {authenticated ? <AuthenticatedAppearance colorMode="DARK" theme={theme} /> : <AppearanceProbe />}
        </AppearanceProvider>
      );
    }

    render(<Harness />);
    expect(screen.getByLabelText('appearance')).toHaveTextContent('DARK:NRW:dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'NRW');

    act(() => screen.getByRole('button', { name: 'Switch group' }).click());
    expect(screen.getByLabelText('appearance')).toHaveTextContent('DARK:TIEF_IM_WESTEN:dark');
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#08183d');

    act(() => screen.getByRole('button', { name: 'Sign out' }).click());
    expect(screen.getByLabelText('appearance')).toHaveTextContent('DARK:TEAMTALER:dark');
  });
});
