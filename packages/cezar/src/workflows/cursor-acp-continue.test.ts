import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from './run.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const REFUSED = 'This Cursor session was started on the ACP transport, which Cezarion no longer supports, '
  + 'so it cannot resume. Start a new task to continue this work.';

/**
 * Continue on a Cursor session recorded on the removed ACP transport, or untagged from before
 * print sessions existed, fails with a clear error and starts no Cursor process
 * (hearsay-tools/cezarion#1267). The real Cursor runner runs; the Cursor binary only logs calls.
 */
describe('Continue on a legacy ACP Cursor session', () => {
  let repoRoot: string;
  let calls: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-cursor-acp-continue-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    calls = join(repoRoot, 'cursor-calls.log');
    const bin = join(repoRoot, 'fake-agent.sh');
    writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${calls}'\nexit 1\n`);
    chmodSync(bin, 0o755);
    vi.stubEnv('CEZ_DRY_RUN', undefined);
    vi.stubEnv('CEZ_CURSOR_BIN', bin);
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    manager?.dispose();
    manager = undefined;
    store.flush();
    vi.unstubAllEnvs();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function finishedCursorRun(sessionTransport: 'cursor-acp' | undefined): string {
    const record = store.createRun({
      title: 't', workflow: 'quick-task', task: 'do the thing', runner: 'cursor',
      steps: [{ id: 'work', name: 'Work', kind: STEP_KIND.agent }],
    });
    store.updateRun(record.id, { status: RUN_STATUS.review, finishedAt: new Date().toISOString() });
    store.updateStep(record.id, 'work', {
      status: STEP_STATUS.done, sessionId: 'legacy-acp-session', backend: 'cursor', ...(sessionTransport ? { sessionTransport } : {}),
    });
    store.appendEvent(record.id, {
      type: 'session', stepId: 'work', sessionId: 'legacy-acp-session', ...(sessionTransport ? { sessionTransport } : {}),
    });
    return record.id;
  }

  for (const [label, transport] of [['ACP-tagged', 'cursor-acp'], ['untagged', undefined]] as const) {
    it(`fails Continue on an ${label} session with the removal error and starts no Cursor process`, async () => {
      const id = finishedCursorRun(transport);
      expect(manager!.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
      await expect.poll(() => store.getRun(id)?.status, { timeout: 15_000 }).toBe(RUN_STATUS.failed);
      expect(store.getRun(id)?.error).toContain(REFUSED);
      const sessions = store.readEvents(id).filter(event => event.type === 'session');
      expect(sessions).toHaveLength(1);
      expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').toBe('');
    });
  }
});
