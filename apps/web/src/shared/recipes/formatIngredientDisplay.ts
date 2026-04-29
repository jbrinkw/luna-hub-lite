/**
 * Format an ingredient line for display in a recipe.
 *
 * If the visual pair (visual_unit_label + visual_quantity) is set, renders:
 *   "<visual_quantity> <visual_unit_label> <productName> (<canonical>)"
 * e.g. "1 slice Bacon (30g)"
 *
 * Otherwise renders the canonical amount:
 *   - gram:      "30g <productName>"
 *   - container: "1 ctn <productName>"
 *   - serving:   "2 svg <productName>"
 *
 * visual_unit_label and visual_quantity are display-only fields.
 * Macro and stock math always uses the canonical unit + quantity columns.
 */
export function formatIngredientDisplay(args: {
  quantity: number;
  unit: 'container' | 'serving' | 'gram';
  visual_quantity: number | null;
  visual_unit_label: string | null;
  productName: string;
}): string {
  const { quantity, unit, visual_quantity, visual_unit_label, productName } = args;
  const name = productName ?? '';

  if (visual_quantity != null && visual_unit_label != null) {
    // Visual pair is set — show friendly label with canonical in parens
    const visualQtyStr = formatNumber(visual_quantity);
    const canonical = canonicalStr(quantity, unit);
    return `${visualQtyStr} ${visual_unit_label} ${name} (${canonical})`;
  }

  // No visual pair — render canonical directly
  return `${canonicalStr(quantity, unit)} ${name}`;
}

/** Format a number: drop trailing zeros, keep up to 3 decimal places. */
function formatNumber(n: number): string {
  // Use toPrecision-style: show up to 3 significant decimals but trim zeros
  const fixed = n.toFixed(3);
  // Remove trailing zeros after decimal, and trailing dot
  return fixed.replace(/\.?0+$/, '');
}

/** Canonical unit abbreviation string, e.g. "30g", "1 ctn", "2 svg". */
function canonicalStr(quantity: number, unit: 'container' | 'serving' | 'gram'): string {
  const qStr = formatNumber(quantity);
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
