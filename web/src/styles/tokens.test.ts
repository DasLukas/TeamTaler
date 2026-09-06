import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ResolvedColorScheme } from '@/app/appearance-context';
import type { ThemeId } from '@/api/types';

const tokenSource = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');
const themes: readonly ThemeId[] = ['TEAMTALER', 'NRW', 'TIEF_IM_WESTEN', 'FIRE'];
const schemes: readonly ResolvedColorScheme[] = ['light', 'dark'];

function extractHexTokens(selector: string): Record<string, string> {
  const start = tokenSource.indexOf(`${selector} {`);
  if (start < 0) return {};
  const blockStart = tokenSource.indexOf('{', start) + 1;
  const blockEnd = tokenSource.indexOf('}', blockStart);
  return Object.fromEntries(
    [...tokenSource.slice(blockStart, blockEnd).matchAll(/(--[\w-]+):\s*(#[\da-f]{6});/gi)]
      .map((match) => [match[1], match[2].toLowerCase()]),
  );
}

function resolveHexTokens(theme: ThemeId, scheme: ResolvedColorScheme): Record<string, string> {
  return {
    ...extractHexTokens(':root'),
    ...(scheme === 'dark' ? extractHexTokens(":root[data-color-scheme='dark']") : {}),
    ...extractHexTokens(`:root[data-theme='${theme}'][data-color-scheme='${scheme}']`),
  };
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('semantic theme tokens', () => {
  it.each(themes.flatMap((theme) => schemes.map((scheme) => [theme, scheme] as const)))(
    'defines the complete statistics chart palette for %s %s',
    (theme, scheme) => {
      const tokens = resolveHexTokens(theme, scheme);
      [
        '--chart-primary', '--chart-secondary', '--chart-tertiary', '--chart-positive', '--chart-negative',
        '--chart-due', '--chart-neutral', '--chart-credit', '--chart-grid', '--chart-axis', '--chart-hover',
        '--chart-label-on-primary', '--chart-label-on-secondary', '--chart-label-on-due',
        '--chart-label-on-neutral', '--chart-label-on-credit',
      ].forEach((token) => expect(tokens[token], `${theme}/${scheme}: ${token}`).toMatch(/^#[\da-f]{6}$/));
    },
  );

  it.each(themes.flatMap((theme) => schemes.map((scheme) => [theme, scheme] as const)))(
    'keeps chart marks and direct labels legible for %s %s',
    (theme, scheme) => {
      const tokens = resolveHexTokens(theme, scheme);
      const surface = tokens['--color-surface'];
      ['--chart-primary', '--chart-secondary', '--chart-due', '--chart-neutral', '--chart-credit'].forEach((mark) => {
        expect(contrastRatio(tokens[mark], surface), `${theme}/${scheme}: ${mark} against surface`).toBeGreaterThanOrEqual(3);
      });
      [
        ['--chart-label-on-primary', '--chart-primary'],
        ['--chart-label-on-secondary', '--chart-secondary'],
        ['--chart-label-on-due', '--chart-due'],
        ['--chart-label-on-neutral', '--chart-neutral'],
        ['--chart-label-on-credit', '--chart-credit'],
      ].forEach(([label, fill]) => {
        expect(contrastRatio(tokens[label], tokens[fill]), `${theme}/${scheme}: ${label} on ${fill}`).toBeGreaterThanOrEqual(4.5);
      });
      expect(contrastRatio(tokens['--chart-axis'], surface), `${theme}/${scheme}: axis against surface`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens['--chart-grid'], surface), `${theme}/${scheme}: grid against surface`).toBeGreaterThanOrEqual(1.25);
    },
  );

  it.each(themes.flatMap((theme) => schemes.map((scheme) => [theme, scheme] as const)))(
    'keeps critical %s %s text pairs at WCAG AA contrast',
    (theme, scheme) => {
      const tokens = resolveHexTokens(theme, scheme);
      const pairs = [
        ['--color-text', '--color-canvas'],
        ['--color-text-strong', '--color-surface'],
        ['--color-text-muted', '--color-surface'],
        ['--color-text-subtle', '--color-surface-brand-subtle'],
        ['--color-text-brand', '--color-surface'],
        ['--color-text-on-brand', '--color-brand'],
        ['--color-navigation-text', '--color-navigation'],
        ['--color-status-success', '--color-status-success-subtle'],
        ['--color-status-warning', '--color-status-warning-subtle'],
        ['--color-status-danger', '--color-status-danger-subtle'],
      ] as const;

      pairs.forEach(([foregroundToken, backgroundToken]) => {
        const foreground = tokens[foregroundToken];
        const background = tokens[backgroundToken];
        expect(foreground, `${foregroundToken} must resolve to a hex color`).toBeDefined();
        expect(background, `${backgroundToken} must resolve to a hex color`).toBeDefined();
        expect(
          contrastRatio(foreground, background),
          `${theme}/${scheme}: ${foregroundToken} on ${backgroundToken}`,
        ).toBeGreaterThanOrEqual(4.5);
      });
    },
  );

  it.each(themes.flatMap((theme) => schemes.map((scheme) => [theme, scheme] as const)))(
    'keeps critical %s %s graphical indicators at non-text contrast',
    (theme, scheme) => {
      const tokens = resolveHexTokens(theme, scheme);
      const pairs = [
        ['--color-border-brand', '--color-surface'],
        ['--color-focus-ring', '--color-surface'],
        ['--color-navigation-accent', '--color-navigation'],
      ] as const;

      pairs.forEach(([indicatorToken, adjacentToken]) => {
        const indicator = tokens[indicatorToken];
        const adjacent = tokens[adjacentToken];
        expect(indicator, `${indicatorToken} must resolve to a hex color`).toBeDefined();
        expect(adjacent, `${adjacentToken} must resolve to a hex color`).toBeDefined();
        expect(
          contrastRatio(indicator, adjacent),
          `${theme}/${scheme}: ${indicatorToken} against ${adjacentToken}`,
        ).toBeGreaterThanOrEqual(3);
      });
    },
  );

  it('uses distinct tonal surface scales for every dark theme', () => {
    const darkThemes = themes.map((theme) => resolveHexTokens(theme, 'dark'));

    expect(new Set(darkThemes.map((tokens) => tokens['--color-canvas']))).toHaveLength(themes.length);
    expect(new Set(darkThemes.map((tokens) => tokens['--color-surface']))).toHaveLength(themes.length);
    darkThemes.forEach((tokens) => {
      expect(relativeLuminance(tokens['--color-canvas'])).toBeLessThan(relativeLuminance(tokens['--color-surface']));
      expect(relativeLuminance(tokens['--color-surface'])).toBeLessThan(relativeLuminance(tokens['--color-surface-raised']));
    });
  });
});
