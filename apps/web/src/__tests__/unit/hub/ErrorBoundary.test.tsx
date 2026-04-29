import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from '../../../components/ErrorBoundary';
import { RELOAD_FLAG } from '@/shared/lazyWithReload';

function ThrowingComponent({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('Test error');
  return <div>Working</div>;
}

function ThrowingWithError({ error }: { error: Error }): never {
  throw error;
}

describe('ErrorBoundary', () => {
  const originalError = console.error;
  let reloadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    console.error = vi.fn();
    sessionStorage.clear();
    reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(() => {
    console.error = originalError;
  });

  it('renders children when no error', () => {
    render(
      <ErrorBoundary module="Test">
        <div>Content</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('Content')).toBeInTheDocument();
  });

  it('shows fallback UI on error with module name', () => {
    render(
      <ErrorBoundary module="CoachByte">
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByText(/CoachByte/)).toBeInTheDocument();
    expect(screen.getByText(/Test error/)).toBeInTheDocument();
  });

  it('recovers when retry is clicked', () => {
    let shouldThrow = true;
    function Toggleable() {
      if (shouldThrow) throw new Error('fail');
      return <div>Recovered</div>;
    }

    render(
      <ErrorBoundary module="Test">
        <Toggleable />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    shouldThrow = false;
    fireEvent.click(screen.getByText(/retry/i));
    expect(screen.getByText('Recovered')).toBeInTheDocument();
  });
});

describe('ErrorBoundary — stale-bundle (chunk-load after reload attempt)', () => {
  const originalError = console.error;
  let reloadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    console.error = vi.fn();
    sessionStorage.clear();
    reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(() => {
    console.error = originalError;
  });

  it('shows "App was updated" UI when chunk error occurs and reload flag is set', () => {
    sessionStorage.setItem(RELOAD_FLAG, '1');
    const chunkErr = Object.assign(
      new Error('Failed to fetch dynamically imported module: /assets/ChefRoutes-abc.js'),
      { name: 'Error' },
    );

    render(
      <ErrorBoundary module="ChefByte">
        <ThrowingWithError error={chunkErr} />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/app was updated/i)).toBeInTheDocument();
    expect(screen.getByText(/no longer available/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /load new version/i })).toBeInTheDocument();
    // Standard error UI should NOT appear
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  it('clicking "Load new version" clears the flag and calls reload', () => {
    sessionStorage.setItem(RELOAD_FLAG, '1');
    const chunkErr = Object.assign(
      new Error('Failed to fetch dynamically imported module: /assets/ChefRoutes-abc.js'),
      { name: 'Error' },
    );

    render(
      <ErrorBoundary module="ChefByte">
        <ThrowingWithError error={chunkErr} />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: /load new version/i }));

    expect(sessionStorage.getItem(RELOAD_FLAG)).toBeNull();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('shows normal error UI for chunk error when reload flag is NOT set', () => {
    // Flag not set → this is the first failure; lazyWithReload would have called
    // reload already. ErrorBoundary still shows normal error UI in this case
    // (the never-resolving promise prevents reaching the boundary in practice,
    // but we guard for robustness).
    const chunkErr = Object.assign(new Error('Failed to fetch dynamically imported module: /assets/foo.js'), {
      name: 'Error',
    });

    render(
      <ErrorBoundary module="Hub">
        <ThrowingWithError error={chunkErr} />
      </ErrorBoundary>,
    );

    expect(screen.queryByText(/app was updated/i)).not.toBeInTheDocument();
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  });
});
