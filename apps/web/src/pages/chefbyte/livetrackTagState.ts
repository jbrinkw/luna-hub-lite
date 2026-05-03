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
      tooltip: 'No tare — tracking relative changes only. Place this on the catch-all to capture tare automatically.',
    };
  }
  if (!fullSet) {
    const missing: string[] = ['measured-full confirmation'];
    if (inputs.net_weight_g === null || inputs.net_weight_g === undefined) {
      missing.unshift('net weight not set (required for measured-full detection)');
    }
    return {
      color: 'blue',
      label: 'LiveTrack',
      tooltip: `Tare is an AI estimate. Missing: ${missing.join('; ')}. Confirm a full placement to lock it.`,
    };
  }
  return {
    color: 'normal',
    label: 'LiveTrack',
    tooltip: 'Fully calibrated — tare measured and full mass confirmed.',
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
