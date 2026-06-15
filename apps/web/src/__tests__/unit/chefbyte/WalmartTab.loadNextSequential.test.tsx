/**
 * A5-06 — WalmartTab "Load Next 5 Products" must fetch SEQUENTIALLY and stop
 * on the first quota / rate-limit (429) response.
 *
 * Bug: the handler fired all 5 `walmart-scrape` edge-function calls at once
 * via `Promise.all`. The server-side rate-limit caps spend, but the client
 * still burned up to 5 doomed calls against a near-exhausted daily quota.
 *
 * Fix: a sequential loop that bails the moment `handleQuotaResponse()` flags a
 * quota hit (the edge fn returns `{ quota_exceeded: true }` / HTTP 429),
 * leaving the not-yet-attempted cards labeled instead of issuing the calls.
 *
 * This test renders the SHIPPED `WalmartTab`:
 *   - 5 products are missing Walmart links.
 *   - The mocked `walmart-scrape` invoke succeeds on call #1 and returns a
 *     quota_exceeded signal on call #2.
 *   - Assert EXACTLY 2 invoke calls fired (1 success + 1 quota), NOT 5.
 *     Pre-fix all 5 would fire in parallel before the loop could bail.
 *
 * Only the Supabase transport + toast are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const PRODUCTS = [
  { product_id: 'p1', name: 'Oats', barcode: '111' },
  { product_id: 'p2', name: 'Rice', barcode: '222' },
  { product_id: 'p3', name: 'Beans', barcode: '333' },
  { product_id: 'p4', name: 'Eggs', barcode: '444' },
  { product_id: 'p5', name: 'Milk', barcode: '555' },
];

// Records the search_term of every walmart-scrape invocation so we can count
// exactly how many calls fired before the loop bailed.
let invokeCalls: string[] = [];

// Per-call response: call #1 succeeds, call #2 returns the quota_exceeded
// signal (the edge fn's 429 shape). If the loop did NOT stop, calls 3-5 would
// also be recorded here.
function invokeResponseForCall(callIndex: number) {
  if (callIndex === 0) {
    return {
      data: { results: [{ url: 'https://walmart.com/ip/1', title: 'Oats', price: 3.99, image_url: null }] },
      error: null,
    };
  }
  // 2nd call: quota exhausted.
  return { data: { quota_exceeded: true, used: 100, limit: 100 }, error: null };
}

function resetState() {
  invokeCalls = [];
}

vi.mock('@/shared/supabase', () => {
  const buildChefClient = () => {
    const root: any = {};
    root.from = vi.fn((table: string) => {
      const builder: any = {};
      builder.select = vi.fn((_cols?: any, opts?: any) => {
        // The "missing walmart links" load (loadNext5Products) selects
        // product_id,name,barcode without a count option and ends in .limit(5).
        // The loadData() counters use { count:'exact', head:true }.
        builder._headCount = opts?.head === true;
        return builder;
      });
      builder.eq = vi.fn(() => builder);
      builder.is = vi.fn(() => builder);
      builder.not = vi.fn(() => builder);
      builder.neq = vi.fn(() => builder);
      builder.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
      builder.limit = vi.fn(() => {
        // Terminal for the missing-links product fetch.
        if (table === 'products') {
          return Promise.resolve({ data: PRODUCTS, error: null });
        }
        return Promise.resolve({ data: [], error: null });
      });
      // Head-count selects (loadData) resolve to a count envelope.
      builder.then = (resolve: (v: unknown) => void) => {
        resolve({ data: null, error: null, count: 5 });
      };
      return builder;
    });
    return root;
  };

  let callIndex = 0;
  const supabase: any = {
    schema: vi.fn(() => buildChefClient()),
    functions: {
      invoke: vi.fn((_name: string, opts: any) => {
        const term = opts?.body?.search_term ?? '';
        invokeCalls.push(term);
        const resp = invokeResponseForCall(callIndex);
        callIndex += 1;
        return Promise.resolve(resp);
      }),
    },
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })),
    removeChannel: vi.fn(),
  };

  return {
    supabase,
    chefbyte: () => buildChefClient(),
    escapeIlike: (s: string) => s,
  };
});

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 't@t.com' }, loading: false, signOut: vi.fn() }),
}));

const toastShow = vi.fn();
vi.mock('@/components/shared/Toast', () => ({
  useToast: () => ({ show: toastShow }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { WalmartTab } from '@/components/chefbyte/WalmartTab';

describe('WalmartTab — Load Next 5 stops on first quota hit (A5-06)', () => {
  beforeEach(() => {
    resetState();
    toastShow.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fires only 2 scrape calls when the 2nd returns quota_exceeded (not 5)', async () => {
    const user = userEvent.setup();
    render(<WalmartTab />);

    // Wait for initial load to settle and the button to appear.
    const btn = await screen.findByText('Load Next 5 Products');

    await user.click(btn);

    // Let the sequential loop run to completion / bail.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });

    // EXACTLY 2 calls: p1 (success) then p2 (quota). The loop must have
    // broken — p3/p4/p5 were never requested. Pre-fix: 5 parallel calls.
    await waitFor(() => {
      expect(invokeCalls.length).toBe(2);
    });
    expect(invokeCalls).toEqual(['Oats', 'Rice']);

    // The quota toast was surfaced exactly once for the skipped remainder
    // (call #1 success → no toast, call #2 quota → break → single hitQuota toast).
    expect(toastShow).toHaveBeenCalledTimes(1);
  });
});
