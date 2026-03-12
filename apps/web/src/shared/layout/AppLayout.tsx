import type { ReactNode } from 'react';
import { OfflineIndicator } from '../../components/OfflineIndicator';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  return (
    <>
      <OfflineIndicator />
      {children}
    </>
  );
}
