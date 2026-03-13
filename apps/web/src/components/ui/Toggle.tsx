import type { HTMLAttributes } from 'react';

export interface ToggleProps extends Omit<HTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, disabled = false, className, ...rest }: ToggleProps) {
  return (
    <label
      className={[
        'inline-flex items-center gap-3',
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={[
          'relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent',
          'transition-colors duration-200 ease-in-out',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
          checked ? 'bg-primary' : 'bg-border-strong',
        ].join(' ')}
        {...rest}
      >
        <span
          aria-hidden="true"
          className={[
            'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm ring-0',
            'transition-transform duration-200 ease-in-out',
            checked ? 'translate-x-5' : 'translate-x-0',
          ].join(' ')}
        />
      </button>
      {label && <span className="text-sm font-medium text-text select-none">{label}</span>}
    </label>
  );
}
