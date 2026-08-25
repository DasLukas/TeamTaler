import type { ColorMode } from '@/api/types';

/** Versioned browser key used to mirror the last applied color mode. */
export const APPEARANCE_STORAGE_KEY = 'teamtaler:appearance:v1';

interface StoredAppearance {
  colorMode: ColorMode;
  version: 1;
}

/** Closed set of color modes that may be trusted from browser storage. */
export const COLOR_MODES = ['SYSTEM', 'LIGHT', 'DARK'] as const satisfies readonly ColorMode[];

/**
 * Determines whether an untrusted value is a supported color mode.
 *
 * @param value - Value read from an external source.
 * @returns Whether the value belongs to the supported color-mode registry.
 */
export function isColorMode(value: unknown): value is ColorMode {
  return typeof value === 'string' && COLOR_MODES.some((mode) => mode === value);
}

/**
 * Reads the last applied color mode from versioned browser storage.
 *
 * @param storage - Storage implementation to read, or `undefined` outside a browser.
 * @returns A validated mode, falling back to `SYSTEM` for missing or invalid data.
 */
export function readStoredColorMode(storage?: Pick<Storage, 'getItem'>): ColorMode {
  try {
    const targetStorage = storage ?? globalThis.window?.localStorage;
    if (!targetStorage) return 'SYSTEM';
    const rawValue = targetStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (!rawValue) return 'SYSTEM';
    const value = JSON.parse(rawValue) as Partial<StoredAppearance>;
    return value.version === 1 && isColorMode(value.colorMode) ? value.colorMode : 'SYSTEM';
  } catch {
    return 'SYSTEM';
  }
}

/**
 * Mirrors an applied color mode for startup rendering.
 *
 * @param colorMode - Validated mode selected or applied by the application.
 * @param storage - Storage implementation to update, or `undefined` outside a browser.
 */
export function writeStoredColorMode(colorMode: ColorMode, storage?: Pick<Storage, 'setItem'>): void {
  try {
    const targetStorage = storage ?? globalThis.window?.localStorage;
    if (!targetStorage) return;
    targetStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ colorMode, version: 1 } satisfies StoredAppearance));
  } catch {
    // The in-memory appearance remains usable when browser privacy settings block storage.
  }
}
