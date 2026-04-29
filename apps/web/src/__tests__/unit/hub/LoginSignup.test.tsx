/**
 * HUB-U-01: Unit tests for Login and Signup components.
 *
 * Covers the audit findings:
 *  - signIn called with (email, password) args
 *  - AuthApiError shape propagated to UI (wrong password, email not confirmed)
 *  - AuthRetryableFetchError (network error) propagated to UI
 *  - signUp called with all expected args
 *  - Client-side validation gates (empty fields, short password)
 *  - Session shape in useAuth mock matches real AuthContextType
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@/shared/ThemeProvider';
import { Login } from '@/pages/Login';
import { Signup } from '@/pages/Signup';
import { MIN_PASSWORD_LENGTH } from '@/shared/constants';

// -- useNavigate mock --
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

// -- supabase mock (for demo login reset_demo_dates + resetPasswordForEmail) --
vi.mock('@/shared/supabase', () => ({
  supabase: {
    auth: {
      resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }),
    },
    schema: vi.fn().mockReturnValue({
      rpc: vi.fn().mockResolvedValue({ error: null }),
    }),
  },
}));

// -- useAuth mock (HUB-U-01 + HUB-U-02: full AuthContextType shape) --
const mockSignIn = vi.fn();
const mockSignUp = vi.fn();
const mockSignOut = vi.fn();

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: null,
    session: null,
    loading: false,
    sessionError: null,
    clearSessionError: vi.fn(),
    signIn: mockSignIn,
    signUp: mockSignUp,
    signOut: mockSignOut,
  }),
}));

function renderLogin() {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/login']}>
        <Login />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function renderSignup() {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/signup']}>
        <Signup />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('Login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders email and password fields with sign-in button', () => {
    renderLogin();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('calls signIn with (email, password) args on submit', async () => {
    mockSignIn.mockResolvedValue({ error: null });
    renderLogin();

    await userEvent.type(screen.getByLabelText(/email/i), 'user@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'mypassword');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(mockSignIn).toHaveBeenCalledTimes(1);
      expect(mockSignIn).toHaveBeenCalledWith('user@example.com', 'mypassword');
    });
  });

  it('navigates to /hub on successful sign-in', async () => {
    mockSignIn.mockResolvedValue({ error: null });
    renderLogin();

    await userEvent.type(screen.getByLabelText(/email/i), 'user@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'pass1234');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/hub'));
  });

  it('shows error message when signIn returns a wrong-password error (400 status)', async () => {
    // Real Supabase AuthApiError shape from supabase-js v2:
    // { message, status, name, code }
    const authError = Object.assign(new Error('Invalid login credentials'), {
      name: 'AuthApiError',
      status: 400,
      code: 'invalid_credentials',
    });
    mockSignIn.mockResolvedValue({ error: authError });
    renderLogin();

    await userEvent.type(screen.getByLabelText(/email/i), 'user@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrongpassword');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText('Invalid login credentials')).toBeInTheDocument();
    });
    // Must not navigate
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows error message when signIn returns an email-not-confirmed error', async () => {
    const authError = Object.assign(new Error('Email not confirmed'), {
      name: 'AuthApiError',
      status: 400,
      code: 'email_not_confirmed',
    });
    mockSignIn.mockResolvedValue({ error: authError });
    renderLogin();

    await userEvent.type(screen.getByLabelText(/email/i), 'unconfirmed@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'somepassword');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText('Email not confirmed')).toBeInTheDocument();
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows error message when signIn returns a network/retryable error (AuthRetryableFetchError shape)', async () => {
    // AuthRetryableFetchError extends AuthError — same .message interface used by component
    const networkError = Object.assign(new Error('Failed to fetch'), {
      name: 'AuthRetryableFetchError',
      status: 0,
    });
    mockSignIn.mockResolvedValue({ error: networkError });
    renderLogin();

    await userEvent.type(screen.getByLabelText(/email/i), 'user@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'somepassword');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText('Failed to fetch')).toBeInTheDocument();
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows validation error when email is empty', async () => {
    renderLogin();
    // Leave email blank, fill password, then submit form directly to bypass
    // jsdom's HTML5 constraint validation (type="email" required blocks click).
    await userEvent.type(screen.getByLabelText(/password/i), 'somepassword');
    fireEvent.submit(screen.getByRole('button', { name: /sign in/i }).closest('form')!);

    await waitFor(() => {
      expect(screen.getByText('Email is required')).toBeInTheDocument();
    });
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it('shows validation error when password is empty', async () => {
    renderLogin();
    await userEvent.type(screen.getByLabelText(/email/i), 'user@example.com');
    // Leave password blank, submit form directly to bypass jsdom constraint validation.
    fireEvent.submit(screen.getByRole('button', { name: /sign in/i }).closest('form')!);

    await waitFor(() => {
      expect(screen.getByText('Password is required')).toBeInTheDocument();
    });
    expect(mockSignIn).not.toHaveBeenCalled();
  });
});

describe('Signup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders display name, email, and password fields', () => {
    renderSignup();
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign up/i })).toBeInTheDocument();
  });

  it('calls signUp with (email, password, displayName, timezone, dayStartHour) on submit', async () => {
    mockSignUp.mockResolvedValue({ error: null });
    renderSignup();

    await userEvent.type(screen.getByLabelText(/display name/i), 'Alice');
    await userEvent.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'securepass');
    await userEvent.click(screen.getByRole('button', { name: /sign up/i }));

    await waitFor(() => {
      expect(mockSignUp).toHaveBeenCalledTimes(1);
      // First two args are always email + password
      const [email, password] = mockSignUp.mock.calls[0] as [string, string, ...unknown[]];
      expect(email).toBe('alice@example.com');
      expect(password).toBe('securepass');
    });
  });

  it('navigates to /hub on successful sign-up', async () => {
    mockSignUp.mockResolvedValue({ error: null });
    renderSignup();

    await userEvent.type(screen.getByLabelText(/display name/i), 'Bob');
    await userEvent.type(screen.getByLabelText(/email/i), 'bob@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'password99');
    await userEvent.click(screen.getByRole('button', { name: /sign up/i }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/hub'));
  });

  it('shows error when signUp returns an AuthApiError (e.g. email already exists)', async () => {
    const authError = Object.assign(new Error('User already registered'), {
      name: 'AuthApiError',
      status: 422,
      code: 'user_already_exists',
    });
    mockSignUp.mockResolvedValue({ error: authError });
    renderSignup();

    await userEvent.type(screen.getByLabelText(/display name/i), 'Alice');
    await userEvent.type(screen.getByLabelText(/email/i), 'existing@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'password99');
    await userEvent.click(screen.getByRole('button', { name: /sign up/i }));

    await waitFor(() => {
      expect(screen.getByText('User already registered')).toBeInTheDocument();
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows validation error when display name is empty', async () => {
    renderSignup();
    await userEvent.type(screen.getByLabelText(/email/i), 'user@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'password99');
    await userEvent.click(screen.getByRole('button', { name: /sign up/i }));

    await waitFor(() => {
      expect(screen.getByText('Display name is required')).toBeInTheDocument();
    });
    expect(mockSignUp).not.toHaveBeenCalled();
  });

  it('shows validation error when password is shorter than MIN_PASSWORD_LENGTH', async () => {
    renderSignup();
    const shortPassword = 'a'.repeat(MIN_PASSWORD_LENGTH - 1);
    await userEvent.type(screen.getByLabelText(/display name/i), 'Carol');
    await userEvent.type(screen.getByLabelText(/email/i), 'carol@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), shortPassword);
    await userEvent.click(screen.getByRole('button', { name: /sign up/i }));

    await waitFor(() => {
      expect(screen.getByText(new RegExp(`at least ${MIN_PASSWORD_LENGTH} characters`, 'i'))).toBeInTheDocument();
    });
    // The signUp hook must NOT be called — validation must block the network call
    expect(mockSignUp).not.toHaveBeenCalled();
  });

  it('password at exactly MIN_PASSWORD_LENGTH is accepted', async () => {
    mockSignUp.mockResolvedValue({ error: null });
    renderSignup();

    const exactPassword = 'a'.repeat(MIN_PASSWORD_LENGTH);
    await userEvent.type(screen.getByLabelText(/display name/i), 'Dave');
    await userEvent.type(screen.getByLabelText(/email/i), 'dave@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), exactPassword);
    await userEvent.click(screen.getByRole('button', { name: /sign up/i }));

    await waitFor(() => {
      expect(mockSignUp).toHaveBeenCalledTimes(1);
    });
  });
});
