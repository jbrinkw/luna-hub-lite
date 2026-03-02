import type { ReactNode } from 'react';
import { IonPage, IonContent, IonGrid, IonRow, IonCol } from '@ionic/react';
import { HubHeader } from './HubHeader';
import { SideNav } from './SideNav';
import { ModuleSwitcher } from '../ModuleSwitcher';

interface HubLayoutProps {
  title: string;
  children: ReactNode;
}

export function HubLayout({ title, children }: HubLayoutProps) {
  return (
    <IonPage>
      <HubHeader title={title} />
      <IonContent>
        <ModuleSwitcher />
        <IonGrid>
          <IonRow>
            <IonCol size="12" sizeMd="3">
              <SideNav />
            </IonCol>
            <IonCol size="12" sizeMd="9">
              {children}
            </IonCol>
          </IonRow>
        </IonGrid>
      </IonContent>
    </IonPage>
  );
}
