/**
 * Epley 1RM formula: load * (1 + reps/30).
 *
 * Lives in `shared/` (not `pages/coachbyte/PrsPage`) because TodayPage's
 * PR-detection path needs it too — and "page A imports from page B" is
 * the kind of cross-page dependency that bites in code splitting.
 */
export function epley1RM(load: number, reps: number): number {
  if (reps <= 0 || load <= 0) return 0;
  if (reps === 1) return load;
  return Math.round(load * (1 + reps / 30));
}
