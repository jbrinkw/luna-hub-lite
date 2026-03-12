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

function pct(val: number, goal: number): number {
  if (goal <= 0) return 0;
  return Math.min(Math.round((val / goal) * 100), 100);
}

/**
 * Shared macro progress bar — label, current/goal text, and colored fill bar.
 * Replaces the identical pattern duplicated in MacroPage and HomePage.
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
  const percentage = pct(current, goal);
  const suffix = unit ? unit : '';

  return (
    <div data-testid={testId} className="mb-2">
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span>
          {current}
          {suffix} / {goal}
          {suffix} ({percentage}%)
        </span>
      </div>
      <div className={`bg-slate-200 rounded ${barHeight} overflow-hidden`}>
        <div
          className="h-full rounded"
          style={{
            width: `${percentage}%`,
            background: color,
          }}
        />
      </div>
    </div>
  );
}
