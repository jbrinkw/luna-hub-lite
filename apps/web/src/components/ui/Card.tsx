import type { HTMLAttributes, ReactNode } from 'react';

/* ─── Card root ─── */

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function Card({ children, className, ...rest }: CardProps) {
  return (
    <div
      className={['bg-surface border border-border rounded-xl overflow-hidden', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </div>
  );
}

/* ─── CardHeader ─── */

export interface CardHeaderProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function CardHeader({ children, className, ...rest }: CardHeaderProps) {
  return (
    <div className={['px-5 py-4 border-b border-border', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </div>
  );
}

/* ─── CardTitle ─── */

export interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  children: ReactNode;
}

export function CardTitle({ children, className, ...rest }: CardTitleProps) {
  return (
    <h3 className={['text-lg font-semibold text-text', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </h3>
  );
}

/* ─── CardContent ─── */

export interface CardContentProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function CardContent({ children, className, ...rest }: CardContentProps) {
  return (
    <div className={['p-5', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </div>
  );
}

/* ─── CardFooter ─── */

export interface CardFooterProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function CardFooter({ children, className, ...rest }: CardFooterProps) {
  return (
    <div
      className={['px-5 py-4 border-t border-border bg-surface-sunken', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </div>
  );
}
