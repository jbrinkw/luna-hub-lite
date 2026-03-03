import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SettingsPage } from '@/pages/coachbyte/SettingsPage';

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1' }, signOut: vi.fn() }),
}));

const mockSettings = {
  default_rest_seconds: 90,
  bar_weight_lbs: 45,
  available_plates: [45, 35, 25, 10, 5, 2.5],
};

const mockExercises = [
  { exercise_id: 'ex-1', name: 'Bench Press', user_id: null },
  { exercise_id: 'ex-2', name: 'Squat', user_id: null },
  { exercise_id: 'ex-3', name: 'My Custom Lift', user_id: 'u1' },
];

const mockChain: any = {};
const chainMethods = ['select', 'eq', 'order', 'or', 'single', 'update', 'insert', 'delete'];
chainMethods.forEach(m => { mockChain[m] = vi.fn(() => mockChain); });
mockChain.then = vi.fn((cb: any) => cb({ data: mockExercises }));
mockChain.single.mockReturnValue({ data: mockSettings, error: null });

vi.mock('@/shared/supabase', () => ({
  supabase: {
    schema: () => ({
      from: () => mockChain,
    }),
    channel: () => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() }),
    removeChannel: vi.fn(),
  },
}));

describe('SettingsPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders settings cards after loading', async () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByTestId('defaults-card')).toBeInTheDocument();
    });
    expect(screen.getByTestId('plate-calc-card')).toBeInTheDocument();
    expect(screen.getByTestId('exercise-library-card')).toBeInTheDocument();
  });

  it('renders default rest duration input', async () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByTestId('default-rest-input')).toBeInTheDocument();
    });
  });

  it('renders bar weight input', async () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByTestId('bar-weight-input')).toBeInTheDocument();
    });
  });

  it('renders exercise library with global and custom exercises', async () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByTestId('exercise-list')).toBeInTheDocument();
    });
    expect(screen.getByTestId('exercise-ex-1')).toHaveTextContent('Bench Press');
    expect(screen.getByTestId('exercise-ex-1')).toHaveTextContent('global');
    expect(screen.getByTestId('exercise-ex-3')).toHaveTextContent('My Custom Lift');
    expect(screen.getByTestId('exercise-ex-3')).toHaveTextContent('custom');
  });

  it('shows delete button only for custom exercises', async () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByTestId('exercise-list')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('delete-exercise-ex-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('delete-exercise-ex-3')).toBeInTheDocument();
  });
});
