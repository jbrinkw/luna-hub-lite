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
 * Probe credentials by hitting the MCP Worker's `/test-extension-creds`
 * endpoint instead of calling upstream services directly from the
 * browser. Three reasons (R2 audit F5):
 *   1. Tests Worker → upstream reachability — which is what actually
 *      matters at tool-call time, not browser → upstream.
 *   2. Avoids browser CORS surprises (Todoist's REST API was a
 *      borderline case here).
 *   3. Lets us extend to LAN-only / Worker-only services later (HA
 *      via outbound-only relay, self-hosted Gitea on private nets).
 *
 * The Worker reads stored creds when `useStored=true`, so post-Save
 * "test stored credentials" works without retyping. When `useStored`
 * is false (or omitted) the Worker uses the in-form `creds` payload —
 * useful for first-time setup before Save.
 *
 * Auth: Bearer the user's Supabase session JWT (already used by the
 * /v1/chat/completions path on the same Worker).
 */
async function probeExtensionCredentials(
  extensionName: string,
  creds: Record<string, string>,
  opts: { useStored?: boolean; bearer?: string } = {},
): Promise<CredTestState> {
  const baseUrl = (import.meta.env.VITE_MCP_URL as string | undefined) ?? 'https://mcp.lunahub.dev';
  const url = `${baseUrl.replace(/\/$/, '')}/test-extension-creds`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
      },
      body: JSON.stringify({
        extension: extensionName,
        creds: opts.useStored ? null : creds,
        use_stored: opts.useStored === true,
      }),
    });
    if (res.status === 401) {
      return { status: 'fail', message: 'Sign in expired. Refresh the page and try again.' };
    }
    let body: { ok?: boolean; message?: string } | null = null;
    try {
      body = (await res.json()) as { ok?: boolean; message?: string };
    } catch {
      return { status: 'fail', message: `Worker returned HTTP ${res.status} (non-JSON).` };
    }
    if (body?.ok) {
      return { status: 'ok', message: body.message ?? 'Credentials work.' };
    }
    return { status: 'fail', message: body?.message ?? `Worker returned HTTP ${res.status}.` };
  } catch (e) {
    return { status: 'fail', message: e instanceof Error ? e.message : 'Network error reaching MCP Worker.' };
  }
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
   * Override hook for tests: lets a unit test inject a stub probe so
   * the test isn't dependent on the live MCP Worker. Production uses
   * `probeExtensionCredentials` (which calls the Worker's
   * /test-extension-creds endpoint) by default. The signature matches
   * the production probe so the unit test can assert against the
   * exact arguments the component would have sent.
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
      // R2 audit F4: do NOT clear credentials state on save. Clearing
      // it stranded the operator in a Save→Test dead-end where the
      // form was empty and Test connection had no creds to send. The
      // form retains its values until the user explicitly clears them
      // (e.g. by re-entering different creds and saving again).
    }
  };

  const handleTest = async () => {
    setCredTest({ status: 'running' });
    // If the form has values, send them. If not (post-Save returning
    // user with no in-flight edits AND saved credentials on file),
    // ask the Worker to load stored creds and probe with those.
    const hasInFormValues = Object.values(credentials).some((v) => v && v.trim().length > 0);
    const useStored = !hasInFormValues && hasCredentials;
    const result = await probe(extensionName, credentials, { useStored });
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
