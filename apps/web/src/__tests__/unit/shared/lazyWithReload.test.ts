import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RELOAD_FLAG } from '@/shared/lazyWithReload';

// We need to test the async internals of lazyWithReload without triggering
// React.lazy's rendering machinery. We do this by extracting the async factory
// that was passed to lazy() via a spy, then calling it directly.

// Spy on React.lazy so we can intercept the factory argument.
let capturedFactory: (() => Promise<any>) | null = null;

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    lazy: (factory: () => Promise<any>) => {
      capturedFactory = factory;
      // Return a minimal stub that satisfies the type — we never render it in
      // these unit tests, we only call capturedFactory directly.
      return { $$typeof: Symbol.for('react.lazy'), _payload: null, _init: null };
    },
  };
});

// Import AFTER the mock is set up so the module picks up our lazy spy.
const { lazyWithReload } = await import('@/shared/lazyWithReload');

// ------- helpers -------

function makeChunkError(kind: 'fetch' | 'name' | 'loading' = 'fetch'): Error {
  if (kind === 'fetch') {
    return Object.assign(new Error('Failed to fetch dynamically imported module: /assets/foo.js'), { name: 'Error' });
  }
  if (kind === 'name') {
    return Object.assign(new Error('chunk failed'), { name: 'ChunkLoadError' });
  }
  return Object.assign(new Error('Loading chunk 42 failed.'), { name: 'Error' });
}

function makeGenericError(): Error {
  return new Error('ReferenceError: foo is not defined');
}

// Stub window.location.reload without replacing the whole location object.
let reloadSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionStorage.clear();
  capturedFactory = null;
  reloadSpy = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload: reloadSpy },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ------- tests -------

describe('lazyWithReload — factory extraction', () => {
  it('passes a factory function to React.lazy', () => {
    const importer = vi.fn().mockResolvedValue({ default: () => null });
    lazyWithReload(importer);
    expect(capturedFactory).toBeTypeOf('function');
  });
});

describe('lazyWithReload — successful import', () => {
  it('returns the module and clears the reload flag', async () => {
    sessionStorage.setItem(RELOAD_FLAG, '1'); // pre-existing flag from a previous session
    const fakeModule = { default: () => null };
    const importer = vi.fn().mockResolvedValue(fakeModule);

    lazyWithReload(importer);
    const result = await capturedFactory!();

    expect(result).toBe(fakeModule);
    expect(sessionStorage.getItem(RELOAD_FLAG)).toBeNull();
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});

describe('lazyWithReload — first chunk-load failure (no flag set)', () => {
  it('sets the flag and calls reload once for "Failed to fetch" error', async () => {
    const importer = vi.fn().mockRejectedValue(makeChunkError('fetch'));
    lazyWithReload(importer);

    // The factory returns a never-resolving promise; we just need to let it run.
    const factoryPromise = capturedFactory!();
    // Give the microtask queue a tick to process the rejection handler.
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.getItem(RELOAD_FLAG)).toBe('1');
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    // The promise itself should never settle (pending forever).
    let settled = false;
    factoryPromise
      .then(() => {
        settled = true;
      })
      .catch(() => {
        settled = true;
      });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
  });

  it('sets the flag and calls reload for ChunkLoadError name', async () => {
    const importer = vi.fn().mockRejectedValue(makeChunkError('name'));
    lazyWithReload(importer);
    capturedFactory!(); // invoke factory; triggers rejection handler
    await new Promise((r) => setTimeout(r, 0));

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(RELOAD_FLAG)).toBe('1');
  });

  it('sets the flag and calls reload for "Loading chunk N failed" message', async () => {
    const importer = vi.fn().mockRejectedValue(makeChunkError('loading'));
    lazyWithReload(importer);
    capturedFactory!(); // invoke factory; triggers rejection handler
    await new Promise((r) => setTimeout(r, 0));

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(RELOAD_FLAG)).toBe('1');
  });
});

describe('lazyWithReload — second chunk-load failure (flag already set)', () => {
  it('does NOT call reload and propagates the error', async () => {
    sessionStorage.setItem(RELOAD_FLAG, '1');
    const chunkErr = makeChunkError('fetch');
    const importer = vi.fn().mockRejectedValue(chunkErr);
    lazyWithReload(importer);

    await expect(capturedFactory!()).rejects.toThrow(chunkErr);
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});

describe('lazyWithReload — non-chunk errors', () => {
  it('propagates generic errors without reloading or setting the flag', async () => {
    const genericErr = makeGenericError();
    const importer = vi.fn().mockRejectedValue(genericErr);
    lazyWithReload(importer);

    await expect(capturedFactory!()).rejects.toThrow(genericErr);
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RELOAD_FLAG)).toBeNull();
  });

  it('propagates non-Error rejections without reloading', async () => {
    const importer = vi.fn().mockRejectedValue('string error');
    lazyWithReload(importer);

    await expect(capturedFactory!()).rejects.toBe('string error');
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});
