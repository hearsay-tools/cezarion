import { Component, type ErrorInfo, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'

/** A crash in the pane stays in the pane: the task view around it keeps working. */
export class PreviewErrorBoundary extends Component<{ children: ReactNode; onClose: () => void }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('cezar cockpit: the preview pane crashed', error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div data-slot="preview-pane-error" role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm font-semibold text-foreground">The preview hit an error</p>
        <p className="text-sm text-muted-foreground">The task is unaffected. Close the preview and open it again.</p>
        <Button variant="outline" onClick={this.props.onClose}>Close preview</Button>
      </div>
    )
  }
}
