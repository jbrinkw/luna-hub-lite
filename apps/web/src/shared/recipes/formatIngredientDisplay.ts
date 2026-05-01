/**
 * Format a product quantity for human-readable display.
 *
 * Three render modes, in precedence order:
 *
 *   1. **By-weight** — `displayByWeight && netWeightG > 0`. Converts the
 *      canonical quantity to grams via net_weight_g, then renders as either
 *      grams (`unitSystem='metric'`) or ounces (`unitSystem='imperial'`).
 *      Format: "150g <name>" / "5.3oz <name>" — no plural-s, no space
 *      before unit symbol.
 *
 *   2. **Visual unit** — `visualUnitLabel && visualUnitsPerServing > 0` AND
 *      canonical unit is 'serving' or 'container'. Converts to servings,
 *      multiplies by units-per-serving, pluralizes the label.
 *      Format: "2 eggs <name>", "1 slice <name>".
 *
 *   3. **Canonical fallback** — render the raw unit. Format: "30g <name>",
 *      "1 ctn <name>", "2 svg <name>".
 *
 * Backend math (consume_product, mark_meal_done, food_logs, macro calc)
 * NEVER reads any of these display fields — canonical unit + quantity
 * remain the single source of truth.
 */
export type UnitSystem = 'metric' | 'imperial';

const GRAMS_PER_OUNCE = 28.3495231;

export function formatIngredientDisplay(args: {
  quantity: number;
  unit: 'container' | 'serving' | 'gram';
  productName: string;
  visualUnitLabel: string | null;
  visualUnitsPerServing: number | null;
  servingsPerContainer: number;
  displayByWeight?: boolean;
  netWeightG?: number | null;
  unitSystem?: UnitSystem;
}): string {
  const { productName } = args;
  const name = productName ?? '';
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
 * render as "1.0 eggs". The by-weight path also trims zeros — gram/oz
 * never pluralize.
 */
export function formatQuantityWithVisual(args: {
  quantity: number;
  unit: 'container' | 'serving' | 'gram';
  visualUnitLabel: string | null;
  visualUnitsPerServing: number | null;
  servingsPerContainer: number;
  canonicalDecimals?: number;
  displayByWeight?: boolean;
  netWeightG?: number | null;
  unitSystem?: UnitSystem;
}): string {
  const {
    quantity,
    unit,
    visualUnitLabel,
    visualUnitsPerServing,
    servingsPerContainer,
    canonicalDecimals,
    displayByWeight,
    netWeightG,
    unitSystem = 'imperial',
  } = args;

  // Mode 1: by-weight rendering — highest precedence. Requires net_weight_g
  // so we can convert canonical → grams. If the flag is set but
  // net_weight_g is missing, fall through to the next mode rather than
  // emitting a meaningless "0g" / "NaNg".
  if (displayByWeight && netWeightG != null && netWeightG > 0) {
    const grams = canonicalToGrams(quantity, unit, netWeightG, servingsPerContainer);
    if (unitSystem === 'imperial') {
      // Ounces typically show 1 decimal (per CLAUDE.md UI convention) —
      // 5.3oz reads cleaner than 5oz or 5.29oz.
      return `${(grams / GRAMS_PER_OUNCE).toFixed(1)}oz`;
    }
    // Grams as whole numbers — fractional grams aren't useful at the scale
    // of recipe ingredients (the smallest recipe portion is ~1g).
    return `${Math.round(grams)}g`;
  }

  // Mode 2: visual unit (eggs / slices / etc.).
  const visualSet =
    visualUnitLabel != null && visualUnitLabel !== '' && visualUnitsPerServing != null && visualUnitsPerServing > 0;
  if (visualSet && (unit === 'container' || unit === 'serving')) {
    const servings = unit === 'container' ? quantity * Math.max(servingsPerContainer, 0.001) : quantity;
    const displayQty = servings * (visualUnitsPerServing as number);
    const label = pluralize(visualUnitLabel as string, displayQty);
    return `${formatNumber(displayQty)} ${label}`;
  }

  // Mode 3: canonical fallback.
  return canonicalStr(quantity, unit, canonicalDecimals);
}

/**
 * Convert a canonical (quantity + unit) into grams using a product's
 * net_weight_g (per container) and servings_per_container.
 *
 * - container: quantity × net_weight_g
 * - serving:   quantity × (net_weight_g / servings_per_container)
 * - gram:      quantity (already grams)
 */
function canonicalToGrams(
  quantity: number,
  unit: 'container' | 'serving' | 'gram',
  netWeightG: number,
  servingsPerContainer: number,
): number {
  if (unit === 'gram') return quantity;
  if (unit === 'container') return quantity * netWeightG;
  // serving
  const spc = servingsPerContainer > 0 ? servingsPerContainer : 1;
  return quantity * (netWeightG / spc);
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
