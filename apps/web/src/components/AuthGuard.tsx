import { Navigate } from 'react-router-dom';
import { useAuth } from '@/shared/auth/AuthProvider';
import type { ReactNode } from 'react';

export function AuthGuard({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <h1 className="text-2xl font-bold text-text">Luna Hub</h1>
        <div
          className="h-8 w-8 animate-spin rounded-full border-4 border-border-strong border-t-primary"
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
