import { IonContent, IonPage } from '@ionic/react';
import type { ReactNode } from 'react';

interface ModuleLayoutProps {
  children: ReactNode;
}

export function ModuleLayout({ children }: ModuleLayoutProps) {
  return (
    <IonPage>
      <IonContent>{children}</IonContent>
    </IonPage>
  );
}
