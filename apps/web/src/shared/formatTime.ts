/**
 * Format total seconds into mm:ss display string.
 * Negative values are clamped to 0:00.
 */
export function formatTime(totalSeconds: number): string {
  const mins = Math.floor(Math.max(0, totalSeconds) / 60);
  const secs = Math.max(0, totalSeconds) % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
