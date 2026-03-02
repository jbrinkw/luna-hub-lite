import { IonHeader, IonToolbar, IonTitle, IonButtons, IonButton } from '@ionic/react';
import { useAuth } from '@/shared/auth/AuthProvider';

interface HubHeaderProps {
  title: string;
}

export function HubHeader({ title }: HubHeaderProps) {
  const { signOut } = useAuth();

  return (
    <IonHeader>
      <IonToolbar>
        <IonTitle>{title}</IonTitle>
        <IonButtons slot="end">
          <IonButton onClick={() => signOut()}>Logout</IonButton>
        </IonButtons>
      </IonToolbar>
    </IonHeader>
  );
}
