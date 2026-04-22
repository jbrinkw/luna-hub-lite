import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Alert } from '@/components/ui/Alert';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Copy, Check, Key, Trash2 } from 'lucide-react';

interface ApiKey {
  id: string;
  label: string | null;
  created_at: string;
  /**
   * Timestamp of the last successful auth with this key. Updated by the
   * MCP worker via hub.bump_api_key_used_admin on every auth. Null means
   * "never used" (either freshly created or predates the tracking
   * migration).
   */
  last_used_at: string | null;
}

interface ApiKeyGeneratorProps {
  activeKeys: ApiKey[];
  loading?: boolean;
  error?: string | null;
  onGenerate: (label: string) => Promise<string | null>;
  onRevoke: (keyId: string) => void;
  /**
   * Revokes EVERY non-revoked key for the current user in one RPC. Distinct
   * from onRevoke(keyId) — fires the SECURITY DEFINER "revoke all" path so
   * the UI can expose a one-click button. Gated by a confirm dialog since
   * it's destructive.
   */
  onRevokeAll?: () => void;
}

/** Format a last_used_at timestamp as a short relative string. */
function formatLastUsed(iso: string | null): string {
  if (!iso) return 'never used';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'never used';
  const deltaSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (deltaSec < 60) return `used ${deltaSec}s ago`;
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `used ${deltaMin}m ago`;
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 24) return `used ${deltaHr}h ago`;
  const deltaDay = Math.floor(deltaHr / 24);
  return `used ${deltaDay}d ago`;
}

export function ApiKeyGenerator({
  activeKeys,
  loading,
  error,
  onGenerate,
  onRevoke,
  onRevokeAll,
}: ApiKeyGeneratorProps) {
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [label, setLabel] = useState('');
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);

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

  const handleRevokeClick = (keyId: string) => {
    setRevokeTarget(keyId);
  };

  const handleRevokeConfirm = () => {
    if (revokeTarget) {
      onRevoke(revokeTarget);
      setRevokeTarget(null);
    }
  };

  const handleRevokeCancel = () => {
    setRevokeTarget(null);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>API Keys</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-3 items-end">
          <div className="flex-1">
            <Input
              label="Key label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="My API Key"
            />
          </div>
          <Button onClick={handleGenerate} disabled={generating || loading} loading={generating}>
            Generate
          </Button>
        </div>

        {error && <Alert variant="error">{error}</Alert>}

        {generatedKey && (
          <div data-testid="key-display" className="bg-surface-sunken border border-border rounded-lg p-4 space-y-3">
            <p className="text-sm font-medium text-text">Your API key (shown once):</p>
            <code
              data-testid="key-plaintext"
              className="block text-sm bg-surface border border-border rounded px-3 py-2 break-all"
            >
              {generatedKey}
            </code>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={handleCopy}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? 'Copied!' : 'Copy'}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleDismiss}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {activeKeys.length > 0 && onRevokeAll && (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRevokeAllOpen(true)}
              data-testid="revoke-all-keys"
              className="text-danger hover:text-danger-hover hover:bg-danger-subtle"
            >
              <Trash2 className="h-4 w-4" />
              Revoke all ({activeKeys.length})
            </Button>
          </div>
        )}

        <div className="divide-y divide-border-light border border-border rounded-lg overflow-hidden">
          {activeKeys.map((key) => (
            <div key={key.id} className="flex items-center justify-between px-4 py-3 bg-surface">
              <div className="flex items-center gap-3 min-w-0">
                <Key className="h-4 w-4 text-text-tertiary shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text truncate">{key.label || 'Untitled'}</p>
                  <p className="text-xs text-text-secondary">
                    Created {new Date(key.created_at).toLocaleDateString()}
                    <span className="mx-1.5 text-text-disabled">·</span>
                    <span data-testid={`key-last-used-${key.id}`}>{formatLastUsed(key.last_used_at)}</span>
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleRevokeClick(key.id)}
                className="text-danger hover:text-danger-hover hover:bg-danger-subtle"
              >
                <Trash2 className="h-4 w-4" />
                Revoke
              </Button>
            </div>
          ))}
          {activeKeys.length === 0 && (
            <div className="px-4 py-8 text-center">
              <Key className="h-8 w-8 text-text-disabled mx-auto mb-2" />
              <p className="text-sm text-text-secondary">No API keys yet. Generate one to connect MCP clients.</p>
            </div>
          )}
        </div>
      </CardContent>

      <ConfirmModal
        open={revokeTarget !== null}
        onConfirm={handleRevokeConfirm}
        onCancel={handleRevokeCancel}
        title="Revoke API Key"
        message="This will permanently revoke this API key. Any integrations using it will stop working."
        confirmLabel="Revoke"
        confirmVariant="danger"
      />

      <ConfirmModal
        open={revokeAllOpen}
        onConfirm={() => {
          onRevokeAll?.();
          setRevokeAllOpen(false);
        }}
        onCancel={() => setRevokeAllOpen(false)}
        title="Revoke all API keys"
        message={`This will revoke all ${activeKeys.length} active key${activeKeys.length === 1 ? '' : 's'}. Every integration will stop working until new keys are generated.`}
        confirmLabel="Revoke all"
        confirmVariant="danger"
      />
    </Card>
  );
}
