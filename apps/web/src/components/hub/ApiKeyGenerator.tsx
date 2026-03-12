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
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);

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
          <div data-testid="key-display" className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-3">
            <p className="text-sm font-medium text-slate-700">Your API key (shown once):</p>
            <code
              data-testid="key-plaintext"
              className="block text-sm bg-white border border-slate-200 rounded px-3 py-2 break-all"
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

        <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
          {activeKeys.map((key) => (
            <div key={key.id} className="flex items-center justify-between px-4 py-3 bg-white">
              <div className="flex items-center gap-3 min-w-0">
                <Key className="h-4 w-4 text-slate-400 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900 truncate">{key.label || 'Untitled'}</p>
                  <p className="text-xs text-slate-500">Created {new Date(key.created_at).toLocaleDateString()}</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleRevokeClick(key.id)}
                className="text-red-600 hover:text-red-700 hover:bg-red-50"
              >
                <Trash2 className="h-4 w-4" />
                Revoke
              </Button>
            </div>
          ))}
          {activeKeys.length === 0 && (
            <div className="px-4 py-8 text-center">
              <Key className="h-8 w-8 text-slate-300 mx-auto mb-2" />
              <p className="text-sm text-slate-500">No API keys yet. Generate one to connect MCP clients.</p>
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
    </Card>
  );
}
