import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSignUp = vi.fn();
const mockNavigate = vi.fn();

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    signUp: mockSignUp,
    user: null,
    loading: false,
  }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { Signup } from '@/pages/Signup';

function renderSignup() {
  return render(
    <MemoryRouter>
      <Signup />
    </MemoryRouter>,
  );
}

describe('Signup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows validation error on empty display name', async () => {
    renderSignup();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /sign up/i }));

    expect(screen.getByText(/display name is required/i)).toBeInTheDocument();
    expect(mockSignUp).not.toHaveBeenCalled();
  });

  it('shows validation error on empty email', async () => {
    renderSignup();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/display name/i), 'Test User');
    await user.click(screen.getByRole('button', { name: /sign up/i }));

    expect(screen.getByText(/email is required/i)).toBeInTheDocument();
    expect(mockSignUp).not.toHaveBeenCalled();
  });

  it('shows validation error on empty password', async () => {
    renderSignup();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/display name/i), 'Test User');
    await user.type(screen.getByLabelText(/email/i), 'test@test.com');
    await user.click(screen.getByRole('button', { name: /sign up/i }));

    expect(screen.getByText(/password is required/i)).toBeInTheDocument();
    expect(mockSignUp).not.toHaveBeenCalled();
  });

  it('calls signUp with correct args on valid inputs', async () => {
    mockSignUp.mockResolvedValue({ error: null });
    renderSignup();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/display name/i), 'Test User');
    await user.type(screen.getByLabelText(/email/i), 'test@test.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign up/i }));

    expect(mockSignUp).toHaveBeenCalledWith('test@test.com', 'password123', 'Test User');
  });

  it('displays error message on duplicate email', async () => {
    mockSignUp.mockResolvedValue({ error: new Error('User already registered') });
    renderSignup();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/display name/i), 'Test User');
    await user.type(screen.getByLabelText(/email/i), 'dup@test.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign up/i }));

    await waitFor(() => {
      expect(screen.getByText(/user already registered/i)).toBeInTheDocument();
    });
  });

  it('navigates to /hub on success', async () => {
    mockSignUp.mockResolvedValue({ error: null });
    renderSignup();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/display name/i), 'Test User');
    await user.type(screen.getByLabelText(/email/i), 'test@test.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign up/i }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/hub');
    });
  });

  it('loading state disables submit and shows creating text', async () => {
    // Never-resolving promise to keep the component in loading state
    mockSignUp.mockReturnValue(new Promise(() => {}));
    renderSignup();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/display name/i), 'Test User');
    await user.type(screen.getByLabelText(/email/i), 'test@test.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign up/i }));

    await waitFor(() => {
      expect(screen.getByText('Creating account...')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /creating account/i })).toBeDisabled();
  });
});
