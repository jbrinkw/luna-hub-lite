import { useState } from 'react';
import { useAppContext } from '../shared/AppProvider';

/**
 * Renders a vertical stack of connectivity banners. Two distinct states:
 *
 *   1. **Offline** (red) — `navigator.onLine === false`. No network at all.
 *   2. **Realtime degraded** (yellow) — network is up but the Supabase
 *      Realtime WebSocket isn't delivering events. Rendering stale data
 *      silently used to be indistinguishable from "everything fine" — this
 *      banner makes the degraded state visible and exposes a "Reconnect"
 *      button that resets the underlying Realtime socket AND forces
 *      `channel.unsubscribe() + subscribe()` on every tracked channel.
 *
 * If both conditions hold, we only show the offline banner (the realtime
 * banner would be redundant — the network is the root cause).
 */
export function OfflineIndicator() {
  const { online, lastSynced, realtimeDegraded, reconnectRealtime } = useAppContext();
  // Local "reconnecting" state so the button can show a brief loading
  // indicator while the socket reset Promise is in flight. The banner
  // itself stays visible until the underlying realtime channels actually
  // re-SUBSCRIBE — the health store flips `realtimeDegraded` to false at
  // that point and the banner unmounts on its own.
  const [reconnecting, setReconnecting] = useState(false);

  const handleReconnect = async () => {
    if (reconnecting) return; // ignore double-clicks while in flight
    setReconnecting(true);
    try {
      await reconnectRealtime();
    } catch (err) {
      // Swallow + log: a transient reconnect failure must NOT propagate as
      // an unhandled rejection (would surface as a global error banner /
      // crash overlay) and must NOT leave the button stuck on
      // "Reconnecting…". The banner itself stays up because
      // `realtimeDegraded` is still true; the user can click again or wait
      // for the auto-reconnect retry loop in `useRealtimeInvalidation` to
      // recover.
      console.error('[OfflineIndicator] reconnectRealtime failed:', err);
    } finally {
      setReconnecting(false);
    }
  };

  if (!online) {
    const syncedStr = lastSynced ? `Last synced: ${lastSynced.toLocaleTimeString()}` : 'Never synced';
    return (
      <div
        data-testid="offline-banner"
        className="w-full bg-warning-subtle border-b border-warning text-warning-text px-4 py-2 text-sm text-center font-medium"
      >
        <strong>No connection</strong> — {syncedStr}
      </div>
    );
  }

  if (realtimeDegraded) {
    return (
      <div
        data-testid="realtime-degraded-banner"
        className="w-full bg-amber-100 dark:bg-amber-900/40 border-b border-amber-400 dark:border-amber-600 text-amber-900 dark:text-amber-100 px-4 py-2 text-sm text-center font-medium flex items-center justify-center gap-3"
      >
        <span>
          <strong>Live updates paused</strong> — data may be stale until reconnected.
        </span>
        <button
          type="button"
          data-testid="realtime-reconnect-button"
          onClick={handleReconnect}
          disabled={reconnecting}
          aria-busy={reconnecting}
          className="px-2 py-0.5 rounded border border-amber-500 hover:bg-amber-200 dark:hover:bg-amber-800/60 font-semibold disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {reconnecting ? 'Reconnecting…' : 'Reconnect'}
        </button>
      </div>
    );
  }

  return null;
}
