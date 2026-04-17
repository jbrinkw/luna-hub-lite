export interface VoiceAckSettings {
  enabled: boolean;
  text: string;
  delayMs: number;
}

export const DEFAULT_VOICE_ACK: VoiceAckSettings = {
  enabled: false,
  text: 'Working on that…',
  delayMs: 1200,
};

/**
 * Load voice-ack settings for a user. Never throws — any error falls back to
 * DEFAULT_VOICE_ACK so the streaming request isn't blocked by an optional
 * setting lookup.
 */
export async function loadVoiceAckSettings(supabase: any, userId: string): Promise<VoiceAckSettings> {
  try {
    const { data, error } = await supabase.schema('hub').rpc('get_agent_voice_ack_admin', { p_user_id: userId });

    if (error || !data) return DEFAULT_VOICE_ACK;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return DEFAULT_VOICE_ACK;

    return {
      enabled: Boolean(row.voice_ack_enabled),
      text: row.voice_ack_text || DEFAULT_VOICE_ACK.text,
      delayMs: Number.isFinite(row.voice_ack_delay_ms) ? row.voice_ack_delay_ms : DEFAULT_VOICE_ACK.delayMs,
    };
  } catch {
    return DEFAULT_VOICE_ACK;
  }
}
