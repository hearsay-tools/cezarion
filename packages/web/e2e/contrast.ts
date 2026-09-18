import { WaitForValueError, type AgentBrowser } from './agent-browser'

export interface ContrastSample {
  foreground: string
  background: string
  ratio: number
}

export interface ContrastQaVariant {
  id: string
  theme: 'dark' | 'light'
  density: 'comfortable' | 'ultra'
  viewport: { width: 360 | 1440; height: 640 | 900 }
}

export const contrastQaVariants: ContrastQaVariant[] = ([
  { id: 'mobile', width: 360, height: 640 },
  { id: 'desktop', width: 1440, height: 900 },
] as const).flatMap((viewport) =>
  (['comfortable', 'ultra'] as const).flatMap((density) =>
    (['dark', 'light'] as const).map((theme) => ({
      id: `${viewport.id}-${theme}-${density}`,
      theme,
      density,
      viewport: { width: viewport.width, height: viewport.height },
    })),
  ),
)

export function applyContrastQaVariant(browser: AgentBrowser, variant: ContrastQaVariant): void {
  browser.setViewport(variant.viewport.width, variant.viewport.height)
  browser.evaluate(`(() => {
    document.documentElement.style.setProperty('--default-transition-duration', '0s')
    document.documentElement.classList.toggle('light', ${variant.theme === 'light'})
    if (${variant.density === 'ultra'}) document.documentElement.dataset.density = 'ultra'
    else delete document.documentElement.dataset.density
  })()`)
}

export function restoreContrastQaDefaults(browser: AgentBrowser): void {
  browser.setViewport(1440, 900)
  browser.evaluate(`(() => {
    document.documentElement.style.removeProperty('--default-transition-duration')
    document.documentElement.classList.remove('light')
    delete document.documentElement.dataset.density
  })()`)
}

/**
 * Browser expression for the contrast a person actually sees: the element's computed ink,
 * composited over every transparent ancestor until the opaque page surface is reached.
 */
