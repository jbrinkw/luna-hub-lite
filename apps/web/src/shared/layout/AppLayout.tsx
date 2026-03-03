import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { IonLoading } from '@ionic/react';
import { OfflineIndicator } from '../../components/OfflineIndicator';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const { loading } = useAuth();

  if (loading) {
    return <IonLoading isOpen message="Loading..." />;
  }

  return (
    <>
      <OfflineIndicator />
      {children}
    </>
  );
}
