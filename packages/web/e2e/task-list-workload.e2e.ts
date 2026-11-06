import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
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
