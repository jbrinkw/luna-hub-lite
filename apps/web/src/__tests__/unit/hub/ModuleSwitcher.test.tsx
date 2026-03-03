import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useAppContext } from '../../../shared/AppProvider';
import { ModuleSwitcher } from '../../../components/ModuleSwitcher';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockUseAppContext = vi.mocked(useAppContext);

describe('ModuleSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAppContext.mockReturnValue({
      activations: { coachbyte: true, chefbyte: true },
      online: true,
      lastSynced: null,
      refreshActivations: vi.fn(),
    });
  });

  it('always shows Hub', () => {
    mockUseAppContext.mockReturnValue({
      activations: {},
      online: true,
      lastSynced: null,
      refreshActivations: vi.fn(),
    });

    render(
      <MemoryRouter initialEntries={['/hub']}>
        <ModuleSwitcher />
      </MemoryRouter>,
    );
    expect(screen.getByText('Hub')).toBeInTheDocument();
  });

  it('shows activated modules only', () => {
    mockUseAppContext.mockReturnValue({
      activations: { coachbyte: true },
      online: true,
      lastSynced: null,
      refreshActivations: vi.fn(),
    });

    render(
      <MemoryRouter initialEntries={['/hub']}>
        <ModuleSwitcher />
      </MemoryRouter>,
    );
    expect(screen.getByText('CoachByte')).toBeInTheDocument();
    expect(screen.queryByText('ChefByte')).not.toBeInTheDocument();
  });

  it('shows all modules when both active', () => {
    render(
      <MemoryRouter initialEntries={['/hub']}>
        <ModuleSwitcher />
      </MemoryRouter>,
    );
    expect(screen.getByText('Hub')).toBeInTheDocument();
    expect(screen.getByText('CoachByte')).toBeInTheDocument();
    expect(screen.getByText('ChefByte')).toBeInTheDocument();
  });

  it('navigates when a segment button is clicked', () => {
    render(
      <MemoryRouter initialEntries={['/hub']}>
        <ModuleSwitcher />
      </MemoryRouter>,
    );

    // Click the CoachByte segment button (role="tab" with data-value="/coach")
    const coachTab = screen.getByText('CoachByte').closest('[role="tab"]')!;
    fireEvent.click(coachTab);

    expect(mockNavigate).toHaveBeenCalledWith('/coach');
  });

  it('highlights the current segment based on route', () => {
    render(
      <MemoryRouter initialEntries={['/coach/today']}>
        <ModuleSwitcher />
      </MemoryRouter>,
    );

    // The IonSegment mock sets data-value to the computed current path
    const segment = screen.getByRole('tablist');
    expect(segment).toHaveAttribute('data-value', '/coach');
  });
});
