import { Routes, Route } from 'react-router-dom';
import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar, IonButton, IonButtons } from '@ionic/react';
import { useAuth } from '@/shared/auth/AuthProvider';

function HubHome() {
  const { signOut } = useAuth();

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Luna Hub</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={() => signOut()}>Logout</IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        <p>Account management, MCP config, extensions</p>
      </IonContent>
    </IonPage>
  );
}

export function HubRoutes() {
  return (
    <Routes>
      <Route index element={<HubHome />} />
    </Routes>
  );
}
