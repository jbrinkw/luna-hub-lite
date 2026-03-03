import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SettingsPage } from '@/pages/coachbyte/SettingsPage';

const mockUser = { id: 'u1' };
vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: mockUser, signOut: vi.fn() }),
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

/* ------------------------------------------------------------------ */
/*  Supabase mock — per-table chain routing                            */
/* ------------------------------------------------------------------ */

function getDataForTable(table: string) {
  if (table === 'user_settings') return mockSettings;
  if (table === 'exercises') return mockExercises;
  return null;
}

function makeChain(table: string) {
  const chain: any = {};
  const methods = ['select', 'eq', 'order', 'or', 'single', 'update', 'insert', 'delete'];
  methods.forEach(m => { chain[m] = vi.fn(() => chain); });
  chain.then = (resolve: any, _reject?: any) => {
    const data = getDataForTable(table);
    return resolve({ data, error: null });
  };
  // single() returns { data, error } directly — used by user_settings
  chain.single = vi.fn(() => {
    const data = getDataForTable(table);
    return { data, error: null };
  });
  return chain;
}

vi.mock('@/shared/supabase', () => ({
  supabase: {
    schema: () => ({
      from: (table: string) => makeChain(table),
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

  it('renders default rest duration input with correct mock value (90)', async () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByTestId('default-rest-input')).toBeInTheDocument();
    });
    expect(screen.getByTestId('default-rest-input')).toHaveValue(90);
  });

  it('renders bar weight input with correct mock value (45)', async () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByTestId('bar-weight-input')).toBeInTheDocument();
    });
    expect(screen.getByTestId('bar-weight-input')).toHaveValue(45);
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
