import { HOOK_STATUSES } from '@open-mercato/cezar-api-client/protocol/ui-events'
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RUN_STATUS, STEP_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import type { RunRecord } from '@open-mercato/cezar-api-client/contract/runs'
import { seedRuns, recordedRun } from './seed-runs'
import { seedTranscript } from './seed-transcript'
import recordJson from './fixtures/thread-run.record.json'

/**
 * The task-thread runs that `task-thread-transcript`, `task-thread-session` and
 * `task-thread-layout` seed. Each transcript is the REAL NDJSON of an R2 dry run,
 * `fixtures/thread-run.ndjson` (see fixtures/README.md), or a named edit of it. The server
 * replays it over the per-run SSE stream as it would for any finished run, so a spec sees the
 * full pipe: store → SSE replay → reducer → grouping → tool cards → Streamdown → lazy Shiki.
 *
 * This module only builds data. Each spec owns its server, its browser session and their
 * cleanup: the run store reads `runs.json` once at startup, so a spec seeds its own data root
 * before it boots, and a terminal (`done`) status keeps `recover()` from touching the run.
 */

const HOOK_STATUS = Object.fromEntries(HOOK_STATUSES.map(status => [status, status])) as { [Status in (typeof HOOK_STATUSES)[number]]: Status }

const record = recordedRun(recordJson)
const transcript = () => readFileSync(resolve(import.meta.dirname, 'fixtures/thread-run.ndjson'), 'utf8')

export const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_issue-522')

/** The recorded run (`fixtures/thread-run.record.json`, the store's own zod-checked shape),
 *  with the one legitimate user edit a run can carry: a PATCHed title summary — so the header
 *  assertions cover the edited-title path rather than echoing the raw auto-summary. */
export const RUN = ({ ...record, titleSummary: 'Explain what cezar does' } satisfies Partial<RunRecord>)
export const RUN_ID: string = RUN.id
export const LONG_RUN = ({
  ...RUN, id: 'phone-long-metadata', titleSummary: 'A task with a very long title for the narrow phone header',
  workflow: 'workflow-' + 'unbroken'.repeat(12), branch: 'cez/' + 'long-branch-'.repeat(18),
  model: 'fork-model-' + 'long-model-'.repeat(10), effort: 'high',
  steps: RUN.steps.map((step) => ({ ...step, profileId: 'default' })),
  // Seven-figure counts so the Usage row's tokens and cost cannot both fit on a phone.
  inputTokens: 1_234_567, outputTokens: 345_678, costUsd: 12.34, // shown as `$12`
} satisfies Partial<RunRecord>)
export const TYPO_RUNS = [
  ({ ...LONG_RUN, id: 'typography-long-model', runner: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', effort: 'auto' } satisfies Partial<RunRecord>),
  ({ ...LONG_RUN, id: 'typography-short-model', runner: 'opencode', model: 'grok-4.6', effort: 'auto' } satisfies Partial<RunRecord>),
]
// hearsay-tools/cezarion#1478: a run parked at its review gate keeps its last step in flight, so the
// folded Activity header shows the spinner. The step name is long enough to truncate on a phone.
export const STEP_RUN = ({
  ...LONG_RUN, id: 'folded-step-in-flight', status: RUN_STATUS.review,
  steps: [
    { ...LONG_RUN.steps[0]!, status: STEP_STATUS.done },
    { ...LONG_RUN.steps[1]!, name: 'Verify the change against every acceptance criterion in the ticket', status: STEP_STATUS.review },
  ],
} satisfies Partial<RunRecord>)
// #961: the same transcript with two hook items after the Bash card — Squeal's context and a
// failed Stop hook — as the Claude mapper emits them (`__fixtures__/claude/hooks.expected.json`).
export const HOOK_RUN = ({ ...RUN, id: 'hook-entries', titleSummary: 'Hook entries' } satisfies Partial<RunRecord>)
const HOOK_LINES = [
  { type: 'item.completed', ts: '2026-07-14T20:27:40.000Z', stepId: 'task', item: { kind: 'hook', id: 'hook_ctx', event: 'PostToolBatch', status: 'completed',
    entries: [{ kind: 'context', text: 'SQUEAL · revision 4\n✗ thread-items.test.tsx › ToolCard renders hook rows — new failure' }],
    stdout: '{"hookSpecificOutput":{"hookEventName":"PostToolBatch","additionalContext":"SQUEAL · revision 4"}}', exitCode: 0 } },
  { type: 'item.completed', ts: '2026-07-14T20:27:40.000Z', stepId: 'task', item: { kind: 'hook', id: 'hook_fail', event: 'Stop', status: HOOK_STATUS.failed,
    entries: [{ kind: 'error', text: 'squeal status timed out after 2000 ms' }], stderr: 'squeal status timed out after 2000 ms\n', exitCode: 1,
    source: '/home/agent/.claude/plugins/squeal/hooks/stop.sh' } },
]
export const BARE_COMMAND = 'cd /home/agent/projects/very-long-project && npm run test:e2e -- --reporter verbose --runInBand'

export type ThreadRun = typeof RUN | typeof LONG_RUN | (typeof TYPO_RUNS)[number] | typeof STEP_RUN | typeof HOOK_RUN

/** The NDJSON a run replays: the recorded transcript, or the edit its scenario needs. */
function transcriptFor(id: string): string {
  if (id === HOOK_RUN.id) {
    const lines = transcript().split('\n').filter(Boolean)
    const at = lines.findIndex((entry) => entry.includes('"item.completed"') && entry.includes('toolu_mock_1'))
    return [...lines.slice(0, at + 1), ...HOOK_LINES.map((entry) => JSON.stringify(entry)), ...lines.slice(at + 1)]
      .map((entry, index) => JSON.stringify({ ...JSON.parse(entry), seq: index + 1 })).join('\n') + '\n'
  }
  // The long-metadata run has no plan, so its Activity card shows no plan row.
  if (id === LONG_RUN.id) {
    return transcript().split('\n').filter((line) => !/plan\.updated|TodoWrite|toolu_mock_todo|"type":"plan"/.test(line)).join('\n')
  }
  if (TYPO_RUNS.some((run) => run.id === id)) {
    return transcript()
      .replaceAll('Ran git status --short', BARE_COMMAND)
      .replaceAll('"command":"git status --short"', `"command":${JSON.stringify(BARE_COMMAND)}`)
  }
  return transcript()
}

/**
 * A new data root holding `runs` with their transcripts, and RUN's agent screenshot when RUN is
 * among them. The caller boots a server on it and removes it after `stopFixtureServer`.
 */
export function seedThreadDataRoot(prefix: string, runs: readonly ThreadRun[]): string {
  const dataRoot = mkdtempSync(join(tmpdir(), prefix))
  const runsDir = join(dataRoot, '.ai/cezar/runs')
  mkdirSync(runsDir, { recursive: true })
  seedRuns(dataRoot, [...runs])
  for (const run of runs) seedTranscript(join(runsDir, `${run.id}.ndjson`), transcriptFor(run.id))
  // The agent screenshot the transcript's `image` line points at (served by the run itself).
  if (runs.some((run) => run.id === RUN_ID)) {
    cpSync(resolve(import.meta.dirname, 'fixtures/thread-run-images'), join(runsDir, `${RUN_ID}-images`), { recursive: true })
  }
  return dataRoot
}
