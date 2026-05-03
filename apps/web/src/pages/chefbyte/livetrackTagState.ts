export type LivetrackTagColor = 'red' | 'blue' | 'normal';

export interface LivetrackTagState {
  color: LivetrackTagColor;
  tooltip: string;
  label: string;
}

export interface LivetrackTagInputs {
  tare_weight_g: number | null;
  measured_full_at: string | null;
  net_weight_g?: number | null;
}

export function livetrackTagState(inputs: LivetrackTagInputs): LivetrackTagState {
  const tareSet = inputs.tare_weight_g !== null && inputs.tare_weight_g !== undefined;
  const fullSet = inputs.measured_full_at !== null && inputs.measured_full_at !== undefined;

  if (!tareSet) {
    return {
      color: 'red',
      label: 'LiveTrack',
      tooltip:
        'No tare measured yet — only relative weight changes are tracked. Place this product on the catch-all scale to capture tare automatically.',
    };
  }
  if (!fullSet) {
    const netMissing = inputs.net_weight_g === null || inputs.net_weight_g === undefined;
    return {
      color: 'blue',
      label: 'LiveTrack',
      tooltip: netMissing
        ? "Tare is estimated, not measured. Set the product's net weight (in product details), then place a fresh container on the catch-all to confirm calibration."
        : 'Tare is estimated, not measured. Place a fresh container on the catch-all scale to confirm and lock the calibration.',
    };
  }
  return {
    color: 'normal',
    label: 'LiveTrack',
    tooltip: 'Fully calibrated. Tare is measured and full mass confirmed.',
  };
}

export function livetrackTagClassNames(color: LivetrackTagColor): string {
  switch (color) {
    case 'red':
      return 'bg-red-50 text-red-800 border border-red-200';
    case 'blue':
      return 'bg-blue-50 text-blue-800 border border-blue-200';
    case 'normal':
      return 'bg-emerald-50 text-emerald-800 border border-emerald-200';
  }
}
