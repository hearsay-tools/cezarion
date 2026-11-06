import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { pollFor } from './poll'
import { createTabFixture } from './tab-fixture'
import { runTaskListsBenchmark } from '../scripts/benchmark-task-lists'

it('runs the task-list workload matrix with tiny fixtures and clean shutdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-task-list-smoke-'))
  try {
    const report = await runTaskListsBenchmark({ smoke: true, output: join(dir, 'result.json') })
    expect(report.productionProfilingBuild).toBe(false)
    expect(report.pendingCase).toBeNull()
    expect(report.failure).toBeUndefined()
    expect(report.cases).toHaveLength(16)
    const keys = report.cases.map((sample: { scope: string; width: number; setting: string; view: string }) => `${sample.scope}/${sample.width}/${sample.setting}/${sample.view}`)
    expect(new Set(keys).size).toBe(16)
    for (const sample of report.cases) {
      const perProject = sample.view === 'active' ? 3 : 5
      expect(sample.mountedRows).toBe(perProject * (sample.scope === 'global' ? 2 : 1))
      const representation = sample.scope === 'global' ? (sample.setting === 'grouped' ? 'cards' : 'summary')
        : sample.width === 360 ? 'cards' : sample.setting === 'detailed' ? 'resources' : 'summary'
      expect(sample.representation).toBe(representation)
      expect(sample.frames).toHaveLength(2)
      expect(sample.scrollFrameP50).toBe(sample.frames[1])
      expect(sample.scrollFrameP95).toBe(sample.frames[1])
    }
    expect(report.fixtureExits).toHaveLength(2)
    for (const exit of report.fixtureExits) {
      expect(exit.exitCode).toBe(0)
      expect(exit.signalCode).toBeNull()
      expect(exit.stderr).toBe('')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
  // bound: fixture boot and 16 real page navigations; the tiny workload targets <30 s on CI.
}, 90_000)


it('keeps an empty task-list fixture alive when summary streaming is requested', async () => {
  const fixture = await createTabFixture(process.cwd(), { taskList: 'project', taskListSizes: { active: 0, archived: 0, projects: 1 } })
  try {
    expect(fixture.runs).toEqual([])
    await fixture.control({ summaryStreaming: true })
    // Negative case: require health on three polls spanning the child's 50 ms timer; parent fake timers cannot drive it.
    let healthy = 0
    await pollFor(async (signal) => {
      const response = await fetch(`${fixture.origin}/api/v1/health`, { signal })
      if (!response.ok) throw new Error(`fixture health ${response.status}`)
      return ++healthy >= 3 ? true : undefined
    }, () => 'empty fixture stopped answering health after summary streaming', {
      // bound: three health probes across two timer intervals, with room for host load.
      intervalMs: 100, timeoutMs: 2000,
    })
    expect((await fixture.control()).published).toBe(0)
    expect(fixture.server.exitCode).toBeNull()
    expect((await fetch(`${fixture.origin}/api/v1/health`)).ok).toBe(true)
  } finally { await fixture.stop() }
  // bound: private fixture boot and shutdown, with no browser navigation.
}, 60_000)
