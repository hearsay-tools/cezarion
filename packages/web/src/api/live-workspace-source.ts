import { requestWorkspaceReady, subscribeLive, workspaceReadyReceived } from './live-coordinator'

/** Named-event adapter lets the workspace reducers keep their existing wire contract. */
export class LiveWorkspaceSource extends EventTarget {
  readyState = 0
  private release: () => void
  constructor(_url?: string, _options?: { withCredentials?: boolean }) {
    super()
    this.release = this.subscribe()
  }
  private subscribe(): () => void {
    const ready = () => queueMicrotask(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.dispatchEvent(new Event('open'))
    })
    return subscribeLive({ kind: 'workspace' }, {
      ready,
      reset: () => { if (this.readyState !== 2) { this.readyState = 0; ready() } },
      frame: frame => {
        if ('data' in frame && frame.event === 'reconnect') { this.readyState = 0; ready(); return }
        // The shared feed dropped and is retrying: CONNECTING, as a native EventSource reports
        // between attempts. The `reconnect` that follows reopens (hearsay-tools/cezarion#1069).
        if ('data' in frame && frame.event === 'disconnect') {
          if (this.readyState === 1) { this.readyState = 0; this.dispatchEvent(new Event('error')) }
          return
        }
        if ('data' in frame && frame.event === 'ready') workspaceReadyReceived()
        if ('data' in frame) this.dispatchEvent(new MessageEvent(frame.event, { data: frame.data }))
      },
    })
  }
  /**
   * Ask the shared worker for the workspace stream's `ready` again, for a document that lost it
   * (for example to an epoch change, hearsay-tools/cezarion#2729). The demand stays, so the
   * shared stream never restarts. False without a shared worker.
   */
  requestReady(): boolean {
    return this.readyState !== 2 && requestWorkspaceReady()
  }
  close() { this.readyState = 2; this.release() }
}
