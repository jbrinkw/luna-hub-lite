interface MacroProgressBarProps {
  label: string;
  current: number;
  goal: number;
  color: string;
  unit?: string;
  testId?: string;
}

function pct(val: number, goal: number): number {
  if (goal <= 0) return 0;
  return Math.min(Math.round((val / goal) * 100), 100);
}

/**
 * Shared macro progress bar — label, current/goal text, and colored fill bar.
 * Replaces the identical pattern duplicated in MacroPage and HomePage.
 */
export function MacroProgressBar({ label, current, goal, color, unit, testId }: MacroProgressBarProps) {
  const percentage = pct(current, goal);
  const suffix = unit ? unit : '';

  return (
    <div data-testid={testId} style={{ marginBottom: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9em' }}>
        <span>{label}</span>
        <span>
          {current}
          {suffix} / {goal}
          {suffix} ({percentage}%)
        </span>
      </div>
      <div style={{ background: '#eee', borderRadius: '4px', height: '16px', overflow: 'hidden' }}>
        <div
          style={{
            width: `${percentage}%`,
            height: '100%',
            background: color,
            borderRadius: '4px',
          }}
        />
      </div>
    </div>
  );
}
