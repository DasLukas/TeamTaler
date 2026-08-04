/**
 * Neutralizes formulas and escapes text for a semicolon-separated CSV cell.
 *
 * @param value - Untrusted cell text.
 * @returns A quoted, formula-safe CSV cell.
 */
export function safeCsvCell(value: string): string {
  const sanitized = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${sanitized.replaceAll('"', '""')}"`;
}
