import { Component, type ReactNode } from 'react';
import { RELOAD_FLAG } from '@/shared/lazyWithReload';

interface Props {
  module: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  isStaleBundle: boolean;
}

function isChunkLoadError(err: Error): boolean {
  return (
    /Failed to fetch dynamically imported module/i.test(err.message) ||
    /ChunkLoadError/i.test(err.name) ||
    /Loading chunk \d+ failed/i.test(err.message)
  );
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, isStaleBundle: false };
  }

  static getDerivedStateFromError(error: Error): State {
    const chunkError = isChunkLoadError(error);
    const reloadAlreadyAttempted = !!sessionStorage.getItem(RELOAD_FLAG);
    return {
      hasError: true,
      error,
      // Stale-bundle UI only when: chunk error AND we already tried a reload
      isStaleBundle: chunkError && reloadAlreadyAttempted,
    };
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, isStaleBundle: false });
  };

  handleForceReload = () => {
    sessionStorage.removeItem(RELOAD_FLAG);
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.state.isStaleBundle) {
        return (
          <div className="p-8 text-center">
            <h2 className="text-lg font-semibold text-text mb-2">App was updated</h2>
            <p className="text-text-secondary mb-4">
              The previous version is no longer available. Click below to load the new version.
            </p>
            <button
              onClick={this.handleForceReload}
              className="px-4 py-2 bg-primary text-primary-text rounded-lg font-medium hover:bg-primary-hover transition-colors"
            >
              Load new version
            </button>
          </div>
        );
      }

      return (
        <div className="p-8 text-center">
          <h2 className="text-danger-text text-lg font-semibold mb-2">Something went wrong in {this.props.module}</h2>
          <p className="text-danger-text mb-4">{this.state.error?.message}</p>
          <button
            onClick={this.handleRetry}
            className="px-4 py-2 bg-primary text-primary-text rounded-lg font-medium hover:bg-primary-hover transition-colors"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
