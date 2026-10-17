/**
 * jsdom lays nothing out, and virtua sizes its viewport from a ResizeObserver entry whose target
 * has an `offsetParent` — which jsdom never sets. Without one the virtualized GitHub list
 * (hearsay-tools/cezarion#1183) mounts no rows at all. This observer reports a tall viewport for
 * the list's scroll owner (`gh-list`, or the shell's `main` that wraps it) so every test row
 * mounts through the real `Virtualizer`; every other observed element (floating-ui, the
 * workspace geometry effect) stays inert, exactly as the old no-op stub left it.
 */
export const LIST_VIEWPORT_PX = 20_000

export class ListViewportResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(element: Element): void {
    if (!element.matches('[data-slot="gh-list"], [data-slot="main"]')) return
    Object.defineProperty(element, 'offsetParent', { configurable: true, get: () => element.ownerDocument.body })
    queueMicrotask(() => this.callback(
      [{ target: element, contentRect: { width: 1_024, height: LIST_VIEWPORT_PX } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    ))
  }

  unobserve(): void {}
  disconnect(): void {}
}
