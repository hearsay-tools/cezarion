import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixture, removeAfterOwnedWork, waitForOwnedWork } from './service.testkit.ts';

describe('delegation fixture cleanup', () => {
  const leftovers: string[] = [];
  afterEach(() => {
    for (const root of leftovers.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('waits for owned asynchronous work before removing its directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-fixture-cleanup-'));
    leftovers.push(root);
    writeFileSync(join(root, 'early'), 'ok');
    let resolve!: () => void;
    const gate = new Promise<void>(r => { resolve = r; });
    const owned = gate.then(() => writeFileSync(join(root, 'late'), 'owned'));
    const removing = removeAfterOwnedWork(root, owned);
    expect(existsSync(join(root, 'early'))).toBe(true);
    expect(existsSync(join(root, 'late'))).toBe(false);
    resolve();
    await removing;
    expect(existsSync(root)).toBe(false);
  });

  it('close() returns a promise and removes the fixture root', async () => {
    const f = fixture();
    leftovers.push(f.root);
    const closed = f.close();
    expect(closed).toEqual(expect.any(Promise));
    await closed;
    expect(existsSync(f.root)).toBe(false);
  });

  it('does not swallow owned-work errors or remove the directory after them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-fixture-cleanup-err-'));
    leftovers.push(root);
    writeFileSync(join(root, 'early'), 'ok');
    await expect(removeAfterOwnedWork(root, Promise.resolve().then(() => { throw new Error('owned work failed'); }))).rejects.toThrow('owned work failed');
    expect(existsSync(join(root, 'early'))).toBe(true);
  });
});

it('refuses directory removal when worker termination returns false', async () => {
  const f = fixture();
  vi.stubEnv('CEZ_DELEGATION', '1');
  await f.service.spawn(f.caller, { task: 'work', baseline: 'HEAD', requestId: randomUUID() });
  // Only the termination boundary is replaced: false is its timeout result,
  // not a resolved proof that deletion is safe. Acceptance and Stop are real.
  const termination = vi.spyOn(f.manager, 'awaitRunTermination').mockResolvedValue(false);
  try {
    await expect(removeAfterOwnedWork(f.root, waitForOwnedWork(f.manager, f.store))).rejects.toThrow('Worker did not terminate');
    expect(existsSync(f.root)).toBe(true);
  } finally {
    termination.mockRestore();
    await f.close();
    vi.unstubAllEnvs();
  }
});
