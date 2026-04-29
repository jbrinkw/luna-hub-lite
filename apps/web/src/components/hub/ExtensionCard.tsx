import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Toggle } from '@/components/ui/Toggle';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { ExternalLink, PlugZap } from 'lucide-react';

/** Credential field keys that represent URLs (not secrets) */
const URL_FIELD_KEYS = new Set(['ha_url', 'github_api_url', 'github_repo']);

/**
 * Per-extension help block shown above the credential fields. Closes the
 * "Where do I get these credentials?" gap from the audit. Each entry
 * names the exact UI path on the upstream service so non-developers
 * aren't googling. Keyed by extension_name.
 */
const SETUP_HINTS: Record<string, { steps: string[]; docsUrl?: string; docsLabel?: string }> = {
  obsidian: {
    steps: [
      'Repo: <owner>/<repo> for the GitHub/Gitea repo containing your vault.',
      'Token: GitHub → Settings → Developer settings → Personal access tokens. Scope `repo` (read+write).',
      'API URL is optional — leave blank for github.com, set to https://your-gitea-host/api/v1 for Gitea.',
    ],
    docsUrl:
      'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
    docsLabel: 'GitHub PAT setup',
  },
  todoist: {
    steps: ['Token: Todoist → Settings → Integrations → Developer → API token (copy).'],
    docsUrl: 'https://todoist.com/help/articles/find-your-api-token-Jpzx9IIlB',
    docsLabel: 'Find your Todoist API token',
  },
  homeassistant: {
    steps: [
      'URL: full base URL of your HA instance (e.g. https://homeassistant.local:8123).',
      'Token: HA Profile → Long-Lived Access Tokens → Create token.',
    ],
    docsUrl: 'https://developers.home-assistant.io/docs/auth_api/#long-lived-access-token',
    docsLabel: 'HA long-lived tokens',
  },
};

/**
 * Result of a credential probe. Live-tests fire a single read-only call
 * against the upstream service to confirm the supplied creds work BEFORE
 * the user discovers the misconfiguration via a failed tool call from
 * Claude.ai (the audit's "silent misconfiguration trap").
 */
type CredTestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ok'; message: string }
  | { status: 'fail'; message: string };

/**
 * Live-fire a minimal read against the upstream service using the in-form
 * credentials. Returns a structured result. Network and 401/403 errors
 * are reported separately so the user can tell auth-failed from
 * unreachable.
 *
 * Only Obsidian + Todoist are wired up here. Home Assistant is FLAGGED
 * because the cloud Worker can't always reach a user's LAN-only HA
 * instance — see UX_AUDIT_HUB_MCP_LIVETRACK_FLAGS.md FLAG-03.
 */
