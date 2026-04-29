/**
 * Pre-fill heuristic for the meal-type dropdown in the Add Meal modal.
 *
 * Maps a 24-hour clock hour into the most-likely meal type:
 *   - 05:00 – 10:59 → 'breakfast'
 *   - 11:00 – 14:59 → 'lunch'
 *   - 17:00 – 21:59 → 'dinner'
 *   - elsewhere     → null (no pre-fill, user picks manually)
 *
 * Closes the FLAG (UX_AUDIT_CHEFBYTE_USE) "Pre-fill meal type from
 * time of day" item. Cheap, no DB, easy to override.
 */
export function mealTypeFromHour(hour: number): 'breakfast' | 'lunch' | 'dinner' | null {
  if (hour >= 5 && hour < 11) return 'breakfast';
  if (hour >= 11 && hour < 15) return 'lunch';
  if (hour >= 17 && hour < 22) return 'dinner';
  return null;
}
