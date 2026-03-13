import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme, type Theme } from '@/shared/ThemeProvider';

const options: { value: Theme; icon: typeof Sun; label: string }[] = [
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'system', icon: Monitor, label: 'System' },
  { value: 'dark', icon: Moon, label: 'Dark' },
];

export function ThemeToggle() {
  const { preference, setTheme } = useTheme();

  return (
    <div className="inline-flex items-center rounded-lg border border-border bg-surface p-0.5 gap-0.5">
      {options.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          onClick={() => setTheme(value)}
          aria-label={`${label} theme`}
          aria-pressed={preference === value}
          className={[
            'inline-flex items-center justify-center rounded-md p-1.5 transition-colors',
            preference === value ? 'bg-surface-hover text-text' : 'text-text-tertiary hover:text-text-secondary',
          ].join(' ')}
        >
          <Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}
