import { subscribeLive } from './live-coordinator'

/** Named-event adapter lets the workspace reducers keep their existing wire contract. */
export class LiveWorkspaceSource extends EventTarget {
  readyState = 0
  private release: () => void
  constructor(_url?: string, _options?: { withCredentials?: boolean }) {
    super()
    const ready = () => queueMicrotask(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.dispatchEvent(new Event('open'))
    })
    this.release = subscribeLive({ kind: 'workspace' }, {
      ready,
      reset: () => { if (this.readyState !== 2) { this.readyState = 0; ready() } },
      frame: frame => {
        if ('data' in frame && frame.event === 'reconnect') { this.readyState = 0; ready(); return }
        if ('data' in frame) this.dispatchEvent(new MessageEvent(frame.event, { data: frame.data }))
      },
    })
  }
  close() { this.readyState = 2; this.release() }
}
