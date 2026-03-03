import type { ToolResult } from '../types';

export function toolSuccess(data: unknown): ToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}

export function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Get today's logical date for a user (same logic as private.get_logical_date) */
export async function getLogicalDate(supabase: any, userId: string): Promise<string> {
  const { data: profile } = await supabase
    .schema('hub')
    .from('profiles')
    .select('timezone, day_start_hour')
    .eq('user_id', userId)
    .single();

  const tz = profile?.timezone || 'America/New_York';
  const dayStart = profile?.day_start_hour ?? 6;
  const now = new Date();
  const localDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  const localHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(now),
  );
  return localHour < dayStart
    ? new Date(new Date(localDateStr).getTime() - 86400000).toISOString().slice(0, 10)
    : localDateStr;
}
