import { lazy, type ComponentType } from 'react';

export const RELOAD_FLAG = 'luna_chunk_reload_attempted';

function isChunkLoadError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    /Failed to fetch dynamically imported module/i.test(err.message) ||
    /ChunkLoadError/i.test(err.name) ||
    /Loading chunk \d+ failed/i.test(err.message)
  );
}

export function lazyWithReload<T extends ComponentType<any>>(
  importer: () => Promise<{ default: T }>,
): React.LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      const mod = await importer();
      sessionStorage.removeItem(RELOAD_FLAG);
      return mod;
    } catch (err) {
      if (isChunkLoadError(err) && !sessionStorage.getItem(RELOAD_FLAG)) {
        sessionStorage.setItem(RELOAD_FLAG, '1');
        window.location.reload();
        // Return never-resolving promise so React doesn't surface error UI
        return new Promise<{ default: T }>(() => {});
      }
      throw err;
    }
  }) as React.LazyExoticComponent<T>;
}
