import type { AgentBrowser } from './agent-browser'
import type { VisualProgram, VisualReason } from './visual-sample-protocol'

type Appearance = { theme?: string; width?: string; idle?: boolean }

/** Readiness plus geometry in one sample. Held loading fixtures deliberately omit idle. */
export function visualSampleExpression(selector: string, appearance: Appearance = {}): string {
  return visualProgram(selector, appearance)
}

function visualProgram(selector: string, { theme, width, idle = false }: Appearance, recorder?: string, declaration = '', envelope = false): string {
  const exit = (reason: VisualReason, value = 'null') => recorder
    ? `return (${recorder}.reason = ${JSON.stringify(reason)}, ${envelope ? `${recorder}.finish(${value})` : value});`
    : `return ${value};`
  return `(() => {${declaration}
    const root = document.documentElement, target = document.querySelector(${JSON.stringify(selector)});
    ${recorder ? `if (!target) ${exit('missing-target')}
    if ((${recorder}.fontObserved = true, ${recorder}.fontStatus = document.fonts?.status) !== 'loaded') ${exit('fonts')}` : `if (!target || document.fonts?.status !== 'loaded') return null;`}
    // #795/#758: box reads can force layout in skipped content-visibility subtrees.
    // Observe native rendering BEFORE reading any geometry, including descendants.
    if (!target.checkVisibility({ contentVisibilityAuto: true })) ${exit('native')}
    if (${JSON.stringify(theme)} && root.classList.contains('light') !== (${JSON.stringify(theme)} === 'light')) ${exit('theme')}
    if (${JSON.stringify(width)} && root.dataset.width !== ${JSON.stringify(width)}) ${exit('width')}
    if (${idle} && window.__cezIdle !== true) ${exit('idle')}
    const elements = [target, ...target.querySelectorAll('*')];
    for (let el = target.parentElement; el; el = el.parentElement) elements.push(el);
    if (elements.some(el => el.getAnimations().some(a => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity))) ${exit('finite-animation')}
    // Infinite spinners are valid loading state. Their transformed ink moves, while the
    // enclosing layout box and all surrounding content must still remain stable.
    const movingInk = el => {
      for (let node = el; node && node !== target.parentElement; node = node.parentElement)
        if (node.getAnimations().some(a => a.playState === 'running' && a.effect?.getComputedTiming().iterations === Infinity)) return true;
      return false;
    };
    const rect = el => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
    const box = target.getBoundingClientRect();
    if (!box.width || !box.height) ${exit('zero-box')}
    ${exit('visual-ready', `{ boxes: elements.filter(el => el.checkVisibility({ contentVisibilityAuto: true }) && !movingInk(el)).map(rect), text: target.textContent, scrollWidth: root.scrollWidth, viewport: innerWidth }`)}
  })()`
}

export function settleVisual(browser: AgentBrowser, selector: string, appearance: Appearance = {}): void {
  browser.waitForStable(visualSampleExpression(selector, appearance), { holdMs: 200, visualDiagnostic: diagnosticProgram('visual', selector, appearance) })
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
  return settledProgram(expression, selector)
}

function settledProgram(expression: string, selector: string, recorder?: string, declaration = ''): string {
  return `(() => {${declaration}
    const layout = ${visualProgram(selector, {}, recorder)};
    if (!layout) return ${recorder ? `${recorder}.finish(null)` : 'null'};
    const active = document.activeElement;
    const focus = active ? [...document.querySelectorAll('*')].indexOf(active) : -1;
    const value = (${expression});
    ${recorder ? `if (value === null || value === undefined) return (${recorder}.reason = value === null ? 'measurement-null' : 'measurement-undefined', ${recorder}.finish(null));
    return (${recorder}.reason = 'sample-ready', ${recorder}.finish({ layout, focus, value }));` : `if (value === null || value === undefined) return null;
    return { layout, focus, value };`}
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
    visualDiagnostic: diagnosticProgram('settled', selector, {}, expression),
    matcher: sample => sample !== null && matcher(sample.value),
  })
  // waitForStable's matcher rejects null; keep the narrowing explicit for callers.
  if (sample === null) throw new Error('settled sample unexpectedly absent')
  return sample.value
}


/** Extra lexical bindings are not a generic introspection-safe JS transform.
 * Keep explicit dynamic evaluation/source/stack introspection and escaped identifiers
 * on the original path. This conservative exclusion may also match string contents.
 * Ordinary opaque measurements keep their exact layout/active/focus/value scope. */
function diagnosticProgram(kind: 'visual' | 'settled', selector: string, appearance: Appearance, expression = ''): VisualProgram {
  if (/\b(?:eval|Function|arguments|caller|callee|constructor|toString|stack|Error|Reflect|Proxy|debugger)\b|\\u|\bwith(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*\(/.test(expression)) {
    return { mode: 'legacy', kind: 'settled', fallback: 'dynamic-or-introspective-source' }
  }
  const source = expression + JSON.stringify([selector, appearance])
  let recorder = '__cezVisualEvidence'
  while (source.includes(recorder)) recorder += '_'
  return { mode: 'envelope', kind, build: (token, attempt) => {
    const header = { version: 1, token, attempt, kind }
    const declaration = `
    const ${recorder} = {
      sourceDocument: document, reason: 'missing-target', fontObserved: false, fontStatus: undefined, document: null,
      finish(value) {
        return { protocol: 'cez.visual', version: 1, token: ${JSON.stringify(token)}, attempt: ${attempt}, kind: ${JSON.stringify(kind)},
          public: value === undefined ? { present: false } : { present: true, value },
          evidence: { reason: this.reason, phase: this.reason.startsWith('measurement-') || this.reason === 'sample-ready' ? 'measurement' : 'visual',
            fontObserved: this.fontObserved, ...(this.fontObserved ? { fontStatus: this.fontStatus ?? null } : {}), document: this.document } };
      }
    };
    ${recorder}.document = { timeOrigin: performance.timeOrigin, path: location.pathname.slice(0, 512), readyState: ${recorder}.sourceDocument.readyState, visibilityState: ${recorder}.sourceDocument.visibilityState, observedAt: performance.now() };`
    return `/*cez-visual:${JSON.stringify(header)}*/\n` + (kind === 'visual'
      ? visualProgram(selector, appearance, recorder, declaration, true)
      : settledProgram(expression, selector, recorder, declaration))
  } }
}

/** Native visibility is a measurement: a settled false remains an assertion failure. */
export function visibilitySampleExpression(selector: string): string {
  return `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return null;
    if (!target.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })) return false;
    const rect = target.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  })()`
}

/** #795 review: observe the disclosure commit independently of its visibility result. */
export function disclosureVisibilityExpression(toggleSelector: string, targetSelector: string, expanded: boolean): string {
  return `(() => {
    const toggle = document.querySelector(${JSON.stringify(toggleSelector)});
    if (!toggle || toggle.getAttribute('aria-expanded') !== ${JSON.stringify(String(expanded))}) return null;
    return ${visibilitySampleExpression(targetSelector)};
  })()`
}
