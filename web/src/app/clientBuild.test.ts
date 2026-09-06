import { describe, expect, it } from 'vitest';
import { clientVersionFromBuildId } from './clientBuild';

describe('clientVersionFromBuildId', () => {
  it('removes release-tag and revision details from a production build identifier', () => {
    expect(clientVersionFromBuildId('v1.2.0@abc123')).toBe('1.2.0');
  });

  it('keeps the development version readable', () => {
    expect(clientVersionFromBuildId('dev@unknown')).toBe('dev');
  });
});
