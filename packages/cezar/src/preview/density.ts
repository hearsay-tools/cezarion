import type { Cdp } from './cdp.ts';

/**
 * The pixel density a page renders and streams at (hearsay-tools/cezarion#2069). An emulated
 * `deviceScaleFactor` alone is not enough: the screencast scales each frame back to CSS pixels.
 * A window on a screen at that pixel ratio streams frames at the full size, so `place` moves the
 * page's window onto an emulated screen at the ratio, and back to the primary screen for 1. The
 * page keeps its document, scroll and form state through a move.
 *
 * Screens belong to the browser, not to a CDP session: a session opened on a page another session
 * moved finds the window on the extra screen. The first placement therefore reads the screens, and
 * moves the window back when any extra screen exists. A Chromium without these commands streams at
 * scale 1, as before.
 */

type ScreenInfo = { id: string; availLeft: number; availTop: number; devicePixelRatio: number; isPrimary: boolean };

/** Emulated screens sit far to the right of the primary screen, one beside the other, so no two overlap. */
const SCREEN_ORIGIN = 100_000;
const SCREEN_STRIDE = 20_000;
/** Physical pixels: at ratio 2 this is 8000 CSS pixels square, more than the largest viewport (4000). */
const SCREEN_SIZE = 16_000;
/** Chromium may hand a ratio back with float noise (10/9 stored as a float), so a screen at the ratio matches within this. */
const RATIO_EPSILON = 1e-6;

export class PixelDensity {
  /** The ratio the window was last placed at; undefined until the first placement read the screens. */
  private placed?: number | undefined;
  private windowId?: number | undefined;
  /** Chromium refused a density command: everything streams at scale 1 from now on. */
  private unsupported = false;
  /** The window sits on an emulated screen: a move back to the primary screen is still owed. */
  private moved = false;

  /** Whether the window still sits on an emulated screen, so the page renders above scale 1. */
  get onExtraScreen(): boolean {
    return this.moved;
  }

  constructor(private readonly cdp: Cdp) {}

  /** Places the window for `scale` and resolves with the scale the page renders at: `scale`, or 1 when Chromium cannot. */
  async place(scale: number): Promise<number> {
    if (this.unsupported) return 1;
    if (scale === this.placed) return scale;
    try {
      const { screenInfos } = await this.cdp.send<{ screenInfos: ScreenInfo[] }>('Emulation.getScreenInfos');
      if (scale === 1 && this.placed === undefined && screenInfos.length <= 1) {
        this.placed = 1;
        return 1;
      }
      const screen = scale === 1 ? screenInfos.find(info => info.isPrimary) : (screenInfos.find(info => !info.isPrimary && Math.abs(info.devicePixelRatio - scale) < RATIO_EPSILON) ?? (await this.addScreen(scale, screenInfos)));
      if (!screen) throw new Error('no primary screen');
      this.windowId ??= (await this.cdp.send<{ windowId: number }>('Browser.getWindowForTarget')).windowId;
      await this.cdp.send('Browser.setWindowBounds', { windowId: this.windowId, bounds: { left: screen.availLeft, top: screen.availTop } });
      this.placed = scale;
      this.moved = scale !== 1;
      return scale;
    } catch {
      // A failed move back from an emulated screen is a failed move, not a missing feature: the
      // next placement tries again. Any other refusal turns density off for this session.
      if (scale === 1 && this.moved) this.placed = undefined;
      else this.unsupported = true;
      return 1;
    }
  }

  private async addScreen(ratio: number, screens: ScreenInfo[]): Promise<ScreenInfo> {
    const left = SCREEN_ORIGIN + (screens.length - 1) * SCREEN_STRIDE;
    const { screenInfo } = await this.cdp.send<{ screenInfo: ScreenInfo }>('Emulation.addScreen', { left, top: 0, width: SCREEN_SIZE, height: SCREEN_SIZE, devicePixelRatio: ratio });
    return screenInfo;
  }
}
