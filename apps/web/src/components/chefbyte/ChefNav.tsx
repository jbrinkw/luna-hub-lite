import { useLocation, useNavigate } from 'react-router-dom';
import { IonSegment, IonSegmentButton, IonLabel } from '@ionic/react';

const tabs = [
  { label: 'Scanner', path: '/chef' },
  { label: 'Home', path: '/chef/home' },
  { label: 'Inventory', path: '/chef/inventory' },
  { label: 'Shopping', path: '/chef/shopping' },
  { label: 'Meal Plan', path: '/chef/meal-plan' },
  { label: 'Recipes', path: '/chef/recipes' },
  { label: 'Macros', path: '/chef/macros' },
  { label: 'Walmart', path: '/chef/walmart' },
  { label: 'Settings', path: '/chef/settings' },
];

export function ChefNav() {
  const location = useLocation();
  const navigate = useNavigate();

  // Match exact for index, startsWith for others
  const current =
    location.pathname === '/chef'
      ? '/chef'
      : tabs.find((t) => t.path !== '/chef' && location.pathname.startsWith(t.path))?.path ?? '/chef';

  return (
    <nav aria-label="ChefByte navigation">
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
