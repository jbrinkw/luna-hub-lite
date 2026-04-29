/**
 * HUB-O-01: Unit tests for OAuthConsent component.
 *
 * The OAuthConsent page is the only OAuth-facing UI in the SPA. It calls
 * supabase.auth.oauth.getAuthorizationDetails, approveAuthorization, and
 * denyAuthorization. Before this test file, there was zero coverage for
 * these code paths.
 *
 * Covers:
 *  (a) Loading state shown on mount
 *  (b) Missing authorization_id parameter renders error
 *  (c) Unauthenticated user redirected to /login with return URL
 *  (d) getAuthorizationDetails API failure → error card renders with message
 *  (e) Already-consented path (data.redirect_url present) triggers redirect
 *  (f) Happy-path: details rendered (client name, redirect URI, scopes)
 *  (g) Approve fires redirect to data.redirect_url
 *  (h) Deny fires redirect to data.redirect_url
 *  (i) Approve API failure → error message shown in card
 *  (j) Deny API failure → error message shown in card
 *  (k) Missing supabase.auth.oauth property (SDK version mismatch) → error card
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// -- navigate mock --
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

// -- supabase oauth API mock --
const mockGetAuthorizationDetails = vi.fn();
const mockApproveAuthorization = vi.fn();
const mockDenyAuthorization = vi.fn();

vi.mock('@/shared/supabase', () => ({
  supabase: {
    auth: {
      get oauth() {
        return {
          getAuthorizationDetails: mockGetAuthorizationDetails,
          approveAuthorization: mockApproveAuthorization,
          denyAuthorization: mockDenyAuthorization,
        };
      },
    },
  },
}));

// -- useAuth mock (full AuthContextType shape) --
type AuthShape = {
  user: { id: string; email: string } | null;
  session: object | null;
  loading: boolean;
  sessionError: null;
  clearSessionError: () => void;
  signIn: () => void;
  signUp: () => void;
  signOut: () => void;
};
let mockAuthShape: AuthShape = {
  user: { id: 'user-1', email: 'user@example.com' },
  session: {
    access_token: 'test-access-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'user-1', email: 'user@example.com' },
  },
  loading: false,
  sessionError: null,
  clearSessionError: vi.fn(),
  signIn: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
};
vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => mockAuthShape,
}));

// -- window.location.href mock --
const originalLocation = window.location;
let assignedHref = '';

// Import OAuthConsent AFTER mocks are set up
import { OAuthConsent } from '@/pages/OAuthConsent';

function renderConsent(authorizationId: string | null = 'auth-id-123') {
  const search = authorizationId ? `?authorization_id=${authorizationId}` : '';
  return render(
    <MemoryRouter initialEntries={[`/oauth/consent${search}`]}>
      <OAuthConsent />
    </MemoryRouter>,
  );
}

describe('OAuthConsent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assignedHref = '';
    // Mock window.location.href setter
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        get href() {
          return assignedHref;
        },
        set href(v: string) {
          assignedHref = v;
        },
      },
    });

    // Default auth: logged-in user
    mockAuthShape = {
      user: { id: 'user-1', email: 'user@example.com' },
      session: {
        access_token: 'test-access-token',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: 'user-1', email: 'user@example.com' },
      },
      loading: false,
      sessionError: null,
      clearSessionError: vi.fn(),
      signIn: vi.fn(),
      signUp: vi.fn(),
      signOut: vi.fn(),
    };
  });

  it('(a) shows loading state while fetching authorization details', async () => {
    // Never resolves — stays in loading state
    mockGetAuthorizationDetails.mockReturnValue(new Promise(() => {}));
    renderConsent();

    expect(screen.getByText(/loading authorization details/i)).toBeInTheDocument();
  });

  it('(b) renders error card when authorization_id query param is missing', () => {
    renderConsent(null);

    expect(screen.getByText(/missing authorization_id parameter/i)).toBeInTheDocument();
    // getAuthorizationDetails must NOT be called — no ID to fetch
    expect(mockGetAuthorizationDetails).not.toHaveBeenCalled();
  });

  it('(c) redirects unauthenticated user to /login with return URL', async () => {
    mockAuthShape = { ...mockAuthShape, user: null, session: null };
    renderConsent('auth-id-unauthenticated');

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        expect.stringContaining('/login'),
        expect.objectContaining({ replace: true }),
      );
    });
    const [path] = mockNavigate.mock.calls[0] as [string, ...unknown[]];
    expect(path).toContain('redirect=');
    // The redirect param is URL-encoded, so authorization_id=... becomes authorization_id%3D...
    expect(decodeURIComponent(path)).toContain('authorization_id=auth-id-unauthenticated');
  });

  it('(d) shows error card when getAuthorizationDetails returns an error', async () => {
    mockGetAuthorizationDetails.mockResolvedValue({
      data: null,
      error: { message: 'Authorization not found' },
    });
    renderConsent();

    await waitFor(() => {
      expect(screen.getByText('Authorization not found')).toBeInTheDocument();
    });
  });

  it('(e) already-consented path: immediate redirect when data.redirect_url present', async () => {
    mockGetAuthorizationDetails.mockResolvedValue({
      data: { redirect_url: 'https://client.example.com/callback?code=abc' },
      error: null,
    });
    renderConsent();

    await waitFor(() => {
      expect(assignedHref).toBe('https://client.example.com/callback?code=abc');
    });
  });

  it('(f) happy path: renders client name, redirect URI, and scopes', async () => {
    mockGetAuthorizationDetails.mockResolvedValue({
      data: {
        client: { name: 'Claude Desktop' },
        redirect_uri: 'http://localhost:5173/callback',
        scope: 'read write',
      },
      error: null,
    });
    renderConsent();

    await waitFor(() => {
      expect(screen.getByText(/Claude Desktop/)).toBeInTheDocument();
    });
    expect(screen.getByText(/http:\/\/localhost:5173\/callback/)).toBeInTheDocument();
    expect(screen.getByText(/read write/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument();
  });

  it('(g) clicking Approve triggers redirect to approval redirect_url', async () => {
    mockGetAuthorizationDetails.mockResolvedValue({
      data: { client: { name: 'My App' }, redirect_uri: 'http://localhost/cb', scope: 'read' },
      error: null,
    });
    mockApproveAuthorization.mockResolvedValue({
      data: { redirect_url: 'http://localhost/cb?code=approval-code' },
      error: null,
    });
    renderConsent();

    await waitFor(() => screen.getByRole('button', { name: /approve/i }));
    await userEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => {
      expect(mockApproveAuthorization).toHaveBeenCalledWith('auth-id-123');
      expect(assignedHref).toBe('http://localhost/cb?code=approval-code');
    });
  });

  it('(h) clicking Deny triggers redirect to denial redirect_url', async () => {
    mockGetAuthorizationDetails.mockResolvedValue({
      data: { client: { name: 'My App' }, redirect_uri: 'http://localhost/cb', scope: '' },
      error: null,
    });
    mockDenyAuthorization.mockResolvedValue({
      data: { redirect_url: 'http://localhost/cb?error=access_denied' },
      error: null,
    });
    renderConsent();

    await waitFor(() => screen.getByRole('button', { name: /deny/i }));
    await userEvent.click(screen.getByRole('button', { name: /deny/i }));

    await waitFor(() => {
      expect(mockDenyAuthorization).toHaveBeenCalledWith('auth-id-123');
      expect(assignedHref).toBe('http://localhost/cb?error=access_denied');
    });
  });

  it('(i) approve API failure → error message shown in card', async () => {
    mockGetAuthorizationDetails.mockResolvedValue({
      data: { client: { name: 'My App' }, redirect_uri: 'http://localhost/cb', scope: 'read' },
      error: null,
    });
    mockApproveAuthorization.mockResolvedValue({
      data: null,
      error: { message: 'Authorization code already used' },
    });
    renderConsent();

    await waitFor(() => screen.getByRole('button', { name: /approve/i }));
    await userEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => {
      expect(screen.getByText('Authorization code already used')).toBeInTheDocument();
    });
    // Must not have redirected
    expect(assignedHref).toBe('');
  });

  it('(j) deny API failure → error message shown in card', async () => {
    mockGetAuthorizationDetails.mockResolvedValue({
      data: { client: { name: 'My App' }, redirect_uri: 'http://localhost/cb', scope: 'read' },
      error: null,
    });
    mockDenyAuthorization.mockResolvedValue({
      data: null,
      error: { message: 'Session expired during denial' },
    });
    renderConsent();

    await waitFor(() => screen.getByRole('button', { name: /deny/i }));
    await userEvent.click(screen.getByRole('button', { name: /deny/i }));

    await waitFor(() => {
      expect(screen.getByText('Session expired during denial')).toBeInTheDocument();
    });
    expect(assignedHref).toBe('');
  });

  it('(k) supabase.auth.oauth undefined (SDK mismatch) → error card with message', async () => {
    // Simulate the case where the oauth property does not exist on supabase.auth
    // (SDK version mismatch). The component uses (supabase.auth as any).oauth.xxx
    // so a TypeError is thrown, caught by the catch block, and rendered as an error.
    mockGetAuthorizationDetails.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'getAuthorizationDetails')");
    });
    renderConsent();

    await waitFor(() => {
      // The catch (e: any) block sets setError(e.message || 'Failed to load...')
      expect(
        screen.getByText(/Cannot read properties of undefined|Failed to load authorization details/i),
      ).toBeInTheDocument();
    });
  });
});
