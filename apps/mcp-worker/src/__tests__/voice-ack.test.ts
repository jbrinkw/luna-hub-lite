import { describe, it, expect, vi } from 'vitest';
import { loadVoiceAckSettings, DEFAULT_VOICE_ACK } from '../voice-ack';

function mockSupabase(rpcImpl: (name: string, args: unknown) => unknown) {
  return {
    schema: () => ({ rpc: vi.fn(rpcImpl) }),
  } as any;
}

describe('loadVoiceAckSettings', () => {
  it('returns DB row values when present', async () => {
    const supabase = mockSupabase(() => ({
      data: [{ voice_ack_enabled: true, voice_ack_text: 'One sec…', voice_ack_delay_ms: 800 }],
      error: null,
    }));
    const result = await loadVoiceAckSettings(supabase, 'user-1');
    expect(result).toEqual({ enabled: true, text: 'One sec…', delayMs: 800 });
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
});

describe('DEFAULT_VOICE_ACK', () => {
  it('matches the DB migration defaults', () => {
    expect(DEFAULT_VOICE_ACK).toEqual({ enabled: false, text: 'Working on that…', delayMs: 1200 });
  });
});
