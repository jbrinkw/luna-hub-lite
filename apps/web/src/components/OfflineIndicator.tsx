import { useAppContext } from '../shared/AppProvider';

export function OfflineIndicator() {
  const { online, lastSynced } = useAppContext();

  if (online) return null;

  const syncedStr = lastSynced ? `Last synced: ${lastSynced.toLocaleTimeString()}` : 'Never synced';

  return (
    <div className="w-full bg-amber-50 border-b border-amber-200 text-amber-800 px-4 py-2 text-sm text-center font-medium">
      <strong>No connection</strong> — {syncedStr}
    </div>
  );
}
