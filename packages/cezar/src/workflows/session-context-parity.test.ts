import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS, type RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { handoffPath } from '../handoff.ts';
import { SESSION_CONTEXT_SEPARATOR } from '../session-context.ts';
import { ciNativeMessages } from './waits-parity.testkit.ts';
import { manager, restart, root, semaphore, store, until, useWorkerWaitFixture, worker } from './worker-wait.testkit.ts';
import { QUICK_TASK_WORKFLOW, type WorkflowDef } from './types.ts';

// hearsay-tools/cezarion#1584: every cezar-managed launch opens with the run's own handoff and
// the project's context rules, on every native wire; a live message never does.
const CONTEXT_YAML = `version: 1
rules:
  - id: vision
    on: session_start
    target: parent
    template: |
      Project vision:
      {{file:docs/vision.md}}
  - id: worker-brief
    on: session_start
    target: worker
    template: WORKER-BRIEF-1584
  - id: recipient
    on: session_start
    template: "ROLE={{role}} RUN={{run.id}} STEP={{step.id}}"
`;

function native(runner: RunnerId) {
  const adapter = HARNESS_ADAPTERS[runner];
  vi.stubEnv('CEZ_DRY_RUN', '0');
  vi.stubEnv(adapter.binEnv, adapter.mockBin);
  vi.stubEnv('CEZ_MOCK_ARGS_FILE', join(root, 'args'));
  vi.stubEnv('CEZ_MOCK_STDIN_FILE', join(root, 'stdin'));
  return () => ciNativeMessages(runner, root);
}

