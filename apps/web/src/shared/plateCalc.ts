export interface PlateConfig {
  barWeight: number;
  plates: Record<number, number>; // plate weight -> number of pairs available
}

export const DEFAULT_PLATE_CONFIG: PlateConfig = {
  barWeight: 45,
  plates: { 45: 2, 35: 1, 25: 1, 15: 1, 10: 1 },
};

/**
 * Calculate plates needed per side for a target weight.
 * Returns the achievable weight and plates for one side (sorted descending).
 */
export function calculatePlates(
  targetWeight: number,
  config: PlateConfig = DEFAULT_PLATE_CONFIG,
): { weight: number; plates: number[] } {
  if (targetWeight <= config.barWeight) {
    return { weight: targetWeight, plates: [] };
  }

  const perSide = (targetWeight - config.barWeight) / 2;
  const plateWeights = Object.keys(config.plates)
    .map(Number)
    .sort((a, b) => b - a);

  const result: number[] = [];
  let remaining = perSide;

  for (const pw of plateWeights) {
    const available = config.plates[pw];
    const count = Math.min(available, Math.floor(remaining / pw));
    for (let i = 0; i < count; i++) {
      result.push(pw);
    }
    remaining -= count * pw;
  }

  const actualWeight = config.barWeight + result.reduce((s, p) => s + p, 0) * 2;
  return { weight: actualWeight, plates: result };
}

/**
 * Format weight with plate breakdown. E.g., "185 (45,25)" or "bar" for bar weight.
 */
export function formatWeightWithPlates(weight: number, config: PlateConfig = DEFAULT_PLATE_CONFIG): string {
  if (weight <= 0) return '0';
  if (weight <= config.barWeight) return weight === config.barWeight ? 'bar' : `${weight}`;

  const { plates } = calculatePlates(weight, config);
  if (plates.length === 0) return `${weight}`;
  return `${weight} (${plates.join(',')})`;
}
