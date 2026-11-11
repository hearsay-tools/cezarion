import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { QUICK_TASK_WORKFLOW } from '../workflows/types.ts';
import type { AgentRunResult } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import * as runners from '../core/runner-factory.ts';
import '../core/every-runner.testkit.ts';
import { fixture } from './service.testkit.ts';

it('accepts a queued worker after release while two running parents fill the default slots', async () => {

  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.stubEnv('CEZ_AUTONAME', '0');
  let opened = 0;
  vi.spyOn(runners, 'createRunner').mockImplementation(backend => ({
    backend: backend ?? 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
    interrupt: async () => {}, run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: () => {
      opened++;
      let open = true;
      let resolve!: (result: AgentRunResult) => void;
      const result = new Promise<AgentRunResult>(done => { resolve = done; });
      const finish = () => { open = false; resolve({ text: '', toolCalls: [], tokensUsed: 0 }); };
      return { result, get open() { return open; }, sendMessage: () => open, sendAgentMessage: () => open ? Promise.resolve() : false,
        discardQueuedMessages: () => {}, holdsHumanInput: () => false, interrupt: finish, end: finish };
    },
  }));
  const f = fixture();
  try {
    await f.releaseAdmission();
    const parents = Array.from({ length: 2 }, () => f.manager.startRun(QUICK_TASK_WORKFLOW, {
      task: 'hold parent slot', runner: 'claude', worktree: true,
    }));
    // bound: the runner boundary confirms both parents hold their slots before acceptance.
    await vi.waitFor(() => {
      expect(opened).toBe(2);
      for (const parent of parents) {
        expect(f.store.getRun(parent.id)?.status).toBe(RUN_STATUS.running);
      }
    }, { timeout: 15_000 });
    const accepted = await f.service.spawn(f.caller, { task: 'queued third worker', baseline: 'parent-head', requestId: randomUUID() });
    expect(f.store.getRun(accepted.workerId)?.status).toBe(RUN_STATUS.queued);
    expect(parents.every(parent => f.manager.isActive(parent.id))).toBe(true);
  } finally {
    try { await f.close(); } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
  }
}, 20_000); // bound: two runner starts, one acceptance, and owned fixture teardown.
