/**
 * Date utilities for the Luna Hub Lite frontend.
 *
 * Uses local timezone (via `sv-SE` locale formatting) instead of UTC
 * to match the server-side `private.get_logical_date()` behavior.
 * The `sv-SE` locale outputs YYYY-MM-DD format natively.
 */

/**
 * Returns today's date as a YYYY-MM-DD string in the local timezone.
 *
 * Unlike `new Date().toISOString().slice(0, 10)` which uses UTC and
 * can return yesterday/tomorrow near midnight, this uses the browser's
 * local timezone to match what the user expects.
 */
export function todayStr(): string {
  return new Date().toLocaleDateString('sv-SE');
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
