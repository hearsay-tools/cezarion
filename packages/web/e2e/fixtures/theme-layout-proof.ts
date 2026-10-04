/**
 * #795 native render-phase regression for the measured postreload readiness gap.
 * Run: node --import tsx packages/web/e2e/fixtures/theme-layout-proof.ts
 * Red comparison: add --first-truth. Requires the configured browser provider.
 *
 * This owns a blank fixture document; it never changes a product-rendered node.
 * The real loaded trace shows semantic Light/native-visible controls preceding a
 * 60px layout shift. No original failing pointer trace exists: this proves geometry
 * readiness, not that the original failed Dark click hit Light.
 */
import assert from 'node:assert/strict'
import { AgentBrowser } from '../agent-browser'
import { settleVisual, visualSampleExpression } from '../visual-ready'

const dark = '[data-slot="appearance-theme"] [data-value="dark"]'
const expression = visualSampleExpression(dark)
const browser = AgentBrowser.open(`e2e-theme-layout-proof-${process.pid}`)
const firstTruth = process.argv.includes('--first-truth')
try {
  browser.setViewport(1440, 900)
  browser.goto('about:blank')
  const initial = browser.evaluate(`(() => {
    document.documentElement.classList.add('light');
    const group = document.createElement('div');
    group.setAttribute('data-slot', 'appearance-theme');
    group.style.cssText = 'position:absolute;left:408.921875px;top:286px;display:flex;gap:10px';
    const light = document.createElement('button');
    light.setAttribute('data-value', 'light'); light.setAttribute('aria-checked', 'true');
    light.style.cssText = 'box-sizing:border-box;width:64.65625px;height:45.5px';
    light.textContent = 'Light';
    const dark = document.createElement('button');
    dark.setAttribute('data-value', 'dark'); dark.setAttribute('aria-checked', 'false');
    dark.style.cssText = 'box-sizing:border-box;width:63.53125px;height:45.5px';
    dark.textContent = 'Dark';
    group.append(light, dark); document.body.append(group);
    group.addEventListener('click', event => {
      const selected = event.target.closest('button');
      if (!selected) return;
      for (const button of group.children) button.setAttribute('aria-checked', String(button === selected));
      document.documentElement.classList.toggle('light', selected === light);
    });
    // Mount/semantic state is observable in this task. A separate native rendered
    // frame commits the observed +60px layout change, without pointer side effects,
    // delays, expected-answer polls or geometry assertion thresholds as readiness.
    const first = ${expression};
    requestAnimationFrame(() => {
      group.style.transform = 'translateX(60px)';
      group.setAttribute('data-layout-committed', 'true');
    });
    return { first, ready: document.readyState, light: light.getAttribute('aria-checked'),
      root: document.documentElement.classList.contains('light') };
  })()`) as { first: unknown; ready: string; light: string; root: boolean }
  assert.equal(initial.ready, 'complete')
  assert.equal(initial.light, 'true')
  assert.equal(initial.root, true)
  assert.notEqual(initial.first, null)

  let accepted = initial.first
  if (!firstTruth) {
    // Record the actual held sample from the same existing primitive used by the
    // spec's local settleVisual call. No replacement browser or fake geometry.
    const waitForStable = browser.waitForStable.bind(browser)
    browser.waitForStable = ((...args: Parameters<typeof waitForStable>) => {
      const sample = waitForStable(...args)
      accepted = sample
      return sample
    }) as typeof browser.waitForStable
    settleVisual(browser, dark)
  }
  // The original selector action stays a selector action in both variants. It may
  // succeed either way; that is not relabelled as a reproduced original mis-hit.
  browser.click(dark)
  browser.waitForFunction(`document.querySelector('[data-layout-committed="true"]') !== null`)
  const final = browser.evaluate(expression)
  const clickedDark = browser.evaluate(`!document.documentElement.classList.contains('light')`)
  console.log(JSON.stringify({ strategy: firstTruth ? 'first-truth' : 'settled', initial, accepted, final, clickedDark }, null, 2))
  assert.deepEqual(accepted, final, 'accepted action geometry must be the committed geometry, independent of the theme result')
  assert.equal(clickedDark, true)
} finally {
  browser.close()
}
