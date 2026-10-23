import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State { error: Error | null }

/** Last-resort guard so a render crash shows a recoverable message instead of a blank screen. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) { console.error('UI crash', error, info.componentStack); }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <pre className="max-w-2xl overflow-auto rounded-lg border border-border bg-surface-2 p-3 text-left text-xs text-muted">{this.state.error.stack ?? this.state.error.message}</pre>
        <button className="rounded-lg bg-accent px-3 py-1.5 text-sm text-accent-fg" onClick={() => { this.setState({ error: null }); location.assign('/chat'); }}>Reload app</button>
      </div>
    );
  }
}
