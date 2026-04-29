import { useEffect } from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ExtensionCard } from '@/components/hub/ExtensionCard';
import { queryKeys } from '@/shared/queryKeys';

// HUB-U-02: mock useAuth with full AuthContextType shape (user + session) so
// any component path that reads session.access_token or session.expires_at is
// exercised rather than silently receiving undefined.
vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'test@test.com' },
    session: {
      access_token: 'test-access-token-abc123',
      refresh_token: 'test-refresh-token-xyz',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'user-1', email: 'test@test.com' },
    },
    loading: false,
    sessionError: null,
    clearSessionError: vi.fn(),
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  }),
}));

// Capture realtime subscriptions so we can assert (a) the hook is wired,
// and (b) what schema/table/queryKeys it was given. Tests can also drive
// the channel to fire by reaching into the captured config.
const realtimeRegistrations: Array<{ channelName: string; subs: unknown[] }> = [];
vi.mock('@/shared/useRealtimeInvalidation', () => ({
  useRealtimeInvalidation: vi.fn((channelName: string, subs: unknown[]) => {
    realtimeRegistrations.push({ channelName, subs });
  }),
}));

// Capture supabase query state so each test can program a result and so
// we can assert filter args (the namespace LIKE clause is load-bearing).
type StoredCalls = {
  schema?: string;
  table?: string;
  selectCols?: string;
  likeCol?: string;
  likePattern?: string;
  orderCol?: string;
  orderAsc?: boolean;
  limit?: number;
};
const supabaseCalls: { last: StoredCalls } = { last: {} };
let mcpLogsResponse: { data: unknown; error: unknown } = { data: [], error: null };

vi.mock('@/shared/supabase', () => {
  const buildBuilder = (table: string) => {
    const builder: any = {};
    builder.select = vi.fn((cols: string) => {
      supabaseCalls.last.selectCols = cols;
      supabaseCalls.last.table = table;
      return builder;
    });
    builder.like = vi.fn((col: string, pattern: string) => {
      supabaseCalls.last.likeCol = col;
      supabaseCalls.last.likePattern = pattern;
      return builder;
    });
    builder.order = vi.fn((col: string, opts?: { ascending?: boolean }) => {
      supabaseCalls.last.orderCol = col;
      supabaseCalls.last.orderAsc = opts?.ascending ?? true;
      return builder;
    });
    builder.limit = vi.fn((n: number) => {
      supabaseCalls.last.limit = n;
      return Promise.resolve(mcpLogsResponse);
    });
    return builder;
  };
  const schemaClient = {
    from: vi.fn((table: string) => buildBuilder(table)),
  };
  return {
    supabase: {
      schema: vi.fn((s: string) => {
        supabaseCalls.last.schema = s;
        return schemaClient;
      }),
    },
  };
});

const baseProps = {
  extensionName: 'obsidian',
  displayName: 'Obsidian',
  description: 'Sync notes with Obsidian vault',
  enabled: false,
  hasCredentials: false,
  credentialFields: [{ key: 'vault_path', label: 'Vault Path' }],
  onToggle: vi.fn(),
  onSaveCredentials: vi.fn().mockResolvedValue({}),
};

function renderCard(propsOverride: Partial<typeof baseProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <ExtensionCard {...baseProps} {...propsOverride} />
    </QueryClientProvider>,
  );
  return { ...utils, client };
}

