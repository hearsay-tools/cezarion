import type { PreviewClientMessage, PreviewServerMessage } from '@open-mercato/cezar-contract';
import type { Cdp } from './cdp.ts';
import { normalizePreviewUrl } from './url.ts';

/**
 * One task's Chromium page (#781, spec 2026-10-02-live-preview-v1), ported from the CDP screencast
 * prototype: JPEG screencast frames with one frame in flight and the newest frame winning, the
 * whitelisted input vocabulary, dialog forwarding, and the injected script for cursor shapes and
 * same-tab popups. One viewer at a time; the host decides who that is.
 */

/** The socket side of one open pane, as the host and the session see it. */
export type Viewer = {
  sendFrame(buf: Buffer): void;
  send(msg: PreviewServerMessage): void;
  close(code: number, reason: string): void;
  userAgent: string;
};

const QUALITY = 60;
const DEFAULT_VIEWPORT = { w: 1280, h: 800 };

/**
 * Runs in every page. Popups open in the same tab (there is one page to stream), and the cursor
 * shape is reported through the `__cursor` binding because screencast frames carry no cursor.
 */
export const INJECT = `(() => {
  window.open = (u) => { if (u) location.href = u; return null; };
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[target]');
    if (a && a.target !== '_self') a.target = '_self';
  }, true);
  let last = '';
  document.addEventListener('mousemove', (e) => {
    const c = getComputedStyle(e.target).cursor;
    if (c !== last) { last = c; window.__cursor && window.__cursor(c); }
  }, true);
})();`;

type ScreencastFrame = { data: string; sessionId: number };
type DialogOpening = { type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string; url?: string; defaultPrompt?: string };

function originOf(url: string | undefined): string {
  try {
    return url ? new URL(url).origin : '';
  } catch {
    return '';
  }
}

export class PreviewSession {
  /** The page's current top-level URL, as Chromium last reported it. */
  url?: string;

  private viewer?: Viewer;
  /** The frame sent to the viewer and not yet acked. */
  private pending?: number;
  /** The newest frame that arrived while one was in flight. */
  private held?: ScreencastFrame;
  private announced = false;
  private viewport = DEFAULT_VIEWPORT;

  private constructor(
    private readonly cdp: Cdp,
    private readonly opts: { onFirstFrame?: (viewer: Viewer) => void },
  ) {
    cdp.on<ScreencastFrame>('Page.screencastFrame', frame => this.onFrame(frame));
    cdp.on<{ frame: { url: string; parentId?: string } }>('Page.frameNavigated', ({ frame }) => {
      if (frame.parentId) return;
      this.url = frame.url;
      this.tell({ t: 'url', url: frame.url });
    });
    cdp.on<{ url: string }>('Page.navigatedWithinDocument', ({ url }) => {
      this.url = url;
      this.tell({ t: 'url', url });
    });
    cdp.on<DialogOpening>('Page.javascriptDialogOpening', dialog =>
      this.tell({
        t: 'dialog',
        type: dialog.type,
        message: dialog.message,
        ...(dialog.type === 'prompt' ? { defaultPrompt: dialog.defaultPrompt ?? '' } : {}),
        origin: originOf(dialog.url ?? this.url),
      }),
    );
    cdp.on<{ name: string; payload: string }>('Runtime.bindingCalled', ({ name, payload }) => {
      if (name === '__cursor') this.tell({ t: 'cursor', cursor: payload });
    });
  }

  /** Prepares the page: events, the cursor binding and the injected script, as the prototype did. */
  static async create(cdp: Cdp, opts: { onFirstFrame?: (viewer: Viewer) => void } = {}): Promise<PreviewSession> {
    const session = new PreviewSession(cdp, opts);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.addBinding', { name: '__cursor' });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT });
    return session;
  }

  /** Makes `viewer` the one the page streams to and starts the screencast at the current viewport. */
  attach(viewer: Viewer): void {
    this.viewer = viewer;
    this.announced = false;
    void this.setViewport(this.viewport.w, this.viewport.h).catch(() => {});
  }

  detach(viewer: Viewer): void {
    if (this.viewer !== viewer) return;
    this.viewer = undefined;
    this.releaseFrames();
    void this.cdp.send('Page.stopScreencast').catch(() => {});
  }

