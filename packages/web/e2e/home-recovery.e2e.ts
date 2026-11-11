import { productName } from './product'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { AgentBrowser } from './agent-browser'
import { createHomeRecoveryFixture } from './home-recovery-fixture'

let fixture: Awaited<ReturnType<typeof createHomeRecoveryFixture>>
let browser: AgentBrowser
const rows = '[data-slot="home-recovery"]'
const row = (file: string) => `${rows}[data-home-file="${file}"]`

beforeAll(async () => {
  fixture = await createHomeRecoveryFixture()
  browser = AgentBrowser.open(`e2e-home-recovery-${process.pid}`)
  browser.goto('about:blank')
})
beforeEach(async () => {
  browser.goto('about:blank')
  await fixture.reset()
  browser.goto(`${fixture.origin}/tasks`)
  browser.waitForFunction(`document.querySelector('[data-slot="home-recovery-state"][data-state="ready"]') !== null`)
})
afterAll(async () => { browser?.close(); await fixture?.stop() })

it('shows no recovery banner in a normal session after the recovery snapshot arrives', () => {
  const count = browser.waitForValue<number>(`document.querySelectorAll(${JSON.stringify(rows)}).length`, value => value === 0)
  expect(count).toBe(0)
  expect(fixture.readState().projects.some(project => project.id === fixture.project.id)).toBe(true)
})

it('receives a registry reset live and restores the previous project without a reload', async () => {
  await fixture.control({ kind: 'reset-projects' })
  browser.waitForFunction(`document.querySelector(${JSON.stringify(row('config.json'))}) !== null`)
  expect(fixture.readState().projects).toEqual([])
  browser.click(`${row('config.json')} button[data-action="restore"]`)
  const count = browser.waitForValue<number>(`document.querySelectorAll(${JSON.stringify(row('config.json'))}).length`, value => value === 0)
  expect(count).toBe(0)
  expect(fixture.readState().projects).toContainEqual(expect.objectContaining({ id: fixture.project.id, root: fixture.project.root }))
})

it('accepts a reset registry and keeps it empty until a new project is added', async () => {
  await fixture.control({ kind: 'reset-projects' })
  const text = browser.waitForValue<string>(`document.querySelector(${JSON.stringify(row('config.json'))})?.textContent`,
    value => typeof value === 'string' && value.includes('The project registry was reset. Restore the previous projects?'))
  expect(text).toContain('Accept as found')
  browser.click(`${row('config.json')} button[data-action="accept"]`)
  const count = browser.waitForValue<number>(`document.querySelectorAll(${JSON.stringify(row('config.json'))}).length`, value => value === 0)
  expect(count).toBe(0)
  expect(fixture.readState().projects).toEqual([])
  await fixture.control({ kind: 'add-project' })
  expect(fixture.readState().projects).toContainEqual(expect.objectContaining({ id: fixture.project.id }))
})

it('receives an outside write live, refuses saves, and restores the pinned UI state', async () => {
  await fixture.control({ kind: 'outside-ui-state' })
  const text = browser.waitForValue<string>(`document.querySelector(${JSON.stringify(row('ui-state.json'))})?.textContent`,
    value => typeof value === 'string' && value.includes(`ui-state.json changed outside ${productName('Cezar')}. Restore the previous version or accept the file as found.`))
  expect(text).toContain('Accept as found')
  await expect(fixture.control({ kind: 'write-ui-state', value: 'blocked' })).rejects.toThrow(/Outside write/)
  browser.click(`${row('ui-state.json')} button[data-action="restore"]`)
  const count = browser.waitForValue<number>(`document.querySelectorAll(${JSON.stringify(row('ui-state.json'))}).length`, value => value === 0)
  expect(count).toBe(0)
  expect(fixture.readState().uiState.recoveryFixture).toBe('original')
  await fixture.control({ kind: 'write-ui-state', value: 'after-restore' })
  expect(fixture.readState().uiState.recoveryFixture).toBe('after-restore')
})

it('accepts an outside file as found and permits the next HomeStore write', async () => {
  await fixture.control({ kind: 'outside-ui-state' })
  browser.waitForFunction(`document.querySelector(${JSON.stringify(row('ui-state.json'))}) !== null`)
  browser.click(`${row('ui-state.json')} button[data-action="accept"]`)
  const count = browser.waitForValue<number>(`document.querySelectorAll(${JSON.stringify(row('ui-state.json'))}).length`, value => value === 0)
  expect(count).toBe(0)
  expect(fixture.readState().uiState.recoveryFixture).toBe('outside')
  await fixture.control({ kind: 'write-ui-state', value: 'after-accept' })
  expect(fixture.readState().uiState.recoveryFixture).toBe('after-accept')
})

it('imports a late legacy change from the global banner without a reload', async () => {
  const before = fixture.legacyHash()
  await fixture.control({ kind: 'legacy-ui-state', value: 'late-import' })
  const text = browser.waitForValue<string>(`document.querySelector(${JSON.stringify(row('ui-state.json'))})?.textContent`,
    value => typeof value === 'string' && value.includes('ui-state.json changed in the old home.'))
  expect(text).toContain('Old-home changes win')
  browser.click(`${row('ui-state.json')} button[data-action="import"]`)
  const count = browser.waitForValue<number>(`document.querySelectorAll(${JSON.stringify(row('ui-state.json'))}).length`, value => value === 0)
  expect(count).toBe(0)
  expect(fixture.readState().uiState.recoveryFixture).toBe('late-import')
  expect(fixture.legacyHash()).not.toBe(before)
})

it('ignores a late legacy change and records its hash while keeping the live file', async () => {
  const before = fixture.legacyHash()
  await fixture.control({ kind: 'legacy-ui-state', value: 'late-ignore' })
  browser.waitForFunction(`document.querySelector(${JSON.stringify(row('ui-state.json'))})?.textContent.includes('changed in the old home.')`)
  browser.click(`${row('ui-state.json')} button[data-action="accept"]`)
  const count = browser.waitForValue<number>(`document.querySelectorAll(${JSON.stringify(row('ui-state.json'))}).length`, value => value === 0)
  expect(count).toBe(0)
  expect(fixture.readState().uiState.recoveryFixture).toBe('original')
  expect(fixture.legacyHash()).not.toBe(before)
})
