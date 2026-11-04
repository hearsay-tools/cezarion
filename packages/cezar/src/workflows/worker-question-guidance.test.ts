import { completionRefusal, type CompletionGateHost } from './run/completion-gate.ts';
import type { RunModuleContext } from './run/types.ts';
import { TrackedWork } from './run/tracked-work.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture } from '../delegation/service.testkit.ts';

describe('unanswered worker question completion guidance', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); });
  afterEach(async () => { await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it.each([1, 100])('teaches usable message commands for %i questions without a live session', count => {
    const questions = Array.from({ length: count }, () => ({ workerId: randomUUID(), messageId: randomUUID() }));
    const asked = vi.fn(() => questions);
    const context: RunModuleContext = { store: f.store, repoRoot: f.root, dataDir: join(f.root, '.ai/cezar'),
      work: new TrackedWork(), semaphore: new WorkspaceSemaphore(), disposed: () => false };
    const host: CompletionGateHost = { active: new Map(), unansweredQuestions: asked, parentCompletionBlockers: () => [],
      pendingHumanAskSeq: () => undefined, isActive: () => false, holdsAgentWaits: () => false, waitingBeforeFinalWorkflowStep: () => false };
    const gate = completionRefusal(context, host, f.parent.id)!;
    expect(asked).toHaveBeenCalledWith(f.parent.id);
    expect(gate.code).toBe('worker_questions');
    expect(gate.message).toContain('cez message reply');
    expect(gate.message).not.toMatch(/worker (?:reply|inbox)/);
    if (count === 1) {
      expect(gate.message).toContain(`cez message reply ${questions[0]!.workerId}`);
      expect(gate.message).toContain(`--request-id ${questions[0]!.messageId}`);
    } else {
      expect(gate.message).toContain('cez message inbox');
      expect(gate.message).toContain('--request-id <question-id>');
    }
  });
});