  async navigate(url: string): Promise<void> {
    this.announced = false;
    await this.cdp.send('Page.navigate', { url });
  }

  close(): void {
    this.viewer = undefined;
    this.cdp.close();
  }

  /** The whole browser-facing surface. Everything else in CDP stays unreachable. */
  async handle(msg: PreviewClientMessage): Promise<void> {
    switch (msg.t) {
      case 'resize':
        return this.setViewport(msg.w, msg.h);
      case 'ack': {
        if (this.pending === undefined) return;
        const acked = this.pending;
        this.pending = undefined;
        const held = this.held;
        this.held = undefined;
        if (held) this.sendFrame(held);
        return this.ackFrame(acked);
      }
      case 'mouse':
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: msg.type,
          x: msg.x,
          y: msg.y,
          button: msg.button ?? 'none',
          buttons: msg.buttons ?? 0,
          clickCount: msg.clickCount ?? 0,
          deltaX: msg.deltaX ?? 0,
          deltaY: msg.deltaY ?? 0,
          modifiers: msg.modifiers ?? 0,
        });
        return;
      case 'key':
        await this.cdp.send('Input.dispatchKeyEvent', {
          type: msg.type,
          key: msg.key ?? '',
          code: msg.code ?? '',
          ...(msg.type === 'keyUp' ? {} : { text: msg.text ?? '' }),
          modifiers: msg.modifiers ?? 0,
          windowsVirtualKeyCode: msg.vk ?? 0,
          ...(msg.commands ? { commands: msg.commands } : {}),
        });
        return;
      case 'insertText':
        await this.cdp.send('Input.insertText', { text: msg.text });
        return;
      case 'nav':
        return this.navigate(normalizePreviewUrl(msg.url));
      case 'reload':
        await this.cdp.send('Page.reload', { ignoreCache: msg.ignoreCache ?? false });
        return;
      case 'back':
      case 'forward': {
        const { currentIndex, entries } = await this.cdp.send<{ currentIndex: number; entries: Array<{ id: number }> }>('Page.getNavigationHistory');
        const entry = entries[currentIndex + (msg.t === 'back' ? -1 : 1)];
        if (entry) await this.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id });
        return;
      }
      case 'dialogResult':
        await this.cdp.send('Page.handleJavaScriptDialog', { accept: msg.accept, promptText: msg.text ?? '' });
        return;
      default:
        // Server and lifecycle messages belong to the host.
        return;
    }
  }

  private async setViewport(w: number, h: number): Promise<void> {
    this.viewport = { w, h };
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    if (!this.viewer) return;
    await this.cdp.send('Page.stopScreencast').catch(() => {});
    // A restarted screencast numbers its frames afresh; the old in-flight frame will never be acked.
    this.pending = undefined;
    this.held = undefined;
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: w, maxHeight: h, everyNthFrame: 1 });
  }

  /** One frame in flight per viewer. A newer frame replaces a held one, so the last visual state always arrives. */
  private onFrame(frame: ScreencastFrame): void {
    if (!this.viewer) return void this.ackFrame(frame.sessionId);
    if (this.pending !== undefined) {
      if (this.held) void this.ackFrame(this.held.sessionId);
      this.held = frame;
      return;
    }
    this.sendFrame(frame);
  }

  private sendFrame(frame: ScreencastFrame): void {
    const viewer = this.viewer;
    if (!viewer) return void this.ackFrame(frame.sessionId);
    this.pending = frame.sessionId;
    if (!this.announced) {
      this.announced = true;
      this.opts.onFirstFrame?.(viewer);
    }
    viewer.sendFrame(Buffer.from(frame.data, 'base64'));
  }

  /** Frames owed to a viewer that left: ack them so Chromium does not stall. */
  private releaseFrames(): void {
    if (this.pending !== undefined) void this.ackFrame(this.pending);
    if (this.held) void this.ackFrame(this.held.sessionId);
    this.pending = undefined;
    this.held = undefined;
  }

  private ackFrame(sessionId: number): Promise<void> {
    return this.cdp.send('Page.screencastFrameAck', { sessionId }).then(() => {}, () => {});
  }

  private tell(msg: PreviewServerMessage): void {
    this.viewer?.send(msg);
  }
}
