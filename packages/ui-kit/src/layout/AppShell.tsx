import { IonApp } from '@ionic/react';
import type { ReactNode } from 'react';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return <IonApp>{children}</IonApp>;
}