export function contrastSampleExpression(selector: string, foregroundProperty = 'color', backgroundSource: 'element' | 'parent' = 'element'): string {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) throw new Error('contrast target not found: ' + ${JSON.stringify(selector)})
    const parse = (value) => {
      const channels = value.match(/[\\d.]+/g)?.map(Number) ?? []
      if (channels.length < 3) throw new Error('unsupported computed color: ' + value)
      return { r: channels[0], g: channels[1], b: channels[2], a: channels[3] ?? 1 }
    }
    const over = (front, back) => {
      const alpha = front.a + back.a * (1 - front.a)
      return {
        r: (front.r * front.a + back.r * back.a * (1 - front.a)) / alpha,
        g: (front.g * front.a + back.g * back.a * (1 - front.a)) / alpha,
        b: (front.b * front.a + back.b * back.a * (1 - front.a)) / alpha,
        a: alpha,
      }
    }
    const layers = []
    // An offset outline sits outside the control's fill, on the parent surface.
    for (let node = ${backgroundSource === 'parent' ? 'element.parentElement' : 'element'}; node; node = node.parentElement) {
      const layer = parse(getComputedStyle(node).backgroundColor)
      if (layer.a > 0) layers.push(layer)
      if (layer.a === 1) break
    }
    let background = { r: 255, g: 255, b: 255, a: 1 }
    for (const layer of layers.reverse()) background = over(layer, background)
    const foregroundValue = getComputedStyle(element).getPropertyValue(${JSON.stringify(foregroundProperty)})
    const foreground = over(parse(foregroundValue), background)
    const luminance = (color) => {
      const channel = (value) => {
        const srgb = value / 255
        return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
    }
    const light = Math.max(luminance(foreground), luminance(background))
    const dark = Math.min(luminance(foreground), luminance(background))
    return {
      foreground: foregroundValue,
      background: 'rgb(' + [background.r, background.g, background.b].map(Math.round).join(', ') + ')',
      ratio: (light + 0.05) / (dark + 0.05),
    }
  })()`
}

/**
 * Focuses the target through a real Tab key from the preceding visible control.
 *
 * Three steps, each waited on rather than sampled (#409). The predecessor lookup polls until the
 * target and a focusable control before it exist, and refuses what `.focus()` refuses: an
 * element with a box but `visibility: hidden` is skipped by the browser's tab order too, so
 * focusing it would put the Tab that follows somewhere else. `press('Tab')` is its own CLI call,
 * and focus can land asynchronously after it (a menu that moves focus in an effect), so the
 * last step waits until `document.activeElement` IS the target and, when it never is, names the
 * element that took focus instead.
 */
export function focusWithKeyboard(browser: AgentBrowser, selector: string): void {
  const target = JSON.stringify(selector)
  const describe = `(el) => el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 3).map((c) => '.' + c).join('') : null`
  browser.waitForValue<{ ready: boolean; predecessor: string | null }>(
    `(() => {
    const describe = ${describe}
    const target = document.querySelector(${target})
    if (!target) return { ready: false, predecessor: null }
    const controls = [...document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
    const index = controls.indexOf(target)
    if (index < 1) return { ready: false, predecessor: null }
    controls[index - 1].focus()
    return { ready: document.activeElement === controls[index - 1], predecessor: describe(controls[index - 1]) }
  })()`,
    (state) => state.ready,
    { failure: `no visible keyboard predecessor for ${selector}` },
  )
  browser.press('Tab')
  try {
    browser.waitForValue<{ onTarget: boolean; active: string | null }>(
      `(() => {
    const describe = ${describe}
    const target = document.querySelector(${target})
    return { onTarget: !!target && document.activeElement === target, active: describe(document.activeElement) }
  })()`,
      (state) => state.onTarget,
    )
  } catch (error) {
    if (!(error instanceof WaitForValueError)) throw error
    const active = (error.lastValue as { active?: string | null } | undefined)?.active ?? 'nothing'
    throw new Error(`focus never reached ${selector}; it is on ${active} (failure bundle: ${error.bundle})`, { cause: error })
  }
}

/**
 * Dismisses a Radix overlay with Escape and waits for the focus that comes back with it.
 *
 * Escape closes the content, but the trigger gets focus back one task LATER. Radix keeps the
 * content mounted through its exit animation (`Presence` waits for `animationend`, 150ms
 * here), and only when it unmounts does `FocusScope` refocus the trigger, from a zero-delay
 * timer (`onCloseAutoFocus`). A wait for `content` to be `null` resolves inside that gap, so
 * a scripted `.focus()` there is undone a millisecond later: the row-rename pencil's Tab
 * started from the Columns trigger and ended on "New task" (#410, CI job 105562586371). The
 * end state is the focus, not the absence, so this waits for both.
 *
 * `focus` is where the overlay returns focus: its trigger, or whatever its `onCloseAutoFocus`
 * names instead. A dismissal that moved focus itself (an outside click, a tab away) does not
 * return it, and is not this helper's case.
 */
export function dismissWithEscape(browser: AgentBrowser, { content, focus }: { content: string; focus: string }): void {
  browser.press('Escape')
  browser.waitForFunction(
    `document.querySelector(${JSON.stringify(content)}) === null && document.activeElement === document.querySelector(${JSON.stringify(focus)})`,
  )
}

/**
 * Hovers a painted, unobstructed point of a possibly wrapping inline element.
 *
 * Scroll, hit-test and the point come from ONE polled expression (#409). The previous shape —
 * a `waitForFunction` that scrolled and hit-tested, then an `evaluate` that hit-tested again —
 * lost whenever layout moved between the two CLI calls, and failed as `no visible hover point`
 * on `main` and on unrelated pull requests. The sample that passes the matcher is the sample
 * the pointer moves to.
 */
export function hoverVisiblePoint(browser: AgentBrowser, selector: string): void {
  // A previous matrix state can leave the real pointer over a hover-triggered surface after
  // the viewport changes. Clear that state before scrolling so it cannot re-cover the target
  // between the sample and the CDP mouse move.
  browser.moveTo(0, 0)
  type Point = { x: number; y: number }
  const point = browser.waitForValue(
    `(() => {
    const target = document.querySelector(${JSON.stringify(selector)})
    if (!target) return null
    target.scrollIntoView({ block: 'center', inline: 'nearest' })
    for (const rect of target.getClientRects()) {
      for (const yPart of [0.25, 0.5, 0.75]) {
        for (const xPart of [0.25, 0.5, 0.75]) {
          const x = rect.left + rect.width * xPart
          const y = rect.top + rect.height * yPart
          const hit = document.elementFromPoint(x, y)
          if (hit === target || target.contains(hit)) return { x, y }
        }
      }
    }
    return null
  })()`,
    (sample: Point | null): sample is Point => sample !== null,
    { failure: `no visible hover point for ${selector}` },
  )
  // Round to the same integers `moveTo` sends. Do not wait on CSS :hover afterwards:
  // agent-browser's CDP mouse-move does not set it on wrapping inline links (diagnosed
  // #369, timed out at 25s). Do not wait on these frozen coordinates either — a later
  // layout pass (viewport/theme in the QA matrix) leaves them pointing at empty space.
  // Callers that need a settled pointer re-hit-test current rects, not this snapshot.
  browser.moveTo(Math.round(point.x), Math.round(point.y))
}
