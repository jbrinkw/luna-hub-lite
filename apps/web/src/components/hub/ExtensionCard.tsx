import { useState } from 'react';
import { IonCard, IonCardHeader, IonCardTitle, IonCardContent, IonToggle, IonInput, IonButton, IonText, IonItem, IonLabel } from '@ionic/react';

interface ExtensionCardProps {
  extensionName: string;
  displayName: string;
  description: string;
  enabled: boolean;
  hasCredentials: boolean;
  credentialFields: { key: string; label: string }[];
  onToggle: (enabled: boolean) => void;
  onSaveCredentials: (credentials: Record<string, string>) => Promise<{ error?: string }>;
}

export function ExtensionCard({
  displayName,
  description,
  enabled,
  hasCredentials,
  credentialFields,
  onToggle,
  onSaveCredentials,
}: ExtensionCardProps) {
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSave = async () => {
    setError(null);
    setSuccess(false);

    // Validate required fields
    for (const field of credentialFields) {
      if (!credentials[field.key]?.trim()) {
        setError(`${field.label} is required`);
        return;
      }
    }

    setSaving(true);
    const result = await onSaveCredentials(credentials);
    setSaving(false);

    if (result.error) {
      setError(result.error);
    } else {
      setSuccess(true);
      setCredentials({});
    }
  };

  return (
    <IonCard>
      <IonCardHeader>
        <IonCardTitle>{displayName}</IonCardTitle>
      </IonCardHeader>
      <IonCardContent>
        <p>{description}</p>
        <IonItem>
          <IonLabel>Enabled</IonLabel>
          <IonToggle
            checked={enabled}
            onIonChange={(e) => onToggle(e.detail.checked)}
            aria-label={`Enable ${displayName}`}
          />
        </IonItem>
        {hasCredentials && (
          <IonText color="success"><p>Credentials configured</p></IonText>
        )}
        {enabled && (
          <div style={{ marginTop: '12px' }}>
            {credentialFields.map((field) => (
              <IonInput
                key={field.key}
                label={field.label}
                type="password"
                value={credentials[field.key] ?? ''}
                onIonInput={(e) =>
                  setCredentials((prev) => ({ ...prev, [field.key]: e.detail.value ?? '' }))
                }
              />
            ))}
            <IonButton onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save Credentials'}
            </IonButton>
            {error && <IonText color="danger"><p>{error}</p></IonText>}
            {success && <IonText color="success"><p>Credentials saved</p></IonText>}
          </div>
        )}
      </IonCardContent>
    </IonCard>
  );
}
