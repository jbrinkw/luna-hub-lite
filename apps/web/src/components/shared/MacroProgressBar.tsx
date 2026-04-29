interface MacroProgressBarProps {
  label: string;
  current: number;
  goal: number;
  color: string;
  unit?: string;
  testId?: string;
  /** CSS height class for the bar track, e.g. 'h-5'. Defaults to 'h-4'. */
  barHeight?: string;
}

/**
 * Raw percentage (no cap). Negative goal returns 0.
 *
 * Exported for the over-100% test cases — the rendered bar uses both the
 * raw and the capped (display-width) value.
 */
export function rawPct(val: number, goal: number): number {
  if (goal <= 0) return 0;
  return Math.round((val / goal) * 100);
}

function pct(val: number, goal: number): number {
  if (goal <= 0) return 0;
  return Math.min(Math.round((val / goal) * 100), 100);
}

/**
 * Shared macro progress bar — label, current/goal text, and colored fill bar.
 *
 * Replaces the identical pattern duplicated in MacroPage and HomePage.
 *
 * Over-100% rendering (UX_AUDIT_CHEFBYTE_USE finding): when consumption
 * exceeds the goal, the bar fills 100% in the macro color and an "+N%"
 * overflow badge appears on the right edge in red. A capped progress bar
 * makes 105% indistinguishable from 100% — disciplined macro-trackers
 * specifically need the over-goal signal to be visually loud.
 */
export function MacroProgressBar({
  label,
  current,
  goal,
  color,
  unit,
  testId,
  barHeight = 'h-4',
}: MacroProgressBarProps) {
  const percentage = pct(current, goal); // capped 0-100, drives bar width
  const raw = rawPct(current, goal); // uncapped, drives the overflow chip
  const overflow = Math.max(0, raw - 100);
  const suffix = unit ?? '';

  return (
    <div data-testid={testId} className="mb-2">
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span>
          {current}
          {suffix} / {goal}
          {suffix} ({raw}%)
          {overflow > 0 && (
            <span
              data-testid={testId ? `${testId}-overflow` : undefined}
              className="ml-1.5 inline-flex items-center rounded-full bg-danger px-1.5 py-0 text-[10px] font-bold text-white"
              aria-label={`${overflow}% over goal`}
            >
              +{overflow}%
            </span>
          )}
        </span>
      </div>
      <div className={`relative bg-border rounded ${barHeight} overflow-hidden`}>
        <div
          className="h-full rounded"
          style={{
            width: `${percentage}%`,
            background: color,
          }}
        />
        {overflow > 0 && (
          <div
            data-testid={testId ? `${testId}-overflow-bar` : undefined}
            className="absolute inset-y-0 right-0 w-1 bg-danger"
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  );
}
