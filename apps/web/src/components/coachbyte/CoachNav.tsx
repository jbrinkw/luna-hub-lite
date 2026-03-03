import { useLocation, useNavigate } from 'react-router-dom';
import { IonSegment, IonSegmentButton, IonLabel } from '@ionic/react';

const tabs = [
  { label: 'Today', path: '/coach' },
  { label: 'History', path: '/coach/history' },
  { label: 'Split', path: '/coach/split' },
  { label: 'PRs', path: '/coach/prs' },
  { label: 'Settings', path: '/coach/settings' },
];

export function CoachNav() {
  const location = useLocation();
  const navigate = useNavigate();

  // Match exact for index, startsWith for others
  const current =
    location.pathname === '/coach'
      ? '/coach'
      : tabs.find((t) => t.path !== '/coach' && location.pathname.startsWith(t.path))?.path ?? '/coach';

  return (
    <nav aria-label="CoachByte navigation">
      <IonSegment
        value={current}
        onIonChange={(e) => {
          const val = e.detail.value as string;
          if (val && val !== current) navigate(val);
        }}
      >
        {tabs.map((t) => (
          <IonSegmentButton key={t.path} value={t.path}>
            <IonLabel>{t.label}</IonLabel>
          </IonSegmentButton>
        ))}
      </IonSegment>
    </nav>
  );
}
