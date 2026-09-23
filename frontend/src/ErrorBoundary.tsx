import { Component, type ErrorInfo, type ReactNode } from 'react';
import { trackException } from './telemetry';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    trackException(error, { componentStack: info.componentStack ?? '' });
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="no-access" role="alert">
        <h1>Something went wrong</h1>
        <p>This screen stopped working. Reload the page to try again.</p>
      </div>
    );
  }
}
