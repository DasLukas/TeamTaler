import { beforeEach, describe, expect, it } from 'vitest';
import { APPEARANCE_STORAGE_KEY, readStoredColorMode, writeStoredColorMode } from './appearance-storage';

describe('appearance storage', () => {
  beforeEach(() => window.localStorage.clear());

  it('falls back to system mode for missing, invalid, or obsolete values', () => {
    expect(readStoredColorMode()).toBe('SYSTEM');

    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, '{invalid');
    expect(readStoredColorMode()).toBe('SYSTEM');

    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ colorMode: 'DARK', version: 2 }));
    expect(readStoredColorMode()).toBe('SYSTEM');

    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ colorMode: 'SEPIA', version: 1 }));
    expect(readStoredColorMode()).toBe('SYSTEM');
  });

  it('round-trips a supported mode through the versioned payload', () => {
    writeStoredColorMode('DARK');

    expect(readStoredColorMode()).toBe('DARK');
    expect(JSON.parse(window.localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? '')).toEqual({
      colorMode: 'DARK',
      version: 1,
    });
  });

  it('keeps working when storage access is blocked', () => {
    const blockedStorage = {
      getItem: () => { throw new DOMException('Blocked'); },
      setItem: () => { throw new DOMException('Blocked'); },
    };

    expect(readStoredColorMode(blockedStorage)).toBe('SYSTEM');
    expect(() => writeStoredColorMode('LIGHT', blockedStorage)).not.toThrow();
  });
});
