import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { OfflineIndicator } from '../../components/OfflineIndicator';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const { loading } = useAuth();

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-slate-50">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-blue-600" />
      </div>
    );
  }

  return (
    <>
      <OfflineIndicator />
      {children}
    </>
  );
}
