import { Component, type ReactNode } from 'react';
import { IonButton, IonText } from '@ionic/react';

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
        <div style={{ padding: '32px', textAlign: 'center' }}>
          <IonText color="danger">
            <h2>Something went wrong in {this.props.module}</h2>
            <p>{this.state.error?.message}</p>
          </IonText>
          <IonButton onClick={this.handleRetry}>Retry</IonButton>
        </div>
      );
    }
    return this.props.children;
  }
}
