import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatSetupDuration,
  resolveWorktreeSetup,
  runWorktreeSetup,
  worktreeSetupAgentNote,
  worktreeSetupEndNote,
  worktreeSetupEnv,
  worktreeSetupRecordError,
  worktreeSetupStartNote,
  type WorktreeSetupCommandResult,
  type WorktreeSetupOutcome,
} from './worktree-setup.ts';

/**
 * Worktree setup (#917, spec `.ai/specs/2026-10-07-worktree-setup.md`). The resolver decides
 * what `config.json`'s `worktreeSetup` means: nothing, a setting that is invalid and must be
 * reported, or the commands to run.
 */
describe('resolveWorktreeSetup', () => {
  it('treats an absent key and an empty command list as no setup', () => {
    expect(resolveWorktreeSetup(undefined)).toEqual({ kind: 'none' });
    expect(resolveWorktreeSetup({ commands: [] })).toEqual({ kind: 'none' });
  });

  it('trims commands and defaults the timeout to 900 seconds', () => {
    expect(resolveWorktreeSetup({ commands: [' npm ci '] })).toEqual({
      kind: 'commands',
      commands: ['npm ci'],
      timeoutSeconds: 900,
    });
  });

  it('keeps a configured timeout', () => {
    expect(resolveWorktreeSetup({ commands: ['a'], timeoutSeconds: 60 })).toEqual({
      kind: 'commands',
      commands: ['a'],
      timeoutSeconds: 60,
    });
  });

  it('reports a wrong-typed command list with the path of the problem', () => {
    const plan = resolveWorktreeSetup({ commands: 'npm ci' });
    expect(plan.kind).toBe('invalid');
    expect(plan.kind === 'invalid' && plan.issue).toMatch(/^commands: /);
  });

  it.each([
    ['21 commands', { commands: Array.from({ length: 21 }, (_, i) => `echo ${i}`) }],
    ['a command over 4000 characters', { commands: ['x'.repeat(4001)] }],
    ['a blank command', { commands: ['   '] }],
    ['a zero timeout', { commands: ['a'], timeoutSeconds: 0 }],
    ['a timeout over 7200 seconds', { commands: ['a'], timeoutSeconds: 7201 }],
    ['a fractional timeout', { commands: ['a'], timeoutSeconds: 1.5 }],
    ['an unknown key', { commands: ['a'], command: 'b' }],
    ['a non-object', 'npm ci'],
  ])('reports %s as invalid', (_name, raw) => {
    expect(resolveWorktreeSetup(raw).kind).toBe('invalid');
  });

  it('accepts exactly 20 commands of 4000 characters and a 7200 second timeout', () => {
    const plan = resolveWorktreeSetup({ commands: Array.from({ length: 20 }, () => 'x'.repeat(4000)), timeoutSeconds: 7200 });
    expect(plan.kind).toBe('commands');
  });
});

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-setup-'));
  dirs.push(dir);
  return dir;
}

async function run(commands: string[], opts: { timeoutSeconds?: number; cancelAfter?: number } = {}) {
  const cwd = scratch();
  const results: WorktreeSetupCommandResult[] = [];
  const outcome = await runWorktreeSetup({
    plan: { kind: 'commands', commands, timeoutSeconds: opts.timeoutSeconds ?? 900 },
    cwd,
    env: process.env,
    setInterrupt: () => undefined,
    isCancelled: () => opts.cancelAfter !== undefined && results.length >= opts.cancelAfter,
    onCommandResult: (result) => results.push(result),
  });
  return { cwd, results, outcome };
}

