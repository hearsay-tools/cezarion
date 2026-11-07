import type { AgentBackend, AgentRunner, RunnerId } from './agent-runner.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { CursorRunner } from './cursor-runner.ts';
import type { SessionTransport } from '@open-mercato/cezar-contract';
import { PiRunner } from './pi-runner.ts';
import { OmpRunner } from './omp-runner.ts';

/**
 * The production `RunnerFactory`: the single place that maps a backend id onto a concrete
 * runner. The entry points pass it to `RunManager` and the planner; engine code never imports
 * this module, so a test that drives one runner loads only that adapter
 * (hearsay-tools/cezarion#2939). `claude-cli` is the legacy id for `claude`.
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

