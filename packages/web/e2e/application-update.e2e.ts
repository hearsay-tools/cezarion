import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e/application-update')
let browser: AgentBrowser
let baseUrl: string
let project: string
let actualHealth: Record<string, unknown>
const desktop = '[data-slot="sidebar"]'
const drawer = '[data-slot="mobile-nav-drawer"]'

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  project = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(`application-update-${process.pid}`)
  actualHealth = await fetch(`${baseUrl}/api/v1/health`).then((response) => response.json()) as Record<string, unknown>
})
afterAll(() => { browser?.close() })

/** Chrome route fixtures survive the document reload that a confirmed version change triggers. */
function fixture(state: { status: string; supported: boolean; targetVersion?: string; message?: string }, version = '1.0.0', latestVersion = '2.0.0') {
  browser.routeJson('**/api/v1/health', {
    ...actualHealth,
    capabilities: { ...(actualHealth.capabilities as object), localHandoff: false },
    version, latestVersion, applicationUpdate: state,
  })
  browser.routeJson('**/api/v1/workspace/application-update/apply', { state: { status: 'ready', supported: true, targetVersion: '2.0.0' } })
  browser.routeJson('**/api/v1/workspace/application-update/restart', { state: { status: 'restarting', supported: true, targetVersion: '2.0.0' } })
}

function reconcile(): void {
  browser.evaluate(`window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))`)
}

