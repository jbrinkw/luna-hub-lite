import { Routes, Route } from 'react-router-dom';
import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';

function HubHome() {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Luna Hub</IonTitle>
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
