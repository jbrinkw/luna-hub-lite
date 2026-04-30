/**
 * Format a product quantity for human-readable display.
 *
 * Used in two places that share identical display semantics:
 *   1. Recipe lines  ("2 eggs Cage-Free Eggs")
 *   2. Inventory / meal-plan / food-log quantity columns
 *
 * The visual pair lives on the PRODUCT now (visual_unit_label +
 * visual_units_per_serving). When set, this helper converts the
 * canonical (quantity + unit) into "<displayQty> <pluralized-label>
 * <productName>". When unset OR when the canonical unit is `gram`, the
 * helper falls back to the existing canonical rendering ("30g <name>",
 * "1 ctn <name>", "2 svg <name>").
 *
 * Backend math (consume_product, mark_meal_done, food_logs, macro calc)
 * NEVER reads visual fields — canonical unit + quantity remain the single
 * source of truth.
 */
export function formatIngredientDisplay(args: {
  quantity: number;
  unit: 'container' | 'serving' | 'gram';
  productName: string;
  visualUnitLabel: string | null;
  visualUnitsPerServing: number | null;
  servingsPerContainer: number;
}): string {
  const { productName } = args;
  const name = productName ?? '';
  // Recipe ingredient lines drop trailing zeros ("1 ctn Bacon", not
  // "1.0 ctn Bacon") for tighter prose — pass canonicalDecimals undefined
  // to skip toFixed and use the trim-zeros formatter instead.
  const qty = formatQuantityWithVisual(args);
  return `${qty} ${name}`;
}

/**
 * Format just the "<qty> <label>" portion (no product name).
 *
 * `canonicalDecimals`:
 *   - omitted/undefined → trim trailing zeros, up to 3 decimals
 *     ("3 ctn", "1 ctn"). Used by `formatIngredientDisplay` for recipe
 *     prose.
 *   - set to a number (typically `1`) → fixed-decimal output
 *     ("3.0 ctn", "1.0 ctn"). Used directly by inventory / meal-plan UI
 *     per CLAUDE.md ("Quantities displayed to 1 decimal in UI").
 *
 * The visual path always trims zeros and pluralizes so "1 egg" doesn't
 * render as "1.0 eggs".
 */
export function formatQuantityWithVisual(args: {
  quantity: number;
  unit: 'container' | 'serving' | 'gram';
  visualUnitLabel: string | null;
  visualUnitsPerServing: number | null;
  servingsPerContainer: number;
  canonicalDecimals?: number;
}): string {
  const { quantity, unit, visualUnitLabel, visualUnitsPerServing, servingsPerContainer, canonicalDecimals } = args;

  const visualSet =
    visualUnitLabel != null && visualUnitLabel !== '' && visualUnitsPerServing != null && visualUnitsPerServing > 0;

  // Visual rendering only applies when the canonical unit is something
  // we can convert to servings (container or serving). For gram, the
  // user is already speaking grams — keep the canonical rendering so
  // "30g" stays exact and stable.
  if (visualSet && (unit === 'container' || unit === 'serving')) {
    const servings = unit === 'container' ? quantity * Math.max(servingsPerContainer, 0.001) : quantity;
    const displayQty = servings * (visualUnitsPerServing as number);
    const label = pluralize(visualUnitLabel as string, displayQty);
    return `${formatNumber(displayQty)} ${label}`;
  }

  return canonicalStr(quantity, unit, canonicalDecimals);
}

/** Format a number: drop trailing zeros, keep up to 3 decimal places. */
function formatNumber(n: number): string {
  // Use toPrecision-style: show up to 3 significant decimals but trim zeros
  const fixed = n.toFixed(3);
  // Remove trailing zeros after decimal, and trailing dot
  return fixed.replace(/\.?0+$/, '');
}

/**
 * Simple pluralization: append "s" unless count === 1. Matches the rest
 * of the codebase ("1 serving" vs "2 servings"). No irregulars — the
 * label is user-supplied and we do not maintain a dictionary.
 */
function pluralize(label: string, count: number): string {
  return count === 1 ? label : `${label}s`;
}

/** Canonical unit abbreviation string, e.g. "30g", "1 ctn", "2 svg". */
function canonicalStr(quantity: number, unit: 'container' | 'serving' | 'gram', decimals?: number): string {
  const qStr = decimals != null ? quantity.toFixed(decimals) : formatNumber(quantity);
  switch (unit) {
    case 'gram':
      return `${qStr}g`;
    case 'container':
      return `${qStr} ctn`;
    case 'serving':
      return `${qStr} svg`;
    default:
      return `${qStr} ${unit}`;
  }
}
