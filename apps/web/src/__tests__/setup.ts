import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Mock AppProvider (provides default activation + online state for all tests)
vi.mock('@/shared/AppProvider', () => ({
  useAppContext: vi.fn(() => ({
    activations: { coachbyte: true, chefbyte: true },
    online: true,
    lastSynced: new Date(),
    dayStartHour: 0,
    refreshActivations: vi.fn(),
  })),
  AppProvider: ({ children }: any) => children,
}));