describe('application update chrome', () => {
  it.each([
    { width: 1024, theme: 'light' }, { width: 1024, theme: 'dark' },
    { width: 360, theme: 'light' }, { width: 360, theme: 'dark' },
  ])('aligns preview versions at the trailing edge and keeps manual guidance in the header at $width/$theme', ({ width, theme }) => {
    const root = width < 768 ? drawer : desktop
    const preview = '0.14.8-pr501.7.abcdef1234567890'
    browser.setViewport(width, 640)
    fixture({ status: 'idle', supported: false, message: 'Update this installation manually.' }, preview, '0.14.8')
    browser.goto(`${baseUrl}/p/${project}/skills`)
    browser.waitForFunction(`document.querySelector('[data-slot="version-chip"]') !== null`)
    browser.evaluate(`localStorage.setItem('cez-theme', ${JSON.stringify(theme)})`)
    browser.goto(`${baseUrl}/p/${project}/skills`)
    browser.waitForFunction(`document.documentElement.classList.contains('light') === ${theme === 'light'}`)
    if (width < 768) browser.click('[aria-label="Open menu"]')
    const aligned = browser.waitForValue(`(() => {
      const root = document.querySelector('${root}')
      const chip = root?.querySelector('[data-slot="version-chip"]')
      if (!chip || root.getAnimations().some(a => a.playState === 'running')) return null
      const row = root.querySelector('[data-slot="brand-wordmark"]').parentElement
      const edge = row.getBoundingClientRect().right - parseFloat(getComputedStyle(row).paddingRight)
      return { gap: edge - chip.getBoundingClientRect().right, overflow: row.scrollWidth - row.clientWidth,
        version: chip.textContent, action: !!root.querySelector('[data-slot="application-update-action"]'),
        feedback: !!root.querySelector('[data-slot="application-update-feedback"]') }
    })()`)
    expect(aligned).toMatchObject({ version: `v${preview}`, overflow: 0, action: false, feedback: false })
    expect(Math.abs((aligned as { gap: number }).gap)).toBeLessThanOrEqual(1)
    browser.screenshot(`${artifacts}/preview-${width}-${theme}.png`, { viewport: true })
    fixture({ status: 'idle', supported: false, message: 'Update this installation manually.' }, preview)
    reconcile()
    const guidance = browser.waitForValue(`(() => {
      const root = document.querySelector('${root}')
      const feedback = root?.querySelector('[data-slot="application-update-feedback"]')
      if (!feedback?.textContent.includes('Install the newer release')) return null
      const row = root.querySelector('[data-slot="brand-wordmark"]').parentElement
      return { text: feedback.textContent, inHeader: !!feedback.closest('[data-slot="sidebar-header"]'),
        afterVersion: feedback.getBoundingClientRect().top >= row.getBoundingClientRect().bottom,
        beforeSearch: feedback.getBoundingClientRect().bottom <= root.querySelector('[data-slot="command-palette-hint"]').getBoundingClientRect().top,
        footerVisible: root.querySelector('[data-slot="sidebar-footer"]').getBoundingClientRect().bottom <= root.getBoundingClientRect().bottom + 1 }
    })()`)
    expect(guidance).toMatchObject({ inHeader: true, afterVersion: true, beforeSearch: true, footerVisible: true })
    expect((guidance as { text: string }).text).toContain('In-app updates are unavailable for this installation.')
    browser.screenshot(`${artifacts}/manual-update-${width}-${theme}.png`, { viewport: true })
  })

  it('keeps the header steady through preparation, error and ready on a minimum desktop sidebar', () => {
    browser.setViewport(1024, 768)
    fixture({ status: 'idle', supported: true })
    browser.goto(`${baseUrl}/p/${project}/skills`)
    browser.waitForFunction(`document.querySelector('${desktop} [data-slot="version-chip"]') !== null`)
    browser.evaluate(`localStorage.setItem('cez-theme', 'light')`)
    browser.goto(`${baseUrl}/p/${project}/skills`)
    browser.waitForFunction(`document.documentElement.classList.contains('light')`)
    browser.waitForFunction(`document.querySelector('${desktop} [aria-label="Update application"]') !== null`)
    const before = browser.waitForValue(`(() => { const root = document.querySelector('${desktop}'); const header = root.querySelector('[data-slot="brand-wordmark"]').parentElement.getBoundingClientRect(); const button = root.querySelector('[aria-label="Update application"]').getBoundingClientRect(); return { width: root.getBoundingClientRect().width, top: header.top, height: header.height, button: [button.width, button.height], title: root.querySelector('[aria-label="Update application"]').title, version: root.querySelector('[data-slot="version-chip"]').textContent }; })()`)
    expect(before).toMatchObject({ width: 264, button: [44, 44], title: 'Update from v1.0.0 to v2.0.0', version: 'v1.0.0' })
    browser.hover(`${desktop} [aria-label="Update application"]`)
    expect(browser.waitForValue(`document.querySelector('[data-slot="tooltip-content"]')?.textContent?.includes('Update from v1.0.0 to v2.0.0') ? true : null`)).toBe(true)
    browser.screenshot(`${artifacts}/desktop-update-light.png`, { viewport: true })
    fixture({ status: 'preparing', supported: true, targetVersion: '2.0.0' }); reconcile()
    browser.waitForFunction(`document.querySelector('${desktop} [aria-label="Preparing update"]')?.disabled === true`)
    browser.screenshot(`${artifacts}/desktop-preparing-light.png`, { viewport: true })
    fixture({ status: 'error', supported: true, message: 'Preparation failed.' }); reconcile()
    browser.waitForFunction(`document.querySelector('${desktop} [role="status"]')?.textContent.includes('Retry or update manually')`)
    browser.screenshot(`${artifacts}/desktop-error-light.png`, { viewport: true })
    browser.click(`${desktop} [aria-label="Update application"]`)
    browser.waitForFunction(`document.querySelector('${desktop} [aria-label="Restart application"]') !== null`)
    const after = browser.waitForValue(`(() => { const root = document.querySelector('${desktop}'); const header = root.querySelector('[data-slot="brand-wordmark"]').parentElement.getBoundingClientRect(); const button = root.querySelector('[aria-label="Restart application"]').getBoundingClientRect(); return { top: header.top, height: header.height, button: [button.width, button.height], title: root.querySelector('[aria-label="Restart application"]').title }; })()`)
    expect(after).toEqual({ top: (before as { top: number }).top, height: (before as { height: number }).height, button: [44, 44], title: 'Restart required' })
    browser.screenshot(`${artifacts}/desktop-ready-light.png`, { viewport: true })
  })

  it('supports the mobile dialog actions in dark mode and restores focus after Later', () => {
    browser.setViewport(360, 640)
    fixture({ status: 'ready', supported: true, targetVersion: '2.0.0' }, '1.0.0-nightly.20260923.abcdef1234567890')
    browser.goto(`${baseUrl}/p/${project}/skills`)
    browser.waitForFunction(`document.querySelector('[data-slot="mobile-top-bar"]') !== null`)
    browser.evaluate(`localStorage.setItem('cez-theme', 'dark')`)
    browser.goto(`${baseUrl}/p/${project}/skills`)
    browser.waitForFunction(`!document.documentElement.classList.contains('light')`)
    browser.waitForFunction(`document.querySelector('button[aria-label="Open menu"]') !== null`)
    browser.click('[aria-label="Open menu"]')
    browser.waitForFunction(`(() => { const d = document.querySelector('${drawer}'); return !!d && d.getBoundingClientRect().left === 0 && !!d.querySelector('[aria-label="Restart application"]') })()`)
    browser.screenshot(`${artifacts}/mobile-ready-dark.png`, { viewport: true })
    browser.click(`${drawer} [data-slot="theme-toggle"]`)
    browser.waitForFunction(`document.querySelector('${drawer} [data-slot="theme-toggle"]')?.getAttribute('data-theme-pref') === 'system'`)
    browser.click(`${drawer} [data-slot="theme-toggle"]`)
    browser.waitForFunction(`document.documentElement.classList.contains('light')`)
    browser.goto(`${baseUrl}/p/${project}/skills`)
    browser.waitForFunction(`document.documentElement.classList.contains('light') && document.querySelector('button[aria-label="Open menu"]') !== null`)
    browser.click('button[aria-label="Open menu"]')
    browser.waitForFunction(`document.querySelector('${drawer}')?.getBoundingClientRect().left === 0`)
    browser.moveTo(350, 600)
    browser.screenshot(`${artifacts}/mobile-ready-light.png`, { viewport: true })
    browser.evaluate(`localStorage.setItem('cez-theme', 'dark')`)
    browser.goto(`${baseUrl}/p/${project}/skills`)
    browser.waitForFunction(`!document.documentElement.classList.contains('light')`)
    browser.click('button[aria-label="Open menu"]')
    browser.waitForFunction(`document.querySelector('${drawer}')?.getBoundingClientRect().left === 0`)
    const nightly = browser.waitForValue(`(() => {
      const chip = document.querySelector('${drawer} [data-slot="version-chip"]')
      const header = chip?.closest('[data-slot="version-action"]')?.parentElement
      if (!chip || !header) return null
      return { version: chip.textContent, title: chip.title, overflow: header.scrollWidth - header.clientWidth }
    })()`)
    expect(nightly).toMatchObject({ version: 'v1.0.0-nightly.20260923.abcdef1234567890', overflow: 0 })
    expect((nightly as { title: string }).title).toContain('v1.0.0-nightly.20260923.abcdef1234567890')
    browser.click(`${drawer} [aria-label="Restart application"]`)
    browser.waitForFunction(`document.querySelector('[role="alertdialog"]') !== null`)
    expect(browser.text('[role="alertdialog"]')).toContain('Running tasks will be recovered after restart.')
    const modal = browser.waitForValue(`(() => {
      const dialog = document.querySelector('[role="alertdialog"]')
      const overlay = document.querySelector('[data-slot="alert-dialog-overlay"]')
      const sheet = document.querySelector('${drawer}')
      if (!dialog || !overlay || !sheet) return null
      if ([dialog, overlay, sheet].some(el => el.getAnimations().some(animation => animation.playState === 'running'))) return null
      const rect = dialog.getBoundingClientRect()
      return {
        opacity: getComputedStyle(dialog).opacity,
        left: sheet.getBoundingClientRect().left,
        dialogLeft: rect.left,
        dialogRight: rect.right,
        topIsDialog: dialog.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)),
        titleColor: getComputedStyle(dialog.querySelector('[data-slot="alert-dialog-title"]')).color,
        background: getComputedStyle(dialog).backgroundColor,
      }
    })()`)
    expect(modal).toMatchObject({ opacity: '1', left: 0, dialogLeft: 16, dialogRight: 344, topIsDialog: true })
    browser.screenshot(`${artifacts}/mobile-confirm-dark.png`, { viewport: true })
    browser.click('[data-slot="alert-dialog-cancel"]')
    browser.waitForFunction(`document.querySelector('[role="alertdialog"]') === null && document.activeElement?.getAttribute('aria-label') === 'Restart application'`)
    browser.click(`${drawer} [aria-label="Restart application"]`)
    browser.waitForFunction(`(() => {
      const dialog = document.querySelector('[role="alertdialog"]')
      const overlay = document.querySelector('[data-slot="alert-dialog-overlay"]')
      const action = dialog?.querySelector('[data-slot="alert-dialog-action"]')
      if (!dialog || !overlay || !action) return false
      if ([dialog, overlay].some(el => el.getAnimations().some(animation => animation.playState === 'running'))) return false
      const rect = action.getBoundingClientRect()
      return getComputedStyle(dialog).opacity === '1' && action.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
    })()`)
    browser.click('[data-slot="alert-dialog-action"]')
    browser.waitForFunction(`document.querySelector('${drawer} [aria-label="Reconnecting after restart"]') !== null && document.querySelector('[role="alertdialog"]') === null`)
    browser.screenshot(`${artifacts}/mobile-restarting-dark.png`, { viewport: true })
    fixture({ status: 'idle', supported: true }, '2.0.0'); reconcile()
    const reloaded = browser.waitForValue(`(() => { const navigation = performance.getEntriesByType('navigation')[0]; return navigation?.type === 'reload' ? { path: location.pathname, marker: sessionStorage.getItem('cez:application-restart-from') } : null })()`)
    expect(reloaded).toEqual({ path: `/p/${project}/skills`, marker: null })
  })

  it('keeps last-known version through offline and respects zoom and reduced motion', () => {
    browser.setViewport(1440, 900)
    fixture({ status: 'idle', supported: true })
    browser.goto(`${baseUrl}/p/${project}/skills`)
    browser.waitForFunction(`document.querySelector('${desktop} [data-slot="version-chip"]') !== null`)
    browser.waitForFunction(`document.querySelector('${desktop} [aria-label="Update application"]') !== null`)
    browser.setOffline(true)
    browser.waitForFunction(`document.querySelector('${desktop} [aria-label="Update application"]')?.disabled === true && document.querySelector('${desktop} [role="status"]')?.textContent.includes('Connection lost')`)
    expect(browser.text(`${desktop} [data-slot="version-chip"]`)).toBe('v1.0.0')
    browser.screenshot(`${artifacts}/desktop-offline-dark.png`, { viewport: true })
    browser.setOffline(false)
    browser.waitForFunction(`document.querySelector('${desktop} [aria-label="Update application"]')?.disabled === false`)
    browser.setReducedMotion()
    browser.evaluate(`document.documentElement.style.zoom = '2'`)
    const geometry = browser.waitForValue(`(() => { const root = document.querySelector('${desktop}'); const action = root.querySelector('[aria-label="Update application"]'); const header = root.querySelector('[data-slot="brand-wordmark"]').parentElement; return { reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, width: action.getBoundingClientRect().width, overflow: header.scrollWidth - header.clientWidth, title: action.title }; })()`)
    expect(geometry).toMatchObject({ reduced: true, width: 88, title: 'Update from v1.0.0 to v2.0.0' })
    expect((geometry as { overflow: number }).overflow).toBeLessThanOrEqual(0)
    browser.screenshot(`${artifacts}/desktop-zoom-200-reduced-dark.png`, { viewport: true })
    fixture({ status: 'ready', supported: true, targetVersion: '2.0.0' })
    reconcile()
    browser.waitForFunction(`document.querySelector('${desktop} [aria-label="Restart application"]') !== null`)
    browser.click(`${desktop} [aria-label="Restart application"]`)
    const dialogMotion = browser.waitForValue(`(() => {
      const dialog = document.querySelector('[role="alertdialog"]')
      const overlay = document.querySelector('[data-slot="alert-dialog-overlay"]')
      return dialog && overlay ? {
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        dialogAnimation: getComputedStyle(dialog).animationName,
        overlayAnimation: getComputedStyle(overlay).animationName,
      } : null
    })()`)
    expect(dialogMotion).toEqual({ reduced: true, dialogAnimation: 'none', overlayAnimation: 'none' })
    browser.screenshot(`${artifacts}/desktop-confirm-zoom-200-reduced-dark.png`, { viewport: true })
  })
})
