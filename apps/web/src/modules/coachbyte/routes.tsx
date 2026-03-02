import { Routes, Route } from 'react-router-dom';
import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';

function CoachHome() {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>CoachByte</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        <p>Strength training copilot</p>
      </IonContent>
    </IonPage>
  );
}

export function CoachRoutes() {
  return (
    <Routes>
      <Route index element={<CoachHome />} />
    </Routes>
  );
}
