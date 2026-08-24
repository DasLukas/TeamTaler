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
    'keeps critical %s %s text pairs at WCAG AA contrast',
    (theme, scheme) => {
      const tokens = resolveHexTokens(theme, scheme);
      const pairs = [
        ['--color-text', '--color-canvas'],
        ['--color-text-strong', '--color-surface'],
        ['--color-text-muted', '--color-surface'],
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
});
