import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase, chefbyte } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { useAuth } from '@/shared/auth/AuthProvider';

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

  const voidMutation = useMutation({
    mutationFn: async (transactionId: string) => {
      const { error } = await supabase.functions.invoke(`shelf-ingest/scan-transaction/${transactionId}/void`, {
        method: 'POST',
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scanTransactions(user?.id) });
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
