import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SystemHealthCard } from '@/components/hub/SystemHealthCard';

// Mock supabase storage
const mockDownload = vi.fn();
vi.mock('@/shared/supabase', () => ({
  supabase: {
    storage: {
      from: () => ({ download: mockDownload }),
    },
  },
}));

// Mock useAuth
vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-test-123', email: 'test@test.com' } }),
}));

function makeReport(
  overrides: Partial<{
    deltas_total: number;
    generated_at: string;
    deltas_by_table: Record<string, number>;
    pi_db_sha256: string;
  }> = {},
) {
  return {
    deltas_total: 0,
    generated_at: new Date().toISOString(),
    deltas_by_table: {},
    pi_db_sha256: 'abc123',
    ...overrides,
  };
}

function makeBlob(report: object) {
  const json = JSON.stringify(report);
  return { text: async () => json };
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SystemHealthCard />
    </QueryClientProvider>,
  );
}

describe('SystemHealthCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing while loading', () => {
    // download never resolves during this test
    mockDownload.mockReturnValue(new Promise(() => {}));
    renderCard();
    expect(screen.queryByTestId('system-health-card')).not.toBeInTheDocument();
  });

  it('renders nothing when no report exists (404)', async () => {
    mockDownload.mockResolvedValue({ data: null, error: { message: 'not found' } });
    renderCard();
    await waitFor(() => {
      expect(screen.queryByTestId('system-health-card')).not.toBeInTheDocument();
    });
  });

  it('shows green badge when deltas=0 and report is fresh', async () => {
    mockDownload.mockResolvedValue({ data: makeBlob(makeReport({ deltas_total: 0 })), error: null });
    renderCard();
    await waitFor(() => {
      expect(screen.getByTestId('system-health-card')).toBeInTheDocument();
    });
    expect(screen.getByTestId('health-status-badge')).toHaveTextContent('In sync');
    expect(screen.getByTestId('health-drift-count')).toHaveTextContent('0 deltas');
  });

  it('shows red badge when drift > 0', async () => {
    mockDownload.mockResolvedValue({
      data: makeBlob(makeReport({ deltas_total: 3 })),
      error: null,
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByTestId('health-status-badge')).toHaveTextContent('Drift detected');
    });
    expect(screen.getByTestId('health-drift-count')).toHaveTextContent('3 deltas');
    expect(screen.getByTestId('health-status-dot')).toHaveClass('bg-red-500');
  });

  it('shows yellow badge when report is stale (>3h old)', async () => {
    const staleDate = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(); // 4h ago
    mockDownload.mockResolvedValue({
      data: makeBlob(makeReport({ deltas_total: 0, generated_at: staleDate })),
      error: null,
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByTestId('health-status-badge')).toHaveTextContent('Stale report');
    });
    expect(screen.getByTestId('health-status-dot')).toHaveClass('bg-amber-400');
  });

  it('red overrides stale: drift > 0 but fresh shows red not yellow', async () => {
    // Fresh report, drift > 0 -> red (not stale, not green)
    mockDownload.mockResolvedValue({
      data: makeBlob(makeReport({ deltas_total: 1 })),
      error: null,
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByTestId('health-status-badge')).toHaveTextContent('Drift detected');
    });
  });

  it('stale takes priority over green: stale + no drift -> yellow', async () => {
    // Old report, no drift -> yellow (not green)
    const staleDate = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    mockDownload.mockResolvedValue({
      data: makeBlob(makeReport({ deltas_total: 0, generated_at: staleDate })),
      error: null,
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByTestId('health-status-badge')).toHaveTextContent('Stale report');
    });
  });

  it('shows last-updated text', async () => {
    mockDownload.mockResolvedValue({
      data: makeBlob(makeReport()),
      error: null,
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByTestId('health-last-updated')).toHaveTextContent('Last report:');
    });
  });

  it('singular "delta" for deltas_total=1', async () => {
    mockDownload.mockResolvedValue({
      data: makeBlob(makeReport({ deltas_total: 1 })),
      error: null,
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByTestId('health-drift-count')).toHaveTextContent('1 delta');
    });
    expect(screen.getByTestId('health-drift-count')).not.toHaveTextContent('deltas');
  });
});