describe('runWorktreeSetup', () => {
  it('runs commands in order in the cwd', async () => {
    const { cwd, results, outcome } = await run(['echo one >> log', 'echo two >> log']);
    expect(readFileSync(join(cwd, 'log'), 'utf8')).toBe('one\ntwo\n');
    expect(outcome).toMatchObject({ status: 'done', commands: ['echo one >> log', 'echo two >> log'] });
    expect(results.map((r) => r.exitCode)).toEqual([0, 0]);
  });

  it('stops at the first failure and lists the rest as skipped', async () => {
    const { results, outcome } = await run(['exit 3', 'echo never']);
    expect(results).toHaveLength(1);
    expect(outcome).toMatchObject({ status: 'failed', reason: 'exit', skipped: ['echo never'] });
    expect(outcome.status === 'failed' && outcome.failed.exitCode).toBe(3);
  });

  it('a timeout fails with reason timeout', async () => {
    const { outcome } = await run(['sleep 5'], { timeoutSeconds: 1 });
    expect(outcome).toMatchObject({ status: 'failed', reason: 'timeout', timeoutSeconds: 1 });
    expect(outcome.status === 'failed' && outcome.failed.timedOut).toBe(true);
  }, 20_000);

  it('a cancel after a command yields stopped', async () => {
    const { results, outcome } = await run(['true', 'echo never'], { cancelAfter: 1 });
    expect(results).toHaveLength(1);
    expect(outcome.status).toBe('stopped');
  });
});

describe('worktreeSetupEnv', () => {
  it('drops secrets and adds the project root, task id and run temp dir', () => {
    const env = worktreeSetupEnv({
      projectRoot: '/repo',
      runId: 'run-1',
      tmpEnv: { TMPDIR: '/repo/.ai/cezar/tmp/run-1', TEMP: '/repo/.ai/cezar/tmp/run-1', TMP: '/repo/.ai/cezar/tmp/run-1' },
      source: { PATH: '/usr/bin', HOME: '/home/u', GITHUB_TOKEN: 'x', ANTHROPIC_API_KEY: 'y', TMPDIR: '/tmp' },
    });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.CEZ_PROJECT_ROOT).toBe('/repo');
    expect(env.CEZ_TASK_ID).toBe('run-1');
    expect(env.TMPDIR).toBe('/repo/.ai/cezar/tmp/run-1');
  });
});

