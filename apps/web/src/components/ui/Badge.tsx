import type { HTMLAttributes, ReactNode } from 'react';

const variantClasses = {
  default: 'bg-surface-hover text-text-secondary',
  success: 'bg-success-subtle text-success-text',
  warning: 'bg-warning-subtle text-warning-text',
  danger: 'bg-danger-subtle text-danger-text',
  info: 'bg-info-subtle text-info-text',
} as const;

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: keyof typeof variantClasses;
  children: ReactNode;
}

export function Badge({ variant = 'default', children, className, ...rest }: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium',
        variantClasses[variant],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </span>
  );
}
