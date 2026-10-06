import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { processStartToken } from '../delegation/process-liveness.ts';
import { claimOwnerLive, closeClaimSession, openClaimSession } from './run-claims.ts';
import { RUNS_DB_FILE, RunDatabase } from './run-database.ts';
import { RunStore } from './store.ts';

/**
 * Run claims across a real second process (#779, plan step 3): a claim is taken over only once
 * its owner is PROVEN dead — its pid gone, or its pid now another process (a different start
 * identity). An owner that cannot be proven dead keeps its runs.
 */

const STORE_MODULE = fileURLToPath(new URL('./store.ts', import.meta.url));

let dataDir: string;
let child: ChildProcess | undefined;
const stores: RunStore[] = [];

const claims = () => {
  const db = RunDatabase.open(join(dataDir, RUNS_DB_FILE));
  try { return db.listClaims(); } finally { db.close(); }
};
const setClaimToken = (token: string | null) => {
  const raw = new DatabaseSync(join(dataDir, RUNS_DB_FILE));
  try { raw.prepare('UPDATE run_claims SET start_token = ?').run(token); } finally { raw.close(); }
};

/** Another cezar process: opens the project, starts a run and keeps running until killed. */
async function startOwner(): Promise<{ runId: string; pid: number }> {
  const script = join(dataDir, 'owner.mts');
  writeFileSync(script, `
    import { RunStore } from ${JSON.stringify(STORE_MODULE)};
    const store = RunStore.open(process.argv[2], { keepLive: true });
    const run = store.createRun({ title: 'theirs', workflow: 'w', task: 't', steps: [] });
    store.updateRun(run.id, { status: 'running' });
    store.flush();
    process.stdout.write(JSON.stringify({ runId: run.id, pid: process.pid }) + '\\n');
    setInterval(() => {}, 1000);
  `);
  child = spawn(process.execPath, ['--import', 'tsx', script, dataDir], { stdio: ['ignore', 'pipe', 'inherit'] });
  const [line] = (await once(createInterface({ input: child.stdout! }), 'line')) as [string];
  return JSON.parse(line) as { runId: string; pid: number };
}

async function kill(): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cez-run-claims-'));
});

afterEach(async () => {
  await kill();
  child = undefined;
  for (const store of stores.splice(0)) store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const open = () => {
  const store = RunStore.open(dataDir, { keepLive: true });
  stores.push(store);
  return store;
};

describe('claims held by another process', () => {
  it('records the owner\'s pid and start identity, and never takes a live owner\'s run', async () => {
    const owner = await startOwner();
    expect(claims()).toEqual([expect.objectContaining({ family: owner.runId, pid: owner.pid, startToken: processStartToken(owner.pid) ?? null })]);

    const store = open();
    expect(store.heldIds()).toEqual([]);
    expect(store.runOwnership(owner.runId)).toBe('foreign');
    expect(store.getRun(owner.runId)?.status).toBe('running');
    expect(store.updateRun(owner.runId, { title: 'mine' })).toBeUndefined();
  }, 30_000);

  it('takes a run over once its owner is killed, as a restart recovering it would', async () => {
    const owner = await startOwner();
    const before = open();
    expect(before.runOwnership(owner.runId)).toBe('foreign');
    await kill();

    expect(before.runOwnership(owner.runId)).toBe('orphaned');
    const after = open();
    expect(after.heldIds()).toEqual([owner.runId]);
    // keepLive: left running for the manager's recovery, not settled.
    expect(after.getRun(owner.runId)?.status).toBe('running');
    expect(claims()).toEqual([expect.objectContaining({ family: owner.runId, pid: process.pid })]);
  }, 30_000);

  it('takes over a live pid whose start identity differs: the pid was reused by another process', async () => {
    const owner = await startOwner();
    setClaimToken('a-start-identity-the-owner-never-had');
    expect(claimOwnerLive({ session: 'owner', pid: owner.pid, startToken: 'a-start-identity-the-owner-never-had' })).toBe(false);
    const store = open();
    expect(store.heldIds()).toEqual([owner.runId]);
  }, 30_000);

  it('never takes over a live pid without a start identity: it cannot be proven dead', async () => {
    const owner = await startOwner();
    setClaimToken(null);
    expect(claimOwnerLive({ session: 'owner', pid: owner.pid, startToken: null })).toBe(true);
    const store = open();
    expect(store.heldIds()).toEqual([]);
    expect(store.runOwnership(owner.runId)).toBe('foreign');
  }, 30_000);
});

describe('claimOwnerLive in this process', () => {
  it('an open session is live, a closed one is dead, and so is an earlier incarnation of this pid', () => {
    const owner = openClaimSession();
    expect(owner.pid).toBe(process.pid);
    expect(owner.startToken).toBe(processStartToken(process.pid) ?? null);
    expect(claimOwnerLive(owner)).toBe(true);
    if (owner.startToken !== null) expect(claimOwnerLive({ ...owner, startToken: `${owner.startToken}-earlier` })).toBe(false);
    closeClaimSession(owner.session);
    expect(claimOwnerLive(owner)).toBe(false);
  });
});
