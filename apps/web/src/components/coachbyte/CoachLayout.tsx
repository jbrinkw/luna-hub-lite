import type { ReactNode } from 'react';
import { IonPage, IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonButton } from '@ionic/react';
import { useAuth } from '@/shared/auth/AuthProvider';
import { ModuleSwitcher } from '../ModuleSwitcher';
import { CoachNav } from './CoachNav';

interface CoachLayoutProps {
  title: string;
  children: ReactNode;
}

export function CoachLayout({ children }: CoachLayoutProps) {
  const { signOut } = useAuth();

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>COACHBYTE</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={() => signOut()}>Logout</IonButton>
          </IonButtons>
        </IonToolbar>
        <IonToolbar>
          <CoachNav />
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
