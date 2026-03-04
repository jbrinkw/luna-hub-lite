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

  if (activationsLoading) return null;

  if (!activations[appName]) {
    return <Navigate to="/hub/apps" replace />;
  }

  return <>{children}</>;
}
