import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { supabase } from '@/shared/supabase';
import { useAuth } from '@/shared/auth/AuthProvider';

interface ParityReport {
  generated_at: string;
  deltas_total: number;
  deltas_by_table: Record<string, number>;
  pi_db_sha256: string;
}

const STALE_MS = 3 * 60 * 60 * 1000; // 3 hours

function useParityReport() {
  const { user } = useAuth();
  return useQuery<ParityReport | null>({
    queryKey: ['parity-report', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      // Object path is relative to the bucket root. The exporter writes to
      // bucket `parity-reports` at key `{user_id}/latest.json`, so the
      // download path must NOT re-prefix the bucket name.
      const { data, error } = await supabase.storage.from('parity-reports').download(`${user.id}/latest.json`);
      if (error) return null;
      return JSON.parse(await data.text()) as ParityReport;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

function formatAge(generatedAt: string): string {
  const diffMin = Math.floor((Date.now() - new Date(generatedAt).getTime()) / 60_000);
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.floor(diffMin / 60)}h ago`;
}

type Status = 'green' | 'yellow' | 'red';

function resolveStatus(report: ParityReport): Status {
  if (Date.now() - new Date(report.generated_at).getTime() > STALE_MS) return 'yellow';
  if (report.deltas_total > 0) return 'red';
  return 'green';
}

const STATUS: Record<Status, { dot: string; badge: string; label: string }> = {
  green: {
    dot: 'bg-emerald-500',
    badge: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300',
    label: 'In sync',
  },
  yellow: {
    dot: 'bg-amber-400',
    badge: 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
    label: 'Stale report',
  },
  red: {
    dot: 'bg-red-500',
    badge: 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300',
    label: 'Drift detected',
  },
};

export function SystemHealthCard() {
  const { data: report, isLoading } = useParityReport();

  if (isLoading || report == null) return null;

  const status = resolveStatus(report);
  const { dot, badge, label } = STATUS[status];

  return (
    <section
      data-testid="system-health-card"
      className="bg-surface rounded-xl border border-border p-4"
      aria-label="System health"
    >
      <div className="flex items-center gap-2 mb-3">
        <Activity className="h-4 w-4 text-text-secondary" aria-hidden />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">System Health</h2>
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            data-testid="health-status-dot"
            className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`}
            aria-hidden
          />
          <span data-testid="health-status-badge" className={`text-xs font-medium px-2 py-0.5 rounded-full ${badge}`}>
            {label}
          </span>
        </div>
        <span
          data-testid="health-drift-count"
          className={`text-sm font-semibold tabular-nums ${report.deltas_total > 0 ? 'text-red-600 dark:text-red-400' : 'text-text-secondary'}`}
        >
          {report.deltas_total} delta{report.deltas_total !== 1 ? 's' : ''}
        </span>
      </div>
      <p data-testid="health-last-updated" className="mt-2 text-xs text-text-tertiary">
        Last report: {formatAge(report.generated_at)}
      </p>
    </section>
  );
}
