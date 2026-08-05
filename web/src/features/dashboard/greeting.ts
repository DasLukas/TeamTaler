type DashboardGreetingKey = 'night' | 'morning' | 'day' | 'evening';

/**
 * Selects the localized dashboard greeting for a local clock hour.
 *
 * @param hour - Local hour in the browser's 24-hour clock.
 * @returns The translation key for night, morning, daytime, or evening.
 * @throws This function does not throw.
 * @example getDashboardGreetingKey(0) returns `night`.
 */
export function getDashboardGreetingKey(hour: number): DashboardGreetingKey {
  if (hour < 5) return 'night';
  if (hour < 11) return 'morning';
  if (hour < 18) return 'day';
  if (hour < 22) return 'evening';
  return 'night';
}
