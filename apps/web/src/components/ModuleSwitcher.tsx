import { useLocation, useNavigate } from 'react-router-dom';
import { IonSegment, IonSegmentButton, IonLabel } from '@ionic/react';
import { useAppContext } from '../shared/AppProvider';

const allModules = [
  { label: 'Hub', path: '/hub', appName: null as string | null },
  { label: 'CoachByte', path: '/coach', appName: 'coachbyte' },
  { label: 'ChefByte', path: '/chef', appName: 'chefbyte' },
];

export function ModuleSwitcher() {
  const location = useLocation();
  const navigate = useNavigate();
  const { activations } = useAppContext();

  const modules = allModules.filter(
    (m) => m.appName === null || activations[m.appName],
  );

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
