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
/** A started stream with no frame after this long is restarted: Chromium can stay silent after back-to-back restarts on a page that no longer changes. */
const FIRST_FRAME_WAIT_MS = 500;
const FIRST_FRAME_RETRIES = 5;
/**
 * Page activity (a click, a key, a navigation, a load step) with no frame after it this long restarts
 * the stream. Chromium can paint once and then go silent, so the pane kept the first frame for good,
 * and a first paint after the first-frame retries never reached it (#870).
 */
const ACTIVITY_FRAME_WAIT_MS = 1000;
/** Input that can change what the page shows. A pointer move alone is too frequent to count. */
const ACTIVE_MOUSE = new Set(['mousePressed', 'mouseReleased', 'mouseWheel']);

/**
 * The pixel size of a JPEG frame, from its first baseline/progressive SOF segment; undefined when
 * the bytes are not a JPEG this can read. Screencast metadata is no help: it can report the
 * requested size for a frame captured before the page resized.
 */
function jpegSize(base64: string): { w: number; h: number } | undefined {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return at + 9 <= bytes.length ? { h: bytes.readUInt16BE(at + 5), w: bytes.readUInt16BE(at + 7) } : undefined;
    }
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return undefined;
}

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
  /** Viewport changes and screencast stops run one at a time: overlapping stop/start pairs can leave Chromium without a first frame. */
  private queue: Promise<void> = Promise.resolve();
  /** The size the running screencast was started at; unset while stopped. */
  private streaming?: { w: number; h: number };
  private watchdog?: ReturnType<typeof setTimeout>;
  private silentStarts = 0;
  /** The top-level frame, so a subframe's load steps do not count as page activity. */
  private mainFrameId?: string;

  private constructor(
    private readonly cdp: Cdp,
    private readonly opts: { onFirstFrame?: (viewer: Viewer) => void },
  ) {
    cdp.on<ScreencastFrame>('Page.screencastFrame', frame => this.onFrame(frame));
    cdp.on<{ frame: { id?: string; url: string; parentId?: string } }>('Page.frameNavigated', ({ frame }) => {
      if (frame.parentId) return;
      this.mainFrameId = frame.id;
      this.url = frame.url;
      this.tell({ t: 'url', url: frame.url });
      this.expectFrame();
    });
    cdp.on<{ frameId?: string; url: string }>('Page.navigatedWithinDocument', ({ frameId, url }) => {
      if (!this.isMainFrame(frameId)) return;
      this.url = url;
      this.tell({ t: 'url', url });
      this.expectFrame();
    });
    // The page's load steps, first paint among them: the moment a page that painted late has something to show.
    cdp.on<{ frameId?: string; name: string }>('Page.lifecycleEvent', ({ frameId }) => {
      if (this.isMainFrame(frameId)) this.expectFrame();
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
    await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true });
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.addBinding', { name: '__cursor' });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT });
    return session;
  }

  /** Makes `viewer` the one the page streams to and starts the screencast at the current viewport. */
  attach(viewer: Viewer): void {
    this.viewer = viewer;
    this.announced = false;
    // A new viewer needs its own first frame, so its stream always restarts, whatever the size.
    this.streaming = undefined;
    this.silentStarts = 0;
    void this.setViewport(this.viewport.w, this.viewport.h).catch(() => {});
  }

  detach(viewer: Viewer): void {
    if (this.viewer !== viewer) return;
    this.viewer = undefined;
    this.releaseFrames();
    this.streaming = undefined;
    this.disarmWatchdog();
    this.enqueue(async () => {
      await this.cdp.send('Page.stopScreencast').catch(() => {});
    });
  }

  async navigate(url: string): Promise<void> {
    this.announced = false;
    this.expectFrame();
    await this.cdp.send('Page.navigate', { url });
  }

  close(): void {
    this.viewer = undefined;
    this.disarmWatchdog();
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
        if (ACTIVE_MOUSE.has(msg.type)) this.expectFrame();
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
        if (msg.type !== 'keyUp') this.expectFrame();
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
        this.expectFrame();
        await this.cdp.send('Input.insertText', { text: msg.text });
        return;
      case 'nav':
        return this.navigate(normalizePreviewUrl(msg.url));
      case 'reload':
        this.expectFrame();
        await this.cdp.send('Page.reload', { ignoreCache: msg.ignoreCache ?? false });
        return;
      case 'back':
      case 'forward': {
        this.expectFrame();
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

  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.queue.then(job);
    this.queue = run.catch(() => {});
    return run;
  }

  private setViewport(w: number, h: number): Promise<void> {
    // Recorded now, so an attach that follows queued resizes starts at the newest size.
    this.viewport = { w, h };
    return this.enqueue(() => this.applyViewport(w, h));
  }

  private async applyViewport(w: number, h: number): Promise<void> {
    // The pane repeats its size at every loading step; a stream already at this size has nothing to redo.
    if (this.streaming?.w === w && this.streaming.h === h) return;
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    if (!this.viewer) return;
    this.streaming = undefined;
    await this.cdp.send('Page.stopScreencast').catch(() => {});
    // A restarted screencast numbers its frames afresh; the old in-flight frame will never be acked.
    this.pending = undefined;
    this.held = undefined;
    // Set before the start: its first frame can beat the command's reply, and is judged against this size.
    this.streaming = { w, h };
    try {
      await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: w, maxHeight: h, everyNthFrame: 1 });
    } catch (error) {
      this.streaming = undefined;
      throw error;
    }
    this.armWatchdog();
  }

  /**
   * Something happened that should paint: wait for a frame, and restart the stream if none comes.
   * Each activity gets its own few tries, so a stream the start retries gave up on recovers on the
   * next click or load step. A frame at the viewport size disarms it, as after a start.
   */
  private expectFrame(): void {
    if (!this.viewer) return;
    this.silentStarts = 0;
    // Mid-restart, the start arms its own watchdog, now with fresh tries.
    if (this.streaming) this.armWatchdog(ACTIVITY_FRAME_WAIT_MS);
  }

  private isMainFrame(frameId: string | undefined): boolean {
    return frameId === undefined || this.mainFrameId === undefined || frameId === this.mainFrameId;
  }

  /** No frame, or none at the viewport size, since the last start or activity: start again, a few times, then wait for the next activity. */
  private armWatchdog(waitMs = FIRST_FRAME_WAIT_MS): void {
    this.disarmWatchdog();
    this.watchdog = setTimeout(() => {
      if (!this.viewer || !this.streaming || this.silentStarts >= FIRST_FRAME_RETRIES) return;
      this.silentStarts += 1;
      this.streaming = undefined;
      void this.setViewport(this.viewport.w, this.viewport.h).catch(() => {});
    }, waitMs);
    this.watchdog.unref?.();
  }

  private disarmWatchdog(): void {
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
  }

  /** One frame in flight per viewer. A newer frame replaces a held one, so the last visual state always arrives. */
  private onFrame(frame: ScreencastFrame): void {
    // A frame the size of the viewport settles the stream. Chromium can capture one before the page
    // has resized (646x362 for a 646x787 viewport) and send nothing after it on a static page; the
    // viewer still gets that frame, and the watchdog starts the stream again to replace it.
    const size = jpegSize(frame.data);
    const stale = size !== undefined && this.streaming !== undefined && (size.w !== this.streaming.w || size.h !== this.streaming.h);
    if (stale) {
      this.armWatchdog();
    } else {
      this.silentStarts = 0;
      this.disarmWatchdog();
    }
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
