import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from '../../../components/ErrorBoundary';

function ThrowingComponent({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('Test error');
  return <div>Working</div>;
}

describe('ErrorBoundary', () => {
  const originalError = console.error;
  beforeEach(() => {
    console.error = vi.fn();
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
