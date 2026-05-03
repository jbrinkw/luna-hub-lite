import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchScannerState, pushScannerMode, type ScanMode } from '@/shared/scannerStateApi';
import { queryKeys } from '@/shared/queryKeys';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';

const MODE_LABELS: Record<ScanMode, string> = {
  purchase: 'Purchase (add to stock)',
  consume_macros: 'Consume + log macros',
  consume_no_macros: 'Consume (no macros)',
  shopping: 'Add to shopping list',
};

export function ScannerTab() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: state } = useQuery({
    queryKey: queryKeys.scannerState(user?.id),
    queryFn: fetchScannerState,
    enabled: !!user,
  });

  // Derive initial form state from the server-side row when it loads, then
  // let the user override locally. Tracking the "hydrated" snapshot via a
  // setState-during-render comparison avoids a useEffect that would just
  // mirror server state into local state (and trips the
  // react-hooks/set-state-in-effect lint).
  const [hydratedFor, setHydratedFor] = useState<typeof state | undefined>(undefined);
  const [locked, setLocked] = useState(false);
  const [selectedMode, setSelectedMode] = useState<ScanMode>('purchase');
  if (state !== hydratedFor) {
    setHydratedFor(state);
    if (state) {
      setLocked(!!state.locked_mode);
      setSelectedMode(state.locked_mode ?? state.last_active_mode ?? 'purchase');
    }
  }

  const mutation = useMutation({
    mutationFn: async () => {
      await pushScannerMode({ locked_mode: locked ? selectedMode : null });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scannerState(user?.id) });
    },
  });

  // Realtime: cross-device lock changes — when another tab/device flips the
  // lock or the Pi forwarder updates last_active_mode, this tab's display
  // should reflect it without a manual reload. Migration
  // `20260503100000_scanner_state_and_transactions.sql` adds
  // chefbyte.scanner_state to the supabase_realtime publication.
  useRealtimeInvalidation('scanner-tab', [
    {
      schema: 'chefbyte',
      table: 'scanner_state',
      queryKeys: [queryKeys.scannerState(user?.id)],
    },
  ]);

  return (
    <div className="space-y-3 p-4">
      <h3 className="text-lg font-semibold">Scanner</h3>
      <p className="text-xs text-text-muted">
        Lock the scanner to a single mode. Pi USB scans and the web Scanner page will both use this mode regardless of
        what's selected on the page. Off by default.
      </p>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="scanner-lock-toggle"
          data-testid="scanner-lock-toggle"
          checked={locked}
          onChange={(e) => setLocked(e.target.checked)}
        />
        <label htmlFor="scanner-lock-toggle">Lock scanner to a single mode</label>
      </div>

      {locked && (
        <select
          data-testid="scanner-locked-mode-select"
          value={selectedMode}
          onChange={(e) => setSelectedMode(e.target.value as ScanMode)}
          className="border border-border rounded px-2 py-1"
        >
          {(Object.keys(MODE_LABELS) as ScanMode[]).map((m) => (
            <option key={m} value={m}>
              {MODE_LABELS[m]}
            </option>
          ))}
        </select>
      )}

      <button
        type="button"
        data-testid="scanner-save-lock"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
        className="bg-primary text-on-primary px-3 py-1 rounded disabled:opacity-50"
      >
        {mutation.isPending ? 'Saving…' : 'Save'}
      </button>

      {state?.locked_mode && !mutation.isPending && (
        <p className="text-xs text-text-muted">Currently locked to: {MODE_LABELS[state.locked_mode]}</p>
      )}

      {mutation.isError && <p className="text-xs text-danger">Save failed: {(mutation.error as Error).message}</p>}
    </div>
  );
}
