/**
 * A shipped backend id never stops parsing.
 *
 * Run records and transcripts on users' disks carry the backend id that started them, so removing
 * or repurposing one makes that history unreadable: it is a breaking change
 * (`BACKWARD_COMPATIBILITY.md`). `claude-cli` is the legacy id of `claude`.
 */
import { describe, expect, it } from 'vitest';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';

import { runRecordSchema } from '../runs/store.ts';
import { workflowStepSchema } from '../workflows/types.ts';
import type { AgentBackend, RunnerId } from './agent-runner.ts';
import { createRunner } from './runner-factory.ts';

/**
 * Every backend id that shipped, with the runner it resolves to. Add a new id; never remove an
 * entry or change its runner. `satisfies` fails to compile when `AgentBackend` gains an id this
 * map lacks, loses one it names, or a runner id it resolves to is gone.
 */
const SHIPPED_BACKEND_IDS = {
  claude: 'claude',
  'claude-cli': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
  cursor: 'cursor',
  omp: 'omp',
} as const satisfies Record<AgentBackend, RunnerId>;

const shipped = Object.entries(SHIPPED_BACKEND_IDS) as Array<[AgentBackend, RunnerId]>;
/** The ids a user can select: each resolves to itself. `claude-cli` only reads back. */
const selectable = shipped.filter(([id, runner]) => id === runner);

describe('shipped backend ids', () => {
  it.each(shipped)('a stored run that carries %s still parses, as %s', (id, runner) => {
    const parsed = runRecordSchema.parse({
      id: 'stored-1',
      title: 'stored',
      workflow: 'quick-task',
      task: 'stored',
      status: RUN_STATUS.done,
      createdAt: '2026-01-01T00:00:00.000Z',
      tokensUsed: 0,
      archived: false,
      runner: id,
      steps: [{ id: 'task', name: 'Do the task', kind: STEP_KIND.agent, status: STEP_STATUS.done, iterations: 1, tokensUsed: 0, backend: id }],
    });
    expect(parsed.runner).toBe(runner);
    expect(parsed.steps[0]?.backend).toBe(runner);
  });

  it.each(shipped)('createRunner builds the %s backend as the %s runner', (id, runner) => {
    // An unknown id also falls back to Claude, so compare the built runner's own id.
    expect(createRunner(id).backend).toBe(runner);
  });

  // A workflow step never accepted the legacy id: nothing may ask for it (`runs/store.ts`).
  it.each(selectable)('a workflow step that names %s still parses', (id) => {
    expect(workflowStepSchema.parse({ id: 'work', prompt: '{{task}}', runner: id }).runner).toBe(id);
  });
});