beforeEach(() => {
  realtimeRegistrations.length = 0;
  supabaseCalls.last = {};
  mcpLogsResponse = { data: [], error: null };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ExtensionCard', () => {
  it('renders extension name and description', () => {
    renderCard();
    expect(screen.getByText('Obsidian')).toBeInTheDocument();
    expect(screen.getByText('Sync notes with Obsidian vault')).toBeInTheDocument();
  });

  it('enable toggle calls onToggle', async () => {
    const onToggle = vi.fn();
    renderCard({ onToggle });
    await userEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('when enabled, credential form fields appear', () => {
    renderCard({ enabled: true });
    expect(screen.getByText('Vault Path')).toBeInTheDocument();
    expect(screen.getByText('Save Credentials')).toBeInTheDocument();
  });

  it('save credentials calls onSaveCredentials with field values', async () => {
    const onSaveCredentials = vi.fn().mockResolvedValue({});
    renderCard({ enabled: true, onSaveCredentials });
    const input = screen.getByLabelText('Vault Path');
    await userEvent.type(input, '/path/to/vault');
    await userEvent.click(screen.getByText('Save Credentials'));
    await waitFor(() => {
      expect(onSaveCredentials).toHaveBeenCalledWith({ vault_path: '/path/to/vault' });
    });
  });

  it('empty required credential shows validation error', async () => {
    renderCard({ enabled: true });
    await userEvent.click(screen.getByText('Save Credentials'));
    expect(screen.getByText(/vault path is required/i)).toBeInTheDocument();
  });

  it('disabled state hides credential form', () => {
    renderCard({ enabled: false });
    expect(screen.queryByText('Save Credentials')).not.toBeInTheDocument();
  });

  it('hasCredentials shows configured badge', () => {
    renderCard({ enabled: true, hasCredentials: true });
    expect(screen.getByText('Credentials configured')).toBeInTheDocument();
  });

  it('no credentials shows not configured badge', () => {
    renderCard({ enabled: true, hasCredentials: false });
    expect(screen.getByText('Not configured')).toBeInTheDocument();
  });

  it('server error from onSaveCredentials', async () => {
    const onSaveCredentials = vi.fn().mockResolvedValue({ error: 'Network error' });
    renderCard({ enabled: true, onSaveCredentials });
    const input = screen.getByLabelText('Vault Path');
    await userEvent.type(input, '/some/path');
    await userEvent.click(screen.getByText('Save Credentials'));
    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('toggle off calls onToggle(false)', async () => {
    const onToggle = vi.fn();
    renderCard({ enabled: true, onToggle });
    await userEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('save button is disabled while save is in progress', async () => {
    const onSaveCredentials = vi.fn().mockReturnValue(new Promise(() => {}));
    renderCard({ enabled: true, onSaveCredentials });
    const input = screen.getByLabelText('Vault Path');
    await userEvent.type(input, '/some/path');
    await userEvent.click(screen.getByText('Save Credentials'));
    await waitFor(() => {
      const saveButton = screen.getByRole('button', { name: /save credentials/i });
      expect(saveButton).toBeDisabled();
    });
  });

  it('URL fields use text type, API key fields use password type', () => {
    const fields = [
      { key: 'ha_url', label: 'Home Assistant URL' },
      { key: 'ha_api_key', label: 'API Key' },
    ];
    renderCard({ enabled: true, credentialFields: fields, extensionName: 'homeassistant', displayName: 'HA' });
    expect(screen.getByLabelText('Home Assistant URL')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'password');
  });

  it('enabled card has success semantic-token left border', () => {
    const { container } = renderCard({ enabled: true });
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('border-l-success');
  });

  it('disabled card has reduced opacity', () => {
    const { container } = renderCard({ enabled: false });
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('opacity-60');
  });

  describe('Last 5 MCP calls tail', () => {
    it('hides the tail when not enabled', () => {
      renderCard({ enabled: false, hasCredentials: true });
      expect(screen.queryByTestId('extension-tail-obsidian')).not.toBeInTheDocument();
    });

    it('hides the tail when enabled but credentials are not configured', () => {
      renderCard({ enabled: true, hasCredentials: false });
      expect(screen.queryByTestId('extension-tail-obsidian')).not.toBeInTheDocument();
    });

    it('shows empty state when enabled+configured with no recent calls', async () => {
      mcpLogsResponse = { data: [], error: null };
      renderCard({ enabled: true, hasCredentials: true });
      expect(await screen.findByTestId('extension-tail-obsidian')).toBeInTheDocument();
      expect(screen.getByText(/No calls yet/i)).toBeInTheDocument();
    });

    it('queries hub.mcp_tool_logs filtered by namespace, ordered desc, limit 5', async () => {
      mcpLogsResponse = { data: [], error: null };
      renderCard({ enabled: true, hasCredentials: true });
      await waitFor(() => {
        expect(supabaseCalls.last.schema).toBe('hub');
        expect(supabaseCalls.last.table).toBe('mcp_tool_logs');
        expect(supabaseCalls.last.likeCol).toBe('tool_name');
        // Backslash-escapes the literal underscore so PG LIKE doesn't
        // treat it as a single-char wildcard. (e.g. would otherwise also
        // match `OBSIDIANXcreate_project` if the namespace were `OBSIDIA`.)
        expect(supabaseCalls.last.likePattern).toBe('OBSIDIAN\\_%');
        expect(supabaseCalls.last.orderCol).toBe('created_at');
        expect(supabaseCalls.last.orderAsc).toBe(false);
        expect(supabaseCalls.last.limit).toBe(5);
      });
    });

    it('renders rows with relative time and short tool name', async () => {
      const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
      mcpLogsResponse = {
        data: [
          {
            id: 1,
            tool_name: 'OBSIDIAN_create_project',
            status: 'ok',
            error_message: null,
            duration_ms: 432,
            created_at: tenSecondsAgo,
          },
        ],
        error: null,
      };
      renderCard({ enabled: true, hasCredentials: true });
      const row = await screen.findByTestId('extension-tail-row-1');
      expect(row).toHaveTextContent('create_project');
      expect(row).not.toHaveTextContent('OBSIDIAN_create_project'); // collapsed view
      expect(row).toHaveTextContent('432ms');
      expect(row).toHaveTextContent('10s ago');
    });

    it('successful row uses success-colored status icon, failed row uses danger', async () => {
      mcpLogsResponse = {
        data: [
          {
            id: 1,
            tool_name: 'OBSIDIAN_create_project',
            status: 'ok',
            error_message: null,
            duration_ms: 100,
            created_at: new Date().toISOString(),
          },
          {
            id: 2,
            tool_name: 'OBSIDIAN_patch_file',
            status: 'tool_error',
            error_message: 'Permission denied',
            duration_ms: 50,
            created_at: new Date().toISOString(),
          },
        ],
        error: null,
      };
      renderCard({ enabled: true, hasCredentials: true });
      const okIcon = await screen.findByTestId('extension-tail-status-1');
      const failIcon = await screen.findByTestId('extension-tail-status-2');
      expect(okIcon).toHaveAttribute('data-status-color', 'success');
      expect(failIcon).toHaveAttribute('data-status-color', 'danger');
    });

    it('expanding a failed row reveals the full tool name and error message', async () => {
      mcpLogsResponse = {
        data: [
          {
            id: 7,
            tool_name: 'OBSIDIAN_patch_file',
            status: 'tool_error',
            error_message: 'Permission denied on path /vault/foo.md',
            duration_ms: 50,
            created_at: new Date().toISOString(),
          },
        ],
        error: null,
      };
      renderCard({ enabled: true, hasCredentials: true });
      const row = await screen.findByTestId('extension-tail-row-7');
      const button = row.querySelector('button')!;
      await userEvent.click(button);
      expect(row).toHaveTextContent('OBSIDIAN_patch_file');
      expect(row).toHaveTextContent('Permission denied on path /vault/foo.md');
    });

    it('subscribes useRealtimeInvalidation to hub.mcp_tool_logs with the tail query key', async () => {
      mcpLogsResponse = { data: [], error: null };
      renderCard({ enabled: true, hasCredentials: true });
      await waitFor(() => expect(realtimeRegistrations.length).toBeGreaterThan(0));
      const reg = realtimeRegistrations[realtimeRegistrations.length - 1];
      expect(reg.channelName).toBe('extension-tail-obsidian');
      const subs = reg.subs as Array<{ schema: string; table: string; queryKeys: unknown[][] }>;
      expect(subs[0]?.schema).toBe('hub');
      expect(subs[0]?.table).toBe('mcp_tool_logs');
      // The query key the tail uses must be the SAME one the subscription
      // invalidates — otherwise live updates land on a key nobody reads.
      expect(subs[0]?.queryKeys[0]).toEqual(queryKeys.mcpToolLogs('user-1', 'OBSIDIAN'));
    });

    it('realtime invalidation triggers a tail refetch', async () => {
      // Initial fetch returns one row. After invalidation we mutate the
      // mocked response and assert the new row replaces the old.
      mcpLogsResponse = {
        data: [
          {
            id: 1,
            tool_name: 'OBSIDIAN_create_project',
            status: 'ok',
            error_message: null,
            duration_ms: 100,
            created_at: new Date().toISOString(),
          },
        ],
        error: null,
      };

      // Wrap in a probe so we can grab the QueryClient and invalidate the
      // tail key the same way the realtime hook would. The probe writes
      // through a side-effect (effect-after-render) instead of mutating
      // a hoisted variable during render — eslint react/components-must-be-pure.
      const probeBox: { client: ReturnType<typeof useQueryClient> | null } = { client: null };
      const Probe = () => {
        const qc = useQueryClient();
        useEffect(() => {
          probeBox.client = qc;
        }, [qc]);
        return null;
      };
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <Probe />
          <ExtensionCard {...baseProps} enabled hasCredentials />
        </QueryClientProvider>,
      );
      expect(await screen.findByTestId('extension-tail-row-1')).toBeInTheDocument();

      // Simulate a new tool call landing — the realtime sub would
      // invalidate the tail key. We do the equivalent by hand.
      mcpLogsResponse = {
        data: [
          {
            id: 99,
            tool_name: 'OBSIDIAN_get_morning_brief',
            status: 'ok',
            error_message: null,
            duration_ms: 220,
            created_at: new Date().toISOString(),
          },
        ],
        error: null,
      };
      await waitFor(() => expect(probeBox.client).not.toBeNull());
      await act(async () => {
        await probeBox.client!.invalidateQueries({ queryKey: queryKeys.mcpToolLogs('user-1', 'OBSIDIAN') });
      });
      expect(await screen.findByTestId('extension-tail-row-99')).toBeInTheDocument();
      expect(screen.queryByTestId('extension-tail-row-1')).not.toBeInTheDocument();
    });
  });
});
