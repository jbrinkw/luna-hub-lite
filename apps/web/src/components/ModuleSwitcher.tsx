import { useLocation, useNavigate } from 'react-router-dom';
import { IonSegment, IonSegmentButton, IonLabel } from '@ionic/react';

const modules = [
  { label: 'Hub', path: '/hub' },
  { label: 'CoachByte', path: '/coach' },
  { label: 'ChefByte', path: '/chef' },
];

export function ModuleSwitcher() {
  const location = useLocation();
  const navigate = useNavigate();

  const current = modules.find((m) => location.pathname.startsWith(m.path))?.path ?? '/hub';

  return (
    <IonSegment
      value={current}
      onIonChange={(e) => {
        const val = e.detail.value as string;
        if (val && val !== current) navigate(val);
      }}
    >
      {modules.map((m) => (
        <IonSegmentButton key={m.path} value={m.path}>
          <IonLabel>{m.label}</IonLabel>
        </IonSegmentButton>
      ))}
    </IonSegment>
  );
}
