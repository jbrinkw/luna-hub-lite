import { Component, type ReactNode } from 'react';

interface Props {
  module: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
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
