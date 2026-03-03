import { IonSkeletonText } from '@ionic/react';

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div style={{ padding: '16px' }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ marginBottom: '12px' }}>
          <IonSkeletonText animated style={{ width: '100%', height: '20px' }} />
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div style={{ padding: '16px', border: '1px solid var(--ion-color-light)', borderRadius: '8px', marginBottom: '12px' }}>
      <IonSkeletonText animated style={{ width: '60%', height: '24px', marginBottom: '8px' }} />
      <IonSkeletonText animated style={{ width: '100%', height: '16px', marginBottom: '4px' }} />
      <IonSkeletonText animated style={{ width: '80%', height: '16px' }} />
    </div>
  );
}

export function MacroBarSkeleton() {
  return (
    <div style={{ display: 'flex', gap: '16px', padding: '16px' }}>
      {['Calories', 'Protein', 'Carbs', 'Fat'].map((label) => (
        <div key={label} style={{ flex: 1, textAlign: 'center' }}>
          <IonSkeletonText animated style={{ width: '100%', height: '12px', marginBottom: '4px' }} />
          <IonSkeletonText animated style={{ width: '60%', height: '20px', margin: '0 auto' }} />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div style={{ padding: '16px' }}>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
          {Array.from({ length: cols }, (_, c) => (
            <IonSkeletonText key={c} animated style={{ flex: 1, height: '20px' }} />
          ))}
        </div>
      ))}
    </div>
  );
}
