import { IonText } from '@ionic/react';
import { useAppContext } from '../shared/AppProvider';

export function OfflineIndicator() {
  const { online, lastSynced } = useAppContext();

  if (online) return null;

  const syncedStr = lastSynced
    ? `Last synced: ${lastSynced.toLocaleTimeString()}`
    : 'Never synced';

  return (
    <div
      style={{
        background: 'var(--ion-color-warning)',
        color: 'var(--ion-color-warning-contrast)',
        padding: '8px 16px',
        textAlign: 'center',
        fontSize: '14px',
      }}
    >
      <IonText>
        <strong>No connection</strong> — {syncedStr}
      </IonText>
    </div>
  );
}
