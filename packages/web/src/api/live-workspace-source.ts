import { subscribeLive } from './live-coordinator'

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
        if ('data' in frame) this.dispatchEvent(new MessageEvent(frame.event, { data: frame.data }))
      },
    })
  }
  /**
   * Drop and re-add the workspace demand: the shared worker then treats it as a new subscription
   * and sends the stream's `ready` before any frame, and this source opens again. For a document
   * that lost its first `ready` to an epoch change (hearsay-tools/cezarion#2729).
   */
  rejoin() {
    if (this.readyState === 2) return
    this.release()
    this.readyState = 0
    this.release = this.subscribe()
  }
  close() { this.readyState = 2; this.release() }
}
