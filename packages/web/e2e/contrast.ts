import type { AgentBrowser } from './agent-browser'

export interface ContrastSample {
  foreground: string
  background: string
  ratio: number
}

/**
 * Browser expression for the contrast a person actually sees: the element's computed ink,
 * composited over every transparent ancestor until the opaque page surface is reached.
 */
export function contrastSampleExpression(selector: string, foregroundProperty = 'color'): string {
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
    for (let node = element; node; node = node.parentElement) {
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

/** Focuses the target through a real Tab key from the preceding visible control. */
export function focusWithKeyboard(browser: AgentBrowser, selector: string): void {
  const ready = browser.evaluate(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)})
    const controls = [...document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.getClientRects().length > 0)
    const index = controls.indexOf(target)
    if (index < 1) return false
    controls[index - 1].focus()
    return true
  })()`)
  if (ready !== true) throw new Error(`no visible keyboard predecessor for ${selector}`)
  browser.press('Tab')
}
