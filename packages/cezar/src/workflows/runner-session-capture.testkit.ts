import { onTestFinished, vi } from 'vitest';
import type { AgentSession } from '../core/agent-runner.ts';
import * as runnerFactory from '../core/runner-factory.ts';

/** Own the real sessions at the runner boundary, keyed by the task environment. */
export function captureSessions(options: { env?: (id: string) => Record<string, string> } = {}) {
  const sessions = new Map<string, AgentSession>();
  const create = runnerFactory.createRunner;
  const capture = vi.spyOn(runnerFactory, 'createRunner').mockImplementation((...args) => {
    const runner = create(...args);
    const start = runner.startSession.bind(runner);
    vi.spyOn(runner, 'startSession').mockImplementation((spec, ...rest) => {
      const id = spec.env?.CEZ_TASK_ID;
      if (!id) throw new Error('runner launched without task identity');
      const env = options.env?.(id);
      const session = start(env ? { ...spec, env: { ...spec.env, ...env } } : spec, ...rest);
      sessions.set(id, session);
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
