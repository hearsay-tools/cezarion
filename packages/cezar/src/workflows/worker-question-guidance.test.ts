import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture } from '../delegation/service.testkit.ts';

describe('unanswered worker question completion guidance', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); });
  afterEach(async () => { await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it.each([1, 100])('teaches usable message commands for %i questions without a live session', count => {
    const questions = Array.from({ length: count }, () => ({ workerId: randomUUID(), messageId: randomUUID() }));
    const manager = f.manager as unknown as {
      unansweredQuestions(id: string): typeof questions;
      completionRefusal(id: string): { code: string; message: string } | undefined;
    };
    vi.spyOn(manager, 'unansweredQuestions').mockReturnValue(questions);
    const gate = manager.completionRefusal(f.parent.id)!;
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
