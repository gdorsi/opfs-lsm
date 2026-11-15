import { Component, Suspense, type ReactNode } from "react";

/** fate's hooks suspend while data loads and throw what a read could not fetch; a screen shows either here. */
export function Loading({ fallback, children }: { fallback: ReactNode; children: ReactNode }) {
  return (
    <ReadErrors>
      <Suspense fallback={fallback}>{children}</Suspense>
    </ReadErrors>
  );
}

class ReadErrors extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="load-error" role="alert">
        <span>Could not load: {this.state.error.message}</span>
        <button className="btn" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
