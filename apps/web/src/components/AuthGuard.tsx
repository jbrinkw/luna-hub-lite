import { Navigate } from 'react-router-dom';
import { useAuth } from '@/shared/auth/AuthProvider';
import type { ReactNode } from 'react';

export function AuthGuard({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div
          className="h-8 w-8 animate-spin rounded-full border-4 border-slate-300 border-t-blue-600"
          aria-label="loading"
        />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
