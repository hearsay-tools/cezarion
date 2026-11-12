import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import { shellQuote } from '../core/shell-env.ts';
import { RunStore } from '../runs/store.ts';
import type { WorkflowDef } from './types.ts';
import type { RunManager, PastedContent } from './run.ts';

// Shared setup for pasted-attachments.test.ts and pasted-attachments-continue.test.ts (open-mercato/cezar#357, open-mercato/cezar#950).

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
let gateSequence = 0;
const pendingHolderReleases = new Set<() => void>();

/** A real check-step subprocess that holds a slot until the test releases it. */
export function slotHolder(root: string, name: string): { workflow: WorkflowDef; release: () => void } {
  const gate = join(root, `.release-${gateSequence++}`);
  const script =
    "const fs=require('node:fs');const gate=process.argv[1];" +
    'const poll=()=>fs.existsSync(gate)?undefined:setTimeout(poll,5);poll()';
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    writeFileSync(gate, '');
    pendingHolderReleases.delete(release);
  };
  pendingHolderReleases.add(release);
  return {
    workflow: {
      name,
      source: 'built-in',
      steps: [
        {
          id: 'hold',
          command: `${shellQuote(process.execPath)} -e ${shellQuote(script)} ${shellQuote(gate)}`,
        },
      ],
    },
    release,
  };
}

/** Exit in the same turn that accepts Continue, before its first asynchronous launch. */
export async function crashAfterContinue(repoRoot: string, dataDir: string, runId: string, mode: string, images: PastedContent[]): Promise<void> {
  const script = `
    import { RunStore } from ${JSON.stringify(new URL('../runs/store.ts', import.meta.url).href)};
    import { RunManager } from ${JSON.stringify(new URL('./run.ts', import.meta.url).href)};
    import { acquireInertCiResources } from ${JSON.stringify(new URL('../ci-wait/inert-ci-resources.testkit.ts', import.meta.url).href)};
    import { createRunner } from ${JSON.stringify(new URL('../core/runner-factory.ts', import.meta.url).href)};
    import { WorkspaceSemaphore } from ${JSON.stringify(new URL('../workspace/semaphore.ts', import.meta.url).href)};
    import { Home } from ${JSON.stringify(new URL('../home/home.ts', import.meta.url).href)};
    const home = Home.sandbox(process.env.CEZ_HOME);
    const input = JSON.parse(process.argv[1]);
    const store = RunStore.open(input.dataDir, { keepLive: true });
    const semaphore = new WorkspaceSemaphore({ home, initial: { maxParallel: 0 } });
    const manager = new RunManager(store, input.repoRoot, { acquireCiResources: acquireInertCiResources, home, createRunner, semaphore });
    const accepted = manager.continueRun(input.runId, { text: 'read my durable continuation brief', images: input.images }, input.mode === 'capacity');
    if (!accepted.ok) throw new Error(accepted.error);
    process.exit(0);
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script,
    JSON.stringify({ repoRoot, dataDir, runId, mode, images })], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  let guard: ReturnType<typeof setTimeout> | undefined;
  // bound: only the owned child's exit event completes this wait; 15 s detects a stuck startup.
  const hung = new Promise<never>((_resolve, reject) => { guard = setTimeout(() => reject(new Error('Continue crash child did not exit')), 15_000); });
  try {
    expect(await Promise.race([exit, hung]), stderr).toBe(0);
  } finally {
    clearTimeout(guard);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
  }
}

// 1x1 transparent PNG — small enough to inline, real enough to round-trip through base64.
export const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// A markdown brief and a minimal PDF (open-mercato/cezar#950) — the two non-image attachments the composer takes.
// Their CONTENT is the thing every assertion below is about: it must reach disk and never the
// prompt, which is the whole point of handing the agent a path instead of the bytes.
export const BRIEF_MD = '# Brief\n\nShip the alpha-particle report.\n';
export const BRIEF_MD_B64 = Buffer.from(BRIEF_MD).toString('base64');
export const TINY_PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
export const TINY_PDF_B64 = Buffer.from(TINY_PDF).toString('base64');

/** The engine fixture the end-to-end cases share. `store` and `manager` are fields because a restart
 *  case swaps them for reopened ones, and the cleanup must reach whichever is current. */
export interface PastedAttachmentsFixture {
  repoRoot: string;
  dataDir: string;
  store: RunStore;
  manager: RunManager;
  argsFile: string;
  stdinFile: string;
  readStdinLines(): Array<{ userText: string; imageCount: number }>;
  waitForStatus(runId: string, statuses: string[], timeoutMs?: number): Promise<string>;
}

/**
 * End-to-end through the real engine with CEZ_DRY_RUN=1 (open-mercato/cezar#357): one git repo, one store and one
 * manager per describe block, with the mock's CEZ_MOCK_STDIN_FILE hook capturing the untruncated
 * inbound text.
 */
export function usePastedAttachmentsFixture(): PastedAttachmentsFixture {
  const savedEnv: Record<string, string | undefined> = {};
  const fx = {
    readStdinLines(): Array<{ userText: string; imageCount: number }> {
      return readFileSync(fx.stdinFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    async waitForStatus(runId: string, statuses: string[], timeoutMs = 20_000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const status = fx.store.getRun(runId)?.status;
        if (status && statuses.includes(status)) return status;
        if (Date.now() > deadline) throw new Error(`run did not reach ${statuses.join('/')} in time (was ${status})`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  } as PastedAttachmentsFixture;

  beforeAll(async () => {
    fx.repoRoot = mkdtempSync(join(tmpdir(), 'cez-pasted-'));
    fx.dataDir = join(fx.repoRoot, '.ai/cezar');
    fx.argsFile = join(fx.repoRoot, 'mock-args.ndjson');
    fx.stdinFile = join(fx.repoRoot, 'mock-stdin.ndjson');
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_MOCK_ARGS_FILE = process.env.CEZ_MOCK_ARGS_FILE;
    savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_MOCK_ARGS_FILE = fx.argsFile;
    process.env.CEZ_MOCK_STDIN_FILE = fx.stdinFile;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: fx.repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: fx.repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: fx.repoRoot });
    writeFileSync(join(fx.repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: fx.repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: fx.repoRoot });
    mkdirSync(fx.dataDir, { recursive: true });
    writeFileSync(join(fx.dataDir, 'config.json'), JSON.stringify({ maxParallel: 1 }));
    fx.store = RunStore.open(fx.dataDir);
    fx.manager = createFixtureManager(fx.store, fx.repoRoot);
  });

  afterEach(async () => {
    for (const release of [...pendingHolderReleases]) release();
    for (const run of fx.store.listRuns()) {
      if (!['done', 'review', 'failed', 'cancelled'].includes(run.status)) fx.manager.cancel(run.id);
    }
    await Promise.all(
      fx.store.listRuns().map((run) =>
        fx.waitForStatus(run.id, ['done', 'review', 'failed', 'cancelled'], 5_000),
      ),
    );
  });

  afterAll(async () => {
    for (const release of [...pendingHolderReleases]) release();
    await drainFixtureManagers(fx.repoRoot);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(fx.repoRoot, { recursive: true, force: true });
  });

  return fx;
}
