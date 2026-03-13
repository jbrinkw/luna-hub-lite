import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Toggle } from '@/components/ui/Toggle';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';

/** Credential field keys that represent URLs (not secrets) */
const URL_FIELD_KEYS = new Set(['obsidian_url', 'ha_url']);

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
    <Card className={['transition-all', enabled ? 'border-l-4 border-l-success' : 'opacity-60'].join(' ')}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{displayName}</CardTitle>
          <Toggle checked={enabled} onChange={onToggle} aria-label={`Enable ${displayName}`} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-text-secondary">{description}</p>

        {hasCredentials ? (
          <Badge variant="success">Credentials configured</Badge>
        ) : (
          <Badge variant="warning">Not configured</Badge>
        )}

        {enabled && (
          <div className="space-y-3 pt-2 border-t border-border-light">
            {credentialFields.map((field) => (
              <Input
                key={field.key}
                label={field.label}
                type={URL_FIELD_KEYS.has(field.key) ? 'text' : 'password'}
                value={credentials[field.key] ?? ''}
                onChange={(e) => setCredentials((prev) => ({ ...prev, [field.key]: e.target.value }))}
              />
            ))}
            <Button onClick={handleSave} loading={saving} size="sm">
              Save Credentials
            </Button>
            {error && <Alert variant="error">{error}</Alert>}
            {success && <Alert variant="success">Credentials saved</Alert>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
