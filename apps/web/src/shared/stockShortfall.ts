/**
 * Wrap a raw RPC stock-shortfall error into actionable copy.
 *
 * The mark_meal_done RPC raises:
 *   'Insufficient stock for <name>: need <X> containers, have <Y>'
 *
 * Audit (UX_AUDIT_CHEFBYTE_USE_R2 #12) flagged the cross-page import
 * of this helper from HomePage as a code-splitting smell — MealPlanPage
 * was dragging HomePage's bundle along just to pick this string up.
 * Moved here so consumers can import from a route-neutral module.
 *
 * Other errors pass through untouched so we don't mask unexpected
 * failures behind a friendlier-but-wrong message.
 */
export function formatStockShortfallMessage(message: string): string {
  if (!message) return '';
  if (/insufficient stock/i.test(message)) {
    return `Can't mark this meal done: ${message}. Add the missing item to your shopping list, then try again.`;
  }
  return message;
}
