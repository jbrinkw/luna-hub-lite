import type { ReactNode } from 'react';

interface ModuleLayoutProps {
  children: ReactNode;
}

export function ModuleLayout({ children }: ModuleLayoutProps) {
  return <>{children}</>;
}
