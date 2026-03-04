/**
 * Date utilities for the Luna Hub Lite frontend.
 *
 * Uses local timezone (via `sv-SE` locale formatting) instead of UTC
 * to match the server-side `private.get_logical_date()` behavior.
 * The `sv-SE` locale outputs YYYY-MM-DD format natively.
 */

/**
 * Returns today's logical date as a YYYY-MM-DD string in the local timezone.
 *
 * Unlike `new Date().toISOString().slice(0, 10)` which uses UTC and
 * can return yesterday/tomorrow near midnight, this uses the browser's
 * local timezone to match what the user expects.
 *
 * If dayStartHour > 0, times before that hour count as the previous day.
 * This aligns with the server-side `private.get_logical_date()` which uses
 * the user's `day_start_hour` profile setting to shift the day boundary.
 */
export function todayStr(dayStartHour = 0): string {
  const now = new Date();
  if (dayStartHour > 0) {
    now.setHours(now.getHours() - dayStartHour);
  }
  return now.toLocaleDateString('sv-SE');
}

/**
 * Converts a Date object to a YYYY-MM-DD string in local timezone.
 */
export function toDateStr(d: Date): string {
  return d.toLocaleDateString('sv-SE');
}

/**
 * Formats a YYYY-MM-DD date string for display (e.g., "Mon, Mar 3").
 */
export function formatDateDisplay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
