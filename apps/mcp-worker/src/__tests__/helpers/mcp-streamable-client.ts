/**
 * McpStreamableClient — Streamable HTTP client for testing the stateless MCP endpoint.
 * Uses POST /mcp for all communication. No SSE, no persistent connections.
 */
export class McpStreamableClient {
  private baseUrl: string;
  private apiKey: string = '';
  private sessionId: string = '';
  private rpcId = 0;

  constructor(baseUrl = 'http://localhost:8787') {
    this.baseUrl = baseUrl;
  }

  /** Set the API key for authentication (sent as Bearer token). */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  /** Get the current session ID (assigned by server on initialize). */
  get currentSessionId(): string {
    return this.sessionId;
  }

  /** Send a JSON-RPC request via POST /mcp and return the parsed result. */
  async sendRpc(method: string, params?: any): Promise<any> {
    if (!this.apiKey) throw new Error('No API key set — call setApiKey() first');

    const id = ++this.rpcId;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }

    const response = await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }),
    });

    // Capture session ID from response
    const respSessionId = response.headers.get('Mcp-Session-Id');
    if (respSessionId) {
      this.sessionId = respSessionId;
    }

    if (response.status === 202) {
      return null; // Notification acknowledged
    }

    if (response.status === 401) {
      throw new Error('Authentication failed (401)');
    }

    const rpcResponse = (await response.json()) as any;

    if (rpcResponse.error) {
      throw new Error(`JSON-RPC error (${rpcResponse.error.code}): ${rpcResponse.error.message}`);
    }

    return rpcResponse.result;
  }

  /** Send the MCP initialize handshake. */
  async initialize(): Promise<any> {
    return this.sendRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-streamable', version: '1.0' },
    });
  }

  /** List all available MCP tools. */
  async listTools(): Promise<any[]> {
    const result = await this.sendRpc('tools/list', {});
    return result.tools;
  }

  /** Call an MCP tool by name with the given arguments. */
  async callTool(name: string, args: any = {}): Promise<any> {
    return this.sendRpc('tools/call', { name, arguments: args });
  }
}
