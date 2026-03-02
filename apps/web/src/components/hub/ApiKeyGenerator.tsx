import { useState } from 'react';
import { IonButton, IonItem, IonLabel, IonList, IonText, IonInput, IonSpinner } from '@ionic/react';

interface ApiKey {
  id: string;
  label: string | null;
  created_at: string;
}

interface ApiKeyGeneratorProps {
  activeKeys: ApiKey[];
  loading?: boolean;
  error?: string | null;
  onGenerate: (label: string) => Promise<string | null>;
  onRevoke: (keyId: string) => void;
}

export function ApiKeyGenerator({ activeKeys, loading, error, onGenerate, onRevoke }: ApiKeyGeneratorProps) {
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [label, setLabel] = useState('');
  const [copied, setCopied] = useState(false);

  const handleGenerate = async () => {
    setGenerating(true);
    setCopied(false);
    const key = await onGenerate(label || 'Untitled');
    setGeneratedKey(key);
    setGenerating(false);
    setLabel('');
  };

  const handleCopy = async () => {
    if (generatedKey) {
      await navigator.clipboard.writeText(generatedKey);
      setCopied(true);
    }
  };

  const handleDismiss = () => {
    setGeneratedKey(null);
    setCopied(false);
  };

  return (
    <div>
      <h3>API Keys</h3>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '16px' }}>
        <IonInput
          label="Key label"
          value={label}
          onIonInput={(e) => setLabel(e.detail.value ?? '')}
          placeholder="My API Key"
        />
        <IonButton onClick={handleGenerate} disabled={generating || loading}>
          {generating ? <IonSpinner /> : 'Generate'}
        </IonButton>
      </div>

      {error && <IonText color="danger"><p>{error}</p></IonText>}

      {generatedKey && (
        <div data-testid="key-display" style={{ padding: '12px', background: '#f0f0f0', borderRadius: '8px', marginBottom: '16px' }}>
          <p><strong>Your API key (shown once):</strong></p>
          <code data-testid="key-plaintext">{generatedKey}</code>
          <div style={{ marginTop: '8px', display: 'flex', gap: '8px' }}>
            <IonButton fill="outline" onClick={handleCopy}>
              {copied ? 'Copied!' : 'Copy'}
            </IonButton>
            <IonButton fill="clear" onClick={handleDismiss}>
              Dismiss
            </IonButton>
          </div>
        </div>
      )}

      <IonList>
        {activeKeys.map((key) => (
          <IonItem key={key.id}>
            <IonLabel>
              <h2>{key.label || 'Untitled'}</h2>
              <p>Created {new Date(key.created_at).toLocaleDateString()}</p>
            </IonLabel>
            <IonButton fill="clear" color="danger" onClick={() => onRevoke(key.id)}>
              Revoke
            </IonButton>
          </IonItem>
        ))}
        {activeKeys.length === 0 && (
          <IonItem>
            <IonLabel color="medium">No active API keys</IonLabel>
          </IonItem>
        )}
      </IonList>
    </div>
  );
}
