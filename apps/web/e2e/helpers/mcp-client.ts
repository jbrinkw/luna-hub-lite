import { createHash, randomBytes } from 'node:crypto';
import { admin } from './constants';

// ---------------------------------------------------------------------------
// API key generation — creates a raw API key and inserts its SHA-256 hash
// into hub.api_keys for the given user. Returns the raw key for MCP auth.
// ---------------------------------------------------------------------------

export async function generateTestApiKey(userId: string): Promise<string> {
  const rawKey = 'lh_' + randomBytes(16).toString('hex');
  const keyHash = createHash('sha256').update(rawKey).digest('hex');

  const { error } = await (admin as any).schema('hub').from('api_keys').insert({
    user_id: userId,
    api_key_hash: keyHash,
    label: 'e2e-test-key',
  });

  if (error) throw new Error(`Failed to create API key: ${error.message}`);
  return rawKey;
}

// ---------------------------------------------------------------------------
// McpE2EClient — Lightweight SSE/JSON-RPC client for Playwright E2E tests.
//
// Simplified version of apps/mcp-worker/src/__tests__/helpers/mcp-client.ts
// tailored for the Playwright test runner (runs in Node.js, not browser).
// ---------------------------------------------------------------------------

export class McpE2EClient {
  private baseUrl: string;
  private sessionId = '';
  private sseAbortController: AbortController | null = null;
  private messageQueue: any[] = [];
  private messageResolvers: Array<(value: any) => void> = [];
  private rpcId = 0;
  private connected = false;

  constructor(baseUrl = 'http://localhost:8787') {
    this.baseUrl = baseUrl;
  }

  /**
   * Connect to the MCP Worker SSE endpoint.
   * Sends GET /sse?apiKey=xxx and waits for the initial "endpoint" event
   * which contains the sessionId used for subsequent JSON-RPC calls.
   */
  async connect(apiKey: string): Promise<void> {
    this.sseAbortController = new AbortController();

    const response = await fetch(`${this.baseUrl}/sse?apiKey=${encodeURIComponent(apiKey)}`, {
      signal: this.sseAbortController.signal,
      headers: { Accept: 'text/event-stream' },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`SSE connection failed (${response.status}): ${text}`);
    }

    if (!response.body) {
      throw new Error('SSE response has no body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // Promise that resolves when we receive the endpoint event
    const endpointReady = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for endpoint event')), 10_000);

      let buffer = '';

      const readLoop = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Parse complete SSE events (delimited by double newline)
            let doubleNewline: number;
            while ((doubleNewline = buffer.indexOf('\n\n')) !== -1) {
              const rawEvent = buffer.slice(0, doubleNewline);
              buffer = buffer.slice(doubleNewline + 2);

              const parsed = this.parseSseEvent(rawEvent);
              if (!parsed) continue;

              if (parsed.event === 'endpoint') {
                // data is JSON-stringified — parse the endpoint URL
                const endpointUrl = JSON.parse(parsed.data) as string;
                const url = new URL(endpointUrl, this.baseUrl);
                this.sessionId = url.searchParams.get('sessionId') || '';
                if (!this.sessionId) {
                  clearTimeout(timeout);
                  reject(new Error(`No sessionId in endpoint URL: ${endpointUrl}`));
                  return;
                }
                this.connected = true;
                clearTimeout(timeout);
                resolve();
              } else if (parsed.event === 'message') {
                const message = JSON.parse(parsed.data);
                this.deliverMessage(message);
              }
            }
          }
        } catch (err: any) {
          // AbortError is expected on disconnect
          if (err.name !== 'AbortError') {
            console.error('[McpE2EClient] SSE read error:', err.message);
          }
        }
      };

      readLoop();
    });

    await endpointReady;
  }

  /**
   * Send the MCP initialize handshake. Must be called after connect().
   */
  async initialize(): Promise<any> {
    return this.sendRpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e-test', version: '1.0' },
    });
  }

  /**
   * Call an MCP tool by name with the given arguments.
   * Returns the tool result (content array with text fields).
   */
  async callTool(name: string, args: any = {}): Promise<any> {
    return this.sendRpc('tools/call', { name, arguments: args });
  }

  /**
   * List all available tools. Returns the tools/list response.
   */
  async listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: any }> }> {
    return this.sendRpc('tools/list', {});
  }

  /**
   * Disconnect from the SSE stream. Safe to call multiple times.
   */
  async disconnect(): Promise<void> {
    this.connected = false;
    this.sseAbortController?.abort();
    this.sseAbortController = null;
    this.messageResolvers = [];
    this.messageQueue = [];
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Send a JSON-RPC request via POST to /message and wait for the SSE response.
   */
  private async sendRpc(method: string, params?: any): Promise<any> {
    if (!this.connected) {
      throw new Error('Not connected — call connect() first');
    }

    const id = ++this.rpcId;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: params ?? {},
    });

    const postResponse = await fetch(`${this.baseUrl}/message?sessionId=${this.sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (postResponse.status !== 202) {
      const text = await postResponse.text();
      throw new Error(`POST /message returned ${postResponse.status}: ${text}`);
    }

    // Wait for the response via SSE
    const rpcResponse = await this.waitForMessage();

    if (rpcResponse.error) {
      throw new Error(`JSON-RPC error (${rpcResponse.error.code}): ${rpcResponse.error.message}`);
    }

    return rpcResponse.result;
  }

  /**
   * Wait for the next message from the SSE stream.
   */
  private waitForMessage(timeoutMs = 30_000): Promise<any> {
    // Check queue first
    if (this.messageQueue.length > 0) {
      return Promise.resolve(this.messageQueue.shift());
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.messageResolvers.indexOf(resolverFn);
        if (idx !== -1) this.messageResolvers.splice(idx, 1);
        reject(new Error(`Timed out waiting for SSE message (${timeoutMs}ms)`));
      }, timeoutMs);

      const resolverFn = (value: any) => {
        clearTimeout(timeout);
        resolve(value);
      };

      this.messageResolvers.push(resolverFn);
    });
  }

  /**
   * Parse a raw SSE event block into { event, data }.
   */
  private parseSseEvent(raw: string): { event: string; data: string } | null {
    let event = '';
    let data = '';

    for (const line of raw.split('\n')) {
      if (line.startsWith('event: ')) {
        event = line.slice(7);
      } else if (line.startsWith('data: ')) {
        data += (data ? '\n' : '') + line.slice(6);
      } else if (line.startsWith('event:')) {
        event = line.slice(6);
      } else if (line.startsWith('data:')) {
        data += (data ? '\n' : '') + line.slice(5);
      }
    }

    if (!event && !data) return null;
    return { event, data };
  }

  /**
   * Deliver a parsed SSE message to the next waiting resolver, or queue it.
   */
  private deliverMessage(message: any): void {
    if (this.messageResolvers.length > 0) {
      const resolver = this.messageResolvers.shift()!;
      resolver(message);
    } else {
      this.messageQueue.push(message);
    }
  }
}
