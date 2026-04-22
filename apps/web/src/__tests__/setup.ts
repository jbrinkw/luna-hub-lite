import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// jsdom doesn't implement window.matchMedia — shim it so components that
// consume ThemeProvider (which reads prefers-color-scheme on mount) can
// render in tests.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// Mock AppProvider (provides default activation + online state for all tests)
vi.mock('@/shared/AppProvider', () => ({
  useAppContext: vi.fn(() => ({
    activations: { coachbyte: true, chefbyte: true },
    online: true,
    lastSynced: new Date(),
    dayStartHour: 0,
    refreshActivations: vi.fn(),
    realtimeDegraded: false,
    reconnectRealtime: vi.fn(),
  })),
  AppProvider: ({ children }: any) => children,
}));
