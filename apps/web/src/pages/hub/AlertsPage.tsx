import { useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, AlertOctagon, AlertCircle, CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react';
import { HubLayout } from '@/components/hub/HubLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';

type Severity = 'critical' | 'error' | 'warning';

interface AlertRow {
  alert_id: string;
  created_at: string;
  invariant_name: string;
  severity: Severity;
  subject_type: string;
  subject_id: string | null;
  user_id: string | null;
  details: Record<string, unknown>;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  acknowledged_note: string | null;
}

const ALERTS_QUERY_KEY = ['hub-alerts'] as const;

function severityIcon(s: Severity) {
  if (s === 'critical') return <AlertOctagon className="h-5 w-5 text-danger" aria-label="critical" />;
  if (s === 'error') return <AlertTriangle className="h-5 w-5 text-warning" aria-label="error" />;
  return <AlertCircle className="h-5 w-5 text-text-secondary" aria-label="warning" />;
}

function severityLabel(s: Severity): string {
  return s === 'critical' ? 'Critical' : s === 'error' ? 'Error' : 'Warning';
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

interface RowProps {
  row: AlertRow;
  onAcknowledge: (alert: AlertRow, note: string) => Promise<void>;
}

function AlertRowItem({ row, onAcknowledge }: RowProps) {
  const [expanded, setExpanded] = useState(false);
  const [ackOpen, setAckOpen] = useState(false);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleAck() {
    setSubmitting(true);
    try {
      await onAcknowledge(row, note);
      setAckOpen(false);
      setNote('');
    } finally {
      setSubmitting(false);
    }
  }

  const isAcked = !!row.acknowledged_at;
  const detailsString = useMemo(() => JSON.stringify(row.details, null, 2), [row.details]);

  return (
    <li className="border border-border rounded-lg bg-surface" data-testid={`alert-row-${row.alert_id}`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-3 p-3 text-left hover:bg-surface-hover transition-colors rounded-lg"
        aria-expanded={expanded}
      >
        <div className="mt-0.5 shrink-0">{severityIcon(row.severity)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-mono text-sm text-text">{row.invariant_name}</span>
            <span className="text-xs text-text-tertiary">
              {row.subject_type}
              {row.subject_id ? `: ${row.subject_id}` : ''}
            </span>
          </div>
          <div className="text-xs text-text-secondary">{formatTimestamp(row.created_at)}</div>
          {isAcked && row.acknowledged_note ? (
            <div className="mt-1 text-xs text-text-secondary italic">Acked: {row.acknowledged_note}</div>
          ) : null}
        </div>
        <div className="shrink-0 mt-0.5">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-text-tertiary" />
          ) : (
            <ChevronRight className="h-4 w-4 text-text-tertiary" />
          )}
        </div>
      </button>

      {expanded ? (
        <div className="border-t border-border-light px-3 py-3 text-sm">
          <pre className="text-xs bg-surface-sunken rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
            {detailsString}
          </pre>
          {!isAcked ? (
            <div className="mt-3">
              {ackOpen ? (
                <div className="flex flex-col gap-2">
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Optional note (e.g. cause, fix, next step)"
                    rows={2}
                    className="w-full p-2 text-sm border border-border rounded bg-surface text-text"
                    data-testid={`alert-ack-note-${row.alert_id}`}
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleAck}
                      disabled={submitting}
                      className="px-3 py-1.5 text-sm font-medium rounded bg-primary text-white hover:bg-primary-hover disabled:opacity-50"
                      data-testid={`alert-ack-confirm-${row.alert_id}`}
                    >
                      {submitting ? 'Saving…' : 'Acknowledge'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAckOpen(false);
                        setNote('');
                      }}
                      className="px-3 py-1.5 text-sm font-medium rounded border border-border text-text hover:bg-surface-hover"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAckOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded border border-border text-text hover:bg-surface-hover"
                  data-testid={`alert-ack-open-${row.alert_id}`}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Acknowledge
                </button>
              )}
            </div>
          ) : (
            <div className="mt-2 text-xs text-text-tertiary">
              Acknowledged at {formatTimestamp(row.acknowledged_at!)}
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}

export function AlertsPage() {
  const { user } = useAuth();
  const { isAdmin, loading: adminLoading } = useIsAdmin();
  const queryClient = useQueryClient();
  const [showAcked, setShowAcked] = useState(false);

  // Realtime invalidation: when a new alert lands, refetch automatically.
  useRealtimeInvalidation('hub-alerts-realtime', [
    {
      schema: 'hub',
      table: 'alerts',
      queryKeys: [ALERTS_QUERY_KEY],
    },
  ]);

  const { data: alerts = [], isLoading } = useQuery<AlertRow[]>({
    queryKey: ALERTS_QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('hub')
        .from('alerts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as AlertRow[];
    },
    enabled: !!user && isAdmin,
    staleTime: 30 * 1000,
  });

  const ackMutation = useMutation({
    mutationFn: async ({ alertId, note }: { alertId: string; note: string }) => {
      const { error } = await (supabase as any).schema('hub').rpc('acknowledge_alert', {
        p_alert_id: alertId,
        p_note: note?.trim() ? note.trim() : null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ALERTS_QUERY_KEY });
    },
  });

  // Hooks below MUST run unconditionally — early returns happen after
  // all hooks resolve to keep the order stable across renders.
  const filtered = useMemo(() => alerts.filter((a) => (showAcked ? true : !a.acknowledged_at)), [alerts, showAcked]);
  const groups = useMemo(() => {
    const out: Record<Severity, AlertRow[]> = { critical: [], error: [], warning: [] };
    for (const row of filtered) {
      if (row.severity in out) out[row.severity].push(row);
    }
    return out;
  }, [filtered]);
  const unackedCount = useMemo(() => alerts.filter((a) => !a.acknowledged_at).length, [alerts]);

  // Admin gate — render a 404-style block for non-admins. Wait for the
  // hook to finish before deciding so an admin doesn't briefly see "not
  // found" on a slow profile fetch.
  if (adminLoading) {
    return (
      <HubLayout title="Alerts">
        <div className="text-text-secondary">Loading…</div>
      </HubLayout>
    );
  }
  if (!isAdmin) {
    return <Navigate to="/hub" replace />;
  }

  return (
    <HubLayout title="Alerts">
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-text">System Alerts</h2>
            <p className="text-sm text-text-secondary mt-1">
              Production invariant violations detected by the monitor (runs every 30 min).{' '}
              <span className="font-medium" data-testid="alerts-unacked-count">
                {unackedCount} unacknowledged
              </span>
              .
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={showAcked}
              onChange={(e) => setShowAcked(e.target.checked)}
              data-testid="alerts-show-acked"
              className="h-4 w-4"
            />
            Show acknowledged
          </label>
        </div>

        {isLoading ? (
          <div data-testid="alerts-loading" className="text-text-secondary">
            Loading alerts…
          </div>
        ) : filtered.length === 0 ? (
          <div
            className="border border-border rounded-lg bg-surface p-8 text-center text-text-secondary"
            data-testid="alerts-empty"
          >
            No {showAcked ? '' : 'unacknowledged '}alerts. System is healthy.
          </div>
        ) : (
          (['critical', 'error', 'warning'] as Severity[]).map((sev) => {
            const rows = groups[sev];
            if (!rows || rows.length === 0) return null;
            return (
              <section key={sev} data-testid={`alerts-group-${sev}`}>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">
                  {severityLabel(sev)} ({rows.length})
                </h3>
                <ul className="flex flex-col gap-2">
                  {rows.map((row) => (
                    <AlertRowItem
                      key={row.alert_id}
                      row={row}
                      onAcknowledge={async (a, note) => {
                        await ackMutation.mutateAsync({ alertId: a.alert_id, note });
                      }}
                    />
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </HubLayout>
  );
}
