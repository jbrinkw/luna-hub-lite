import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase, chefbyte } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';

interface ScanTxRow {
  transaction_id: string;
  barcode: string;
  product_id: string | null;
  mode: string;
  qty: number | null;
  unit: string | null;
  status: 'pending' | 'applied' | 'voided' | 'errored';
  error_msg: string | null;
  logical_date: string;
  source: 'web' | 'pi_usb';
  created_at: string;
}

export function ScannerTransactionsTab() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: rows = [] } = useQuery<ScanTxRow[]>({
    queryKey: queryKeys.scanTransactions(user?.id),
    queryFn: async () => {
      const { data, error } = await chefbyte()
        .from('scan_transactions')
        .select(
          'transaction_id, barcode, product_id, mode, qty, unit, status, error_msg, logical_date, source, created_at',
        )
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as ScanTxRow[];
    },
    enabled: !!user,
  });

  // Realtime: when the Pi USB scanner (or any other tab) writes a new row to
  // chefbyte.scan_transactions, refresh this tab without a manual reload.
  // Migration `20260503100000_scanner_state_and_transactions.sql` already
  // adds the table to the supabase_realtime publication.
  useRealtimeInvalidation('scan-transactions-tab', [
    {
      schema: 'chefbyte',
      table: 'scan_transactions',
      queryKeys: [queryKeys.scanTransactions(user?.id)],
    },
  ]);

  const voidMutation = useMutation({
    mutationFn: async (transactionId: string) => {
      const { error } = await supabase.functions.invoke(`shelf-ingest/scan-transaction/${transactionId}/void`, {
        method: 'POST',
      });
      if (error) throw error;
    },
    onSuccess: () => {
      // Always: refresh the transactions list (status flips to 'voided').
      queryClient.invalidateQueries({ queryKey: queryKeys.scanTransactions(user?.id) });
      // Defensive downstream invalidation: void reverses one of three
      // side-effect paths and we don't know which from the UI side, so
      // invalidate every key that could have been touched.
      //   purchase        → stock_lots (Realtime usually catches it; this
      //                     covers the case where the realtime channel for
      //                     stock_lots is unhealthy or the page mounted
      //                     after the event fired).
      //   consume_macros  → food_log row deleted → dailyMacros + foodLogs
      //                     for whatever date the consume hit.
      //   shopping        → cart_item row deleted → shoppingList.
      // products is included because Settings → Products may have been
      // affected (e.g. last lot of a placeholder product re-added).
      queryClient.invalidateQueries({ queryKey: queryKeys.products(user!.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.stockLots(user!.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.shoppingList(user!.id) });
      // dailyMacros/foodLogs are date-keyed; the void may correspond to any
      // logical_date so we invalidate by tuple prefix (matches every date).
      queryClient.invalidateQueries({ queryKey: ['daily-macros', user?.id] });
      queryClient.invalidateQueries({ queryKey: ['food-logs', user?.id] });
    },
  });

  return (
    <div className="space-y-2 p-4">
      <h3 className="text-lg font-semibold">Scanner Transactions</h3>
      <p className="text-xs text-text-muted">
        Every scan (web + Pi USB) recorded here. Void to reverse the side-effect.
      </p>

      {voidMutation.isError && (
        <p className="text-xs text-danger">Void failed: {(voidMutation.error as Error).message}</p>
      )}

      <div className="overflow-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-bg-soft text-text-muted">
              <th className="text-left p-1">When</th>
              <th className="text-left p-1">Source</th>
              <th className="text-left p-1">Barcode</th>
              <th className="text-left p-1">Mode</th>
              <th className="text-left p-1">Qty</th>
              <th className="text-left p-1">Status</th>
              <th className="text-left p-1">Error</th>
              <th className="text-left p-1">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="p-2 text-center text-text-muted">
                  No transactions yet.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr
                key={row.transaction_id}
                data-testid={`tx-row-${row.transaction_id}`}
                className="border-t border-border"
              >
                <td className="p-1">{new Date(row.created_at).toLocaleString()}</td>
                <td className="p-1">{row.source}</td>
                <td className="p-1 font-mono">{row.barcode}</td>
                <td className="p-1">{row.mode}</td>
                <td className="p-1">{row.qty != null ? `${row.qty} ${row.unit ?? ''}`.trim() : '-'}</td>
                <td className="p-1">{row.status}</td>
                <td className="p-1 text-danger">{row.error_msg ?? ''}</td>
                <td className="p-1">
                  {row.status === 'applied' && (
                    <button
                      type="button"
                      data-testid={`void-${row.transaction_id}`}
                      onClick={() => voidMutation.mutate(row.transaction_id)}
                      disabled={voidMutation.isPending}
                      className="text-danger underline disabled:opacity-50"
                    >
                      Void
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
