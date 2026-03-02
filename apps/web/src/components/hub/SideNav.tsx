import { useLocation, useNavigate } from 'react-router-dom';
import { IonList, IonItem, IonLabel, IonIcon } from '@ionic/react';
import { personOutline, appsOutline, constructOutline, extensionPuzzleOutline, keyOutline } from 'ionicons/icons';

const navItems = [
  { label: 'Account', path: '/hub/account', icon: personOutline },
  { label: 'Apps', path: '/hub/apps', icon: appsOutline },
  { label: 'Tools', path: '/hub/tools', icon: constructOutline },
  { label: 'Extensions', path: '/hub/extensions', icon: extensionPuzzleOutline },
  { label: 'MCP Settings', path: '/hub/mcp', icon: keyOutline },
];

export function SideNav() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <nav aria-label="Hub navigation">
      <IonList lines="none">
        {navItems.map((item) => {
          const active = location.pathname.startsWith(item.path);
          return (
            <IonItem
              key={item.path}
              button
              onClick={() => navigate(item.path)}
              color={active ? 'primary' : undefined}
              aria-current={active ? 'page' : undefined}
            >
              <IonIcon icon={item.icon} slot="start" />
              <IonLabel>{item.label}</IonLabel>
            </IonItem>
          );
        })}
      </IonList>
    </nav>
  );
}
