import type { HTMLAttributes } from 'react';

export interface ProgressBarProps extends HTMLAttributes<HTMLDivElement> {
  value: number;
  max: number;
  color?: string;
  label?: string;
  sublabel?: string;
  showPercentage?: boolean;
  secondaryValue?: number;
  secondaryColor?: string;
}

export function ProgressBar({
  value,
  max,
  color = 'bg-blue-600',
  label,
  sublabel,
  showPercentage = false,
  secondaryValue,
  secondaryColor = 'bg-blue-300',
  className,
  ...rest
}: ProgressBarProps) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const secondaryPct = secondaryValue != null && max > 0 ? Math.min((secondaryValue / max) * 100, 100) : 0;

  return (
    <div className={['w-full', className].filter(Boolean).join(' ')} {...rest}>
      {/* Label row */}
      {(label || showPercentage) && (
        <div className="flex items-baseline justify-between mb-1.5">
          <div className="flex items-baseline gap-2">
            {label && <span className="text-sm font-medium text-slate-700">{label}</span>}
            {sublabel && <span className="text-xs text-slate-500">{sublabel}</span>}
          </div>
          {showPercentage && (
            <span className="text-xs font-medium text-slate-500 tabular-nums">{Math.round(pct)}%</span>
          )}
        </div>
      )}

      {/* Bar */}
      <div className="relative h-2 w-full rounded-full bg-slate-100 overflow-hidden">
        {/* Secondary fill (planned) — rendered behind primary */}
        {secondaryValue != null && secondaryPct > 0 && (
          <div
            className={['absolute inset-y-0 left-0 rounded-full transition-all duration-300', secondaryColor].join(' ')}
            style={{ width: `${secondaryPct}%` }}
          />
        )}
        {/* Primary fill */}
        {pct > 0 && (
          <div
            className={['absolute inset-y-0 left-0 rounded-full transition-all duration-300', color].join(' ')}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  );
}
