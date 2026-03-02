import { Routes, Route } from 'react-router-dom';
import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';

function ChefHome() {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>ChefByte</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        <p>AI-powered nutrition lab</p>
      </IonContent>
    </IonPage>
  );
}

export function ChefRoutes() {
  return (
    <Routes>
      <Route index element={<ChefHome />} />
    </Routes>
  );
}
