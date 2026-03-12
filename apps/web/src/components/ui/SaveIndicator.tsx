import { Check } from 'lucide-react';

interface SaveIndicatorProps {
  show: boolean;
}

export function SaveIndicator({ show }: SaveIndicatorProps) {
  if (!show) return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-emerald-600 animate-fade-in"
      data-testid="save-indicator"
    >
      <Check className="h-3 w-3" />
      Saved
    </span>
  );
}
