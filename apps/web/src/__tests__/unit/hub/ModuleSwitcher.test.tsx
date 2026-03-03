import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useAppContext } from '../../../shared/AppProvider';
import { ModuleSwitcher } from '../../../components/ModuleSwitcher';

const mockUseAppContext = vi.mocked(useAppContext);

describe('ModuleSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mockUseAppContext.mockReturnValue({
      activations: { coachbyte: true, chefbyte: true },
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
    expect(screen.getByText('CoachByte')).toBeInTheDocument();
    expect(screen.getByText('ChefByte')).toBeInTheDocument();
  });
});
