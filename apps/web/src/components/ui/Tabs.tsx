import { Link } from 'react-router-dom';
import type { HTMLAttributes } from 'react';

export interface TabItem {
  label: string;
  value: string;
  href?: string;
  badge?: string;
}

export interface TabsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  items: TabItem[];
  activeValue: string;
  onChange?: (value: string) => void;
  accentColor?: string;
}

export function Tabs({ items, activeValue, onChange, accentColor: _, className, ...rest }: TabsProps) {
  return (
    <nav className={['flex gap-1', className].filter(Boolean).join(' ')} role="tablist" {...rest}>
      {items.map((item) => {
        const isActive = item.value === activeValue;
        const sharedClasses = [
          'inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
          isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50',
        ].join(' ');

        const badgeEl = item.badge ? (
          <span className="ml-1 inline-flex items-center rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
            {item.badge}
          </span>
        ) : null;

        if (item.href) {
          return (
            <Link key={item.value} to={item.href} role="tab" aria-selected={isActive} className={sharedClasses}>
              {item.label}
              {badgeEl}
            </Link>
          );
        }

        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange?.(item.value)}
            className={sharedClasses}
          >
            {item.label}
            {badgeEl}
          </button>
        );
      })}
    </nav>
  );
}
