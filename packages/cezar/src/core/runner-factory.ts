import type { AgentBackend, AgentRunner, RunnerId } from './agent-runner.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { CursorRunner } from './cursor-runner.ts';
import type { SessionTransport } from '@open-mercato/cezar-contract';
import { PiRunner } from './pi-runner.ts';
import { OmpRunner } from './omp-runner.ts';

/**
 * The single place that maps a backend id onto a concrete runner. Everything
 * that used to `new ClaudeCliRunner()` (the planner and the workflow engine)
 * goes through here so switching the agent backend is one function call.
 * `claude-cli` is the legacy id for `claude`.
 */
export function createRunner(backend: AgentBackend | RunnerId | undefined, options: { sessionTransport?: SessionTransport } = {}): AgentRunner {
  switch (backend) {
    case 'codex':
      return new CodexAppServerRunner();
    case 'opencode':
      return new OpencodeServerRunner();
    case 'cursor':
      return new CursorRunner(options);
    case 'pi':
      return new PiRunner();
    case 'omp':
      return new OmpRunner();
    case 'claude':
    case 'claude-cli':
    default:
      return new ClaudeCliRunner();
  }
}
