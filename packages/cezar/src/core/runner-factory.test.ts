import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { CursorRunner } from './cursor-runner.ts';
import { OmpRunner } from './omp-runner.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { PiRunner } from './pi-runner.ts';
import { createRunner } from './runner-factory.ts';

// The production factory the entry points inject (hearsay-tools/cezarion#2939).
describe('createRunner', () => {
  const classes = { claude: ClaudeCliRunner, codex: CodexAppServerRunner, opencode: OpencodeServerRunner, cursor: CursorRunner, pi: PiRunner, omp: OmpRunner };

  it.each(RUNNER_IDS)('builds the %s runner', (id) => {
    const runner = createRunner(id);
    expect(runner).toBeInstanceOf(classes[id]);
    expect(runner.backend).toBe(id);
  });

  it.each([['claude-cli'], [undefined]] as const)('builds the claude runner for %s', (id) => {
    expect(createRunner(id)).toBeInstanceOf(ClaudeCliRunner);
  });
});
