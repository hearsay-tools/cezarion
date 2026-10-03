import type { AgentBrowser } from './agent-browser'

type Appearance = { theme?: string; width?: string; idle?: boolean }

/** Readiness plus geometry in one sample. Held loading fixtures deliberately omit idle. */
export function visualSampleExpression(selector: string, { theme, width, idle = false }: Appearance = {}): string {
  return `(() => {
    const root = document.documentElement, target = document.querySelector(${JSON.stringify(selector)});
    if (!target || document.fonts?.status !== 'loaded') return null;
    // #795/#758: box reads can force layout in skipped content-visibility subtrees.
    // Observe native rendering BEFORE reading any geometry, including descendants.
    if (!target.checkVisibility({ contentVisibilityAuto: true })) return null;
    if (${JSON.stringify(theme)} && root.classList.contains('light') !== (${JSON.stringify(theme)} === 'light')) return null;
    if (${JSON.stringify(width)} && root.dataset.width !== ${JSON.stringify(width)}) return null;
    if (${idle} && window.__cezIdle !== true) return null;
    const elements = [target, ...target.querySelectorAll('*')];
    for (let el = target.parentElement; el; el = el.parentElement) elements.push(el);
    if (elements.some(el => el.getAnimations().some(a => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity))) return null;
    // Infinite spinners are valid loading state. Their transformed ink moves, while the
    // enclosing layout box and all surrounding content must still remain stable.
    const movingInk = el => {
      for (let node = el; node && node !== target.parentElement; node = node.parentElement)
        if (node.getAnimations().some(a => a.playState === 'running' && a.effect?.getComputedTiming().iterations === Infinity)) return true;
      return false;
    };
    const rect = el => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
    const box = target.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    return { boxes: elements.filter(el => el.checkVisibility({ contentVisibilityAuto: true }) && !movingInk(el)).map(rect), text: target.textContent, scrollWidth: root.scrollWidth, viewport: innerWidth };
  })()`
}

export function settleVisual(browser: AgentBrowser, selector: string, appearance: Appearance = {}): void {
  browser.waitForStable(visualSampleExpression(selector, appearance), { holdMs: 200 })
}

/**
 * #795: a mounted control or the first truth is not a settled layout. Reuse the
 * #764 visual signature and #415 hold, keeping readiness and the measurement in
 * ONE browser task. False/zero are valid measurements: assertions stay outside
 * the matcher. Never pass contrast, line-height or coverage limits as readiness.
 * Lazy transcript targets must scroll and checkVisibility BEFORE box reads in
 * their measurement expression, as chat-code-fence (#758) does.
 */
export function settledSampleExpression(expression: string, selector = 'body'): string {
  return `(() => {
    const layout = ${visualSampleExpression(selector)};
    if (!layout) return null;
    const active = document.activeElement;
    const focus = active ? [...document.querySelectorAll('*')].indexOf(active) : -1;
    const value = (${expression});
    if (value === null || value === undefined) return null;
    return { layout, focus, value };
  })()`
}

export function waitForSettledSample<T = unknown>(
  browser: AgentBrowser,
  expression: string,
  matcher: (value: T) => boolean = () => true,
  selector = 'body',
): T {
  const sample = browser.waitForStable<{ value: T } | null>(settledSampleExpression(expression, selector), {
    holdMs: 200,
    matcher: sample => sample !== null && matcher(sample.value),
  })
  // waitForStable's matcher rejects null; keep the narrowing explicit for callers.
  if (sample === null) throw new Error('settled sample unexpectedly absent')
  return sample.value
}
