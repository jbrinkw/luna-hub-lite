/**
 * Group consecutive same-product food_log entries within a 15-min window.
 *
 * Used by HomePage's "Consumed Today" and MealPlanPage's per-day "Consumed"
 * sections. Without grouping, rapid-fire scans of the same product (e.g.
 * four glasses of milk in twenty minutes) render as four separate rows.
 *
 * Behavior:
 *   - Groups are formed by sorting logs by created_at ascending and walking
 *     the list. A new log joins the current group if (a) its product_id
 *     matches the group's anchor product_id and (b) its created_at is
 *     within 15 minutes of the GROUP'S FIRST entry. Otherwise it starts
 *     a new group.
 *   - Logs with no product_id (e.g. an orphan after a hard delete via
 *     ON DELETE SET NULL) always stand alone — there's no key to merge on.
 *   - Single-log groups are still returned as a one-element group so the
 *     caller has a uniform shape.
 *   - Original input is not mutated.
 */

export interface AggregableLog {
  log_id: string;
  /** product_id is the merge key. Logs with null product_id never merge. */
  product_id?: string | null;
  qty_consumed: number;
  unit: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  /** ISO-8601 timestamp from food_logs.created_at. */
  created_at: string;
  products?: { name: string } | null;
}

export interface LogGroup<T extends AggregableLog> {
  /** The first (oldest) log in the group — drives display name + unit. */
  anchor: T;
  /** All logs in the group (1+ entries). */
  logs: T[];
  totalQty: number;
  totalCalories: number;
  totalProtein: number;
  totalCarbs: number;
  totalFat: number;
}

const FIFTEEN_MIN_MS = 15 * 60 * 1000;

const tsOf = (log: AggregableLog): number => {
  const t = Date.parse(log.created_at);
  return Number.isFinite(t) ? t : 0;
};

const numericField = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

export function aggregateLogsByProduct<T extends AggregableLog>(logs: T[]): LogGroup<T>[] {
  if (logs.length === 0) return [];
  const sorted = [...logs].sort((a, b) => tsOf(a) - tsOf(b));
  const groups: LogGroup<T>[] = [];
  let current: LogGroup<T> | null = null;
  let anchorTs = 0;

  for (const log of sorted) {
    const ts = tsOf(log);
    const canMerge =
      current != null &&
      current.anchor.product_id != null &&
      log.product_id != null &&
      current.anchor.product_id === log.product_id &&
      ts - anchorTs <= FIFTEEN_MIN_MS;

    if (canMerge && current) {
      current.logs.push(log);
      current.totalQty += numericField(log.qty_consumed);
      current.totalCalories += numericField(log.calories);
      current.totalProtein += numericField(log.protein);
      current.totalCarbs += numericField(log.carbs);
      current.totalFat += numericField(log.fat);
    } else {
      current = {
        anchor: log,
        logs: [log],
        totalQty: numericField(log.qty_consumed),
        totalCalories: numericField(log.calories),
        totalProtein: numericField(log.protein),
        totalCarbs: numericField(log.carbs),
        totalFat: numericField(log.fat),
      };
      anchorTs = ts;
      groups.push(current);
    }
  }
  return groups;
}
