import type { ReactNode } from 'react';
import { IonPage, IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonButton } from '@ionic/react';
import { useAuth } from '@/shared/auth/AuthProvider';
import { ModuleSwitcher } from '../ModuleSwitcher';
import { ChefNav } from './ChefNav';

interface ChefLayoutProps {
  title: string;
  children: ReactNode;
}

export function ChefLayout({ children }: ChefLayoutProps) {
  const { signOut } = useAuth();

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>CHEFBYTE</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={() => signOut()}>Logout</IonButton>
          </IonButtons>
        </IonToolbar>
        <IonToolbar>
          <ChefNav />
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <ModuleSwitcher />
        <div style={{ padding: '16px' }}>
          {children}
        </div>
      </IonContent>
    </IonPage>
  );
}
