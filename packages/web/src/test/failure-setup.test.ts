// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({ beforeAll: vi.fn(), beforeEach: vi.fn() }))
const capture = vi.hoisted(() => ({
  beginFailureSpec: vi.fn(), beginFailureTest: vi.fn(), configureFailureCapture: vi.fn(),
  lastAttachedBrowser: vi.fn(),
}))
vi.mock('vitest', async (original) => ({ ...await original<typeof import('vitest')>(), ...hooks }))
vi.mock('../../e2e/agent-browser', () => capture)
import '../../e2e/failure-setup'

afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks() })

describe('failure setup hooks', () => {
  // Keep registrations: clearing mock calls does not discard these captured callbacks.
  const beforeSpec = hooks.beforeAll.mock.calls[0]![0]
  const beforeTest = hooks.beforeEach.mock.calls[0]![0]

  it('cleans the selected spec before setup, without cleaning again for tests or retries', () => {
    beforeSpec({}, { filepath: '/specs/task-thread.e2e.ts' })
    expect(capture.beginFailureSpec).toHaveBeenCalledWith('task-thread')
    const onTestFailed = vi.fn()
    const context = { task: { name: 'layout', file: { filepath: '/specs/task-thread.e2e.ts' } }, onTestFailed }
    beforeTest(context)
    beforeTest(context)
    expect(capture.beginFailureSpec).toHaveBeenCalledTimes(1)
    expect(capture.beginFailureTest).toHaveBeenCalledTimes(2)
    expect(capture.beginFailureTest).toHaveBeenCalledWith({ spec: 'task-thread', test: 'layout' })
  })

  it('prints a parseable bundle path and passes the original assertion to capture', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {})
    const original = new Error('expected whole row')
    const captureTestFailure = vi.fn().mockReturnValue('/failures/task-thread/layout-1')
    capture.lastAttachedBrowser.mockReturnValue({ captureTestFailure })
    const onTestFailed = vi.fn()
    beforeTest({ task: { name: 'layout', file: { filepath: '/specs/task-thread.e2e.ts' } }, onTestFailed })
    onTestFailed.mock.calls[0]![0]({ task: { name: 'layout', result: { errors: [original] } } })
    expect(captureTestFailure).toHaveBeenCalledWith([original])
    expect(original.message).toBe('expected whole row')
    expect(output).toHaveBeenCalledWith('cezar e2e: "layout" (failure bundle: /failures/task-thread/layout-1)')
    captureTestFailure.mockReturnValue(null) // Wait already captured: no duplicate path or bundle.
    output.mockClear()
    onTestFailed.mock.calls[0]![0]({ task: { name: 'layout', result: { errors: [original] } } })
    expect(output).not.toHaveBeenCalled()
  })
})
