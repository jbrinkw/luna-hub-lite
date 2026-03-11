import type { HTMLAttributes } from 'react';

/* ─── Base Skeleton ─── */

export type SkeletonProps = HTMLAttributes<HTMLDivElement>;

export function Skeleton({ className, ...rest }: SkeletonProps) {
  return <div className={['animate-pulse bg-slate-200 rounded', className].filter(Boolean).join(' ')} {...rest} />;
}

/* ─── ListSkeleton ─── */

export interface ListSkeletonProps extends HTMLAttributes<HTMLDivElement> {
  count?: number;
}

export function ListSkeleton({ count = 5, className, ...rest }: ListSkeletonProps) {
  return (
    <div className={['space-y-3', className].filter(Boolean).join(' ')} {...rest}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-10 w-10 rounded-lg shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─── CardSkeleton ─── */

export type CardSkeletonProps = HTMLAttributes<HTMLDivElement>;

export function CardSkeleton({ className, ...rest }: CardSkeletonProps) {
  return (
    <div
      className={['bg-white border border-slate-200 rounded-xl overflow-hidden p-5 space-y-4', className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      <Skeleton className="h-5 w-1/3" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  );
}

/* ─── MacroBarSkeleton ─── */

export type MacroBarSkeletonProps = HTMLAttributes<HTMLDivElement>;

export function MacroBarSkeleton({ className, ...rest }: MacroBarSkeletonProps) {
  return (
    <div className={['space-y-3', className].filter(Boolean).join(' ')} {...rest}>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="space-y-1.5">
          <div className="flex justify-between">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-12" />
          </div>
          <Skeleton className="h-2 w-full rounded-full" />
        </div>
      ))}
    </div>
  );
}

/* ─── TableSkeleton ─── */

export interface TableSkeletonProps extends HTMLAttributes<HTMLDivElement> {
  rows?: number;
  cols?: number;
}

export function TableSkeleton({ rows = 5, cols = 4, className, ...rest }: TableSkeletonProps) {
  return (
    <div className={['space-y-2', className].filter(Boolean).join(' ')} {...rest}>
      {/* Header row */}
      <div className="flex gap-4 pb-2 border-b border-slate-200">
        {Array.from({ length: cols }, (_, i) => (
          <Skeleton key={i} className="h-4 flex-1" />
        ))}
      </div>
      {/* Body rows */}
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 py-1">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}
