import { describe, expect, it } from 'vitest';
import { safeCsvCell } from './csv';

describe('safeCsvCell', () => {
  it.each(['=2+2', '+SUM(A1:A2)', '-1+2', '@IMPORT', '\tformula'])('neutralizes spreadsheet formula input %s', (value) => {
    expect(safeCsvCell(value)).toBe(`"'${value}"`);
  });

  it('escapes quotes in ordinary content', () => {
    expect(safeCsvCell('Team "Adler"')).toBe('"Team ""Adler"""');
  });
});
