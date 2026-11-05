import { onTestFinished, vi } from 'vitest';
import type { AgentSession } from '../core/agent-runner.ts';
import * as runnerFactory from '../core/runner-factory.ts';

/** Own the real sessions at the runner boundary, keyed by the task environment. */
export function captureSessions() {
  const sessions = new Map<string, AgentSession>();
  const create = runnerFactory.createRunner;
  const capture = vi.spyOn(runnerFactory, 'createRunner').mockImplementation((...args) => {
    const runner = create(...args);
    const start = runner.startSession.bind(runner);
    vi.spyOn(runner, 'startSession').mockImplementation((spec, ...rest) => {
      const session = start(spec, ...rest);
      sessions.set(spec.env!.CEZ_TASK_ID!, session);
      return session;
    });
    return runner;
  });
  onTestFinished(() => capture.mockRestore());
  return (id: string) => {
    const session = sessions.get(id);
    if (!session) throw new Error(`No runner session for ${id}`);
    return session;
  };
}
