/**
 * McpTestClient — SSE/JSON-RPC client for testing the MCP Worker.
 *
 * Usage:
 *   const client = new McpTestClient();
 *   await client.connect(apiKey);
 *   const initResult = await client.initialize();
 *   const tools = await client.listTools();
 *   const result = await client.callTool('CHEFBYTE_LIST_PRODUCTS', { limit: 10 });
 *   await client.disconnect();
 */
export class McpTestClient {
  private baseUrl: string;
  private sessionId: string = '';
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
   * Waits until the initial "endpoint" event is received with the sessionId.
   */
  async connect(apiKey: string, retries = 3): Promise<void> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this._connectOnce(apiKey);
        return;
      } catch (err: any) {
        if (attempt === retries) throw err;
        console.warn(`[McpTestClient] connect attempt ${attempt}/${retries} failed: ${err.message}, retrying…`);
        this.sseAbortController?.abort();
        this.sseAbortController = null;
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }

  private async _connectOnce(apiKey: string): Promise<void> {
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

    // Read the SSE stream in the background
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // Promise that resolves when we get the endpoint event
    const endpointReady = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for endpoint event')), 20_000);

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
            console.error('[McpTestClient] SSE read error:', err.message);
          }
        }
      };

      readLoop();
    });

    await endpointReady;
  }

  /**
   * Parse a raw SSE event block into { event, data }.
   * Handles multiline data fields.
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
        // Remove this resolver from the array
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
   * Send a JSON-RPC request via POST to /message and wait for the SSE response.
   */
  async sendRpc(method: string, params?: any): Promise<any> {
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
   * Send the MCP initialize handshake.
   */
  async initialize(): Promise<any> {
    return this.sendRpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    });
  }

  /**
   * List all available MCP tools.
   */
  async listTools(): Promise<any[]> {
    const result = await this.sendRpc('tools/list', {});
    return result.tools;
  }

  /**
   * Call an MCP tool by name with the given arguments.
   */
  async callTool(name: string, args: any = {}): Promise<any> {
    return this.sendRpc('tools/call', { name, arguments: args });
  }

  /**
   * Disconnect from the SSE stream.
   */
  async disconnect(): Promise<void> {
    this.connected = false;
    this.sseAbortController?.abort();
    this.sseAbortController = null;
    this.messageResolvers = [];
    this.messageQueue = [];
  }

  /** Check if the client is currently connected. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Get the current session ID. */
  get currentSessionId(): string {
    return this.sessionId;
  }
}
