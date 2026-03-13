import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAppContext } from '../shared/AppProvider';

interface ActivationGuardProps {
  appName: string;
  children: ReactNode;
}

/** Redirects to /hub/apps if the given app is not activated. */
export function ActivationGuard({ appName, children }: ActivationGuardProps) {
  const { activations, activationsLoading } = useAppContext();

  if (activationsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="h-8 w-8 border-4 border-border border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (!activations[appName]) {
    return <Navigate to="/hub/apps" replace />;
  }

  return <>{children}</>;
}