describe('worktree setup copy', () => {
  const failedResult = (over: Partial<WorktreeSetupCommandResult> = {}): WorktreeSetupCommandResult => ({
    command: 'npm ci', exitCode: 1, timedOut: false, durationMs: 12_000, output: 'npm ERR! boom', ...over,
  });
  const done: WorktreeSetupOutcome = { status: 'done', commands: ['npm ci', 'cp a b'], durationMs: 41_000 };
  const exited: WorktreeSetupOutcome = {
    status: 'failed', reason: 'exit', failed: failedResult(), skipped: ['cp a b'], timeoutSeconds: 900, durationMs: 12_000,
  };
  const timedOut: WorktreeSetupOutcome = {
    status: 'failed', reason: 'timeout', failed: failedResult({ exitCode: null, timedOut: true }), skipped: [], timeoutSeconds: 900, durationMs: 900_000,
  };
  const spawn: WorktreeSetupOutcome = {
    status: 'failed', reason: 'spawn', failed: failedResult({ exitCode: null, spawnError: 'spawn bash ENOENT' }), skipped: [], timeoutSeconds: 900, durationMs: 5,
  };
  const invalid: WorktreeSetupOutcome = { status: 'invalid', issue: 'commands: Expected array, received string' };

  it('formats durations', () => {
    expect(formatSetupDuration(41_000)).toBe('41s');
    expect(formatSetupDuration(125_000)).toBe('2m 5s');
    expect(formatSetupDuration(400)).toBe('0s');
  });

  it('writes the start note', () => {
    expect(worktreeSetupStartNote(1)).toBe('preparing the worktree — 1 command from worktreeSetup in .ai/cezar/config.json');
    expect(worktreeSetupStartNote(2)).toBe('preparing the worktree — 2 commands from worktreeSetup in .ai/cezar/config.json');
  });

  it('writes the end notes', () => {
    expect(worktreeSetupEndNote(done)).toBe('worktree setup done in 41s');
    expect(worktreeSetupEndNote(exited)).toBe('worktree setup failed — `npm ci` exited 1 after 12s; starting the agent anyway');
    expect(worktreeSetupEndNote(timedOut)).toBe('worktree setup failed — `npm ci` timed out after 900s; starting the agent anyway');
    expect(worktreeSetupEndNote(spawn)).toBe('worktree setup failed — `npm ci` could not start (spawn bash ENOENT); starting the agent anyway');
    expect(worktreeSetupEndNote({ status: 'stopped', durationMs: 3 })).toBe('worktree setup stopped');
    expect(worktreeSetupEndNote(invalid)).toBe(
      'worktree setup skipped — worktreeSetup in .ai/cezar/config.json is invalid (commands: Expected array, received string)',
    );
  });

  it('tells the agent setup is done', () => {
    expect(worktreeSetupAgentNote(done)).toBe(
      'Cezar prepared this worktree before your session started: `npm ci`, `cp a b` (41s). Dependencies are installed; do not repeat this setup.',
    );
  });

  it('shortens long commands in notes to 120 characters', () => {
    const long = 'x'.repeat(200);
    const note = worktreeSetupAgentNote({ status: 'done', commands: [long], durationMs: 1000 })!;
    expect(note).toContain(`\`${'x'.repeat(119)}…\``);
  });

  it('tells the agent setup failed, with the skipped commands and the output', () => {
    expect(worktreeSetupAgentNote(exited)).toBe(
      "Cezar's worktree setup did not complete before your session started: `npm ci` exited 1 after 12s. " +
        'The remaining commands did not run: `cp a b`.\n\nIts last output:\n\n```text\nnpm ERR! boom\n```\n\n' +
        'Dependencies or generated files may be missing. Fix the cause or run the setup yourself before tests or builds.',
    );
  });

  it('phrases a timeout and a spawn failure like the end note', () => {
    expect(worktreeSetupAgentNote(timedOut)).toContain('`npm ci` timed out after 900s.');
    expect(worktreeSetupAgentNote(spawn)).toContain('`npm ci` could not start (spawn bash ENOENT).');
    expect(worktreeSetupAgentNote(timedOut)).not.toContain('The remaining commands');
  });

  it('tells the agent an invalid setting skipped setup', () => {
    expect(worktreeSetupAgentNote(invalid)).toBe(
      "Cezar's worktree setup did not run: worktreeSetup in .ai/cezar/config.json is invalid (commands: Expected array, received string). " +
        'Dependencies or generated files may be missing. Fix the cause or run the setup yourself before tests or builds.',
    );
  });

  it('says nothing to the agent when setup was stopped', () => {
    expect(worktreeSetupAgentNote({ status: 'stopped', durationMs: 1 })).toBeUndefined();
  });

  it('the agent note fence survives backticks in the output', () => {
    const note = worktreeSetupAgentNote({
      ...exited,
      failed: failedResult({ output: 'a ``` b ```` c' }),
    })!;
    expect(note).toContain('`````text\na ``` b ```` c\n`````');
  });

  it('the agent note keeps only the last 4000 characters of output', () => {
    const note = worktreeSetupAgentNote({ ...exited, failed: failedResult({ output: `HEAD${'y'.repeat(5000)}TAIL` }) })!;
    expect(note).not.toContain('HEAD');
    expect(note).toContain(`${'y'.repeat(3996)}TAIL`);
  });

  it('summarizes the outcome for the run record', () => {
    expect(worktreeSetupRecordError(done)).toBeUndefined();
    expect(worktreeSetupRecordError(exited)).toBe('`npm ci` exited 1');
    expect(worktreeSetupRecordError(timedOut)).toBe('`npm ci` timed out after 900s');
    expect(worktreeSetupRecordError(spawn)).toBe('`npm ci` could not start: spawn bash ENOENT');
    expect(worktreeSetupRecordError({ status: 'stopped', durationMs: 1 })).toBe('stopped');
    expect(worktreeSetupRecordError(invalid)).toBe('invalid config: commands: Expected array, received string');
  });
});
