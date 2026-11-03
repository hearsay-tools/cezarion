import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runRecordSchema, type RunRecord } from '@open-mercato/cezar-api-client/contract/runs'
import { makeRunRecord } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'

/** Validate recorded JSON before a spec derives typed overrides from it. */
export function recordedRun(value: unknown): RunRecord {
  return runRecordSchema.parse(value)
}

/** Seed the legacy import file before the fixture server opens its run store. */
export function seedRuns(dataRoot: string, partials: readonly Partial<RunRecord>[]): void {
  const records = partials.map(partial => makeRunRecord(partial))
  mkdirSync(join(dataRoot, '.ai/cezar'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify(records, null, 2), 'utf8')
}
