import type { AgentBrowser } from './agent-browser'

type Appearance = { theme?: string; width?: string; idle?: boolean }

/** Readiness plus geometry in one sample. Held loading fixtures deliberately omit idle. */
export function visualSampleExpression(selector: string, { theme, width, idle = false }: Appearance = {}): string {
  return `(() => {
    const root = document.documentElement, target = document.querySelector(${JSON.stringify(selector)});
    if (!target || document.fonts?.status !== 'loaded') return null;
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
    return { boxes: elements.filter(el => !movingInk(el)).map(rect), text: target.textContent, scrollWidth: root.scrollWidth, viewport: innerWidth };
  })()`
}

export function settleVisual(browser: AgentBrowser, selector: string, appearance: Appearance = {}): void {
  browser.waitForStable(visualSampleExpression(selector, appearance), { holdMs: 200 })
}