/** The project's rules and vision, committed so an owned worker's worktree has them too. */
function projectContext(vision = 'VISION-V1') {
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, '.ai/cezar/context.yaml'), CONTEXT_YAML);
  writeFileSync(join(root, 'docs/vision.md'), `${vision}\n`);
  execFileSync('git', ['add', '-f', '.ai/cezar/context.yaml', 'docs/vision.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'context'], { cwd: root });
}

const handoffBlock = (id: string) => `<cezar-context id="handoff" source="${handoffPath(join(root, '.ai/cezar'), id)}">`;
const count = (text: string, needle: string) => text.split(needle).length - 1;
const contextLines = (id: string) => store.readEvents(id)
  .filter((event) => event.type === 'lifecycle' && String(event.message).startsWith('session context: '))
  .map((event) => String(event.message));

/** The prefix of one native message: the blocks before the opening message's separator. */
function prefixOf(message: string): string {
  const start = message.indexOf('<cezar-context id="handoff"');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = message.indexOf(`</cezar-context>${SESSION_CONTEXT_SEPARATOR}`, message.lastIndexOf('<cezar-context id="'));
  expect(end).toBeGreaterThan(start);
  return message.slice(start, end + '</cezar-context>'.length);
}

async function finished(id: string) {
  await until(() => ['failed', 'done', 'review', 'waiting'].includes(store.getRun(id)?.status ?? '') && !manager.isActive(id));
}

describe('session-start context through every native wire (hearsay-tools/cezarion#1584)', () => {
  useWorkerWaitFixture();
  afterEach(() => vi.unstubAllEnvs());

  for (const runner of RUNNER_IDS) {
    it(`${runner} R120 opens a fresh step with the whole handoff and parent rules, then refreshes them on Continue`, async () => {
      const messages = native(runner);
      projectContext();
      const task = HARNESS_ADAPTERS[runner].scenarios.done!;
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task, runner, worktree: false });
      await finished(run.id);
      const first = messages()[0]!;
      const prefix = prefixOf(first);
      // One prefix, the handoff first, the parent rules in file order, the task after the separator.
      expect(count(first, '<cezar-context id="handoff"')).toBe(1);
      expect(prefix.startsWith(handoffBlock(run.id))).toBe(true);
      expect(prefix).toContain('## Goal');
      expect(prefix.indexOf('id="vision"')).toBeLessThan(prefix.indexOf('id="recipient"'));
      expect(prefix).toContain('Project vision:\nVISION-V1');
      expect(prefix).toContain(`ROLE=parent RUN=${run.id} STEP=task`);
      expect(prefix).not.toContain('WORKER-BRIEF-1584');
      expect(first.slice(first.lastIndexOf(SESSION_CONTEXT_SEPARATOR) + SESSION_CONTEXT_SEPARATOR.length)).toContain(task);
      expect(contextLines(run.id)).toEqual([expect.stringMatching(/^session context: handoff applied \(\d+ B, .+\); vision applied \(\d+ B, docs\/vision\.md\); recipient applied \(\d+ B\)$/)]);

      writeFileSync(join(root, 'docs/vision.md'), 'VISION-V2\n');
      const before = messages().length;
      expect(manager.continueRun(run.id, { text: 'Keep working.' })).toEqual({ ok: true });
      await until(() => messages().length > before);
      const second = messages()[before]!;
      const refreshed = prefixOf(second);
      expect(count(second, '<cezar-context id="handoff"')).toBe(1);
      expect(refreshed).toContain('VISION-V2');
      expect(refreshed).not.toContain('VISION-V1');
      // The whole handoff as it stands at this launch, including what the first launch added.
      const handoff = readFileSync(handoffPath(join(root, '.ai/cezar'), run.id), 'utf8');
      expect(handoff).toContain('complete — status=');
      expect(refreshed).toContain('complete — status=');
      expect(second.endsWith('Keep working.')).toBe(true);
      expect(contextLines(run.id)).toHaveLength(2);
    }, 60_000);

    it(`${runner} R121 never injects into a live message`, async () => {
      const messages = native(runner);
      projectContext();
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner, worktree: false });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      const before = messages().length;
      const text = `${HARNESS_ADAPTERS[runner].scenarios.baseline!} live follow-up 1584`;
      expect(manager.sendMessage(run.id, [{ type: 'text', text }])).toBe(true);
      await until(() => messages().slice(before).some((message) => message.includes('live follow-up 1584')));
      const live = messages().slice(before).find((message) => message.includes('live follow-up 1584'))!;
      expect(live).not.toContain('<cezar-context');
      expect(contextLines(run.id)).toHaveLength(1);
    }, 60_000);

    it(`${runner} R122 injects into a check retry`, async () => {
      const messages = native(runner);
      projectContext();
      const workflow: WorkflowDef = { name: 'retry-1584', source: 'built-in', steps: [
        { id: 'implement', prompt: HARNESS_ADAPTERS[runner].scenarios.done!, runner },
        { id: 'verify', command: 'node -e "const fs=require(\'node:fs\');if(!fs.existsSync(\'retried-1584\')){fs.writeFileSync(\'retried-1584\',\'\');process.exit(1)}"', onFail: { retry: 'implement', max: 1 } },
      ] };
      const run = manager.startRun(workflow, { task: 'retry task', runner, worktree: false });
      await until(() => ['done', 'review', 'failed'].includes(store.getRun(run.id)?.status ?? '') && !manager.isActive(run.id));
      const opening = messages().filter((message) => message.includes(handoffBlock(run.id)));
      expect(opening).toHaveLength(2);
      expect(opening[1]).toContain('A verification command failed after the previous attempt.');
      expect(prefixOf(opening[1]!)).toContain('STEP=implement');
      expect(contextLines(run.id)).toHaveLength(2);
    }, 60_000);

    it(`${runner} R123 injects into restart recovery with no live session`, async () => {
      const messages = native(runner);
      projectContext();
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.done!, runner, worktree: false });
      await finished(run.id);
      store.updateStep(run.id, 'task', { status: 'running', finishedAt: undefined });
      store.updateRun(run.id, { status: 'running', currentStepId: 'task', finishedAt: undefined, continuationMessage: undefined });
      const before = messages().length;
      const held = vi.spyOn(semaphore, 'maxParallel').mockReturnValue(0);
      await restart();
      held.mockRestore();
      await (manager as unknown as { pump(): Promise<void> }).pump();
      await until(() => messages().length > before);
      const recovered = messages()[before]!;
      expect(count(recovered, '<cezar-context id="handoff"')).toBe(1);
      expect(prefixOf(recovered)).toContain(handoffBlock(run.id));
      expect(recovered).toContain('cezar process restarted');
    }, 60_000);

    it(`${runner} R124 renders an owned worker's own handoff and worker rules, never the parent's`, async () => {
      const messages = native(runner);
      projectContext();
      const parent = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner });
      store.commitDelegation([{ id: parent.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
      await until(() => store.getRun(parent.id)?.status === 'waiting');
      const child = await worker(parent.id, HARNESS_ADAPTERS[runner].scenarios.done!, runner);
      manager.enqueueOwnedRun(child.id);
      await until(() => messages().some((message) => message.includes(handoffBlock(child.id))));
      const opening = messages().find((message) => message.includes(handoffBlock(child.id)))!;
      const prefix = prefixOf(opening);
      expect(count(opening, '<cezar-context id="handoff"')).toBe(1);
      expect(prefix).not.toContain(handoffBlock(parent.id));
      expect(prefix).toContain('WORKER-BRIEF-1584');
      expect(prefix).toContain(`ROLE=worker RUN=${child.id}`);
      expect(prefix).not.toContain('VISION-V1');
      expect(prefix).not.toContain(`RUN=${parent.id}`);
      // The worker's inherited system prompt carries none of the parent's rendered context.
      expect(store.getRun(child.id)?.systemPrompt ?? '').not.toContain('<cezar-context');
    }, 60_000);
  }
});
