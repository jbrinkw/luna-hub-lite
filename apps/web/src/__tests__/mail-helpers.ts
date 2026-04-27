/**
 * Helpers for asserting that Supabase Auth emails were actually sent,
 * using the local Mailpit mail catcher (default port 54324 in the
 * `supabase` CLI's local stack).
 *
 * The API used here matches Mailpit v1.22+:
 *   GET  /api/v1/search?query=to:<email>   → { messages: [...] }
 *   GET  /api/v1/message/<ID>              → full message (Text, HTML)
 *   DELETE /api/v1/messages?ids=[...]      → batch delete
 */

const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://127.0.0.1:54324';

export interface MailpitMessageSummary {
  ID: string;
  Subject: string;
  From: { Address: string; Name: string };
  To: { Address: string; Name: string }[];
  Created: string;
}

export interface MailpitMessage extends MailpitMessageSummary {
  Text?: string;
  HTML?: string;
}

async function searchMailbox(email: string): Promise<MailpitMessageSummary[]> {
  const url = `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Mailpit search failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { messages?: MailpitMessageSummary[] };
  return data.messages ?? [];
}

async function fetchMessage(id: string): Promise<MailpitMessage> {
  const res = await fetch(`${MAILPIT_URL}/api/v1/message/${id}`);
  if (!res.ok) {
    throw new Error(`Mailpit fetch message ${id} failed: ${res.status}`);
  }
  return (await res.json()) as MailpitMessage;
}

/**
 * Remove any messages currently addressed to `email`. Call this before
 * triggering the action that is supposed to send a fresh email so the
 * polling assertion can't match a stale reset from a prior test run.
 */
export async function clearMailboxFor(email: string): Promise<void> {
  const existing = await searchMailbox(email);
  if (existing.length === 0) return;

  // Mailpit supports batch delete via POST /api/v1/delete with {ids:[]}.
  // Fall back to per-id DELETE if the batch route isn't available.
  const ids = existing.map((m) => m.ID);
  const res = await fetch(`${MAILPIT_URL}/api/v1/messages`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    // Per-id fallback — ignore errors, they're best-effort cleanup.
    await Promise.all(
      ids.map((id) => fetch(`${MAILPIT_URL}/api/v1/message/${id}`, { method: 'DELETE' }).catch(() => undefined)),
    );
  }
}

/**
 * Poll Mailpit until an email addressed to `email` appears, then fetch
 * and return the full message. Returns `null` if no message arrives
 * within `timeoutMs`.
 *
 * The caller is expected to have cleared the mailbox for this address
 * before triggering the action (see `clearMailboxFor`).
 */
export async function waitForResetEmail(email: string, timeoutMs: number): Promise<MailpitMessage | null> {
  const deadline = Date.now() + timeoutMs;
  const pollMs = 200;

  while (Date.now() < deadline) {
    const summaries = await searchMailbox(email);
    // Mailpit search is case-insensitive on recipients. The newest
    // message is first; also filter by Subject looking like a reset.
    const candidate = summaries.find((m) => /reset|password/i.test(m.Subject)) ?? summaries[0];
    if (candidate) {
      return await fetchMessage(candidate.ID);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  return null;
}