async function probeExtensionCredentials(extensionName: string, creds: Record<string, string>): Promise<CredTestState> {
  if (extensionName === 'obsidian') {
    const repo = (creds.github_repo ?? '').trim();
    const token = (creds.github_token ?? '').trim();
    const apiBase = ((creds.github_api_url ?? '').trim() || 'https://api.github.com').replace(/\/$/, '');
    if (!repo || !token) return { status: 'fail', message: 'Repo + Token are required.' };
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      return { status: 'fail', message: 'Repo must be in the form owner/repo.' };
    }
    try {
      const res = await fetch(`${apiBase}/repos/${repo}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      });
      if (res.status === 401 || res.status === 403) {
        return { status: 'fail', message: `Authentication rejected (${res.status}). Check the token.` };
      }
      if (res.status === 404) {
        return { status: 'fail', message: 'Repo not found. Check the owner/repo and that the token can see it.' };
      }
      if (!res.ok) return { status: 'fail', message: `Upstream returned HTTP ${res.status}.` };
      return { status: 'ok', message: 'Repo reachable with this token.' };
    } catch (e) {
      return { status: 'fail', message: e instanceof Error ? e.message : 'Network error.' };
    }
  }
  if (extensionName === 'todoist') {
    const token = (creds.todoist_api_key ?? '').trim();
    if (!token) return { status: 'fail', message: 'API token is required.' };
    try {
      const res = await fetch('https://api.todoist.com/rest/v2/projects', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401 || res.status === 403) {
        return { status: 'fail', message: `Authentication rejected (${res.status}). Check the token.` };
      }
      if (!res.ok) return { status: 'fail', message: `Todoist returned HTTP ${res.status}.` };
      const json = (await res.json()) as unknown;
      const count = Array.isArray(json) ? json.length : 0;
      return { status: 'ok', message: `Token works. ${count} project${count === 1 ? '' : 's'} visible.` };
    } catch (e) {
      return { status: 'fail', message: e instanceof Error ? e.message : 'Network error.' };
    }
  }
  // Home Assistant + anything else: not implemented in this pass.
  return { status: 'fail', message: 'Live test not yet supported for this extension.' };
}

interface ExtensionCardProps {
  extensionName: string;
  displayName: string;
  description: string;
  enabled: boolean;
  hasCredentials: boolean;
  credentialFields: { key: string; label: string; optional?: boolean }[];
  onToggle: (enabled: boolean) => void;
  onSaveCredentials: (credentials: Record<string, string>) => Promise<{ error?: string }>;
  /**
   * Override hook for tests: lets a unit test inject a stub probe so the
   * test isn't dependent on real GitHub / Todoist responses. Production
   * uses `probeExtensionCredentials` by default.
   */
  testProbe?: typeof probeExtensionCredentials;
}

export function ExtensionCard({
  extensionName,
  displayName,
  description,
  enabled,
  hasCredentials,
  credentialFields,
  onToggle,
  onSaveCredentials,
  testProbe,
}: ExtensionCardProps) {
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [credTest, setCredTest] = useState<CredTestState>({ status: 'idle' });

  const setupHint = SETUP_HINTS[extensionName];
  const probe = testProbe ?? probeExtensionCredentials;

  const handleSave = async () => {
    setError(null);
    setSuccess(false);

    for (const field of credentialFields) {
      if (!field.optional && !credentials[field.key]?.trim()) {
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

  const handleTest = async () => {
    setCredTest({ status: 'running' });
    const result = await probe(extensionName, credentials);
    setCredTest(result);
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
            {setupHint && (
              <div className="rounded border border-border-light bg-surface-sunken p-3 text-xs text-text-secondary">
                <p className="mb-1 font-semibold text-text-primary">Where do I get these?</p>
                <ul className="list-disc space-y-1 pl-4">
                  {setupHint.steps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ul>
                {setupHint.docsUrl && (
                  <a
                    href={setupHint.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-accent hover:underline"
                  >
                    <ExternalLink size={12} />
                    {setupHint.docsLabel ?? 'Docs'}
                  </a>
                )}
              </div>
            )}
            {credentialFields.map((field) => (
              <Input
                key={field.key}
                label={field.label}
                type={URL_FIELD_KEYS.has(field.key) ? 'text' : 'password'}
                value={credentials[field.key] ?? ''}
                onChange={(e) => setCredentials((prev) => ({ ...prev, [field.key]: e.target.value }))}
              />
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={handleSave} loading={saving} size="sm">
                Save Credentials
              </Button>
              <Button
                onClick={handleTest}
                loading={credTest.status === 'running'}
                size="sm"
                variant="secondary"
                disabled={credentialFields.length === 0}
              >
                <PlugZap size={14} className="mr-1" />
                Test connection
              </Button>
            </div>
            {error && <Alert variant="error">{error}</Alert>}
            {success && <Alert variant="success">Credentials saved</Alert>}
            {credTest.status === 'ok' && <Alert variant="success">{credTest.message}</Alert>}
            {credTest.status === 'fail' && <Alert variant="error">{credTest.message}</Alert>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
