/**
 * Date utilities for the Luna Hub Lite frontend.
 *
 * These compute the *logical date* shown to the user, mirroring the
 * server-side `private.get_logical_date(ts, tz, day_start_hour)` contract:
 *
 *   (ts AT TIME ZONE tz - interval '<day_start_hour> hours')::DATE
 *
 * IMPORTANT (audit H-19 / TZ-CLIENT): the logical date that the web app
 * writes into `food_logs.logical_date` (via `consume_product`'s
 * `p_logical_date`) is stored VERBATIM — the server does NOT recompute it.
 * The Pi (`shelf-ingest`) and MCP paths compute it from the user's PROFILE
 * timezone. So the web app must use that same profile timezone, not the
 * browser's, or rows near the day boundary land on the wrong logical day
 * versus every other writer. Always pass the profile `timezone` from
 * `useAppContext()` when the result feeds a logical_date or a "today"
 * comparison against server data.
 *
 * When `timezone` is omitted these functions fall back to the browser's
 * local timezone (legacy behavior) for non-critical, display-only callers.
 */

/**
 * Formats a UTC instant as a YYYY-MM-DD calendar date in `timeZone`, after
 * subtracting `dayStartHour` hours from the wall-clock time in that zone.
 *
 * This mirrors the SQL `private.get_logical_date` exactly. We use
 * `Intl.DateTimeFormat` so we get real IANA timezone data (DST transitions,
 * date-line offsets), not a naive fixed UTC offset.
 */
function logicalDateInTz(instant: Date, timeZone: string, dayStartHour: number): string {
  // Step 1 — decompose the instant into wall-clock parts in `timeZone`.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));

  // Step 2 — build a synthetic local Date from those parts so we can do
  // calendar-correct hour arithmetic. The host timezone is irrelevant here:
  // we only read back the resulting Y/M/D after the subtraction.
  const hour24 = parseInt(parts.hour, 10) % 24; // Intl can emit '24' for midnight
  const localEquiv = new Date(
    parseInt(parts.year, 10),
    parseInt(parts.month, 10) - 1,
    parseInt(parts.day, 10),
    hour24,
    parseInt(parts.minute, 10),
    parseInt(parts.second, 10),
  );

  // Step 3 — subtract dayStartHour hours (matches the SQL INTERVAL subtraction).
  localEquiv.setHours(localEquiv.getHours() - dayStartHour);

  // Step 4 — format the resulting date as YYYY-MM-DD.
  const y = localEquiv.getFullYear();
  const m = String(localEquiv.getMonth() + 1).padStart(2, '0');
  const d = String(localEquiv.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Returns today's logical date as a YYYY-MM-DD string.
 *
 * Pass the profile `timezone` (IANA, e.g. "America/New_York") whenever the
 * result is written to the DB or compared against server-computed logical
 * dates — this keeps the web app aligned with the Pi/MCP and the SQL
 * `private.get_logical_date`. Without it, the browser's local timezone is
 * used (legacy / display-only fallback).
 *
 * If `dayStartHour > 0`, times before that hour count as the previous day.
 */
export function todayStr(dayStartHour = 0, timezone?: string): string {
  const now = new Date();
  if (timezone) {
    return logicalDateInTz(now, timezone, dayStartHour);
  }
  // Legacy fallback: browser-local wall clock.
  if (dayStartHour > 0) {
    now.setHours(now.getHours() - dayStartHour);
  }
  return now.toLocaleDateString('sv-SE');
}

/**
 * Converts a Date object to a YYYY-MM-DD string.
 *
 * Pass the profile `timezone` to format the calendar day in that zone
 * (so a stored instant maps to the same logical day as the server). Without
 * it, the browser's local timezone is used (legacy / display-only fallback).
 */
export function toDateStr(d: Date, timezone?: string): string {
  if (timezone) {
    // dayStartHour=0: pure calendar-date conversion in the target zone.
    return logicalDateInTz(d, timezone, 0);
  }
  return d.toLocaleDateString('sv-SE');
}

/**
 * Formats a YYYY-MM-DD date string for display (e.g., "Mon, Mar 3").
 */
export function formatDateDisplay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
