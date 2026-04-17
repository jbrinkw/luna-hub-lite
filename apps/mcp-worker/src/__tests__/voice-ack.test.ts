import { describe, it, expect, vi } from 'vitest';
import { loadVoiceAckSettings, DEFAULT_VOICE_ACK } from '../voice-ack';

function mockSupabase(rpcImpl: (name: string, args: unknown) => unknown) {
  return {
    schema: () => ({ rpc: vi.fn(rpcImpl) }),
  } as any;
}

/**
 * Spy-enabled variant of mockSupabase that exposes the underlying rpc and
 * schema mocks so tests can verify the RPC name and args used by the loader.
 */
function mockSupabaseSpy(rpcImpl: (name: string, args: unknown) => unknown) {
  const rpcSpy = vi.fn(rpcImpl);
  const schemaSpy = vi.fn(() => ({ rpc: rpcSpy }));
  return {
    client: { schema: schemaSpy } as any,
    rpcSpy,
    schemaSpy,
  };
}

describe('loadVoiceAckSettings', () => {
  it('returns DB row values when present', async () => {
    const { client, rpcSpy, schemaSpy } = mockSupabaseSpy(() => ({
      data: [{ voice_ack_enabled: true, voice_ack_text: 'One sec…', voice_ack_delay_ms: 800 }],
      error: null,
    }));
    const result = await loadVoiceAckSettings(client, 'user-1');
    expect(result).toEqual({ enabled: true, text: 'One sec…', delayMs: 800 });
    expect(schemaSpy).toHaveBeenCalledWith('hub');
    expect(rpcSpy).toHaveBeenCalledWith('get_agent_voice_ack_admin', { p_user_id: 'user-1' });
  });

  it('returns defaults when no row exists', async () => {
    const supabase = mockSupabase(() => ({ data: [], error: null }));
    const result = await loadVoiceAckSettings(supabase, 'user-1');
    expect(result).toEqual(DEFAULT_VOICE_ACK);
  });

  it('returns defaults when RPC returns an error', async () => {
    const supabase = mockSupabase(() => ({ data: null, error: { message: 'boom' } }));
    const result = await loadVoiceAckSettings(supabase, 'user-1');
    expect(result).toEqual(DEFAULT_VOICE_ACK);
  });

  it('returns defaults when RPC throws', async () => {
    const supabase = mockSupabase(() => {
      throw new Error('network fail');
    });
    const result = await loadVoiceAckSettings(supabase, 'user-1');
    expect(result).toEqual(DEFAULT_VOICE_ACK);
  });

  it('falls back to default text when row returns empty string', async () => {
    const supabase = mockSupabase(() => ({
      data: [{ voice_ack_enabled: true, voice_ack_text: '', voice_ack_delay_ms: 800 }],
      error: null,
    }));
    const result = await loadVoiceAckSettings(supabase, 'user-1');
    expect(result.text).toBe(DEFAULT_VOICE_ACK.text);
  });

  it('falls back to default delayMs when row returns non-finite value', async () => {
    const supabase = mockSupabase(() => ({
      data: [{ voice_ack_enabled: true, voice_ack_text: 'ok', voice_ack_delay_ms: null }],
      error: null,
    }));
    const result = await loadVoiceAckSettings(supabase, 'user-1');
    expect(result.delayMs).toBe(DEFAULT_VOICE_ACK.delayMs);
  });
});

describe('DEFAULT_VOICE_ACK', () => {
  it('matches the DB migration defaults', () => {
    expect(DEFAULT_VOICE_ACK).toEqual({ enabled: false, text: 'Working on that…', delayMs: 1200 });
  });
});
