import { useAppContext } from '../shared/AppProvider';

/**
 * Renders a vertical stack of connectivity banners. Two distinct states:
 *
 *   1. **Offline** (red) — `navigator.onLine === false`. No network at all.
 *   2. **Realtime degraded** (yellow) — network is up but the Supabase
 *      Realtime WebSocket isn't delivering events. Rendering stale data
 *      silently used to be indistinguishable from "everything fine" — this
 *      banner makes the degraded state visible and exposes a "Reconnect"
 *      button that forces `channel.unsubscribe() + subscribe()` on every
 *      tracked channel.
 *
 * If both conditions hold, we only show the offline banner (the realtime
 * banner would be redundant — the network is the root cause).
 */
export function OfflineIndicator() {
  const { online, lastSynced, realtimeDegraded, reconnectRealtime } = useAppContext();

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
          onClick={reconnectRealtime}
          className="px-2 py-0.5 rounded border border-amber-500 hover:bg-amber-200 dark:hover:bg-amber-800/60 font-semibold"
        >
          Reconnect
        </button>
      </div>
    );
  }

  return null;
}
