import { useState } from 'react';
import { IonCard, IonCardHeader, IonCardTitle, IonCardContent, IonButton, IonChip, IonAlert } from '@ionic/react';

interface AppActivationCardProps {
  appName: string;
  displayName: string;
  active: boolean;
  loading?: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
}

export function AppActivationCard({
  displayName,
  active,
  loading,
  onActivate,
  onDeactivate,
}: AppActivationCardProps) {
  const [showConfirm, setShowConfirm] = useState(false);

  return (
    <IonCard>
      <IonCardHeader>
        <IonCardTitle>{displayName}</IonCardTitle>
      </IonCardHeader>
      <IonCardContent>
        <IonChip color={active ? 'success' : 'medium'}>
          {active ? 'Active' : 'Inactive'}
        </IonChip>
        {active ? (
          <IonButton color="danger" fill="outline" onClick={() => setShowConfirm(true)} disabled={loading}>
            Deactivate
          </IonButton>
        ) : (
          <IonButton color="primary" onClick={onActivate} disabled={loading}>
            Activate
          </IonButton>
        )}
        <IonAlert
          isOpen={showConfirm}
          header={`Deactivate ${displayName}?`}
          message={`Are you sure you want to deactivate ${displayName}?`}
          buttons={[
            { text: 'Cancel', role: 'cancel', handler: () => setShowConfirm(false) },
            {
              text: 'Confirm',
              role: 'destructive',
              handler: () => {
                setShowConfirm(false);
                onDeactivate();
              },
            },
          ]}
          onDidDismiss={() => setShowConfirm(false)}
        />
      </IonCardContent>
    </IonCard>
  );
}
