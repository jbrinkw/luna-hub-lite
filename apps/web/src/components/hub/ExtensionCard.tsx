import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Toggle } from '@/components/ui/Toggle';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { ExternalLink, PlugZap, CheckCircle2, XCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { supabase } from '@/shared/supabase';
import { useAuth } from '@/shared/auth/AuthProvider';
import { queryKeys } from '@/shared/queryKeys';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';

/**
 * Map extension UI name → MCP tool-name namespace prefix. Tool names in
 * `hub.mcp_tool_logs` follow the convention `<NAMESPACE>_<action>`
 * (uppercase namespace, e.g. `OBSIDIAN_create_project`). The namespace is
 * what we filter on for the per-extension call tail.
 */
const EXTENSION_NAMESPACE: Record<string, string> = {
  obsidian: 'OBSIDIAN',
  todoist: 'TODOIST',
  homeassistant: 'HOMEASSISTANT',
};

/** Row shape for the recent-calls query. Only fields the UI renders. */
interface McpToolLogRow {
  id: number;
  tool_name: string;
  status: 'ok' | 'tool_error' | 'exception';
  error_message: string | null;
  duration_ms: number;
  created_at: string;
}

/** Relative time string ("5s ago", "2m ago", "1h ago", "3d ago"). */
function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const deltaSec = Math.max(0, Math.floor((now - then) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  return `${Math.floor(deltaHr / 24)}d ago`;
}

/** Drop the `OBSIDIAN_` prefix so the action ("create_project") renders. */
function shortToolName(toolName: string, namespace: string): string {
  const prefix = `${namespace}_`;
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}

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
  const [expandedLogId, setExpandedLogId] = useState<number | null>(null);
  const { user } = useAuth();

  const setupHint = SETUP_HINTS[extensionName];
  const probe = testProbe ?? probeExtensionCredentials;

  // Tool-name namespace prefix for `hub.mcp_tool_logs` filtering. Tools
  // not in the EXTENSION_NAMESPACE map (e.g. future extensions) won't get
  // a tail until the map is updated — this is a deliberate fail-closed
  // default rather than guessing the prefix from `extensionName`.
  const toolNamespace = EXTENSION_NAMESPACE[extensionName];
  const showTail = enabled && hasCredentials && !!toolNamespace && !!user;
  const tailQueryKey = useMemo(
    () => queryKeys.mcpToolLogs(user?.id ?? '', toolNamespace ?? ''),
    [user?.id, toolNamespace],
  );

  // Realtime: invalidate the tail query whenever a new log row lands for
  // this user. Default filter `user_id=eq.<uid>` already scopes by user;
  // we still cull non-matching namespaces client-side via the `like`
  // filter on the SELECT below. Mounting the subscription only when the
  // tail itself is shown avoids opening per-extension channels for
  // disabled/unconfigured cards.
  useRealtimeInvalidation(`extension-tail-${extensionName}`, [
    {
      schema: 'hub',
      table: 'mcp_tool_logs',
      queryKeys: showTail ? [tailQueryKey] : [],
    },
  ]);

  const { data: recentCalls = [] } = useQuery<McpToolLogRow[]>({
    queryKey: tailQueryKey,
    queryFn: async () => {
      // Filter by `tool_name LIKE 'OBSIDIAN_%'` so this card only shows
      // calls for ITS extension's namespace. RLS handles the user scoping.
      const { data, error: queryError } = await supabase
        .schema('hub')
        .from('mcp_tool_logs')
        .select('id, tool_name, status, error_message, duration_ms, created_at')
        .like('tool_name', `${toolNamespace}\\_%`)
        .order('created_at', { ascending: false })
        .limit(5);
      if (queryError) throw queryError;
      return (data ?? []) as McpToolLogRow[];
    },
    enabled: showTail,
    staleTime: 30 * 1000,
  });

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

            {showTail && (
              <div
                className="space-y-2 pt-3 mt-1 border-t border-border-light"
                data-testid={`extension-tail-${extensionName}`}
              >
                <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Last 5 MCP calls</p>
                {recentCalls.length === 0 ? (
                  <p className="text-xs text-text-tertiary italic">
                    No calls yet — try asking Claude to use this extension.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {recentCalls.map((row) => {
                      const ok = row.status === 'ok';
                      const isExpanded = expandedLogId === row.id;
                      return (
                        <li
                          key={row.id}
                          className="rounded border border-border-light bg-surface-sunken text-xs"
                          data-testid={`extension-tail-row-${row.id}`}
                          data-status={row.status}
                        >
                          <button
                            type="button"
                            onClick={() => setExpandedLogId(isExpanded ? null : row.id)}
                            className="w-full flex items-center gap-2 p-2 text-left hover:bg-surface-hover transition-colors min-w-0"
                            aria-expanded={isExpanded}
                          >
                            <span
                              className="shrink-0"
                              data-testid={`extension-tail-status-${row.id}`}
                              data-status-color={ok ? 'success' : 'danger'}
                              aria-label={ok ? 'success' : 'failed'}
                            >
                              {ok ? (
                                <CheckCircle2 size={14} className="text-success" />
                              ) : (
                                <XCircle size={14} className="text-danger" />
                              )}
                            </span>
                            <span className="font-mono truncate flex-1 min-w-0 text-text-primary">
                              {shortToolName(row.tool_name, toolNamespace)}
                            </span>
                            <span className="shrink-0 text-text-tertiary tabular-nums">{row.duration_ms}ms</span>
                            <span className="shrink-0 text-text-tertiary">{relativeTime(row.created_at)}</span>
                            <span className="shrink-0 text-text-tertiary">
                              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            </span>
                          </button>
                          {isExpanded && (
                            <div className="border-t border-border-light px-2 py-2 space-y-1">
                              <div className="font-mono text-text-secondary break-all">{row.tool_name}</div>
                              {!ok && row.error_message && (
                                <div className="text-danger break-words whitespace-pre-wrap">{row.error_message}</div>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
