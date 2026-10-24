import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Root render-error fallback with no provider or design-system dependencies. Keep app-error as
 * the stable crash marker, log the caught stack and offer reload. An absent marker does not
 * prove general application health.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The stack the boundary swallowed still belongs in the console, where a failure bundle's
    // capture and a developer's devtools both look for it.
    console.error('cezar cockpit: uncaught render error', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div
        data-slot="app-error"
        role="alert"
        style={{
          display: 'flex',
          minHeight: '100dvh',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '12px',
          padding: '24px',
          textAlign: 'center',
          font: '14px/1.5 system-ui, sans-serif',
        }}
      >
        <h1 style={{ fontSize: '20px', fontWeight: 600, margin: 0 }}>The cockpit hit an error</h1>
        <p style={{ margin: 0, maxWidth: '52ch' }}>
          Reload to carry on. Nothing on disk changed — cezar&rsquo;s state lives in{' '}
          <code>.ai/cezar/</code>, and this page never wrote to it.
        </p>
        <pre
          data-slot="app-error-detail"
          style={{ margin: 0, maxWidth: '100%', overflowX: 'auto', textAlign: 'left', opacity: 0.75 }}
        >
          {error.message}
        </pre>
        <button type="button" onClick={() => location.reload()} style={{ padding: '6px 14px', cursor: 'pointer' }}>
          Reload
        </button>
      </div>
    )
  }
}
